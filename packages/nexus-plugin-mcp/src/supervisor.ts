/**
 * 一台 MCP server 的連線監督者（[#1099](https://github.com/DemianLi/nexus-agent/issues/1099)）：連線掉了之後用有上限的
 * 指數退避重連，照 dsh 的 `startConnection`（`packages/mcp/mcp-client/src/connection.ts`，`5badb150`）。
 *
 * ## 照 dsh 的部分
 *
 * - **退避**（`scheduleReconnect`，`:209-243`）：第一次 `initialDelayMs`（500），每次連續失敗加倍，上限 `maxDelayMs`
 *   （30000）；同一次中斷最多 `maxAttempts`（10）次，超過就放棄，不再重試。
 * - **預算重置**（`:224`）：上限同時是「穩定運行多久才算上一次中斷結束」——連上之後撐過 `maxDelayMs` 才掉線，失敗次數歸零。
 * - **一代一個決定**（`generationDown`，`:180-186`）：同一代的 close 事件與呼叫失敗兩個訊號賽跑，只有仍是目前這一代的才算。
 * - **dispose**（`:386-`）：取消待跑的計時器、等進行中的那次嘗試收斂，連上了就關；之後不再重連。
 * - 待跑的計時器 `unref`，不單獨撐住行程。
 * - **關閉有期限**（[#1543](https://github.com/DemianLi/nexus-agent/issues/1543)，`687f282e` 的 `connection.ts:51-54`、`:187-209`、`:388-407`）：
 *   收一代最多等 {@link GENERATION_CLOSE_TIMEOUT_MS}，要看到它真的關掉（呼叫端的 `closed`）才算數。dispose 等不到就記一句、照常
 *   回來；掉線之後等不到，就不重連、記一句，寧可停下也不讓兩代 server 同時活著。訊息的英文前半句逐字照 dsh。
 *
 * ## 偏離登記
 *
 * 1. **重連走 adapter 的 `close()` 再 `getTools()`，不開 adapter 內建的 `restart`**。內建的是固定間隔、固定次數
 *    （`@langchain/mcp-adapters` 2.0.0 `client.js:337,502`），沒有指數退避也沒有穩定期重置，表達不出 dsh 的政策；而且它重連之後
 *    已註冊的舊工具物件仍綁著死掉的 client（實測：`Not connected`，只有重新 `getTools()` 的新物件通）。所以退避自己做，
 *    已註冊的工具把 `func` 換成「委派給目前這一代同名工具」的薄包裝，舊物件因此不死。
 * 2. **工具集合不變**：dsh 重連之後重新同步工具（`syncTools`）、`tools/list_changed` 也會重新列出。deepagents 建好之後工具集合
 *    不可變，註冊表上的工具換不掉，所以**重連回來的新工具清單裡，原本沒有的工具不加、原本有的但這一代沒有的叫它回
 *    「不再提供」**；`tools/list_changed` 不處理，新工具在下一次組裝生效（PM 2026-10-08 決定維持明文限制）。
 * 3. **server 指引在載入期定下來**（`hub.ts` 檔頭偏離 2）：dsh 重連成功後會換成新一代的指引；這裡不換。
 * 4. **放棄時工具不撤**：dsh 放棄時把工具從註冊表撤掉；我們的註冊表在組裝之後撤了也沒有效果，所以留著，叫它得到說明
 *    「已放棄重連」的錯誤，要恢復得重新組裝。
 * 5. **起動時就連不上的那一列：只在 CLI 不重連**。dsh 初次失敗後同一個監督者繼續重試，連上就補工具。serve 的連線池
 *    （[#1677](https://github.com/DemianLi/nexus-agent/issues/1677)）照做：監督者一建立就擁有第一次連線，失敗就照退避排重試，連上之後
 *    組的對話拿得到工具；之前組好的照偏離 2 補不了。CLI 沒有池，一次組裝就是整個行程，補不了工具也就不重試
 *    （`index.ts` 檔頭既有的偏離）。
 * 6. **關閉期限退到最接近的做法**（#1543，三格）：
 *    - **握手中斷不了**（理由 1）：dsh 先關「連線中的那一代」來打斷握手（`connection.ts:277`、`:388-407`）。adapter
 *      （`@langchain/mcp-adapters` 2.0.0）不交出還沒連上的 client 或 transport，`close()` 也中止不了進行中的
 *      `_initializeConnection`，而且自己先等它（`connection.js` 的 `#closeAll`）。所以 dispose 照舊先等進行中的嘗試，但整段
 *      跟 {@link GENERATION_CLOSE_TIMEOUT_MS} 賽跑，到期就記 dsh 那一句、照常回來。被丟下的嘗試落定之後照樣收（連上了就關、
 *      失敗了 adapter 自己收），只是那個子行程比 thread 多活一段，最多到它的握手逾時。
 *    - **屏障掛在「已連上的那一代被 down」**（理由 1）：dsh 的屏障在**失敗的連線嘗試**上（`connection.ts:187-197`、
 *      `:323-331`），已連上的那一代由自己的 `onclose` 證明已經關掉、直接 `generationDown`。握手失敗時 adapter 自己收掉 client
 *      與 transport（`connection.js:122-124`），我們拿不到那個 close 訊號，所以退到最接近的一格：已連上的那一代被 `down`
 *      （例如工具呼叫失敗判成斷線、transport 其實還開著）時，先關、確認它真的關掉，才排重連；確認不到就不排。失敗的嘗試靠
 *      SDK stdio 自帶的兩段 2 秒寬限之後 SIGKILL。期限包住「關」與「等關掉」整段，不是關完才起算。
 *    - **CLI 那條只有一級日誌**（理由 1）：dsh 這兩句是 error 級；插件 logger 只有 warn（`@nexus/core` `registry.ts:679`、`:705`），
 *      #1534 也定了不擴充它的等級。所以每次組裝自己連的那條把 {@link SupervisorHooks.error} 接到 warn，等 MCP 遷上樹改用
 *      `ctx.logger.error`。serve 的連線池寫伺服器日誌，那裡有 error 級，照 dsh 接 error（`pool.ts`）。
 *
 * 這個檔案不認識 MCP：一代是什麼、怎麼連、怎麼關、怎麼偵測斷線都由呼叫端給，所以退避與預算可以用假計時器逐步測。
 *
 * @module
 */

