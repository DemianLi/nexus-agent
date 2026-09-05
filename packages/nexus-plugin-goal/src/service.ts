/**
 * goal 域本身：**事件溯源的狀態、CAS 變更，與 process 內的續行授權**。
 *
 * 形狀照 dsh 的 `GoalService`（`packages/goal/goal/src/index.ts`，對讀日期 2026-09-01，
 * 版本 `0a53fb55bea101816fa226bb964ae2bed71c343b`）。
 *
 * ## 三個形狀差異，都不是偏離
 *
 * 1. **方法不帶 `agent`。** dsh 的每一個方法都是 `get(agent)` / `create(agent, …)`，
 *    因為它有 `AgentRegistry` 與 scoped layers，一個服務要服務很多個 agent。我們一次
 *    `createNexusAgent` 一份註冊表、一份會話日誌，一個服務**天生只綁一份日誌**（建構
 *    子收的就是那份日誌的 subject），那個參數沒有指涉對象。同 `registry.ts` 對
 *    `ScopedLayers` 的處理，寫在這裡是為了後面的人不要「還原」它。
 * 2. **`GOAL_AGENT_NOT_LIVE` 這個錯誤碼不在。** 它守的正是上面那個參數——dsh 的
 *    `assertLive` 擋的是「拿一個已經不在註冊表裡的 Agent 來呼叫」。參數沒了，那個碼就
 *    沒有生產者，留著等於留一個永遠拋不出來的分類。**是缺，不是省略**：驅動器或多
 *    agent 那一天真的來了，它跟著那個參數一起回來。
 * 3. **狀態不走投影註冊表。** dsh 的 `applyGoalProjection` 跑在 `sessionProjections`
 *    裡，帶 `stateVersion` 與 `wire.view`；我們沒有投影子系統，折疊持在這個物件的私有
 *    欄位上，由 {@link ../../nexus-core/src/sessions.ts | sessions 通道} 的 `observe()`
 *    推進——安裝當下會重播日誌裡已有的事件，所以接上一份有內容的日誌折得出同一個答案。
 *
 * ## 折疊壞掉要扣住，不能靠拋
 *
 * 觀察者跑在 `SessionLog` 的回呼裡，而那一層**會把拋出來的東西吞成一行 warn**（#99 刻意
 * 的）。所以一顆解不開的 `goal/change` 如果只是讓觀察者拋，換來的是：日誌往前走、折疊
 * 停在原地、兩邊悄悄分岔，而外面看到的只有一行 warn。dsh 那側是 `applyGoalProjection`
 * 接住並把第一次失敗寫進 `failure`，`state()` 在 `failure` 不是 null 時拋——我們照抄那個
 * 形狀：{@link GoalService} 自己接住、扣住理由，**之後每一次讀與每一次變更都拒絕**。
 *
 * 另一半在配套入口（`./invariant.ts`）：那條路會**大聲報違規**。兩個機制不重複——這裡
 * 保證「壞掉之後不會給出錯的答案」，那裡保證「壞掉這件事有人講」。
 *
 * @module
 */

import { randomUUID } from 'node:crypto';

import { GOAL_CHANGE_VERSION, goalId } from '@nexus/core';
import type {
  GoalBlockReason,
  GoalChangeMeta,
  GoalClearChangeMeta,
  GoalOperation,
  GoalPhase,
  GoalRef,
  GoalSnapshot,
  GoalSnapshotChangeMeta,
  SessionEvent,
  SessionLog,
  SessionSubject,
} from '@nexus/core';
import { applyGoalEvent, emptyGoalFoldState } from './fold.js';
import type { GoalFoldState } from './fold.js';

/**
 * 這個 process 准不准自動續行這個目標。**永遠不持久**。
 *
 * 它不進日誌是 dsh 刻意的：續行授權是「這個活著的行程被誰授權過」，重放一段歷史不該
 * 讓一個沒有人在的行程自己動起來。我們這一版連續行驅動器都沒有，所以它現在**沒有任何
 * 消費者**——它是給人看的「這個目標現在是不是待命狀態」，以及驅動器那張卡落地時的接口。
 */
export type GoalActivation = 'armed' | 'disarmed';

