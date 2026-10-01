/**
 * 背景子代理現況在線上的形狀（[#867](https://github.com/DemianLi/nexus-agent/issues/867)）：真的組裝、真的 wire handler，
 * 折進 `@nexus/wire` 的折疊器，看畫面拿到什麼。
 *
 * 要釘的四件事：跑著是 `running`、做完是 `idle`；`subagent.send` 叫醒之後又回到 `running`；**重新接上的下行在註冊當下先收到
 * 目前那一份**（歷史沒有它）；沒有背景派出的 thread 一顆都沒有。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import type { PluginEntry } from '@nexus/core';
import { createWireClient, emptyConversation, reduceAll, SUBAGENT_STATUS } from '@nexus/wire';
import type { ConversationState, Event } from '@nexus/wire';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { emptyCommandPoint, loopbackRequest, TEST_BROWSER_AUTH } from './fixtures.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';
import type { WireHandler } from './wire-handler.js';

let dir: string;
const opened: WireHandler[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-subagent-status-'));
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

const isStatus = (frame: Event): boolean =>
  frame.method === 'custom' && (frame.params.data as { name?: unknown }).name === SUBAGENT_STATUS;

/** 這顆 frame 的酬載：`bg-…:running` 之類，逗號相連。 */
const itemsOf = (frame: Event): string =>
  (frame.params.data as { payload: { items: { runId: string; status: string }[] } }).payload.items
    .map((item) => `${item.runId}:${item.status}`)
    .join(',');

const delegate = (background: boolean): ScriptedTurn => ({
  content: '委派。',
  toolCalls: [
    {
      name: 'subagent',
      id: 'root-call',
      args: { description: '幹活', subagent_type: 'worker', run_in_background: background },
    },
  ],
});

async function assemble(options: { readonly background: boolean; readonly configured?: boolean }) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const workerModel = new ScriptedChatModel({
    turns: [
      { content: '先等閘門。', toolCalls: [{ name: 'gate', id: 'w-gate', args: {} }] },
      { content: '做完了。' },
      { content: '第二次也做完了。' },
    ],
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
  const built = await createNexusAgent({
    model: new ScriptedChatModel({
      turns: [delegate(options.background), { content: '派出去了，等通知。' }],
    }),
    checkpointer: new MemorySaver(),
    plugins: [worker],
    backend: new ContainedFilesystemBackend({ rootDir: dir, mode: 'workspace-write' }),
    ...(options.configured !== false && { backgroundSubagents: {} }),
  });
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    createAgent: async () => ({
      agent: built.agent as unknown as PumpAgent,
      commands: emptyCommandPoint(),
      dispose: () => built.dispose(),
      attachSession: (registry, port) => built.attachSession(registry, port),
    }),
  });
  opened.push(handler);
  const client = createWireClient({
    baseUrl: 'http://status.test',
    fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
  });

  /** 開一條下行，把收到的 frame 都記下來並折起來。 */
  async function listen() {
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
    return {
      frames,
      state: (): ConversationState => reduceAll(emptyConversation(), frames),
      close: () => line.abort(),
    };
  }
  return { client, listen, release, workerModel };
}

describe('背景子代理現況', () => {
  it('running → idle → 被 subagent.send 叫醒又 running → idle；折出來的 subagentStatus 跟著走', async () => {
    const rig = await assemble({ background: true });
    const feed = await rig.listen();
    // 下行一開就先收到一份空的（thread 剛建起來，還沒派任何子代理）：收過空快照才是 `{}`，不是 `null`。
    await until(() => feed.state().subagentStatus !== null);
    expect(feed.state().subagentStatus).toEqual({});
    await rig.client.runStart('t1', '委派');
    await until(() => Object.keys(feed.state().subagentStatus ?? {}).length > 0);
    const runId = Object.keys(feed.state().subagentStatus ?? {})[0]!;
    expect(runId).toMatch(/^bg-/);
    expect(feed.state().subagentStatus).toEqual({ [runId]: 'running' });

    rig.release();
    await until(() => feed.state().subagentStatus?.[runId] === 'idle');

    expect(await rig.client.subagentSend('t1', runId, '再做一次')).toMatchObject({
      type: 'success',
    });
    await until(() => feed.state().subagentStatus?.[runId] === 'running');
    await until(() => feed.state().subagentStatus?.[runId] === 'idle');
    const sequence = feed.frames.filter(isStatus).map(itemsOf);
    expect(sequence).toEqual([
      '',
      `${runId}:running`,
      `${runId}:idle`,
      `${runId}:running`,
      `${runId}:idle`,
    ]);
    feed.close();
  }, 20000);

  it('重新接上的下行在註冊當下先收到目前那一份，而且是原本那顆的號', async () => {
    const rig = await assemble({ background: true });
    const first = await rig.listen();
    await rig.client.runStart('t1', '委派');
    await until(() => Object.keys(first.state().subagentStatus ?? {}).length > 0);
    const runId = Object.keys(first.state().subagentStatus ?? {})[0]!;
    const live = first.frames.filter(isStatus).find((frame) => itemsOf(frame) !== '')!;

    // 子代理還卡在 gate 上：此刻才接上的第二條下行，**頭一顆**就是現況。
    const late = await rig.listen();
    await until(() => late.frames.some(isStatus));
    const snapshot = late.frames.find(isStatus)!;
    expect(itemsOf(snapshot)).toBe(`${runId}:running`);
    expect(snapshot.seq).toBe(live.seq);
    expect(late.state().subagentStatus).toEqual({ [runId]: 'running' });

    // 做完之後再接上的：補送的是 idle，不是舊的 running。
    rig.release();
    await until(() => first.state().subagentStatus?.[runId] === 'idle');
    const later = await rig.listen();
    await until(() => later.frames.some(isStatus));
    expect(later.state().subagentStatus).toEqual({ [runId]: 'idle' });
    first.close();
    late.close();
    later.close();
  }, 20000);

  it('有背景派出的組裝、但沒有任何背景子代理（前景委派／重啟後）：接上就是一份空的，subagentStatus 是 {} 不是 null', async () => {
    const rig = await assemble({ background: false });
    rig.release();
    const feed = await rig.listen();
    // 下行一開就要有：此刻 thread 才建起來，接上的當下送了空快照，新下行補送。
    await rig.client.runStart('t1', '委派');
    await until(() => feed.frames.some(isStatus));
    expect(feed.frames.filter(isStatus).map(itemsOf)).toEqual(['']);
    expect(feed.state().subagentStatus).toEqual({});
    feed.close();
  }, 20000);

  it('沒有背景派出的組裝：一顆都不送，subagentStatus 永遠是 null（不下判斷）', async () => {
    const rig = await assemble({ background: false, configured: false });
    rig.release();
    const feed = await rig.listen();
    await rig.client.runStart('t1', '委派');
    await until(() =>
      feed.frames.some(
        (frame) =>
          frame.method === 'lifecycle' &&
          (frame.params.data as { event?: unknown }).event === 'completed' &&
          frame.params.namespace.length === 0,
      ),
    );
    expect(feed.frames.filter(isStatus)).toEqual([]);
    expect(feed.state().subagentStatus).toBeNull();
    feed.close();
  }, 20000);
});
