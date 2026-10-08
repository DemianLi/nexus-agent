import { MODEL_DOES_NOT_SUPPORT_IMAGES } from '@nexus/wire';
import type { PromptAttachment, UploadOutcome } from '@nexus/wire';

import { formatBytes, imageMediaType, MAX_IMAGE_PIXELS } from '@/lib/attachments';
import type { DraftAttachment } from '@/lib/attachments';

/**
 * 送出時把草稿附件變成 `run.start` 的 `attachments`（[#732](https://github.com/DemianLi/nexus-agent/issues/732)，
 * 契約見 `@nexus/wire` 的 `attachments.ts`）：
 *
 * - **白名單內的圖**（`imageMediaType`）：內嵌的 base64，`{ type: 'image', mediaType, data, name }`，不經上傳。
 * - **其餘都是檔案**（含不在白名單的圖，例如 svg、heic）：先 `uploadFile` 換一張收據，`{ type: 'file', receiptId }`。
 * - **照選取順序**（dsh 前端也是 `[...附件照選取順序, 文字]`）；文字另走 `input`，永遠在最後。
 *
 * 任何一個失敗整句就不送：回講得出原因的話，呼叫端把草稿與附件都留著。收據一張只用一次、只在收下它的 thread 有效，
 * 所以重試會重傳，不拿上一次的收據。
 *
 * @module
 */

export type PrepareOutcome =
  | { readonly kind: 'ok'; readonly attachments: readonly PromptAttachment[] }
  | { readonly kind: 'failed'; readonly message: string }
  /** 人按了取消（#733）：不是錯誤，呼叫端不跳錯誤提示，草稿與附件照樣留著。 */
  | { readonly kind: 'cancelled' };

/** 上傳進度，形狀照 dsh `file-upload`：已送出的位元組，加上總量（瀏覽器不一定知道，所以可能沒有）。 */
export interface UploadProgress {
  readonly loaded: number;
  readonly total?: number | undefined;
}

/**
 * `uploadFile` 加上取消與進度的形狀（#733，照 dsh `file-upload` 的 `upload(session, body, name, signal, onProgress)`）。
 * `WireClient.uploadFile` 今天只收到 `signal` 為止；多給的第五個參數它會忽略，所以進度那條線等 wire client 補上
 * 之後才有數字（沒有時卡片畫不確定長度的進度條）。形狀有差再對。
 */
export interface UploadClient {
  uploadFile(
    threadId: string,
    body: Blob | Uint8Array,
    name?: string,
    signal?: AbortSignal,
    onProgress?: (progress: UploadProgress) => void,
  ): Promise<UploadOutcome>;
}

/** 上傳過程的觀察點與取消：卡片上的進度條與取消鈕靠它們（`lib/upload-state.ts`）。 */
export interface UploadHooks {
  /** 取消：中止還在跑的上傳，這一句回 `cancelled`。 */
  readonly signal?: AbortSignal;
  /** 某個附件開始上傳（只有一般檔案會上傳；圖內嵌，不經這裡）。 */
  readonly onStart?: (id: string) => void;
  readonly onProgress?: (id: string, progress: UploadProgress) => void;
  readonly onDone?: (id: string) => void;
}

/** 讀圖的長寬；讀不到（瀏覽器沒有 `createImageBitmap`、檔案壞了）回 `undefined`，那一條上限就不擋。 */
export async function readImageSize(
  file: Blob,
): Promise<{ readonly width: number; readonly height: number } | undefined> {
  if (typeof createImageBitmap !== 'function') return undefined;
  try {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return undefined;
  }
}

/** 標準 base64，不含 `data:` 前綴。 */
async function toBase64(file: Blob): Promise<string> {
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('讀不到檔案'));
    reader.readAsDataURL(file);
  });
  return url.slice(url.indexOf(',') + 1);
}

const NOT_SUPPORTED_TEXT = '這個伺服器不收檔案附件。';

