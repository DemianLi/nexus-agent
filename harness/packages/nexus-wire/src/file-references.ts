/**
 * `@` 引用的列檔（[#651](https://github.com/DemianLi/nexus-agent/issues/651)）上線的形狀。
 *
 * 照 dsh 的 `fileReferences.list(agent, query, signal) → FileReferenceCandidate[]`
 * （`packages/context/file-reference/src/{index,types}.ts`、`packages/api/session-controller/src/file-references.ts`，
 * `477b4f4`）。**只給路徑，不給內容**：選中的候選在輸入框裡是普通的 `@path` 文字，伺服器不展開，模型要自己用
 * 檔案工具讀（系統提示那一句交代它）。
 *
 * ## 給 client 的三條約定
 *
 * 1. **路徑以 `/` 開頭，`/` 就是工作區根**，同檔案工具的位址空間（`@nexus/plugin-sandbox-policy` 那句提示）。
 *    查詢開頭的 `/` 可給可不給，伺服器先剝掉一個再分派，所以 `sr` 與 `/sr` 是同一個查詢。
 * 2. **資料夾的 `path` 不帶結尾的 `/`**，同 dsh 的候選：插入時由 client 依 `kind` 補（dsh 的 `formatFileMention`）。
 * 3. **`GET` 也要帶 `content-type: application/json`**，理由同 `THREADS_PATH`。
 *
 * 查法照 dsh 兩種：`query` 空的或含 `/` 的，即時列那一層；其他的對整個工作區的索引做模糊比對。一次最多 20 筆。
 *
 * ## 與 dsh 的偏離
 *
 * 1. **路徑以 `/` 開頭**：dsh 給相對路徑，絕對路徑指主機上的檔。我們的檔案工具收的是 `/` 開頭的虛擬路徑，
 *    給相對路徑會跟那句提示打架。連帶的後果：dsh 對 `/etc/` 這種主機路徑回空，我們剝掉 `/` 之後查的是工作區裡的
 *    `etc/`。
 * 2. **路徑掛在 thread 底下、走 `GET`**：dsh 是 Remote `fileReferences/list`。我們的 server 一律以 thread 分路，而且
 *    `/threads/:id/…` 才在瀏覽器會話認證（#424）的圍欄裡。
 * 3. **沒給 `--workspace` 就不提供**（{@link FileReferenceListResult} 的 `available: false`）：dsh 永遠有 cwd。我們沒有工作區時
 *    檔案工具讀的是記憶體裡的 state，列磁碟上的檔等於引導模型去讀一個它讀不到的位址。
 *
 * @module
 */

import type { ErrorResponse } from './protocol.js';

/** 一個候選：工作區裡的一個檔或資料夾。 */
export interface FileReferenceCandidate {
  /** 以 `/` 開頭、`/` 是工作區根；資料夾不帶結尾的 `/`。 */
  readonly path: string;
  /** 資料夾可以往下鑽，檔案就是選中。 */
  readonly kind: 'file' | 'directory';
}

/**
 * 列檔的結果。
 *
 * **`available: false` 是「這台 server 沒有工作區」，不是空清單**：web 據它整個不開選單，打 `@` 就是普通字元。
 * 它跟 query 無關，同一台 server 上每一次都一樣，所以 client 問一次就夠。
 */
export type FileReferenceListResult =
  | { readonly available: false }
  | { readonly available: true; readonly candidates: readonly FileReferenceCandidate[] };

/** {@link fileReferencesPath} 的回應封包。 */
export type FileReferenceListResponse =
  { readonly type: 'success'; readonly result: FileReferenceListResult } | ErrorResponse;

/**
 * 列檔的路徑，`GET`，帶 `?query=`（`@` 後面那一段；省略就是空的，列根目錄那一層）。
 *
 * 回應是 `ThreadHistoryResponse` 那種封包：成功是 `{ type: 'success', result: FileReferenceListResult }`，
 * 這條 thread 起不來或索引建不起來是協定層的錯誤封包。**新對話在第一句之前就列得出來**：同 `slash.list`，
 * 沒開過的 thread 會為它建起來。
 *
 * @param threadId - thread id，就是 root 會話的 id。
 * @returns 路徑。
 */
export function fileReferencesPath(threadId: string): string {
  return `/threads/${encodeURIComponent(threadId)}/file-references`;
}
