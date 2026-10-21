/**
 * serve 的**探針與指標端點**（[#1535](https://github.com/DemianLi/nexus-agent/issues/1535)）：`GET /livez`、`GET /readyz`、`GET /metrics`。
 *
 * 今天要知道 serve 活不活著，只能看 port 有沒有開。這一檔補三個**被動抓取**的路徑，serve 不主動往任何地方送，指標預設關著：
 *
 * - **`/livez`**：handler 跑得到就回 `200 ok`。不查任何狀態——回得了，就代表事件圈在轉。
 * - **`/readyz`**：`200 ok` 是「在聽、收尾還沒開始」；`503 closing` 是收尾已經開始（#1777：`close()` 立旗後 listener 還會照常在聽一段時間窗，
 *   見 `serve.ts`；沒有這段，`server.close()` 一開頭就斷掉所有連線，監控只會看到連不上，看不到 503）。**thread 數到上限不算沒就緒**：已經開著的 thread 照樣服務，
 *   而且同一個 home 只有一台 serve（#1503），沒有別台可以分流。到上限要看指標。
 * - **`/metrics`**：Prometheus 文字格式 0.0.4，手寫。**名單固定、標籤不含 thread id 或路徑**，基數不隨使用者長。
 *
 * 三個路徑**都先過 `isTrustedWireRequest`**（Host 不是 loopback 一律 403，跟 wire 同一道圍欄，不開捷徑），只收 `GET`／`HEAD`，其餘 405。
 * 探針免登入、本文只有狀態字（同機的人用 `ss -ltn` 本來就看得到有一台 serve 在聽）；指標透露別人的活動，要 `Authorization: Bearer <token>`
 * （`tokenMatches` 比），缺或錯一律 401、不說是哪一種。**會話 cookie 換不到指標，反過來也一樣**：兩件事分開，避免把瀏覽器的 cookie 交給監控系統。
 *
 * ## 偏離 dsh：產品需求超出 dsh（理由 2）
 *
 * dsh `687f282e` 沒有探針端點，也沒有指標出口（唯一相關的是 OTel 的 `selfObsMeterProvider` 被刻意排除）。判準取公開的慣例：探針語意取
 * Kubernetes 的 `livez`／`readyz` 分法；格式取 Prometheus 文字格式（`# HELP`／`# TYPE`，counter 名以 `_total` 結尾）。**不新增任何出境路徑**。
 *
 * @module
 */

import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { IntervalHistogram } from 'node:perf_hooks';
import { THREADS_PATH } from '@nexus/wire';

import { tokenMatches } from './browser-auth.js';
import { readMemory } from './memory-gauge.js';
import type { MemoryGaugeDeps } from './memory-gauge.js';
import { isTrustedWireRequest } from './request-trust.js';

/** 三個路徑。 */
export const LIVEZ_PATH = '/livez';
export const READYZ_PATH = '/readyz';
export const METRICS_PATH = '/metrics';

/** 指標的 content-type（Prometheus 文字格式 0.0.4）。 */
export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** 請求落在哪一個面：`/threads` 底下是 wire，這三個路徑是 ops，其餘是網頁。 */
export type Surface = 'wire' | 'web' | 'ops';

/** 這個 pathname 屬於哪個面。`routeBySurface` 與請求計數共用這一份，兩邊不各判一次。 */
export function surfaceOf(pathname: string): Surface {
  if (isOpsPath(pathname)) return 'ops';
  return pathname === THREADS_PATH || pathname.startsWith(`${THREADS_PATH}/`) ? 'wire' : 'web';
}

/** 是不是三個路徑之一（精確比對，`/livez/` 或 `/metrics.json` 不算）。 */
export function isOpsPath(pathname: string): boolean {
  return pathname === LIVEZ_PATH || pathname === READYZ_PATH || pathname === METRICS_PATH;
}

/** 狀態碼 → `2xx`／`3xx`／`4xx`／`5xx`（標籤只有這四個值）；其他碼歸 `other`。 */
function codeClassOf(status: number): string {
  return status >= 200 && status < 600 ? `${String(Math.floor(status / 100))}xx` : 'other';
}

/** 回合失敗碼的標籤基數上限：`classifyTurnFailure` 的值域有限，這是保險；超過的歸 `OTHER`。 */
const MAX_TURN_FAILURE_CODES = 64;

/** 抓取時由 serve 現算的瞬時值。 */
export interface OpsGauges {
  /** `threads.size`（含建構中的），不含撤到一半的。 */
  readonly threads: number;
  /** 撤到一半的。 */
  readonly threadsClosing: number;
  /** 上限；沒有就不出現那個指標。 */
  readonly maxThreads?: number;
}

