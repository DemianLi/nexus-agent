/**
 * 照位元組複製一個檔，穿過組好的 backend（`copy_file`，[#2289](https://github.com/DemianLi/nexus-agent/issues/2289)）。
 *
 * 基座的 `BackendProtocol` 沒有複製，而產品的 backend 一定包在 `ModifiedOrderCompositeBackend` 裡：工作區、共用參考區、附件、
 * 工具結果暫存、會話歷史與插件的掛載點各是一個子 backend。來源與目的地常落在不同的子 backend（`/shared/x` 複製到 `/x`），
 * 所以契約拆成兩半：來源那一半交出位元組串流（{@link COPY_SOURCE}），目的地那一半從串流建新檔（{@link COPY_INTO}）。
 * composite 兩半各自照路由往下轉，同一個子 backend 內的複製也走同一條路。
 *
 * 子 backend 少了任一半就回錯誤，**不退回 `readRaw` 加 `write`**：`readRaw` 對副檔名判成文字的檔（含不認得的副檔名）
 * 照 UTF-8 解，非 UTF-8 的位元組變成 U+FFFD，`write` 又只收字串，接起來保不住原本的位元組。也不退回 `downloadFiles` 加 `uploadFiles`：
 * 整份放進記憶體，錯誤只有四個碼，說不出給模型的原因。
 *
 * 跟 `FILE_VERSION` 一樣掛在 `Symbol.for` 上：不跟基座日後的方法名撞，同一行程裡有兩份 `@nexus/core` 時仍是同一個。
 *
 * @module
 */

import type { Readable } from 'node:stream';

/**
 * 一次複製的兩條路徑，都是模型給的原路徑（最外層座標），兩半都會收到。子 backend 回給模型的句子裡用這一份路徑，
 * 不用自己座標系的那一份（那一份另外傳）。
 */
export interface CopyRequest {
  readonly from: string;
  readonly to: string;
}

/** 開好的來源。`close` 由 {@link copyFileOf} 在 `finally` 裡呼叫，目的地沒讀串流就失敗時 handle 也不會漏；它拋的錯不進結果，交給呼叫端給的 `onCloseError`。 */
export interface CopySource {
  readonly stream: Readable;
  /** 開檔當下的位元組數，給目的地那一半核對寫下的量。 */
  readonly size: number;
  close(): Promise<void>;
}

/**
 * 目的地那一半的結果。成功時 `path` 是這一層座標系的目的地，`bytes`、`sha256` 是子 backend 實際寫下的位元組數與 SHA-256（選填）；
 * composite 往上交時只把 `path` 補回路由前綴，其餘欄位原樣帶出。`exists`：失敗是因為目的地已經存在。
 */
export type CopyIntoResult =
  | { readonly path: string; readonly bytes?: number; readonly sha256?: string }
  | { readonly error: string; readonly exists?: true };

/** 來源那一半：過讀取面的檢查、開檔，回開好的來源或交給模型的錯誤。 */
export const COPY_SOURCE = Symbol.for('nexus.backend.copy-source');

/** 目的地那一半：過寫入面的檢查，目的地已存在就拒，從串流建新檔。 */
export const COPY_INTO = Symbol.for('nexus.backend.copy-into');

/** 掛了兩半的 backend。`path` 是這個 backend 自己座標系的路徑，composite 往下轉時已剝掉路由前綴。 */
export interface CopyCapable {
  [COPY_SOURCE](
    path: string,
    request: CopyRequest,
  ): Promise<CopySource | { readonly error: string }>;
  [COPY_INTO](path: string, source: CopySource, request: CopyRequest): Promise<CopyIntoResult>;
}

/**
 * 叫 backend 的來源那一半；沒有這一半就回固定錯誤。
 *
 * @param backend - 要叫的 backend：最外層的 composite，或 composite 換回的子 backend 原物件。
 * @param path - 這個 backend 座標系的來源路徑。
 * @param request - 原路徑。
 */
export async function copySourceOf(
  backend: unknown,
  path: string,
  request: CopyRequest,
): Promise<CopySource | { readonly error: string }> {
  const open = (backend as Partial<CopyCapable> | null | undefined)?.[COPY_SOURCE];
  if (typeof open !== 'function')
    return {
      error: `Error copying '${request.from}': this location does not support copying files`,
    };
  return open.call(backend, path, request);
}

/**
 * 叫 backend 的目的地那一半；沒有這一半就回固定錯誤，串流不讀。
 *
 * @param backend - 要叫的 backend：最外層的 composite，或 composite 換回的子 backend 原物件。
 * @param path - 這個 backend 座標系的目的地路徑。
 * @param source - 開好的來源。
 * @param request - 原路徑。
 */
export async function copyIntoOf(
  backend: unknown,
  path: string,
  source: CopySource,
  request: CopyRequest,
): Promise<CopyIntoResult> {
  const write = (backend as Partial<CopyCapable> | null | undefined)?.[COPY_INTO];
  if (typeof write !== 'function')
    return {
      error: `Error copying to '${request.to}': this location does not accept copied files`,
    };
  return write.call(backend, path, source, request);
}

/**
 * 把 `from` 照位元組複製到 `to`。開了來源就一定會關：目的地回錯誤或拋錯也一樣。
 *
 * **模型看到的只由兩半決定**：目的地成功就回成功，回錯誤就回那個錯誤，拋錯就照拋那個錯；來源那一半拋錯也照拋。
 * `close` 拋的錯不改變這個結果（目的地已經寫好卻回失敗，模型重試會撞上已存在），改交給 `onCloseError`。唯一的例外是
 * `onCloseError` 自己同步拋錯：那個錯會取代結果往外拋。
 *
 * @param backend - 工具實際讀寫的那個 backend（組好的最外層）。
 * @param from - 模型給的來源路徑。
 * @param to - 模型給的目的地路徑。
 * @param onCloseError - 關掉來源時拋的錯交給它記錄，必填：這個錯不進結果，也不能靜靜丟掉。同步呼叫、不等它回的 Promise：
 *   它同步拋的錯會蓋掉結果往外拋，回傳被拒的 Promise 會變成 unhandled rejection，所以它自己不該拋。
 * @returns 目的地那一半的結果，`path` 是最外層座標；來源那一半失敗時是它的錯誤。
 */
export async function copyFileOf(
  backend: unknown,
  from: string,
  to: string,
  onCloseError: (error: unknown) => void,
): Promise<CopyIntoResult> {
  const request: CopyRequest = { from, to };
  const source = await copySourceOf(backend, from, request);
  if ('error' in source) return source;
  try {
    return await copyIntoOf(backend, to, source, request);
  } finally {
    try {
      await source.close();
    } catch (error: unknown) {
      onCloseError(error);
    }
  }
}
