/**
 * 會話遙測的 OpenTelemetry 後端——[#89](https://github.com/DemianLi/nexus-agent/issues/89)
 * 兩張裡的第二張。
 *
 * **原樣配置 OTel JS SDK**：一個 `LoggerProvider`、一個 `BatchLogRecordProcessor`、
 * 一個 OTLP/HTTP 的 log exporter，把協調器交過來的每一筆 `SessionTelemetryRecord`
 * 映到 `logger.emit()`。**那一次呼叫之後的一切**——批次、重試、排隊、丟失策略——
 * 全部是 SDK 有文件的行為，靠兩個原樣轉交的選項物件設定。形狀照
 * `references/deepseek-harness/packages/session/session-telemetry-otel/src/index.ts`。
 *
 * 這個套件自己擁有的只有兩件：**mode**，以及**一個外層的關機期限**（SDK 的 export
 * timeout 只包住 `exportCompleted`，包不住它前面那次 `forceFlush()` 的等待）。
 *
 * ## 為什麼自己一包
 *
 * 5 個 `@opentelemetry/*` 是這個 repo 第一次吃這種規模的執行期相依樹。照
 * `@nexus/plugin-quickjs` 與 `@nexus/plugin-mcp` 的先例：**重的相依歸 plugin 自己，
 * `@nexus/core` 保持輕**。
 *
 * ## 三條偏離（AGENTS.md 的偏離規則）
 *
 * **一、`FEEDBACK_ONLY` 沒有來源。** dsh 那個 mode 靠 `feedback/record` 這個 session
 * 事件驅動（`dsh-command-feedback` 的 `/feedback` 指令），協調器在 on-demand 模式下
 * 只在收到它時補送到那個 `seq` 為止。**nexus 沒有 feedback 子系統，`SessionEventMap`
 * 裡也沒有那個事件種類**，所以這裡只出 `full` 與 `disabled`。`'feedback-only'` 仍在
 * seam 的披露字彙裡（那是 seam 的字彙不是這裡的），只是沒有 mode 產得出它。
 * **來源不存在，不是省略。**
 *
 * **二、Resource 上沒有 `user.id`。** dsh 放 `getOrCreateAnonymousUserId()`
 * （`dsh-anonymous-user-id`，存在 `~/.dsh`）。nexus 沒有那個套件、也沒有 harness home
 * 的概念，**不編一個**——退到不送。偏離的方向是往少送那一邊。
 *
 * **三、Config 驗證：schemastery ＋ cordis loader → 工廠函式當場驗。** dsh 的 `Config`
 * 是 schemastery 的 `z<Config>`，由 cordis 在 plugin 起來之前跑，只驗頂層；值檢查留在
 * constructor 裡好讓錯誤訊息指得出欄位。**我們沒有會跑 Config schema 的 loader**
 * ——`NexusPlugin` 的形狀是 `apply(registry)`，設定從工廠函式的參數進來。退到最接近的：
 * **四條值檢查照抄進工廠函式**，訊息一樣指名欄位。兩個 SDK 選項物件照 dsh 原樣轉交、
 * 不重新宣告——重宣告會靜靜吃掉所有沒被抄到的欄位。
 *
 * @module @nexus/plugin-telemetry-otel
 */

import type {
  NexusPlugin,
  SessionTelemetryRecord,
  SessionTelemetryService,
  SessionTelemetrySeverity,
  SessionTelemetrySharingStatus,
} from '@nexus/core';
import { SeverityNumber } from '@opentelemetry/api-logs';
import type { AnyValue, Logger } from '@opentelemetry/api-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import type { OTLPExporterNodeConfigBase } from '@opentelemetry/otlp-exporter-base';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';
import type { BatchLogRecordProcessorOptions } from '@opentelemetry/sdk-logs';

/** 這個 plugin 的名字，也是錯誤訊息的前綴。 */
export const PLUGIN_NAME = 'telemetry-otel';

/** instrumentation scope 的名字。ledger 與 ops 各一個，收端才分得開。 */
const LEDGER_SCOPE = '@nexus/plugin-telemetry-otel';
const OPS_SCOPE = '@nexus/plugin-telemetry-otel/ops';
const SCOPE_VERSION = '0.0.0';

/**
 * 共享策略，**只有兩個**。
 *
 * `'feedback-only'` 不在這裡——見模組說明的偏離一。
 */
export type TelemetryMode = 'full' | 'disabled';

/** 省略即關閉。**預設要是不送的那一個**，跟 dsh 的 `DEFAULT_TELEMETRY_MODE` 同一條。 */
export const DEFAULT_TELEMETRY_MODE: TelemetryMode = 'disabled';

/** SDK 完整關機流程的外層預設寬限。 */
export const DEFAULT_SHUTDOWN_TIMEOUT_MILLIS = 3_000;

// Node 會把超過這個值的計時器延遲夾成一毫秒。這是執行期的協定上限，不是部署預設值。
const MAX_TIMER_DELAY_MILLIS = 2_147_483_647;

