/**
 * 背景子代理的冷復活，端到端（[#1271](https://github.com/DemianLi/nexus-agent/issues/1271)，缺口源自
 * [#737](https://github.com/DemianLi/nexus-agent/issues/737)）。
 *
 * **全走產品組裝**：`createNexusAgent`＋腳本模型＋`ThreadPump`＋`attachSession`＋真的 JSONL 存放處。第一個行程派兩個背景子代理、
 * 跑到 idle、整個收掉；第二個行程用**全新的** `MemorySaver` 與模型（存檔點不落盤，所以第二個行程的圖 state 是空的）從同一個目錄
 * 接回 root，再對舊編號送話。要證明的是：
 *
 * - 送話把冷的叫醒，它看得到重啟之前的對話（模型這一次收到的 prompt 以**重啟之前那一份為前綴**，工具結果逐字相同）；
 * - 列出與現況不復活任何一個，現況第一份就含叫得醒的（沒有先送空的）；
 * - 名額在重建之前佔：滿了拒絕、沒去握租約；
 * - 舊日誌沒有身分：不擋啟動，列出來附原因，送話回找不到並說明；
 * - 模型自己用 `send_message` 也叫得醒；
 * - 日誌往原檔續寫：`seq` 連續、`subagent/descriptor` 只有一顆、中間只有一顆 `session/end-seed`。
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
} from '@nexus/core';
import type { PluginEntry } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { createColdChildStore } from './background-cold.js';
import { BackgroundSubagentError } from './background-subagents.js';
import type { BackgroundSubagentStatus } from './background-subagents.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { createJsonlSessionStore, openJsonlSessionStore } from './jsonl-session-store.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

const ROOT = 'cold-root';

let dir: string;
/** 第一個行程建出來的專案日誌目錄；之後的「行程」重新打開同一個。 */
let storeDirectory: string | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-background-cold-'));
  storeDirectory = undefined;
});

