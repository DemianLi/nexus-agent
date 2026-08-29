/**
 * 遙測的**捕獲協調器**：把一份 {@link ./session-log.ts | SessionLog} 投影成
 * {@link ./session-telemetry.ts | SessionTelemetryRecord}，跑過脫敏折疊，交給後端。
 *
 * 形狀照 dsh 的 `SessionTelemetryCoordinator`
 * （`references/deepseek-harness/packages/session/session-telemetry/src/coordinator.ts`）：
 * 兩條捕獲路徑（live 跟著日誌走、on-demand 只在被要求時讀）、一個交付游標、
 * 每一步各自圍堵。
 *
 * **每一步都圍堵，是因為捕獲跑在 agent loop 的熱路徑上。** 遙測是盡力而為的旁路，
 * 後端壞掉、脫敏規則拋錯，都只能換來一行 warn——**不能有能力扳倒 loop**。
 *
 * @see [#89](https://github.com/DemianLi/nexus-agent/issues/89)
 */

import { formatOrigin } from './plugin.js';
import type { SessionEvent, SessionLog } from './session-log.js';
import type {
  SessionTelemetryRecord,
  SessionTelemetryRedactRule,
  SessionTelemetrySeverity,
  SessionTelemetrySink,
} from './session-telemetry.js';
import type { NamedEntry } from './entries.js';

/** 捕獲是跟著日誌走，還是只在被要求時讀。 */
export type SessionTelemetryCapture = 'live' | 'on-demand';

export interface SessionTelemetryCoordinatorOptions {
  /** 要鏡像的日誌。 */
  readonly log: SessionLog;
  /** 收記錄的後端。**這裡不擁有它**，除了關機時轉發 `shutdown()`。 */
  readonly sink: SessionTelemetrySink;
  /**
   * 目前掛著的脫敏規則，**每次捕獲時現讀**。
   *
   * 是 getter 而不是一份陣列，因為 dsh 的 waterfall 就是「用捕獲當下掛著的規則」——
   * on-demand 補送歷史時套的是**現在**的策略，不是事件發生當時的。省略即無規則，
   * 記錄原樣送出：**匯出的資料有多乾淨，取決於部署掛了什麼**，這一層自己不帶規則。
   */
  readonly rules?: () => readonly NamedEntry<SessionTelemetryRedactRule>[];
  /** 圍堵下來的失敗往哪裡講。省略即 `console.warn`。 */
  readonly warn?: (message: string) => void;
  /** 省略即 `live`。 */
  readonly capture?: SessionTelemetryCapture;
}

/**
 * 一份日誌一個。
 *
 * `live` 會在建構當下**補送日誌裡已經有的東西**再訂閱後續——協調器晚於日誌成立是常態
 * （日誌在 pump / CLI 起來時就建了），少補這一段就等於開頭那幾筆永遠不會出去。
 */
export class SessionTelemetryCoordinator {
  readonly #log: SessionLog;
  readonly #sink: SessionTelemetrySink;
  readonly #rules: () => readonly NamedEntry<SessionTelemetryRedactRule>[];
  readonly #warn: (message: string) => void;
  /**
   * 交付游標：**交出去過的最高 `seq`**，還沒交過任何一筆時是 `-1`。
   *
   * 「交出去過」不是「送達了」——`emit()` 回來就算數，送達是後端 SDK 的事。被扣住的
   * 記錄（脫敏拋錯、後端拋錯）**不推進游標**，所以下一次 {@link captureNow} 會再試一遍。
   */
  #cursor = -1;
  #unsubscribe: (() => void) | undefined;
  #disposed = false;

