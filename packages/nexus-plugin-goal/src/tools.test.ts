/**
 * 三顆模型工具走**真的通道**：註冊表 → `sessions` 接線 → `forCall` → 服務 → 日誌。
 *
 * 刻意不直接叫 `createGoalTools`：這個套件宣稱「掛上去之後模型改得動同一份域狀態」，
 * 而那個宣稱裡最容易靜靜壞掉的是接線那一段（`forCall` 挑錯日誌、服務查不到）。
 *
 * **權限那一半的單元在 `authority.test.ts`**，走真 agent 的行為驗收在
 * `apps/harness/src/goal-tools.test.ts`——那一份才證得了核准恢復之後那一輪真的過得了。
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { StructuredTool } from '@langchain/core/tools';
import { Command } from '@langchain/langgraph';
import {
  createRegistry,
  createSessionRunner,
  GOAL_WRAPUP_MARKER,
  goalId,
  SessionRegistry,
} from '@nexus/core';
import type { NamedEntry, SessionLog } from '@nexus/core';

import { createGoalPlugin } from './index.js';
import type { GoalPluginOptions } from './index.js';
import { hasDirectHumanTurn } from './authority.js';
import { renderWrapupContext } from './wrapup.js';
import {
  GOAL_CREATE_TOOL_NAME,
  GOAL_GET_TOOL_NAME,
  GOAL_MODEL_REPORTED_CODE,
  GOAL_TOOL_AUTHORITY_MESSAGE,
  GOAL_TOOL_COMPLETION_AUTHORITY_MESSAGE,
  GOAL_TOOL_ERROR_PREFIX,
  GOAL_TOOL_INVALID_REF_MESSAGE,
  GOAL_TOOL_NO_SERVICE_MESSAGE,
  GOAL_TOOL_NOT_ATTACHED_MESSAGE,
  GOAL_TOOL_REASON_MISPLACED_MESSAGE,
  GOAL_TOOL_REASON_REQUIRED_MESSAGE,
  GOAL_TOOL_REPLACEMENT_MISPLACED_MESSAGE,
  GOAL_TOOL_UNKNOWN_CALLER_MESSAGE,
  GOAL_UPDATE_TOOL_NAME,
  goalToolBlockTooSoonMessage,
} from './tools.js';

/** root 的工具呼叫長這樣（`session-address.ts` 那張表的第一列）。 */
const ROOT_CALL = { configurable: { checkpoint_ns: 'tools:call-1' } };

/**
 * 一次組裝：註冊表 → 綁一張 `SessionRegistry` → 每一份會話各裝一次參與者。
 *
 * **`bind` 是 `forCall` 唯一的輸入**（`registry.ts` 的 `boundSessions`），所以照
 * `agent-factory.ts` 的 `attachSession` 抄同一組四行——少一行工具就一律回「沒接上」。
 */
function bench(options: GoalPluginOptions = {}): {
  log: SessionLog;
  sessions: SessionRegistry;
  registry: ReturnType<typeof createRegistry>;
  call: (name: string, args?: Record<string, unknown>, config?: unknown) => Promise<string>;
  raw: (name: string, args?: Record<string, unknown>, config?: unknown) => Promise<unknown>;
  tools: Map<string, NamedEntry<StructuredTool>>;
} {
  let serial = 0;
  const plugin = createGoalPlugin({
    now: () => 100,
    newGoalId: () => `goal-${(serial += 1)}`,
    ...options,
  });
  const registry = createRegistry();
  const exit = registry.enter({ id: 'goal#0', name: 'goal' });
  plugin.apply(registry);
  exit();
  const sessions = new SessionRegistry('goal');
  attach(registry, sessions);
  const tools = registry.tools.effective(undefined);
  let callSerial = 0;
  const raw = async (
    name: string,
    args: Record<string, unknown> = {},
    config: unknown = ROOT_CALL,
  ): Promise<unknown> => {
    const found = tools.get(name);
    if (found === undefined) throw new Error(`沒有這顆工具：${name}`);
    // **以 `ToolCall` 形式呼叫，不是素參數。** 產品路徑上的 tool node 一律走這一條，
    // 而 `update_goal` 的自主收尾要從 config 上拿 `tool_call_id` 才造得出工具結果——
    // 素參數那條路拿不到它，測到的會是一個產品裡不存在的形狀。
    const call = {
      name,
      args,
      id: `call-${(callSerial += 1)}`,
      type: 'tool_call' as const,
    };
    return found.value.invoke(call as never, config as never);
  };
  return {
    log: sessions.root,
    sessions,
    registry,
    tools,
    raw,
    call: async (name, args = {}, config = ROOT_CALL) => textOf(await raw(name, args, config)),
  };
}

