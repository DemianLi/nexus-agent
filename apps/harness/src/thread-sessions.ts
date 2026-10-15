/**
 * 行程裡**每一條活著的 thread 綁上的會話註冊表**（[#1463](https://github.com/DemianLi/nexus-agent/issues/1463) Q1 (a)，
 * Part of #1385；逐條 thread 接縫的第三段，#1418 → #1458 → 這張）。
 *
 * 樹上的 `session-lookup` 那一列（`@nexus/session/provider`）問的就是它：模型工具呼叫當下問「這次呼叫該寫進哪一份日誌」，
 * 這裡把「活著的那幾張」交給 `@nexus/core` 的 `pickSessionForCall`——**與相容層的 `registry.sessions.forCall` 是同一支挑法**，
 * 這個檔不另寫一份（驗收 G 的「永遠回第一張」突變改在那支函式上）。
 *
 * ## 登記與撤除的時機
 *
 * - **登記**：`createNexusAgent` 的 `attachSession` 在 `registry.sessions.bind(sessions)` 與背景 host 都建好之後、回傳 detach 之前
 *   才登記——組裝在這之前失敗就什麼都沒登記。
 * - **撤除**：掛在 `attachSession` 回傳的 detach 上，與解綁、退訂是同一個函式。
 * - **同一條 thread id 重組**：以 **root 日誌 id** 為鍵，後登記的**取代**先登記的（舊的那份 detach 之後只撤自己，不會誤撤新的）。
 *   所以不論舊的那一份有沒有被收掉，行程裡**不會有兩張都認得同一條 thread 的登記**——那會讓下一次呼叫變成 `ambiguous`。
 *   會重組同一個 id 的時機（產品路徑上今天只有第一種會走到，其餘兩種是同一個機制的邊界）：
 *   1. serve 的 thread 在 `attachSessions` 之後、`ready.set` 之前建不起來（落盤接不上、標題接線拋……），`threads` 條目被刪，
 *      下一次請求用同一個 thread id 重新組裝；舊的那一份沒人收（`wire-handler.ts` 的 catch 只收 `threadAgent`）。
 *   2. 同一棵樹上先後組兩次同一個 thread id（測試、`resume` 在同一個行程裡接回同一份日誌）。
 *   3. 行程重啟：新行程是新的一棵樹，沒有殘留。
 *
 * **只在行程內、不落盤**：這是「這個行程現在有哪幾條活著」，不是任何耐久狀態。
 *
 * @module
 */

import { pickSessionForCall } from '@nexus/core';
import type { SessionLookup, SessionRegistry } from '@nexus/core';

/** `attachSession` 需要的那一面：把一條 thread 的註冊表登記進行程級的查找，回撤除函式。 */
export interface SessionLookupRegistrar {
  /**
   * @param sessions - 這條 thread 的會話註冊表（root 日誌 id 就是 thread id）。
   * @returns 只撤自己這一次登記的冪等 undo：同一個 id 後來被別的註冊表取代了，它什麼都不做。
   */
  register(sessions: SessionRegistry): () => void;
}

/** 一棵樹上活著的 thread 的註冊表。 */
export class ThreadSessions implements SessionLookupRegistrar {
  /** 鍵是 root 日誌 id（＝thread id）。 */
  readonly #live = new Map<string, SessionRegistry>();

  register(sessions: SessionRegistry): () => void {
    const key = sessions.root.sessionId;
    // 取代而不是並列：理由見檔頭「同一條 thread id 重組」。
    this.#live.set(key, sessions);
    return () => {
      if (this.#live.get(key) === sessions) this.#live.delete(key);
    };
  }

  /**
   * 這次呼叫該寫進哪一份日誌。挑法是 core 的 {@link pickSessionForCall}：沒有就 `not-attached`、一張不看 `thread_id`、
   * 多張依 `thread_id` 挑恰好一張。
   *
   * @param config - 工具 handler 的第二個參數。
   */
  forCall(config: unknown): SessionLookup {
    return pickSessionForCall(this.#live.values(), config);
  }

  /** 現在登記著幾條。給測試與稽核對照。 */
  get size(): number {
    return this.#live.size;
  }
}
