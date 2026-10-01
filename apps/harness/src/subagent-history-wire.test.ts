/**
 * 背景子代理自己那份對話的歷史（[#871](https://github.com/DemianLi/nexus-agent/issues/871)）：真的組裝、真的 wire handler，
 * 折進 `@nexus/wire` 的折疊器，看畫面拿到什麼。
 *
 * 要釘的事：人對子代理說的話（派出去那句與之後 `subagent.send` 的）、子代理自己的工具卡與回覆都讀得到，而且是**獨立**的一條對話
 * （不混進主對話）；找不到一律 `subagent_not_found`（編號長得不對、不是這條 thread 的、沒有這份日誌）；thread 沒載入時不建 agent，
 * 讀落盤的那份。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import type { PluginEntry, SessionEvent } from '@nexus/core';
import { createWireClient, emptyConversation, reduceAll, subagentHistoryPath } from '@nexus/wire';
import type { ConversationEntry, ConversationState, Event } from '@nexus/wire';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { emptyCommandPoint, loopbackRequest, TEST_BROWSER_AUTH } from './fixtures.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';
import type { WireHandler, WireHandlerOptions } from './wire-handler.js';
import { composeAttachSessions } from './session-attach.js';

let dir: string;
const opened: WireHandler[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-subagent-history-'));
});
afterEach(async () => {
  for (const handler of opened.splice(0)) await handler.close();
  await rm(dir, { recursive: true, force: true });
});

async function until(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function humans(state: ConversationState): string[] {
  return state.entries.flatMap((entry) => (entry.kind === 'human' ? [entry.text] : []));
}
function kinds(entries: readonly ConversationEntry[]): string[] {
  return entries.map((entry) => (entry.kind === 'tool' ? `tool:${entry.name}` : entry.kind));
}

async function assemble(extra: Partial<WireHandlerOptions> = {}) {
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
          model: new ScriptedChatModel({
            turns: [
              { content: '先等閘門。', toolCalls: [{ name: 'gate', id: 'w-gate', args: {} }] },
              { content: '做完了。' },
              { content: '第二次也做完了。' },
            ],
          }) as never,
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
  const warnings: string[] = [];
  const built = await createNexusAgent({
    model: new ScriptedChatModel({
      turns: [
        {
          content: '委派。',
          toolCalls: [
            {
              name: 'subagent',
              id: 'root-call',
              args: { description: '幹活', subagent_type: 'worker', run_in_background: true },
            },
          ],
        },
        { content: '派出去了，等通知。' },
      ],
    }),
    checkpointer: new MemorySaver(),
    plugins: [worker],
    backend: new ContainedFilesystemBackend({ rootDir: dir, mode: 'workspace-write' }),
    backgroundSubagents: {},
  });
  let created = 0;
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    warn: (message) => warnings.push(message),
    createAgent: async () => {
      created += 1;
      return {
        agent: built.agent as unknown as PumpAgent,
        commands: emptyCommandPoint(),
        dispose: () => built.dispose(),
        attachSessions: composeAttachSessions(built),
      };
    },
    ...extra,
  });
  opened.push(handler);
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) =>
    handler.handle(loopbackRequest(input as string, init));
  const client = createWireClient({ baseUrl: 'http://history.test', fetch: fetchImpl });

  /** 派出去，等狀態投影出現那顆子代理，回它的編號（此刻它卡在 gate 上）。 */
  async function dispatch(): Promise<string> {
    const frames: Event[] = [];
    const line = new AbortController();
    const stream = await client.openEvents('t1', { signal: line.signal });
    void (async () => {
      try {
        for await (const frame of stream) frames.push(frame);
      } catch {
        // 中止收線。
      }
    })();
    await client.runStart('t1', '委派');
    const status = () => reduceAll(emptyConversation(), frames).subagentStatus ?? {};
    await until(() => Object.keys(status()).length > 0);
    line.abort();
    return Object.keys(status())[0]!;
  }
  return { client, fetchImpl, release, warnings, created: () => created, dispatch };
}

async function folded(
  client: ReturnType<typeof createWireClient>,
  runId: string,
): Promise<ConversationState> {
  const outcome = await client.subagentHistory('t1', runId);
  if (outcome.kind !== 'ok') throw new Error(`讀不到：${outcome.message}`);
  return reduceAll(emptyConversation(), outcome.result.events);
}