/**
 * 一次呼叫回來的東西裡，模型看得到的那一段工具結果。
 *
 * 三種形狀：帶 id 呼叫時基座包成一則 `ToolMessage`；自主收尾回的是一顆 `Command`，
 * 工具結果在它的 `update.messages` 裡；其餘退回字串。
 *
 * @param result - `invoke` 回來的東西。
 * @returns 工具結果的原文。
 */
function textOf(result: unknown): string {
  if (ToolMessage.isInstance(result)) return String(result.content);
  const messages = commandMessages(result);
  if (messages !== undefined) {
    const found = messages.find((message) => ToolMessage.isInstance(message));
    if (found !== undefined) return String(found.content);
  }
  return String(result);
}

/** 一顆 `Command` 帶的訊息串，不是 `Command` 就當場失敗。 */
function messagesOf(result: unknown): BaseMessage[] {
  const messages = commandMessages(result);
  if (messages === undefined) throw new Error('這一次回的不是一顆帶訊息的 Command');
  return messages;
}

/** 一顆 `Command` 帶的訊息串；不是 `Command` 就是 `undefined`。 */
function commandMessages(result: unknown): BaseMessage[] | undefined {
  if (!(result instanceof Command)) return undefined;
  const update = result.update as { messages?: unknown } | undefined;
  return Array.isArray(update?.messages) ? (update.messages as BaseMessage[]) : undefined;
}

/** 照 `agent-factory.ts` 的 `attachSession`：綁註冊表，每一份會話各裝一次參與者。 */
function attach(registry: ReturnType<typeof createRegistry>, sessions: SessionRegistry): void {
  const installers = registry.sessions.installers();
  registry.sessions.bind(sessions);
  sessions.observe(({ address, log }) => {
    if (installers.length > 0) createSessionRunner({ address, log, installers });
  });
}

/** 記一顆人打的輪次。 */
function human(log: SessionLog, text = '把這件事做完'): void {
  log.append('turn/start', { kind: 'message', text });
}

/** 解出一次回傳的 JSON。 */
function parse(raw: string): { goal: unknown; activation?: unknown } {
  return JSON.parse(raw) as { goal: unknown; activation?: unknown };
}

/** 目前這一份的 CAS 兩格。 */
async function refOf(call: ReturnType<typeof bench>['call']): Promise<{
  goal_id: string;
  revision: number;
}> {
  const view = parse(await call(GOAL_GET_TOOL_NAME)).goal as { id: string; revision: number };
  return { goal_id: view.id, revision: view.revision };
}

describe('註冊', () => {
  it('三顆都在，而且都是 rootOnly——subagent 那一份拿到的是拒絕樁', () => {
    const { tools } = bench();
    expect([...tools.keys()].sort()).toEqual(
      [GOAL_CREATE_TOOL_NAME, GOAL_GET_TOOL_NAME, GOAL_UPDATE_TOOL_NAME].sort(),
    );
  });
});

describe('get_goal', () => {
  it('沒有目標時回 {"goal":null}，而且不要求任何權限', async () => {
    const { call } = bench();
    expect(await call(GOAL_GET_TOOL_NAME)).toBe('{"goal":null}');
  });

  it('有目標時把 id、revision 與相位一起交出去', async () => {
    const { call, log } = bench();
    human(log);
    await call(GOAL_CREATE_TOOL_NAME, { objective: '把 CI 修綠' });
    const value = parse(await call(GOAL_GET_TOOL_NAME));
    expect(value.goal).toMatchObject({
      id: 'goal-1',
      revision: 1,
      objective: '把 CI 修綠',
      phase: 'active',
      roundsStarted: 0,
    });
    expect(value.activation).toBe('armed');
  });
});

