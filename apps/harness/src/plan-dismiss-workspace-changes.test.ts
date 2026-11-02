/**
 * **關掉計劃審核收尾這一輪，改動紀錄記在 `turn/end` 之前**（[#1607](https://github.com/DemianLi/nexus-agent/issues/1607)，照 dsh）。
 *
 * 關掉審核時 `exit_plan_mode` 的結果帶 `name`、工具設了 `returnDirect`，基座的 tools 路由走 exitNode，**跑所有 `afterAgent`**，
 * 其中一顆是 `@nexus/plugin-workspace-changes` 的 `stopping()`（輪內記錄）。同一輪先改了檔、再交計劃、人關掉審核，
 * 日誌上的 `workspace/changes` 落在這一輪、**在 `turn/end` 之前**——dsh 的 `agent/turn-stopping` 也是這個時機。
 * （曾試過 middleware 的 `beforeModel` 跳 `end`：略過 `afterAgent`，記錄要等 `turn/end` 之後由 `end()` 補記；探針量過，沒採用。）
 *
 * 走產品組裝（serve 的出貨清單＋`--workspace`）、真的 pump 與 wire，模型是腳本。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PluginEntry, SessionRegistry } from '@nexus/core';
import { EXIT_PLAN_MODE_TOOL_NAME, PLAN_REVIEW_DISMISSED_MESSAGE } from '@nexus/plugin-plan-mode';
import type { Event } from '@nexus/wire';
import {
  cancelResponse,
  createWireClient,
  emptyConversation,
  isQuestionPending,
  reduceConversation,
} from '@nexus/wire';
import type { ConversationState } from '@nexus/wire';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCliAgent } from './assembly-root.js';
import {
  loopbackRequest,
  shippedServePlugins,
  TEST_BROWSER_AUTH,
  withScriptedModel,
} from './fixtures.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';

const shipped = await shippedServePlugins();

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function directory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

/** 計劃模式開著（`startActive`），其餘照 serve 的出貨清單；出貨的指引照用。 */
function withPlanModeOn(plugins: readonly PluginEntry[]): PluginEntry[] {
  return plugins.map((entry) => {
    if (entry.id !== 'plan-mode') return entry;
    const config = entry.config as { guidance: string };
    return { ...entry, config: { ...config, startActive: true } };
  });
}

const PLAN = '# 計劃\n\n先寫一個檔。';

const TURNS: ScriptedTurn[] = [
  {
    content: '先寫檔。',
    toolCalls: [{ name: 'write_file', args: { file_path: '/new.md', content: 'hi\n' } }],
  },
  {
    content: '交計劃。',
    toolCalls: [{ name: EXIT_PLAN_MODE_TOOL_NAME, args: { plan: PLAN } }],
  },
  { content: '不該被叫到。' },
];

async function dismissAfterWriting(): Promise<{
  readonly sessions: SessionRegistry;
  readonly model: ScriptedChatModel;
  readonly close: () => Promise<void>;
}> {
  const root = await directory('nexus-plan-dismiss-ws-');
  const tempRoot = await directory('nexus-plan-dismiss-temp-');
  await writeFile(join(root, 'seed.md'), 'x\n');
  vi.stubEnv('TMPDIR', tempRoot);
  const built = await createCliAgent(
    { live: false, workspace: root, sandbox: 'workspace-write' },
    withScriptedModel(withPlanModeOn(shipped), TURNS),
    root,
  );
  const model = built.model as ScriptedChatModel;
  let sessions: SessionRegistry | undefined;
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    createAgent: async () => ({
      agent: built.agent as unknown as PumpAgent,
      commands: built.commands,
      dispose: built.dispose,
      workspaceChanges: built.workspaceChanges,
      attachSessions: (registry, backgroundPort) => {
        sessions = registry;
        return built.attachSessions(registry, backgroundPort);
      },
    }),
  });
  const client = createWireClient({
    baseUrl: 'http://plan-dismiss.test',
    fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
  });
  const threadId = 'plan-dismiss-ws';
  const events = await client.openEvents(threadId);
  await client.runStart(threadId, '寫個檔再交計劃。');
  let state: ConversationState = emptyConversation();
  const pump = async (done: () => boolean): Promise<void> => {
    while (!done()) {
      const next: IteratorResult<Event, void> = await events.next();
      if (next.done === true) break;
      state = reduceConversation(state, next.value);
    }
  };
  await pump(() => state.status === 'awaiting-input');
  const pending = state.pendings[0];
  if (pending === undefined || !isQuestionPending(pending)) throw new Error('沒有掛著的審核');
  await client.inputRespond(threadId, {
    namespace: [...pending.namespace],
    interrupt_id: pending.interruptId,
    response: cancelResponse(),
  });
  const ended = (): boolean =>
    sessions?.root.events.some(
      (event, at, all) =>
        event.type === 'turn/end' &&
        all.slice(0, at).some((e) => e.type === 'turn/start' && e.data.kind === 'resume'),
    ) ?? false;
  await pump(ended);
  // 記錄經日誌的寫入佇列落定；等它出現。
  await vi.waitFor(() => {
    expect(sessions?.root.events.some((event) => event.type === 'workspace/changes')).toBe(true);
  });
  await events.return?.(undefined);
  if (sessions === undefined) throw new Error('attachSession 沒被叫到');
  return { sessions, model, close: () => handler.close() };
}

describe('關掉計劃審核收尾：afterAgent 照跑，改動紀錄記在 turn/end 之前', () => {
  it('同一輪先改檔、再交計劃、人關掉審核：一顆 workspace/changes，落在這一輪、模型只多叫到交計劃那一次', async () => {
    const { sessions, model, close } = await dismissAfterWriting();
    try {
      const events = sessions.root.events;
      // 沒有第三次模型呼叫（腳本第三句 '不該被叫到' 沒被讀到）：寫檔一次、交計劃一次。
      expect(model.prompts).toHaveLength(2);
      const reviewResult = events
        .filter((event) => event.type === 'tool/result')
        .some((event) => {
          const message = (event.data as { message?: { data?: { content?: unknown } } }).message;
          return String(message?.data?.content) === PLAN_REVIEW_DISMISSED_MESSAGE;
        });
      expect(reviewResult).toBe(true);

      const changes = events.filter((event) => event.type === 'workspace/changes');
      expect(changes).toHaveLength(1);
      const at = changes[0]!.seq;
      const starts = events
        .filter((event) => event.type === 'turn/start')
        .map((event) => event.seq);
      const lastStart = starts.at(-1)!;
      // 落在最後一顆 `turn/start`（resume 那一輪）之後，也沒有下一輪的 `turn/start` 在它後面。
      expect(at).toBeGreaterThan(lastStart);
      // 輪內記錄在 `turn/end` 之前：走 exitNode 所以 `afterAgent` 的 `stopping()` 跑到了，不是靠 `end()` 補記。
      const turnEnd = events.filter((event) => event.type === 'turn/end').at(-1)!.seq;
      expect(at).toBeLessThan(turnEnd);
    } finally {
      await close();
    }
  });
});
