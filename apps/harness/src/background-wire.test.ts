/**
 * 背景子代理在線上的形狀（[#832](https://github.com/DemianLi/nexus-agent/issues/832)）：真的組裝、真的 pump，
 * 折進 `@nexus/wire` 的折疊器，看畫面拿到什麼。
 *
 * 要釘的三件事：背景那一輪的卡歸給派它的那個子代理；卡在 root 閒著的時候也會收；前景的 `subagent`
 * 照舊靠 `task` 那顆歸屬。假模型兩邊的 `tool_call_id` 給不撞的（折疊器照 id 認卡）。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tool } from '@langchain/core/tools';
import type { PluginEntry } from '@nexus/core';
import { emptyConversation, reduceAll } from '@nexus/wire';
import type { ConversationState, Event, ToolEntry } from '@nexus/wire';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { PrunedMemorySaver } from './pruned-memory-saver.js';
import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-bg-wire-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function until(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const isRootDone = (frame: Event): boolean =>
  frame.method === 'lifecycle' &&
  frame.params.namespace.length === 0 &&
  (frame.params.data as { graph_name?: unknown }).graph_name === 'root' &&
  ['completed', 'failed'].includes(String((frame.params.data as { event?: unknown }).event));

const delegate = (runInBackground: boolean): ScriptedTurn => ({
  content: '委派。',
  toolCalls: [
    {
      name: 'subagent',
      id: 'root-call',
      args: { description: '幹活', subagent_type: 'worker', run_in_background: runInBackground },
    },
  ],
});

/**
 * 真的組裝跑一輪到 root 收尾。子代理有一顆 `gate` 工具：等到放行才回，讓「root 已經閒著」成為可控的前提。
 *
 * @param open - 一開始就放行（前景要這樣，父輪在等它）。
 */
async function run(
  rootTurns: readonly ScriptedTurn[],
  workerTurns: readonly ScriptedTurn[],
  open: boolean,
) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  if (open) release();
  const worker: PluginEntry = {
    plugin: {
      name: 'worker-host',
      apply(registry) {
        registry.subagents.register({
          name: 'worker',
          description: '幹活的。',
          systemPrompt: '你是 worker。',
          model: new ScriptedChatModel({ turns: workerTurns }) as never,
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
    model: new ScriptedChatModel({ turns: rootTurns }),
    checkpointer: new PrunedMemorySaver(),
    plugins: [worker],
    backend: new ContainedFilesystemBackend({ rootDir: dir, mode: 'workspace-write' }),
    backgroundSubagents: {},
  });
  const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'bg-wire');
  const detach = built.attachSession(pump.sessions);
  const frames: Event[] = [];
  const line = new AbortController();
  const stream = pump.subscribe(['messages', 'tools', 'lifecycle', 'input'], line.signal);
  const draining = (async () => {
    for await (const frame of stream) frames.push(frame);
  })();
  await pump.submit({ kind: 'message', text: '委派' });
  await until(() => frames.some(isRootDone));
  await pump.whenIdle();
  return {
    release,
    state: (): ConversationState => reduceAll(emptyConversation(), frames),
    close: async () => {
      release();
      line.abort();
      await draining;
      detach();
      await built.dispose();
    },
  };
}

const statusOf = (state: ConversationState, callId: string): string | undefined => {
  const entry = state.entries.find((candidate) => candidate.id === `tool-${callId}`);
  return entry?.kind === 'tool' ? entry.status : undefined;
};

const toolEntry = (state: ConversationState, callId: string): ToolEntry => {
  const entry = state.entries.find((candidate) => candidate.id === `tool-${callId}`);
  if (entry?.kind !== 'tool') throw new Error(`折出來的對話裡沒有 ${callId} 這顆工具`);
  return entry;
};

describe('背景：卡歸給派它的子代理，root 閒著時也收', () => {
  it('root 那一輪已經收尾，背景的 gate 才放行：卡歸屬 worker、終態 done，root 那顆帶編號鑰匙', async () => {
    const r = await run(
      [delegate(true), { content: '根收尾' }],
      [
        { content: '', toolCalls: [{ name: 'gate', id: 'bg-call', args: {} }] },
        { content: '做完' },
      ],
      false,
    );
    try {
      // 卡從日誌開，背景那一輪停在 gate 上；此刻 root 已經閒著。
      await until(() => statusOf(r.state(), 'bg-call') === 'running');
      r.release();
      await until(() => statusOf(r.state(), 'bg-call') === 'done');

      const state = r.state();
      const root = toolEntry(state, 'root-call');
      expect(root.name).toBe('subagent');
      expect(root.meta).toMatchObject({ kind: 'background-subagent', subagentType: 'worker' });
      const { runId } = root.meta as { runId: string };
      expect(runId).toMatch(/^bg-[0-9a-f]{12}$/);

      const inner = toolEntry(state, 'bg-call');
      expect(inner.text).toBe('放行了');
      expect(inner.attribution).toEqual({ kind: 'subagent', name: 'worker', callId: 'root-call' });
      expect(state.subagents[runId]).toEqual({ name: 'worker', callId: 'root-call' });
    } finally {
      await r.close();
    }
  });
});

describe('前景：照今天的路徑歸屬', () => {
  it('subagent 前景派給 task，內部的卡歸給 worker；root 那顆是 subagent、不帶鑰匙', async () => {
    const r = await run(
      [delegate(false), { content: '根收尾' }],
      [
        { content: '', toolCalls: [{ name: 'gate', id: 'fg-call', args: {} }] },
        { content: '做完' },
      ],
      true,
    );
    try {
      await until(() => statusOf(r.state(), 'fg-call') === 'done');
      const state = r.state();
      const root = toolEntry(state, 'root-call');
      expect(root.name).toBe('subagent');
      expect(root.meta).toBeUndefined();
      const inner = toolEntry(state, 'fg-call');
      // 前景改派時 `task` 收到的是同一個 `tool_call_id`：歸屬的 callId 指回 root 那張 `subagent` 卡。
      expect(inner.attribution).toEqual({ kind: 'subagent', name: 'worker', callId: 'root-call' });
      expect(Object.values(state.subagents)).toEqual([{ name: 'worker', callId: 'root-call' }]);
    } finally {
      await r.close();
    }
  });
});
