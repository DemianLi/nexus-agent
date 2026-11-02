/**
 * **thread 身分拿得到嗎**（[#1418](https://github.com/DemianLi/nexus-agent/issues/1418) Q3 的前提證明，PR 的第一個 commit）。
 *
 * #1418 要讓「插件只套一次、也分得清這次呼叫是哪一條 thread」。Q3 拍板的來源是 LangGraph 的呼叫設定
 * （`configurable.thread_id`），對應 dsh 的 `exec.agent`：**身分隨呼叫明確傳進來**。卡上寫明這個前提「還沒實測」：
 * 只核過 `thread-pump.ts` 把 `thread_id` 交給圖、以及認會話的 `checkpoint_ns` 來自同一份設定。這一檔就是那個實測，
 * 量三種情況下**工具 handler 的第二個參數**與 **middleware 的 `request.runtime.configurable`** 各看到什麼：
 *
 * 1. 根 agent；
 * 2. 同步子代理（`task` 派出去、在父圖裡跑）；
 * 3. 背景子代理（`BackgroundSubagentHost` 在 `task` 之外用自己的 `thread_id` 拉起）。
 *
 * 這一檔只量、不改產品程式碼。證明不了就停下來回報到卡上，不換別的來源（PM 派工第 1 點）。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tool } from '@langchain/core/tools';
import type { PluginEntry } from '@nexus/core';
import { toolCallSessionAddress } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { BackgroundSubagentHost } from './background-subagents.js';
import type { BackgroundAgent } from './background-subagents.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { PrunedMemorySaver } from './pruned-memory-saver.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

const ROOT_THREAD = 'tid-root';

/** 一次觀測：在哪一種位置、哪一個 agent 的呼叫、看到的 configurable 上跟身分有關的鍵。 */
interface Observation {
  readonly where: 'tool' | 'wrapToolCall' | 'wrapModelCall';
  /** 工具名（工具 handler 與 `wrapToolCall`）；`wrapModelCall` 沒有。 */
  readonly tool?: string;
  readonly threadId: unknown;
  readonly checkpointNs: unknown;
  readonly background: unknown;
  /** 同一份設定餵給現行的身分判斷，認成誰。 */
  readonly address: ReturnType<typeof toolCallSessionAddress>;
}

function observe(
  where: Observation['where'],
  toolName: string | undefined,
  configurable: unknown,
): Observation {
  const bag = (configurable ?? {}) as Record<string, unknown>;
  return {
    where,
    ...(toolName === undefined ? {} : { tool: toolName }),
    threadId: bag['thread_id'],
    checkpointNs: bag['checkpoint_ns'],
    background: bag['nexus_background_session'],
    address: toolCallSessionAddress({ configurable }),
  };
}

