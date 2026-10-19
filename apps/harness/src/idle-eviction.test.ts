/**
 * serve 逐出閒置 thread（[#1484](https://github.com/DemianLi/nexus-agent/issues/1484)，保險絲第 1 級）。
 *
 * **真的 wire handler＋真的最小 agent**（`createNexusAgent`＋腳本模型＋可以卡住的工具），時鐘是假的（`now` 選項）、
 * 掃描用 `handler.sweepIdle()` 決定性地驅動（計時器的輪詢間隔設成一小時，另有一條測試用假計時器驗它真的會叫掃描）。
 * 問的是：
 *
 * - **A 閒置條件逐條成立才逐出**：每一條不成立的條件各一條測試（不成立就不逐出、而且重新計時）。
 * - **C 撤的當中來了同一個 thread 的請求**：等撤完、拿到重建後的那一份，不准拿到正在關的舊 thread；收尾拋錯時等待者照樣得到重建。
 * - **D 撤中的也佔名額**，收完才還。
 * - **E 撤完之後上傳收據、快照通知不再掛著這條 thread**；通知拋錯不擋逐出。
 * - **G 請求計數**：`run.start` 卡在附件的 `await` 裡時，閒置逐出不能落下去、讓那句話不見。
 * - **H MCP 收尾有期限**（[#1543](https://github.com/DemianLi/nexus-agent/issues/1543)）：MCP 重連卡在握手時，逐出不被它拖住。
 *
 * 從 serve 組裝起的接線、以及「撤掉之後重開等價於重啟」的對照（驗收 B），在 `serve-idle-eviction.test.ts`。
 *
 * 偏離登記：dsh 頂層沒有閒置逐出，見 `wire-handler.ts` 的 `WireHandlerOptions.idleEvictMs`。
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tool } from '@langchain/core/tools';
import { createWireClient, THREAD_AT_CAPACITY, historyPath } from '@nexus/wire';
import type { Event, PromptAttachment } from '@nexus/wire';
import type { PluginEntry } from '@nexus/core';
import { createMcpPlugin } from '@nexus/plugin-mcp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { AttachmentStore, attachmentsRootOf } from './attachment-store.js';
import { foldTurn, loopbackRequest, TEST_BROWSER_AUTH } from './fixtures.js';
import { PNG_7X5 } from './image-fixtures.js';
import { PrunedMemorySaver } from './pruned-memory-saver.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { composeAttachSessions } from './session-attach.js';
import type { SessionTitleDetach } from './session-title-llm.js';
import type { PumpAgent } from './thread-pump.js';
import { signalPid } from './test-pids.fixture.js';
import { createWireHandler } from './wire-handler.js';
import type { ThreadAgent, WireHandlerOptions } from './wire-handler.js';
import type { BackgroundSubagentControl } from './background-subagents.js';
import type { GoalDriverPort } from './goal-driver.js';

const BASE = 'http://evict.test';
const JSON_HEADERS = { 'content-type': 'application/json' };
/** 閒置多久逐出；假時鐘的單位。 */
const T = 10_000;

interface Gate {
  readonly promise: Promise<void>;
  open(): void;
}

