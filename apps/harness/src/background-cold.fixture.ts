/**
 * 背景子代理冷復活測試共用的夾具：暫存目錄與 JSONL 存放處、兩種 worker、`boot`（起一個「行程」）、`firstProcess`。
 *
 * 狀態（`world`）是模組層級的：每個測試檔各自載入一份，測試之間靠 `setupWorld`／`teardownWorld` 重置。
 * 用法：測試檔在 `beforeEach`／`afterEach` 各呼叫一次。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import {
  appendSubagentCatalog,
  attachSessionPersistence,
  resumeClosingInterruptedTurn,
  subagentLinks,
  SessionLogOffset,
} from '@nexus/core';
import type { AgentLoopKind, HistorySource, PluginEntry } from '@nexus/core';
import { expect } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { createColdChildStore } from './background-cold.js';
import type { BackgroundSubagentStatus } from './background-subagents.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { createJsonlSessionStore, openJsonlSessionStore } from './jsonl-session-store.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

export const ROOT = 'cold-root';

/** 每個測試各自的暫存目錄與第一個行程建出來的專案日誌目錄（之後的「行程」重新打開同一個）。 */
export const world: { dir: string; storeDirectory: string | undefined } = {
  dir: '',
  storeDirectory: undefined,
};
export async function setupWorld(): Promise<void> {
  world.dir = await mkdtemp(join(tmpdir(), 'nexus-background-cold-'));
  world.storeDirectory = undefined;
}
export async function teardownWorld(): Promise<void> {
  await rm(world.dir, { recursive: true, force: true });
}

/** 新的存放處把手：第一次建，之後打開同一個目錄（每個 `createJsonlSessionStore` 都會開一個新的 run 目錄）。 */
export function openStore() {
  if (world.storeDirectory === undefined) {
    const store = createJsonlSessionStore({ rootDir: join(world.dir, 'logs') });
    world.storeDirectory = store.directory;
    return store;
  }
  return openJsonlSessionStore({ directory: world.storeDirectory });
}

