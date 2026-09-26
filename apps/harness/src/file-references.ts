/**
 * `@` 引用的列檔與它那一句提示（[#651](https://github.com/DemianLi/nexus-agent/issues/651)）。
 *
 * 照 dsh 的 `file-reference-local`（`packages/context/file-reference-local/src/{search,index}.ts`，`477b4f4`）：
 *
 * - {@link WorkspaceFileSearch} **逐字移植** dsh 的同名 class：不讀 `.gitignore`、用固定清單按 basename 排除目錄、
 *   隱藏檔預設不列、不跟符號連結、不出工作區；一次最多 20 筆，索引上限 5 萬筆。空 query 或含 `/` 的即時列那一層，
 *   其他的對快取索引做模糊比對。索引被標過期之後先用舊的回答，同時在背景重建；每個呼叫者自己取消，不殺共用的走訪。
 * - {@link listFileReferences} 是**我們加的那一層位址翻譯**，只做這一件事：查詢開頭的 `/` 剝掉一個再交給 dsh 的分派，
 *   回來的路徑補回 `/`。理由見 `@nexus/wire` 的 `file-references.ts`。
 * - {@link createFileReferencePlugin} 是 dsh `context:file-reference` 那段提示的對應物。
 *
 * **只給路徑，不讀內容**：同 dsh README 的「never reads or attaches file contents」。
 *
 * ## 圍堵
 *
 * 這是第一條「由客戶端給路徑、去讀磁碟」的路由。dsh 的做法（`resolveDisplayDirectory`）是 `resolve` → `relative` 判出界，
 * 再從根往下**逐段 `lstat`**，任何一段是符號連結或不是資料夾就回空。路徑上沒有符號連結時，realpath 就等於根接上那段
 * 相對路徑，所以這一套已經蓋住「realpath 必須在根之內」那一條（同 `deliverable-files.ts` 的
 * `locateDeliverableFile`），不另疊一套 realpath 比較——疊的話兩側都得 realpath，macOS 的暫存目錄在
 * `/var` → `/private/var` 後面，只 realpath 一側會把整個工作區判成根外。
 *
 * 走訪（索引）那一半靠 `Dirent`：`isDirectory()` 對符號連結回 `false`，所以指向任何地方的連結都不會被走進去；
 * `isFile()` 也回 `false`，所以連結本身也不列。
 *
 * **不用 backend 的 `ls`／`glob`**：`ContainedFilesystemBackend` 只圍寫、不圍讀（`contained-backend.ts`），基座的 `glob`
 * 沒有排除也沒有上限，會走進 `node_modules`。
 *
 * ## 偏離
 *
 * 1. **路徑以 `/` 開頭**：見 `@nexus/wire` 的 `file-references.ts`。
 * 2. **提示句只在有工作區時注入**：dsh 是「有 `read` 工具就注入」。我們沒有工作區時不提供列檔（web 不開選單），使用者
 *    插不出 `@` 路徑，這句就沒有對象；檔案工具那時讀的也不是磁碟。所以跟 `@nexus/plugin-sandbox-policy` 同一個條件掛。
 * 3. **三個上限是常數，不是設定**：dsh 的 `maxResults`／`maxEntries`／`excludedDirectories` 是部署可覆寫的 Config。
 *    出廠值一樣，dsh 的 web-app bundle 也沒覆寫（`packages/bundle/web-app/cordis.patch.yml`），所以出廠行為不變，
 *    少的是那個旋鈕。
 *
 * @module
 */

import { lstat, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { NexusPlugin, PluginEntry } from '@nexus/core';
import type { FileReferenceCandidate } from '@nexus/wire';
import { createMiddleware } from 'langchain';

/** 一次查詢最多回幾筆。同 dsh 的 `DEFAULT_FILE_SEARCH_MAX_RESULTS`。 */
export const FILE_SEARCH_MAX_RESULTS = 20;
/** 一份索引最多收幾筆。同 dsh 的 `DEFAULT_FILE_SEARCH_MAX_ENTRIES`。 */
export const FILE_SEARCH_MAX_ENTRIES = 50_000;
/**
 * 按 basename 排除、不走也不列的目錄，同 dsh 的 `DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES`：版本控制、相依，
 * 以及沒有哪個生態拿來放原始碼的建置產物。產物帶著產生它的原始碼的 basename，不排除的話索引額度花兩次，
 * 而且每次查詢 `dist/x.js` 都跟 `src/x.ts` 排在一起。
 *
 * **`lib` 刻意不在裡面**：Ruby gem 與很多 npm 套件的原始碼放在那裡，排掉的話 `@` 會整個、而且靜靜地找不到它們。
 */
export const FILE_SEARCH_EXCLUDED_DIRECTORIES = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  '.next',
  '.nuxt',
  '.turbo',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.gradle',
] as const;

