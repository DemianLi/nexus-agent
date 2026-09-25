/**
 * 讀檔碰到二進位檔照 dsh 拒絕——[#642](https://github.com/DemianLi/nexus-agent/issues/642)。
 *
 * 基座的 `read_file` 照副檔名判 MIME，非文字的整份交給模型當圖片、音訊或檔案塊，而模型那一側的工具訊息只收文字：
 * NVIDIA 對它回 400，那則工具結果又已經進了 state，同一條 thread 之後每一輪都 400（實測）。dsh 的 `read` 不看副檔名、
 * 看內容（`packages/fs/fs-local/src/fsio.ts:386-399`，`477b4f4`）：前 {@link BINARY_SAMPLE_BYTES} 個位元組有 NUL 是
 * `binary file`，不是合法 UTF-8 是 `invalid UTF-8 text`，兩句都帶 `FS_NOT_TEXT`。圖片另走 `read_image`，要掛了附件
 * 儲存才有——我們沒有，等於 dsh「沒掛」的那一格。
 *
 * 判在 backend 的 `read` 上，兩種 backend 各一個掛點：落磁碟的 `ContainedFilesystemBackend`（`contained-backend.ts`），與沒給
 * `--workspace` 時墊底的 {@link TextOnlyStateBackend}。回 `{ error }` 就走基座既有的錯誤路：`read_file` 回
 * `Error: …`。子代理拿的是同一個 backend，一併涵蓋。
 *
 * **偏離**：副檔名被基座判成非文字、內容卻是合法文字的檔（例如一份叫 `.png` 的純文字），dsh 照讀，我們一律拒成
 * `binary file`。照讀要自己重做基座文字那一支的切頁與空檔提示；基座不認得的副檔名一律當 `text/plain`，會落到
 * 非文字那一支的只有它表上的圖、音、影、pdf、ppt，實務上內容都是二進位。
 *
 * @module
 */

import { StateBackend } from 'deepagents';
import type { ReadResult } from 'deepagents';

/** dsh 判二進位時取樣的位元組數（`fsio.ts` 的 `BINARY_SAMPLE_BYTES`）。 */
export const BINARY_SAMPLE_BYTES = 8192;

/**
 * 照 dsh 的 `readWholeText` 判一份內容是不是文字：前 {@link BINARY_SAMPLE_BYTES} 個位元組有 NUL 是 `binary file`，
 * 不是合法 UTF-8 是 `invalid UTF-8 text`，是文字就回 `undefined`。
 */
export function notTextReason(bytes: Uint8Array): string | undefined {
  if (bytes.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) return 'binary file';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return 'invalid UTF-8 text';
  }
  return undefined;
}

/**
 * 基座非文字那一支讀出來的東西，拒絕的錯誤結果。原因照內容判，內容是文字的也拒成 `binary file`（見模組註解的偏離）。
 *
 * @param filePath - 錯誤訊息裡的路徑，照呼叫端給的原樣。
 * @param bytes - 那一支的位元組。
 */
export function refuseNonText(filePath: string, bytes: Uint8Array): ReadResult {
  return { error: `cannot read "${filePath}": ${notTextReason(bytes) ?? 'binary file'}` };
}

/**
 * 沒給 `--workspace` 時墊底的虛擬 FS，讀檔碰到二進位檔照 dsh 拒絕。
 *
 * 基座的 `StateBackend.write` 碰到非文字副檔名會把內容當 base64 解成位元組存起來，`read` 再原樣交回去——模型寫一張
 * PNG 再讀，同一條 thread 就中毒了（實測）。state 裡文字那一支一定是字串（不是字串的基座自己回錯），所以**內容不是
 * 字串就是非文字那一支**：位元組，或 checkpoint 往返後變成的普通物件（基座 `read_file` 對它做 `Object.values`）。
 * 零參數建構，所以仍是基座的非 legacy 模式。
 */
export class TextOnlyStateBackend extends StateBackend {
  override read(filePath: string, offset?: number, limit?: number): ReadResult {
    const result = super.read(filePath, offset, limit);
    if (result.error !== undefined || typeof result.content === 'string') return result;
    const content = result.content as unknown;
    const bytes =
      content instanceof Uint8Array
        ? content
        : Uint8Array.from(Object.values((content ?? {}) as Record<string, number>));
    return refuseNonText(filePath, bytes);
  }
}
