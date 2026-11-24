/**
 * 網頁端讀交付檔的呼叫（[#747](https://github.com/DemianLi/nexus-agent/issues/747)）：命令通道上的 `deliverable.read` 與
 * `deliverable.readBytes`，契約見 `deliverables.ts`。
 *
 * **不進 {@link WireClient}**：web 有很多手寫的假 `WireClient`，介面多一個必填成員，它們當場編不過，第 1 刀就不是純新增了。
 * 這裡是一個獨立的小工廠，形狀同 web 的 `createChangesSummaryStore`（吃 `baseUrl` 與 `fetch`）。之後要不要併進
 * `WireClient` 是 web 那一刀的事。
 *
 * 結果分兩層，同回饋那幾支：`rejected` 是「這條線收不了」（協定錯誤、被載體層擋下、回應看不懂），`ok` 的 `result` 才是
 * 命令自己的結果，其中 `ok: false` 是業務上的拒絕（帶碼）。
 *
 * @module
 */

import { decodeBinaryResult, isBinaryResponse } from './deliverables.js';
import type {
  DeliverableReadBytesParams,
  DeliverableReadBytesResult,
  DeliverableReadParams,
  DeliverableReadResult,
} from './deliverables.js';
import { commandPath } from './protocol.js';
import type { WireErrorCode } from './protocol.js';

/**
 * `rejected` 的來源有兩種，網頁要分得開（重試對前者沒有意義、對後者可能有）：
 *
 * - **協定錯誤**：HTTP 200，body 是 `{ type: 'error', error, message }`（例如參數不合格是 `invalid_argument`）。
 *   帶 `code`；這是終局的，重送同樣的請求永遠是同一個答案。
 * - **載體層擋下**：非 2xx（401、415、5xx…）。帶 `status`、不帶 `code`；暫時性的（5xx）值得重試。
 *
 * 兩個欄位都是選填的純新增，只讀 `message` 的呼叫端不受影響。**呼叫端不要去比對 `message` 的字串**：那是給人看的。
 */
export type DeliverableOutcome<T> =
  | { readonly kind: 'ok'; readonly result: T }
  | {
      readonly kind: 'rejected';
      readonly message: string;
      /** 協定錯誤的碼；載體層擋下與回應看不懂時沒有。 */
      readonly code?: WireErrorCode;
      /** 載體層擋下時的 HTTP 狀態碼；其餘情形沒有。 */
      readonly status?: number;
    };

export interface DeliverableClient {
  /** 讀一頁文字（`deliverable.read`）。 */
  read(
    threadId: string,
    params: DeliverableReadParams,
    signal?: AbortSignal,
  ): Promise<DeliverableOutcome<DeliverableReadResult>>;
  /** 讀位元組（`deliverable.readBytes`）：給 `offset`／`length` 是窗口，都不給是整檔。 */
  readBytes(
    threadId: string,
    params: DeliverableReadBytesParams,
    signal?: AbortSignal,
  ): Promise<DeliverableOutcome<DeliverableReadBytesResult>>;
}

export interface DeliverableClientOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createDeliverableClient(options: DeliverableClientOptions): DeliverableClient {
  const base = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  let nextCommandId = 1;

  async function send<T>(
    threadId: string,
    method: 'deliverable.read' | 'deliverable.readBytes',
    params: object,
    signal: AbortSignal | undefined,
  ): Promise<DeliverableOutcome<T>> {
    const id = nextCommandId++;
    const response = await doFetch(`${base}${commandPath(threadId, method)}`, {
      method: 'POST',
      // 同 `createWireClient` 的 `postJson`：server 只收 application/json，逼出一個它從不回答的 preflight。
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, method, params }),
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) {
      return {
        kind: 'rejected',
        message: `被載體層擋下：${response.status} ${await response.text()}`,
        status: response.status,
      };
    }
    let echoedId: unknown;
    let result: unknown;
    try {
      if (isBinaryResponse(response)) {
        const decoded = await decodeBinaryResult(response);
        echoedId = decoded.id;
        result = decoded.result;
      } else {
        const parsed: unknown = await response.json();
        if (!isRecord(parsed)) return { kind: 'rejected', message: '回應看不懂' };
        if (parsed.type === 'error') {
          return {
            kind: 'rejected',
            message: typeof parsed.message === 'string' ? parsed.message : '這條線收不了',
            // 碼在線上就是一個字串；不是字串（壞封包）就不帶，不去猜。
            ...(typeof parsed.error === 'string' && { code: parsed.error as WireErrorCode }),
          };
        }
        echoedId = parsed.id;
        result = parsed.result;
      }
    } catch (error) {
      return {
        kind: 'rejected',
        message: `回應看不懂：${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (echoedId !== id) {
      return { kind: 'rejected', message: `回應的編號 ${String(echoedId)} 對不上 ${id}` };
    }
    if (typeof (result as { ok?: unknown } | null)?.ok !== 'boolean') {
      return { kind: 'rejected', message: '回應看不懂：結果沒有 ok' };
    }
    return { kind: 'ok', result: result as T };
  }

  return {
    read: (threadId, params, signal) =>
      send<DeliverableReadResult>(threadId, 'deliverable.read', params, signal),
    readBytes: (threadId, params, signal) =>
      send<DeliverableReadBytesResult>(threadId, 'deliverable.readBytes', params, signal),
  };
}
