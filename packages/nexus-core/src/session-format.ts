/**
 * 會話日誌格式的**版本邊目錄**（[#1529](https://github.com/DemianLi/nexus-agent/issues/1529) 第一刀）：每一次升
 * {@link SESSION_LOG_FORMAT_VERSION}，這一版與上一版是什麼關係，寫成資料、在模組載入時驗。
 *
 * ## 照 dsh 的什麼
 *
 * dsh 的靜態目錄（`packages/session/session-format-catalog/src/generated.ts`）直接 import、不依賴掛了哪些插件；建構時
 * 驗重複、缺號、比目前新的版本（`session-format/src/catalog.ts:29-42`），遷移邊必須是 `v(N)→v(N+1)`、不重複、不缺號、
 * 走得到目前版本（`chain.ts:26-74`）；沒有某版的解碼器就拋「不支援」，不算壞檔（`catalog.ts:98-105`）。這裡同樣：
 * 只升常數、不補邊，載入就拋，CI 紅。
 *
 * ## 跟 dsh 不一樣的
 *
 * dsh 的邊是真的遷移（凍結的 codec 加轉換），我們到今天一條都沒有：每一版的檔頭都寫「舊檔直接讀」（`session-store.ts`），
 * 續接把舊檔的事件原樣搬進這一版的世代檔，只把 header 換成最新（#1594 ③）。所以這裡的邊只有兩種：
 *
 * - **`additive`**：比 `to` 舊的檔，今天的讀方直接讀得對。有些靠讀方裡為舊形狀留的分支，記在 `readerBranch`——
 *   那些分支哪天被當成死碼清掉，夾具測試（`apps/harness/src/session-format-fixtures.test.ts`）會紅。
 * - **`breaking`**：這一版沒有那一段的遷移，比 `to` 舊的檔一律拒讀（{@link classifyStoredFormatVersion} 回
 *   `older-without-migration`，`parseHeader` 拋 `SessionFormatUnsupportedError`），列表算進讀不懂。今天沒有任何一條，
 *   它是第一次出現非加性變更、而遷移還沒落地時唯一失敗即關閉的選項。真的遷移（`transform`）等 #1529 第四刀。
 *
 * 事件原樣搬進新世代只在加性區間成立：從存的版本走到目前版本，路上全是 `additive`，舊事件這一版的讀方本來就讀得懂。
 * 路上有一條 `breaking`，`parseHeader` 就擋掉，走不到續接。
 *
 * ## 升版時要做的
 *
 * 1. 升 {@link SESSION_LOG_FORMAT_VERSION}，在 `session-store.ts` 檔頭寫那一版的段落（讀舊檔的敘事），並在
 *    `docs/persistence-changes/` 寫一筆 `version-bump` 紀錄（[#1856](https://github.com/DemianLi/nexus-agent/issues/1856)，
 *    `persistence-changes --record ID --decision version-bump`；header 版號一變，驗證器就要求這一筆）。
 * 2. 在下面的 {@link SESSION_FORMAT_EDGES} 末尾加一條 `{ from: 舊, to: 新, … }`。不加的話這個模組載入就拋。
 * 3. 讀方為舊形狀留了分支的，填 `readerBranch`，並讓 `apps/harness/src/fixtures/session-format/` 裡某一份比 `to` 舊的夾具
 *    含觸發它的事件（夾具的 `expected.json` 的 `triggers` 登記這條邊；規則測試檢查每條 `readerBranch` 都有），並在
 *    規則測試的錨點表登記那一行一定有的字串（行號漂了、或指到別的行，那裡會紅）。
 * 4. 要發的版本格式版本是新的，**發版前**另開一張進 `develop` 的 PR，把它加進 {@link RELEASED_SESSION_FORMAT_VERSIONS}，
 *    並用當下 `develop` 那個 commit 的寫入器凍一份夾具（產生器在 `scripts/session-format-fixtures/`；細節見
 *    `docs/standards.md`〈會話日誌格式〉）。`develop → main` 的 PR 不另加 commit、tag 要發完才有，所以不能留到那一步。
 *
 * ## 同一版之內新增、沒有升版的欄位
 *
 * 這份目錄只記升版的邊。同一版之內的型別變更逐筆登記在 `docs/persistence-changes/`
 * （[#1856](https://github.com/DemianLi/nexus-agent/issues/1856)，由 `apps/harness/src/persistence-changes.ts` 驗、CI 擋）；
 * 50 版以前的（32、48、49 之內）寫在基線 `2026-10-23-initial.md` 的〈相容性〉。
 *
 * @module
 */

import { SESSION_LOG_FORMAT_VERSION } from './session-store.js';

/** 一條版本邊的種類。見模組說明。 */
export type SessionFormatEdgeKind = 'additive' | 'breaking';

