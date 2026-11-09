/**
 * 計劃模式的狀態：每份 root 日誌上的模式，與 `exit_plan_mode` 同意之後排著的待關。
 *
 * 逐條 thread 的那一半（會話參與者接上 root 日誌、`agent/pre-step` 交出待關）與行程級的那一半（退出工具排待關、`/plan` 讀寫模式）
 * 都在 `./index.ts` 的 `mountPlanMode` 裡，所以一次掛載建一份（{@link createPlanModeState}），閉包裡帶著走。以 root 那份 `SessionLog`
 * 為鍵：一份日誌一筆，兩份日誌互不影響，日誌被回收，那一筆跟著走。
 *
 * @module
 */

import type { SessionLog } from '@nexus/session';

/**
 * 一份 root 日誌上的模式。
 *
 * `log` 是寫的那一份，`active()` 是讀的那一份——**兩者是同一份日誌**，讀的那一半是觀察面折出來的，所以 `append` 之後 `active()`
 * 當場就是新的值（觀察面同步送，見 `@nexus/core` 的 `SessionSubject.observe`）。
 */
export interface PlanModeSession {
  readonly log: SessionLog;
  active(): boolean;
}

/** 一次掛載的狀態表。 */
export interface PlanModeState {
  /**
   * 登記一份 root 日誌上的模式。
   *
   * @returns 收掉這一筆（連同排著的待關）的函式。
   */
  attach(session: PlanModeSession): () => void;
  /** 這份日誌上的模式；不是計劃模式接著的 root 日誌時是 `undefined`。 */
  sessionOf(log: SessionLog): PlanModeSession | undefined;
  /** 排一格待關。 */
  queueExit(session: PlanModeSession): void;
  /**
   * 丟掉排著的待關。
   *
   * @returns 原本有沒有排著。
   */
  dropExit(session: PlanModeSession): boolean;
  /**
   * 交出這份日誌排著的待關：有排著、而且模式還開著，就寫 `plan/mode { active: false }`。不是計劃模式接著的 root 日誌、或沒有排著的，
   * 什麼都不做。**寫成功才拿掉待關**：`append` 拋錯時日誌不變，待關留著，下一次再交。
   *
   * @throws `append` 拋的錯，原樣往外。
   */
  settleExit(log: SessionLog): void;
}

/** 建一份空的狀態表。 */
export function createPlanModeState(): PlanModeState {
  const sessionsByLog = new WeakMap<SessionLog, PlanModeSession>();
  const pendingExits = new WeakSet<PlanModeSession>();
  return {
    attach(session) {
      sessionsByLog.set(session.log, session);
      return () => {
        pendingExits.delete(session);
        if (sessionsByLog.get(session.log) === session) sessionsByLog.delete(session.log);
      };
    },
    sessionOf: (log) => sessionsByLog.get(log),
    queueExit(session) {
      pendingExits.add(session);
    },
    dropExit: (session) => pendingExits.delete(session),
    settleExit(log) {
      const session = sessionsByLog.get(log);
      if (session === undefined || !pendingExits.has(session)) return;
      if (session.active()) session.log.append('plan/mode', { active: false });
      pendingExits.delete(session);
    },
  };
}