const call = (name: string, args: Record<string, unknown>): ScriptedTurn => ({
  content: '',
  toolCalls: [{ name, args }],
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-thread-id-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * 真組裝＋假模型。root 有 `probe_root`（工具 handler 量測）與 `spawn_bg`（呼叫 host 拉背景子代理）；
 * `worker` 子代理有 `probe_worker`。一顆 `registry.middleware.use()` 的 middleware 掛在 root 與每個子代理上，
 * 兩個 wrap 都記下 `request.runtime.configurable`。
 */
async function assemble(turns: readonly ScriptedTurn[]) {
  const seen: Observation[] = [];
  const holder: { host?: BackgroundSubagentHost; outcome?: Promise<unknown> } = {};
  const plugin: PluginEntry = {
    plugin: {
      name: 'thread-id-probe',
      apply(registry) {
        const probe = (name: string) =>
          tool(
            (_input: Record<string, never>, config?: { configurable?: unknown }) => {
              seen.push(observe('tool', name, config?.configurable));
              return '看過了';
            },
            { name, description: '記下呼叫設定。', schema: z.object({}) },
          );
        registry.tools.register(probe('probe_root'));
        registry.tools.register(
          tool(
            async ({ text }: { text: string }) => {
              holder.outcome = holder.host!.submit({ runId: 'bg-1', subagent: 'worker', text });
              await holder.outcome;
              return '已派出 bg-1';
            },
            {
              name: 'spawn_bg',
              description: '派一輪背景的活。',
              schema: z.object({ text: z.string() }),
            },
          ),
        );
        registry.subagents.register({
          name: 'worker',
          description: '幹活的。',
          systemPrompt: '幹活。',
          tools: [probe('probe_worker')],
        });
        registry.middleware.use({
          name: 'thread-id-probe-middleware',
          wrapToolCall: (request: unknown, handler: (request: unknown) => unknown) => {
            const runtime = (request as { runtime?: { configurable?: unknown } }).runtime;
            const name = (request as { toolCall?: { name?: string } }).toolCall?.name;
            seen.push(observe('wrapToolCall', name, runtime?.configurable));
            return handler(request);
          },
          wrapModelCall: (request: unknown, handler: (request: unknown) => unknown) => {
            const runtime = (request as { runtime?: { configurable?: unknown } }).runtime;
            seen.push(observe('wrapModelCall', undefined, runtime?.configurable));
            return handler(request);
          },
        } as never);
      },
    },
  };
  const built = await createNexusAgent({
    model: new ScriptedChatModel({ turns }),
    checkpointer: new PrunedMemorySaver(),
    plugins: [plugin],
    backend: new ContainedFilesystemBackend({ rootDir: dir, mode: 'workspace-write' }),
  });
  const pump = new ThreadPump(built.agent as unknown as PumpAgent, ROOT_THREAD);
  const detach = built.attachSession(pump.sessions);
  const host = new BackgroundSubagentHost({
    sessions: pump.sessions,
    compile: (name) =>
      built.compileSubagent(name, new PrunedMemorySaver()) as unknown as BackgroundAgent,
  });
  holder.host = host;
  return {
    seen,
    pump,
    host,
    close: async () => {
      await host.close();
      detach();
      await built.dispose();
    },
  };
}

describe('thread_id 到得了工具 handler 與 middleware（#1418 Q3 的前提）', () => {
  it('根 agent：工具 handler 與兩個 wrap 都拿到 root 的 thread_id', async () => {
    const run = await assemble([call('probe_root', {}), { content: '根收尾' }]);
    try {
      await run.pump.submit({ kind: 'message', text: '跑' });
      await run.pump.whenIdle();
    } finally {
      await run.close();
    }
    const tool = run.seen.find((entry) => entry.where === 'tool' && entry.tool === 'probe_root');
    expect(tool?.threadId).toBe(ROOT_THREAD);
    expect(tool?.address).toEqual({ kind: 'root' });
    const wrapTool = run.seen.find(
      (entry) => entry.where === 'wrapToolCall' && entry.tool === 'probe_root',
    );
    expect(wrapTool?.threadId).toBe(ROOT_THREAD);
    const wrapModel = run.seen.filter((entry) => entry.where === 'wrapModelCall');
    expect(wrapModel.length).toBeGreaterThan(0);
    expect(wrapModel.map((entry) => entry.threadId)).toEqual(wrapModel.map(() => ROOT_THREAD));
  });

  it('同步子代理（task）：子代理的工具 handler 與 middleware 看到的 thread_id 就是 root 的，子代理身分靠 checkpoint_ns', async () => {
    const run = await assemble([
      call('task', { description: '幹活', subagent_type: 'worker' }),
      call('probe_worker', {}),
      { content: '子代理收工' },
      { content: '根收尾' },
    ]);
    try {
      await run.pump.submit({ kind: 'message', text: '跑' });
      await run.pump.whenIdle();
    } finally {
      await run.close();
    }
    const tool = run.seen.find((entry) => entry.where === 'tool' && entry.tool === 'probe_worker');
    expect(tool).toBeDefined();
    expect(tool?.threadId).toBe(ROOT_THREAD);
    expect(tool?.address?.kind).toBe('subagent');
    const wrapTool = run.seen.find(
      (entry) => entry.where === 'wrapToolCall' && entry.tool === 'probe_worker',
    );
    expect(wrapTool?.threadId).toBe(ROOT_THREAD);
    expect(wrapTool?.address?.kind).toBe('subagent');
    // 子代理那一輪的模型呼叫（位址是子代理的那幾次）：thread_id 同樣是 root 的。
    const subagentModelCalls = run.seen.filter(
      (entry) => entry.where === 'wrapModelCall' && entry.address?.kind === 'subagent',
    );
    expect(subagentModelCalls.length).toBeGreaterThan(0);
    for (const entry of subagentModelCalls) expect(entry.threadId).toBe(ROOT_THREAD);
  });

  it('背景子代理：thread_id 是它自己的日誌 id（`<root>/<runId>`），並帶背景身分鍵；root thread 可以從前綴還原', async () => {
    const run = await assemble([
      call('spawn_bg', { text: '背景的活' }),
      call('probe_worker', {}),
      { content: '背景收工' },
      { content: '根收尾' },
    ]);
    try {
      await run.pump.submit({ kind: 'message', text: '派' });
      await run.pump.whenIdle();
      await run.host.idle();
    } finally {
      await run.close();
    }
    const tool = run.seen.find((entry) => entry.where === 'tool' && entry.tool === 'probe_worker');
    expect(tool).toBeDefined();
    expect(tool?.threadId).toBe(`${ROOT_THREAD}/bg-1`);
    expect(tool?.background).toBe('bg-1');
    expect(tool?.address).toEqual({ kind: 'subagent', runId: 'bg-1' });
    const wrapTool = run.seen.find(
      (entry) => entry.where === 'wrapToolCall' && entry.tool === 'probe_worker',
    );
    expect(wrapTool?.threadId).toBe(`${ROOT_THREAD}/bg-1`);
    expect(wrapTool?.background).toBe('bg-1');
    const backgroundModelCalls = run.seen.filter(
      (entry) => entry.where === 'wrapModelCall' && entry.background === 'bg-1',
    );
    expect(backgroundModelCalls.length).toBeGreaterThan(0);
    for (const entry of backgroundModelCalls) expect(entry.threadId).toBe(`${ROOT_THREAD}/bg-1`);
  });
});