/** 相鄰兩版之間的一條邊。 */
export interface SessionFormatEdge {
  /** 舊的那一版。 */
  readonly from: number;
  /** 新的那一版，恆為 `from + 1`。 */
  readonly to: number;
  readonly kind: SessionFormatEdgeKind;
  /** 這一版的卡，`#N`。段落在 `session-store.ts` 檔頭的 `## <to>`。 */
  readonly ref: string;
  /**
   * 今天的讀方為「比 `to` 舊的寫入器才寫得出來的形狀」留的分支，`<repo 相對路徑>:<行號>`，指到判斷的那一行。
   * 只在 `additive` 上有意義：`breaking` 的舊檔根本讀不到讀方。
   */
  readonly readerBranch?: string;
}

/** 驗過的目錄。只由 {@link createSessionFormatCatalog} 產生。 */
export interface SessionFormatCatalog {
  /** 目錄走得到的最新版本，等於建它時給的 `current`。 */
  readonly current: number;
  /** 照 `from` 排、從 1 連續到 `current` 的邊。 */
  readonly edges: readonly SessionFormatEdge[];
}

/**
 * 驗一份邊的清單並凍起來。照 dsh `chain.ts:26-74`：每條是 `v(N)→v(N+1)`、不重複、從 1 連續走到 `current`。
 *
 * @param edges - 邊，順序不拘。
 * @param current - 要走到的版本。產品用 {@link SESSION_LOG_FORMAT_VERSION}；測試注入別的值驗「最後一條沒到常數」。
 * @returns 驗過、照 `from` 排好的目錄。
 * @throws Error 任何一條不合。
 */
export function createSessionFormatCatalog(
  edges: readonly SessionFormatEdge[],
  current: number = SESSION_LOG_FORMAT_VERSION,
): SessionFormatCatalog {
  if (!Number.isSafeInteger(current) || current < 1) {
    throw new Error(`會話格式目錄：目前版本 ${String(current)} 不是正整數。`);
  }
  const byFrom = new Map<number, SessionFormatEdge>();
  for (const edge of edges) {
    if (!Number.isSafeInteger(edge.from) || edge.from < 1 || edge.to !== edge.from + 1) {
      throw new Error(
        `會話格式目錄：邊 ${String(edge.from)}→${String(edge.to)} 不是相鄰的兩版（要 N→N+1）。`,
      );
    }
    if (byFrom.has(edge.from)) {
      throw new Error(`會話格式目錄：邊 ${String(edge.from)}→${String(edge.to)} 重複。`);
    }
    byFrom.set(edge.from, edge);
  }
  for (let from = 1; from < current; from += 1) {
    if (!byFrom.has(from)) {
      throw new Error(
        `會話格式目錄：缺 ${String(from)}→${String(from + 1)} 這條邊，走不到目前版本 ${String(current)}。` +
          `升了 SESSION_LOG_FORMAT_VERSION 就要在 SESSION_FORMAT_EDGES 補邊。`,
      );
    }
  }
  if (byFrom.size !== current - 1) {
    const beyond = [...byFrom.keys()].filter((from) => from >= current).sort((a, b) => a - b);
    throw new Error(
      `會話格式目錄：有比目前版本 ${String(current)} 新的邊（from ${beyond.join('、')}）。`,
    );
  }
  const sorted = [...byFrom.values()].sort((a, b) => a.from - b.from);
  return Object.freeze({
    current,
    edges: Object.freeze(sorted.map((edge) => Object.freeze({ ...edge }))),
  });
}

/**
 * 每一次升版。**逐條對 `session-store.ts` 檔頭審過**（#1529 PR 內文貼了每一條的判斷），不是一律標 `additive`。
 */