/** 新的存放處把手：第一次建，之後打開同一個目錄（每個 `createJsonlSessionStore` 都會開一個新的 run 目錄）。 */
function openStore() {
  if (storeDirectory === undefined) {
    const store = createJsonlSessionStore({ rootDir: join(dir, 'logs') });
    storeDirectory = store.directory;
    return store;
  }
  return openJsonlSessionStore({ directory: storeDirectory });
}
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function until(predicate: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** 一則訊息的可比較形狀（型別加文字）。 */
const shape = (message: BaseMessage) => ({ type: message.type, content: message.content });
/** prompt 去掉系統訊息（兩個行程的系統提示詞本來就可以不同）。 */
const conversation = (prompt: readonly BaseMessage[]) =>
  prompt.filter((message) => message.type !== 'system').map(shape);

/** 兩種 worker 各有一顆工具 `note`（回一段可辨認的結果），`hold` 是第二個行程用來佔住名額的。 */
function workers(models: Record<'worker-a' | 'worker-b', ScriptedChatModel>, hold?: Promise<void>) {
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

const workerTurns = (name: string): ScriptedTurn[] => [
  { content: '', toolCalls: [{ name: 'note', id: `${name}-note`, args: {} }] },
  { content: `${name} 做完` },
];

interface Booted {
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
async function boot(options: {
  readonly rootTurns: ScriptedTurn[];
  readonly turnsFor: (name: 'worker-a' | 'worker-b') => ScriptedTurn[];
  readonly resume?: boolean;
  readonly maxActive?: number;
  readonly hold?: Promise<void>;
}): Promise<Booted> {
  const store = openStore();
  const models = {
    'worker-a': new ScriptedChatModel({ turns: options.turnsFor('worker-a') }),
    'worker-b': new ScriptedChatModel({ turns: options.turnsFor('worker-b') }),
  };
  const built = await createNexusAgent({
    model: new ScriptedChatModel({ turns: options.rootTurns }),
    checkpointer: new MemorySaver(),
    plugins: [workers(models, options.hold)],
    backend: new ContainedFilesystemBackend({
      rootDir: join(dir, 'workspace'),
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
      resumedRoot: { stored: resumed.stored, storedCount: resumed.events.length },
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

const delegateBoth: ScriptedTurn = {
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
async function firstProcess() {
  const first = await boot({
    rootTurns: [delegateBoth, { content: '根收尾' }],
    turnsFor: workerTurns,
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

const SEND_MESSAGE_TURN = (runId: string): ScriptedTurn => ({
  content: '',
  toolCalls: [
    { name: 'send_message', id: 'wake-call', args: { agent_id: runId, message: '模型叫醒' } },
  ],
});

describe('重啟之後送話叫醒背景子代理', () => {
  it('wire 路徑：列出不復活、現況第一份就含叫得醒的、送話叫醒、看得到重啟之前的對話、日誌往原檔續寫', async () => {
    const { a, b } = await firstProcess();
    // 重啟之前那一份對話是真的有東西：任務、工具呼叫、工具結果、結語。
    expect(a.before.map((message) => message.type)).toEqual(['human', 'ai', 'tool']);

    const second = await boot({
      rootTurns: [{ content: '根' }],
      turnsFor: (name) => [{ content: `${name} 醒來答覆` }],
      resume: true,
    });
    try {
      const background = second.detach.background!;
      // 還沒送話：沒有任何子代理的模型被叫過、子日誌沒有在註冊表上。
      expect(second.models['worker-a'].prompts).toEqual([]);
      expect(second.pump.sessions.get({ kind: 'subagent', runId: a.runId })).toBeUndefined();

      await background.sendFromUser(a.runId, '重啟後的話');
      await until(
        () =>
          second.pump.sessions
            .get({ kind: 'subagent', runId: a.runId })
            ?.events.filter((event) => event.type === 'turn/end').length === 2,
      );
      // 現況第一份就含兩個叫得醒的（掃完才送），舊版寫的那個不在裡面。
      expect(second.statuses[0]).toEqual([
        { runId: a.runId, status: 'idle' },
        { runId: b.runId, status: 'idle' },
      ]);
      // 看得到重啟之前的對話：以重啟之前那一份為前綴，工具結果逐字相同；後面接上新的一句。
      const prompt = conversation(second.models['worker-a'].lastPrompt);
      expect(prompt.slice(0, a.before.length)).toEqual(a.before);
      expect(prompt.slice(a.before.length).map((message) => message.type)).toEqual(['ai', 'human']);
      expect(prompt.at(-1)).toEqual({ type: 'human', content: '重啟後的話' });
      // 另一個還是冷的，沒被碰。
      expect(second.models['worker-b'].prompts).toEqual([]);

      // 日誌往原檔續寫，seq 連續；身分只有一顆；中間只有一顆 end-seed；新的一輪接在後面。
      await second.shutdown();
      const store = openStore();
      const events = await (await store.open(`${ROOT}/${a.runId}`, 'read')).read();
      expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index));
      const types = events.map((event) => event.type);
      expect(types.filter((type) => type === 'subagent/descriptor')).toHaveLength(1);
      expect(types.filter((type) => type === 'session/end-seed')).toHaveLength(1);
      // 重啟之前的一輪在 end-seed 前面，重啟之後的一輪在後面。
      const seedAt = types.indexOf('session/end-seed');
      expect(types.slice(0, seedAt).filter((type) => type === 'turn/start')).toHaveLength(1);
      expect(types.slice(seedAt + 1).filter((type) => type === 'turn/start')).toHaveLength(1);
      expect(types.at(-1)).toBe('turn/end');
    } finally {
      await second.shutdown().catch(() => undefined);
    }
  }, 30000);

  it('名額在重建之前佔：滿了拒絕、騰出來就叫得醒', async () => {
    const { a, b } = await firstProcess();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const second = await boot({
      rootTurns: [{ content: '根' }],
      turnsFor: (name) =>
        name === 'worker-a'
          ? [
              { content: '', toolCalls: [{ name: 'hold', id: 'hold-call', args: {} }] },
              { content: 'a 醒來答覆' },
            ]
          : [{ content: 'b 醒來答覆' }],
      resume: true,
      maxActive: 1,
      hold,
    });
    try {
      const background = second.detach.background!;
      await background.sendFromUser(a.runId, '甲先醒');
      await until(() => second.models['worker-a'].prompts.length > 0);
      // a 卡在 hold 上佔著唯一的名額：b 叫不醒，而且根本沒去握它的租約（日誌沒開在註冊表上）。
      await expect(background.sendFromUser(b.runId, '乙也要醒')).rejects.toMatchObject({
        name: 'BackgroundSubagentError',
        code: 'at-capacity',
      });
      expect(second.pump.sessions.get({ kind: 'subagent', runId: b.runId })).toBeUndefined();
      // 租約沒被佔：另一個把手現在拿得到 b 的寫入權。
      const probe = openStore();
      await (await probe.resume(`${ROOT}/${b.runId}`)).stored.close();

      release();
      await until(
        () =>
          second.pump.sessions
            .get({ kind: 'subagent', runId: a.runId })!
            .events.filter((event) => event.type === 'turn/end').length === 2,
      );
      await until(
        () => second.statuses.at(-1)?.find((s) => s.runId === a.runId)?.status === 'idle',
      );
      await background.sendFromUser(b.runId, '乙現在可以了');
      await until(() => second.models['worker-b'].prompts.length > 0);
    } finally {
      release();
      await second.shutdown();
    }
  }, 30000);

  it('舊日誌沒有身分：不擋啟動；列出來附原因；送話回找不到並說明；現況裡沒有它', async () => {
    const { a } = await firstProcess();
    const second = await boot({
      rootTurns: [{ content: '根' }],
      turnsFor: (name) => [{ content: `${name} 醒來答覆` }],
      resume: true,
    });
    try {
      const background = second.detach.background!;
      await expect(background.sendFromUser('bg-legacy000000', '醒醒')).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof BackgroundSubagentError &&
          error.code === 'not-found' &&
          error.message.includes('叫不醒') &&
          error.message.includes('subagent/descriptor'),
      );
      expect(second.statuses[0]?.map((item) => item.runId)).toEqual([a.runId, expect.any(String)]);
      expect(second.statuses[0]?.some((item) => item.runId === 'bg-legacy000000')).toBe(false);
    } finally {
      await second.shutdown();
    }
  }, 30000);

  it('模型用 send_message 也叫得醒', async () => {
    const { a } = await firstProcess();
    const second = await boot({
      rootTurns: [SEND_MESSAGE_TURN(a.runId), { content: '根收尾' }],
      turnsFor: (name) => [{ content: `${name} 醒來答覆` }],
      resume: true,
    });
    try {
      await second.pump.submit({ kind: 'message', text: '叫 a 起來' });
      await second.pump.whenIdle();
      await until(() => second.models['worker-a'].prompts.length > 0);
      const prompt = conversation(second.models['worker-a'].lastPrompt);
      expect(prompt.slice(0, a.before.length)).toEqual(a.before);
      // 模型寫的話帶 dsh 的前綴，不是人說的原文。
      expect(String(prompt.at(-1)?.content)).toMatch(/sent a message: 模型叫醒$/);
    } finally {
      await second.shutdown();
    }
  }, 30000);
});
