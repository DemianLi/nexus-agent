/**
 * 計劃模式兩列共用的狀態：樹上的 `plan-mode` 那一列（`./index.ts`）與相容層的 `plan-mode-model-call` 那一格（`./model-call-cell.ts`）。
 *
 * 樹上那一列接上 root 日誌、排待關；相容層那一格在下一次模型呼叫之前交出待關。兩邊不在同一個 `apply` 裡，所以表放在這個模組的頂層，
 * 以 root 那份 `SessionLog` 為鍵：一份日誌一筆，兩次組裝、兩份日誌互不影響，日誌被回收，那一筆跟著走。
 *
 * **兩列必須來自同一份套件。** 兩邊讀寫同一張表的前提是 import 到同一份 `plan-mode-state.js`。行程裡裝了兩份這個套件時，兩列各拿各的表：
 * 樹上那一半排的待關，相容層那一格看不到，同意之後模式關不掉，沒有東西會拋。出貨清單的兩列都從這個套件的 `exports` 進來
 * （`apps/harness/src/plan-mode-on-tree.test.ts` 釘住）。
 *
 * @module
 */

import type { SessionLog } from '@nexus/session';

/**
 * 一份 root 日誌上的模式。
 *
 * `log` 是寫的那一份，`active()` 是讀的那一份——**兩者是同一份日誌**，讀的那一半是觀察面折出來的，所以 `append` 之後 `active()`
 * 當場就是新的值（觀察面同步送）。
 */
export interface PlanModeSession {
  readonly log: SessionLog;
  active(): boolean;
}

// eslint-disable-next-line no-restricted-syntax -- 兩列共用的狀態，見檔頭
const sessionsByLog = new WeakMap<SessionLog, PlanModeSession>();
// `exit_plan_mode` 同意之後排著、等下一次模型呼叫交出去的待關。同 dsh 的 `pendingIntents`。
// eslint-disable-next-line no-restricted-syntax -- 兩列共用的狀態，見檔頭
const pendingExits = new WeakSet<PlanModeSession>();

/**
 * 登記一份 root 日誌上的模式。
 *
 * @returns 收掉這一筆（連同排著的待關）的函式。
 */
export function attachPlanModeSession(session: PlanModeSession): () => void {
  sessionsByLog.set(session.log, session);
  return () => {
    pendingExits.delete(session);
    if (sessionsByLog.get(session.log) === session) sessionsByLog.delete(session.log);
  };
}

/** 這份日誌上的模式；不是計劃模式接著的 root 日誌時是 `undefined`。 */
export function planModeSessionOf(log: SessionLog): PlanModeSession | undefined {
  return sessionsByLog.get(log);
}

/** 排一格待關。 */
export function queuePlanModeExit(session: PlanModeSession): void {
  pendingExits.add(session);
}

/**
 * 丟掉排著的待關。
 *
 * @returns 原本有沒有排著。
 */
export function dropPlanModeExit(session: PlanModeSession): boolean {
  return pendingExits.delete(session);
}

/**
 * 交出這份日誌排著的待關：有排著、而且模式還開著，就寫 `plan/mode { active: false }`。不是計劃模式接著的 root 日誌、或沒有排著的，
 * 什麼都不做。
 */
export function settlePlanModeExit(log: SessionLog): void {
  const session = sessionsByLog.get(log);
  if (session === undefined || !pendingExits.delete(session)) return;
  if (session.active()) session.log.append('plan/mode', { active: false });
}