/** 歷史是一次性的 GET：條件還沒成立就隔一下重讀。 */
async function foldedUntil(
  client: ReturnType<typeof createWireClient>,
  runId: string,
  ready: (state: ConversationState) => boolean,
): Promise<ConversationState> {
  const start = Date.now();
  for (;;) {
    const state = await folded(client, runId);
    if (ready(state)) return state;
    if (Date.now() - start > 5000) throw new Error('歷史等太久了');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function aiTexts(state: ConversationState): string[] {
  return state.entries.flatMap((entry) => (entry.kind === 'ai' ? [entry.text] : []));
}

describe('背景子代理自己的歷史', () => {
  it('載入著的 thread：派出去那句、工具卡、回覆與之後 subagent.send 的人話都在，而且不混進主對話', async () => {
    const rig = await assemble();
    const runId = await rig.dispatch();
    try {
      // 子代理還卡在 gate 上：已經有派給它的那句與正在跑的工具卡。
      const running = await folded(rig.client, runId);
      expect(kinds(running.entries)).toEqual(['human', 'ai', 'tool:gate']);
      expect(humans(running)).toHaveLength(1);
      expect(humans(running)[0]).toMatch(/^幹活/);
    } finally {
      rig.release();
    }

    // 做完：收尾的回覆在。
    const done = await foldedUntil(rig.client, runId, (state) =>
      aiTexts(state).includes('做完了。'),
    );
    expect(aiTexts(done)).toContain('做完了。');
    expect(done.entries.find((entry) => entry.kind === 'tool')).toMatchObject({
      name: 'gate',
      status: 'done',
    });

    // 人對它說話：進它自己那份，不進主對話。
    expect(await rig.client.subagentSend('t1', runId, '再做一次')).toMatchObject({
      type: 'success',
    });
    const again = await foldedUntil(rig.client, runId, (state) =>
      aiTexts(state).includes('第二次也做完了。'),
    );
    expect(humans(again)).toHaveLength(2);
    expect(humans(again)[1]).toBe('再做一次');
    expect(aiTexts(again)).toContain('第二次也做完了。');

    const main = await rig.client.threadHistory('t1');
    if (main.kind !== 'ok') throw new Error(main.message);
    expect(humans(reduceAll(emptyConversation(), main.result.events))).not.toContain('再做一次');
  }, 20000);

  it('找不到一律 subagent_not_found：編號長得不對、不是這條 thread 的、沒有這一份；不建 agent', async () => {
    const rig = await assemble();
    const runId = await rig.dispatch();
    rig.release();
    const created = rig.created();

    const rejected = async (thread: string, id: string) => {
      const response = await rig.fetchImpl(
        `http://history.test${subagentHistoryPath(thread, id)}`,
        { method: 'GET', headers: { 'content-type': 'application/json' } },
      );
      return (await response.json()) as { type: string; error?: string };
    };
    // 長得不對（含夾了斜線的）、沒這個編號、別條 thread 底下的同一個編號。
    for (const [thread, id] of [
      ['t1', 'not-a-run'],
      ['t1', 'bg-0123456789ab/x'],
      ['t1', 'bg-ffffffffffff'],
      ['t2', runId],
    ] as const) {
      expect(await rejected(thread, id)).toMatchObject({
        type: 'error',
        error: 'subagent_not_found',
      });
    }
    expect(await rig.client.subagentHistory('t2', runId)).toMatchObject({ kind: 'rejected' });
    expect(rig.created()).toBe(created);
  }, 20000);

  it('查詢參數同主歷史：maxMessages 不是整數是 invalid_argument；合法的分頁照給，frame 不帶 seq', async () => {
    const rig = await assemble();
    const runId = await rig.dispatch();
    rig.release();
    await foldedUntil(rig.client, runId, (state) => aiTexts(state).includes('做完了。'));

    const bad = await rig.fetchImpl(
      `http://history.test${subagentHistoryPath('t1', runId)}?maxMessages=abc`,
      { method: 'GET', headers: { 'content-type': 'application/json' } },
    );
    expect(await bad.json()).toMatchObject({ type: 'error', error: 'invalid_argument' });

    const outcome = await rig.client.subagentHistory('t1', runId, { maxMessages: 1 });
    if (outcome.kind !== 'ok') throw new Error(outcome.message);
    expect(outcome.result.events.length).toBeGreaterThan(0);
    for (const frame of outcome.result.events) expect(frame).not.toHaveProperty('seq');
  }, 20000);

  it('thread 沒載入（重啟之後）：不建 agent，讀 readSubagentSession 給的那份；讀不到或拋錯都是找不到', async () => {
    const seen: string[] = [];
    let behave: 'found' | 'missing' | 'throws' = 'found';
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 1, data: { kind: 'message', text: '冷的那句' } },
      { type: 'turn/end', seq: 1, time: 2, data: {} },
    ] as unknown as SessionEvent[];
    const rig = await assemble({
      readSubagentSession: async (threadId, runId) => {
        seen.push(`${threadId}/${runId}`);
        if (behave === 'throws') throw new Error('壞檔');
        return behave === 'found' ? events : undefined;
      },
    });
    const id = 'bg-0123456789ab';

    const cold = await folded(rig.client, id);
    expect(humans(cold)).toEqual(['冷的那句']);
    expect(seen).toEqual([`t1/${id}`]);
    expect(rig.created()).toBe(0);

    // 編號長得不對的，連冷讀都不問（`<thread>/<runId>` 是後端的 id，不讓人拿它組出別的檔）。
    expect(await rig.client.subagentHistory('t1', '../alpha')).toMatchObject({ kind: 'rejected' });
    expect(seen).toEqual([`t1/${id}`]);

    behave = 'missing';
    expect(await rig.client.subagentHistory('t1', id)).toMatchObject({ kind: 'rejected' });
    behave = 'throws';
    expect(await rig.client.subagentHistory('t1', id)).toMatchObject({ kind: 'rejected' });
    expect(rig.warnings.some((message) => message.includes('壞檔'))).toBe(true);
    expect(rig.created()).toBe(0);
  });
});
