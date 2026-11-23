/**
 * **停止撞上核准點：這一輪收完之後收回，兩個 loop 一樣**（[#2592](https://github.com/DemianLi/nexus-agent/issues/2592)）。
 *
 * 停止落在「這一輪已經決定停在核准點、還沒收尾」的那段時間，有三個入口，各量一格：
 *
 * - **提問已經講出去**（`input-requested` 之後、`turn/end` 之前）；
 * - **閘門決定要問的那一刻**（同步的閘門回 `ask` 之前按）；
 * - **非同步的閘門**（閘門先等一拍 macrotask 再按、再回 `ask`）。
 *
 * 判準是日誌：三個入口留下的，跟「停穩之後才按停止」那條收回路徑逐筆相同（編號與時間正規化掉）。收回的原因照這一輪被中止的
 * 原因記：一輪的時鐘到點撞上這段，記成時鐘到點（`hook`，`turn-timeout`），不是人按的。
 *
 * @module
 */

import { tool } from '@langchain/core/tools';
import type { PluginEntry, SessionEvent } from '@nexus/core';
import type { Event } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createNexusAgent } from './agent-factory.js';
import { PrunedMemorySaver } from './pruned-memory-saver.js';
import { ScriptedChatModel } from './scripted-model.js';
import { TURN_TIMEOUT_REASON } from './settings/turn-timeout.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpActivity, PumpAgent } from './thread-pump.js';
import type { TurnClock } from './turn-clock.js';

type Loop = 'langgraph' | 'native';
type Gate = 'sync' | 'async';

const LOOPS = ['langgraph', 'native'] as const;
const USER_END = { reason: { kind: 'aborted', cause: { kind: 'user' } } };
const TIMEOUT_CAUSE = { kind: 'hook', reason: TURN_TIMEOUT_REASON };

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * 組一份：模型叫一顆要核准的 `danger`，第二輪說一句話收尾。
 *
 * @param loop - 哪一個 loop。
 * @param options.onGate - 閘門判定 `danger` 要問時叫，`gate` 決定在回 `ask` 之前同步叫還是先等一拍 macrotask。
 * @param options.clock - 這條 thread 的一輪時鐘。
 */
async function assemble(
  loop: Loop,
  options: { onGate?: () => void; gate?: Gate; clock?: TurnClock } = {},
) {
  const model = new ScriptedChatModel({
    turns: [{ content: '動手。', toolCalls: [{ name: 'danger', args: {} }] }, { content: '好。' }],
  });
  const hook: { onGate?: () => void } = { onGate: options.onGate };
  const ask = { kind: 'ask' as const, reason: '危險' };
  const danger: PluginEntry = {
    plugin: {
      name: 'approval-point-danger',
      apply(registry) {
        registry.tools.register(
          tool(() => '做完了', { name: 'danger', description: '要核准。', schema: z.object({}) }),
        );
        registry.approvals.gate((exec, next) => {
          if (exec.name !== 'danger') return next();
          const fire = (): typeof ask => {
            const onGate = hook.onGate;
            hook.onGate = undefined;
            onGate?.();
            return ask;
          };
          if (options.gate !== 'async') return fire();
          return new Promise<void>((resolve) => setImmediate(resolve)).then(fire);
        });
      },
    },
  };
  const built = await createNexusAgent({
    model,
    checkpointer: new PrunedMemorySaver(),
    agentLoop: loop,
    plugins: [danger],
  });
  const pump = new ThreadPump(
    built.agent as unknown as PumpAgent,
    `approval-point-${loop}`,
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
    options.clock,
  );
  const detach = built.attachSession(pump.sessions);
  const activities: PumpActivity[] = [];
  const unwatch = pump.watch((activity) => void activities.push(activity));
  const frames: Event[] = [];
  const line = new AbortController();
  const stream = pump.subscribe(['messages', 'tools', 'lifecycle', 'input'], line.signal);
  const draining = (async () => {
    for await (const frame of stream) frames.push(frame);
  })();
  cleanups.push(async () => {
    line.abort();
    await draining;
    unwatch();
    detach();
    await built.dispose();
  });
  const log = (): readonly SessionEvent[] => pump.sessions.root.events;
  return {
    pump,
    log,
    activities,
    frames,
    ended: () => log().some((event) => event.type === 'turn/end'),
    asked: () => log().some((event) => event.type === 'interrupt/raised'),
  };
}

/** 提問講出去之後，等一拍 microtask 再叫 `act`——這時這一輪還沒收尾。 */
function afterAsked(pump: ThreadPump, act: () => void): void {
  const stop = pump.watch((activity) => {
    if (activity.type !== 'input-requested') return;
    stop();
    void Promise.resolve().then(act);
  });
}

