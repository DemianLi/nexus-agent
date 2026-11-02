import type {
  DeliverableBytes,
  DeliverableFilePage,
  DeliverableReadBytesParams,
  DeliverableReadParams,
  DeliverableRefusalCode,
} from '@nexus/wire';
import type { WireErrorCode } from '@nexus/wire';
import { encodeBinaryResult, errorResponse, successResponse } from '@nexus/wire';
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { vi } from 'vitest';

/**
 * 交付檔命令通道（[#747](https://github.com/DemianLi/nexus-agent/issues/747)）的假 fetch。
 *
 * 讀檔與下載的測試都拿它：解出上行的 `{ id, method, params }`，交給測試的 `respond` 決定回什麼，再把回覆編成線上真正的
 * 形狀（JSON 外殼，或位元組走 wire 的 `encodeBinaryResult` 多段表單）。編碼與解碼是同一份 wire 程式碼，所以這裡驗不到
 * wire 自己的格式，那由 wire 的測試管；這裡管的是「網頁送了什麼參數、照回覆的理由碼畫了什麼」。
 */

/**
 * **jsdom 的 `Blob`／`File`／`FormData` 跟 Node 的 `Response`（undici）不是同一組類別**：`new Response(jsdomFormData)` 會把表單
 * 當成 `"[object FormData]"` 字串，`response.formData()` 吐出來的檔又不是 jsdom `Blob` 的實例，wire 的
 * `decodeBinaryResult` 的 `instanceof Blob` 就過不了。真瀏覽器沒有這個問題，所以是測試環境的落差，不改產品程式碼去遷就：
 * 這個檔一載入就把 `Blob`、`File`、`FormData` 三個全域換成 Node 自己的那一組（undici 解表單時用全域的 `File`），編碼與解碼兩端才用同一組類別。
 *
 * `FormData` 沒有從 Node 的模組匯出，只能從一個 undici 自己解出來的表單拿它的建構子。
 */
const NodeFormData = (
  await new Response('a=1', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  }).formData()
).constructor as typeof FormData;

/**
 * 換全域。**每建一個假 `fetch` 就再換一次**：不少測試在 `afterEach` 裡 `vi.unstubAllGlobals()`，只在載入時換的話，
 * 第二條測試起就被還原回 jsdom 的那一組。
 */
function useNodeBinaryApis(): void {
  vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('File', NodeFile);
  vi.stubGlobal('FormData', NodeFormData);
}

export type DeliverableCall =
  | { readonly method: 'deliverable.read'; readonly params: DeliverableReadParams }
  | { readonly method: 'deliverable.readBytes'; readonly params: DeliverableReadBytesParams };

/** 一個回覆：拿到上行的編號，回一個線上的回應。 */
export type Reply = (id: number) => Response;

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

/** `deliverable.read` 成功：一頁文字。 */
export const pageReply =
  (value: DeliverableFilePage): Reply =>
  (id) =>
    json(successResponse(id, { ok: true, value }));

/** `deliverable.readBytes` 成功：位元組走多段表單。 */
export const bytesReply =
  (value: DeliverableBytes): Reply =>
  (id) =>
    encodeBinaryResult(id, value);

/** 業務上的拒絕（`too-large` 另有 {@link tooLargeReply}，它要帶上限）。 */
export const refuseReply =
  (code: Exclude<DeliverableRefusalCode, 'deliverable/too-large'>): Reply =>
  (id) =>
    json(successResponse(id, { ok: false, error: { code, message: code } }));

/** 太大：頁、窗口或整檔超過上限，帶被超過的那個數字。 */
export const tooLargeReply =
  (maxBytes = 2 * 1024 * 1024): Reply =>
  (id) =>
    json(
      successResponse(id, {
        ok: false,
        error: { code: 'deliverable/too-large', message: 'too large', maxBytes },
      }),
    );

/** 協定錯誤 `invalid_argument`：參數本身不合格（座標、翻頁、窗口）。HTTP 200，body 是 error 物件。 */
export const badRequestReply: Reply = (id) =>
  json(errorResponse(id, 'invalid_argument', '參數不合格'));

/** 別的協定錯誤：HTTP 200，body 是 error 物件，碼不是 `invalid_argument`。 */
export const protocolErrorReply =
  (code: WireErrorCode): Reply =>
  (id) =>
    json(errorResponse(id, code, '這條線收不了'));

/** 載體層擋下（非 2xx），例如 500。 */
export const carrierReply =
  (status: number): Reply =>
  () =>
    new Response('nope', { status });

/**
 * @param respond - 看到一個呼叫，決定回什麼。
 * @returns 假 `fetch`，與它收到的每一個呼叫（依序）、網址與請求設定。
 */
export function deliverableFetch(respond: (call: DeliverableCall) => Reply | Promise<Reply>) {
  useNodeBinaryApis();
  const calls: DeliverableCall[] = [];
  const urls: string[] = [];
  const inits: (RequestInit | undefined)[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number } & DeliverableCall;
    const call = { method: body.method, params: body.params } as DeliverableCall;
    calls.push(call);
    urls.push(String(input));
    inits.push(init);
    return (await respond(call))(body.id);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls, urls, inits };
}

/** 呼叫的 `offset`（沒送就是 `undefined`）。 */
export const offsetOf = (call: DeliverableCall): number | undefined => call.params.offset;