import { z } from 'zod';

/**
 * 收一代連線最多等多久（毫秒），照 dsh 的 `GENERATION_CLOSE_TIMEOUT_MS`（`connection.ts:51-54`）。SDK 的 stdio transport
 * 自帶兩段 2 秒的終止寬限，再多留 1 秒給子行程的 close 事件來證明舊的一代真的沒了；逾時就停下來，不讓兩代子行程重疊。
 */
export const GENERATION_CLOSE_TIMEOUT_MS = 5_000;

/** 重連政策，欄位與預設一字不差照 dsh 的 `ReconnectConfig`／`RECONNECT_DEFAULTS`（`connection.ts:28-47`）。 */
export const reconnectSchema = z
  .strictObject({
    /** 掉線之後要不要自動重連，預設 `true`。 */
    enabled: z.boolean().default(true),
    /** 第一次重連前等多久（毫秒）；每次連續失敗加倍。預設 500。 */
    initialDelayMs: z.number().positive().finite().default(500),
    /** 退避上限（毫秒），同時是「穩定運行多久之後失敗次數歸零」。預設 30000。 */
    maxDelayMs: z.number().positive().finite().default(30_000),
    /** 同一次中斷最多連續失敗幾次就放棄，預設 10。 */
    maxAttempts: z.number().int().min(1).default(10),
  })
  .refine((policy) => policy.initialDelayMs <= policy.maxDelayMs, {
    message: 'initialDelayMs 不能大於 maxDelayMs',
    path: ['initialDelayMs'],
  });

/** 驗過的重連政策。 */
export type ReconnectPolicy = z.infer<typeof reconnectSchema>;

/** 監督者需要呼叫端提供的東西。`G` 是「一代連線」，由呼叫端定義。 */
export interface SupervisorHooks<G> {
  /** 診斷訊息的前綴，例如 `mcp-client(github)`。 */
  readonly label: string;
  readonly policy: ReconnectPolicy;
  /** 一次連線嘗試；失敗要拋。自己負責先收掉上一代殘留的東西。 */
  connect(): Promise<G>;
  /** 收掉一代。要冪等；監督者會忽略它的錯誤。 */
  close(generation: G): Promise<void>;
  /**
   * 這一代**真的關掉了**才落定（例如子行程的 close 事件），不能只是「`close` 回來了」：stdio 的 `close()` 送出 SIGKILL
   * 之後不等就回。沒有東西可等的一代（沒接上 transport）要立刻落定。
   */
  closed(generation: G): Promise<void>;
  /** dispose 最後收掉一代以外的殘留（例如失敗的嘗試留下的連線）；跟關閉算在同一個期限裡。 */
  release?(): Promise<void>;
  /**
   * 一代連上之後，安排「這一代斷了」時呼叫 `onDown`（例如掛 transport 的 close 事件）。
   * 另一個訊號來源是呼叫端在工具呼叫失敗時自己呼叫 {@link Supervisor.down}。
   */
  watch(generation: G, onDown: () => void): void;
  /** 給人看的訊息（警告、放棄、重連成功都走這裡）。 */
  report(message: string): void;
  /** 照 dsh 是 error 級的那幾句：關閉確認不到（偏離 6）。 */
  error(message: string): void;
  /** 現在的毫秒時鐘，測試可替換；預設 `Date.now`。 */
  readonly now?: () => number;
}

