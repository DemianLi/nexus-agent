/**
 * **目標目前的樣子，即時看得到，重新整理之後也一樣**——[#897](https://github.com/DemianLi/nexus-agent/issues/897)
 * 的 harness 那一半。
 *
 * 真的圖、真的 goal 域、真的 pump，模型是腳本。規則照 dsh 的 `goal` 投影，只送持久的那一半（activation 不在，理由見
 * `@nexus/wire` 的 `goal.ts`）：
 *
 * 1. root 日誌的 `goal/change` 與 `turn/start{kind:'goal'}` 每讓值變一次就送一顆，沒變不送。
 * 2. 清掉了送 `{ goal: null }`。
 * 3. 歷史只在最新一頁送目前的值；一顆 `goal/change` 都沒有就不送。
 * 4. 帶著上一個行程的日誌起來時，那一段不重送，只送之後的變化。
 * 5. 折壞了（接不上的輪次）停在最後一個好的值，講一次 warn。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import { MemorySaver } from '@langchain/langgraph';
import type { SessionEvent, SessionLog } from '@nexus/core';
import { createGoalPlugin, GOALS_SERVICE } from '@nexus/plugin-goal';
import type { GoalServices } from '@nexus/plugin-goal';
import type { Event, WireGoal } from '@nexus/wire';
import { emptyConversation, GOAL, reduceAll } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { historyPage } from './conversation-history.js';
import type { GoalDriverPort } from './goal-driver.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import type { PumpAgent } from './thread-pump.js';
import { ThreadPump } from './thread-pump.js';

const OBJECTIVE = '把 CI 修綠';

/** 一輪：模型建一個目標，上限 2。接著續行排兩輪，第二輪之後撞到上限被擋。 */
const TURNS: readonly ScriptedTurn[] = [
  {
    content: '',
    toolCalls: [{ name: 'create_goal', args: { objective: OBJECTIVE, max_goal_rounds: 2 } }],
  },
  { content: '建好了。' },
  { content: '再看一下。' },
  { content: '又看一下。' },
  { content: '還有。' },
];

interface Built {
  readonly pump: ThreadPump;
  readonly goals: GoalServices;
  readonly frames: Event[];
  readonly warnings: string[];
  stop(): Promise<void>;
}

async function build(
  options: {
    turns?: readonly ScriptedTurn[];
    withDriver?: boolean;
    rootSeed?: readonly SessionEvent[];
    withGoal?: boolean;
  } = {},
): Promise<Built> {
  let serial = 0;
  const built = await createNexusAgent({
    model: new ScriptedChatModel({ turns: options.turns ?? TURNS }) as never,
    plugins:
      options.withGoal === false
        ? []
        : [createGoalPlugin({ now: () => 100, newGoalId: () => `goal-${(serial += 1)}` })],
    checkpointer: new MemorySaver(),
  });
  const late: { log?: SessionLog } = {};
  const goals = built.services.use(GOALS_SERVICE);
  const warnings: string[] = [];
  const port: GoalDriverPort = {
    goal: () => goals.serviceFor(late.log as SessionLog)?.get(),
    block: (ref, reason) => void goals.serviceFor(late.log as SessionLog)?.block(ref, reason),
    disarm: () => void goals.serviceFor(late.log as SessionLog)?.disarm(),
    pause: (ref) => void goals.serviceFor(late.log as SessionLog)?.pause(ref),
    flush: () => Promise.resolve(),
    warn: (message) => void warnings.push(message),
  };
  const pump = new ThreadPump(
    built.agent as unknown as PumpAgent,
    'goal-wire',
    options.withDriver === false ? undefined : port,
    options.rootSeed,
    undefined,
    undefined,
    (message) => void warnings.push(message),
  );
  late.log = pump.sessionLog;
  const detach = built.attachSession(pump.sessions);
  const frames: Event[] = [];
  const line = new AbortController();
  const stream = pump.subscribe(['messages', 'tools', 'lifecycle', 'custom'], line.signal);
  const draining = (async () => {
    for await (const frame of stream) frames.push(frame);
  })();
  return {
    pump,
    goals,
    frames,
    warnings,
    stop: async () => {
      line.abort();
      await draining;
      detach();
      await built.dispose();
    },
  };
}

