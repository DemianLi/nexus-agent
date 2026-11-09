/**
 * `idle-eviction.test.ts`（[#1484](https://github.com/DemianLi/nexus-agent/issues/1484)）與 `conversation-idle.test.ts`（[#2338](https://github.com/DemianLi/nexus-agent/issues/2338)）共用的
 * 測試台：真的 wire handler＋真的最小 agent、假時鐘、會卡住的工具與讓一條 thread 不閒的幾種做法。
 */

import { tool } from '@langchain/core/tools';
import { createWireClient, historyPath } from '@nexus/wire';
import type { Event } from '@nexus/wire';
import type { PluginEntry } from '@nexus/core';
import { expect } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import type { BackgroundSubagentControl } from './background-subagents.js';
import { foldTurn, loopbackRequest, TEST_BROWSER_AUTH } from './fixtures.js';
import type { GoalDriverPort } from './goal-driver.js';
import { PrunedMemorySaver } from './pruned-memory-saver.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { composeAttachSessions } from './session-attach.js';
import type { SessionTitleDetach } from './session-title-llm.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';
import type { ThreadAgent, WireHandlerOptions } from './wire-handler.js';

export const BASE = 'http://evict.test';
export const JSON_HEADERS = { 'content-type': 'application/json' };
/** 閒置多久逐出；假時鐘的單位。 */
export const T = 10_000;

export interface Gate {
  readonly promise: Promise<void>;
  open(): void;
}

export function gate(): Gate {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

export async function until(predicate: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** 兩種會讓一輪停住的工具：`hold` 卡在一道閘上，`danger` 要核准。 */
export interface Probe {
  started: number;
  settled: number;
  readonly hold: Gate;
  /** 斜線命令 `/slow` 進來幾次、卡在哪道閘上。 */
  slashEntered: number;
  readonly slash: Gate;
}

export function toolsPlugin(probe: Probe): PluginEntry {
  return {
    plugin: {
      name: 'evict-tools',
      apply(registry) {
        registry.tools.register(
          tool(
            async () => {
              probe.started += 1;
              await probe.hold.promise;
              probe.settled += 1;
              return '放行了';
            },
            { name: 'hold', description: '卡住直到被放行。', schema: z.object({}) },
          ),
        );
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
        void registry.commands.register({
          name: 'slow',
          description: '等人放行才回來。',
          handler: async () => {
            probe.slashEntered += 1;
            await probe.slash.promise;
            return { kind: 'success', text: '放行了。' };
          },
        });
      },
    },
  };
}

export const HOLD_SCRIPT: readonly ScriptedTurn[] = [
  { content: '動手', toolCalls: [{ name: 'hold', args: {} }] },
  { content: '好' },
];
export const DANGER_SCRIPT: readonly ScriptedTurn[] = [
  { content: '要核准', toolCalls: [{ name: 'danger', args: {} }] },
  { content: '好' },
];
export const PLAIN_SCRIPT: readonly ScriptedTurn[] = [{ content: '好' }, { content: '好' }];

/** 每條 thread 的組裝可以多掛的東西（替身）。 */
export interface AgentExtras {
  readonly script?: readonly ScriptedTurn[];
  readonly background?: BackgroundSubagentControl;
  readonly goalDriver?: GoalDriverPort;
  readonly attachTitle?: () => SessionTitleDetach;
  /** `dispose` 要等這道閘才完成（撤中的狀態可以停在這裡）。 */
  readonly disposeGate?: Gate;
  /** `dispose` 拋這個錯。 */
  readonly disposeError?: Error;
  /** 多掛的插件（例如真的 MCP）。 */
  readonly plugins?: readonly PluginEntry[];
}

export interface Rig {
  readonly handler: ReturnType<typeof createWireHandler>;
  readonly client: ReturnType<typeof createWireClient>;
  /** `createAgent` 被叫過的 thread id，照順序。 */
  readonly created: string[];
  /** `dispose` 完成的 thread id，照順序。 */
  readonly disposed: string[];
  /** `onThreadEvicted` 被叫的 thread id。 */
  readonly evicted: string[];
  readonly warnings: string[];
  readonly probe: Probe;
  /** 假時鐘。 */
  clock: number;
  advance(ms: number): void;
  /** 某條 thread 之後建的組裝要多掛什麼（只影響之後才建的）。 */
  extras: Map<string, AgentExtras>;
}

export function rig(options: Partial<WireHandlerOptions> = {}): Rig {
  const created: string[] = [];
  const disposed: string[] = [];
  const evicted: string[] = [];
  const warnings: string[] = [];
  const extras = new Map<string, AgentExtras>();
  const probe: Probe = { started: 0, settled: 0, hold: gate(), slashEntered: 0, slash: gate() };
  const state: { clock: number } = { clock: 1_000_000 };
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    idleEvictMs: T,
    // 計時器不插手：掃描由測試驅動。
    idleEvictPollMs: 3_600_000,
    now: () => state.clock,
    warn: (message) => warnings.push(message),
    onThreadEvicted: (threadId) => {
      evicted.push(threadId);
    },
    createAgent: async (threadId): Promise<ThreadAgent> => {
      created.push(threadId);
      const extra = extras.get(threadId) ?? {};
      const built = await createNexusAgent({
        model: new ScriptedChatModel({ turns: [...(extra.script ?? HOLD_SCRIPT)] }),
        checkpointer: new PrunedMemorySaver(),
        plugins: [toolsPlugin(probe), ...(extra.plugins ?? [])],
        // 插話那一條（`next-step`）的載體：不掛的話插話退成排隊，測不到「只有 nextStep 在擋」。
        stepInbox: true,
      });
      const compose = composeAttachSessions(built);
      return {
        agent: built.agent as unknown as PumpAgent,
        stepInbox: true,
        commands: built.commands,
        attachSessions: (sessions, sessionOptions) => {
          const detach = compose(sessions, sessionOptions);
          return extra.background === undefined
            ? detach
            : Object.assign(detach, { background: extra.background });
        },
        ...(extra.goalDriver !== undefined && { goalDriver: () => extra.goalDriver! }),
        ...(extra.attachTitle !== undefined && { attachTitle: () => extra.attachTitle!() }),
        dispose: async () => {
          if (extra.disposeGate !== undefined) await extra.disposeGate.promise;
          disposed.push(threadId);
          await built.dispose();
          if (extra.disposeError !== undefined) throw extra.disposeError;
        },
      };
    },
    ...options,
  });
  const client = createWireClient({
    baseUrl: BASE,
    fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
  });
  return {
    handler,
    client,
    created,
    disposed,
    evicted,
    warnings,
    probe,
    get clock() {
      return state.clock;
    },
    set clock(value: number) {
      state.clock = value;
    },
    advance(ms: number) {
      state.clock += ms;
    },
    extras,
  };
}