/**
 * 被拒絕的讀與變更的穩定分類。
 *
 * dsh 有九個，這裡八個——少的那個是 `GOAL_AGENT_NOT_LIVE`，理由見檔頭。
 */
export type GoalErrorCode =
  | 'GOAL_NOT_FOUND'
  | 'GOAL_ALREADY_EXISTS'
  | 'GOAL_STALE_REVISION'
  | 'GOAL_INVALID_OBJECTIVE'
  | 'GOAL_INVALID_MAX_ROUNDS'
  | 'GOAL_INVALID_BLOCK_REASON'
  | 'GOAL_INVALID_EDIT'
  | 'GOAL_INVALID_TRANSITION';

/**
 * 域邊界丟出來的**可預期拒絕**。
 *
 * 形狀照 {@link @nexus/core!InvariantError}：Error 子類別加一格穩定的 `code`。dsh 那側
 * 繼承的是 `HarnessError`，我們沒有那個共用基底。
 *
 * **它與「壞掉」不同**：`GOAL_STALE_REVISION` 是兩個人同時改一個目標的正常結果，不是
 * 誰的 bug。折疊壞掉那種丟的是裸 `Error`，讓上面的人分得出來。
 */
export class GoalError extends Error {
  /** 穩定的機器可讀分類。 */
  readonly code: GoalErrorCode;

  /**
   * @param message - 給人看的拒絕理由。
   * @param code - 穩定的分類。
   */
  constructor(message: string, code: GoalErrorCode) {
    super(message);
    this.name = 'GoalError';
    this.code = code;
  }
}

/** 目前的目標加上重放算出來的東西。 */
export interface GoalView extends GoalSnapshot {
  /** 已經開始的續行輪次。只有被準入的 `turn/start{kind:'goal'}` 推得動它，見 `fold.ts`。 */
  readonly roundsStarted: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** process 內的續行授權，不持久。 */
  readonly activation: GoalActivation;
}

/** 建一個目標要給的東西。 */
export interface CreateGoalRequest {
  readonly objective: string;
  /** 省略即 {@link GoalServiceOptions.defaultMaxGoalRounds}。 */
  readonly maxGoalRounds?: number;
}

/** 改一個目標的定義。**兩格至少要有一格**。 */
export interface EditGoalRequest {
  readonly objective?: string;
  readonly maxGoalRounds?: number;
}

/**
 * `maxGoalRounds` 沒指定時的預設，**照抄 dsh 的 256**。
 *
 * **它進耐久快照，所以是建立當下的那個值**，不是讀取當下的預設：改了這個常數不會追溯
 * 到既有的目標身上。消費它的是續行排程器（`apps/harness` 的 `goal-driver.ts`）——
 * 用完就記一顆 `round-limit` 的 blocker，而那是開著 `--goal-driver` 時**唯一的硬上限**。
 */
export const DEFAULT_MAX_GOAL_ROUNDS = 256;

/** 建服務時換得掉的東西。 */
export interface GoalServiceOptions {
  /** create 沒指定上限時用它。省略即 {@link DEFAULT_MAX_GOAL_ROUNDS}。 */
  readonly defaultMaxGoalRounds?: number;
  /**
   * 現在幾點。省略即 `Date.now`。
   *
   * 這是一道縫而不是直接叫 `Date.now()`，因為**時間戳進了耐久快照**，而折疊對它有
   * 規則（`updatedAt` 不得早於前一次）。要驗那些規則就得換得掉時鐘。
   */
  readonly now?: () => number;
  /** 新目標的 id 怎麼來。省略即 `goal-<randomUUID()>`。同上，換得掉才驗得了。 */
  readonly newGoalId?: () => string;
}

/**
 * 選項在**建 plugin 的時候**就驗。
 *
 * 理由是設定錯誤要炸在設定的地方：安裝期才驗的話，這一顆 `GoalError` 會被 `sessions`
 * 接線的圍堵吞成一行 warn（那道圍堵是對的——一個參與者壞掉不該扳倒 agent loop），
 * 而使用者得到的是一個安靜地沒有目標域的 agent。
 *
 * @param options - 未經檢查的選項。
 * @throws {@link GoalError} `defaultMaxGoalRounds` 不是正的安全整數。
 */
