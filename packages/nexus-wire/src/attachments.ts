/**
 * 檔案上傳與送出時帶收據的形狀（[#732](https://github.com/DemianLi/nexus-agent/issues/732)）。
 *
 * **契約**：路徑、收據的型別、送訊息帶收據的欄位、client 方法。**上傳路徑 server 端已實作**（`apps/harness` 的
 * `attachment-store.ts` 與 `wire-handler.ts`）：沒有附件儲存的組裝仍回 `not_supported`，web 據這個碼把附件列藏起來。
 * `run.start` 帶 {@link PromptAttachment} 的收下還沒做，那時一律回 `not_supported`。
 *
 * 照 dsh 的 `file-upload`（`packages/client/file-upload/src/{protocol,types,http-route}.ts`，`5badb150`）：
 *
 * - **上傳**：`POST` 一個原始位元組的 body（`content-type: application/octet-stream`），檔名走查詢參數 `name`；回
 *   一張**收據**。位元組存在會話日誌之外，日誌與訊息只留參照（dsh 的 `attachment-local`）。
 * - **收據**：不透明的 id，只在**收下它的那條 thread** 有效，送訊息時帶回來；一次上傳一張，用過（或那句話被丟掉）就失效。
 * - **送訊息**：dsh 的 prompt 內容區塊是 `{ type: 'file', receiptId }` 或 `{ type: 'image', mediaType, data, name? }`
 *   （`session-controller/src/types.ts:89-97`）；我們放在 `run.start` 的選填 `params.attachments`
 *   （{@link PromptAttachment}），文字仍走 `input`。
 * - **圖片不走上傳收據**：圖是**內嵌的 base64**，由 Host 在收下時驗過、存到日誌之外、換成參照；只有一般檔案走上傳與收據。
 *   dsh 前端一律送 `[...附件照選取順序, 文字]`（`ui-conversation/src/client/service.ts:261-267`），文字永遠在最後，所以
 *   「文字留在原欄位、附件另開一個陣列」不丟任何資訊——**這是偏離 3**。
 * - **收圖檢查在 server 收下時做**：這個會話目前的模型宣告了輸入種類、裡面沒有 `image` 就拒收
 *   （{@link MODEL_DOES_NOT_SUPPORT_IMAGES}），什麼都沒宣告時照收（dsh `commands.ts:336-348`）。web 收到就顯示出來，輸入框的草稿與
 *   附件留著。**型錄不給 web 看「收不收圖」**，同 dsh 的 wire 型錄沒有這一格。
 *
 * ## 進度與取消
 *
 * `WireClient.uploadFile(threadId, body, name?, signal?, onProgress?)`，簽名與 `onProgress({ loaded, total? })` 的形狀照 dsh 的
 * `file-upload`（`client/contract.ts`）。瀏覽器的 `fetch` 量不到上傳進度，所以 `Blob` 在有 `XMLHttpRequest` 時走 XHR
 * （`lengthComputable` 才帶 `total`），其餘（Node、測試）走 `fetch`、送完報一次。`signal` 中止就斷線，server 端把暫存檔收掉、
 * 什麼都不留。dsh 另有「串流 body 轉給 Worker 增量送」的路，我們沒做：web 的附件都是使用者選的檔案（`Blob`）。
 *
 * ## 與 dsh 的偏離
 *
 * 1. **路徑掛在 thread 底下**（`/threads/:id/uploads`）：dsh 用 `sessionId` 查詢參數、路徑是 `/api/session/uploadFileBinary`。
 *    我們的 server 一律以 thread 分路，而且 `/threads/:id/…` 才在瀏覽器會話認證（#424）的圍欄裡。
 * 2. **回應是協定的封包**（`{ type: 'success', result }`／`ErrorResponse`），不是 dsh 的 `{ ok, value }`：同我們其他 `GET`／`POST`
 *    路徑。
 * 3. **文字不放進附件陣列**：見上，dsh 前端永遠把文字放最後，沒有損失。
 * 4. **`content-type: application/octet-stream` 不是 simple request**，所以跨來源會發 preflight 而 server 從不回答，同
 *    上行 JSON 那一道閘門的用意。
 *
 * @module
 */

import type { ErrorResponse } from './protocol.js';

/** 上傳的查詢參數：顯示用的檔名，server 清成存下來的葉名（不當路徑解讀）。 */
export const UPLOAD_NAME_PARAM = 'name';

/** 一張收據，同 dsh 的 `FileUploadValue`（`receiptId` 加 `file` 的名字與大小）。 */
export interface UploadReceipt {
  /** 不透明、只在收下它的那條 thread 有效；送訊息時原樣放進 {@link PromptAttachment}。 */
  readonly receiptId: string;
  /** server 清過的檔名。 */
  readonly name: string;
  /** 確切位元組數。 */
  readonly bytes: number;
}

/** 內嵌圖片允許的媒體類型，同 dsh 的 `ImageMediaType`（`attachment/src/types.ts:8`）。 */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

/**
 * 每張內嵌圖片編碼前的位元組上限，同 dsh 的 `DEFAULT_MAX_IMAGE_BYTES`（`attachment-local/src/index.ts:34`）：超過就**拒收，不縮圖**。
 * 在 server 收下時檢查（`invalid_argument`）；base64 之後約 4/3 倍，請求本文也跟著大。
 */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** 一句話最多幾張圖，同 dsh 的 `DEFAULT_MAX_IMAGES_PER_MESSAGE`（`attachment-local/src/index.ts:36`，設定欄位 `:151`）。 */
export const MAX_IMAGES_PER_MESSAGE = 20;

/**
 * 收圖檢查的錯誤碼：這個會話目前的模型宣告了輸入種類、而裡面沒有 `image`。同 dsh 的 `MODEL_DOES_NOT_SUPPORT_IMAGES`，
 * 碼的寫法照我們其他的（`turn_not_found` 那一族）。那句話不進佇列、日誌不多東西。
 */
export const MODEL_DOES_NOT_SUPPORT_IMAGES = 'model_does_not_support_images';

/** 附件：一份已上傳的檔案（收據），或一張內嵌的圖片。同 dsh 的 `PromptContentPart` 去掉文字那一支。 */
export type PromptAttachment =
  | { readonly type: 'file'; readonly receiptId: string }
  | {
      readonly type: 'image';
      readonly mediaType: ImageMediaType;
      /** 圖片位元組的標準 base64。 */
      readonly data: string;
      /** 顯示用的檔名；不當路徑解讀。 */
      readonly name?: string;
    };

/** {@link uploadPath} 的回應封包。 */
export type UploadResponse =
  { readonly type: 'success'; readonly result: UploadReceipt } | ErrorResponse;

/**
 * 上傳的路徑，`POST`，body 是檔案的原始位元組，`content-type: application/octet-stream`，帶 `?name=`。
 *
 * 沒開過的 thread 會為它建起來（收據要綁在一條 thread 上）。這個組裝沒有附件儲存：`not_supported`。
 *
 * @param threadId - thread id，就是 root 會話的 id。
 * @returns 路徑。
 */
export function uploadPath(threadId: string): string {
  return `/threads/${encodeURIComponent(threadId)}/uploads`;
}