describe('create_goal', () => {
  it('人打過字就建得起來，而且域真的動了', async () => {
    const { call, log } = bench();
    human(log);
    const value = parse(await call(GOAL_CREATE_TOOL_NAME, { objective: '把 CI 修綠' }));
    expect(value.goal).toMatchObject({ objective: '把 CI 修綠', phase: 'active' });
    expect(log.events.filter((event) => event.type === 'goal/change')).toHaveLength(1);
  });

  /** **這一條是權限那半在工具上的守衛**：日誌裡沒有人類輪次，域一格都不准動。 */
  it('這一輪追不到人類訊息就拒絕，而且什麼都沒寫', async () => {
    const { call, log } = bench();
    expect(await call(GOAL_CREATE_TOOL_NAME, { objective: '偷偷來' })).toBe(
      GOAL_TOOL_ERROR_PREFIX + GOAL_TOOL_AUTHORITY_MESSAGE,
    );
    expect(log.events).toEqual([]);
  });

  it('max_goal_rounds 給了就用它', async () => {
    const { call, log } = bench();
    human(log);
    const value = parse(
      await call(GOAL_CREATE_TOOL_NAME, { objective: '長跑', max_goal_rounds: 12 }),
    );
    expect(value.goal).toMatchObject({ maxGoalRounds: 12 });
  });

  /**
   * **這是 [#188](https://github.com/DemianLi/nexus-agent/issues/188) 拍板的絆索，
   * 釘的是「形狀」與「不勸」兩件事。**
   *
   * 形狀：維持 `optional`。改必填的話，`round-limit` 會在每個目標上綁定，而目標自己那個
   * 數字是**模型填的**（`service.ts` 的 `??` 不是 `Math.min`），等於把停損交回給模型——
   * `goal-driver.ts` 檔頭反對的正是這件事。
   *
   * 不勸：說明**逐字**照 dsh。字串刻意在這裡再打一次而不是 import 常數——要動它的人
   * 得兩邊一起動，那一刻才會撞到上面那個理由。三跑實測見拍板留言。
   */
  it('max_goal_rounds 維持選填，說明與標準逐字相同', () => {
    const { tools } = bench();
    const schema = tools.get(GOAL_CREATE_TOOL_NAME)?.value.schema as z.ZodObject<z.ZodRawShape>;
    const shape = schema.shape as Record<string, z.ZodType>;
    expect(shape['max_goal_rounds']?.description).toBe(
      'Optional positive safe-integer limit on automatic continuation rounds.',
    );
    expect(shape['max_goal_rounds']?.isOptional()).toBe(true);
    expect(shape['objective']?.isOptional()).toBe(false);
  });

  it('域的拒絕（已經有一個沒完成的目標）變成一句話，不是拋', async () => {
    const { call, log } = bench();
    human(log);
    await call(GOAL_CREATE_TOOL_NAME, { objective: '第一個' });
    const second = await call(GOAL_CREATE_TOOL_NAME, { objective: '第二個' });
    expect(second.startsWith(GOAL_TOOL_ERROR_PREFIX)).toBe(true);
    expect(second).toContain('已經存在');
  });
});