/** 一份索引的上限與排除。同 dsh 的 `FileSearchConfig`。 */
export interface FileSearchConfig {
  /** 一次查詢最多回幾筆。 */
  readonly maxResults: number;
  /** 索引最多收幾筆檔案與資料夾。 */
  readonly maxEntries: number;
  /** 不走也不列的目錄 basename。 */
  readonly excludedDirectories: readonly string[];
}

/** 出廠那一份：三個都是 dsh 的預設值。 */
export const FILE_SEARCH_DEFAULTS: FileSearchConfig = {
  maxResults: FILE_SEARCH_MAX_RESULTS,
  maxEntries: FILE_SEARCH_MAX_ENTRIES,
  excludedDirectories: FILE_SEARCH_EXCLUDED_DIRECTORIES,
};

/**
 * dsh 那一層的候選：**相對工作區根、不帶開頭的 `/`**。上線之前由 {@link listFileReferences} 補上。
 */
export interface RelativeCandidate {
  readonly path: string;
  readonly kind: FileReferenceCandidate['kind'];
}

interface RankedPath {
  readonly candidate: RelativeCandidate;
  readonly score: number;
}

interface IndexGeneration {
  readonly controller: AbortController;
  promise: Promise<RelativeCandidate[]>;
}

/** 一次走完的索引，與它開走那一刻看到的失效計數。 */
interface SettledIndex {
  readonly entries: RelativeCandidate[];
  readonly startedAt: number;
}

/**
 * 一個工作區根上可取消、可重用的模糊索引。同 dsh 的 `WorkspaceFileSearch`。
 *
 * 指名資料夾的查詢列即時的那一層；裸字的查詢共用一次有上限的走訪。**只有一個工作區的第一次裸查詢會等那次走訪**
 * ——失效之後，舊的索引照答，替代品在背景建。
 */
export class WorkspaceFileSearch {
  readonly #root: string;
  readonly #config: FileSearchConfig;
  readonly #excludedDirectories: ReadonlySet<string>;
  #settled: SettledIndex | undefined;
  #generation: IndexGeneration | undefined;
  /** 單調遞增的失效計數；開走時的計數比它小的索引就是過期的。 */
  #invalidations = 0;
  #disposed = false;

  constructor(root: string, config: FileSearchConfig = FILE_SEARCH_DEFAULTS) {
    if (!Number.isSafeInteger(config.maxResults) || config.maxResults <= 0) {
      throw new Error('file search maxResults must be a positive safe integer');
    }
    if (!Number.isSafeInteger(config.maxEntries) || config.maxEntries <= 0) {
      throw new Error('file search maxEntries must be a positive safe integer');
    }
    if (
      config.excludedDirectories.some(
        (name) => name.length === 0 || name.includes('/') || name.includes('\\'),
      )
    ) {
      throw new Error(
        'file search excludedDirectories entries must be non-empty directory basenames',
      );
    }
    this.#root = root;
    this.#config = config;
    this.#excludedDirectories = new Set(config.excludedDirectories);
  }

  /**
   * 這一段的候選，排好序。
   *
   * @param rawQuery - `@` 或 `@"` 後面那一段，**相對工作區根**（開頭的 `/` 由 {@link listFileReferences} 剝掉）。
   * @param signal - 只取消這個呼叫者的等待，不殺掉一個被更新的查詢共用的走訪。
   * @returns 最多 `maxResults` 筆，順序是決定性的。
   */
  async list(rawQuery: string, signal: AbortSignal): Promise<RelativeCandidate[]> {
    signal.throwIfAborted();
    if (this.#disposed) return [];
    const query = rawQuery.replaceAll('\\', '/');
    const slash = query.lastIndexOf('/');
    if (query === '' || slash >= 0) {
      const directory = slash < 0 ? '' : query.slice(0, slash + 1);
      const fragment = slash < 0 ? '' : query.slice(slash + 1);
      return this.#listDirectory(directory, fragment, signal);
    }
    const indexed = await this.#indexFor(signal);
    return rankCandidates(
      indexed.filter((candidate) => visibleForGlobalQuery(candidate.path, query)),
      query,
      this.#config.maxResults,
    );
  }

  /**
   * 把索引標成過期，讓之後的裸查詢看到新的樹。
   *
   * **舊的條目留著、照答**：重建一次要走完整個工作區，每來一個工具結果就失效一次的呼叫者，會把那次走訪整個擺在
   * 游標前面。
   */
  invalidate(): void {
    this.#invalidations += 1;
  }

  /** 中止走訪，之後的查詢一律回空。 */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation?.controller.abort(new Error('file search index disposed'));
    this.#generation = undefined;
    this.#settled = undefined;
  }

