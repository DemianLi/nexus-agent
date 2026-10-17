/**
 * 耐久 goal 變更的**嚴格解碼**與**純折疊**。
 *
 * 照抄 dsh 的 `packages/goal/goal/src/fold.ts`（對讀日期 2026-09-01，版本
 * `0a53fb55bea101816fa226bb964ae2bed71c343b`），一條規則都沒放寬。
 *
 * **嚴格的意思是壞掉的變更讓重放失敗，不是被跳過。** 這一點是這個檔案唯一的價值：
 * 一顆解不開的 `goal/change` 代表這個會話對「目前的目標是什麼」已經沒有答案了，靜靜
 * 跳過它換來的是一個看起來正常、實際上少了一次變更的狀態。所以每一個欄位都逐一驗，
 * 連 key 的集合都比對——多一格少一格都是不同的東西。
 *
 * ## `roundsStarted` 是折疊出來的，不是誰寫進 `goal/change` 的
 *
 * dsh 的 `applyGoalEvent` 有第二條分支，從 `user/message` 裡 `source.kind === 'goal'`
 * 的輪次推進 `roundsStarted`；我們的對應物是 `turn/start` 的 `kind: 'goal'`
 * （[#180](https://github.com/DemianLi/nexus-agent/issues/180)）。**只有被準入的那一顆
 * 會推進計數**——四格全部對上（同一個目標、同一個修訂號、剛好是下一輪、沒超過上限）才
 * 算，任何一格不符是拋不是跳過。
 *
 * 這一格為什麼不能讓寫的人自己說：`goal/change` 是**服務**寫的，而輪次是**排程器**排
 * 的。讓變更帶著自己的輪次，等於讓任何一個寫得出 `goal/change` 的人宣稱自己已經跑過幾
 * 輪，而預算檢查（`resume` 那條）讀的正是這個數。所以下面那道
 * `change.roundsStarted !== state.roundsStarted` **照留**：它擋的是「有人寫了一顆自己
 * 改動輪次的變更」，而那條路今天與之後都不該通。
 *
 * @module
 */

import { GOAL_CHANGE_VERSION, goalId } from '@nexus/core';
import type {
  GoalBlockReason,
  GoalChangeMeta,
  GoalClearChangeMeta,
  GoalId,
  GoalOperation,
  GoalPhase,
  GoalRef,
  GoalSnapshot,
  GoalSnapshotChangeMeta,
  SessionEvent,
} from '@nexus/core';

const SNAPSHOT_OPERATIONS: ReadonlySet<string> = new Set([
  'create',
  'edit',
  'pause',
  'resume',
  'complete',
  'block',
]);
const PHASES: ReadonlySet<string> = new Set(['active', 'paused', 'blocked', 'complete']);

/** lower-kebab-case，照抄 dsh 的那一條。 */
const BLOCK_CODE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

/** 重放用的可變累積器。 */
export interface GoalFoldState {
  /** 目前的 goal；create 之前與 clear 之後沒有。 */
  goal: GoalSnapshot | undefined;
  /** 目前這個 goal 已經開始的續行輪次。只有被準入的 `turn/start{kind:'goal'}` 推得動它。 */
  roundsStarted: number;
  createdAt: number | undefined;
  updatedAt: number | undefined;
  /** 最近一次變更的身分，**包含 clear 墓碑**。 */
  lastRef: GoalRef | undefined;
  /** 這個會話用過的 goal id，留著是為了拒絕重用。 */
  seenGoalIds: Set<GoalId>;
}

/**
 * 開一個空的累積器。
 * @returns 沒有目前目標、也沒有前一次身分的可變狀態。
 */
export function emptyGoalFoldState(): GoalFoldState {
  return {
    goal: undefined,
    roundsStarted: 0,
    createdAt: undefined,
    updatedAt: undefined,
    lastRef: undefined,
    seenGoalIds: new Set(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** key 的集合要**剛好**是這些。多一格少一格都拋。 */
function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  what: string,
): void {
  const actual = Object.keys(value).sort().join(',');
  const wanted = [...expected].sort().join(',');
  if (actual !== wanted) {
    throw new Error(
      `${what}的欄位必須剛好是 ${wanted}，實際是 ${actual === '' ? '（空）' : actual}`,
    );
  }
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`goal 變更的 ${field} 必須是正的安全整數`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`goal 變更的 ${field} 必須是非負的安全整數`);
  }
  return value;
}

