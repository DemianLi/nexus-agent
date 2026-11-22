/**
 * 行程裡**每一條活著的 thread 綁上的會話註冊表與 fs 把手**（[#1463](https://github.com/DemianLi/nexus-agent/issues/1463) Q1 (a)，
 * [#1466](https://github.com/DemianLi/nexus-agent/issues/1466) Q2 (a)，Part of #1385；逐條 thread 接縫的第三、四段，
 * #1418 → #1458 → #1463 → 這張）。
 *
 * 樹上的 `session-lookup` 那一列（`@nexus/session/provider`）問的就是它：模型工具呼叫當下問「這次呼叫該寫進哪一份日誌」；
 * `fs` 那一列（`@nexus/fs/provider`）問「這次呼叫該讀寫哪一個 backend」。**兩個問題是同一次挑法**：一次 `attachSession` 登記
 * **一筆**，這一筆同時帶這條 thread 的會話註冊表與 fs 把手，挑法是 `@nexus/core` 的 `pickBoundForCall`（`pickSessionForCall`
 * 就是它加上「開日誌」）——**與相容層的 `registry.sessions.forCall` 是同一支挑法**，這個檔不另寫一份（驗收的「永遠回第一張」
 * 突變改在那支函式上，兩個查找一起紅）。
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
 *      下一次請求用同一個 thread id 重新組裝；舊的那一份由 `wire-handler.ts` 的 catch 收掉（#1467，和成功路徑共用同一支 `release`）。
 *   2. 同一棵樹上先後組兩次同一個 thread id（測試、`resume` 在同一個行程裡接回同一份日誌）。
 *   3. 行程重啟：新行程是新的一棵樹，沒有殘留。
 *
 * **只在行程內、不落盤**：這是「這個行程現在有哪幾條活著」，不是任何耐久狀態。
 *
 * @module
 */

import { pickBoundForCall, pickSessionForCall } from '@nexus/core';
import type { FsService, SessionLookup, SessionRegistry } from '@nexus/core';
import type { FsLookup } from '@nexus/fs';

/** `attachSession` 需要的那一面：把一條 thread 的註冊表（與 fs 把手）登記進行程級的查找，回撤除函式。 */
export interface SessionLookupRegistrar {
  /**
   * @param sessions - 這條 thread 的會話註冊表（root 日誌 id 就是 thread id）。
   * @param fs - 這條 thread 的 fs 把手：**就是這次組裝 host-services 裡那一格 `fs` 服務**（`createFsService` 建、fold 填值），
   *   不是另建的 backend。不給就是這條 thread 沒有（fs 查找對它回 `not-attached`）。
   * @returns 只撤自己這一次登記的冪等 undo：同一個 id 後來被別的註冊表取代了，它什麼都不做。
   */
  register(sessions: SessionRegistry, fs?: FsService): () => void;
}

/**
 * 行程級查找只剩一筆登記時**也核對 `thread_id`**（[#1482](https://github.com/DemianLi/nexus-agent/issues/1482)）。行程裡別條 thread 剛好只剩這一筆，
 * 不代表這次呼叫屬於它——一條 thread 收尾途中還在跑的工具就是這樣被挑到別人身上的（寫進別條 thread 的日誌、讀寫別條 thread 的 fs，而 fs 是
 * 安全邊界）。相容層的 `registry.sessions.forCall` 與沒帶 `thread_id` 的呼叫不跟著改；挑法仍只寫在 core 的 `pickBoundForCall` 一處。
 */
const VERIFY_SINGLE = { verifySingle: true } as const;

/** 一條 thread 的登記：同一次組裝的兩樣東西，**一起登記、一起取代、一起撤**。 */
interface ThreadEntry {
  readonly sessions: SessionRegistry;
  readonly fs: FsService | undefined;
}

/** 一棵樹上活著的 thread 的註冊表。 */
export class ThreadSessions implements SessionLookupRegistrar {
  /** 鍵是 root 日誌 id（＝thread id）。 */
  readonly #live = new Map<string, ThreadEntry>();

  register(sessions: SessionRegistry, fs?: FsService): () => void {
    const key = sessions.root.sessionId;
    const entry: ThreadEntry = { sessions, fs };
    // 取代而不是並列：理由見檔頭「同一條 thread id 重組」。
    this.#live.set(key, entry);
    return () => {
      if (this.#live.get(key) === entry) this.#live.delete(key);
    };
  }

  /**
   * 這次呼叫該寫進哪一份日誌。挑法是 core 的 {@link pickSessionForCall}：沒有就 `not-attached`、一張時核對 `thread_id`（{@link VERIFY_SINGLE}）、
   * 多張依 `thread_id` 挑恰好一張。
   *
   * @param config - 工具 handler 的第二個參數。
   */
  forCall(config: unknown): SessionLookup {
    return pickSessionForCall(
      [...this.#live.values()].map((entry) => entry.sessions),
      config,
      VERIFY_SINGLE,
    );
  }

  /**
   * 這次呼叫該讀寫哪一條 thread 的 fs（#1466）。**挑的是同一筆登記**：用的是 core 的 {@link pickBoundForCall}，與
   * {@link forCall} 同一個演算法——沒有就 `not-attached`、只有一筆也核對 `thread_id`、多筆依 `thread_id` 挑恰好一筆、
   * 算不出位址是 `unknown-caller`。挑中的那一筆沒有 fs 把手（登記時沒給）當 `not-attached`：對模型是同一句話。
   *
   * @param config - 工具 handler 的第二個參數。
   */
  fsForCall(config: unknown): FsLookup {
    const picked = pickBoundForCall(
      this.#live.values(),
      (entry) => entry.sessions,
      config,
      VERIFY_SINGLE,
    );
    if (picked.kind !== 'ok') return picked;
    const fs = picked.bound.fs;
    return fs === undefined
      ? { kind: 'not-attached' }
      : { kind: 'ok', fs, address: picked.address };
  }

  /**
   * 依 root 會話 id（＝thread id）**精確**找回那條 thread 的 fs 把手（#1774）。給只有 `sessionLog` 的命令 handler 用
   * （`/permission` 不帶引數時報這條 thread 的可寫根）。
   *
   * 跟 {@link fsForCall} 不同，**不套「只剩一筆就是它」**：id 沒有登記（沒綁、已撤、別的行程的）就是 `undefined`，即使行程裡只剩一條活著的
   * thread。fs 是安全邊界（#1482），猜錯是讀到別條 thread 的根。登記時沒給 fs 把手的那一筆同樣是 `undefined`。
   *
   * @param threadId - root 會話 id。
   */
  fsForThread(threadId: string): FsService | undefined {
    return this.#live.get(threadId)?.fs;
  }

  /**
   * 依 root 會話 id（＝thread id）**精確**找回那條 thread 的會話註冊表（#1606，落盤確認用）。規則同 {@link fsForThread}：不套「只剩一筆就是它」，
   * 沒有登記就是 `undefined`——排空別條 thread 的註冊表證明不了這一份落了盤。
   *
   * @param threadId - root 會話 id。
   */
  sessionsForThread(threadId: string): SessionRegistry | undefined {
    return this.#live.get(threadId)?.sessions;
  }

  /** 現在登記著幾條。給測試與稽核對照。 */
  get size(): number {
    return this.#live.size;
  }
}