  constructor(options: SessionTelemetryCoordinatorOptions) {
    this.#log = options.log;
    this.#sink = options.sink;
    this.#rules = options.rules ?? (() => []);
    this.#warn =
      options.warn ??
      ((message) => {
        console.warn(message);
      });
    if ((options.capture ?? 'live') === 'live') {
      this.captureNow();
      this.#unsubscribe = this.#log.subscribe((event) => {
        this.#contain(() => {
          this.#captureEvent(event);
        });
      });
    }
  }

  /**
   * 把游標之後的日誌後綴補送出去。live 在建構時自己叫一次；on-demand 的呼叫端自己叫。
   *
   * **圍堵是逐筆的**：一筆被扣住不影響同一次補送裡的其他筆。
   */
  captureNow(): void {
    for (const event of this.#log.events) {
      if (event.seq <= this.#cursor) continue;
      this.#contain(() => {
        this.#captureEvent(event);
      });
    }
  }

  /**
   * 收掉：退訂、發一筆 `shutdown` 的 ops 記錄、轉發後端的 `shutdown()`。
   *
   * 呼叫第二次是 no-op。後端 reject 只換來一行 warn——**盡力而為的旁路不該有讓應用程式
   * 關機失敗的權力**（dsh 同一條）。
   *
   * @returns 後端靜止（或關機失敗已被記下）之後 resolve。
   */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    // 先發 shutdown 標記再叫後端關機：這一筆必須排在後端排空之前進到隊列裡。
    this.#contain(() => {
      this.#deliver(this.#redact(this.#shutdownRecord()));
    });
    try {
      await this.#sink.shutdown();
    } catch (error: unknown) {
      this.#warn(`遙測：後端關機失敗——${String(error)}`);
    }
  }

  /** 投影一筆事件、脫敏、交出去，然後推進游標。 */
  #captureEvent(event: SessionEvent): void {
    const record = this.#redact({
      channel: 'ledger',
      time: event.time,
      severity: severityOf(event),
      attributes: {
        'session.id': this.#log.sessionId,
        'event.type': event.type,
        'event.seq': event.seq,
      },
      // **拷一份，不借用。** 借的話送出去的 body 就是正典日誌裡那個物件，脫敏規則或
      // 後端就地一改等於改寫歷史。今天那還會被 `deepFreeze` 擋成一個看不懂的失敗
      // （sloppy 模式無聲失效、strict 模式拋錯然後被記成「規則扣住了記錄」），明天多
      // 一種沒凍過的 body 就是真的共享可變交接。append 當下驗過純 JSON，所以這裡拷得動。
      body: structuredClone(event.data),
    });
    this.#deliver(record);
    this.#cursor = event.seq;
    // turn 的終結事件兼任 dsh 的 `session/flush`：語意一樣（turn 邊界），來源不同
    // （日誌事件本身，因為我們沒有事件匯流排可以另發一條）。
    //
    // **自己一格圍堵**：這一筆已經交出去、游標也推進了，flush 只是提示。跟捕獲共用同
    // 一格的話，一個會拋的 `flush()` 會讓 warn 說「捕獲步驟失敗」——而那筆其實成功了，
    // 訊息是這裡唯一的診斷，不能說謊。
    if (event.type === 'turn/end' || event.type === 'turn/failed') {
      this.#contain(() => this.#sink.flush?.());
    }
  }

  /**
   * 依註冊順序折疊脫敏規則。沒有規則時原樣通過。
   *
   * 呼叫端都在 {@link #contain} 裡面，所以**一條規則拋錯 = 那一筆被扣住**（fail-closed），
   * 而不是外洩到 loop。錯誤訊息指名是哪一次掛載拋的——扣住一筆卻講不出是誰扣的，
   * 等於沒辦法 debug。
   */
  #redact(record: SessionTelemetryRecord): SessionTelemetryRecord {
    let current = record;
    for (const entry of this.#rules()) {
      try {
        current = entry.value(current);
      } catch (error: unknown) {
        throw new Error(
          `${formatOrigin(entry.origin)} 掛的脫敏規則拋了，這一筆記錄被扣住：${String(error)}`,
          { cause: error },
        );
      }
    }
    return current;
  }

  /** 交一筆給後端。 */
  #deliver(record: SessionTelemetryRecord): void {
    this.#sink.emit(record);
  }

  /** 這個會話的乾淨結束標記。ops channel，**沒有 `event.seq`**。 */
  #shutdownRecord(): SessionTelemetryRecord {
    return {
      channel: 'ops',
      time: Date.now(),
      severity: 'info',
      attributes: { 'telemetry.op': 'shutdown', 'session.id': this.#log.sessionId },
      body: { op: 'shutdown' },
    };
  }

  /** 跑一步捕獲，例外不外洩。 */
  #contain(step: () => void): void {
    try {
      step();
    } catch (error: unknown) {
      this.#warn(`遙測：捕獲步驟失敗——${String(error)}`);
    }
  }
}

/**
 * 事件自己的結果決定告警等級。
 *
 * 這裡刻意**不寫 exhaustive 的 assertNever**：後來加的事件種類預設是 `info`，它們的
 * 結果語意歸它們自己的擁有者，不歸這裡。dsh 同一條理由。
 */
function severityOf(event: SessionEvent): SessionTelemetrySeverity {
  return event.type === 'turn/failed' ? 'error' : 'info';
}