function decodeBlockReason(value: unknown): GoalBlockReason {
  if (!isRecord(value)) throw new Error('goal 變更的 goal.blockedReason 必須是物件');
  requireExactKeys(value, ['code', 'message'], 'goal.blockedReason');
  const code: unknown = value['code'];
  const message: unknown = value['message'];
  if (typeof code !== 'string' || !BLOCK_CODE_PATTERN.test(code)) {
    throw new Error('goal 變更的 goal.blockedReason.code 必須是 lower-kebab-case');
  }
  if (typeof message !== 'string' || message.trim().length === 0 || message !== message.trim()) {
    throw new Error('goal 變更的 goal.blockedReason.message 必須非空且已正規化');
  }
  return { code, message };
}

function decodeSnapshot(value: unknown): GoalSnapshot {
  if (!isRecord(value)) throw new Error('goal 變更的 goal 必須是物件');
  const rawId: unknown = value['id'];
  if (typeof rawId !== 'string' || rawId.length === 0) {
    throw new Error('goal 變更的 goal.id 必須是非空字串');
  }
  const objective: unknown = value['objective'];
  if (
    typeof objective !== 'string' ||
    objective.trim().length === 0 ||
    objective !== objective.trim()
  ) {
    throw new Error('goal 變更的 goal.objective 必須非空且已正規化');
  }
  const phase: unknown = value['phase'];
  if (typeof phase !== 'string' || !PHASES.has(phase)) {
    throw new Error('goal 變更的 goal.phase 不是認得的相位');
  }
  // **`blockedReason` 剛好在 blocked 時存在。** 分成兩條各驗一半的話，「blocked 但沒
  // 理由」與「不是 blocked 卻帶理由」都會變成合法的，而那兩種狀態沒有人讀得懂。
  requireExactKeys(
    value,
    phase === 'blocked'
      ? ['blockedReason', 'id', 'maxGoalRounds', 'objective', 'phase', 'revision']
      : ['id', 'maxGoalRounds', 'objective', 'phase', 'revision'],
    `相位 ${phase} 的 goal`,
  );
  return {
    id: goalId(rawId),
    revision: positiveInteger(value['revision'], 'goal.revision'),
    objective,
    phase: phase as GoalPhase,
    maxGoalRounds: positiveInteger(value['maxGoalRounds'], 'goal.maxGoalRounds'),
    ...(phase === 'blocked' ? { blockedReason: decodeBlockReason(value['blockedReason']) } : {}),
  };
}

function decodeRef(value: unknown, what: string): GoalRef {
  if (!isRecord(value)) throw new Error(`${what}必須是物件`);
  requireExactKeys(value, ['id', 'revision'], what);
  const rawId: unknown = value['id'];
  if (typeof rawId !== 'string' || rawId.length === 0) {
    throw new Error(`${what}的 id 必須是非空字串`);
  }
  return { id: goalId(rawId), revision: positiveInteger(value['revision'], 'cleared.revision') };
}

/**
 * 解一個自稱是 goal 變更的東西。
 *
 * **不是 goal 變更的回 `undefined`，是 goal 變更但壞掉的當場拋。** 兩者分開，因為前者
 * 是「這一筆不關我的事」，後者是「這一筆該是我的事但我讀不懂」。
 *
 * @param value - 候選酬載。
 * @returns 驗過的變更，或這根本不是一顆 goal 變更時的 `undefined`。
 * @throws 自稱是 goal 變更但版本、operation 或任何欄位不合。
 */
export function decodeGoalChange(value: unknown): GoalChangeMeta | undefined {
  if (!isRecord(value) || value['kind'] !== 'goal/change') return undefined;
  if (value['version'] !== GOAL_CHANGE_VERSION) {
    throw new Error(`不支援的 goal 變更版本 ${String(value['version'])}`);
  }
  if (value['operation'] === 'clear') {
    requireExactKeys(
      value,
      ['cleared', 'clearedAt', 'kind', 'operation', 'version'],
      'goal clear 變更',
    );
    return {
      kind: 'goal/change',
      version: GOAL_CHANGE_VERSION,
      operation: 'clear',
      cleared: decodeRef(value['cleared'], 'goal clear 墓碑'),
      clearedAt: nonNegativeInteger(value['clearedAt'], 'clearedAt'),
    } satisfies GoalClearChangeMeta;
  }
  const operation: unknown = value['operation'];
  if (typeof operation !== 'string' || !SNAPSHOT_OPERATIONS.has(operation)) {
    throw new Error('goal 變更的 operation 不是認得的動詞');
  }
  requireExactKeys(
    value,
    ['createdAt', 'goal', 'kind', 'operation', 'roundsStarted', 'updatedAt', 'version'],
    'goal 快照變更',
  );
  const createdAt = nonNegativeInteger(value['createdAt'], 'createdAt');
  const updatedAt = nonNegativeInteger(value['updatedAt'], 'updatedAt');
  if (updatedAt < createdAt) throw new Error('goal 變更的 updatedAt 不能早於 createdAt');
  return {
    kind: 'goal/change',
    version: GOAL_CHANGE_VERSION,
    operation: operation as Exclude<GoalOperation, 'clear'>,
    goal: decodeSnapshot(value['goal']),
    roundsStarted: nonNegativeInteger(value['roundsStarted'], 'roundsStarted'),
    createdAt,
    updatedAt,
  } satisfies GoalSnapshotChangeMeta;
}

