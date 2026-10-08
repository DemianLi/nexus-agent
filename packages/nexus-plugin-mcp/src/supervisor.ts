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
 * 5. **起動時就連不上的那一列不重連**：dsh 初次失敗後同一個監督者繼續重試，連上就補工具；我們補不了工具（偏離 2），
 *    所以不重試，下一次組裝才再連（`index.ts` 檔頭既有的偏離）。
 *
 * 這個檔案不認識 MCP：一代是什麼、怎麼連、怎麼關、怎麼偵測斷線都由呼叫端給，所以退避與預算可以用假計時器逐步測。
 *
 * @module
 */

import { z } from 'zod';

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
   * 一代連上之後，安排「這一代斷了」時呼叫 `onDown`（例如掛 transport 的 close 事件）。
   * 另一個訊號來源是呼叫端在工具呼叫失敗時自己呼叫 {@link Supervisor.down}。
   */
  watch(generation: G, onDown: () => void): void;
  /** 給人看的訊息（警告、放棄、重連成功都走這裡）。 */
  report(message: string): void;
  /** 現在的毫秒時鐘，測試可替換；預設 `Date.now`。 */
  readonly now?: () => number;
}

/** 一台 server 的連線監督者；建構時第 0 代已經連上。 */
export class Supervisor<G> {
  private readonly hooks: SupervisorHooks<G>;
  private generation: G | undefined;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failedAttempts = 0;
  private connectedAt: number | undefined;
  private attempt: Promise<void> = Promise.resolve();
  private gaveUpFlag = false;

  constructor(hooks: SupervisorHooks<G>, initial: G) {
    this.hooks = hooks;
    this.adopt(initial);
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
    this.hooks.close(generation).catch(() => {});
    this.schedule(true);
  }

  /** 取消待跑的重連、等進行中的那次收斂、關掉目前這一代；之後不再重連。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.attempt;
    const generation = this.generation;
    this.generation = undefined;
    if (generation !== undefined) await this.hooks.close(generation).catch(() => {});
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
      this.hooks.report(
        `${label}: connection lost and reconnect is disabled — registered tools will fail until the plugin is assembled again`,
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

  /** 一次嘗試；永不拋。 */
  private async connectOnce(): Promise<void> {
    let next: G;
    try {
      next = await this.hooks.connect();
    } catch (error) {
      if (this.disposed) return;
      this.hooks.report(`${this.hooks.label}: connection attempt failed: ${String(error)}`);
      this.schedule(false);
      return;
    }
    if (this.disposed) {
      await this.hooks.close(next).catch(() => {});
      return;
    }
    this.adopt(next);
    if (this.failedAttempts > 0) {
      this.hooks.report(
        `${this.hooks.label}: reconnected (attempt ${String(this.failedAttempts)}/${String(this.hooks.policy.maxAttempts)})`,
      );
    }
  }
}
