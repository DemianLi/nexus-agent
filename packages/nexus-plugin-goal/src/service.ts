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
 *    子收的就是那份日誌），那個參數沒有指涉對象。同 `registry.ts` 對
 *    `ScopedLayers` 的處理，寫在這裡是為了後面的人不要「還原」它。（樹上一份 `goals` 服務服務整個行程，
 *    所以 `goals.serviceFor(log)` 那一層補回了 dsh 的 `agent` 鍵，鍵是 root 日誌；單一 `GoalService` 仍只綁一份。）
 * 2. **`GOAL_AGENT_NOT_LIVE` 這個錯誤碼不在。** 它守的正是上面那個參數——dsh 的
 *    `assertLive` 擋的是「拿一個已經不在註冊表裡的 Agent 來呼叫」。參數沒了，那個碼就
 *    沒有生產者，留著等於留一個永遠拋不出來的分類。**是缺，不是省略**：驅動器或多
 *    agent 那一天真的來了，它跟著那個參數一起回來。
 * 3. **狀態不走投影註冊表。** dsh 的 `applyGoalProjection` 跑在 `sessionProjections`
 *    裡，帶 `stateVersion` 與 `wire.view`；我們沒有投影子系統，折疊持在這個物件的私有
 *    欄位上，由建構子**同步地**讀 `log.events` 重播、再 `log.subscribe` 接後續推進
 *    （#1486 起：以前是 `sessions` 通道的 `observe()`，接上日誌就建；現在是第一次被問到才建，見 `index.ts`）。
 *    重播與訂閱之間不漏、不重：`SessionLog.append` 先凍住監聽清單、再 push、再同步發布。
 *    折得出的答案與以前相同：接上一份有內容的日誌重播一遍，一路看著它長大折出同一個結果。
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

import {
  applyGoalEvent,
  DEFAULT_MAX_GOAL_ROUNDS,
  emptyGoalFoldState,
  GOAL_CHANGE_VERSION,
  goalId,
} from '@nexus/goal';
import type {
  GoalActivation,
  GoalActivationChange,
  GoalBlockReason,
  GoalChangeMeta,
  GoalClearChangeMeta,
  GoalFoldState,
  GoalOperation,
  GoalPhase,
  GoalRef,
  GoalService as GoalServiceContract,
  GoalSnapshot,
  GoalSnapshotChangeMeta,
  GoalView,
} from '@nexus/goal';
import type { SessionEvent, SessionLog } from '@nexus/session';

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
  /**
   * 續行授權變了就叫它（[#1575](https://github.com/DemianLi/nexus-agent/issues/1575) N0376，dsh `setActivation` 的
   * `goal/activation-changed`）。**同步呼叫**，在授權換掉、折疊之後；值沒變不叫，折疊壞掉也不叫。丟出來的錯由呼叫端（`createGoalCore`）接住。
   */
  readonly onActivationChanged?: (change: GoalActivationChange) => void;
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
 * 一份 root 會話日誌一個。
 *
 * 建構子**同步地**重播 `log.events`、再 `log.subscribe` 接後續——**服務與日誌同壽命**，不存在「還沒開始觀察」的狀態。訂閱沒有拆除的
 * 一步：服務存在以日誌為鍵的 `WeakMap` 裡（`index.ts`），日誌被回收時服務與監聽一起走；thread 收掉之後那份日誌不再有人寫入。
 */
export class GoalService implements GoalServiceContract {
  readonly #log: SessionLog;
  readonly #defaultMaxGoalRounds: number;
  readonly #now: () => number;
  readonly #newGoalId: () => string;
  readonly #onActivationChanged: ((change: GoalActivationChange) => void) | undefined;
  #state: GoalFoldState = emptyGoalFoldState();
  /** 第一次重放失敗的理由，扣住之後不再往前折。 */
  #failure: string | undefined;
  #activation: GoalActivation = 'disarmed';
  /** 跨過同步 append 邊界的那一格：這一次變更**自己**要掛的授權。 */
  #pending: { readonly seq: number; readonly activation: GoalActivation } | undefined;

  /**
   * @param log - 這一份 root 日誌。**呼叫端只交 root**（子代理的日誌建出來也折得出自己的狀態，但沒有任何入口會問它）。
   * @param options - 預設輪次上限、時鐘與 id 工廠。
   * @throws `defaultMaxGoalRounds` 不是正的安全整數。
   */
  constructor(log: SessionLog, options: GoalServiceOptions = {}) {
    this.#log = log;
    this.#defaultMaxGoalRounds = resolveMaxGoalRounds(
      options.defaultMaxGoalRounds ?? DEFAULT_MAX_GOAL_ROUNDS,
    );
    this.#now = options.now ?? (() => Date.now());
    this.#newGoalId = options.newGoalId ?? (() => `goal-${randomUUID()}`);
    this.#onActivationChanged = options.onActivationChanged;
    // **先補歷史再收後續，兩步在同一個同步區塊裡**：`append` 先凍住監聽清單、再 push、再同步發布（`session-log.ts` 的 `append`），
    // 所以在別人的監聽回呼裡才建立也不會漏掉正在發布的那一筆、也不會把它收兩次。`subscribe` 不補發歷史。
    for (const event of log.events) this.#observe(event);
    log.subscribe((event) => {
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
    this.#setActivation('disarmed');
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
    this.#setActivation(
      this.#pending?.seq === event.seq ? this.#pending.activation : 'disarmed',
    );
  }

  /**
   * 換授權，**值真的變了才通知**（dsh `setActivation`，`goal/src/index.ts:495-515`：值沒變不送 `:497`、折疊失敗不送 `:502`）。
   * 通知帶換掉之後的視圖：有目前目標就帶 `{ id, revision, activation }`，沒有就缺席。
   */
  #setActivation(next: GoalActivation): void {
    if (this.#activation === next) return;
    this.#activation = next;
    // dsh 在這裡還有「折疊失敗不送」（`:502`）：我們兩個呼叫點都到不了——`disarm` 先 `#requireHealthy` 拋、`#observe` 折壞就早退。
    const listener = this.#onActivationChanged;
    if (listener === undefined) return;
    const view = this.#view();
    listener(
      view === undefined
        ? {}
        : { goal: { id: view.id, revision: view.revision, activation: view.activation } },
    );
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