async function settle(pump: ThreadPump): Promise<void> {
  for (let round = 0; round < 20; round += 1) {
    await pump.whenIdle();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const isGoalFrame = (frame: Event): boolean =>
  frame.method === 'custom' && (frame.params.data as { name?: string }).name === GOAL;

/** 這條線上收到的 `goal` frame 的酬載，照收到的先後。 */
const goalPayloads = (frames: readonly Event[]) =>
  frames.filter(isGoalFrame).map((frame) => (frame.params.data as { payload: unknown }).payload);

const goalOf = (frames: readonly Event[]) => reduceAll(emptyConversation(), frames).goal;

/** 重新整理拿到的：整份一頁，與只收最後幾則的那一頁。兩種都要跟即時一樣。 */
function refreshed(events: readonly SessionEvent[]) {
  return [historyPage(events), historyPage(events, { maxMessages: 1 })].map((page) =>
    goalOf(page.events),
  );
}

const BLOCKED: Partial<WireGoal> = {
  phase: 'blocked',
  blockedReason: { code: 'round-limit', message: '目標用完了設定的 2 個續行輪次。' },
};

describe('目標在即時與重新整理之後一樣', () => {
  it('建立、續行兩輪、撞到上限被擋：每次變動一顆，blockedReason 只在被擋時有', async () => {
    const { pump, frames, warnings, stop } = await build();
    await pump.submit({ kind: 'message', text: OBJECTIVE });
    await settle(pump);

    const base = {
      id: 'goal-1',
      objective: OBJECTIVE,
      maxGoalRounds: 2,
      createdAt: 100,
      updatedAt: 100,
    };
    expect(goalPayloads(frames)).toEqual([
      { goal: { ...base, revision: 1, phase: 'active', roundsStarted: 0 } },
      { goal: { ...base, revision: 1, phase: 'active', roundsStarted: 1 } },
      { goal: { ...base, revision: 1, phase: 'active', roundsStarted: 2 } },
      { goal: { ...base, revision: 2, roundsStarted: 2, ...BLOCKED } },
    ]);
    // 前提：日誌上真的有兩輪續行，輪數是從 `turn/start{kind:'goal'}` 推進的，不是從 `goal/change` 來的。
    expect(
      pump.sessionLog.events.filter(
        (event) => event.type === 'turn/start' && event.data.kind === 'goal',
      ),
    ).toHaveLength(2);

    const live = goalOf(frames);
    expect(live).toMatchObject({ phase: 'blocked', roundsStarted: 2 });
    expect(refreshed(pump.sessionLog.events)).toEqual([live, live]);
    expect(warnings).toEqual([]);
    await stop();
  }, 30000);

  it('暫停、清掉：暫停沒有 blockedReason；清掉送 null，歷史也是 null', async () => {
    const { pump, goals, frames, stop } = await build({ withDriver: false });
    const service = goals.serviceFor(pump.sessionLog);
    if (service === undefined) throw new Error('goal 域沒接上日誌');

    const created = service.create({ objective: OBJECTIVE, maxGoalRounds: 3 });
    const paused = service.pause(created);
    await settle(pump);
    expect(goalPayloads(frames).at(-1)).toMatchObject({
      goal: { phase: 'paused', revision: 2 },
    });
    expect(goalOf(frames)).not.toHaveProperty('blockedReason');
    expect(refreshed(pump.sessionLog.events)).toEqual([goalOf(frames), goalOf(frames)]);

    service.clear(paused);
    await settle(pump);
    expect(goalPayloads(frames).at(-1)).toEqual({ goal: null });
    expect(goalOf(frames)).toBeNull();
    // 清掉之後歷史明著送 null，不是不送。
    const page = historyPage(pump.sessionLog.events);
    expect(goalPayloads(page.events)).toEqual([{ goal: null }]);
    await stop();
  });

  it('一顆 goal/change 都沒有：即時不送，歷史也不送', async () => {
    const { pump, frames, stop } = await build({
      withDriver: false,
      turns: [{ content: '好。' }],
    });
    await pump.submit({ kind: 'message', text: '你好' });
    await settle(pump);
    expect(goalPayloads(frames)).toEqual([]);
    expect(goalPayloads(historyPage(pump.sessionLog.events).events)).toEqual([]);
    await stop();
  });
});

describe('帶著上一個行程的日誌起來', () => {
  it('那一段不重送，只送之後的變化', async () => {
    const first = await build();
    await first.pump.submit({ kind: 'message', text: OBJECTIVE });
    await settle(first.pump);
    const seed = [...first.pump.sessionLog.events];
    await first.stop();

    const second = await build({ rootSeed: seed, withDriver: false });
    const service = second.goals.serviceFor(second.pump.sessionLog);
    const current = service?.get();
    // 前提：goal 域真的從 seed 折出了那個被擋住的目標。
    expect(current).toMatchObject({ phase: 'blocked', roundsStarted: 2 });
    expect(goalPayloads(second.frames)).toEqual([]);

    service?.clear({ id: current!.id, revision: current!.revision });
    await settle(second.pump);
    expect(goalPayloads(second.frames)).toEqual([{ goal: null }]);
    expect(second.warnings).toEqual([]);
    await second.stop();
  }, 30000);
});

describe('歷史分頁', () => {
  it('目標建在較舊的頁：最新一頁照樣帶目前的值，較舊的頁不帶', async () => {
    const { pump, goals, stop } = await build({
      withDriver: false,
      turns: [{ content: '一。' }, { content: '二。' }, { content: '三。' }],
    });
    await pump.submit({ kind: 'message', text: '一' });
    await settle(pump);
    goals.serviceFor(pump.sessionLog)?.create({ objective: OBJECTIVE, maxGoalRounds: 3 });
    await pump.submit({ kind: 'message', text: '二' });
    await pump.submit({ kind: 'message', text: '三' });
    await settle(pump);
    const events = pump.sessionLog.events;

    const latest = historyPage(events, { maxMessages: 1 });
    // 前提：goal/change 落在最新一頁之前。
    expect(latest.hasMore).toBe(true);
    expect(latest.firstSeq).toBeGreaterThan(events.findIndex((e) => e.type === 'goal/change'));
    expect(goalOf(latest.events)).toMatchObject({ objective: OBJECTIVE });

    const older = historyPage(events, { maxMessages: 1, beforeSeq: latest.firstSeq });
    expect(goalPayloads(older.events)).toEqual([]);

    // throughSeq 之前還沒建的不算。
    const through = events.findIndex((e) => e.type === 'goal/change') - 1;
    expect(goalPayloads(historyPage(events, { throughSeq: through }).events)).toEqual([]);
    await stop();
  }, 30000);
});

describe('折壞了', () => {
  it('接不上的續行輪次：停在最後一個好的值，只講一次', async () => {
    const { pump, goals, frames, warnings, stop } = await build({ withDriver: false });
    const service = goals.serviceFor(pump.sessionLog);
    service?.create({ objective: OBJECTIVE, maxGoalRounds: 3 });
    await settle(pump);
    const good = goalPayloads(frames);
    expect(good).toHaveLength(1);

    // 不屬於目前目標的續行輪次（goalId 不對）：嚴格折疊會拋。
    const bad = {
      kind: 'goal',
      text: '續',
      goalId: 'not-the-goal',
      revision: 1,
      round: 1,
    } as never;
    pump.sessionLog.append('turn/start', bad);
    pump.sessionLog.append('turn/start', bad);
    await settle(pump);

    expect(warnings.filter((message) => message.startsWith('[目標]'))).toHaveLength(1);
    expect(goalPayloads(frames)).toEqual(good);
    // 折壞了歷史也不送：寫壞的日誌不該讓畫面畫出編出來的目標。
    expect(goalPayloads(historyPage(pump.sessionLog.events).events)).toEqual([]);
    await stop();
  });
});
