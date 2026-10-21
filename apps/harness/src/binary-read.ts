/**
 * 讀檔碰到二進位檔照 dsh 拒絕——[#642](https://github.com/DemianLi/nexus-agent/issues/642)。
 *
 * 基座的 `read_file` 照副檔名判 MIME，非文字的整份交給模型當圖片、音訊或檔案塊，而模型那一側的工具訊息只收文字：
 * NVIDIA 對它回 400，那則工具結果又已經進了 state，同一條 thread 之後每一輪都 400（實測）。dsh 的 `read` 不看副檔名、
 * 看內容（`packages/fs/fs-local/src/fsio.ts:386-399`，`477b4f4`）：前 {@link BINARY_SAMPLE_BYTES} 個位元組有 NUL 是
 * `binary file`，不是合法 UTF-8 是 `invalid UTF-8 text`，兩句都帶 `FS_NOT_TEXT`。圖片另走 `read_image`，要掛了附件
 * 儲存才有——我們沒有，等於 dsh「沒掛」的那一格（附件／`read_image` 見 [#731](https://github.com/DemianLi/nexus-agent/issues/731)）。
 *
 * 判在 backend 的 `read` 上，兩種 backend 各一個掛點：落磁碟的 `ContainedFilesystemBackend`（`contained-backend.ts`），與沒給
 * `--workspace` 時墊底的 {@link TextOnlyStateBackend}。回 `{ error }` 就走基座既有的錯誤路：`read_file` 回
 * `Error: …`。子代理拿的是同一個 backend，一併涵蓋。
 *
 * **偏離已撤銷（[#1530](https://github.com/DemianLi/nexus-agent/issues/1530)）**：本來副檔名被基座判成非文字、內容卻是合法文字的檔
 * （例如一份叫 `.png` 的純文字），我們一律拒成 `binary file`，dsh 則照讀。`ContainedFilesystemBackend.read` 現在自己讀檔、
 * 自己建頁，**看內容、不看副檔名**，跟 dsh 一樣；這份檔留下的只有 {@link notTextReason}／{@link BINARY_SAMPLE_BYTES}
 * 與沒給 `--workspace` 時墊底的 {@link TextOnlyStateBackend}（state 裡的位元組內容沒有「看內容」的餘地，仍照舊拒絕）。
 *
 * @module
 */

import { extname } from 'node:path';
import { StateBackend } from 'deepagents';
import type { ReadResult, WriteResult } from 'deepagents';

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
 * 基座 `getMimeType`／`isTextMimeType`（`deepagents@1.13.1` 沒有匯出）判成非文字的副檔名：圖、音、影、pdf、ppt（`MIME_TYPES` 表裡
 * 不是 `text/*`、`application/json`、`application/javascript`、`image/svg+xml` 的那些；大小寫不分，`extname(path).toLocaleLowerCase()`）。
 * 基座的 `StateBackend.write` 在 v2 格式下對這些把內容當 base64 解碼成位元組，{@link TextOnlyStateBackend.write} 要認得這一格才自己組更新。
 * 升版時對照：`binary-tool-results.test.ts` 的「基座語意的釘子」逐個副檔名比基座。
 */
export const NON_TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.heif',
  '.mp3', '.wav', '.aiff', '.aac', '.ogg', '.flac',
  '.mp4', '.webm', '.mpeg', '.mov', '.avi', '.flv', '.mpg', '.wmv', '.3gpp',
  '.pdf', '.ppt', '.pptx',
]); // prettier-ignore

/**
 * 沒給 `--workspace` 時墊底的虛擬 FS，讀檔碰到二進位檔照 dsh 拒絕。
 *
 * 基座的 `StateBackend.write` 碰到非文字副檔名會把內容當 base64 解成位元組存起來，`read` 再原樣交回去——模型寫一張
 * PNG 再讀，同一條 thread 就中毒了（實測）。**`write` 現在一律把內容當 UTF-8 文字存**（[#1813](https://github.com/DemianLi/nexus-agent/issues/1813)，
 * 照 dsh：`write.ts:75/:82/:124` 沒有任何依副檔名的分支），所以模型這一條路寫不出位元組了；state 裡的位元組只剩 `uploadFiles`
 * 灌進來的（與 checkpoint 往返後的）。state 裡文字那一支一定是字串（不是字串的基座自己回錯），所以**內容不是
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

  /**
   * 內容一律當 UTF-8 文字存，不看副檔名（#1813，照 dsh `write.ts:75/:82/:124`）。
   *
   * **偏離 deepagents（理由 1，基座表達不出來），範圍收到最小：** 基座的 `write` 只有 v2 格式下、副檔名被它判成非文字的路徑
   * （{@link NON_TEXT_EXTENSIONS}）才把內容 base64 解碼，沒有選項可以關。**只有這一格自己組更新**；其餘（文字副檔名、整個 v1 格式——
   * 基座在 v1 本來就不解碼）都交回 `super.write`，所以文字路徑與基座逐欄同形（`mimeType` 依副檔名、既有檔保留 `mimeType`）。
   *
   * 自己組的這一格照基座非 legacy 與 legacy 兩種寫法（`files`／`isLegacy`／`sendFilesUpdate` 是 private，用型別斷言取；`deepagents@1.13.1`，
   * 升版時對照 `StateBackend.write`，`binary-tool-results.test.ts` 有兩條釘子）。存的 `mimeType` 是 `text/plain` 而不是路徑推出的
   * `image/png`：後者基座的 `read_file` 會當成圖片塊交給模型，那正是 #642 要擋的毒。
   */
  override write(filePath: string, content: string): WriteResult {
    if (!NON_TEXT_EXTENSIONS.has(extname(filePath).toLowerCase())) {
      return super.write(filePath, content);
    }
    const internals = this as unknown as {
      readonly files: Record<string, { readonly created_at?: string } | undefined>;
      readonly fileFormat: string;
      readonly isLegacy: boolean;
      sendFilesUpdate(update: Record<string, unknown>): void;
    };
    if (internals.fileFormat !== 'v2') return super.write(filePath, content);
    const now = new Date().toISOString();
    const data = {
      content,
      mimeType: 'text/plain',
      created_at: internals.files[filePath]?.created_at ?? now,
      modified_at: now,
    };
    if (internals.isLegacy) {
      return { path: filePath, filesUpdate: { [filePath]: data } } as unknown as WriteResult;
    }
    internals.sendFilesUpdate({ [filePath]: data });
    return { path: filePath };
  }
}
