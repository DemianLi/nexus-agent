/**
 * 改動紀錄的四個資料格式（[#689](https://github.com/DemianLi/nexus-agent/issues/689)）：一輪改了哪些檔、每個檔的
 * 新增與刪除行數、一個檔的逐行比較。
 *
 * 照 dsh `workspace-changes`（`packages/deliverables/workspace-changes/src/types.ts`，`477b4f4`）：**定義住在生產它們的
 * 外掛裡**，另開一個純型別的入口（`package.json` 的 `./types`，dsh `package.json:21`），檔內不 import 任何東西。
 * 消費端（`@nexus/wire`，再經它轉出給 web）在 devDependencies 相依這個外掛、只做 `import type`／`export type`，
 * 方向是消費端 → 生產端，同 wire 今天對 `@nexus/core` 的那一條。
 *
 * 上線的路徑、網址與回應檢查仍在 `@nexus/wire` 的 `workspace-changes.ts`。
 *
 * @module
 */

/** 這一輪改過的一個檔案。 */
export interface WorkspaceChangedFile {
  /** 相對工作區根的路徑；在工作區外時是 server 上的絕對路徑。 */
  readonly path: string;
  /**
   * 排序與標籤：工作區內是相對路徑，repo 裡、工作區之上的是 `../` 開頭，家目錄底下是 `~` 開頭，其餘是絕對路徑。
   * 一律用斜線。
   */
  readonly display: string;
  /** 新增的行數；二進位或過大的檔是 0。 */
  readonly added: number;
  /** 刪掉的行數；二進位或過大的檔是 0。 */
  readonly deleted: number;
  /** git 判成二進位，或有一側含 NUL 位元組。 */
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
  /** git 判成二進位，或有一側含 NUL 位元組，不送內容。 */
  | { readonly kind: 'binary'; readonly path: string; readonly display: string }
  /** 有一側超過大小上限，不送內容。 */
  | { readonly kind: 'oversized'; readonly path: string; readonly display: string };