/**
 * 一次變更帶的身分。
 * @param change - 解過的變更。
 * @returns 快照的 ref，或墓碑的 ref。
 */
export function goalChangeRef(change: GoalChangeMeta): GoalRef {
  return change.operation === 'clear'
    ? change.cleared
    : { id: change.goal.id, revision: change.goal.revision };
}

/** 只有 `edit` 改得動 objective 與 maxGoalRounds。 */
function requireSameDefinition(
  current: GoalSnapshot,
  next: GoalSnapshot,
  operation: GoalOperation,
): void {
  if (next.objective !== current.objective || next.maxGoalRounds !== current.maxGoalRounds) {
    throw new Error(`goal ${operation} 不得改動 objective 或 maxGoalRounds`);
  }
}

/** 每一次變更 revision 剛好 +1，而且要是同一個 goal。 */
function requireNextRevision(current: GoalSnapshot, next: GoalRef, operation: GoalOperation): void {
  if (next.id !== current.id || next.revision !== current.revision + 1) {
    throw new Error(`goal ${operation} 必須把目前的 goal 推進剛好一個修訂號`);
  }
}

/** 一次非 create 的快照操作，對著前一份投影驗。 */
function validateSnapshotTransition(
  state: GoalFoldState,
  change: GoalSnapshotChangeMeta,
  current: GoalSnapshot,
): void {
  const next = change.goal;
  requireNextRevision(current, next, change.operation);
  if (state.updatedAt === undefined) throw new Error('目前的 goal 折疊缺 updatedAt');
  if (
    change.createdAt !== state.createdAt ||
    change.updatedAt < state.updatedAt ||
    change.roundsStarted !== state.roundsStarted
  ) {
    throw new Error(`goal ${change.operation} 沒有保住目前的計數與時間戳`);
  }
  switch (change.operation) {
    case 'edit':
      if (
        next.phase !== current.phase ||
        JSON.stringify(next.blockedReason) !== JSON.stringify(current.blockedReason)
      ) {
        throw new Error('goal edit 不得改動相位或被擋住的理由');
      }
      break;
    case 'pause':
      requireSameDefinition(current, next, change.operation);
      if (current.phase !== 'active' || next.phase !== 'paused') {
        throw new Error('goal pause 的相位轉換不合法');
      }
      break;
    case 'resume': {
      requireSameDefinition(current, next, change.operation);
      const resumable: ReadonlySet<GoalPhase> = new Set<GoalPhase>(['active', 'paused', 'blocked']);
      // `state.roundsStarted >= next.maxGoalRounds` 這一半在驅動器落地之後**兩側都走得到**：
      // 一個燒完預算的目標要先被調高上限才 resume 得了。服務那側的同一條在 `service.ts`
      // 的 `resume`，兩份都要在——折疊擋的是手寫進日誌的，服務擋的是呼叫進來的。
      if (
        !resumable.has(current.phase) ||
        next.phase !== 'active' ||
        state.roundsStarted >= next.maxGoalRounds
      ) {
        throw new Error('goal resume 的相位轉換不合法，或輪次預算已經用完');
      }
      break;
    }
    case 'complete':
      requireSameDefinition(current, next, change.operation);
      if (current.phase === 'complete' || next.phase !== 'complete') {
        throw new Error('goal complete 的相位轉換不合法');
      }
      break;
    case 'block':
      requireSameDefinition(current, next, change.operation);
      if (current.phase !== 'active' || next.phase !== 'blocked') {
        throw new Error('goal block 的相位轉換不合法');
      }
      break;
    case 'create':
      throw new Error('goal create 不能當成目前 goal 的轉換來驗');
    default:
      change.operation satisfies never;
      throw new Error('認不得的 goal 快照操作');
  }
}

/**
 * 把一次解過的變更套到累積器上。
 *
 * @param state - 前一份耐久投影。
 * @param change - 解過的整份快照或墓碑。
 * @throws 這一筆接不上前一筆。
 */