describe('update_goal', () => {
  it('照抄 get_goal 的兩格就改得動敘述', async () => {
    const { call, log } = bench();
    human(log);
    await call(GOAL_CREATE_TOOL_NAME, { objective: '舊的' });
    const ref = await refOf(call);
    const value = parse(
      await call(GOAL_UPDATE_TOOL_NAME, { ...ref, action: 'edit', objective: '新的' }),
    );
    expect(value.goal).toMatchObject({ objective: '新的', revision: 2, phase: 'active' });
  });

  /** CAS 是這顆工具的重點：拿舊的 revision 打就該被擋，而且目標一字不動。 */
  it('過期的 revision 被擋，目標維持原樣', async () => {
    const { call, log } = bench();
    human(log);
    await call(GOAL_CREATE_TOOL_NAME, { objective: '原本的' });
    const stale = await refOf(call);
    await call(GOAL_UPDATE_TOOL_NAME, { ...stale, action: 'edit', objective: '改一次' });
    const rejected = await call(GOAL_UPDATE_TOOL_NAME, {
      ...stale,
      action: 'edit',
      objective: '再改一次',
    });
    expect(rejected.startsWith(GOAL_TOOL_ERROR_PREFIX)).toBe(true);
    expect(parse(await call(GOAL_GET_TOOL_NAME)).goal).toMatchObject({
      objective: '改一次',
      revision: 2,
    });
  });

  it('pause 與 resume 走得通', async () => {
    const { call, log } = bench();
    human(log);
    await call(GOAL_CREATE_TOOL_NAME, { objective: '暫停看看' });
    const paused = parse(
      await call(GOAL_UPDATE_TOOL_NAME, { ...(await refOf(call)), action: 'pause' }),
    );
    expect(paused.goal).toMatchObject({ phase: 'paused' });
    expect(paused.activation).toBe('disarmed');
    const resumed = parse(
      await call(GOAL_UPDATE_TOOL_NAME, { ...(await refOf(call)), action: 'resume' }),
    );
    expect(resumed.goal).toMatchObject({ phase: 'active' });
    expect(resumed.activation).toBe('armed');
  });

  it('complete 走得通', async () => {
    const { call, log } = bench();
    human(log);
    await call(GOAL_CREATE_TOOL_NAME, { objective: '做完它' });
    const done = parse(
      await call(GOAL_UPDATE_TOOL_NAME, { ...(await refOf(call)), action: 'complete' }),
    );
    expect(done.goal).toMatchObject({ phase: 'complete' });
  });

  /**
   * **blocked 沒有輪次門檻**，因為沒有輪次可數（`tools.ts` 檔頭第 2 列）。dsh 那側要
   * 連續 3 個 goal round，我們這裡人直接說「擋住了」就擋得住。
   */
  it('blocked 帶理由就擋得住，理由用 model-reported 落庫', async () => {
    const { call, log } = bench();
    human(log);
    await call(GOAL_CREATE_TOOL_NAME, { objective: '擋住的' });
    const value = parse(
      await call(GOAL_UPDATE_TOOL_NAME, {
        ...(await refOf(call)),
        action: 'blocked',
        blocked_reason: '拿不到測試環境的憑證',
      }),
    );
    expect(value.goal).toMatchObject({
      phase: 'blocked',
      blockedReason: { code: GOAL_MODEL_REPORTED_CODE, message: '拿不到測試環境的憑證' },
    });
  });

  it('blocked 沒帶理由被擋', async () => {
    const { call, log } = bench();
    human(log);
    await call(GOAL_CREATE_TOOL_NAME, { objective: 'x' });
    expect(await call(GOAL_UPDATE_TOOL_NAME, { ...(await refOf(call)), action: 'blocked' })).toBe(
      GOAL_TOOL_ERROR_PREFIX + GOAL_TOOL_REASON_REQUIRED_MESSAGE,
    );
  });

  it('replacement 配在 edit 以外的 action 上被擋', async () => {
    const { call, log } = bench();
    human(log);
    await call(GOAL_CREATE_TOOL_NAME, { objective: 'x' });
    expect(
      await call(GOAL_UPDATE_TOOL_NAME, {
        ...(await refOf(call)),
        action: 'pause',
        objective: '順便改一下',
      }),
    ).toBe(GOAL_TOOL_ERROR_PREFIX + GOAL_TOOL_REPLACEMENT_MISPLACED_MESSAGE);
  });

  it('blocked_reason 配在 blocked 以外的 action 上被擋', async () => {
    const { call, log } = bench();
    human(log);
    await call(GOAL_CREATE_TOOL_NAME, { objective: 'x' });
    expect(
      await call(GOAL_UPDATE_TOOL_NAME, {
        ...(await refOf(call)),
        action: 'complete',
        blocked_reason: '順便講一下',
      }),
    ).toBe(GOAL_TOOL_ERROR_PREFIX + GOAL_TOOL_REASON_MISPLACED_MESSAGE);
  });

  it('goal_id 空的或 revision 是 0 都被擋', async () => {
    const { call, log } = bench();
    human(log);
    expect(await call(GOAL_UPDATE_TOOL_NAME, { goal_id: '', revision: 1, action: 'pause' })).toBe(
      GOAL_TOOL_ERROR_PREFIX + GOAL_TOOL_INVALID_REF_MESSAGE,
    );
    expect(await call(GOAL_UPDATE_TOOL_NAME, { goal_id: 'g', revision: 0, action: 'pause' })).toBe(
      GOAL_TOOL_ERROR_PREFIX + GOAL_TOOL_INVALID_REF_MESSAGE,
    );
  });

  it('沒有任何授權時，每一個 action 都被擋——而拒絕的話說得出缺的是哪一種', async () => {
    const { call } = bench();
    // 四個一律要人。
    for (const action of ['edit', 'pause', 'resume']) {
      expect(await call(GOAL_UPDATE_TOOL_NAME, { goal_id: 'goal-1', revision: 1, action })).toBe(
        GOAL_TOOL_ERROR_PREFIX + GOAL_TOOL_AUTHORITY_MESSAGE,
      );
    }
    // 這兩個另外收得下當前續行輪次，所以拒絕時要把那條路也講出來。
    for (const action of ['complete', 'blocked']) {
      expect(await call(GOAL_UPDATE_TOOL_NAME, { goal_id: 'goal-1', revision: 1, action })).toBe(
        GOAL_TOOL_ERROR_PREFIX + GOAL_TOOL_COMPLETION_AUTHORITY_MESSAGE,
      );
    }
  });
});