/** seam 的三級告警詞彙映到 OTel 的 severity。 */
const SEVERITY: Record<
  SessionTelemetrySeverity,
  { severityNumber: SeverityNumber; severityText: string }
> = {
  info: { severityNumber: SeverityNumber.INFO, severityText: 'INFO' },
  warn: { severityNumber: SeverityNumber.WARN, severityText: 'WARN' },
  error: { severityNumber: SeverityNumber.ERROR, severityText: 'ERROR' },
};

export interface TelemetryOtelOptions {
  /** 共享策略。省略即 {@link DEFAULT_TELEMETRY_MODE}。 */
  readonly mode?: TelemetryMode;
  /**
   * **原樣轉交** SDK 的 OTLP/HTTP log exporter，完整的 `OTLPExporterNodeConfigBase`
   * 形狀（`headers`、`timeoutMillis`、`compression`、`keepAlive`……）由 SDK 擁有與
   * 記錄。`url` 是這個套件唯一自己要求並驗證的欄位。
   */
  readonly exporter?: OTLPExporterNodeConfigBase & {
    /** 完整的 logs 端點（例如 `https://collector.example.com/v1/logs`）。`disabled` 之外必填。 */
    readonly url?: string;
  };
  /** **原樣轉交** `BatchLogRecordProcessor`（除了 exporter 那一格由這裡填）。 */
  readonly processor?: Omit<BatchLogRecordProcessorOptions, 'exporter'>;
  /** 等 SDK 完整關機的上限。省略即 {@link DEFAULT_SHUTDOWN_TIMEOUT_MILLIS}。 */
  readonly shutdownTimeoutMillis?: number;
  /** Resource 的 `service.name`。省略即 `nexus-agent`。 */
  readonly serviceName?: string;
  /** Resource 的 `service.version`。省略即不放這個屬性。 */
  readonly serviceVersion?: string;
}

function fail(message: string): never {
  throw new Error(`${PLUGIN_NAME}：${message}`);
}

/**
 * 驗 `exporter.url`。
 *
 * 三條照抄 dsh：必填、必須 parse 得動、必須是 http(s)。**在工廠函式當場拋**，不是等到
 * 第一筆記錄要送的時候——設定錯了要在載入期爆，不是在熱路徑上靜靜地掉資料。
 */