/** 第一次連線的結果，照 dsh 的 `ready`（`connection.ts:348-364`）：只回報，不拋。 */
export type FirstAttempt = { readonly ok: true } | { readonly ok: false; readonly error: unknown };

/**
 * 一台 server 的連線監督者。第 0 代有三種給法：
 *
 * - **已經連上的那一代**：直接採用。
 * - **還在連的那一次**（`Promise`，serve 的連線池，[#1677](https://github.com/DemianLi/nexus-agent/issues/1677)）：監督者從這一刻起
 *   就擁有它，照 dsh 的 `settling = connectGeneration(true)`（`connection.ts:346`）。連上就採用；失敗時 `retryFirstFailure` 決定
 *   要不要照退避排下一次（`failOnStartupError` 那一列不排，由呼叫端收掉）。結果經 {@link ready} 回報。
 * - **`undefined`**：第一次就連不上，立刻照退避排下一次（照 dsh 初次失敗也走 `scheduleReconnect`，`connection.ts:209-243`）。
 */
export class Supervisor<G> {
  private readonly hooks: SupervisorHooks<G>;
  private generation: G | undefined;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failedAttempts = 0;
  private connectedAt: number | undefined;
  private attempt: Promise<void> = Promise.resolve();
  private gaveUpFlag = false;
  private settleReady!: (outcome: FirstAttempt) => void;
  /**
   * 第一次連線落定時回報結果；**dispose 時立刻以失敗落定**，等它的組裝不會被一次卡住的握手拖過關機。先落定的那一個算數。
   */
  readonly ready: Promise<FirstAttempt>;

  constructor(
    hooks: SupervisorHooks<G>,
    initial: G | Promise<G> | undefined,
    options: { readonly retryFirstFailure?: boolean } = {},
  ) {
    this.hooks = hooks;
    this.ready = new Promise((resolve) => {
      this.settleReady = resolve;
    });
    if (initial instanceof Promise) {
      this.attempt = this.settle(initial, options.retryFirstFailure ?? true).then((outcome) => {
        this.settleReady(outcome);
      });
    } else if (initial === undefined) {
      this.settleReady({ ok: false, error: undefined });
      this.schedule(false);
    } else {
      this.adopt(initial);
      this.settleReady({ ok: true });
    }
  }

  /** 目前這一代；掉線等待重連的期間、放棄之後、dispose 之後是 `undefined`。 */
  current(): G | undefined {
    return this.generation;
  }

  /** 是否已經耗盡預算放棄重連（或政策是關的）。 */
  get gaveUp(): boolean {
    return this.gaveUpFlag;
  }

  /**
   * 通報某一代斷了。**冪等**：不是目前這一代（已經被通報過、或已經換代）就什麼都不做。
   * @param generation - 收到訊號的那一代。
   */
  down(generation: G): void {
    if (this.disposed || this.generation !== generation) return;
    this.generation = undefined;
    this.attempt = this.retire(generation);
  }

  /** 先確認掉線的那一代真的關掉，才排重連；確認不到就停下（照 dsh `settleFailedGeneration`，`connection.ts:187-197`）。 */
  private async retire(generation: G): Promise<void> {
    const confirmed = await settlesWithin(this.closeAndWait(generation));
    if (this.disposed) return;
    if (!confirmed) {
      this.gaveUpFlag = true;
      this.hooks.error(
        `${this.hooks.label}: failed generation could not confirm transport closure — reconnect stopped to avoid overlapping server processes; 要重試得重新組裝（下一條 thread 或重啟 serve）`,
      );
      return;
    }
    this.schedule(true);
  }