/** 轉成 Prometheus 標籤值：`\`、`"`、換行要跳脫。 */
function labelValue(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"').replace(/\n/gu, '\\n');
}

/**
 * 指標的計數與取樣。**名單固定**，標籤只有 `surface`／`code_class`／`code`／`quantile`。
 *
 * - 請求與回合失敗是 counter，行程活著就一直加（重啟歸零，Prometheus 的 `rate()` 認得）。
 * - 事件圈延遲用 `perf_hooks.monitorEventLoopDelay`，**每次抓取後 `reset()`**：每次看到的是「上一次抓取以來」的分位數。
 */
export class OpsMetrics {
  readonly #requests = new Map<string, number>();
  readonly #turnFailures = new Map<string, number>();
  readonly #loop: IntervalHistogram = monitorEventLoopDelay({ resolution: 10 });
  readonly #startedAtSeconds: number;
  readonly #gauges: () => OpsGauges;
  readonly #memoryDeps: MemoryGaugeDeps | undefined;

  /**
   * @param gauges - 抓取當下 serve 給的 thread 數與上限。
   * @param memoryDeps - 讀記憶體的縫（測試換掉）；省略即真的。
   */
  constructor(gauges: () => OpsGauges, memoryDeps?: MemoryGaugeDeps) {
    this.#gauges = gauges;
    this.#memoryDeps = memoryDeps;
    this.#startedAtSeconds = Math.round(Date.now() / 1000 - process.uptime());
    this.#loop.enable();
  }

  /** 一個請求回完了。 */
  recordRequest(surface: Surface, status: number): void {
    const key = `${surface}|${codeClassOf(status)}`;
    this.#requests.set(key, (this.#requests.get(key) ?? 0) + 1);
  }

  /** 一輪失敗了（`onTurnFailed`，含背景子代理）。 */
  recordTurnFailure(code: string): void {
    const key =
      this.#turnFailures.has(code) || this.#turnFailures.size < MAX_TURN_FAILURE_CODES
        ? code
        : 'OTHER';
    this.#turnFailures.set(key, (this.#turnFailures.get(key) ?? 0) + 1);
  }

  /** 停掉事件圈取樣。可重複呼叫。 */
  stop(): void {
    this.#loop.disable();
  }

  /** 輸出 Prometheus 文字格式。 */
  async render(): Promise<string> {
    const gauges = this.#gauges();
    const lines: string[] = [];
    const metric = (name: string, type: 'gauge' | 'counter', help: string): void => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    };

    metric('nexus_threads', 'gauge', '行程裡的 thread 數（含建構中的，不含撤到一半的）。');
    lines.push(`nexus_threads ${String(gauges.threads)}`);
    metric('nexus_threads_closing', 'gauge', '撤到一半、還佔著名額的 thread 數。');
    lines.push(`nexus_threads_closing ${String(gauges.threadsClosing)}`);
    if (gauges.maxThreads !== undefined) {
      metric(
        'nexus_threads_max',
        'gauge',
        'thread 數上限（threads 加 closing 到這個數就拒收新 thread）。',
      );
      lines.push(`nexus_threads_max ${String(gauges.maxThreads)}`);
    }

