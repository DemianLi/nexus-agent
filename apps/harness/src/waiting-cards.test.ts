/**
 * **手搭組裝（#670）**：這一檔留在手搭（`createNexusAgent`），產品組裝（`createCliAgent`）組不出來：核准閘門那幾條由測試握著
 * 一顆 `SandboxModeController`（`createHostServicesPlugin({ fsContainment: CONTAINED_FILESYSTEM, sandboxPolicy: { controller, … } })`，同時把 `controller.source` 與 grants 交給
 * 閘門），產品的控制器建在組裝點裡，測試拿不到（同 `subagent-sandbox.test.ts`）。
 *
 * 停下來等人的那一輪，**即時與重播畫得一樣**——[#317](https://github.com/DemianLi/nexus-agent/issues/317) 的驗收。
 *
 * 兩種等法：本體拋了中斷的（問答）是「等你回答」；停在核准閘門上的本體沒被呼叫到，照 dsh 是「執行中」。背景子代理
 * 照 dsh 不停下來等人（[#324](https://github.com/DemianLi/nexus-agent/issues/324)）；**前景子代理會**（[#328](https://github.com/DemianLi/nexus-agent/issues/328)
 * 第 1 項），它底下的委派卡維持「執行中」，最後一條釘住即時與重播在這條路上畫得一樣。日誌分不出這兩種，重播靠 pump 交進來的
 * 閘門工具名分（`conversation-history.ts` 的 `historyFrames`）。
 *
 * 每條都拿同一次真的組裝跑出來的即時畫面，與它寫下的日誌重播出來的畫面對照，**而且兩邊各自寫明期望值**——只比兩邊
 * 相等的話，兩邊一起錯也會綠。重播只讀 root 那份日誌，子代理的卡不在裡面（`conversation-history.ts` 的 `frame`），
 * 所以只比 root 的卡。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import type { PluginEntry } from '@nexus/core';
import { createHostServicesPlugin } from '@nexus/core';
import { ASK_USER_QUESTION_TOOL_NAME, createAskUserPlugin } from '@nexus/plugin-ask-user';
import {
  CONTAINED_FILESYSTEM,
  createSandboxPolicyPlugin,
  SANDBOX_ESCALATION_TOOL_NAME,
  SandboxModeController,
} from '@nexus/plugin-sandbox-policy';
import type { ConversationState, Event } from '@nexus/wire';
import { emptyConversation, reduceAll, reduceConversation } from '@nexus/wire';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { historyFrames } from './conversation-history.js';
import { ScriptedChatModel } from './scripted-model.js';
import { humanChannelPlugin } from './fixtures.js';
import type { ScriptedTurn } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';
import { DEFAULT_TOOL_TEXT_MAX_BYTES } from './settings/tool-text.js';

type ToolEntry = Extract<ConversationState['entries'][number], { kind: 'tool' }>;

const DANGER: PluginEntry = {
  plugin: {
    name: 'danger',
    apply(registry) {
      registry.tools.register(
        tool(() => '危險的事做完了', {
          name: 'danger',
          description: '要核准。',
          schema: z.object({}),
        }),
      );
      registry.approvals.gate((exec, next) =>
        exec.name === 'danger' ? { kind: 'ask', reason: '危險' } : next(),
      );
    },
  },
};

const WORKER: PluginEntry = {
  plugin: {
    name: 'worker-host',
    apply(registry) {
      registry.subagents.register({ name: 'worker', description: '幹活的。' });
    },
  },
};

/** 升級那一條的控制器：`read-only` 起算，要 `workspace-write` 才是加寬。 */
const escalationController = new SandboxModeController('read-only');

const ASK = {
  name: ASK_USER_QUESTION_TOOL_NAME,
  args: { questions: [{ id: 'day', question: '哪一天？' }] },
};

const isRootDone = (frame: Event): boolean =>
  frame.method === 'lifecycle' &&
  frame.params.namespace.length === 0 &&
  (frame.params.data as { graph_name?: unknown }).graph_name === 'root' &&
  ['completed', 'failed'].includes(String((frame.params.data as { event?: unknown }).event));