export async function until(predicate: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** 一則訊息的可比較形狀（型別加文字）。 */
export const shape = (message: BaseMessage) => ({ type: message.type, content: message.content });
/** prompt 去掉系統訊息（兩個行程的系統提示詞本來就可以不同）。 */
export const conversation = (prompt: readonly BaseMessage[]) =>
  prompt.filter((message) => message.type !== 'system').map(shape);

/** 兩種 worker 各有一顆工具 `note`（回一段可辨認的結果），`hold` 是第二個行程用來佔住名額的。 */
export function workers(
  models: Record<'worker-a' | 'worker-b', ScriptedChatModel>,
  hold?: Promise<void>,
) {
  const entry: PluginEntry = {
    plugin: {
      name: 'worker-host',
      apply(registry) {
        for (const name of ['worker-a', 'worker-b'] as const) {
          registry.subagents.register({
            name,
            description: '幹活的。',
            systemPrompt: `你是 ${name}。`,
            model: models[name] as never,
          });
        }
        registry.tools.register(
          tool(async () => `工具結果：${'長'.repeat(30)}`, {
            name: 'note',
            description: '記一筆。',
            schema: z.object({}),
          }),
        );
        registry.tools.register(
          tool(async () => (await hold, '放行了'), {
            name: 'hold',
            description: '等放行。',
            schema: z.object({}),
          }),
        );
      },
    },
  };
  return entry;
}

export const workerTurns = (name: string): ScriptedTurn[] => [
  { content: '', toolCalls: [{ name: 'note', id: `${name}-note`, args: {} }] },
  { content: `${name} 做完` },
];

export interface Booted {
  readonly pump: ThreadPump;
  readonly detach: ReturnType<Awaited<ReturnType<typeof createNexusAgent>>['attachSession']>;
  readonly statuses: (readonly BackgroundSubagentStatus[])[];
  readonly models: Record<'worker-a' | 'worker-b', ScriptedChatModel>;
  readonly shutdown: () => Promise<void>;
}

/**
 * 起一個「行程」：新的存放處把手、新的 `MemorySaver`、新的模型。`resume` 給了就從 root 的落盤接回來（同 serve 碰到一條以前寫過的
 * thread）。
 */
export async function boot(options: {
  readonly rootTurns: ScriptedTurn[];
  readonly turnsFor: (name: 'worker-a' | 'worker-b') => ScriptedTurn[];
  readonly resume?: boolean;
  readonly maxActive?: number;
  readonly hold?: Promise<void>;
  /** 省略照設定檔；`native` 不給 checkpointer。 */
  readonly agentLoop?: AgentLoopKind;
  /** 省略照測試 setup 補的值（`state`）；明給才是那一個。 */
  readonly historySource?: HistorySource;
}): Promise<Booted> {
  const store = openStore();
  const models = {
    'worker-a': new ScriptedChatModel({ turns: options.turnsFor('worker-a') }),
    'worker-b': new ScriptedChatModel({ turns: options.turnsFor('worker-b') }),
  };
  const built = await createNexusAgent({
    model: new ScriptedChatModel({ turns: options.rootTurns }),
    ...(options.agentLoop !== 'native' && { checkpointer: new MemorySaver() }),
    ...(options.agentLoop !== undefined && { agentLoop: options.agentLoop }),
    ...(options.historySource !== undefined && { historySource: options.historySource }),
    plugins: [workers(models, options.hold)],
    backend: new ContainedFilesystemBackend({
      rootDir: join(world.dir, 'workspace'),
      mode: 'workspace-write',
    }),
    backgroundSubagents: {
      maxActive: options.maxActive ?? 8,
      cold: createColdChildStore(store),
    },
  });
  const resumed = options.resume ? await resumeClosingInterruptedTurn(store, ROOT) : undefined;
  const pump = new ThreadPump(
    built.agent as unknown as PumpAgent,
    ROOT,
    undefined,
    resumed?.events,
  );
  const statuses: (readonly BackgroundSubagentStatus[])[] = [];
  const detach = built.attachSession(pump.sessions, { onStatus: (items) => statuses.push(items) });
  const persistence = attachSessionPersistence(pump.sessions, store, {
    ...(resumed !== undefined && {
      resumedRoot: { stored: resumed.stored, storedCount: SessionLogOffset(resumed.events.length) },
    }),
  });
  return {
    pump,
    detach,
    statuses,
    models,
    shutdown: async () => {
      await persistence.dispose();
      detach();
      await built.dispose();
    },
  };
}

export const delegateBoth: ScriptedTurn = {
  content: '委派兩個。',
  toolCalls: ['worker-a', 'worker-b'].map((name) => ({
    name: 'subagent',
    id: `call-${name}`,
    args: { description: `請 ${name} 幹活`, subagent_type: name, run_in_background: true },
  })),
};

/**
 * 第一個行程：派兩個背景子代理、跑到 idle、再塞一個「舊版寫的」（沒有身分）的，然後整個收掉。
 *
 * @returns 兩個子代理的編號與重啟之前它們最後一次收到的對話（模型視角）。
 */
export async function firstProcess(agentLoop?: AgentLoopKind, historySource?: HistorySource) {
  const first = await boot({
    rootTurns: [delegateBoth, { content: '根收尾' }],
    turnsFor: workerTurns,
    ...(agentLoop !== undefined && { agentLoop }),
    ...(historySource !== undefined && { historySource }),
  });
  await first.pump.submit({ kind: 'message', text: '委派' });
  await first.pump.whenIdle();
  const links = subagentLinks(first.pump.sessions.root.events);
  expect(links).toHaveLength(2);
  const runIdOf = (index: number) => links[index]!.childId.slice(`${ROOT}/`.length);
  const children = first.pump.sessions.list().filter((entry) => entry.address.kind === 'subagent');
  await until(() =>
    children.every((entry) => entry.log.events.some((event) => event.type === 'turn/end')),
  );

  // 舊版寫的：派出時還沒有 `subagent/descriptor`。直接在註冊表上造一份，root 目錄指向它。
  const legacy = first.pump.sessions.open({ kind: 'subagent', runId: 'bg-legacy000000' });
  legacy.append('turn/start', { kind: 'message', text: '舊版任務' });
  legacy.append('turn/end', {});
  appendSubagentCatalog(first.pump.sessions.root, {
    childId: legacy.sessionId,
    callId: 'call-legacy',
    mode: 'continuable',
  });

  const lastPrompt = (name: 'worker-a' | 'worker-b') => conversation(first.models[name].lastPrompt);
  const result = {
    a: { runId: runIdOf(0), before: lastPrompt('worker-a') },
    b: { runId: runIdOf(1), before: lastPrompt('worker-b') },
  };
  await first.shutdown();
  return result;
}

export const SEND_MESSAGE_TURN = (runId: string): ScriptedTurn => ({
  content: '',
  toolCalls: [
    { name: 'send_message', id: 'wake-call', args: { agent_id: runId, message: '模型叫醒' } },
  ],
});