    metric('nexus_http_requests_total', 'counter', '回完的 HTTP 請求數，按面與狀態碼類別。');
    for (const [key, count] of [...this.#requests].sort(([a], [b]) => a.localeCompare(b))) {
      const [surface, codeClass] = key.split('|') as [string, string];
      lines.push(
        `nexus_http_requests_total{surface="${surface}",code_class="${codeClass}"} ${String(count)}`,
      );
    }

    metric('nexus_turn_failures_total', 'counter', '失敗收場的回合數，按失敗碼（含背景子代理）。');
    for (const [code, count] of [...this.#turnFailures].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`nexus_turn_failures_total{code="${labelValue(code)}"} ${String(count)}`);
    }

    metric('nexus_event_loop_delay_seconds', 'gauge', '上一次抓取以來的事件圈延遲分位數（秒）。');
    lines.push(
      `nexus_event_loop_delay_seconds{quantile="0.5"} ${seconds(this.#loop.percentile(50))}`,
      `nexus_event_loop_delay_seconds{quantile="0.99"} ${seconds(this.#loop.percentile(99))}`,
    );
    metric(
      'nexus_event_loop_delay_max_seconds',
      'gauge',
      '上一次抓取以來事件圈延遲的最大值（秒）。',
    );
    lines.push(`nexus_event_loop_delay_max_seconds ${seconds(this.#loop.max)}`);
    this.#loop.reset();

    metric('process_start_time_seconds', 'gauge', '行程啟動的 Unix 時間（秒）。');
    lines.push(`process_start_time_seconds ${String(this.#startedAtSeconds)}`);

    // 記憶體（#1490 的量具，同一份讀法）：讀不到的來源整個不出現，不回 0。
    const memory = await readMemory(this.#memoryDeps);
    if (memory.process.ok) {
      metric('nexus_memory_rss_bytes', 'gauge', '行程常駐記憶體（RSS）位元組。');
      lines.push(`nexus_memory_rss_bytes ${String(memory.process.rssBytes)}`);
      metric('nexus_memory_heap_used_bytes', 'gauge', '行程 V8 heap 已用位元組。');
      lines.push(`nexus_memory_heap_used_bytes ${String(memory.process.heapUsedBytes)}`);
    }
    if (memory.cgroup.ok) {
      metric('nexus_cgroup_memory_current_bytes', 'gauge', '行程所在 cgroup 目前用量位元組。');
      lines.push(`nexus_cgroup_memory_current_bytes ${String(memory.cgroup.currentBytes)}`);
      if (memory.cgroup.limitBytes !== null) {
        metric('nexus_cgroup_memory_max_bytes', 'gauge', '行程所在 cgroup 的記憶體上限位元組。');
        lines.push(`nexus_cgroup_memory_max_bytes ${String(memory.cgroup.limitBytes)}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }
}

/** 奈秒 → 秒的字串。 */
function seconds(nanoseconds: number): string {
  return String(Number.isFinite(nanoseconds) ? nanoseconds / 1e9 : 0);
}

/** {@link createOpsEndpoints} 的選項。 */
export interface OpsEndpointsOptions {
  /** 收尾開始了沒（`handler.close()` 已經叫了，或 serve 的 `close()` 已經開始）。 */
  isClosing(): boolean;
  /** `false`：`/livez`、`/readyz` 回 404。預設 `true`。 */
  readonly probes?: boolean;
  /** 沒給就是指標關著：`/metrics` 回 404。給了要帶 bearer。 */
  readonly metrics?: {
    readonly token: string;
    render(): Promise<string>;
  };
}

/** 探針與指標的請求處理。 */
export interface OpsEndpoints {
  handle(request: Request): Promise<Response>;
  /** 起動以來有沒有人抓過 `/readyz`（過了信任圍欄、探針開著，200 或 503 都算）。收尾時間窗只在有人看的時候才等（#1777）。 */
  readyzProbed(): boolean;
}

const NO_STORE = { 'cache-control': 'no-store' } as const;

function text(
  status: number,
  body: string,
  extra: Record<string, string> = {},
  head = false,
): Response {
  return new Response(head ? null : body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...NO_STORE, ...extra },
  });
}

/** 取 `Authorization: Bearer <token>` 的 token；形狀不對回 `undefined`。 */
function bearerOf(headers: Headers): string | undefined {
  const value = headers.get('authorization');
  if (value === null) return undefined;
  const match = /^Bearer[ ]+(\S+)$/iu.exec(value.trim());
  return match?.[1];
}

/**
 * 組探針與指標的處理器。呼叫端（`serve.ts` 的 `routeBySurface`）只把 {@link isOpsPath} 為真的請求交進來。
 *
 * @param options - 見 {@link OpsEndpointsOptions}。
 */
export function createOpsEndpoints(options: OpsEndpointsOptions): OpsEndpoints {
  const probes = options.probes ?? true;
  let readyzProbed = false;
  return {
    readyzProbed: () => readyzProbed,
    async handle(request) {
      // **先過信任圍欄**，在看方法、路徑、token 之前（同 wire，不開捷徑）。
      if (!isTrustedWireRequest(request.headers)) return text(403, 'forbidden');
      const head = request.method === 'HEAD';
      if (request.method !== 'GET' && !head) {
        return text(405, 'method not allowed', { allow: 'GET, HEAD' });
      }
      const { pathname } = new URL(request.url);
      if (pathname === LIVEZ_PATH || pathname === READYZ_PATH) {
        if (!probes) return text(404, 'not found', {}, head);
        if (pathname === READYZ_PATH) {
          readyzProbed = true;
          if (options.isClosing()) return text(503, 'closing', {}, head);
        }
        return text(200, 'ok', {}, head);
      }
      // /metrics
      const { metrics } = options;
      if (metrics === undefined) return text(404, 'not found', {}, head);
      const presented = bearerOf(request.headers);
      if (presented === undefined || !tokenMatches(presented, metrics.token)) {
        return text(401, 'unauthorized', { 'www-authenticate': 'Bearer' }, head);
      }
      return new Response(head ? null : await metrics.render(), {
        status: 200,
        headers: { 'content-type': METRICS_CONTENT_TYPE, ...NO_STORE },
      });
    },
  };
}