  /**
   * 取消待跑的重連、等進行中的那次收斂、關掉目前這一代；之後不再重連。整段最多等 {@link GENERATION_CLOSE_TIMEOUT_MS}，
   * 等不到就記一句、照常回來（不拋，照 dsh）。
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.settleReady({
      ok: false,
      error: new Error(`${this.hooks.label}: disposed before the first connection settled`),
    });
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!(await settlesWithin(this.quiesce()))) {
      this.hooks.error(
        `${this.hooks.label}: transport closure could not be confirmed during disposal — server shutdown may be incomplete`,
      );
    }
  }

  private async quiesce(): Promise<void> {
    await this.attempt;
    const generation = this.generation;
    this.generation = undefined;
    if (generation !== undefined) await this.closeAndWait(generation);
    await this.hooks.release?.().catch(() => {});
  }

  /** 關掉一代並等它真的關掉；永不拋。 */
  private async closeAndWait(generation: G): Promise<void> {
    await this.hooks.close(generation).catch(() => {});
    await this.hooks.closed(generation);
  }

  private now(): number {
    return (this.hooks.now ?? Date.now)();
  }

  private adopt(generation: G): void {
    this.generation = generation;
    this.connectedAt = this.now();
    this.hooks.watch(generation, () => {
      this.down(generation);
    });
  }

  private schedule(lostEstablished: boolean): void {
    const { policy, label } = this.hooks;
    if (!policy.enabled) {
      this.gaveUpFlag = true;
      // 兩句分開，照 dsh（`connection.ts:211-216`）：連上過才掉線，與第一次就連不上，後者沒有登記任何工具。
      this.hooks.report(
        lostEstablished
          ? `${label}: connection lost and reconnect is disabled — registered tools will fail until the plugin is assembled again`
          : `${label}: connection failed and reconnect is disabled — no tools were registered; the next assembly connects again`,
      );
      return;
    }
    // 連上之後撐過穩定期（= maxDelayMs，最長的退避間隔）才掉線，上一次中斷就算結束，重新給一份預算。
    if (this.connectedAt !== undefined && this.now() - this.connectedAt >= policy.maxDelayMs) {
      this.failedAttempts = 0;
    }
    this.connectedAt = undefined;
    this.failedAttempts += 1;
    if (this.failedAttempts > policy.maxAttempts) {
      this.gaveUpFlag = true;
      this.hooks.report(
        `${label}: giving up after ${String(policy.maxAttempts)} consecutive failed reconnect attempts — registered tools will fail until the plugin is assembled again`,
      );
      return;
    }
    const delayMs = Math.min(
      policy.maxDelayMs,
      policy.initialDelayMs * 2 ** (this.failedAttempts - 1),
    );
    const action = lostEstablished
      ? 'connection lost; reconnecting'
      : 'connection failed; retrying';
    this.hooks.report(
      `${label}: ${action} in ${String(delayMs)}ms (attempt ${String(this.failedAttempts)}/${String(policy.maxAttempts)})`,
    );
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.attempt = this.connectOnce();
    }, delayMs);
    // 待跑的重連計時器不該單獨撐住行程。
    this.timer.unref();
  }

  /** 一次重連嘗試；永不拋。 */
  private async connectOnce(): Promise<void> {
    await this.settle(this.hooks.connect(), true);
  }

  /** 等一次嘗試落定：連上就採用，失敗就照退避排下一次（`retry` 為假時不排）；之後 dispose 了就把連上的那一代收掉。永不拋。 */
  private async settle(pending: Promise<G>, retry: boolean): Promise<FirstAttempt> {
    let next: G;
    try {
      next = await pending;
    } catch (error) {
      if (this.disposed || !retry) return { ok: false, error };
      this.hooks.report(`${this.hooks.label}: connection attempt failed: ${String(error)}`);
      this.schedule(false);
      return { ok: false, error };
    }
    if (this.disposed) {
      await this.closeAndWait(next);
      return { ok: false, error: new Error(`${this.hooks.label}: disposed`) };
    }
    this.adopt(next);
    if (this.failedAttempts > 0) {
      this.hooks.report(
        `${this.hooks.label}: reconnected (attempt ${String(this.failedAttempts)}/${String(this.hooks.policy.maxAttempts)})`,
      );
    }
    return { ok: true };
  }
}

/**
 * `work` 在 {@link GENERATION_CLOSE_TIMEOUT_MS} 內落定就是 `true`，逾時是 `false`，照 dsh 的 `waitForClose`
 * （`connection.ts:199-209`）。計時器 `unref`、落定就清掉，不單獨撐住行程。`work` 被拒絕算沒確認到，等到逾時。
 */
function settlesWithin(work: Promise<void>): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve(false);
    }, GENERATION_CLOSE_TIMEOUT_MS);
    timeout.unref();
    work.then(
      () => {
        clearTimeout(timeout);
        resolve(true);
      },
      () => {},
    );
  });
}