export const SESSION_FORMAT_EDGES: readonly SessionFormatEdge[] = [
  { from: 1, to: 2, kind: 'additive', ref: '#180' },
  { from: 2, to: 3, kind: 'additive', ref: '#251' },
  { from: 3, to: 4, kind: 'additive', ref: '#251' },
  { from: 4, to: 5, kind: 'additive', ref: '#264' },
  { from: 5, to: 6, kind: 'additive', ref: '#266' },
  { from: 6, to: 7, kind: 'additive', ref: '#276' },
  { from: 7, to: 8, kind: 'additive', ref: '#278' },
  {
    from: 8,
    to: 9,
    kind: 'additive',
    ref: '#305',
    readerBranch: 'packages/nexus-core/src/conversation-replay.ts:330',
  },
  {
    from: 9,
    to: 10,
    kind: 'additive',
    ref: '#382',
    readerBranch: 'packages/nexus-core/src/feedback.ts:297',
  },
  { from: 10, to: 11, kind: 'additive', ref: '#441' },
  { from: 11, to: 12, kind: 'additive', ref: '#443' },
  {
    from: 12,
    to: 13,
    kind: 'additive',
    ref: '#504',
    readerBranch: 'apps/harness/src/resume-guards.ts:164',
  },
  { from: 13, to: 14, kind: 'additive', ref: '#528' },
  { from: 14, to: 15, kind: 'additive', ref: '#433' },
  { from: 15, to: 16, kind: 'additive', ref: '#617' },
  { from: 16, to: 17, kind: 'additive', ref: '#637' },
  { from: 17, to: 18, kind: 'additive', ref: '#647' },
  { from: 18, to: 19, kind: 'additive', ref: '#650' },
  { from: 19, to: 20, kind: 'additive', ref: '#710' },
  { from: 20, to: 21, kind: 'additive', ref: '#713' },
  { from: 21, to: 22, kind: 'additive', ref: '#838' },
  { from: 22, to: 23, kind: 'additive', ref: '#839' },
  { from: 23, to: 24, kind: 'additive', ref: '#840' },
  { from: 24, to: 25, kind: 'additive', ref: '#849' },
  { from: 25, to: 26, kind: 'additive', ref: '#875' },
  { from: 26, to: 27, kind: 'additive', ref: '#884' },
  { from: 27, to: 28, kind: 'additive', ref: '#712' },
  { from: 28, to: 29, kind: 'additive', ref: '#721' },
  { from: 29, to: 30, kind: 'additive', ref: '#1025' },
  { from: 30, to: 31, kind: 'additive', ref: '#1023' },
  { from: 31, to: 32, kind: 'additive', ref: '#507' },
  {
    from: 32,
    to: 33,
    kind: 'additive',
    ref: '#721',
    readerBranch: 'apps/harness/src/conversation-history.ts:1177',
  },
  {
    from: 33,
    to: 34,
    kind: 'additive',
    ref: '#437',
    readerBranch: 'packages/nexus-core/src/approval-policy.ts:111',
  },
  { from: 34, to: 35, kind: 'additive', ref: '#437' },
  { from: 35, to: 36, kind: 'additive', ref: '#724' },
  { from: 36, to: 37, kind: 'additive', ref: '#723' },
  { from: 37, to: 38, kind: 'additive', ref: '#732' },
  { from: 38, to: 39, kind: 'additive', ref: '#638' },
  { from: 39, to: 40, kind: 'additive', ref: '#633' },
  { from: 40, to: 41, kind: 'additive', ref: '#633' },
  { from: 41, to: 42, kind: 'additive', ref: '#328' },
  { from: 42, to: 43, kind: 'additive', ref: '#1270' },
  { from: 43, to: 44, kind: 'additive', ref: '#1271' },
  {
    from: 44,
    to: 45,
    kind: 'additive',
    ref: '#1301',
    readerBranch: 'packages/nexus-core/src/conversation-replay.ts:334',
  },
  { from: 45, to: 46, kind: 'additive', ref: '#1302' },
  { from: 46, to: 47, kind: 'additive', ref: '#1303' },
  { from: 47, to: 48, kind: 'additive', ref: '#1335' },
  { from: 48, to: 49, kind: 'additive', ref: '#1629' },
  { from: 49, to: 50, kind: 'additive', ref: '#1624' },
  { from: 50, to: 51, kind: 'additive', ref: '#1579' },
  {
    from: 51,
    to: 52,
    kind: 'additive',
    ref: '#2132',
    readerBranch: 'apps/harness/src/jsonl-session-store.ts:1912',
  },
];

/** 產品用的目錄。模組載入時就驗，不合就拋。 */
export const SESSION_FORMAT_CATALOG: SessionFormatCatalog =
  createSessionFormatCatalog(SESSION_FORMAT_EDGES);

/** 一份存檔的格式版本，對今天的讀方來說是哪一種。 */
export type StoredFormatVersionClass = 'readable' | 'newer' | 'older-without-migration';

/**
 * 一份存檔的格式版本今天讀不讀得了。
 *
 * - 比目錄的目前版本新：`newer`。
 * - 從它走到目前版本，路上有任何一條 `breaking`（`from >= version`）：`older-without-migration`。
 * - 其餘：`readable`。
 *
 * 版本本身合不合法（正整數）不歸這裡判，`parseHeader` 先擋。
 *
 * @param version - header 記的版本。
 * @param catalog - 省略即 {@link SESSION_FORMAT_CATALOG}；測試注入。
 */
export function classifyStoredFormatVersion(
  version: number,
  catalog: SessionFormatCatalog = SESSION_FORMAT_CATALOG,
): StoredFormatVersionClass {
  if (version > catalog.current) return 'newer';
  return catalog.edges.some((edge) => edge.kind === 'breaking' && edge.from >= version)
    ? 'older-without-migration'
    : 'readable';
}

/**
 * 隨 GitHub Release 出過貨的格式版本：每個 tag 的 `SESSION_LOG_FORMAT_VERSION`，去重（v0.4.0 到 v0.5.19；v0.1.0 到
 * v0.3.0 沒有會話日誌），加上發版前先凍好的新版本（52）。每一版在 `apps/harness/src/fixtures/session-format/v<N>/`
 * 都有一份由那一版的寫入器寫出的夾具。
 */
export const RELEASED_SESSION_FORMAT_VERSIONS: readonly number[] = Object.freeze([
  2, 3, 4, 8, 9, 10, 12, 13, 14, 52,
]);