async function until(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** root 的卡，`名字:狀態`。 */
function rootCards(state: ConversationState): string[] {
  return state.entries
    .filter((entry): entry is ToolEntry => entry.kind === 'tool')
    .filter((entry) => entry.attribution.kind === 'root')
    .map((entry) => `${entry.name}:${entry.status}`);
}

/** 呼叫端自己掛了 host-services（它會提供 channel）就照它的；沒有才補一份「有人在答」的。 */
function withChannel(plugins: readonly PluginEntry[]): PluginEntry[] {
  return plugins.some((entry) => entry.plugin.name === 'host-services')
    ? [...plugins]
    : [humanChannelPlugin(), ...plugins];
}

/**
 * 真的組裝跑一輪到收尾（停下來等人，或跑完），回傳即時與重播兩個畫面——serve 那條路的形狀，同
 * `tool-card-from-log.test.ts`。
 */
async function stopForInput(
  turns: readonly ScriptedTurn[],
  plugins: readonly PluginEntry[] | ((root: string) => readonly PluginEntry[]),
  backend: (root: string) => ContainedFilesystemBackend = (root) =>
    new ContainedFilesystemBackend({ rootDir: root, mode: 'workspace-write' }),
) {
  const root = await mkdtemp(join(tmpdir(), 'nexus-waiting-cards-'));
  const built = await createNexusAgent({
    model: new ScriptedChatModel({ turns }),
    checkpointer: new MemorySaver(),
    plugins: withChannel(typeof plugins === 'function' ? plugins(root) : plugins),
    backend: backend(root),
  });
  const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'waiting-cards');
  const detach = built.attachSession(pump.sessions);
  const frames: Event[] = [];
  const line = new AbortController();
  const stream = pump.subscribe(['messages', 'tools', 'lifecycle', 'input'], line.signal);
  const draining = (async () => {
    for await (const frame of stream) frames.push(frame);
  })();

  await pump.submit({ kind: 'message', text: '動手' });
  await until(() => frames.some(isRootDone));
  await pump.whenIdle();

  const history = historyFrames(pump.sessionLog.events, DEFAULT_TOOL_TEXT_MAX_BYTES, {
    gatedTools: pump.gatedTools,
  });
  return {
    pump,
    frames,
    history,
    live: frames.reduce(reduceConversation, emptyConversation()),
    replay: reduceAll(emptyConversation(), history),
    close: async () => {
      line.abort();
      await draining;
      detach();
      await built.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe('停下來等人的那一輪，即時與重播畫得一樣', () => {
  /**
   * **只寫「核准那張是執行中」的話，把每張卡都畫成執行中也會綠**；所以同一輪還要有一題問答，才分得出兩種等法真的分開畫。
   *
   * **逐顆問（#711 第 2 步，同 dsh）**：問答與核准都沒宣告可重疊，是獨佔，同一步裡排在前面的先問，後面的在屏障上等、中斷時
   * 一起退出，連卡都還沒開。所以這一輪只掛著問答那一顆；核准的卡要等問答答完、它重跑之後才出現。以前（沒有屏障）兩顆同時掛上。
   */
  it('同一輪一題問答、一顆核准：先問問答（等你回答），核准還沒開卡', async () => {
    const run = await stopForInput(
      [
        { content: '兩個都動。', toolCalls: [ASK, { name: 'danger', args: {} }] },
        { content: '收工。' },
      ],
      [DANGER, createAskUserPlugin()],
    );
    try {
      expect(run.pump.pendings).toHaveLength(1);
      expect(run.pump.sessionLog.events.at(-1)?.type).toBe('turn/end');

      const expected = [`${ASK_USER_QUESTION_TOOL_NAME}:suspended`];
      expect(rootCards(run.live)).toEqual(expected);
      expect(rootCards(run.replay)).toEqual(expected);
      expect(run.replay.status).toBe('running');
    } finally {
      await run.close();
    }
  }, 20000);

  /**
   * **升級的核准從 #700 起在工具本體裡問**：本體被呼叫到了，基座發 `tool-started`，中斷又是拋出來的，所以
   * 基座接著發一顆帶中斷酬載的 `tool-error`——跟問答同一條路。照 dsh，核准的等待不畫在卡上（卡維持執行中，
   * 面板接管輸入框），所以 pump 不能把它換成 `tool-suspended`；重播靠 `gatedTools` 認得它的名字。
   */
  it('升級停在本體的核准上：即時與重播都是「執行中」，兩邊都沒有 `tool-suspended`', async () => {
    const run = await stopForInput(
      [
        {
          content: '要升級。',
          toolCalls: [
            {
              name: SANDBOX_ESCALATION_TOOL_NAME,
              args: {
                file_path: '/a.txt',
                sandbox_permissions: 'workspace-write',
                justification: '使用者要這個檔',
              },
            },
          ],
        },
        { content: '收工。' },
      ],
      (root) => [
        createHostServicesPlugin({
          channel: { kind: 'human' },
          fsContainment: CONTAINED_FILESYSTEM,
          sandboxPolicy: { controller: escalationController, rootDir: root },
        }),
        createSandboxPolicyPlugin(),
      ],
      (root) =>
        new ContainedFilesystemBackend({
          rootDir: root,
          mode: escalationController.source,
          grants: escalationController,
        }),
    );
    try {
      // 前提：真的停在升級的核准上，而且是本體發的那一種（本體被呼叫到了，才有基座的 `tool-error`）。
      expect(run.pump.pendings).toHaveLength(1);
      expect([...run.pump.gatedTools]).toEqual([SANDBOX_ESCALATION_TOOL_NAME]);
      expect(
        run.frames.some(
          (frame) =>
            frame.method === 'tools' &&
            (frame.params.data as { event?: unknown }).event === 'tool-started',
        ),
      ).toBe(true);

      const expected = [`${SANDBOX_ESCALATION_TOOL_NAME}:running`];
      expect(rootCards(run.live)).toEqual(expected);
      expect(rootCards(run.replay)).toEqual(expected);
      const suspended = (frames: readonly Event[]) =>
        frames.filter(
          (frame) =>
            frame.method === 'tools' &&
            (frame.params.data as { event?: unknown }).event === 'tool-suspended',
        );
      expect(suspended(run.frames)).toEqual([]);
      expect(suspended(run.history)).toEqual([]);
    } finally {
      await run.close();
    }
  }, 20000);

  /**
   * **[#328](https://github.com/DemianLi/nexus-agent/issues/328) 第 1 項翻回來**（[#324](https://github.com/DemianLi/nexus-agent/issues/324) 曾翻成不停）。
   * 前景子代理叫到要核准的工具會停在核准點；root 的 `task` 即時與重播都還是「執行中」（子代理在它底下等人），
   * 中斷帶的是子代理的 namespace，畫面靠它認出是哪個子代理在問。
   */
  it('前景子代理叫到要核准的工具：停下來，root 的 `task` 兩邊畫得一樣', async () => {
    const run = await stopForInput(
      [
        {
          content: '委派。',
          toolCalls: [{ name: 'task', args: { description: '幹活', subagent_type: 'worker' } }],
        },
        { content: '子代理動手。', toolCalls: [{ name: 'danger', args: {} }] },
        { content: '子代理收工。' },
        { content: '根收工。' },
      ],
      [DANGER, WORKER],
    );
    try {
      expect(run.pump.awaitingInput).toBe(true);
      expect(run.pump.pendings).toHaveLength(1);
      // 閘門上的工具名，加上它底下停著的委派卡（重播靠名字讓那張卡維持執行中）。
      expect([...run.pump.gatedTools]).toEqual(['danger', 'task', 'subagent']);

      expect(rootCards(run.live)).toEqual(['task:running']);
      expect(rootCards(run.replay)).toEqual(['task:running']);
      // 中斷帶的是子代理的 namespace（畫面靠它認出是誰在問），而且只有一顆：root 層的第二次露面被吞掉。
      const requests = run.frames.filter((frame) => frame.method === 'input.requested');
      expect(requests).toHaveLength(1);
      expect(requests[0]?.params.namespace.length).toBeGreaterThan(0);
    } finally {
      await run.close();
    }
  }, 20000);
});
