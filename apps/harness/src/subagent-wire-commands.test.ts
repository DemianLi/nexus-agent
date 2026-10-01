/**
 * 對單一背景子代理傳話與單獨停下的 wire 命令（[#865](https://github.com/DemianLi/nexus-agent/issues/865)）。
 *
 * 兩層：
 *
 * - **替身控制面**：參數驗證、回應形狀、host 的拒絕譯成三個錯誤碼、沒開過的 thread 與沒有背景派出的組裝。
 * - **真組裝**：真的 `createNexusAgent`＋背景子代理，從 wire 送 `subagent.send`，看子代理自己的日誌與它下一步讀到的字；
 *   `subagent.interrupt` 只停它、不連帶 root。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import type { PluginEntry, SessionRegistry } from '@nexus/core';
import {
  createWireClient,
  SUBAGENT_AT_CAPACITY,
  SUBAGENT_CLOSED,
  SUBAGENT_INTERRUPT_METHOD,
  SUBAGENT_NOT_FOUND,
  SUBAGENT_SEND_METHOD,
} from '@nexus/wire';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { BackgroundSubagentError } from './background-subagents.js';
import type { BackgroundSubagentControl } from './background-subagents.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { emptyCommandPoint, loopbackRequest, noSessions, TEST_BROWSER_AUTH } from './fixtures.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';
import type { WireHandler } from './wire-handler.js';
import { composeAttachSessions } from './session-attach.js';

async function until(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const opened: WireHandler[] = [];
afterEach(async () => {
  for (const handler of opened.splice(0)) await handler.close();
});

function rig(createAgent: Parameters<typeof createWireHandler>[0]['createAgent']) {
  const handler = createWireHandler({ auth: TEST_BROWSER_AUTH, createAgent });
  opened.push(handler);
  const fetch = async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
    handler.handle(loopbackRequest(input as string, init));
  const client = createWireClient({ baseUrl: 'http://subagent.test', fetch });
  let nextId = 1;
  /** 直接打命令：client 的型別送不出的封包（缺 run_id、空白 text），伺服器那一側要自己認。 */
  const raw = async (thread: string, method: string, params: unknown) => {
    const response = await fetch(`http://subagent.test/threads/${thread}/commands/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: nextId++, method, params }),
    });
    return (await response.json()) as Record<string, unknown>;
  };
  return { client, raw };
}

const ACCEPTED = { type: 'success', result: { accepted: true } };

describe('替身控制面：wire 這一層', () => {
  function stubbed(control: BackgroundSubagentControl | undefined) {
    return rig(async () => ({
      agent: {} as PumpAgent,
      commands: emptyCommandPoint(),
      dispose: async () => {},
      attachSessions: () => ({
        detach: async () => {},
        ...(control !== undefined && { background: control }),
      }),
    }));
  }

  /** 記下每一次呼叫；`reject` 設了，送話就拋它。 */
  function recorder(reject?: BackgroundSubagentError) {
    const calls: string[] = [];
    const control: BackgroundSubagentControl = {
      sendFromUser: (runId, text) => {
        calls.push(`send:${runId}:${text}`);
        if (reject !== undefined) throw reject;
      },
      interrupt: (runId) => {
        calls.push(`interrupt:${runId}`);
        return runId === 'bg-live';
      },
    };
    return { calls, control };
  }

  it('subagent.send：受理就回 accepted，文字原封不動交給控制面', async () => {
    const { calls, control } = recorder();
    const { client } = stubbed(control);
    await client.slashList('t1'); // 建出 thread
    expect(await client.subagentSend('t1', 'bg-live', '  先看 b.ts\n')).toMatchObject(ACCEPTED);
    expect(calls).toEqual(['send:bg-live:  先看 b.ts\n']);
  });

  it('subagent.send 的參數：缺 run_id、空白 text 是 invalid_argument，而且沒送到控制面', async () => {
    const { calls, control } = recorder();
    const { client, raw } = stubbed(control);
    await client.slashList('t1');
    expect(await raw('t1', SUBAGENT_SEND_METHOD, { text: '嗨' })).toMatchObject({
      type: 'error',
      error: 'invalid_argument',
    });
    expect(await raw('t1', SUBAGENT_SEND_METHOD, { run_id: '', text: '嗨' })).toMatchObject({
      error: 'invalid_argument',
    });
    expect(
      await raw('t1', SUBAGENT_SEND_METHOD, { run_id: 'bg-live', text: ' \n ' }),
    ).toMatchObject({ error: 'invalid_argument' });
    expect(await raw('t1', SUBAGENT_SEND_METHOD, { run_id: 'bg-live', text: 3 })).toMatchObject({
      error: 'invalid_argument',
    });
    expect(await raw('t1', SUBAGENT_SEND_METHOD, undefined)).toMatchObject({
      error: 'invalid_argument',
    });
    expect(calls).toEqual([]);
  });

  it('host 的三種拒絕各譯成自己的錯誤碼，訊息原樣帶過去', async () => {
    const cases = [
      ['not-found', SUBAGENT_NOT_FOUND],
      ['at-capacity', SUBAGENT_AT_CAPACITY],
      ['closed', SUBAGENT_CLOSED],
    ] as const;
    for (const [code, wireCode] of cases) {
      const { control } = recorder(new BackgroundSubagentError(code, `原因：${code}`));
      const { client } = stubbed(control);
      await client.slashList('t1');
      expect(await client.subagentSend('t1', 'bg-x', '嗨')).toMatchObject({
        type: 'error',
        error: wireCode,
        message: `原因：${code}`,
      });
    }
  });

  it('不是型別化的拒絕（程式錯）不被吞成業務錯誤碼', async () => {
    const control: BackgroundSubagentControl = {
      sendFromUser: () => {
        throw new Error('壞掉了');
      },
      interrupt: () => false,
    };
    const { client } = stubbed(control);
    await client.slashList('t1');
    await expect(client.subagentSend('t1', 'bg-x', '嗨')).rejects.toThrow();
  });

  it('subagent.interrupt：交給控制面；不認得的編號也是 accepted（no-op，不讓人試探編號）', async () => {
    const { calls, control } = recorder();
    const { client, raw } = stubbed(control);
    await client.slashList('t1');
    expect(await client.subagentInterrupt('t1', 'bg-live')).toMatchObject(ACCEPTED);
    expect(await client.subagentInterrupt('t1', 'bg-ghost')).toMatchObject(ACCEPTED);
    expect(calls).toEqual(['interrupt:bg-live', 'interrupt:bg-ghost']);
    expect(await raw('t1', SUBAGENT_INTERRUPT_METHOD, {})).toMatchObject({
      error: 'invalid_argument',
    });
  });

  it('沒開過的 thread、或這份組裝沒有背景派出：send 是 subagent_not_found，interrupt 是 accepted；而且不為此建 agent', async () => {
    let built = 0;
    const cold = rig(async () => {
      built += 1;
      return {
        agent: {} as PumpAgent,
        attachSessions: noSessions,
        commands: emptyCommandPoint(),
        dispose: async () => {},
      };
    });
    expect(await cold.client.subagentSend('never-opened', 'bg-x', '嗨')).toMatchObject({
      type: 'error',
      error: SUBAGENT_NOT_FOUND,
    });
    expect(await cold.client.subagentInterrupt('never-opened', 'bg-x')).toMatchObject(ACCEPTED);
    expect(built).toBe(0);

    const { client } = stubbed(undefined);
    await client.slashList('t1');
    expect(await client.subagentSend('t1', 'bg-x', '嗨')).toMatchObject({
      type: 'error',
      error: SUBAGENT_NOT_FOUND,
    });
    expect(await client.subagentInterrupt('t1', 'bg-x')).toMatchObject(ACCEPTED);
  });

  it('封包的 method 與路徑不合照舊被擋', async () => {
    const { client } = stubbed(recorder().control);
    await client.slashList('t1');
    const handler = opened.at(-1)!;
    const res = await handler.handle(
      loopbackRequest(`http://subagent.test/threads/t1/commands/${SUBAGENT_SEND_METHOD}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 1, method: SUBAGENT_INTERRUPT_METHOD, params: { run_id: 'a' } }),
      }),
    );
    expect(await res.json()).toMatchObject({ type: 'error', error: 'invalid_argument' });
  });
});