export function applyGoalChange(state: GoalFoldState, change: GoalChangeMeta): void {
  const ref = goalChangeRef(change);
  if (change.operation === 'clear') {
    const current = state.goal;
    if (current === undefined) throw new Error('goal clear 需要一個目前的 goal');
    requireNextRevision(current, change.cleared, change.operation);
    if (state.updatedAt === undefined) throw new Error('目前的 goal 折疊缺 updatedAt');
    if (change.clearedAt < state.updatedAt) {
      throw new Error('goal clear 的時間不能早於目前 goal 的更新時間');
    }
    state.goal = undefined;
    state.roundsStarted = 0;
    state.createdAt = undefined;
    state.updatedAt = undefined;
    state.lastRef = ref;
    return;
  }
  if (change.operation === 'create') {
    // **id 用過就不能再用**：重用會讓兩段互不相干的歷史在同一個身分下面串成一條。
    if (
      change.goal.revision !== 1 ||
      change.goal.phase !== 'active' ||
      change.roundsStarted !== 0 ||
      (state.goal !== undefined && state.goal.phase !== 'complete') ||
      state.seenGoalIds.has(change.goal.id)
    ) {
      throw new Error('goal create 需要一個沒用過的、修訂號為 1、相位 active、輪次為 0 的 goal');
    }
    state.seenGoalIds.add(change.goal.id);
  } else {
    const current = state.goal;
    if (current === undefined) throw new Error(`goal ${change.operation} 需要一個目前的 goal`);
    validateSnapshotTransition(state, change, current);
  }
  state.goal = change.goal;
  state.roundsStarted = change.roundsStarted;
  state.createdAt = change.createdAt;
  state.updatedAt = change.updatedAt;
  state.lastRef = ref;
}

/**
 * 把一顆 goal 來源的輪次套到折疊上，**準入才算**。
 *
 * 照 dsh 的 `applyGoalEvent`（`goal/goal/src/fold.ts`）那半條：四格全部對上才推進計數。
 * 對不上時**拋而不是略過**——一顆對不上的 goal 輪次代表有人在這份日誌裡排了一輪不屬於
 * 目前目標的續行，靜靜跳過它換來的是一個看起來正常、實際上少算了一輪的預算。
 *
 * @param state - 可變的累積器。
 * @param event - 一顆 `kind: 'goal'` 的 `turn/start`。
 * @throws 這一輪不是目前這個 active 目標的下一個準入輪次。
 */
function applyGoalRound(state: GoalFoldState, event: SessionEvent<'turn/start'>): void {
  const data = event.data;
  if (data.kind !== 'goal') return;
  const current = state.goal;
  if (
    current === undefined ||
    current.phase !== 'active' ||
    data.goalId !== current.id ||
    data.revision !== current.revision ||
    data.round !== state.roundsStarted + 1 ||
    data.round > current.maxGoalRounds
  ) {
    throw new Error(`會話事件 ${event.seq} 的 goal 輪次不是目前 active 目標的下一個準入輪次`);
  }
  state.roundsStarted = data.round;
}

/**
 * 把一筆會話事件套到嚴格折疊上。**其他種類原樣略過**。
 *
 * 兩種事件推得動這份狀態，而且推的是不同的格子：`goal/change` 換整份快照，
 * `turn/start{kind:'goal'}` 推進 `roundsStarted`。
 *
 * @param state - 可變的累積器。
 * @param event - 依序來的下一筆事件。
 * @throws 這一筆是 goal 變更但解不開或接不上，或是一顆接不上的 goal 輪次。
 */
export function applyGoalEvent(state: GoalFoldState, event: SessionEvent): void {
  if (event.type === 'turn/start') {
    applyGoalRound(state, event);
    return;
  }
  if (event.type !== 'goal/change') return;
  const change = decodeGoalChange(event.data);
  if (change === undefined) {
    throw new Error(`會話事件 ${event.seq} 的 goal 變更沒有自稱是 goal 變更`);
  }
  applyGoalChange(state, change);
}

/** 一次重放的結果。 */
export interface FoldedGoal {
  readonly goal?: GoalSnapshot;
  readonly roundsStarted: number;
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly lastRef?: GoalRef;
}

/**
 * 從一串連續的會話事件折出目前的 goal 狀態。
 *
 * @param events - 依 `seq` 排好的事件。
 * @returns 一份新的耐久投影；**activation 刻意不在裡面**，它不持久。
 * @throws 任何一筆 goal 變更解不開或接不上——**不跳過**。
 */
export function foldGoal(events: readonly SessionEvent[]): FoldedGoal {
  const state = emptyGoalFoldState();
  for (const event of events) applyGoalEvent(state, event);
  return {
    ...(state.goal === undefined ? {} : { goal: { ...state.goal } }),
    roundsStarted: state.roundsStarted,
    ...(state.createdAt === undefined ? {} : { createdAt: state.createdAt }),
    ...(state.updatedAt === undefined ? {} : { updatedAt: state.updatedAt }),
    ...(state.lastRef === undefined ? {} : { lastRef: { ...state.lastRef } }),
  };
}