/**
 * **這一組是這張卡開的那條新授權路徑的驗收句。**
 *
 * 每一條都從「人建了一個目標」開始，然後手動排一顆續行輪次進日誌——沒有排程器在場，
 * 因為授權讀的是日誌不是排程器。
 */
describe('在續行輪次裡', () => {
  /** 排一輪：`turn/end` 收掉人那一輪，然後 append 一顆 goal 來源的頭。 */
  function admit(log: SessionLog, ref: { goal_id: string; revision: number }, round: number): void {
    log.append('turn/end', {});
    log.append('turn/start', {
      kind: 'goal',
      text: `<goal_round>第 ${round} 輪`,
      goalId: goalId(ref.goal_id),
      revision: ref.revision,
      round,
    });
  }

  /** 人建一個目標，然後排到第 `upto` 輪。 */
  async function upto(
    bench_: ReturnType<typeof bench>,
    upto_: number,
  ): Promise<{ goal_id: string; revision: number }> {
    human(bench_.log);
    await bench_.call(GOAL_CREATE_TOOL_NAME, { objective: '把 CI 修綠' });
    const ref = await refOf(bench_.call);
    for (let round = 1; round <= upto_; round += 1) admit(bench_.log, ref, round);
    return ref;
  }

  /**
   * **這一條是整張卡在防的那件事。** 一個自己排得出輪次的模型若也能 `create`／`edit`，
   * 它就能改寫自己要達成的東西——而 `complete` 只是承認一件已經發生的事。
   */
  it('create 與 edit 照樣要人——模型改不動自己的目標', async () => {
    const b = bench();
    const ref = await upto(b, 1);
    expect(await b.call(GOAL_CREATE_TOOL_NAME, { objective: '換一個' })).toBe(
      GOAL_TOOL_ERROR_PREFIX + GOAL_TOOL_AUTHORITY_MESSAGE,
    );
    for (const action of ['edit', 'pause', 'resume']) {
      expect(
        await b.call(GOAL_UPDATE_TOOL_NAME, {
          ...ref,
          action,
          ...(action === 'edit' ? { objective: '換一個' } : {}),
        }),
      ).toBe(GOAL_TOOL_ERROR_PREFIX + GOAL_TOOL_AUTHORITY_MESSAGE);
    }
  });

  it('complete 過得去——這是 goal-round 授權存在的理由', async () => {
    const b = bench();
    const ref = await upto(b, 1);
    const value = parse(await b.call(GOAL_UPDATE_TOOL_NAME, { ...ref, action: 'complete' }));
    expect(value.goal).toMatchObject({ phase: 'complete' });
  });

  /**
   * **收尾指示的驗收句：模型收到的那一則，逐字就是 `renderWrapupContext` 算出來的。**
   *
   * 「有一則訊息」不夠——一個把工具結果重複貼一次的實作也過得了。所以逐字比對，並且
   * 一併釘住 `tool_call_id`：漏掉它的話模型會看到一顆沒有結果的工具呼叫，有些 provider
   * 直接拒，而那是單元測試綠著、真跑就死的形狀。
   */
  it('complete 之後注入收尾指示，工具結果與指示各一則', async () => {
    const b = bench();
    const ref = await upto(b, 1);
    const result = await b.raw(GOAL_UPDATE_TOOL_NAME, { ...ref, action: 'complete' });
    const messages = messagesOf(result);
    expect(messages).toHaveLength(2);
    const [toolResult, wrapup] = messages;
    expect(ToolMessage.isInstance(toolResult)).toBe(true);
    // `call-3` 是這一次 `update_goal` 的序號（前面 create 與 get 各用掉一個）——
    // 寫死的 id 或別一次呼叫的 id 都對不上這一格。
    expect((toolResult as ToolMessage).tool_call_id).toBe('call-3');
    expect(parse(String(toolResult?.content)).goal).toMatchObject({ phase: 'complete' });
    expect(String(wrapup?.content)).toBe(renderWrapupContext('把 CI 修綠'));
    expect(wrapup?.additional_kwargs[GOAL_WRAPUP_MARKER]).toEqual({ action: 'complete' });
  });

  it('blocked 的收尾指示帶著模型自己報的那句話', async () => {
    const b = bench();
    const ref = await upto(b, 3);
    const result = await b.raw(GOAL_UPDATE_TOOL_NAME, {
      ...ref,
      action: 'blocked',
      blocked_reason: '缺憑證',
    });
    const messages = messagesOf(result);
    expect(String(messages[1]?.content)).toBe(renderWrapupContext('把 CI 修綠', '缺憑證'));
    expect(messages[1]?.additional_kwargs[GOAL_WRAPUP_MARKER]).toEqual({ action: 'blocked' });
  });

  /**
   * **人打的 `complete` 不注入。** 人自己知道自己剛做了什麼，而且那一輪本來就該由人
   * 決定下一步（dsh 的 `index.ts:312` 同此）。
   *
   * 把注入條件寫成「action 是 complete／blocked」而不看授權的話，這一條會紅。
   */
  it('人打的 complete 不注入收尾指示', async () => {
    const b = bench();
    human(b.log);
    await b.call(GOAL_CREATE_TOOL_NAME, { objective: '人自己收' });
    const ref = await refOf(b.call);
    const result = await b.raw(GOAL_UPDATE_TOOL_NAME, { ...ref, action: 'complete' });
    expect(result).not.toBeInstanceOf(Command);
    expect(ToolMessage.isInstance(result)).toBe(true);
  });

  /** 被擋下來的那一次**什麼都沒收掉**，所以也沒有收尾可言。 */
  it('太早報 blocked 被擋時不注入收尾指示', async () => {
    const b = bench();
    const ref = await upto(b, 1);
    const result = await b.raw(GOAL_UPDATE_TOOL_NAME, {
      ...ref,
      action: 'blocked',
      blocked_reason: '卡住',
    });
    expect(result).not.toBeInstanceOf(Command);
  });

  /**
   * **收尾指示不進會話日誌，所以它借不到人類授權。**
   *
   * 這是 [#180](https://github.com/DemianLi/nexus-agent/issues/180) 關掉的那個洞的反面：
   * 那張卡在防「機器自己排的一輪在日誌上跟人打的一模一樣」。收尾指示是一則長得像人講
   * 的話的 `HumanMessage`，而三個授權判準（`hasDirectHumanTurn`、`isMatchingGoalRound`、
   * `hasUnansweredInterrupt`）**全部讀會話日誌，一個都不讀圖上的訊息**——今天成立是因為
   * 這兩個載體剛好分開，而沒有任何東西釘住它。這一條就是那顆釘子。
   *
   * 把收尾指示也 append 成一顆 `turn/start` 的實作會讓這裡紅。
   */
  it('收尾指示只進圖裡，會話日誌上一顆新輪次都沒有', async () => {
    const b = bench();
    const ref = await upto(b, 1);
    const before = b.log.events.length;
    const result = await b.raw(GOAL_UPDATE_TOOL_NAME, { ...ref, action: 'complete' });
    // 先確認這一次真的注入了，不然下面兩句對一個什麼都沒做的呼叫也成立。
    expect(messagesOf(result)).toHaveLength(2);
    expect(b.log.events.slice(before).map((event) => event.type)).toEqual(['goal/change']);
    expect(hasDirectHumanTurn(b.log.events)).toBe(false);
  });

  it('第 1 輪報 blocked 太早——門檻預設 3', async () => {
    const b = bench();
    const ref = await upto(b, 1);
    expect(
      await b.call(GOAL_UPDATE_TOOL_NAME, { ...ref, action: 'blocked', blocked_reason: '卡住' }),
    ).toBe(GOAL_TOOL_ERROR_PREFIX + goalToolBlockTooSoonMessage(3, 1));
  });

  it('撐到第 3 輪就過得去', async () => {
    const b = bench();
    const ref = await upto(b, 3);
    const value = parse(
      await b.call(GOAL_UPDATE_TOOL_NAME, { ...ref, action: 'blocked', blocked_reason: '缺憑證' }),
    );
    expect(value.goal).toMatchObject({ phase: 'blocked' });
  });

  it('門檻換得掉', async () => {
    const b = bench({ blockedAfterConsecutiveRounds: 1 });
    const ref = await upto(b, 1);
    const value = parse(
      await b.call(GOAL_UPDATE_TOOL_NAME, { ...ref, action: 'blocked', blocked_reason: '缺憑證' }),
    );
    expect(value.goal).toMatchObject({ phase: 'blocked' });
  });

  /**
   * **門檻只管 `goal-round` 那條路。** 人不需要向自己證明卡了三輪——dsh 明說「人類直接
   * 請求可以立即停止 goal」。把門檻套到 direct-human 上的話這一條會紅。
   */
  it('人一句話就 blocked 得了，門檻不管人', async () => {
    const b = bench();
    human(b.log);
    await b.call(GOAL_CREATE_TOOL_NAME, { objective: '把 CI 修綠' });
    const ref = await refOf(b.call);
    const value = parse(
      await b.call(GOAL_UPDATE_TOOL_NAME, { ...ref, action: 'blocked', blocked_reason: '缺憑證' }),
    );
    expect(value.goal).toMatchObject({ phase: 'blocked' });
  });

  it('門檻不是正整數的話，建 plugin 當場拋', () => {
    expect(() => createGoalPlugin({ blockedAfterConsecutiveRounds: 0 })).toThrow(
      /blockedAfterConsecutiveRounds 必須是正的安全整數/u,
    );
    expect(() => createGoalPlugin({ blockedAfterConsecutiveRounds: 1.5 })).toThrow(TypeError);
  });

  /** 說明文字**是算出來的**：門檻換掉，模型讀到的數字要跟著換。 */
  it('update_goal 的說明帶得出這一次的門檻', () => {
    const { tools } = bench({ blockedAfterConsecutiveRounds: 7 });
    const description = tools.get(GOAL_UPDATE_TOOL_NAME)?.value.description ?? '';
    expect(description).toContain('at least 7 consecutive rounds');
  });
});