function gate(): Gate {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

async function until(predicate: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** 兩種會讓一輪停住的工具：`hold` 卡在一道閘上，`danger` 要核准。 */
interface Probe {
  started: number;
  settled: number;
  readonly hold: Gate;
  /** 斜線命令 `/slow` 進來幾次、卡在哪道閘上。 */
  slashEntered: number;
  readonly slash: Gate;
}

function toolsPlugin(probe: Probe): PluginEntry {
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

const HOLD_SCRIPT: readonly ScriptedTurn[] = [
  { content: '動手', toolCalls: [{ name: 'hold', args: {} }] },
  { content: '好' },
];
const DANGER_SCRIPT: readonly ScriptedTurn[] = [
  { content: '要核准', toolCalls: [{ name: 'danger', args: {} }] },
  { content: '好' },
];
const PLAIN_SCRIPT: readonly ScriptedTurn[] = [{ content: '好' }, { content: '好' }];

/** 每條 thread 的組裝可以多掛的東西（替身）。 */
interface AgentExtras {
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

interface Rig {
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

function rig(options: Partial<WireHandlerOptions> = {}): Rig {
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

interface Outcome {
  readonly type: string;
  readonly error?: string;
  readonly message?: string;
}

/** 讀一條 thread 的歷史：經 `threadFor`，不用跑模型就把一條 thread 組起來的最短路。 */
async function touch(r: Rig, thread: string): Promise<Outcome> {
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
async function openLine(r: Rig, thread: string) {
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

let handlers: Rig[] = [];
function track(r: Rig): Rig {
  handlers.push(r);
  return r;
}

afterEach(async () => {
  for (const r of handlers) {
    r.probe.hold.open();
    r.probe.slash.open();
    await r.handler.close();
  }
  handlers = [];
  vi.useRealTimers();
});

/**
 * 條件成立的那一刻 T 早就過了：掃描**不逐出、而且重新計時**——條件放掉之後立刻掃還是不逐出，再過 T 才逐出。
 *
 * @param release - 放掉那個條件（讓這條 thread 回到閒置）。
 */
async function expectBlocksThenResets(
  r: Rig,
  thread: string,
  release: () => Promise<void> | void,
): Promise<void> {
  r.advance(T * 2);
  await r.handler.sweepIdle();
  expect(r.disposed).toEqual([]);
  await release();
  // 放掉條件之後，pump 的收尾（例如中止一輪、收回中斷）是非同步的；等它落定，最後活動時間才不會落在後面的時鐘跳躍之後。
  await new Promise((resolve) => setTimeout(resolve, 50));
  await r.handler.sweepIdle();
  expect(r.disposed).toEqual([]);
  r.advance(T - 1);
  await r.handler.sweepIdle();
  expect(r.disposed).toEqual([]);
  r.advance(1);
  await r.handler.sweepIdle();
  expect(r.disposed).toEqual([thread]);
}

/** 起一輪、卡在 `hold` 工具裡，然後放掉下行（只留「在跑」這一個原因）。 */
async function startHeldRun(r: Rig, thread: string): Promise<void> {
  const line = await openLine(r, thread);
  expect((await r.client.runStart(thread, '動手')).type).toBe('success');
  await until(() => r.probe.started === 1);
  await line.close();
}

/**
 * 跑一輪（工具卡住）、可選地插一句話、按停止，放行工具並等這一輪收完、放掉下行。
 * 回來時 `running` 是假的；有插話的話那一句留在 `next-step`。
 */
async function runThenStop(r: Rig, thread: string, withSteer: boolean): Promise<void> {
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
async function finishHeldRun(r: Rig, thread: string): Promise<void> {
  const line = await openLine(r, thread);
  r.probe.hold.open();
  await foldTurn(line.events);
  await line.close();
}

describe('A：閒置條件成立滿 T 才逐出（#1484）', () => {
  it('全部成立滿 T 才撤：agent 收掉、名額與通知都在，再開一次是重新組裝', async () => {
    const r = track(rig());
    expect((await touch(r, 't1')).type).toBe('success');
    r.advance(T - 1);
    await r.handler.sweepIdle();
    expect(r.disposed).toEqual([]);
    r.advance(1);
    await r.handler.sweepIdle();
    expect(r.disposed).toEqual(['t1']);
    expect(r.evicted).toEqual(['t1']);
    expect(r.warnings.filter((line) => line.startsWith('[閒置逐出]'))).toEqual([
      expect.stringContaining('thread "t1" 閒置 10 秒'),
    ]);
    expect((await touch(r, 't1')).type).toBe('success');
    expect(r.created).toEqual(['t1', 't1']);
  });

  it('沒設 idleEvictMs：不管閒多久都不撤（出廠行為不變）', async () => {
    const r = track(rig({ idleEvictMs: undefined }));
    await touch(r, 't1');
    r.advance(T * 1000);
    await r.handler.sweepIdle();
    expect(r.disposed).toEqual([]);
    expect(r.created).toEqual(['t1']);
  });

  it('計時器真的會叫掃描（輪詢間隔到了就撤）', async () => {
    vi.useFakeTimers();
    const r = track(rig({ idleEvictPollMs: 1000 }));
    await touch(r, 't1');
    r.advance(T);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(r.disposed).toEqual(['t1']));
  });

  it('有一輪在跑：不撤、重新計時；跑完之後再滿 T 才撤', async () => {
    const r = track(rig());
    await startHeldRun(r, 't1');
    await expectBlocksThenResets(r, 't1', () => finishHeldRun(r, 't1'));
  });

  it('停在核准點（掛著的中斷）：不撤、重新計時；收回之後再滿 T 才撤', async () => {
    const r = track(rig());
    r.extras.set('t1', { script: DANGER_SCRIPT });
    const line = await openLine(r, 't1');
    await r.client.runStart('t1', '要核准的事');
    await foldTurn(line.events);
    await line.close();
    await expectBlocksThenResets(r, 't1', async () => {
      // 按停止：收回掛著的中斷。
      await r.client.runCancel('t1');
    });
  });

  it('送出佇列裡還有東西（停住的佇列也算）：不撤', async () => {
    const r = track(rig());
    r.extras.set('t1', { script: DANGER_SCRIPT });
    const line = await openLine(r, 't1');
    await r.client.runStart('t1', '要核准的事');
    await foldTurn(line.events);
    // 停在核准點時再送一句：排進送出佇列。接著按停止：中斷收回、佇列停住——只剩「佇列不空」這一個原因。
    await r.client.runStart('t1', '排著的一句');
    await r.client.runCancel('t1');
    await line.close();
    r.advance(T * 2);
    await r.handler.sweepIdle();
    expect(r.disposed).toEqual([]);
  });

  it('按停止之後留在 next-step 的插話（沒有輪在跑、佇列空）：只有它擋逐出，不撤；沒有插話的對照照撤', async () => {
    // 對照：同樣跑一輪、按停止，但沒有插話——所有條件都成立，滿 T 就撤（確認下面那條擋住的真的是插話）。
    const control = track(rig());
    await runThenStop(control, 'ctl', false);
    control.advance(T * 2);
    await control.handler.sweepIdle();
    expect(control.disposed).toEqual(['ctl']);

    // 插話：人在這一輪跑著時插的，按停止之後不領、留在 next-step，等下一輪開頭才領走。
    // 這時 running 是假的、inbox（next-turn）是空的、沒有下行、沒有請求——只剩 nextStep 在擋。撤掉它那句話就沒了。
    const r = track(rig());
    await runThenStop(r, 't1', true);
    r.advance(T * 2);
    await r.handler.sweepIdle();
    expect(r.disposed).toEqual([]);
  });

  it('有下行掛著：不撤；頁籤關了（下行放掉）才開始計時', async () => {
    const r = track(rig());
    const line = await openLine(r, 't1');
    await expectBlocksThenResets(r, 't1', async () => {
      await line.close();
    });
  });

  it('背景子代理還有在途的工作：不撤、重新計時', async () => {
    const r = track(rig());
    let quiescent = false;
    r.extras.set('t1', {
      background: {
        sendFromUser: () => Promise.resolve(),
        interrupt: () => false,
        hasRunning: () => false,
        interruptAll: () => 0,
        quiescent: () => quiescent,
      },
    });
    await touch(r, 't1');
    await expectBlocksThenResets(r, 't1', () => {
      quiescent = true;
    });
  });

  it('目標 active 且 armed（續行授權只在記憶體）：不撤、重新計時', async () => {
    const r = track(rig());
    let activation: 'armed' | 'disarmed' = 'armed';
    const port = {
      goal: () => ({ phase: 'active', activation }),
      block: () => undefined,
      pause: () => undefined,
      disarm: () => undefined,
      flush: () => Promise.resolve(),
      warn: () => undefined,
    } as unknown as GoalDriverPort;
    r.extras.set('t1', { goalDriver: port });
    await touch(r, 't1');
    await expectBlocksThenResets(r, 't1', () => {
      activation = 'disarmed';
    });
  });

  it('LLM 標題有一次在飛：不撤、重新計時', async () => {
    const r = track(rig());
    let busy = true;
    r.extras.set('t1', {
      attachTitle: () => Object.assign(() => Promise.resolve(), { busy: () => busy }),
    });
    await touch(r, 't1');
    await expectBlocksThenResets(r, 't1', () => {
      busy = false;
    });
  });

  it('斜線命令在跑：不撤、重新計時（`slashInFlight` 與請求計數兩層各自擋得住）', async () => {
    const r = track(rig());
    await touch(r, 't1');
    const running = r.client.slashRun('t1', '/slow');
    await until(() => r.probe.slashEntered === 1);
    await expectBlocksThenResets(r, 't1', async () => {
      r.probe.slash.open();
      expect(await running).toMatchObject({ kind: 'success' });
    });
  });

  it('有請求握著這條 thread（還在讀本文、等 threadFor 的也算）：不撤', async () => {
    const r = track(rig());
    await touch(r, 't1');
    // 一個 POST，本文永遠不到：`handle()` 卡在 `await request.json()`，此時 thread 還在記憶體裡、什麼都沒在做。
    let push: (chunk: Uint8Array) => void = () => undefined;
    let finish: () => void = () => undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (chunk) => controller.enqueue(chunk);
        finish = () => controller.close();
      },
    });
    const pending = r.handler.handle(
      loopbackRequest(`${BASE}/threads/t1/commands/subagent.list`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body,
        // Node 的 fetch 要這一格才收串流本文。
        duplex: 'half',
      }),
    );
    r.advance(T * 2);
    await r.handler.sweepIdle();
    expect(r.disposed).toEqual([]);
    push(new TextEncoder().encode(JSON.stringify({ id: 1, method: 'subagent.list' })));
    finish();
    await pending;
    // 請求結束也算活動：重新計時。
    await r.handler.sweepIdle();
    expect(r.disposed).toEqual([]);
    r.advance(T);
    await r.handler.sweepIdle();
    expect(r.disposed).toEqual(['t1']);
  });
});

describe('C：撤的當中來了同一個 thread 的請求（#1484）', () => {
  it('等撤完再重建；拿到的是重建後的那一份，不是正在關的；多個等待者共用同一次重建', async () => {
    const r = track(rig());
    const closing = gate();
    r.extras.set('t1', { disposeGate: closing });
    await touch(r, 't1');
    r.advance(T);
    const sweeping = r.handler.sweepIdle();
    await until(() => r.warnings.some((line) => line.startsWith('[閒置逐出]')));
    // 舊的 agent 還沒收完。這時進來三個請求：都要等。
    r.extras.set('t1', {});
    const waiters = [touch(r, 't1'), touch(r, 't1'), touch(r, 't1')];
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(r.created).toEqual(['t1']);
    expect(r.disposed).toEqual([]);

    closing.open();
    await sweeping;
    const results = await Promise.all(waiters);
    expect(results.map((result) => result.type)).toEqual(['success', 'success', 'success']);
    // 舊的先收完，才組新的；三個等待者只重建一次。
    expect(r.disposed).toEqual(['t1']);
    expect(r.created).toEqual(['t1', 't1']);
  });

  it('收尾拋錯：記一行、占位照放；等待者照樣拿到重建後的 thread', async () => {
    const r = track(rig());
    const closing = gate();
    r.extras.set('t1', { disposeGate: closing, disposeError: new Error('寫租約放不掉') });
    await touch(r, 't1');
    r.advance(T);
    const sweeping = r.handler.sweepIdle();
    await until(() => r.warnings.some((line) => line.startsWith('[閒置逐出]')));
    r.extras.set('t1', {});
    const waiter = touch(r, 't1');
    closing.open();
    await sweeping;
    expect((await waiter).type).toBe('success');
    expect(r.created).toEqual(['t1', 't1']);
    expect(
      r.warnings.some((line) => line.includes('收尾出錯') && line.includes('寫租約放不掉')),
    ).toBe(true);
    // 占位放了：這條 thread 之後就是一條普通的 thread，可以再被撤。
    r.advance(T * 2);
    await r.handler.sweepIdle();
    await r.handler.sweepIdle();
    expect(r.evicted).toEqual(['t1', 't1']);
  });

  it('close() 等撤到一半的收完', async () => {
    const r = track(rig());
    const closing = gate();
    r.extras.set('t1', { disposeGate: closing });
    await touch(r, 't1');
    r.advance(T);
    void r.handler.sweepIdle();
    await until(() => r.warnings.some((line) => line.startsWith('[閒置逐出]')));
    let closed = false;
    const closing$ = r.handler.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(closed).toBe(false);
    closing.open();
    await closing$;
    expect(r.disposed).toEqual(['t1']);
  });
});

describe('D：撤中的也佔名額（#1484）', () => {
  it('收完才還：撤的當中新 thread 被拒，收完就進得來；拒收訊息講閒置多久自動釋放', async () => {
    const r = track(rig({ maxThreads: 1 }));
    const closing = gate();
    r.extras.set('t1', { disposeGate: closing });
    await touch(r, 't1');
    r.advance(T);
    const sweeping = r.handler.sweepIdle();
    await until(() => r.warnings.some((line) => line.startsWith('[閒置逐出]')));
    const refused = await touch(r, 't2');
    expect(refused).toMatchObject({ type: 'error', error: THREAD_AT_CAPACITY });
    expect(refused.message).toContain('1／1');
    expect(refused.message).toContain('閒置超過 10 秒');
    expect(r.created).toEqual(['t1']);
    // 記憶體警告寫的「現在幾條」（#1493）與這道上限檢查數的是同一個：撤到一半的那條還算。
    expect(r.handler.threadCount()).toBe(1);

    closing.open();
    await sweeping;
    expect(r.handler.threadCount()).toBe(0);
    expect((await touch(r, 't2')).type).toBe('success');
    expect(r.created).toEqual(['t1', 't2']);
  });
});

describe('E：撤完之後不再掛著這條 thread（#1484）', () => {
  it('撤完通知（重寫快照）拋錯：不擋逐出、記一行', async () => {
    const r = track(
      rig({
        onThreadEvicted: () => {
          throw new Error('快照寫不進去');
        },
      }),
    );
    await touch(r, 't1');
    r.advance(T);
    await r.handler.sweepIdle();
    expect(r.disposed).toEqual(['t1']);
    expect(
      r.warnings.some((line) => line.includes('通知撤完') && line.includes('快照寫不進去')),
    ).toBe(true);
    expect((await touch(r, 't1')).type).toBe('success');
  });

  it('上傳收據隨 thread 撤掉而失效（等價於重啟）', async () => {
    const home = await mkdtemp(join('/var/tmp', 'nexus-evict-'));
    try {
      const store = new AttachmentStore(attachmentsRootOf(home));
      const r = track(rig({ attachments: store }));
      r.extras.set('t1', { script: PLAIN_SCRIPT });
      const receipt = await r.client.uploadFile('t1', new TextEncoder().encode('內容'), 'a.txt');
      if (receipt.kind !== 'ok') throw new Error('上傳應該成功');
      const file: PromptAttachment = { type: 'file', receiptId: receipt.receipt.receiptId };
      r.advance(T);
      await r.handler.sweepIdle();
      expect(r.disposed).toEqual(['t1']);
      const refused = await r.client.runStart('t1', '帶著舊收據', { attachments: [file] });
      expect(refused).toMatchObject({ type: 'error', error: 'invalid_argument' });
      expect(JSON.stringify(refused)).toContain('不存在');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('G：請求計數擋住落在 admitAttachments 與 start() 之間的逐出（#1484）', () => {
  it('run.start 卡在存圖的 await 裡：逐出不能落下去，那句話不會不見', async () => {
    const home = await mkdtemp(join('/var/tmp', 'nexus-evict-'));
    try {
      const saving = gate();
      let entered = false;
      class SlowStore extends AttachmentStore {
        override async saveImage(
          input: Parameters<AttachmentStore['saveImage']>[0],
        ): ReturnType<AttachmentStore['saveImage']> {
          entered = true;
          await saving.promise;
          return super.saveImage(input);
        }
      }
      const r = track(rig({ attachments: new SlowStore(attachmentsRootOf(home)) }));
      r.extras.set('t1', { script: PLAIN_SCRIPT });
      await touch(r, 't1');
      const image: PromptAttachment = {
        type: 'image',
        mediaType: 'image/png',
        data: PNG_7X5,
        name: 's.png',
      };
      const started = r.client.runStart('t1', '這句話不能不見', { attachments: [image] });
      await until(() => entered);
      // 這一刻 thread 看起來什麼都沒在做：沒有下行、沒有 run、佇列是空的。T 早就過了。
      r.advance(T * 5);
      await r.handler.sweepIdle();
      expect(r.disposed).toEqual([]);

      saving.open();
      expect((await started).type).toBe('success');
      // 那句話真的進了這條 thread 的日誌（不是被收線的 pump 吞掉）。
      const found = async () => {
        const page = await r.client.threadHistory('t1');
        return page.kind === 'ok' && JSON.stringify(page).includes('這句話不能不見');
      };
      const deadline = Date.now() + 3000;
      let seen = await found();
      while (!seen && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        seen = await found();
      }
      expect(seen).toBe(true);
      expect(r.created).toEqual(['t1']);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

beforeEach(() => {
  handlers = [];
});

const MODERN_STDIO_SERVER = fileURLToPath(
  new URL('../../../packages/nexus-plugin-mcp/src/modern-stdio-server.ts', import.meta.url),
);

/** 命令列含記號的行程；不經 shell（同 `packages/nexus-plugin-mcp/src/reconnect.test.ts`）。 */
function pidsOf(marker: string): number[] {
  try {
    return execFileSync('pgrep', ['-f', '--', marker])
      .toString()
      .split('\n')
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

function killAll(pids: readonly number[]): void {
  for (const pid of pids) signalPid(pid, 'SIGKILL');
}

describe('H：MCP 收尾有期限（#1543）', () => {
  it('MCP 重連卡在握手：逐出 6 秒內放掉占位，同 id 的下一個請求組得回來', async () => {
    const dir = await mkdtemp(join('/var/tmp', 'nexus-evict-mcp-'));
    const flag = join(dir, 'hang');
    const marker = `--marker-${randomUUID()}`;
    try {
      const r = track(rig());
      r.extras.set('t1', {
        plugins: [
          createMcpPlugin({
            serverName: 'srv',
            connection: {
              transport: 'stdio',
              command: process.execPath,
              args: ['--import', 'tsx', MODERN_STDIO_SERVER, marker],
              env: { FIXTURE_HANG_IF_FILE: flag },
            },
            reconnect: { initialDelayMs: 40, maxDelayMs: 160, maxAttempts: 5 },
          }),
        ],
      });
      expect((await touch(r, 't1')).type).toBe('success');
      const first = pidsOf(marker);
      expect(first).toHaveLength(1);
      // 殺掉第 0 代，讓重連起的那一個卡在握手。重建的那一份不掛 MCP：卡住的 server 也會讓組裝等上兩分鐘，那不歸這張。
      await writeFile(flag, '');
      killAll(first);
      await until(() => pidsOf(marker).some((pid) => !first.includes(pid)), 10_000);
      r.extras.set('t1', {});

      r.advance(T);
      const started = Date.now();
      const sweeping = r.handler.sweepIdle();
      await until(() => r.warnings.some((line) => line.startsWith('[閒置逐出]')));
      const back = touch(r, 't1');
      await sweeping;
      const elapsed = Date.now() - started;
      // 下限證明真的卡住了、等滿 MCP 的收尾期限（5 秒）；沒卡住的話這條什麼都沒量到。上限是期限加一點餘裕。
      expect(elapsed).toBeGreaterThanOrEqual(5000);
      expect(elapsed).toBeLessThan(6000);
      expect(r.disposed).toEqual(['t1']);
      expect((await back).type).toBe('success');
      expect(r.created).toEqual(['t1', 't1']);
    } finally {
      killAll(pidsOf(marker));
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
