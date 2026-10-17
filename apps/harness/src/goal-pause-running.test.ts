/**
 * 目標在跑的時候暫停：**人下的暫停當場中止這一輪**（[#1516](https://github.com/DemianLi/nexus-agent/issues/1516)）。
 *
 * 真 agent、真 goal 域、真 pump（同 `goal-driver-pump.test.ts` 的搭法）。這一份測的是 pump 這一段：
 * 目標服務寫出 `goal/change{pause}`，pump 在日誌訂閱上分辨「誰下的」，人下的才中止在跑的那一輪。
 *
 * 末段（#1518）是停止鈕落在排程器 flush 縫的那幾條，同一個搭法。
 *
 * 「人下的」在這裡就是**從測試自己的 async 鏈直接呼叫服務**——跟 wire 的 `goal.pause` 與 `/goal pause` 在 HTTP 請求自己的鏈上
 * 呼叫服務是同一個形狀。兩條入口各自的接線（含 `runWhileBusy` 的閘門）在 `goal-pause-wire.test.ts`。
 */

import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import type { PluginEntry, SessionLog } from '@nexus/core';
import { GOALS_SERVICE } from '@nexus/goal';
import type { GoalServices } from '@nexus/goal';
import { createGoalInvariantPlugin } from '@nexus/plugin-goal/invariant';
import type { GoalCore } from '@nexus/plugin-goal';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import type { GoalDriverPort } from './goal-driver.js';
import { createGoalPlugin, goalCoreOf } from './goal.fixture.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedModelState, ScriptedTurn } from './scripted-model.js';
import type { PumpAgent } from './thread-pump.js';
import { ThreadPump } from './thread-pump.js';

/** 一輪故意拖長的回覆：每個字等一下，測試在中間動手。被中止時不會跑完。 */
const SLOW: ScriptedTurn = { content: '這一輪故意拖得很長。'.repeat(12), tokenDelayMs: 20 };

/** 一份 port，接真的 goal 服務。 */
function portFor(
  goals: GoalServices,
  log: () => SessionLog,
  flush: () => Promise<void> = () => Promise.resolve(),
  onGoalRead?: (nth: number) => void,
): GoalDriverPort {
  let reads = 0;
  return {
    goal: () => {
      const view = goals.serviceFor(log())?.get();
      reads += 1;
      onGoalRead?.(reads);
      return view;
    },
    block: (ref, reason) => void goals.serviceFor(log())?.block(ref, reason),
    disarm: () => void goals.serviceFor(log())?.disarm(),
    pause: (ref) => void goals.serviceFor(log())?.pause(ref),
    flush,
    warn: () => undefined,
  };
}

interface Rig {
  readonly pump: ThreadPump;
  readonly goals: GoalCore;
  readonly state: ScriptedModelState;
  readonly service: ReturnType<GoalCore['serviceFor']>;
  readonly stop: () => Promise<void>;
}

async function build(options: {
  readonly turns: readonly ScriptedTurn[];
  readonly threadId: string;
  readonly extraPlugins?: readonly PluginEntry[];
  readonly goalId?: string;
  /** 排隊前的耐久檢查點；給一個攔得住的，測試就能把一輪停在「決定了、還沒排」那一縫。 */
  readonly flush?: () => Promise<void>;
  /** 排程器每讀一次目標視圖就叫一次（第幾次）；讓測試把動作卡進兩次決定之間。 */
  readonly onGoalRead?: (nth: number) => void;
}): Promise<Rig> {
  const plugin = createGoalPlugin({ now: () => 100, newGoalId: () => options.goalId ?? 'goal-1' });
  const state: ScriptedModelState = { turn: 0, boundToolNames: [], lastPrompt: [], prompts: [] };
  const { agent, dispose, attachSession, attachInvariants, services } = await createNexusAgent({
    model: new ScriptedChatModel({ turns: options.turns, shared: state }) as never,
    plugins: [plugin, createGoalInvariantPlugin(), ...(options.extraPlugins ?? [])],
    checkpointer: new MemorySaver(),
  });
  const late: { log?: SessionLog } = {};
  const goals = goalCoreOf(services.use(GOALS_SERVICE));
  const pump = new ThreadPump(
    agent as unknown as PumpAgent,
    options.threadId,
    portFor(goals, () => late.log as SessionLog, options.flush, options.onGoalRead),
  );
  late.log = pump.sessionLog;
  const detachInvariants = attachInvariants(pump.sessions);
  const detachSession = attachSession(pump.sessions);
  return {
    pump,
    goals,
    state,
    service: goals.serviceFor(pump.sessionLog),
    stop: async () => {
      detachSession();
      detachInvariants?.();
      await dispose();
    },
  };
}