export function assertGoalServiceOptions(options: GoalServiceOptions): void {
  if (options.defaultMaxGoalRounds !== undefined) {
    resolveMaxGoalRounds(options.defaultMaxGoalRounds);
  }
}

function resolveMaxGoalRounds(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new GoalError('maxGoalRounds 必須是正的安全整數', 'GOAL_INVALID_MAX_ROUNDS');
  }
  return value;
}

function resolveObjective(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GoalError('goal 的 objective 必須是非空字串', 'GOAL_INVALID_OBJECTIVE');
  }
  return value.trim();
}

function resolveBlockReason(reason: GoalBlockReason): GoalBlockReason {
  const code: unknown = reason?.code;
  const message: unknown = reason?.message;
  if (
    typeof code !== 'string' ||
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(code) ||
    typeof message !== 'string' ||
    message.trim().length === 0
  ) {
    throw new GoalError(
      'goal 的 block 理由要一個 lower-kebab-case 的 code 與一句非空的 message',
      'GOAL_INVALID_BLOCK_REASON',
    );
  }
  return { code, message: message.trim() };
}

/**
 * 一份會話日誌一個。
 *
 * 建構子就把觀察者掛上去了——**服務與日誌同壽命**，不存在「還沒開始觀察」的狀態。
 */
export class GoalService {
  readonly #log: SessionLog;
  readonly #defaultMaxGoalRounds: number;
  readonly #now: () => number;
  readonly #newGoalId: () => string;
  #state: GoalFoldState = emptyGoalFoldState();
  /** 第一次重放失敗的理由，扣住之後不再往前折。 */
  #failure: string | undefined;
  #activation: GoalActivation = 'disarmed';
  /** 跨過同步 append 邊界的那一格：這一次變更**自己**要掛的授權。 */
  #pending: { readonly seq: number; readonly activation: GoalActivation } | undefined;