  /**
   * 裸查詢排序的那一批。只有第一次裸查詢會等走訪；之後過期的索引當場回答，替代品在背景建。
   *
   * @param signal - 只取消這個呼叫者的等待，不殺掉共用的走訪。
   * @returns 索引裡的路徑，最多落後樹一次失效。
   */
  async #indexFor(signal: AbortSignal): Promise<readonly RelativeCandidate[]> {
    const settled = this.#settled;
    if (settled === undefined) return waitForPromise(this.#ensureIndex(), signal);
    if (settled.startedAt < this.#invalidations) {
      void this.#ensureIndex().catch(() => {
        // 背景重建失敗不是這個呼叫者的錯：舊的條目照答，`startedAt` 留在後面，所以下一次裸查詢會再試一次。
      });
    }
    return settled.entries;
  }

  #ensureIndex(): Promise<RelativeCandidate[]> {
    if (this.#generation !== undefined) return this.#generation.promise;
    const controller = new AbortController();
    const startedAt = this.#invalidations;
    const generation: IndexGeneration = {
      controller,
      promise: Promise.resolve([]),
    };
    generation.promise = this.#scanWorkspace(controller.signal).then(
      (entries) => {
        /* v8 ignore next -- dispose 會中止這次走訪，走的是 rejection 那一支；這一道只擋「最後一個目錄剛好在中止落地前
         * 讀完」那一瞬間，不能把條目交還給一個已經收掉的索引。同 dsh。 */
        if (this.#disposed) return entries;
        this.#generation = undefined;
        this.#settled = { entries, startedAt };
        return entries;
      },
      (error: unknown) => {
        /* v8 ignore next -- dispose 同步清掉 `generation`；這一道只擋預期之外的走訪失敗。同 dsh。 */
        if (this.#generation === generation) this.#generation = undefined;
        throw error;
      },
    );
    this.#generation = generation;
    return generation.promise;
  }

  async #scanWorkspace(signal: AbortSignal): Promise<RelativeCandidate[]> {
    const indexed: RelativeCandidate[] = [];
    const directories: { readonly absolute: string; readonly relative: string }[] = [
      { absolute: this.#root, relative: '' },
    ];
    for (
      let cursor = 0;
      cursor < directories.length && indexed.length < this.#config.maxEntries;
      cursor += 1
    ) {
      signal.throwIfAborted();
      const directory = directories[cursor];
      /* v8 ignore next 3 -- cursor 的上限就是這個佇列自己的長度。 */
      if (directory === undefined) {
        throw new Error('file search selected a missing directory');
      }
      // **根不是一棵子樹**：讀不到的分支只少掉它自己的候選，但讀不到根代表這次走訪什麼都沒學到。讓它落定的話，
      // 一份空索引會蓋掉還好好的條目，而且不留任何失效可以重試。同 dsh。
      const entries =
        cursor === 0
          ? await readWorkspaceRoot(directory.absolute, signal)
          : await readDirectory(directory.absolute, signal);
      for (const entry of entries) {
        signal.throwIfAborted();
        const path = directory.relative === '' ? entry.name : `${directory.relative}/${entry.name}`;
        if (entry.isDirectory()) {
          if (this.#excludedDirectories.has(entry.name)) continue;
          indexed.push({ path, kind: 'directory' });
          directories.push({ absolute: join(directory.absolute, entry.name), relative: path });
        } else if (entry.isFile()) {
          indexed.push({ path, kind: 'file' });
        }
        if (indexed.length >= this.#config.maxEntries) break;
      }
    }
    return indexed;
  }

  async #listDirectory(
    displayDirectory: string,
    fragment: string,
    signal: AbortSignal,
  ): Promise<RelativeCandidate[]> {
    if (displayDirectory.split('/').some((segment) => this.#excludedDirectories.has(segment))) {
      return [];
    }
    const absolute = await resolveDisplayDirectory(this.#root, displayDirectory, signal);
    if (absolute === undefined) return [];
    const entries = await readDirectory(absolute, signal);
    const candidates: RelativeCandidate[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.') && !fragment.startsWith('.')) continue;
      if (entry.isDirectory()) {
        if (this.#excludedDirectories.has(entry.name)) continue;
        candidates.push({ path: `${displayDirectory}${entry.name}`, kind: 'directory' });
      } else if (entry.isFile()) {
        candidates.push({ path: `${displayDirectory}${entry.name}`, kind: 'file' });
      }
    }
    return rankCandidates(candidates, fragment, this.#config.maxResults);
  }
}

/**
 * 上線的那一層：**剝掉查詢開頭的一個 `/`、補回結果開頭的 `/`**，其餘原樣交給 {@link WorkspaceFileSearch}。
 *
 * **先換反斜線、再剝**：反過來的話 `\src` 與 `/src` 會是兩種行為——前者留著 `/` 進 dsh 的分派，變成「列根目錄再過濾」，
 * 後者是全域模糊比對。那正是這一層要消掉的東西（`sr` 與 `/sr` 是同一個查詢）。
 *
 * @param search - 這條 thread 的索引。
 * @param rawQuery - `@` 後面那一段，原文原樣。
 * @param signal - 見 {@link WorkspaceFileSearch.list}。
 * @returns 以 `/` 開頭的候選。
 */
export async function listFileReferences(
  search: WorkspaceFileSearch,
  rawQuery: string,
  signal: AbortSignal,
): Promise<FileReferenceCandidate[]> {
  const slashed = rawQuery.replaceAll('\\', '/');
  const query = slashed.startsWith('/') ? slashed.slice(1) : slashed;
  const found = await search.list(query, signal);
  return found.map(({ path, kind }) => ({ path: `/${path}`, kind }));
}

async function resolveDisplayDirectory(
  root: string,
  displayDirectory: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const resolvedRoot = resolve(root);
  const absolute = resolve(resolvedRoot, displayDirectory === '' ? '.' : displayDirectory);
  const fromRoot = relative(resolvedRoot, absolute);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) return undefined;
  /* v8 ignore next -- 只有 Windows 會生出跨磁碟區的絕對相對路徑。同 dsh。 */
  if (isAbsolute(fromRoot)) return undefined;
  let current = resolvedRoot;
  for (const segment of fromRoot.split(sep).filter(Boolean)) {
    signal.throwIfAborted();
    current = join(current, segment);
    try {
      const status = await lstat(current);
      signal.throwIfAborted();
      // `lstat` 不跟隨連結，連結的 `isDirectory()` 本來就是 `false`，所以前半句是多餘的：突變量過，拿掉它測試全綠。
      // 照 dsh 逐字留著，它把「連結一律拒」寫明在這一行，不靠讀的人知道 `lstat` 的語意。
      if (status.isSymbolicLink() || !status.isDirectory()) return undefined;
    } catch {
      signal.throwIfAborted();
      return undefined;
    }
  }
  return absolute;
}

async function readWorkspaceRoot(absolute: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const entries = await readdir(absolute, { withFileTypes: true });
  signal.throwIfAborted();
  return entries.sort((left, right) => compareText(left.name, right.name));
}

async function readDirectory(absolute: string, signal: AbortSignal) {
  signal.throwIfAborted();
  try {
    const entries = await readdir(absolute, { withFileTypes: true });
    signal.throwIfAborted();
    return entries.sort((left, right) => compareText(left.name, right.name));
  } catch {
    signal.throwIfAborted();
    // 讀不到或不見了的子樹不貢獻候選；其他讀得到的分支照樣有用，補全本來就只是建議。同 dsh。
    return [];
  }
}

function visibleForGlobalQuery(path: string, query: string): boolean {
  if (query.startsWith('.') || query.includes('/.')) return true;
  return !path.split('/').some((segment) => segment.startsWith('.'));
}

function rankCandidates(
  candidates: readonly RelativeCandidate[],
  query: string,
  limit: number,
): RelativeCandidate[] {
  const ranked: RankedPath[] = [];
  for (const candidate of candidates) {
    const score = scoreCandidate(candidate, query);
    if (score !== undefined) ranked.push({ candidate, score });
  }
  ranked.sort(
    (left, right) =>
      right.score - left.score ||
      kindRank(left.candidate.kind) - kindRank(right.candidate.kind) ||
      (query === '' ? 0 : left.candidate.path.length - right.candidate.path.length) ||
      compareText(left.candidate.path, right.candidate.path),
  );
  return ranked.slice(0, limit).map((entry) => entry.candidate);
}

function scoreCandidate(candidate: RelativeCandidate, query: string): number | undefined {
  if (query === '') return 0;
  const path = candidate.path.toLowerCase();
  const name = path.slice(path.lastIndexOf('/') + 1);
  const needle = query.toLowerCase();
  const directoryBonus = candidate.kind === 'directory' ? 25 : 0;
  if (name === needle) return 1_000 + directoryBonus;
  if (name.startsWith(needle)) return 900 + directoryBonus;
  if (name.includes(needle)) return 700 + directoryBonus;
  if (path.includes(needle)) return 500 + directoryBonus;
  const subsequence = subsequenceScore(path, needle);
  return subsequence === undefined ? undefined : 300 + subsequence + directoryBonus;
}

function subsequenceScore(target: string, query: string): number | undefined {
  let targetIndex = 0;
  let gap = 0;
  for (const character of query) {
    const found = target.indexOf(character, targetIndex);
    if (found < 0) return undefined;
    gap += found - targetIndex;
    targetIndex = found + 1;
  }
  return Math.max(0, 100 - gap);
}

function kindRank(kind: RelativeCandidate['kind']): number {
  return kind === 'directory' ? 0 : 1;
}

function compareText(left: string, right: string): number {
  /* v8 ignore next -- 條目與候選都不重複；誰跟誰比由主機列舉的順序決定。同 dsh。 */
  return left < right ? -1 : left > right ? 1 : 0;
}

function waitForPromise<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  /* v8 ignore next -- `list()` 在同步呼叫進來之前剛查過這顆 signal。同 dsh。 */
  if (signal.aborted) return Promise.reject(errorReason(signal.reason, 'file search aborted'));
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const onAbort = (): void => {
      rejectPromise(errorReason(signal.reason, 'file search aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolvePromise(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        rejectPromise(errorReason(error, 'file search index failed'));
      },
    );
  });
}

function errorReason(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(fallback, { cause: reason });
}

/**
 * 講給模型聽的那一句，dsh `FILE_REFERENCE_PROMPT` 的對應物。
 *
 * **語意照 dsh**（只給路徑、叫模型自己讀、讀之前不要說看過了、`@"…"` 是含空白的路徑）；**位址照我們的**：dsh 說「相對路徑
 * 從工作區根解析、絕對路徑是主機上的檔」，而我們的檔案工具收的是 `/` 開頭的虛擬路徑，照抄那半句會把模型帶去傳主機路徑
 * （`@nexus/plugin-sandbox-policy` 模組註解裡量過的那次：30 輪裡 23 輪用錯）。工具名是這個組裝真的註冊的那兩顆
 * （`base-tools.ts`）。
 */
export const FILE_REFERENCE_PROMPT =
  '`@` 開頭的是使用者明確引用的路徑，從 `/` 寫起，`/` 就是工作區根。' +
  '結尾是 `/` 的是資料夾，內容要緊時先用 ls 列出它；其他的是檔案，需要內容時用 read_file 讀，讀之前不要說你看過了。' +
  '`@"…"` 是含空白的路徑。';

/** 這個 middleware 的名字。 */
export const FILE_REFERENCE_MIDDLEWARE_NAME = 'nexusFileReference';

/**
 * 把 {@link FILE_REFERENCE_PROMPT} 接到每一次模型呼叫的 system prompt 後面。
 *
 * **只在有工作區的組裝上掛**，條件跟 `createSandboxPolicyPlugin()` 同一個，理由見模組註解的偏離 2。接法照抄
 * sandbox-policy：`wrapModelCall`、`concat` 不取代，`systemMessage` 在就接在它後面，不在就由 `systemPrompt` 承接。
 */
export const fileReferencePlugin: NexusPlugin = {
  name: 'file-reference',
  apply(registry) {
    registry.middleware.use(
      createMiddleware({
        name: FILE_REFERENCE_MIDDLEWARE_NAME,
        wrapModelCall: (request, handler) => {
          const { systemMessage } = request;
          return handler(
            systemMessage === undefined
              ? { ...request, systemPrompt: FILE_REFERENCE_PROMPT }
              : { ...request, systemMessage: systemMessage.concat(`\n${FILE_REFERENCE_PROMPT}`) },
          );
        },
      }),
    );
  },
};

/** 建一個條目，放進組裝點的清單。 */
export function createFileReferencePlugin(): PluginEntry {
  return { plugin: fileReferencePlugin };
}
