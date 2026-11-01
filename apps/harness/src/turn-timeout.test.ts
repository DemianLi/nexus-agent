/**
 * 一輪的時鐘（[#1624](https://github.com/DemianLi/nexus-agent/issues/1624)）的驗收，**走真的 pump**（搭法同 `turn-cancel.test.ts`）：到點照停止鍵的路
 * 中止，`turn/end` 帶 `{ kind: 'aborted', cause: { kind: 'hook', reason: 'turn-timeout' } }`，下行的收尾 frame 帶同一個原因。
 *
 * 計時器多半用可注入的手動版（{@link ManualTimers}）：測試決定哪一刻到點，不靠負載下的毫秒間距；「拿掉清計時器的那一行要紅」靠
 * 數還掛著幾顆（到點時 pump 會先比對這一輪還是不是當下那一輪，漏清的計時器在行為上碰不到下一輪）。驗收 1 與「停在核准點不算時間」
 * 用真的時間，serve 那兩條用出廠的真計時器。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`；退避那一條的對手方是本機的假 SSE 端點，金鑰是假的。
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HumanMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { SessionRegistry, TOOL_ABORTED, TURN_CANCEL_CONFIG_KEY } from '@nexus/core';
import type { PluginEntry, SessionEvent, SessionLog } from '@nexus/core';
import { GOALS_SERVICE } from '@nexus/goal';
import type { GoalServices } from '@nexus/goal';
import { createGoalInvariantPlugin } from '@nexus/plugin-goal/invariant';
import type { Event } from '@nexus/wire';
import { createWireClient } from '@nexus/wire';
import { createMiddleware } from 'langchain';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { historyFrames } from './conversation-history.js';
import { DEFAULT_TOOL_TEXT_MAX_BYTES } from './settings/tool-text.js';
import { BackgroundSubagentHost } from './background-subagents.js';
import type { BackgroundAgent, BackgroundSettlement } from './background-subagents.js';
import { emptyCommandPoint, loopbackRequest, serveClient, TEST_BROWSER_AUTH } from './fixtures.js';
import type { GoalDriverPort } from './goal-driver.js';
import { createGoalPlugin, goalCoreOf } from './goal.fixture.js';
import { createLiveModel, LIVE_API_KEY_ENV } from './live-model.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { startScriptedServe } from './scripted-serve.js';
import type { ScriptedServe } from './scripted-serve.js';
import { liveModelConfigSchema } from './settings/live-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';
import { REAL_TURN_TIMERS, startTurnClock, unsettledToolNames } from './turn-clock.js';
import type { TurnClock, TurnTimers } from './turn-clock.js';
import { createWireHandler } from './wire-handler.js';
import type { AttachSessions } from './session-attach.js';

/** 手動計時器：測試決定哪一顆什麼時候到點，也數得到還掛著幾顆。 */
class ManualTimers implements TurnTimers {
  readonly #pending = new Map<number, { readonly callback: () => void; readonly ms: number }>();
  #next = 0;
  readonly set = (callback: () => void, ms: number): unknown => {
    this.#next += 1;
    this.#pending.set(this.#next, { callback, ms });
    return this.#next;
  };
  readonly clear = (handle: unknown): void => {
    this.#pending.delete(handle as number);
  };
  /** 還掛著的計時器各排了幾毫秒。 */
  delays(): number[] {
    return [...this.#pending.values()].map((entry) => entry.ms);
  }
  /** 讓排了 `ms` 毫秒的那一顆到點。沒有就拋：表示根本沒起計時器。 */
  fire(ms: number): void {
    const found = [...this.#pending].find(([, entry]) => entry.ms === ms);
    if (found === undefined) {
      throw new Error(`沒有排 ${String(ms)} 毫秒的計時器（還掛著：${this.delays().join('、')}）`);
    }
    this.#pending.delete(found[0]);
    found[1].callback();
  }
}

/** 手動計時器的兩個數，刻意分開，`fire` 才認得出是哪一顆。 */
const TIMEOUT_MS = 1_000;
const GRACE_MS = 50;
const HOOK = { kind: 'hook', reason: 'turn-timeout' } as const;
const TIMED_OUT_END = { reason: { kind: 'aborted', cause: HOOK } };
const STOPPED_END = { reason: { kind: 'aborted', cause: { kind: 'user' } } };

interface Probe {
  started: number;
  settled: number;
  /** 給了就等它開才落定；沒給就睡 `sleepMs`。 */
  hold?: Promise<void>;
  sleepMs: number;
}

function toolsPlugin(probe: Probe): PluginEntry {
  return {
    plugin: {
      name: 'clock-tools',
      apply(registry) {
        registry.tools.register(
          tool(
            async () => {
              probe.started += 1;
              await (probe.hold ?? new Promise((resolve) => setTimeout(resolve, probe.sleepMs)));
              probe.settled += 1;
              return '查好了';
            },
            { name: 'slow_lookup', description: '慢慢查。', schema: z.object({}) },
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
      },
    },
  };
}

/** 真的組裝接上一個帶時鐘的 pump 與一條下行。 */
async function assemble(
  turns: readonly ScriptedTurn[],
  clock: TurnClock | undefined,
  plugins: readonly PluginEntry[] = [],
) {
  const model = new ScriptedChatModel({ turns });
  const built = await createNexusAgent({
    model,
    checkpointer: new MemorySaver(),
    plugins: [...plugins],
  });
  const warnings: string[] = [];
  const pump = new ThreadPump(
    built.agent as unknown as PumpAgent,
    'clock-root',
    undefined,
    undefined,
    undefined,
    undefined,
    (message) => warnings.push(message),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    clock,
  );
  const detach = built.attachSession(pump.sessions);
  const frames: Event[] = [];
  const line = new AbortController();
  const stream = pump.subscribe(['messages', 'tools', 'lifecycle', 'input'], line.signal);
  const draining = (async () => {
    for await (const frame of stream) frames.push(frame);
  })();
  return {
    model,
    pump,
    frames,
    warnings,
    root: (): readonly SessionEvent[] => pump.sessionLog.events,
    close: async () => {
      line.abort();
      await draining;
      detach();
      await built.dispose();
    },
  };
}

async function until(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const typesOf = (events: readonly SessionEvent[]) => events.map((event) => event.type);
const ends = (events: readonly SessionEvent[]) =>
  events.filter((event) => event.type === 'turn/end').map((event) => event.data);
const resultCodes = (events: readonly SessionEvent[]) =>
  events.flatMap((event) => (event.type === 'tool/result' ? [event.data.error?.code] : []));

/** root 那顆標了中止的收尾 `lifecycle` 帶的原因；沒有那顆就是 `undefined`。 */
const stoppedCause = (frames: readonly Event[]) =>
  frames
    .filter(
      (frame) =>
        frame.method === 'lifecycle' &&
        frame.params.namespace.length === 0 &&
        (frame.params.data as { aborted?: unknown }).aborted === true,
    )
    .map((frame) => (frame.params.data as { cause?: unknown }).cause)
    .at(-1);

/** 每輪都要一顆工具，備得比會跑的多。 */
const forever = (count: number): ScriptedTurn[] =>
  Array.from({ length: count }, () => ({
    content: '再查一次。',
    toolCalls: [{ name: 'slow_lookup', args: {} }],
  }));

describe('root 那一輪到點（真 pump）', () => {
  /** 驗收 1；接線紅燈（驗收 11）：拿掉 `#runOnce` 起計時器的那一行，這一條要紅（沒有到點，劇本跑到遞迴上限）。 */
  it('模型一直要工具：到點收成 aborted/hook，之後沒有新的模型請求，沒有 turn/failed；下行帶同一個原因', async () => {
    // 真的時間：300 毫秒到點。到點的那一刻記下模型被叫了幾次。
    let promptsAtExpiry: number | undefined;
    const holder: { model?: ScriptedChatModel } = {};
    const timers: TurnTimers = {
      set: (callback, ms) =>
        REAL_TURN_TIMERS.set(() => {
          if (ms === 300) promptsAtExpiry = holder.model?.prompts.length;
          callback();
        }, ms),
      clear: REAL_TURN_TIMERS.clear,
    };
    const probe: Probe = { started: 0, settled: 0, sleepMs: 100 };
    const run = await assemble(forever(60), { timeoutMs: 300, timers }, [toolsPlugin(probe)]);
    holder.model = run.model;
    try {
      const startedAt = Date.now();
      await run.pump.submit({ kind: 'message', text: '一直查' });
      // 下限：不是一開跑就停（時鐘是 300 毫秒，不是 0）。
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(300);
      expect(promptsAtExpiry).toBeGreaterThanOrEqual(1);
      expect(run.root().at(-1)).toMatchObject({ type: 'turn/end', data: TIMED_OUT_END });
      expect(typesOf(run.root())).not.toContain('turn/failed');
      expect(run.model.prompts).toHaveLength(promptsAtExpiry!);
      // 再等一下：真的沒有人接著叫模型。
      await sleep(300);
      expect(run.model.prompts).toHaveLength(promptsAtExpiry!);
      await until(() => stoppedCause(run.frames) !== undefined);
      expect(stoppedCause(run.frames)).toEqual(HOOK);
    } finally {
      await run.close();
    }
  });

  it('驗收 2 串流慢慢滴：到點當場切斷，被打斷的半段照停止鍵的規矩留下', async () => {
    const timers = new ManualTimers();
    const full = '這一句回覆故意吐得很慢，'.repeat(20);
    const run = await assemble([{ content: full, tokenDelayMs: 10 }], {
      timeoutMs: TIMEOUT_MS,
      graceMs: GRACE_MS,
      timers,
    });
    try {
      const turn = run.pump.submit({ kind: 'message', text: '講長一點' });
      await until(() =>
        run.frames.some(
          (frame) =>
            frame.method === 'messages' &&
            (frame.params.data as { event?: unknown }).event === 'content-block-delta',
        ),
      );
      timers.fire(TIMEOUT_MS);
      await turn;
      expect(run.root().at(-1)).toMatchObject({ type: 'turn/end', data: TIMED_OUT_END });
      const kept = run
        .root()
        .find((event) => event.type === 'assistant/message' && event.data.interrupted === true);
      const text = (kept?.data as { message: { data: { content: unknown } } } | undefined)?.message
        .data.content;
      expect(typeof text).toBe('string');
      expect((text as string).length).toBeGreaterThan(0);
      expect((text as string).length).toBeLessThan(full.length);
      expect(full.startsWith(text as string)).toBe(true);
      expect(typesOf(run.root())).not.toContain('turn/failed');
    } finally {
      await run.close();
    }
  });

  it('驗收 4 正在跑的工具：等它落定才收尾，結果換成 ABORTED，之後不再叫模型', async () => {
    const timers = new ManualTimers();
    const probe: Probe = { started: 0, settled: 0, sleepMs: 500 };
    const run = await assemble(forever(3), { timeoutMs: TIMEOUT_MS, graceMs: GRACE_MS, timers }, [
      toolsPlugin(probe),
    ]);
    try {
      const turn = run.pump.submit({ kind: 'message', text: '查' });
      await until(() => probe.started === 1);
      timers.fire(TIMEOUT_MS);
      await turn;
      // 沒有丟下它：本體跑完了。
      expect(probe.settled).toBe(1);
      expect(resultCodes(run.root())).toEqual([TOOL_ABORTED]);
      expect(run.model.prompts).toHaveLength(1);
      expect(run.root().at(-1)).toMatchObject({ type: 'turn/end', data: TIMED_OUT_END });
      // 收尾之後兩顆計時器都清掉了（寬限那一顆還沒到點，在 finally 清）。
      expect(timers.delays()).toEqual([]);
    } finally {
      await run.close();
    }
  });

  it('驗收 7（Q-B2 (a)）：到點之後過了寬限還沒收尾，記一行 warn，帶 thread id 與還沒落定的工具名；不丟下工具', async () => {
    const timers = new ManualTimers();
    let release!: () => void;
    const probe: Probe = {
      started: 0,
      settled: 0,
      sleepMs: 0,
      hold: new Promise<void>((resolve) => (release = resolve)),
    };
    const run = await assemble(forever(3), { timeoutMs: TIMEOUT_MS, graceMs: GRACE_MS, timers }, [
      toolsPlugin(probe),
    ]);
    try {
      const turn = run.pump.submit({ kind: 'message', text: '查' });
      await until(() => probe.started === 1);
      timers.fire(TIMEOUT_MS);
      // 到點之後排的是寬限那一顆。
      expect(timers.delays()).toEqual([GRACE_MS]);
      timers.fire(GRACE_MS);
      expect(run.warnings).toHaveLength(1);
      expect(run.warnings[0]).toContain('clock-root');
      expect(run.warnings[0]).toContain('slow_lookup');
      // 只記，不丟下：放行之後照常收尾。
      expect(probe.settled).toBe(0);
      release();
      await turn;
      expect(probe.settled).toBe(1);
      expect(run.root().at(-1)).toMatchObject({ type: 'turn/end', data: TIMED_OUT_END });
    } finally {
      release();
      await run.close();
    }
  });

  it('驗收 5 計時器有清掉：正常收尾之後一顆都不掛；接著的第二輪掛的是它自己的那一顆', async () => {
    const timers = new ManualTimers();
    const run = await assemble(
      [{ content: '第一輪。' }, { content: '第二輪。', tokenDelayMs: 5 }],
      { timeoutMs: TIMEOUT_MS, graceMs: GRACE_MS, timers },
    );
    try {
      await run.pump.submit({ kind: 'message', text: '一' });
      // 拿掉清計時器的那一行，這裡是 [1000]。
      expect(timers.delays()).toEqual([]);
      const second = run.pump.submit({ kind: 'message', text: '二' });
      await until(() => run.pump.running);
      expect(timers.delays()).toEqual([TIMEOUT_MS]);
      await second;
      expect(timers.delays()).toEqual([]);
      expect(ends(run.root())).toEqual([{}, {}]);
    } finally {
      await run.close();
    }
  });

  it('驗收 6 人先按停止：原因是 user；之後那顆時鐘才到點也不改寫（先到的原因算數）', async () => {
    const timers = new ManualTimers();
    const probe: Probe = { started: 0, settled: 0, sleepMs: 100 };
    const run = await assemble(forever(3), { timeoutMs: TIMEOUT_MS, graceMs: GRACE_MS, timers }, [
      toolsPlugin(probe),
    ]);
    try {
      const turn = run.pump.submit({ kind: 'message', text: '查' });
      await until(() => probe.started === 1);
      expect(run.pump.cancel()).toBe('run');
      timers.fire(TIMEOUT_MS);
      await turn;
      expect(run.root().at(-1)).toMatchObject({ type: 'turn/end', data: STOPPED_END });
      await until(() => stoppedCause(run.frames) !== undefined);
      expect(stoppedCause(run.frames)).toEqual({ kind: 'user' });
    } finally {
      await run.close();
    }
  });

  /**
   * 驗收 10（關掉這一列行為與今天相同）與 #637 的 Q2：停止、送出、再停止，排著的那一句停住。**沒給時鐘**——這是停止鍵自己的行為，
   * 不能因為停止改走 `#abortRun` 而變（#1831 審查 B1：第二次停止落在已經中止的那一輪上，`#abortRun` 直接回去，請求沒設回來）。
   */
  it('停止、送出、再停止（那一輪還在等工具落定）：排著的那一句停住；沒給時鐘也一樣', async () => {
    let release!: () => void;
    const probe: Probe = {
      started: 0,
      settled: 0,
      sleepMs: 0,
      hold: new Promise<void>((resolve) => (release = resolve)),
    };
    const run = await assemble(
      [...forever(1), { content: 'B 收到。' }, { content: '多的。' }],
      undefined,
      [toolsPlugin(probe)],
    );
    try {
      const first = run.pump.submit({ kind: 'message', text: 'A' });
      await until(() => probe.started === 1);
      expect(run.pump.cancel()).toBe('run');
      void run.pump.submit({ kind: 'message', text: 'B' });
      expect(run.pump.cancel()).toBe('run');
      release();
      await first;
      await run.pump.whenIdle();
      expect(ends(run.root())).toEqual([STOPPED_END]);
      expect(run.pump.inbox.map((item) => item.text)).toEqual(['B']);
    } finally {
      release();
      await run.close();
    }
  });

  /**
   * 對照：時鐘那條路「已經中止就不動」。人先按停止、接著送了 B，那一輪還在等工具落定時時鐘才到點——原因照舊是 user，B 照常跑。
   * 時鐘若走 `cancel()`（每次都把停住的請求設回來），B 會被一顆已經被人中止的輪的時鐘停住。
   */
  it('人停止、送出，那一輪的時鐘才到點：原因不改，排著的那一句照常跑', async () => {
    const timers = new ManualTimers();
    let release!: () => void;
    const probe: Probe = {
      started: 0,
      settled: 0,
      sleepMs: 0,
      hold: new Promise<void>((resolve) => (release = resolve)),
    };
    const run = await assemble(
      [...forever(1), { content: 'B 收到。' }, { content: '多的。' }],
      { timeoutMs: TIMEOUT_MS, graceMs: GRACE_MS, timers },
      [toolsPlugin(probe)],
    );
    try {
      const first = run.pump.submit({ kind: 'message', text: 'A' });
      await until(() => probe.started === 1);
      expect(run.pump.cancel()).toBe('run');
      void run.pump.submit({ kind: 'message', text: 'B' });
      timers.fire(TIMEOUT_MS);
      release();
      await first;
      await until(() => ends(run.root()).length === 2);
      await run.pump.whenIdle();
      expect(ends(run.root())).toEqual([STOPPED_END, {}]);
      expect(run.pump.inbox).toEqual([]);
    } finally {
      release();
      await run.close();
    }
  });

  /**
   * 最後一次模型呼叫剛回來、圖還沒收尾就到點：後面沒有下一次模型呼叫可以擋，串流照常抽完，收尾 frame 標了中止——走的是「正常抽完
   * 但標了中止」那一格，那一格的原因也要照時鐘記（#1831 審查 N1）。到點的那一下放在外掛的 `wrapModelCall` 裡、模型回來之後。
   */
  it('最後一次模型呼叫剛回來就到點：照常抽完的那一格也收成 aborted/hook', async () => {
    const timers = new ManualTimers();
    const fireAfterModel: PluginEntry = {
      plugin: {
        name: 'fire-after-model',
        apply(registry) {
          registry.middleware.use(
            createMiddleware({
              name: 'fire-after-model',
              wrapModelCall: async (request, handler) => {
                const response = await handler(request);
                timers.fire(TIMEOUT_MS);
                return response;
              },
            }),
          );
        },
      },
    };
    const run = await assemble(
      [{ content: '答完了。' }],
      { timeoutMs: TIMEOUT_MS, graceMs: GRACE_MS, timers },
      [fireAfterModel],
    );
    try {
      await run.pump.submit({ kind: 'message', text: '問' });
      expect(typesOf(run.root())).not.toContain('turn/failed');
      expect(ends(run.root())).toEqual([TIMED_OUT_END]);
      await until(() => stoppedCause(run.frames) !== undefined);
      expect(stoppedCause(run.frames)).toEqual(HOOK);
    } finally {
      await run.close();
    }
  });

  it('驗收 9（Q-B3 (a)）：到點之後排著的那一句停住，下一次送出才照 FIFO 跑', async () => {
    const timers = new ManualTimers();
    const probe: Probe = { started: 0, settled: 0, sleepMs: 100 };
    const run = await assemble(
      [...forever(1), { content: '第二句收到。' }, { content: '第三句收到。' }],
      { timeoutMs: TIMEOUT_MS, graceMs: GRACE_MS, timers },
      [toolsPlugin(probe)],
    );
    try {
      const first = run.pump.submit({ kind: 'message', text: '查' });
      void run.pump.submit({ kind: 'message', text: '第二句' });
      await until(() => probe.started === 1);
      timers.fire(TIMEOUT_MS);
      await first;
      await run.pump.whenIdle();
      expect(ends(run.root())).toEqual([TIMED_OUT_END]);
      expect(run.pump.running).toBe(false);
      expect(run.pump.inbox.map((item) => item.text)).toEqual(['第二句']);

      await run.pump.submit({ kind: 'message', text: '第三句' });
      await run.pump.whenIdle();
      expect(ends(run.root())).toEqual([TIMED_OUT_END, {}, {}]);
    } finally {
      await run.close();
    }
  });

  it('停在核准點不算時間（真的時間）：停 500 毫秒（大於 300 毫秒的時鐘）再批准，resume 那一輪正常跑完', async () => {
    const run = await assemble(
      [{ content: '動手。', toolCalls: [{ name: 'danger', args: {} }] }, { content: '做完了。' }],
      { timeoutMs: 300 },
      [toolsPlugin({ started: 0, settled: 0, sleepMs: 0 })],
    );
    try {
      await run.pump.submit({ kind: 'message', text: '做危險的事' });
      expect(run.pump.awaitingInput).toBe(true);
      await sleep(500);
      expect(run.pump.awaitingInput).toBe(true);
      const interruptId = run.pump.pendings[0]!.interruptId;
      await run.pump.submit({
        kind: 'resume',
        interruptId,
        response: { decisions: [{ type: 'approve' }] },
      });
      expect(ends(run.root())).toEqual([{}, {}]);
      expect(typesOf(run.root())).not.toContain('turn/failed');
    } finally {
      await run.close();
    }
  });

  /** 停在核准點按停止（收回）：那顆收尾 frame 是 pump 自己合成的，也要帶原因（#1831 審查 N3）。時鐘在跑，但沒到點。 */
  it('停在核准點按停止（收回）：合成的收尾 frame 帶原因 user', async () => {
    const run = await assemble(
      [{ content: '動手。', toolCalls: [{ name: 'danger', args: {} }] }, { content: '多的。' }],
      { timeoutMs: TIMEOUT_MS, graceMs: GRACE_MS, timers: new ManualTimers() },
      [toolsPlugin({ started: 0, settled: 0, sleepMs: 0 })],
    );
    try {
      await run.pump.submit({ kind: 'message', text: '做危險的事' });
      expect(run.pump.awaitingInput).toBe(true);
      expect(run.pump.cancel()).toBe('withdrawn');
      await run.pump.whenIdle();
      expect(ends(run.root()).at(-1)).toEqual(STOPPED_END);
      await until(() => stoppedCause(run.frames) !== undefined);
      expect(stoppedCause(run.frames)).toEqual({ kind: 'user' });
    } finally {
      await run.close();
    }
  });

  it('驗收 12 帶 hook 原因的日誌續接：新的 pump 從它接著跑，歷史的收尾 frame 帶同一個原因', async () => {
    const timers = new ManualTimers();
    const probe: Probe = { started: 0, settled: 0, sleepMs: 50 };
    const first = await assemble(forever(1), { timeoutMs: TIMEOUT_MS, graceMs: GRACE_MS, timers }, [
      toolsPlugin(probe),
    ]);
    let seed: readonly SessionEvent[];
    try {
      const turn = first.pump.submit({ kind: 'message', text: '查' });
      await until(() => probe.started === 1);
      timers.fire(TIMEOUT_MS);
      await turn;
      seed = [...first.root()];
    } finally {
      await first.close();
    }
    expect(seed.at(-1)).toMatchObject({ type: 'turn/end', data: TIMED_OUT_END });

    const built = await createNexusAgent({
      model: new ScriptedChatModel({ turns: [{ content: '接著來。' }] }),
      checkpointer: new MemorySaver(),
      plugins: [toolsPlugin(probe)],
    });
    const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'clock-root', undefined, seed);
    const detach = built.attachSession(pump.sessions);
    try {
      const closing = historyFrames(pump.sessionLog.events, DEFAULT_TOOL_TEXT_MAX_BYTES)
        .filter((frame) => frame.method === 'lifecycle')
        .map((frame) => frame.params.data as { aborted?: unknown; cause?: unknown });
      expect(closing).toContainEqual(expect.objectContaining({ aborted: true, cause: HOOK }));
      await pump.submit({ kind: 'message', text: '還在嗎' });
      expect(ends(pump.sessionLog.events)).toEqual([TIMED_OUT_END, {}]);
    } finally {
      detach();
      await built.dispose();
    }
  });
});

describe('退避中到點（驗收 3，真的 HTTP）', () => {
  const original = process.env[LIVE_API_KEY_ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[LIVE_API_KEY_ENV];
    else process.env[LIVE_API_KEY_ENV] = original;
  });

  it('第一次就 503、排了 10 秒的退避：到點當場收尾，不再重打', async () => {
    process.env[LIVE_API_KEY_ENV] = 'nvapi-test-value-not-a-real-key';
    let hits = 0;
    const server = createServer((req, res) => {
      hits += 1;
      req.resume();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({ error: { message: '上游出事了', type: 'upstream', code: 503 } })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;
    const built = await createNexusAgent({
      model: createLiveModel(
        liveModelConfigSchema.parse({
          baseUrl: `http://127.0.0.1:${String(port)}/v1`,
          timeoutMs: 2000,
          streamIdleTimeoutMs: 2000,
        }),
      ),
      checkpointer: new MemorySaver(),
      plugins: [],
      streamRetry: { maxRetries: 6, initialDelayMs: 10_000, jitterRatio: 0 },
    });
    const timers = new ManualTimers();
    const pump = new ThreadPump(
      built.agent as unknown as PumpAgent,
      'clock-retry',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { timeoutMs: TIMEOUT_MS, graceMs: GRACE_MS, timers },
    );
    const detach = built.attachSession(pump.sessions);
    try {
      const turn = pump.submit({ kind: 'message', text: '嗨' });
      await until(() => typesOf(pump.sessionLog.events).includes('llm/retry'));
      const firedAt = Date.now();
      timers.fire(TIMEOUT_MS);
      await turn;
      // 當場：遠小於 10 秒的退避。
      expect(Date.now() - firedAt).toBeLessThan(2000);
      expect(hits).toBe(1);
      expect(pump.sessionLog.events.at(-1)).toMatchObject({
        type: 'turn/end',
        data: TIMED_OUT_END,
      });
      expect(typesOf(pump.sessionLog.events)).not.toContain('turn/failed');
      expect(typesOf(pump.sessionLog.events)).not.toContain('llm/retry-started');
    } finally {
      detach();
      await built.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('串流中到點（驗收 2，真的 ChatOpenAI 與重試政策）', () => {
  const original = process.env[LIVE_API_KEY_ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[LIVE_API_KEY_ENV];
    else process.env[LIVE_API_KEY_ENV] = original;
  });

  /**
   * 中止原因不放進 `abort(reason)` 的那條線（`thread-pump.ts` 的 `CurrentRun.cause`）在這裡量：被切斷的請求不能被重試政策當成一次可重打的失敗
   * （多一筆 `llm/retry`、畫面多一則「N 秒後重試」）。
   */
  it('上游當場被切斷，不記重試、不記失敗；被打斷的半段留下', async () => {
    process.env[LIVE_API_KEY_ENV] = 'nvapi-test-value-not-a-real-key';
    const full = '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉';
    let hits = 0;
    let sent = 0;
    const server = createServer((req, res) => {
      hits += 1;
      req.resume();
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
        `data: ${JSON.stringify({
          id: 'c',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'fake',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(chunk({ role: 'assistant', content: '' }));
      let at = 0;
      const tick = setInterval(() => {
        if (res.destroyed) return clearInterval(tick);
        if (at < full.length) {
          res.write(chunk({ content: full[at] }));
          at += 1;
          sent = at;
          return;
        }
        clearInterval(tick);
        res.write(chunk({}, 'stop'));
        res.end('data: [DONE]\n\n');
      }, 40);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;
    const built = await createNexusAgent({
      model: createLiveModel(
        liveModelConfigSchema.parse({ baseUrl: `http://127.0.0.1:${String(port)}/v1` }),
      ),
      checkpointer: new MemorySaver(),
      plugins: [],
      streamRetry: { maxRetries: 6, initialDelayMs: 50, jitterRatio: 0 },
    });
    const timers = new ManualTimers();
    const pump = new ThreadPump(
      built.agent as unknown as PumpAgent,
      'clock-stream',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { timeoutMs: TIMEOUT_MS, graceMs: GRACE_MS, timers },
    );
    const detach = built.attachSession(pump.sessions);
    try {
      const turn = pump.submit({ kind: 'message', text: '講' });
      await until(() => sent >= 3);
      timers.fire(TIMEOUT_MS);
      await turn;
      const events = pump.sessionLog.events;
      expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: TIMED_OUT_END });
      expect(typesOf(events)).not.toContain('turn/failed');
      expect(typesOf(events)).not.toContain('llm/retry');
      expect(hits).toBe(1);
      // 上游真的斷了：之後送出的字數不再長。
      const stopped = sent;
      await sleep(200);
      expect(sent).toBe(stopped);
      expect(stopped).toBeLessThan(full.length);
      const kept = events.find(
        (event) => event.type === 'assistant/message' && event.data.interrupted === true,
      );
      expect(kept).toBeDefined();
    } finally {
      detach();
      await built.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('目標（驗收 8）', () => {
  function portFor(goals: GoalServices, log: () => SessionLog): GoalDriverPort {
    return {
      goal: () => goals.serviceFor(log())?.get(),
      block: (ref, reason) => void goals.serviceFor(log())?.block(ref, reason),
      disarm: () => void goals.serviceFor(log())?.disarm(),
      pause: (ref) => void goals.serviceFor(log())?.pause(ref),
      flush: () => Promise.resolve(),
      warn: () => undefined,
    };
  }

  it('續行輪被時鐘中止：排程器不再排下一輪，目標 active、disarmed', async () => {
    const slow: ScriptedTurn = { content: '這一輪故意拖得很長。'.repeat(12), tokenDelayMs: 20 };
    const plugin = createGoalPlugin({ now: () => 100, newGoalId: () => 'goal-1' });
    const model = new ScriptedChatModel({ turns: [slow, slow, slow] });
    const { agent, dispose, attachSession, attachInvariants, services } = await createNexusAgent({
      model: model as never,
      plugins: [plugin, createGoalInvariantPlugin()],
      checkpointer: new MemorySaver(),
    });
    const late: { log?: SessionLog } = {};
    const goals = goalCoreOf(services.use(GOALS_SERVICE));
    const timers = new ManualTimers();
    const pump = new ThreadPump(
      agent as unknown as PumpAgent,
      'clock-goal',
      portFor(goals, () => late.log as SessionLog),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { timeoutMs: TIMEOUT_MS, graceMs: GRACE_MS, timers },
    );
    late.log = pump.sessionLog;
    const detachInvariants = attachInvariants(pump.sessions);
    const detachSession = attachSession(pump.sessions);
    try {
      const service = goals.serviceFor(pump.sessionLog);
      service?.create({ objective: '把 CI 修綠', maxGoalRounds: 5 });
      await until(() => pump.running);
      timers.fire(TIMEOUT_MS);
      for (let round = 0; round < 20; round += 1) {
        await pump.whenIdle();
        await new Promise((resolve) => setImmediate(resolve));
        if (!pump.running && !pump.goalRoundInFlight) break;
      }
      await sleep(100);
      expect(ends(pump.sessionLog.events)).toEqual([TIMED_OUT_END]);
      expect(model.prompts).toHaveLength(1);
      expect(service?.get()).toMatchObject({ phase: 'active', activation: 'disarmed' });
    } finally {
      detachSession();
      detachInvariants?.();
      await dispose();
    }
  });
});

describe('背景子代理（Q-B4 (a)）', () => {
  /** 假 agent：拿到這一輪的中止訊號，可以等它舉起來再收。 */
  function abortable(script: (text: string, signal: AbortSignal) => Promise<void> | void) {
    const agent: BackgroundAgent = {
      async streamEvents(input, config) {
        const text = String(
          (input as { messages: { content: unknown }[] }).messages.at(-1)?.content,
        );
        await script(text, config.configurable?.[TURN_CANCEL_CONFIG_KEY] as AbortSignal);
        return (async function* () {})() as never;
      },
    };
    return agent;
  }
  const waitAbort = (signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    });

  it('到點：那一輪收成 aborted/hook，排著的輪次暫停到下一次 submit（不結算）；計時器清乾淨', async () => {
    const timers = new ManualTimers();
    const order: string[] = [];
    let entered!: () => void;
    const enteredOnce = new Promise<void>((resolve) => (entered = resolve));
    const agent = abortable(async (text, signal) => {
      order.push(text);
      if (text === 'A1') {
        entered();
        await waitAbort(signal);
      }
    });
    const settlements: BackgroundSettlement[] = [];
    const sessions = new SessionRegistry('root-clock');
    const host = new BackgroundSubagentHost({
      sessions,
      compile: () => agent,
      onSettled: (settlement) => void settlements.push(settlement),
      turnClock: { timeoutMs: TIMEOUT_MS, graceMs: GRACE_MS, timers },
    });
    try {
      const first = host.start({ subagent: 'worker', text: 'A1' });
      const queued = host.submit({ runId: first.runId, subagent: 'worker', text: 'A2' });
      await enteredOnce;
      timers.fire(TIMEOUT_MS);
      expect(await first.outcome).toEqual({ ok: true });
      await sleep(30);
      const log = sessions.get({ kind: 'subagent', runId: first.runId })!;
      expect(ends(log.events)).toEqual([TIMED_OUT_END]);
      // 還有排著的輪次，所以還沒結算（同 `interrupt`）。
      expect(settlements).toEqual([]);
      // 排著的 A2 沒有被丟，也沒有開跑；收尾之後一顆計時器都不掛。
      expect(order).toEqual(['A1']);
      expect(timers.delays()).toEqual([]);
      const resumed = host.submit({ runId: first.runId, subagent: 'worker', text: 'A3' });
      expect(await queued).toEqual({ ok: true });
      expect(await resumed).toEqual({ ok: true });
      expect(order).toEqual(['A1', 'A2', 'A3']);
      expect(ends(log.events)).toEqual([TIMED_OUT_END, {}, {}]);
    } finally {
      await host.close();
    }
  });

  it('沒有排著的：到點之後結算，原因是 aborted', async () => {
    const timers = new ManualTimers();
    let entered!: () => void;
    const enteredOnce = new Promise<void>((resolve) => (entered = resolve));
    const agent = abortable(async (_text, signal) => {
      entered();
      await waitAbort(signal);
    });
    const settlements: BackgroundSettlement[] = [];
    const host = new BackgroundSubagentHost({
      sessions: new SessionRegistry('root-clock'),
      compile: () => agent,
      onSettled: (settlement) => void settlements.push(settlement),
      turnClock: { timeoutMs: TIMEOUT_MS, graceMs: GRACE_MS, timers },
    });
    try {
      const run = host.start({ subagent: 'worker', text: '慢' });
      await enteredOnce;
      timers.fire(TIMEOUT_MS);
      await run.outcome;
      expect(settlements.map((settlement) => settlement.reason)).toEqual(['aborted']);
      expect(settlements[0]?.cause).toEqual({ kind: 'hook', reason: 'turn-timeout' });
    } finally {
      await host.close();
    }
  });

  it('對照：父代理那一側先中斷，原因照舊是 parent；之後時鐘才到點也不改寫', async () => {
    const timers = new ManualTimers();
    let entered!: () => void;
    const enteredOnce = new Promise<void>((resolve) => (entered = resolve));
    const agent = abortable(async (_text, signal) => {
      entered();
      await waitAbort(signal);
    });
    const sessions = new SessionRegistry('root-clock');
    const host = new BackgroundSubagentHost({
      sessions,
      compile: () => agent,
      turnClock: { timeoutMs: TIMEOUT_MS, graceMs: GRACE_MS, timers },
    });
    try {
      const run = host.start({ subagent: 'worker', text: '慢' });
      await enteredOnce;
      expect(host.interrupt(run.runId)).toBe(true);
      timers.fire(TIMEOUT_MS);
      await run.outcome;
      const log = sessions.get({ kind: 'subagent', runId: run.runId })!;
      expect(ends(log.events)).toEqual([
        { reason: { kind: 'aborted', cause: { kind: 'parent' } } },
      ]);
    } finally {
      await host.close();
    }
  });

  /** 同 root 的驗收 7（Q-B2 (a)），背景那一輪（#1831 審查 N4）：到點之後過了寬限還沒收尾，記一行 warn，帶 run id；不丟下那一輪。 */
  it('到點之後過了寬限還沒收尾：記一行 warn，帶 run id；放行之後照常收尾', async () => {
    const timers = new ManualTimers();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const enteredOnce = new Promise<void>((resolve) => (entered = resolve));
    // 不理中止訊號：模擬一顆到點之後還不肯落定的工具。
    const agent = abortable(async () => {
      entered();
      await hold;
    });
    const warnings: string[] = [];
    const sessions = new SessionRegistry('root-clock');
    const host = new BackgroundSubagentHost({
      sessions,
      compile: () => agent,
      warn: (message) => warnings.push(message),
      turnClock: { timeoutMs: TIMEOUT_MS, graceMs: GRACE_MS, timers },
    });
    try {
      const run = host.start({ subagent: 'worker', text: '慢' });
      await enteredOnce;
      timers.fire(TIMEOUT_MS);
      expect(timers.delays()).toEqual([GRACE_MS]);
      timers.fire(GRACE_MS);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(run.runId);
      expect(warnings[0]).toContain('到點中止之後還沒收尾');
      release();
      await run.outcome;
      const log = sessions.get({ kind: 'subagent', runId: run.runId })!;
      expect(ends(log.events)).toEqual([TIMED_OUT_END]);
    } finally {
      release();
      await host.close();
    }
  });

  /** 拿掉 `BackgroundDelegation.attach` 交 `turnClock` 的那一格，這一條要紅：背景那一輪沒有計時器可以到點。 */
  it('接線：產品組裝上 attachSession 的 port 帶時鐘，背景派出的那一輪起一顆、到點收成 hook', async () => {
    const timers = new ManualTimers();
    const worker: PluginEntry = {
      plugin: {
        name: 'clock-worker',
        apply(registry) {
          registry.subagents.register({
            name: 'worker',
            description: '幹活的。',
            systemPrompt: '幹活。',
            model: new ScriptedChatModel({
              turns: [{ content: '背景慢慢講。'.repeat(40), tokenDelayMs: 20 }],
            }) as never,
          });
        },
      },
    };
    const built = await createNexusAgent({
      model: new ScriptedChatModel({
        turns: [
          {
            content: '',
            toolCalls: [
              { name: 'subagent', args: { description: '幹活', subagent_type: 'worker' } },
            ],
          },
          { content: '派出去了。' },
        ],
      }),
      checkpointer: new MemorySaver(),
      plugins: [worker],
      backgroundSubagents: {},
    });
    const sessions = new SessionRegistry('root-attach');
    const detach = built.attachSession(sessions, {
      turnClock: { timeoutMs: TIMEOUT_MS, graceMs: GRACE_MS, timers },
    });
    try {
      await built.agent.invoke(
        { messages: [new HumanMessage('派一個')] },
        { configurable: { thread_id: 'root-attach' } },
      );
      const childLog = () =>
        sessions.list().find((entry) => entry.address.kind === 'subagent')?.log;
      await until(() => childLog() !== undefined && timers.delays().includes(TIMEOUT_MS));
      timers.fire(TIMEOUT_MS);
      await until(() => ends(childLog()!.events).length === 1);
      expect(ends(childLog()!.events)).toEqual([TIMED_OUT_END]);
    } finally {
      await detach();
      await built.dispose();
    }
  });
});

describe('wire 與 serve 的接線', () => {
  it('createWireHandler 把 turnClock 交給背景子代理的 port', async () => {
    const clock: TurnClock = { timeoutMs: 12_345 };
    const ports: unknown[] = [];
    const attachSessions: AttachSessions = (_sessions, port) => {
      ports.push(port);
      return { detach: async () => {} };
    };
    const built = await createNexusAgent({
      model: new ScriptedChatModel({ turns: [{ content: '好。' }] }),
      checkpointer: new MemorySaver(),
      plugins: [],
    });
    const handler = createWireHandler({
      auth: TEST_BROWSER_AUTH,
      turnClock: clock,
      createAgent: async () => ({
        agent: built.agent as unknown as PumpAgent,
        attachSessions,
        commands: emptyCommandPoint(),
        dispose: () => built.dispose(),
      }),
    });
    try {
      const client = createWireClient({
        baseUrl: 'http://clock.test',
        fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
      });
      await client.slashList('clock-thread');
      expect(ports).toHaveLength(1);
      expect((ports[0] as { turnClock?: unknown }).turnClock).toBe(clock);
    } finally {
      await handler.close();
    }
  });
});

/** 下行上 root 收尾那顆 `lifecycle` 的 data。 */
async function closingFrame(events: AsyncIterator<Event>): Promise<Record<string, unknown>> {
  for (;;) {
    const next = await events.next();
    if (next.done === true) throw new Error('下行在 root 收尾之前就斷了');
    const data = next.value.params.data as Record<string, unknown> | null;
    if (
      next.value.method === 'lifecycle' &&
      next.value.params.namespace.length === 0 &&
      data?.graph_name === 'root' &&
      (data.event === 'completed' || data.event === 'failed')
    ) {
      return data;
    }
  }
}

/** 起動日誌去掉時間戳、等級與來源（`2026-10-22 19:29:50 [I] serve `）之後的那句話。 */
const said = (lines: readonly string[]) =>
  lines.map((line) => line.replace(/^.*? \[[A-Z]\] serve /u, ''));

describe('serve：turn-timeout 那一列（產品路徑，出廠的真計時器）', () => {
  let served: ScriptedServe | undefined;
  afterEach(async () => {
    await served?.close();
    served = undefined;
  });

  it('出廠：啟動那一行講 1800000 毫秒（30 分鐘）', async () => {
    const lines: string[] = [];
    served = await startScriptedServe([{ content: '好。' }], {
      log: (line) => void lines.push(line),
    });
    expect(said(lines)).toContain(
      '一輪的時鐘：1800000 毫秒（主對話與背景子代理的每一輪各自起算，到點照停止鍵的路中止）',
    );
  });

  /** 大約 2 秒的一句回覆：每個字 20 毫秒。 */
  const SLOW_REPLY: ScriptedTurn = { content: '慢慢講。'.repeat(25), tokenDelayMs: 20 };

  /** serve 不把那一列交給 handler（或 pump 不交給 `#runOnce`），這一條要紅：那一輪會講完、正常收尾。 */
  it('timeoutMs: 300：那一輪到點收成中止，收尾 frame 帶 hook 原因；啟動那一行講 300 毫秒', async () => {
    const lines: string[] = [];
    served = await startScriptedServe([SLOW_REPLY], {
      extraRows: '- id: turn-timeout\n  config:\n    timeoutMs: 300\n',
      log: (line) => void lines.push(line),
    });
    expect(said(lines)).toContain(
      '一輪的時鐘：300 毫秒（主對話與背景子代理的每一輪各自起算，到點照停止鍵的路中止）',
    );
    const client = await serveClient(served.running);
    const events = await client.openEvents('clock-serve');
    const startedAt = Date.now();
    expect((await client.runStart('clock-serve', '講長一點')).type).toBe('success');
    const closing = await closingFrame(events);
    // 收成中止就表示沒講完（那句要講約 2 秒）；不另外斷言上限，負載下的牆鐘不可靠。
    expect(closing).toMatchObject({ aborted: true, cause: HOOK });
    // 下限：不是一開跑就停（時鐘是 300 毫秒，不是 0）。
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(300);
  }, 15_000);

  /** serve 讀那一列時不先問掛沒掛，這一條要紅：關掉的列被讀成出廠的 30 分鐘。 */
  it('對照：那一列關掉就是不限，啟動那一行講不限；同一句回覆講完、正常收尾', async () => {
    const lines: string[] = [];
    served = await startScriptedServe([SLOW_REPLY], {
      extraRows: '- id: turn-timeout\n  disabled: true\n',
      log: (line) => void lines.push(line),
    });
    expect(said(lines)).toContain('一輪的時鐘：不限（turn-timeout 那一列關掉了）');
    const client = await serveClient(served.running);
    const events = await client.openEvents('clock-off');
    expect((await client.runStart('clock-off', '講長一點')).type).toBe('success');
    const closing = await closingFrame(events);
    expect(closing).toMatchObject({ event: 'completed' });
    expect(closing.aborted).toBeUndefined();
  }, 15_000);
});

describe('turn-clock 本身', () => {
  it('沒給時鐘：不起計時器，stop 什麼都不做', () => {
    const stop = startTurnClock(
      undefined,
      () => {
        throw new Error('不該到點');
      },
      () => undefined,
    );
    stop();
  });

  it('到點之後才排寬限；stop 之後寬限不叫', () => {
    const timers = new ManualTimers();
    const calls: string[] = [];
    const stop = startTurnClock(
      { timeoutMs: TIMEOUT_MS, graceMs: GRACE_MS, timers },
      () => calls.push('expire'),
      () => calls.push('grace'),
    );
    expect(timers.delays()).toEqual([TIMEOUT_MS]);
    timers.fire(TIMEOUT_MS);
    expect(calls).toEqual(['expire']);
    expect(timers.delays()).toEqual([GRACE_MS]);
    stop();
    expect(timers.delays()).toEqual([]);
    stop();
    expect(calls).toEqual(['expire']);
  });

  it('unsettledToolNames：只看最近一輪，落定的不算，依開的先後', () => {
    const events = [
      { type: 'turn/start', data: { kind: 'message', text: '舊' } },
      { type: 'tool/call', data: { callId: 'old', name: 'old_tool', arguments: '{}' } },
      { type: 'turn/start', data: { kind: 'message', text: '新' } },
      { type: 'tool/call', data: { callId: 'a', name: 'first', arguments: '{}' } },
      { type: 'tool/call', data: { callId: 'b', name: 'second', arguments: '{}' } },
      { type: 'tool/result', data: { callId: 'a', isError: false } },
      { type: 'tool/call', data: { callId: 'c', name: 'third', arguments: '{}' } },
    ].map((event, seq) => ({ ...event, seq, time: seq })) as unknown as SessionEvent[];
    expect(unsettledToolNames(events)).toEqual(['second', 'third']);
  });
});