  /**
   * @param subject - 這一份日誌與它的觀察面，由 `sessions` 通道交過來。
   * @param options - 預設輪次上限、時鐘與 id 工廠。
   * @throws `defaultMaxGoalRounds` 不是正的安全整數。
   */
  constructor(subject: SessionSubject, options: GoalServiceOptions = {}) {
    this.#log = subject.log;
    this.#defaultMaxGoalRounds = resolveMaxGoalRounds(
      options.defaultMaxGoalRounds ?? DEFAULT_MAX_GOAL_ROUNDS,
    );
    this.#now = options.now ?? (() => Date.now());
    this.#newGoalId = options.newGoalId ?? (() => `goal-${randomUUID()}`);
    subject.observe((event) => {
      this.#observe(event);
    });
  }

  /**
   * 目前的目標。
   *
   * @returns 一份新的視圖，或沒有目前目標時的 `undefined`。
   * @throws 這份日誌的 goal 串已經重放失敗——見檔頭。
   */
  get(): GoalView | undefined {
    this.#requireHealthy();
    return this.#view();
  }

  /**
   * 收回 process 內的續行授權，**不動耐久的相位與修訂號**。
   *
   * 卸載驅動器的人在卸載前呼叫它；之後要再續行，走的是一次有人授權的 {@link resume}。
   *
   * @returns 收回之後的視圖，或沒有目前目標時的 `undefined`。
   */
  disarm(): GoalView | undefined {
    this.#requireHealthy();
    this.#activation = 'disarmed';
    return this.#view();
  }

  /**
   * 建一個目標並掛上續行授權。
   *
   * **完成掉的目標可以直接被取代**，其他相位一律要先 clear 或 resume——不然「上一個
   * 還沒收尾」這件事會被靜靜蓋掉。
   *
   * @param request - 目標敘述與可選的輪次上限。
   * @returns 建好的視圖。
   * @throws {@link GoalError} 敘述空的、上限不合法，或已經有一個沒完成的目標。
   */
  create(request: CreateGoalRequest): GoalView {
    this.#requireHealthy();
    const objective = resolveObjective(request.objective);
    const maxGoalRounds = resolveMaxGoalRounds(request.maxGoalRounds ?? this.#defaultMaxGoalRounds);
    const current = this.#state.goal;
    if (current !== undefined && current.phase !== 'complete') {
      throw new GoalError(
        `目標 "${current.id}" 已經存在，相位是 "${current.phase}"`,
        'GOAL_ALREADY_EXISTS',
      );
    }
    const now = this.#now();
    const goal: GoalSnapshot = {
      id: goalId(this.#newGoalId()),
      revision: 1,
      objective,
      phase: 'active',
      maxGoalRounds,
    };
    return this.#commitSnapshot('create', goal, 0, now, now, 'armed');
  }

  /**
   * 改敘述與／或輪次上限，**不動相位**。
   *
   * @param ref - 預期的目前修訂號。
   * @param request - 至少一格替換值。
   * @returns 改完的視圖。
   * @throws {@link GoalError} ref 過期、沒有目前目標，或兩格都沒給。
   */
  edit(ref: GoalRef, request: EditGoalRequest): GoalView {
    const current = this.#expectCurrent(ref);
    if (request.objective === undefined && request.maxGoalRounds === undefined) {
      throw new GoalError('goal edit 至少要給 objective 或 maxGoalRounds', 'GOAL_INVALID_EDIT');
    }
    const goal: GoalSnapshot = {
      ...current,
      revision: current.revision + 1,
      ...(request.objective === undefined
        ? {}
        : { objective: resolveObjective(request.objective) }),
      ...(request.maxGoalRounds === undefined
        ? {}
        : { maxGoalRounds: resolveMaxGoalRounds(request.maxGoalRounds) }),
    };
    // edit 不碰授權：改一句敘述不該讓一個待命中的目標停下來，也不該讓停著的動起來。
    return this.#commitCurrent('edit', goal, this.#activation);
  }

  /**
   * 暫停一個 active 的目標並收回授權。
   *
   * @param ref - 預期的目前修訂號。
   * @returns 暫停之後的視圖。
   * @throws {@link GoalError} ref 過期，或目前相位不是 active。
   */
  pause(ref: GoalRef): GoalView {
    return this.#transition(ref, 'pause', ['active'], 'paused', 'disarmed');
  }

  /**
   * 讓一個停住的目標重新 active 並掛上授權。
   *
   * 也收 active——那是為了在 session 開始那個 disarmed 邊之後**重新授權**。
   *
   * @param ref - 預期的目前修訂號。
   * @returns active 的視圖。
   * @throws {@link GoalError} ref 過期、相位不可續行，或已經是 active 且已授權。
   */
  resume(ref: GoalRef): GoalView {
    const current = this.#expectCurrent(ref);
    const resumable: readonly GoalPhase[] = ['active', 'paused', 'blocked'];
    if (!resumable.includes(current.phase)) {
      throw this.#transitionError(current, 'resume', resumable);
    }
    if (current.phase === 'active' && this.#activation === 'armed') {
      throw new GoalError(
        `目標 "${current.id}" 已經是 active 而且已授權`,
        'GOAL_INVALID_TRANSITION',
      );
    }
    // 輪次預算這一條在續行排程器落地之後**兩側都走得到**：一個燒完預算的目標要先被
    // 調高上限才 resume 得了。折疊那側是同一條（`fold.ts` 的 `validateSnapshotTransition`）
    // ——折疊擋的是手寫進日誌的，這裡擋的是呼叫進來的，兩份都要在。
    if (this.#state.roundsStarted >= current.maxGoalRounds) {
      throw new GoalError(
        `目標 "${current.id}" 已經用完 ${current.maxGoalRounds} 個輪次；要續行先調高 maxGoalRounds`,
        'GOAL_INVALID_TRANSITION',
      );
    }
    return this.#commitCurrent('resume', this.#withPhase(current, 'active'), 'armed');
  }

  /**
   * 把一個還沒完成的目標標成完成並收回授權。
   *
   * @param ref - 預期的目前修訂號。
   * @returns 完成之後的視圖。
   * @throws {@link GoalError} ref 過期，或它已經是完成的。
   */
  complete(ref: GoalRef): GoalView {
    return this.#transition(
      ref,
      'complete',
      ['active', 'paused', 'blocked'],
      'complete',
      'disarmed',
    );
  }

  /**
   * 把一個 active 的目標標成被擋住並收回授權。
   *
   * @param ref - 預期的目前修訂號。
   * @param reason - 擋它的那條政策自己選的 code 與說明。
   * @returns 帶著耐久理由的視圖。
   * @throws {@link GoalError} ref 過期、相位不是 active，或理由不合格。
   */
  block(ref: GoalRef, reason: GoalBlockReason): GoalView {
    const current = this.#expectCurrent(ref);
    if (current.phase !== 'active') {
      throw this.#transitionError(current, 'block', ['active']);
    }
    return this.#commitCurrent(
      'block',
      { ...this.#withPhase(current, 'blocked'), blockedReason: resolveBlockReason(reason) },
      'disarmed',
    );
  }

  /**
   * 清掉目前的目標，**留下墓碑與歷史**。
   *
   * @param ref - 預期的目前修訂號。
   * @returns 墓碑的 ref，修訂號是被清掉那一份的下一號。
   * @throws {@link GoalError} ref 過期或沒有目前目標。
   */
  clear(ref: GoalRef): GoalRef {
    const current = this.#expectCurrent(ref);
    const tombstone: GoalRef = { id: current.id, revision: current.revision + 1 };
    const change: GoalClearChangeMeta = {
      kind: 'goal/change',
      version: GOAL_CHANGE_VERSION,
      operation: 'clear',
      cleared: tombstone,
      clearedAt: this.#nextMutationTime(),
    };
    this.#commit(change, 'disarmed');
    return { ...tombstone };
  }

  /**
   * 觀察一筆事件：先推折疊，再決定授權。
   *
   * **兩種事件推得動折疊，但只有一種動得了授權。** `turn/start{kind:'goal'}` 推進
   * `roundsStarted`（見 `fold.ts`），而底下那行重算授權的規則是「每一顆 goal 變更都把
   * 授權打回 disarmed」——讓一顆被準入的輪次走到它，等於**排程器排第一輪的那一刻就把自己
   * 的授權收掉了**，第二輪永遠不會來，而且第一輪跑得好好的，看起來像成功。
   * 所以下面在重算之前先讓非 `goal/change` 的事件離開。
   */
  #observe(event: SessionEvent): void {
    if (event.type !== 'goal/change' && event.type !== 'turn/start') return;
    if (this.#failure !== undefined) return;
    try {
      applyGoalEvent(this.#state, event);
    } catch (error: unknown) {
      // **扣住，不往外拋。** 往外拋只會變成日誌那一層的一行 warn，而折疊會悄悄停住。
      this.#failure = `goal 重放在會話事件 ${event.seq} 失敗：${
        error instanceof Error ? error.message : String(error)
      }`;
      return;
    }
    // 一顆準入的輪次只推計數，**不碰授權**——見這個方法的說明。
    if (event.type !== 'goal/change') return;
    // **每一顆 goal 變更都把授權打回 disarmed**，除非那一顆正是這次變更自己掛的邊。
    // 別人（未來的工具、另一個分頁）改動了目標，這個 process 先前拿到的續行授權就不再
    // 對得上他們改成的東西。
    this.#activation = this.#pending?.seq === event.seq ? this.#pending.activation : 'disarmed';
  }

  #requireHealthy(): void {
    if (this.#failure !== undefined) throw new Error(this.#failure);
  }

  #expectCurrent(ref: GoalRef): GoalSnapshot {
    this.#requireHealthy();
    const current = this.#state.goal;
    if (current === undefined) throw new GoalError('沒有目前的目標', 'GOAL_NOT_FOUND');
    if (ref.id !== current.id || ref.revision !== current.revision) {
      throw new GoalError(
        `目標 ref "${ref.id}" 的修訂號 ${ref.revision} 過期了；目前是 "${current.id}" 的 ${current.revision}`,
        'GOAL_STALE_REVISION',
      );
    }
    return current;
  }

  #transitionError(
    current: GoalSnapshot,
    operation: GoalOperation,
    allowed: readonly GoalPhase[],
  ): GoalError {
    return new GoalError(
      `目標 "${current.id}" 的相位是 "${current.phase}"，${operation} 不了；要 ${allowed.join(' 或 ')}`,
      'GOAL_INVALID_TRANSITION',
    );
  }

  #transition(
    ref: GoalRef,
    operation: Exclude<GoalOperation, 'create' | 'edit' | 'clear'>,
    allowed: readonly GoalPhase[],
    phase: GoalPhase,
    activation: GoalActivation,
  ): GoalView {
    const current = this.#expectCurrent(ref);
    if (!allowed.includes(current.phase)) throw this.#transitionError(current, operation, allowed);
    return this.#commitCurrent(operation, this.#withPhase(current, phase), activation);
  }

  /** 換一個相位，**不帶被擋住的理由**——它只在 blocked 時存在。 */
  #withPhase(current: GoalSnapshot, phase: GoalPhase): GoalSnapshot {
    return {
      id: current.id,
      revision: current.revision + 1,
      objective: current.objective,
      phase,
      maxGoalRounds: current.maxGoalRounds,
    };
  }

  /**
   * 有目前目標時，時間戳一定也在——這是折疊自己保證的。
   *
   * **不用 `?? 0` 兜底**：兜過去的話，一份折壞的狀態會安靜地產出 epoch 0 的時間戳，
   * 而那份快照會被寫進日誌。這個守衛走不到，但它走到的時候要吵。
   */
  #requireTimestamps(): { readonly createdAt: number; readonly updatedAt: number } {
    const { createdAt, updatedAt } = this.#state;
    if (createdAt === undefined || updatedAt === undefined) {
      throw new Error('折疊有目前的目標，卻沒有它的時間戳');
    }
    return { createdAt, updatedAt };
  }

  /** 時鐘往回跳也不讓 `updatedAt` 倒退——折疊對它有規則。 */
  #nextMutationTime(): number {
    return Math.max(this.#now(), this.#requireTimestamps().updatedAt);
  }

  #commitCurrent(
    operation: Exclude<GoalOperation, 'create' | 'clear'>,
    goal: GoalSnapshot,
    activation: GoalActivation,
  ): GoalView {
    return this.#commitSnapshot(
      operation,
      goal,
      this.#state.roundsStarted,
      this.#requireTimestamps().createdAt,
      this.#nextMutationTime(),
      activation,
    );
  }

  #commitSnapshot(
    operation: Exclude<GoalOperation, 'clear'>,
    goal: GoalSnapshot,
    roundsStarted: number,
    createdAt: number,
    updatedAt: number,
    activation: GoalActivation,
  ): GoalView {
    const change: GoalSnapshotChangeMeta = {
      kind: 'goal/change',
      version: GOAL_CHANGE_VERSION,
      operation,
      goal,
      roundsStarted,
      createdAt,
      updatedAt,
    };
    this.#commit(change, activation);
    const view = this.#view();
    // **折疊是唯一真相。** 我們剛寫進去的東西如果折不回來，那是這個服務的 bug——
    // 回一個好看的視圖只會讓它更晚被發現。`#requireHealthy` 已經蓋掉「折疊扣住了」
    // 那一半，這裡蓋的是「折完之後沒有目前目標」。
    this.#requireHealthy();
    if (view === undefined) {
      throw new Error(`goal ${operation} 寫進去了，但折疊沒有折出目前的目標`);
    }
    return view;
  }

  /** 記一筆並把這一次的授權跨過 append 邊界交給觀察者。 */
  #commit(change: GoalChangeMeta, activation: GoalActivation): void {
    // `length` 就是下一筆會拿到的 `seq`——觀察者靠它認出「這一顆是我自己寫的」。
    this.#pending = { seq: this.#log.length, activation };
    try {
      this.#log.append('goal/change', change);
    } finally {
      this.#pending = undefined;
    }
  }

  #view(): GoalView | undefined {
    const goal = this.#state.goal;
    if (goal === undefined) return undefined;
    return {
      ...goal,
      roundsStarted: this.#state.roundsStarted,
      ...this.#requireTimestamps(),
      activation: this.#activation,
    };
  }
}