function assertExporterUrl(url: string | undefined): string {
  if (url === undefined || url.length === 0) {
    fail('exporter.url 是必填的（完整的 OTLP logs 端點）');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    fail(`exporter.url 不是合法的 URL：${JSON.stringify(url)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    fail(`exporter.url 必須是 http(s)，拿到的是 ${parsed.protocol}`);
  }
  return url;
}

/**
 * 驗 `processor.maxExportBatchSize`。
 *
 * **這是唯一一個超出 SDK 自己驗證範圍的 processor 欄位**，照抄 dsh 的理由：SDK 收得下
 * 非正數的批次大小，但它的關機排空接著會切出一堆空批次而不消耗佇列——**佇列裡還有東西
 * 的話 dispose 會永遠掛住**。設定錯了在載入期就爆。
 */
function assertBatchSize(size: number | undefined): void {
  if (size === undefined) return;
  if (!Number.isInteger(size) || size < 1) {
    fail(`processor.maxExportBatchSize 必須是正整數，拿到的是 ${String(size)}`);
  }
}

function assertShutdownTimeout(millis: number): number {
  if (!Number.isFinite(millis) || millis <= 0 || millis > MAX_TIMER_DELAY_MILLIS) {
    fail(
      `shutdownTimeoutMillis 必須是大於 0 且不超過 ${MAX_TIMER_DELAY_MILLIS} 的有限數，` +
        `拿到的是 ${String(millis)}`,
    );
  }
  return millis;
}

/**
 * 掛得上 `registry.telemetry.use()` 的 OTel 服務。
 *
 * `disabled` 完全不建 SDK 狀態：`emit` 是 no-op、`shutdown` 立刻 resolve。**它仍然是
 * 一個掛著的服務**，所以披露會說「已掛後端但策略是關閉」而不是「未配置」——那兩件事
 * 不一樣，dsh 的規矩是只有一個都沒掛才渲染未配置。
 */
export class OpenTelemetrySessionService implements SessionTelemetryService {
  readonly sharing: SessionTelemetrySharingStatus;
  readonly #provider: LoggerProvider | undefined;
  readonly #ledger: Logger | undefined;
  readonly #ops: Logger | undefined;
  readonly #shutdownTimeoutMillis: number;

  constructor(options: TelemetryOtelOptions = {}) {
    const mode = options.mode ?? DEFAULT_TELEMETRY_MODE;
    this.sharing = mode;
    if (mode === 'disabled') {
      this.#provider = undefined;
      this.#ledger = undefined;
      this.#ops = undefined;
      this.#shutdownTimeoutMillis = DEFAULT_SHUTDOWN_TIMEOUT_MILLIS;
      return;
    }

    assertExporterUrl(options.exporter?.url);
    assertBatchSize(options.processor?.maxExportBatchSize);
    this.#shutdownTimeoutMillis = assertShutdownTimeout(
      options.shutdownTimeoutMillis ?? DEFAULT_SHUTDOWN_TIMEOUT_MILLIS,
    );

    this.#provider = new LoggerProvider({
      resource: resourceFromAttributes({
        'service.name': options.serviceName ?? 'nexus-agent',
        ...(options.serviceVersion !== undefined && { 'service.version': options.serviceVersion }),
        // dsh 這裡還有一個 `user.id`（匿名識別）。**我們不編一個**，見模組說明的偏離二。
      }),
      processors: [
        new BatchLogRecordProcessor({
          ...options.processor,
          // 驗過的 exporter 物件**整個原樣傳進去**：`timeoutMillis`、`compression`、
          // `keepAlive`……每個 SDK 選項都到得了。在這裡挑欄位重建會靜靜吃掉其餘的。
          exporter: new OTLPLogExporter(options.exporter),
        }),
      ],
    });
    this.#ledger = this.#provider.getLogger(LEDGER_SCOPE, SCOPE_VERSION);
    this.#ops = this.#provider.getLogger(OPS_SCOPE, SCOPE_VERSION);
  }

  /**
   * 入隊一筆。**非阻塞**——`logger.emit()` 就是 SDK 的入隊，批次與送出歸 processor。
   *
   * ledger 與 ops 走**兩個不同的 instrumentation scope**，收端因此分得開：ops 是告警
   * 訊號、重複被容忍，ledger 是可累加的條目、靠 `(session.id, event.seq)` 去重。
   *
   * @param record - 協調器交過來、已經脫敏過的那一筆。
   */
  emit(record: SessionTelemetryRecord): void {
    const logger = record.channel === 'ops' ? this.#ops : this.#ledger;
    // `disabled` 沒有 logger，這一筆就地丟掉——連 SDK 都不建。
    if (logger === undefined) return;
    logger.emit({
      timestamp: record.time,
      observedTimestamp: record.time,
      ...SEVERITY[record.severity],
      // seam 的契約保證是純 JSON（append 當下驗過），那正好是 AnyValue 的子集。
      body: record.body as AnyValue,
      attributes: record.attributes,
    });
  }

  // seam 那個選配的 `flush()` **刻意不實作**。batch processor 有自己的送出節奏
  // （`processor.scheduledDelayMillis`，SDK 有文件的旋鈕），而這個後端是那條 SDK
  // 流水線唯一的呼叫者——把 hint 轉成 `forceFlush()` 會讓它變成並行 flush 的**唯一**
  // 來源，而並行 flush 跟 shutdown 內部排空的互動（並行 flush 護欄、provider 層的
  // flush timeout）沒有文件，會靜靜掉尾巴的記錄。照抄 dsh 的決定。

  /**
   * 請 SDK 排空並靜止，但**超過自己的期限就 reject**。
   *
   * OTel 的 processor export timeout 只包住 `exportCompleted`；shutdown 會先 await
   * `exporter.forceFlush()`，而傳輸拿不到 socket 的時候那個 promise 可以一直 pending。
   * 期限之後 provider 那個 promise **仍然被觀察著**，這樣它晚一點 reject 也不會變成
   * unhandled rejection。`disabled` 沒有 provider，立刻 resolve。
   *
   * @returns SDK 流水線靜止時 resolve，或在設定的期限 reject。
   */
  async shutdown(): Promise<void> {
    const provider = this.#provider;
    if (provider === undefined) return;
    const providerShutdown = provider.shutdown();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${PLUGIN_NAME}：provider 關機超過 ${this.#shutdownTimeoutMillis}ms`));
      }, this.#shutdownTimeoutMillis);
    });
    try {
      await Promise.race([providerShutdown, deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

/**
 * 建一個把會話遙測送去 OTLP 端點的 plugin。
 *
 * **設定在工廠函式當場驗**（見模組說明的偏離三）：`disabled` 之外，`exporter.url`
 * 必填、必須合法、必須 http(s)；`processor.maxExportBatchSize` 必須是正整數；
 * `shutdownTimeoutMillis` 必須在範圍內。**建構就會拋**，不會拖到跑起來。
 *
 * `apply` 只做一件事——`registry.telemetry.use()`。**協調器不在這裡建**：接線需要一份
 * `SessionLog`，而 plugin 看不到它，那是組裝點的事（`agent-factory.ts` 的
 * `attachTelemetry`）。
 *
 * @param options - mode 與兩個原樣轉交的 SDK 選項物件。
 * @returns 可載入的 plugin。
 * @throws 設定不合法——四條檢查各自的訊息都指名是哪個欄位。
 */
export function createTelemetryOtelPlugin(options: TelemetryOtelOptions = {}): NexusPlugin {
  const service = new OpenTelemetrySessionService(options);
  return {
    name: PLUGIN_NAME,
    apply(registry) {
      registry.telemetry.use(service);
      // 服務的生命週期歸協調器：`SessionTelemetryCoordinator.dispose()` 會轉發
      // `shutdown()`。這裡**不**再登記一次 `lifecycle.onDispose`，否則排空會跑兩遍。
    },
  };
}