describe('接線說得出原因', () => {
  it('認不出呼叫者', async () => {
    const { call } = bench();
    expect(await call(GOAL_GET_TOOL_NAME, {}, { configurable: {} })).toBe(
      GOAL_TOOL_ERROR_PREFIX + GOAL_TOOL_UNKNOWN_CALLER_MESSAGE,
    );
  });

  it('這次組裝沒接會話日誌', async () => {
    const plugin = createGoalPlugin();
    const registry = createRegistry();
    const exit = registry.enter({ id: 'goal#0', name: 'goal' });
    plugin.apply(registry);
    exit();
    const found = registry.tools.effective(undefined).get(GOAL_GET_TOOL_NAME);
    expect(String(await found?.value.invoke({} as never, ROOT_CALL as never))).toBe(
      GOAL_TOOL_ERROR_PREFIX + GOAL_TOOL_NOT_ATTACHED_MESSAGE,
    );
  });

  /**
   * **subagent 那條路的字面版本。** 域只接 root，所以一份 subagent 日誌上本來就沒有服務。
   * 產品路徑到不了這裡（工具是 `rootOnly` 註冊的），釘住它是為了萬一那層沒了，這裡
   * **仍然 fail-closed**——回一句話，不是靜靜動到 root 的目標。
   */
  it('日誌在、但那一份上沒有 goal 域', async () => {
    const { sessions, tools } = bench();
    const log = sessions.open({ kind: 'subagent', runId: 'tools:spawn-1' });
    human(log);
    const found = tools.get(GOAL_CREATE_TOOL_NAME);
    const result = String(
      await found?.value.invoke(
        { objective: '偷偷來' } as never,
        {
          configurable: { checkpoint_ns: 'tools:spawn-1|tools:call-1' },
        } as never,
      ),
    );
    expect(result).toBe(GOAL_TOOL_ERROR_PREFIX + GOAL_TOOL_NO_SERVICE_MESSAGE);
    expect(log.events.filter((event) => event.type === 'goal/change')).toEqual([]);
  });
});