const UUID =
  /^(run-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^[0-9a-f]{32}$/u;

/** 日誌的 `type` 與 `data`，編號照出現順序換成佔位、`modelCall` 也是：兩次組裝之間只差這些。 */
function normalized(events: readonly SessionEvent[]): unknown[] {
  const ids = new Map<string, string>();
  const calls = new Map<number, string>();
  return JSON.parse(
    JSON.stringify(
      events.map((event) => ({ type: event.type, data: event.data })),
      (key, value: unknown) => {
        if (key === 'modelCall' && typeof value === 'number') {
          if (!calls.has(value)) calls.set(value, `<modelCall#${calls.size}>`);
          return calls.get(value);
        }
        if (typeof value === 'string' && UUID.test(value)) {
          if (!ids.has(value)) ids.set(value, `<id#${ids.size}>`);
          return ids.get(value);
        }
        return value;
      },
    ),
  ) as unknown[];
}

/** 對照組：停穩之後才按停止，走的是停在核准點時按停止那一格。 */
async function stoppedAfterSettled(loop: Loop): Promise<unknown[]> {
  const run = await assemble(loop);
  await run.pump.submit({ kind: 'message', text: '做危險的事' });
  expect(run.pump.awaitingInput).toBe(true);
  expect(run.pump.cancel()).toBe('withdrawn');
  await run.pump.whenIdle();
  return normalized(run.log());
}

/** 下行是另一條 async 鏈在抽，`whenIdle` 回來時還不一定抽到最後一顆。 */
async function until(predicate: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const isAbortedRootEnd = (frame: Event): boolean =>
  frame.method === 'lifecycle' &&
  frame.params.namespace.length === 0 &&
  (frame.params.data as { aborted?: unknown }).aborted === true;

/** 收回之後的共同樣子：不再掛著，watch 收到那顆中斷的 `input-withdrawn`，最後一顆 root 收尾 frame 標了中止。 */
async function expectWithdrawn(
  run: Awaited<ReturnType<typeof assemble>>,
  cause: unknown,
): Promise<void> {
  expect(run.pump.awaitingInput).toBe(false);
  const raised = run.log().find((event) => event.type === 'interrupt/raised');
  expect(run.activities).toContainEqual({
    type: 'input-withdrawn',
    interruptId: (raised?.data as { interruptId: string }).interruptId,
  });
  await until(() => run.frames.some(isAbortedRootEnd));
  const last = run.frames
    .filter((frame) => frame.method === 'lifecycle' && frame.params.namespace.length === 0)
    .at(-1);
  expect(last?.params.data).toMatchObject({ event: 'completed', aborted: true, cause });
}

describe('停止撞上核准點：收完這一輪再收回', () => {
  it.each(LOOPS)('%s：提問已經講出去、還沒收尾時按停止', async (loop) => {
    const reference = await stoppedAfterSettled(loop);
    const run = await assemble(loop);
    let landed: { result: string; ended: boolean } | undefined;
    afterAsked(run.pump, () => {
      landed = { ended: run.ended(), result: run.pump.cancel() };
    });
    await run.pump.submit({ kind: 'message', text: '做危險的事' });
    await run.pump.whenIdle();

    // 真的落在這段：落在跑著的那一輪上，那時 `turn/end` 還沒寫。
    expect(landed).toEqual({ ended: false, result: 'run' });
    expect(run.log().at(-1)).toMatchObject({ type: 'turn/end', data: USER_END });
    await expectWithdrawn(run, { kind: 'user' });
    expect(normalized(run.log())).toEqual(reference);
  });

  it.each(
    LOOPS.flatMap((loop) => (['sync', 'async'] as const).map((gate) => [loop, gate] as const)),
  )('%s：%s 閘門決定要問的那一刻按停止', async (loop, gate) => {
    const reference = await stoppedAfterSettled(loop);
    let landed: { result: string; asked: boolean } | undefined;
    const run = await assemble(loop, {
      gate,
      onGate: () => {
        landed = { asked: run.asked(), result: run.pump.cancel() };
      },
    });
    await run.pump.submit({ kind: 'message', text: '做危險的事' });
    await run.pump.whenIdle();

    // 真的落在這段：還沒提問，按的是跑著的那一輪。
    expect(landed).toEqual({ asked: false, result: 'run' });
    expect(run.log().at(-1)).toMatchObject({ type: 'turn/end', data: USER_END });
    await expectWithdrawn(run, { kind: 'user' });
    expect(normalized(run.log())).toEqual(reference);
  });

  it.each(LOOPS)('%s：一輪的時鐘到點撞上這段，收回記成時鐘到點', async (loop) => {
    const expire: { fire?: () => void } = {};
    const run = await assemble(loop, {
      clock: {
        timeoutMs: 60_000,
        timers: {
          set: (callback) => {
            expire.fire ??= callback;
            return expire;
          },
          clear: () => {},
        },
      },
    });
    let ended: boolean | undefined;
    afterAsked(run.pump, () => {
      ended = run.ended();
      expire.fire?.();
    });
    await run.pump.submit({ kind: 'message', text: '做危險的事' });
    await run.pump.whenIdle();

    expect(ended).toBe(false);
    expect(run.log().at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'aborted', cause: TIMEOUT_CAUSE } },
    });
    await expectWithdrawn(run, TIMEOUT_CAUSE);
  });
});