export interface Outcome {
  readonly type: string;
  readonly error?: string;
  readonly message?: string;
}

/** 讀一條 thread 的歷史：經 `threadFor`，不用跑模型就把一條 thread 組起來的最短路。 */
export async function touch(r: Rig, thread: string): Promise<Outcome> {
  const response = await r.handler.handle(
    loopbackRequest(`${BASE}${historyPath(thread)}`, { method: 'GET', headers: JSON_HEADERS }),
  );
  return (await response.json()) as Outcome;
}

/**
 * 開一條下行；`close()` 中止它（真的 server 在連線斷掉時也是中止請求的 signal），並等 server 端的訂閱放掉。
 *
 * **有一個背景讀者一直在抽**：真的 server 會把 body 一直往 socket 寫，所以 `pull` 一直在跑、中止的回呼才掛得上；
 * 測試裡沒人讀的話，訂閱者的產生器根本沒開始，中止也放不掉它。`events` 是從讀者的佇列抽的迭代器，`foldTurn` 照常吃。
 */
export async function openLine(r: Rig, thread: string) {
  const controller = new AbortController();
  const source = await r.client.openEvents(thread, { signal: controller.signal });
  const queue: Event[] = [];
  let ended = false;
  let wake: (() => void) | undefined;
  const reading = (async () => {
    try {
      for await (const frame of source) {
        queue.push(frame);
        wake?.();
      }
    } catch {
      // 中止就是這樣結束的。
    }
    ended = true;
    wake?.();
  })();
  const events: AsyncIterator<Event> = {
    async next() {
      for (;;) {
        const frame = queue.shift();
        if (frame !== undefined) return { done: false, value: frame };
        if (ended) return { done: true, value: undefined };
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
  return {
    events,
    async close(): Promise<void> {
      controller.abort();
      await reading;
    },
  };
}

export async function startHeldRun(r: Rig, thread: string): Promise<void> {
  const line = await openLine(r, thread);
  expect((await r.client.runStart(thread, '動手')).type).toBe('success');
  await until(() => r.probe.started === 1);
  await line.close();
}

/**
 * 跑一輪（工具卡住）、可選地插一句話、按停止，放行工具並等這一輪收完、放掉下行。
 * 回來時 `running` 是假的；有插話的話那一句留在 `next-step`。
 */
export async function runThenStop(r: Rig, thread: string, withSteer: boolean): Promise<void> {
  const line = await openLine(r, thread);
  expect((await r.client.runStart(thread, '動手')).type).toBe('success');
  await until(() => r.probe.started === 1);
  if (withSteer) {
    expect((await r.client.runStart(thread, '停之前插的', { mode: 'steer' })).type).toBe('success');
  }
  await r.client.runCancel(thread);
  r.probe.hold.open();
  await foldTurn(line.events);
  await line.close();
}

/** 放行卡住的工具並等這一輪收完（開一條下行折到收尾，再放掉）。 */
export async function finishHeldRun(r: Rig, thread: string): Promise<void> {
  const line = await openLine(r, thread);
  r.probe.hold.open();
  await foldTurn(line.events);
  await line.close();
}
