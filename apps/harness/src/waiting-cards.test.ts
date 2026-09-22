/**
 * 停下來等人的那一輪，**即時與重播畫得一樣**——[#317](https://github.com/DemianLi/nexus-agent/issues/317) 的驗收。
 *
 * 兩種等法：本體拋了中斷的（問答）是「等你回答」；停在核准閘門上的本體沒被呼叫到，照 dsh 是「執行中」。子代理
 * 照 dsh 不停下來等人（[#324](https://github.com/DemianLi/nexus-agent/issues/324)），所以停下來的只有 root 自己的
 * 工具；最後一條釘住子代理那條路不再停。日誌分不出這兩種，重播靠 pump 交進來的閘門工具名分（`conversation-history.ts` 的 `historyFrames`）。
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
import { ASK_USER_QUESTION_TOOL_NAME, createAskUserPlugin } from '@nexus/plugin-ask-user';
import type { ConversationState, Event } from '@nexus/wire';
import { emptyConversation, reduceAll, reduceConversation } from '@nexus/wire';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { historyFrames } from './conversation-history.js';
import { ScriptedChatModel } from './scripted-model.js';
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

/**
 * 真的組裝跑一輪到收尾（停下來等人，或跑完），回傳即時與重播兩個畫面——serve 那條路的形狀，同
 * `tool-card-from-log.test.ts`。
 */
async function stopForInput(turns: readonly ScriptedTurn[], plugins: readonly PluginEntry[]) {
  const root = await mkdtemp(join(tmpdir(), 'nexus-waiting-cards-'));
  const built = await createNexusAgent({
    model: new ScriptedChatModel({ turns }),
    checkpointer: new MemorySaver(),
    plugins: [...plugins],
    backend: new ContainedFilesystemBackend({ rootDir: root, mode: 'workspace-write' }),
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

  return {
    pump,
    live: frames.reduce(reduceConversation, emptyConversation()),
    replay: reduceAll(
      emptyConversation(),
      historyFrames(pump.sessionLog.events, DEFAULT_TOOL_TEXT_MAX_BYTES, {
        gatedTools: pump.gatedTools,
      }),
    ),
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
   * **只寫「核准那張是執行中」的話，把每張卡都畫成執行中也會綠**；同一輪掛著一題問答，才分得出兩種等法真的分開畫。
   */
  it('同一輪一題問答、一顆核准：問答是「等你回答」，核准是「執行中」', async () => {
    const run = await stopForInput(
      [
        { content: '兩個都動。', toolCalls: [ASK, { name: 'danger', args: {} }] },
        { content: '收工。' },
      ],
      [DANGER, createAskUserPlugin()],
    );
    try {
      // 前提：兩顆都真的掛上了、日誌停在那一輪的收尾，而閘門上只有核准那顆。
      expect(run.pump.pendings).toHaveLength(2);
      expect(run.pump.sessionLog.events.at(-1)?.type).toBe('turn/end');
      expect([...run.pump.gatedTools]).toEqual(['danger']);

      const expected = [`${ASK_USER_QUESTION_TOOL_NAME}:suspended`, 'danger:running'];
      expect(rootCards(run.live)).toEqual(expected);
      expect(rootCards(run.replay)).toEqual(expected);
      expect(run.replay.status).toBe('running');
    } finally {
      await run.close();
    }
  }, 20000);

  /**
   * **[#324](https://github.com/DemianLi/nexus-agent/issues/324) 翻了面。** 以前子代理停在核准點，root 的 `task`
   * 兩邊都是「等你回答」；照 dsh，子代理的核准政策在委派時釘成 `never`，子代理不停下來等人，這一輪根本沒停。
   * 留著它，是為了釘住「子代理叫到要核准的工具」這條路不再產生等人的卡。
   */
  it('子代理叫到要核准的工具：不停下來，root 的 `task` 兩邊都是完成', async () => {
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
      expect(run.pump.awaitingInput).toBe(false);
      expect(run.pump.pendings).toHaveLength(0);
      expect(run.pump.sessionLog.events.at(-1)?.type).toBe('turn/end');
      expect([...run.pump.gatedTools]).toEqual([]);

      expect(rootCards(run.live)).toEqual(['task:done']);
      expect(rootCards(run.replay)).toEqual(['task:done']);
    } finally {
      await run.close();
    }
  }, 20000);
});
