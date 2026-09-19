/**
 * 每一輪改動檔案的紀錄上線的形狀（[#443](https://github.com/DemianLi/nexus-agent/issues/443)）。
 *
 * 照 dsh `workspace-changes`（`packages/deliverables/workspace-changes/src/types.ts`、
 * `packages/client/ui-deliverables/src/{changes.ts,present-open.ts}`，`ddefc45`）：
 *
 * - **事件只是一個指標**：`custom` frame，`data.name` 是 {@link WORKSPACE_CHANGES}，`payload` 是
 *   {@link WorkspaceChangesPayload}。摘要本身留在 server，web 拿 `seq` 去兩條路由要。
 * - **摘要只活到會話結束**：serve 重開、或從日誌重播出來的那一顆，路由回 404，卡片就不畫。
 *   **404 是正常路徑，不是錯誤**——歷史路由照樣會送出這顆 frame（同 dsh：日誌事件照樣重播）。
 *
 * ## 與 dsh 的偏離
 *
 * 1. **不帶 `turn`**（#443 第二則決議）。我們的 `turn/start` 沒有輪號；同一個輪尾並排的交付卡
 *    （`deliverables/presented`，#441）已經不帶，兩張卡用同一條規則認輪：**由 `seq` 往前找最近一顆不是
 *    resume 的 `turn/start`**。所以摘要也不帶 `turn`。
 * 2. **路徑掛在 thread 底下**：dsh 是 `/api/changes.summary?sessionId&seq`，我們的 server 一律以 thread 分路
 *    （`/threads/:id/...`），thread id 就是 root 會話的 id。錯誤協定照 dsh：400（座標不對）、404（這台 server
 *    不再服務這份摘要，或沒有那個 index）、500（讀檔失敗），回應帶 `cache-control: no-store`。
 * 3. **沒有 `changes.open`**：dsh 在 Host 桌面上開檔；我們的 Host 是多人共用的遠端主機，在那裡開檔使用者
 *    看不到（#443 第一則決議）。
 *
 * **兩條路由送出去的東西不一樣多**：摘要只送路徑與行數；**比較送的是檔案全文**（兩側的每一行都在 hunk 裡），
 * 包括工作區外的檔——`danger-full-access` 或核准過的升級經符號連結改到根外時，那個檔會以主機絕對路徑列出來，
 * 同 dsh README 的已知限制。兩條都在瀏覽器會話認證（#424）之後。
 *
 * **`GET` 也要帶 `content-type: application/json`**，理由同 `THREADS_PATH`。
 *
 * @module
 */

/** `custom` 事件的 `data.name`：一輪的改動摘要好了。 */
export const WORKSPACE_CHANGES = 'workspace/changes';

/** `custom` 事件 `data.payload` 的形狀。 */
export interface WorkspaceChangesPayload {
  /** 那顆 `workspace/changes` 在 root 日誌裡的 `seq`，兩條路由拿它定位摘要。 */
  readonly seq: number;
}

/** 這一輪改過的一個檔案。 */
export interface WorkspaceChangedFile {
  /** 相對工作區根的路徑；在工作區外時是 server 上的絕對路徑。 */
  readonly path: string;
  /** 排序與標籤：工作區內是相對路徑，家目錄底下是 `~` 開頭，其餘是絕對路徑。一律用斜線。 */
  readonly display: string;
  /** 新增的行數；二進位或過大的檔是 0。 */
  readonly added: number;
  /** 刪掉的行數；二進位或過大的檔是 0。 */
  readonly deleted: number;
  /** 有一側含 NUL 位元組。 */
  readonly binary?: true;
  /** 有一側超過大小上限，列出來但沒有行數、也沒有比較。 */
  readonly oversized?: true;
}

/** `changes/summary` 的結果：一輪改了哪些檔。 */
export interface WorkspaceChangesSummary {
  /** 照 `display` 排序，最多上限那麼多個。 */
  readonly files: readonly WorkspaceChangedFile[];
  /** 完整的檔數，含被上限切掉的。 */
  readonly total: number;
  /** 全部檔案新增的行數，含被上限切掉的。 */
  readonly added: number;
  /** 全部檔案刪掉的行數，含被上限切掉的。 */
  readonly deleted: number;
}

/** 一個 unified diff 的 hunk，上下文三行；每一行保留 `+`、`-` 或空白前綴。 */
export interface WorkspaceDiffHunk {
  /** 在這一輪開始時的內容裡從第幾行起，1 起算；那一側沒有行時是 1、行數 0。 */
  readonly oldStart: number;
  readonly oldLines: number;
  /** 在這一輪結束時的內容裡從第幾行起。 */
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly string[];
}

/** `changes/diff` 的結果：一個列出的檔在這一輪開始與結束時的比較。 */
export type WorkspaceFileDiff =
  | {
      readonly kind: 'text';
      readonly path: string;
      readonly display: string;
      /** 這一輪開始時檔案在不在。 */
      readonly before: boolean;
      /** 這一輪結束時檔案在不在。 */
      readonly after: boolean;
      /** 照檔案順序；兩側逐行相同時是空的。 */
      readonly hunks: readonly WorkspaceDiffHunk[];
      /** 逐行比較逾時，退成整檔替換。 */
      readonly coarse: boolean;
    }
  /** 有一側含 NUL 位元組，不送內容。 */
  | { readonly kind: 'binary'; readonly path: string; readonly display: string }
  /** 有一側超過大小上限，不送內容。 */
  | { readonly kind: 'oversized'; readonly path: string; readonly display: string };

/**
 * 一輪改動摘要的路徑，`GET`，帶 `?seq=`。
 * @param threadId - thread id，就是 root 會話的 id。
 * @returns 路徑。
 */
export function changesSummaryPath(threadId: string): string {
  return `/threads/${encodeURIComponent(threadId)}/changes/summary`;
}

/**
 * 一個列出的檔的比較，`GET`，帶 `?seq=&index=`（`index` 是它在摘要 `files` 裡的位置）。
 * @param threadId - thread id，就是 root 會話的 id。
 * @returns 路徑。
 */
export function changesDiffPath(threadId: string): string {
  return `/threads/${encodeURIComponent(threadId)}/changes/diff`;
}