/** 伺服器收下那一句之後回的錯誤碼，換成給人看的話；不認得的碼回 `undefined`（用伺服器自己的訊息）。 */
export function attachmentRejectionText(code: string | undefined): string | undefined {
  if (code === MODEL_DOES_NOT_SUPPORT_IMAGES) {
    return '目前的模型不收圖片：換一顆能看圖的模型，或把圖片移掉再送。';
  }
  if (code === 'not_supported') return '這個伺服器不收附件。';
  return undefined;
}

/**
 * `run.start` 被拒時的話：附件的兩種碼照上面；`not_supported` 要看這句帶了什麼——只點名子代理時說的是子代理
 * （不然會誤說「不收附件」），附件與點名都帶就用伺服器自己的訊息（分不出是哪一個）。
 */
export function sendRejectionText(
  code: string | undefined,
  hasAttachments: boolean,
  hasMention: boolean,
): string | undefined {
  if (code === 'not_supported' && hasMention) {
    return hasAttachments ? undefined : '這個伺服器不收點名子代理：取消標記再送。';
  }
  return attachmentRejectionText(code);
}

/** 取消時兌現的 rejection：不管底下的 client 理不理會 `signal`，畫面都立刻回得來。 */
function abortedBy(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const abort = () => reject(new DOMException('上傳已取消', 'AbortError'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

async function prepareOne(
  client: UploadClient,
  threadId: string,
  item: DraftAttachment,
  hooks: UploadHooks,
): Promise<PromptAttachment> {
  const { file } = item;
  const mediaType = imageMediaType(file);
  if (mediaType !== undefined) {
    return { type: 'image', mediaType, data: await toBase64(file), name: file.name };
  }
  hooks.onStart?.(item.id);
  const upload = client.uploadFile(
    threadId,
    file,
    file.name,
    hooks.signal,
    hooks.onProgress === undefined
      ? undefined
      : (progress) => {
          // 取消之後才到的進度不算。
          if (hooks.signal?.aborted !== true) hooks.onProgress?.(item.id, progress);
        },
  );
  const outcome = await (hooks.signal === undefined
    ? upload
    : Promise.race([upload, abortedBy(hooks.signal)]));
  if (outcome.kind === 'ok') {
    hooks.onDone?.(item.id);
    return { type: 'file', receiptId: outcome.receipt.receiptId };
  }
  throw new Error(
    outcome.code === 'not_supported'
      ? NOT_SUPPORTED_TEXT
      : `「${file.name}」上傳失敗：${outcome.message}`,
  );
}

/**
 * 準備這一句話的附件。先逐張擋像素上限（每一張各自算，不加總；圖要讀了才知道），再依序處理每一個；上傳與編碼同時進行，結果照原本的順序排。
 *
 * @param readSize - 讀圖的長寬；測試換掉。
 * @param hooks - 上傳的取消與進度（#733）。取消之後回 `cancelled`，不管那時哪些上傳已經完成或失敗。
 */
export async function prepareAttachments(
  client: UploadClient,
  threadId: string,
  items: readonly DraftAttachment[],
  readSize: typeof readImageSize = readImageSize,
  hooks: UploadHooks = {},
): Promise<PrepareOutcome> {
  for (const item of items) {
    if (item.kind !== 'image') continue;
    const size = await readSize(item.file);
    if (size !== undefined && size.width * size.height > MAX_IMAGE_PIXELS) {
      const megapixels = Math.round((size.width * size.height) / 1_000_000);
      return {
        kind: 'failed',
        message: `「${item.file.name}」是 ${size.width}×${size.height}（約 ${megapixels} 百萬像素，${formatBytes(item.file.size)}），一張圖最多 ${MAX_IMAGE_PIXELS / 1_000_000} 百萬像素。`,
      };
    }
  }
  const aborted = () => hooks.signal?.aborted === true;
  if (aborted()) return { kind: 'cancelled' };
  const settled = await Promise.allSettled(
    items.map((item) => prepareOne(client, threadId, item, hooks)),
  );
  if (aborted()) return { kind: 'cancelled' };
  const attachments: PromptAttachment[] = [];
  for (const result of settled) {
    if (result.status === 'rejected') {
      const reason: unknown = result.reason;
      return { kind: 'failed', message: reason instanceof Error ? reason.message : String(reason) };
    }
    attachments.push(result.value);
  }
  return { kind: 'ok', attachments };
}