/** 日誌上每一顆 `turn/start` 的 `kind`。 */
function startKinds(log: SessionLog): string[] {
  return log.events
    .filter((event) => event.type === 'turn/start')
    .map((event) => (event.data as { kind: string }).kind);
}

/** 日誌上每一顆 `turn/end` 的收尾原因種類（沒帶 reason ＝ 正常收）。 */
function endKinds(log: SessionLog): string[] {
  return log.events
    .filter((event) => event.type === 'turn/end')
    .map((event) => (event.data as { reason?: { kind: string } }).reason?.kind ?? 'done');
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let waited = 0; waited < 400; waited += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等不到：${what}`);
}

/** 等這條 pump 全部收完。 */
async function settle(pump: ThreadPump): Promise<void> {
  for (let round = 0; round < 20; round += 1) {
    await pump.whenIdle();
    await new Promise((resolve) => setImmediate(resolve));
    if (!pump.running && !pump.goalRoundInFlight) return;
  }
}

function refOf(rig: Rig): { id: never; revision: number } {
  const view = rig.service?.get();
  if (view === undefined) throw new Error('目標不在');
  return { id: view.id as never, revision: view.revision };
}

describe('人下的暫停當場中止在跑的那一輪（#1516）', () => {
  it('A 續行輪在跑：暫停之後那一輪以 aborted 收，相位是 paused，不再有續行', async () => {
    const rig = await build({ turns: [SLOW, SLOW, SLOW], threadId: 'pause-a' });
    rig.service?.create({ objective: '把 CI 修綠', maxGoalRounds: 5 });
    await until(() => rig.pump.running, '續行輪開跑');
    expect(startKinds(rig.pump.sessionLog)).toEqual(['goal']);

    rig.service?.pause(refOf(rig));
    await settle(rig.pump);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(endKinds(rig.pump.sessionLog)).toEqual(['aborted']);
    expect(rig.service?.get()?.phase).toBe('paused');
    // 沒有下一個續行輪：模型只被叫過一次。
    expect(startKinds(rig.pump.sessionLog)).toEqual(['goal']);
    expect(rig.state.prompts).toHaveLength(1);
    expect(rig.pump.running).toBe(false);
    await rig.stop();
  });

  it('C 人打的那一輪在跑（目標 active）：暫停同樣當場中止', async () => {
    const rig = await build({ turns: [SLOW], threadId: 'pause-c' });
    // `submit` 等到那一輪收完才回，所以不 await：測試要在它跑著的時候動手。
    const submitted = rig.pump.submit({ kind: 'message', text: '先做這件' });
    await until(() => rig.pump.running, '人打的那一輪開跑');
    // 一輪跑著時建的目標：不問排程器（那一輪收尾時本來就會問）。
    rig.service?.create({ objective: '把 CI 修綠', maxGoalRounds: 5 });
    expect(rig.service?.get()?.phase).toBe('active');

    rig.service?.pause(refOf(rig));
    await submitted;
    await settle(rig.pump);

    expect(startKinds(rig.pump.sessionLog)).toEqual(['message']);
    expect(endKinds(rig.pump.sessionLog)).toEqual(['aborted']);
    expect(rig.service?.get()?.phase).toBe('paused');
    await rig.stop();
  });

  it('active 但已收回授權（disarmed）的目標被暫停：相位變 paused，沒有東西可中止', async () => {
    const rig = await build({ turns: [SLOW], threadId: 'pause-disarmed' });
    rig.service?.create({ objective: '把 CI 修綠', maxGoalRounds: 5 });
    rig.service?.disarm();
    await settle(rig.pump);
    expect(startKinds(rig.pump.sessionLog)).toEqual([]);
    expect(rig.service?.get()).toMatchObject({ phase: 'active', activation: 'disarmed' });

    const cancel = vi.spyOn(rig.pump, 'cancel');
    rig.service?.pause(refOf(rig));
    await settle(rig.pump);

    expect(rig.service?.get()?.phase).toBe('paused');
    expect(cancel).not.toHaveBeenCalled();
    expect(startKinds(rig.pump.sessionLog)).toEqual([]);
    await rig.stop();
  });

  it('D 模型在自己這一輪裡用 update_goal 暫停：那一輪照常收完，不被中止', async () => {
    // 模型的 `update_goal pause` 要一則人類直接發出的訊息當授權（`GOAL_TOOL_AUTHORITY_REQUIRED`），所以它出現在人打的那一輪裡：
    // 人說「先暫停」，模型照做。目標先用服務建好並收回授權，免得排程器先開一輪續行。
    const rig = await build({
      turns: [
        {
          content: '',
          toolCalls: [
            { name: 'update_goal', args: { goal_id: 'goal-1', revision: 1, action: 'pause' } },
          ],
        },
        { content: '好，先暫停這個目標。' },
      ],
      threadId: 'pause-d',
    });
    rig.service?.create({ objective: '把 CI 修綠', maxGoalRounds: 5 });
    rig.service?.disarm();
    await settle(rig.pump);

    await rig.pump.submit({ kind: 'message', text: '先暫停這個目標' });
    await settle(rig.pump);

    expect(rig.service?.get()?.phase).toBe('paused');
    // 暫停是這一輪自己的工具寫的，不是人在外面按的：那一輪把模型的收尾那句也講完，正常收。
    expect(startKinds(rig.pump.sessionLog)).toEqual(['message']);
    expect(endKinds(rig.pump.sessionLog)).toEqual(['done']);
    expect(rig.state.prompts).toHaveLength(2);
    await rig.stop();
  });

  it('F 一輪跑著、後面排著人類輸入：暫停中止這一輪，排著的保留但停住，下一次送出才照順序跑', async () => {
    const rig = await build({
      turns: [SLOW, { content: '第二句的回覆。' }, { content: '第三句的回覆。' }],
      threadId: 'pause-f',
    });
    const first = rig.pump.submit({ kind: 'message', text: '第一句' });
    await until(() => rig.pump.running, '第一句開跑');
    rig.service?.create({ objective: '把 CI 修綠', maxGoalRounds: 5 });
    const second = rig.pump.submit({ kind: 'message', text: '第二句' });
    await until(() => rig.pump.inbox.length === 1, '第二句排進佇列');

    rig.service?.pause(refOf(rig));
    await first;
    await settle(rig.pump);

    // 第一輪以 aborted 收；第二句還在佇列裡、沒有被叫醒（同停止鈕的 keepInbox）。
    expect(endKinds(rig.pump.sessionLog)).toEqual(['aborted']);
    expect(startKinds(rig.pump.sessionLog)).toEqual(['message']);
    expect(rig.pump.inbox).toHaveLength(1);

    // 下一次送出才照先進先出：第二句，再第三句。
    await rig.pump.submit({ kind: 'message', text: '第三句' });
    await second;
    await settle(rig.pump);
    expect(startKinds(rig.pump.sessionLog)).toEqual(['message', 'message', 'message']);
    expect(rig.pump.inbox).toHaveLength(0);
    // 暫停沒有被後面的人類輸入翻掉。
    expect(rig.service?.get()?.phase).toBe('paused');
    await rig.stop();
  });

  it('(ii) 輪內排的計時器在下一輪才觸發、呼叫服務下暫停：算人下的，中止下一輪', async () => {
    // 計時器是在第一輪（人打的那輪）裡排的，帶著那一輪的 async 身分；它輪詢到續行輪開跑才動手。
    // 比的是「這一輪的身分」：只問「有沒有身分」會把它誤判成模型自己下的，那一輪就不會被中止。
    const hooks: { rig?: Rig } = {};
    const armTimer = tool(
      () => {
        const tick = (): void => {
          const rig = hooks.rig;
          if (
            rig !== undefined &&
            startKinds(rig.pump.sessionLog).length >= 2 &&
            rig.pump.running
          ) {
            rig.service?.pause(refOf(rig));
            return;
          }
          setTimeout(tick, 5);
        };
        setTimeout(tick, 1);
        return '計時器排好了。';
      },
      { name: 'arm_timer', description: '排一個計時器。', schema: z.object({}) },
    );
    const rig = await build({
      turns: [
        {
          content: '',
          toolCalls: [
            { name: 'create_goal', args: { objective: '把 CI 修綠', max_goal_rounds: 1 } },
            { name: 'arm_timer', args: {} },
          ],
        },
        { content: '建好了。' },
        SLOW,
      ],
      threadId: 'pause-ii',
      extraPlugins: [
        { plugin: { name: 'pause-timer-fixture', apply: (r) => void r.tools.register(armTimer) } },
      ],
    });
    hooks.rig = rig;
    await rig.pump.submit({ kind: 'message', text: '把 CI 修綠' });
    await settle(rig.pump);

    expect(startKinds(rig.pump.sessionLog)).toEqual(['message', 'goal']);
    expect(endKinds(rig.pump.sessionLog)).toEqual(['done', 'aborted']);
    expect(rig.service?.get()?.phase).toBe('paused');
    await rig.stop();
  });

  it('別條 thread 的輪裡下的暫停打在這條 thread：算人下的，中止這條在跑的那一輪', async () => {
    // 身分是模組層級共用的：X 的輪內鏈寫 Y 的目標，Y 看到的身分是 X 的那一輪，不是 Y 自己的。
    const target = await build({
      turns: [SLOW, SLOW],
      threadId: 'pause-other-target',
    });
    target.service?.create({ objective: '把 CI 修綠', maxGoalRounds: 5 });
    await until(() => target.pump.running, 'Y 的續行輪開跑');
    const pauseOther = tool(
      () => {
        target.service?.pause(refOf(target));
        return '已暫停。';
      },
      { name: 'pause_other', description: '暫停另一條 thread 的目標。', schema: z.object({}) },
    );
    const source = await build({
      turns: [{ content: '', toolCalls: [{ name: 'pause_other', args: {} }] }, { content: '好。' }],
      threadId: 'pause-other-source',
      extraPlugins: [
        {
          plugin: { name: 'pause-other-fixture', apply: (r) => void r.tools.register(pauseOther) },
        },
      ],
    });
    await source.pump.submit({ kind: 'message', text: '去暫停它' });
    await settle(target.pump);

    expect(endKinds(source.pump.sessionLog)).toEqual(['done']);
    expect(endKinds(target.pump.sessionLog)).toEqual(['aborted']);
    expect(target.service?.get()?.phase).toBe('paused');
    await source.stop();
    await target.stop();
  });

  it('停在核准點：人暫停 ＝ 收回那一輪（withdrawn），不再有續行', async () => {
    // dsh 的 agent 停在核准點時 `status` 是 running，所以 `goal/changed{pause}` 一樣走 `agent.cancel`；我們的對應是停止鈕的「收回」那一支。
    const note = tool(({ text }: { text: string }) => `已記下：${text}`, {
      name: 'take_note',
      description: '把一段文字記下來。',
      schema: z.object({ text: z.string() }),
    });
    const gated: PluginEntry = {
      plugin: {
        name: 'pause-approval-fixture',
        apply(registration) {
          registration.tools.register(note);
          registration.approvals.gate((execution, next) =>
            execution.name === 'take_note' ? { kind: 'ask', reason: '看一下' } : next(),
          );
        },
      },
    };
    const rig = await build({
      turns: [
        {
          content: '',
          toolCalls: [
            { name: 'create_goal', args: { objective: '把 CI 修綠', max_goal_rounds: 5 } },
          ],
        },
        { content: '建好了。' },
        { content: '', toolCalls: [{ name: 'take_note', args: { text: '先記一下' } }] },
        { content: '不該被讀到。' },
      ],
      threadId: 'pause-approval',
      extraPlugins: [gated],
    });
    await rig.pump.submit({ kind: 'message', text: '把 CI 修綠' });
    for (let tries = 0; tries < 50 && !rig.pump.awaitingInput; tries += 1) await settle(rig.pump);
    expect(rig.pump.awaitingInput).toBe(true);

    rig.service?.pause(refOf(rig));
    await settle(rig.pump);

    expect(rig.pump.awaitingInput).toBe(false);
    expect(rig.service?.get()?.phase).toBe('paused');
    // 沒有再叫模型：那句「不該被讀到」沒被讀。
    expect(rig.state.prompts).toHaveLength(3);
    expect(startKinds(rig.pump.sessionLog).filter((kind) => kind === 'goal')).toEqual(['goal']);
    await rig.stop();
  });

  it('暫停落在 flush 縫裡（決定了、還沒排）：不用中止什麼，第二次決定把它擋下，沒有新的一輪', async () => {
    // 這一縫裡 `running` 是假的，所以人下的暫停沒有東西可中止；#1516 卡的第 4 節量過：停止鈕（`cancel()`）落在這一縫是 no-op（回 `idle`，
    // 續行照排），而暫停不一樣——它改的是目標的相位，排程器 flush 回來之後的第二次決定看到 paused 就收手。
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rig = await build({ turns: [SLOW], threadId: 'pause-flush-seam', flush: () => held });
    rig.service?.create({ objective: '把 CI 修綠', maxGoalRounds: 5 });
    await until(() => rig.pump.goalRoundInFlight, '排程器問到 flush');
    expect(rig.pump.running).toBe(false);

    const cancel = vi.spyOn(rig.pump, 'cancel');
    rig.service?.pause(refOf(rig));
    release();
    await settle(rig.pump);

    expect(cancel).not.toHaveBeenCalled();
    expect(startKinds(rig.pump.sessionLog)).toEqual([]);
    expect(rig.state.prompts).toHaveLength(0);
    expect(rig.service?.get()?.phase).toBe('paused');
    await rig.stop();
  });
});

describe('中止之後 resume 要自己續上（#1516 帶出來的主流程）', () => {
  /**
   * 以前暫停只落在兩輪之間，日誌上不會留下 aborted 的一輪；現在人下的暫停一定中止在跑的那一輪，
   * 「暫停 → 恢復」每次都會經過「最後一顆 `turn/end` 是 aborted」。`turnClosed` 只看最後一顆，
   * resume 剛武裝就被 driver 看到 `turn-aborted` 又收回，續行輪不會自己開跑。
   * dsh 的收回發生在 `turn/end` 當下（`goal-round-driver/src/index.ts:353-357`），之後的 resume 不受影響。
   */
  it('G 續行輪跑著被暫停（aborted）→ /goal resume：自己排出下一個續行輪', async () => {
    const rig = await build({ turns: [SLOW, { content: '續上了。' }], threadId: 'resume-g' });
    rig.service?.create({ objective: '把 CI 修綠', maxGoalRounds: 2 });
    await until(() => rig.pump.running, '續行輪開跑');

    rig.service?.pause(refOf(rig));
    await settle(rig.pump);
    expect(endKinds(rig.pump.sessionLog)).toEqual(['aborted']);
    expect(rig.service?.get()?.phase).toBe('paused');

    rig.service?.resume(refOf(rig));
    await settle(rig.pump);

    expect(startKinds(rig.pump.sessionLog)).toEqual(['goal', 'goal']);
    expect(endKinds(rig.pump.sessionLog)).toEqual(['aborted', 'done']);
    await rig.stop();
  });

  it('H 人按停止（續行輪 aborted）→ /goal resume：同樣自己續上', async () => {
    const rig = await build({ turns: [SLOW, { content: '續上了。' }], threadId: 'resume-h' });
    rig.service?.create({ objective: '把 CI 修綠', maxGoalRounds: 2 });
    await until(() => rig.pump.running, '續行輪開跑');

    rig.pump.cancel();
    await settle(rig.pump);
    expect(endKinds(rig.pump.sessionLog)).toEqual(['aborted']);
    // 停止只收回授權，相位不動（#265 Q8）；沒有 resume 就不續行。
    expect(rig.service?.get()).toMatchObject({ phase: 'active', activation: 'disarmed' });
    expect(startKinds(rig.pump.sessionLog)).toEqual(['goal']);

    rig.service?.resume(refOf(rig));
    await settle(rig.pump);

    expect(startKinds(rig.pump.sessionLog)).toEqual(['goal', 'goal']);
    await rig.stop();
  });

  it('I 對照：aborted 之後沒有 resume（只是再說一句話），不續行', async () => {
    const rig = await build({ turns: [SLOW, { content: '收到。' }], threadId: 'resume-i' });
    rig.service?.create({ objective: '把 CI 修綠', maxGoalRounds: 5 });
    await until(() => rig.pump.running, '續行輪開跑');
    rig.pump.cancel();
    await settle(rig.pump);

    await rig.pump.submit({ kind: 'message', text: '隨便說一句' });
    await settle(rig.pump);

    expect(startKinds(rig.pump.sessionLog)).toEqual(['goal', 'message']);
    expect(rig.service?.get()).toMatchObject({ activation: 'disarmed' });
    await rig.stop();
  });
});

describe('停止鈕落在 flush 縫（決定了、還沒排）要停住目標（#1518）', () => {
  /** 一個攔得住的 flush：排程器問到它就停在那，測試動完手再放行。 */
  function gate() {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { held, release };
  }

  it('A 停止落在 flush 縫：之後沒有新的一輪，授權收回，相位仍是 active（#265 Q8）', async () => {
    const { held, release } = gate();
    const rig = await build({ turns: [SLOW, SLOW], threadId: 'stop-gap-a', flush: () => held });
    rig.service?.create({ objective: '把 CI 修綠', maxGoalRounds: 5 });
    await until(() => rig.pump.goalRoundInFlight, '排程器問到 flush');
    expect(rig.pump.running).toBe(false);
    expect(rig.service?.get()).toMatchObject({ phase: 'active', activation: 'armed' });

    expect(rig.pump.cancel()).toBe('drive');
    release();
    await settle(rig.pump);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(startKinds(rig.pump.sessionLog)).toEqual([]);
    expect(rig.state.prompts).toHaveLength(0);
    expect(rig.service?.get()).toMatchObject({ phase: 'active', activation: 'disarmed' });
    await rig.stop();
  });

  it('A2 停止落在 flush 縫之後，再 /goal resume：自己續上（resume 在這個縫裡沒有 aborted 收尾可撞）', async () => {
    const { held, release } = gate();
    const rig = await build({
      turns: [{ content: '續上了。' }],
      threadId: 'stop-gap-a2',
      flush: () => held,
    });
    rig.service?.create({ objective: '把 CI 修綠', maxGoalRounds: 1 });
    await until(() => rig.pump.goalRoundInFlight, '排程器問到 flush');
    rig.pump.cancel();
    release();
    await settle(rig.pump);
    expect(startKinds(rig.pump.sessionLog)).toEqual([]);

    rig.service?.resume(refOf(rig));
    await settle(rig.pump);

    expect(startKinds(rig.pump.sessionLog)).toEqual(['goal']);
    expect(endKinds(rig.pump.sessionLog)).toEqual(['done']);
    await rig.stop();
  });

  it('B 對照：停止落在一輪正在跑的時候，照舊——那一輪以 aborted 收，授權收回，相位不動', async () => {
    const rig = await build({ turns: [SLOW, SLOW], threadId: 'stop-gap-b' });
    rig.service?.create({ objective: '把 CI 修綠', maxGoalRounds: 5 });
    await until(() => rig.pump.running, '續行輪開跑');

    expect(rig.pump.cancel()).toBe('run');
    await settle(rig.pump);

    expect(endKinds(rig.pump.sessionLog)).toEqual(['aborted']);
    expect(startKinds(rig.pump.sessionLog)).toEqual(['goal']);
    expect(rig.service?.get()).toMatchObject({ phase: 'active', activation: 'disarmed' });
    await rig.stop();
  });

  it('C 對照：真的閒著、沒有排程在飛時按停止，什麼都不做（授權不動）', async () => {
    const rig = await build({ turns: [SLOW], threadId: 'stop-gap-c' });
    rig.service?.create({ objective: '把 CI 修綠', maxGoalRounds: 1 });
    rig.service?.disarm();
    await settle(rig.pump);
    expect(rig.pump.goalRoundInFlight).toBe(false);
    rig.service?.resume(refOf(rig));
    // resume 之後排程器馬上起跑；等那一輪排完收完，閒著再按。
    await settle(rig.pump);
    expect(rig.pump.goalRoundInFlight).toBe(false);

    expect(rig.pump.cancel()).toBe('idle');
    await rig.stop();
  });

  it('D 停止落在第二次決定讀視圖的那一刻：第二次決定照樣回「排」，預約排進去，但領走時授權已收回，不跑、不暫停', async () => {
    // 排程器讀第二次視圖的那一刻按停止：這份視圖還是 armed，第二次決定不會知道剛剛被停；擋住它的是領走時的驗證。
    const held: { rig?: Rig } = {};
    const rig = await build({
      turns: [SLOW],
      threadId: 'stop-gap-d',
      onGoalRead: (nth) => {
        if (nth === 2) expect(held.rig?.pump.cancel()).toBe('drive');
      },
    });
    held.rig = rig;
    rig.service?.create({ objective: '把 CI 修綠', maxGoalRounds: 5 });
    await until(() => rig.service?.get()?.activation === 'disarmed', '停止落下');
    await settle(rig.pump);

    expect(startKinds(rig.pump.sessionLog)).toEqual([]);
    expect(rig.service?.get()).toMatchObject({ phase: 'active', activation: 'disarmed' });
    await rig.stop();
  });
});