// ───────────────────────────── 真組裝 ─────────────────────────────

describe('真組裝：從 wire 對背景子代理傳話、單獨停', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nexus-subagent-wire-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const delegate: ScriptedTurn = {
    content: '委派。',
    toolCalls: [
      {
        name: 'subagent',
        id: 'root-call',
        args: { description: '幹活', subagent_type: 'worker', run_in_background: true },
      },
    ],
  };

  async function assemble(workerTurns: readonly ScriptedTurn[]) {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worker: PluginEntry = {
      plugin: {
        name: 'worker-host',
        apply(registry) {
          registry.subagents.register({
            name: 'worker',
            description: '幹活的。',
            systemPrompt: '你是 worker。',
            model: workerModel as never,
          });
          registry.tools.register(
            tool(async () => (await gate, '放行了'), {
              name: 'gate',
              description: '等放行。',
              schema: z.object({}),
            }),
          );
        },
      },
    };
    const workerModel = new ScriptedChatModel({ turns: workerTurns });
    const rootModel = new ScriptedChatModel({
      turns: [delegate, { content: '派出去了，等通知。' }],
    });
    const built = await createNexusAgent({
      model: rootModel,
      checkpointer: new MemorySaver(),
      plugins: [worker],
      backend: new ContainedFilesystemBackend({ rootDir: dir, mode: 'workspace-write' }),
      backgroundSubagents: {},
    });
    let sessions: SessionRegistry | undefined;
    const { client } = rig(async () => ({
      agent: built.agent as unknown as PumpAgent,
      commands: emptyCommandPoint(),
      dispose: () => built.dispose(),
      attachSessions: (registry, backgroundPort) => {
        sessions = registry;
        return composeAttachSessions(built)(registry, backgroundPort);
      },
    }));
    await client.runStart('t1', '委派');
    await until(() => sessions?.list().some((entry) => entry.address.kind === 'subagent') ?? false);
    const child = sessions!.list().find((entry) => entry.address.kind === 'subagent')!;
    const runId = (child.address as { runId: string }).runId;
    return { client, child: child.log, runId, release, workerModel, sessions: sessions! };
  }

  it('subagent.send：卡在工具的子代理下一步讀到的是原文（沒有 Agent … sent a message 前綴），日誌來源是 user', async () => {
    const rigged = await assemble([
      { content: '先等閘門。', toolCalls: [{ name: 'gate', id: 'w-gate', args: {} }] },
      { content: '收到，改看 b.ts。' },
    ]);
    // 子代理這一輪已經卡在 gate 上了才送：走「跑著、下一步領走」那條。
    await until(() => rigged.workerModel.prompts.length >= 1);
    expect(await rigged.client.subagentSend('t1', rigged.runId, '改看 b.ts')).toMatchObject(
      ACCEPTED,
    );
    rigged.release();
    await until(() => rigged.workerModel.prompts.length >= 2);
    const secondStep = (rigged.workerModel.prompts[1] ?? []).map((message) => message.text);
    expect(secondStep).toContain('改看 b.ts');
    expect(secondStep.join('\n')).not.toContain('sent a message');
    const logged = rigged.child.events.filter((event) => event.type === 'user/message');
    expect(logged.map((event) => (event.data as { source: unknown }).source)).toEqual([
      { kind: 'user' },
    ]);
  }, 20000);

  it('subagent.send 對不是這條 thread 派出去的編號：subagent_not_found', async () => {
    const rigged = await assemble([{ content: '做完了。' }]);
    expect(await rigged.client.subagentSend('t1', 'bg-not-mine', '嗨')).toMatchObject({
      type: 'error',
      error: SUBAGENT_NOT_FOUND,
    });
  }, 20000);

  it('subagent.interrupt：停子代理當下那一輪，日誌寫 aborted/parent', async () => {
    const rigged = await assemble([
      { content: '先等閘門。', toolCalls: [{ name: 'gate', id: 'w-gate', args: {} }] },
      { content: '不會走到。' },
    ]);
    await until(() => rigged.workerModel.prompts.length >= 1);
    expect(await rigged.client.subagentInterrupt('t1', rigged.runId)).toMatchObject(ACCEPTED);
    rigged.release();
    await until(() => rigged.child.events.some((event) => event.type === 'turn/end'));
    const end = rigged.child.events.find((event) => event.type === 'turn/end')!;
    expect(end.data).toEqual({ reason: { kind: 'aborted', cause: { kind: 'parent' } } });
  }, 20000);
});
