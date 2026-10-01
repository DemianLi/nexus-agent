/**
 * 搜尋結果超過筆數上限時自存全文（[#735](https://github.com/DemianLi/nexus-agent/issues/735)）：`grep` 命中超過
 * `grepMaxMatches`、`glob`／`ls` 超過 `globMaxResults` 時，模型只收到前段加一句定位，完整結果存進外溢的存檔服務
 * （#719 的 {@link SpillStore}），要看全部就 `read_file` 照定位讀。
 *
 * ## 照 dsh 的部分（`packages/fs/tool-fs-search/src/{grep,glob,search-core,index}.ts`，`477b4f4`）
 *
 * - **觸發看筆數、不看字數**：`grep` 數攤平的命中、`glob` 數路徑；剛好等於上限時原樣（`grep.ts:351`、`glob.ts:361`）。
 * - 預設上限 250 與 100（`grep.ts:29`、`glob.ts:25`），是部署可設的欄位（`index.ts:99-100`），欄位名照抄。
 * - 存的是**完整**結果，行內留前段（`grep.ts:342-365`、`glob.ts:355-367`）；`glob` 留按順序的前段，不抽樣——那是
 *   base 出廠的 `sampleOverCapGlobResults: false`（`packages/bundle/base/cordis.patch.yml:286`）。
 * - **存不下照樣成功**：沒有存檔服務、或存檔拋錯，保留行內的前段、註明沒存到，`isError` 不變
 *   （`search-core.ts:370-374`、`:388-410`）。措辭照抄。
 *
 * ## 載體（依 AGENTS.md 登記：哪一條、為什麼、退到什麼）
 *
 * dsh 的搜尋工具是自己的，結果在工具裡還是結構化的值，`tools/post-execute` 拿著那個值決定存不存。
 * **`deepagents@1.13.1` 的 `ls`／`glob`／`grep` 是基座的**：名字無條件保留（自訂同名工具在建構時就被拒，
 * `apps/harness/src/base-tools.ts`），工具本體在自己裡面就把 backend 的結構化結果壓成文字，超過 80,000 字元再自己截掉
 * （`truncateIfTooLong`，`dist/langsmith-zm0ILQsV.js:302`）。換不掉工具，也拿不到它手上的值，所以退到 #617 搜尋卡
 * 已經走過的那條路（`tool-result-meta.ts`）：**一對**——
 *
 * 1. {@link createSearchOverflowMiddleware}（`wrapToolCall`）在那三顆工具的呼叫外面開一個槽，記著上限；
 * 2. {@link capSearchResults} 包 backend，在**這次呼叫的第一次** `grep`／`glob`／`ls` 拿到結構化結果時，超過上限就把
 *    完整的放進槽、只把前段交給基座的工具本體；
 * 3. 工具回來之後，middleware 把完整的那份照基座的格式排好存檔，在基座排好的前段後面接上定位。
 *
 * 只掛一半會靜默失效（沒有槽，包裝什麼都不做；沒有包裝，槽永遠是空的），所以兩半都只由 `foldRegistry` 組起來（#698）。
 *
 * ## 其餘偏離
 *
 * 1. **`ls` 也換**（#735 拍板）。dsh 沒有這顆工具，退到最接近的 `glob`：項目筆數超過上限就存全文，上限沿用
 *    `globMaxResults`（dsh 唯一可抄的數字），不另開一格。
 * 2. **`grep` 只換 `content` 模式。** dsh 的 `grep` 只有一種輸出（逐行命中）；基座另有 `files_with_matches` 與 `count`，
 *    輸出是檔名或計數，按命中截會把計數算錯。那兩種照基座原樣。
 * 3. **`grep` 的前段是「按路徑排序後」的前 250 筆。** 基座排版時按路徑排檔案（`formatGrepResults` 的
 *    `Object.keys(...).sort()`），所以先照同一個順序穩定排序再截，行內才會是存檔那份的前段；dsh 是 ripgrep 的輸出順序。
 * 4. **基座自己的 `max_count`（預設 1000）是另一件事，不動。** 它是「最多要幾筆」的請求上限，命中時基座附一句
 *    「the search stopped early」；dsh 的上限是「行內留幾筆、其餘存檔」。兩者疊在一起時，存下來的是基座交出的那 1000 筆，
 *    基座那句提醒照樣在，所以模型知道存檔那份也不完整。
 * 5. **行內文字的排版是基座的**（`path:` 加縮排的 `行號: 內容`），不是 dsh 的 `Line N:`；改它等於換掉工具，而工具換不掉。
 *    dsh 的開頭一行（`Found 250 of 251 matches`）與結尾的定位照抄；`glob` 的定位措辭把 `sorted` 換成 `glob`——
 *    dsh 的 `sorted` 指按修改時間排，我們的順序是 backend 的（實際上按路徑），寫 `sorted` 會說錯。
 * 6. **有 `permissions` 規則的組裝不掛**（同搜尋卡，見 `fold.ts` 的 `searchMetaAllowed`）：基座拿到 backend 的結果之後
 *    還會照規則濾一次（`filterByPermissions`，沒匯出），這一層看到的是濾之前的那份——照樣存檔，模型看不到的路徑就進了
 *    存檔那份。那種組裝照基座原樣。今天產品碼沒有人註冊規則。
 *
 * @module
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { ToolMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from './base-types.js';
import { resolveToolName } from './containment.js';
import type { SpillRef, SpillStore } from './spill-policy.js';

/** 這一層 middleware 的名字。 */
export const SEARCH_OVERFLOW_MIDDLEWARE_NAME = 'nexusSearchOverflow';

/** `grep` 行內最多留幾筆命中，同 dsh 的 `GREP_MAX_MATCHES`。 */
export const GREP_MAX_MATCHES = 250;

/** `glob`（與 `ls`）行內最多留幾條路徑，同 dsh 的 `GLOB_MAX_RESULTS`。 */
export const GLOB_MAX_RESULTS = 100;

/** 兩個上限。欄位名照 dsh `tool-fs-search` 的 Config。 */
export interface SearchResultLimits {
  readonly grepMaxMatches: number;
  readonly globMaxResults: number;
}

/** 這一層的設定。 */
export interface SearchOverflowOptions {
  /** 上限。 */
  readonly limits: SearchResultLimits;
  /** 完整結果存到哪；缺席就只留前段、註明沒存到（照 dsh 的「沒有 `spillStore`」）。 */
  readonly store?: SpillStore;
  /** 沒存到時講一聲。缺席就不講。 */
  readonly warn?: (message: string) => void;
}

/** 管的三顆工具。 */
type SearchTool = 'grep' | 'glob' | 'ls';

/** 基座 `GrepMatch` 的形狀：`line` 是行號，`text` 是那一行。 */
interface GrepMatchLike {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

/** 基座 `FileInfo` 用得到的那幾格。 */
interface FileInfoLike {
  readonly path: string;
  readonly is_dir?: boolean;
  readonly size?: number;
}

/** 超過上限時包裝放進槽的完整結果。 */
type Overflow =
  | {
      readonly tool: 'grep';
      readonly matches: readonly GrepMatchLike[];
      readonly kept: number;
    }
  | { readonly tool: 'glob'; readonly paths: readonly string[]; readonly kept: number }
  | { readonly tool: 'ls'; readonly files: readonly FileInfoLike[]; readonly kept: number };

/** 一次工具呼叫的槽。 */
interface SearchSlot {
  readonly tool: SearchTool;
  readonly args: Readonly<Record<string, unknown>>;
  readonly limit: number;
  /** 包裝已經處理過這次呼叫的第一次 backend 呼叫。之後的（搜尋卡數總數那一次）原樣通過。 */
  taken: boolean;
  overflow?: Overflow;
}

const currentSlot = new AsyncLocalStorage<SearchSlot>();

/**
 * 被截過的結果上掛著截之前有幾筆。**只給同一對的另一個讀者用**：搜尋卡（`tool-result-meta.ts`）要的
 * `total` 是截之前的數，而交給它的已經是前段。用 symbol 是為了不讓基座的工具本體看見——設 `truncated` 的話，
 * 基座會接上一句「raise max_count」，跟我們的定位講相反的話。
 */
export const SEARCH_SEEN: unique symbol = Symbol('nexus.searchSeen');

/**
 * 讀 {@link SEARCH_SEEN}。
 *
 * @param result - backend 交出（經過包裝）的結果。
 * @returns 截之前的筆數；沒被截就是 `undefined`。
 */
export function searchSeenOf(result: unknown): number | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const seen = (result as { readonly [SEARCH_SEEN]?: unknown })[SEARCH_SEEN];
  return typeof seen === 'number' ? seen : undefined;
}

/** 這次呼叫的槽是不是這顆工具的、而且還沒被處理過；是的話標成處理過並交出來。 */
function take(tool: SearchTool): SearchSlot | undefined {
  const slot = currentSlot.getStore();
  if (slot === undefined || slot.tool !== tool || slot.taken) return undefined;
  slot.taken = true;
  return slot;
}

/** 同基座 `Object.keys(...).sort()` 的比較：UTF-16 碼位。 */
function byPath(a: { readonly path: string }, b: { readonly path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function isGrepMatch(value: unknown): value is GrepMatchLike {
  const match = value as Partial<GrepMatchLike> | null;
  return (
    typeof match === 'object' &&
    match !== null &&
    typeof match.path === 'string' &&
    typeof match.line === 'number' &&
    typeof match.text === 'string'
  );
}

function isFileInfo(value: unknown): value is FileInfoLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { readonly path?: unknown }).path === 'string'
  );
}

type Method = (...args: unknown[]) => unknown;

function withGrepCap(method: Method): Method {
  return async (...args: unknown[]): Promise<unknown> => {
    const result = (await method(...args)) as {
      readonly error?: unknown;
      readonly matches?: unknown;
    };
    const slot = take('grep');
    if (slot === undefined || result.error !== undefined || !Array.isArray(result.matches)) {
      return result;
    }
    // 只有 `content` 模式按命中排版，見檔頭偏離 2。
    const mode = slot.args.output_mode;
    if (mode !== undefined && mode !== null && mode !== 'content') return result;
    const matches: unknown[] = result.matches;
    if (matches.length <= slot.limit || !matches.every(isGrepMatch)) return result;
    // 穩定排序：同一檔內保持 backend 的順序，同基座排版（見檔頭偏離 3）。
    const sorted = [...matches].sort(byPath);
    slot.overflow = { tool: 'grep', matches: sorted, kept: slot.limit };
    return { ...result, matches: sorted.slice(0, slot.limit), [SEARCH_SEEN]: sorted.length };
  };
}

function withListCap(tool: 'glob' | 'ls', method: Method): Method {
  return async (...args: unknown[]): Promise<unknown> => {
    const result = (await method(...args)) as {
      readonly error?: unknown;
      readonly files?: unknown;
    };
    const slot = take(tool);
    if (slot === undefined || result.error !== undefined || !Array.isArray(result.files)) {
      return result;
    }
    const files: unknown[] = result.files;
    if (files.length <= slot.limit || !files.every(isFileInfo)) return result;
    slot.overflow =
      tool === 'glob'
        ? { tool, paths: files.map((info) => info.path), kept: slot.limit }
        : { tool, files, kept: slot.limit };
    return { ...result, files: files.slice(0, slot.limit), [SEARCH_SEEN]: files.length };
  };
}

/**
 * 把 backend 包一層，在搜尋工具那一次呼叫裡截前段、把完整的放進槽。**只給 `foldRegistry` 用**，見檔頭「載體」。
 *
 * 要包在搜尋卡那一層（`recordToolResultMeta`）的**內側**：卡片看到的是截過的前段，跟模型同一份。
 * 轉交同一個實例，同 `recordToolResultMeta`。
 *
 * @param backend - fold 折出來的那個。
 * @returns 交給外面幾層的那一份。
 */
export function capSearchResults<T extends object>(backend: T): T {
  return new Proxy(backend, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      const method = (value as Method).bind(target);
      switch (property) {
        case 'grep':
          return withGrepCap(method);
        case 'glob':
          return withListCap('glob', method);
        case 'ls':
          return withListCap('ls', method);
        default:
          return method;
      }
    },
  });
}

/**
 * 完整的 `grep` 結果，排版逐字照基座 `formatGrepResults` 的 `content` 模式（`dist/langsmith-zm0ILQsV.js:420-425`），
 * 開頭照 dsh 加一行總數（`grep.ts:357`）。
 */
function formatGrepFull(matches: readonly GrepMatchLike[]): string {
  const byFile = new Map<string, GrepMatchLike[]>();
  for (const match of matches) {
    const group = byFile.get(match.path);
    if (group === undefined) byFile.set(match.path, [match]);
    else group.push(match);
  }
  const lines: string[] = [];
  for (const path of [...byFile.keys()].sort()) {
    lines.push(`${path}:`);
    for (const match of byFile.get(path) ?? []) lines.push(`  ${match.line}: ${match.text}`);
  }
  const noun = matches.length === 1 ? 'match' : 'matches';
  return `Found ${matches.length} ${noun}\n\n${lines.join('\n')}`;
}

/** 完整的 `ls` 結果，一行一項，逐字照基座 `createLsTool`（`dist/langsmith-zm0ILQsV.js:2040-2045`）。 */
function formatLsLine(info: FileInfoLike): string {
  if (info.is_dir === true) return `${info.path} (directory)`;
  const size = info.size ? ` (${info.size} bytes)` : '';
  return `${info.path}${size}`;
}

function fullText(overflow: Overflow): string {
  switch (overflow.tool) {
    case 'grep':
      return formatGrepFull(overflow.matches);
    case 'glob':
      return overflow.paths.join('\n');
    case 'ls':
      return overflow.files.map(formatLsLine).join('\n');
  }
}

function seenOf(overflow: Overflow): number {
  switch (overflow.tool) {
    case 'grep':
      return overflow.matches.length;
    case 'glob':
      return overflow.paths.length;
    case 'ls':
      return overflow.files.length;
  }
}

/** 沒存到時要模型收窄哪幾個參數，照各工具的參數名。 */
const NARROW: Readonly<Record<SearchTool, string>> = {
  grep: 'narrow pattern, path, or glob',
  glob: 'narrow pattern or path',
  ls: 'narrow path',
};

/** 結尾那句。存到了指路，沒存到講明；措辭照 dsh（見檔頭）。 */
function recoveryLine(overflow: Overflow, ref: SpillRef | undefined): string {
  if (ref === undefined) {
    return `The complete result could not be saved; ${NARROW[overflow.tool]} to see more.`;
  }
  return `Full ${overflow.tool} result stored at: ${ref.locator}. ${ref.retrievalHint}`;
}

/**
 * 換過的文字：`grep` 照 dsh 開頭加「Found 250 of 251 matches」、結尾加定位；`glob`／`ls` 照 dsh `glob` 在結尾加
 * 「Showing 100 of 101 paths」與定位。
 */
function decorate(text: string, overflow: Overflow, ref: SpillRef | undefined): string {
  const seen = seenOf(overflow);
  const recovery = recoveryLine(overflow, ref);
  if (overflow.tool === 'grep') {
    return `Found ${overflow.kept} of ${seen} matches\n\n${text}\n\n(${recovery})`;
  }
  const noun = overflow.tool === 'glob' ? 'paths' : 'entries';
  return `${text}\n\n(Showing ${overflow.kept} of ${seen} ${noun}. ${recovery})`;
}

/** 結果訊息的文字：字串，或全是文字區塊的陣列。其他形狀回 `undefined`。 */
function plainText(content: ToolMessage['content']): string | undefined {
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const block of content) {
    const typed = block as { readonly type?: unknown; readonly text?: unknown };
    if (typed.type !== 'text' || typeof typed.text !== 'string') return undefined;
    parts.push(typed.text);
  }
  return parts.join('\n');
}

/**
 * 搜尋結果的筆數上限。**每個 agent（root 與子代理）掛同一份實例**：沒有 closure 狀態，槽逐次呼叫開。
 * **只給 `foldRegistry` 用**，見檔頭「載體」。
 *
 * @param options - 上限與存檔服務。
 * @returns 一顆 `wrapToolCall` middleware。
 */
export function createSearchOverflowMiddleware(options: SearchOverflowOptions): AgentMiddleware {
  const limitOf = (tool: string): number | undefined =>
    tool === 'grep'
      ? options.limits.grepMaxMatches
      : tool === 'glob' || tool === 'ls'
        ? options.limits.globMaxResults
        : undefined;
  return createMiddleware({
    name: SEARCH_OVERFLOW_MIDDLEWARE_NAME,
    wrapToolCall: async (request, handler) => {
      const toolName = resolveToolName(request);
      const limit = limitOf(toolName);
      if (limit === undefined) return handler(request);
      const args = request.toolCall.args;
      const slot: SearchSlot = {
        tool: toolName as SearchTool,
        args: typeof args === 'object' && args !== null ? args : {},
        limit,
        taken: false,
      };
      const result = await currentSlot.run(slot, () => handler(request));
      const overflow = slot.overflow;
      if (overflow === undefined) return result;
      if (!ToolMessage.isInstance(result) || result.status === 'error') return result;
      const text = plainText(result.content);
      if (text === undefined) return result;
      let ref: SpillRef | undefined;
      if (options.store === undefined) {
        options.warn?.(`search-overflow: 沒有存檔服務，${toolName} 的完整結果沒存到`);
      } else {
        try {
          ref = await options.store.saveText({
            toolName,
            callId: request.toolCall.id ?? result.tool_call_id,
            content: fullText(overflow),
          });
        } catch (error: unknown) {
          // 照 dsh：存不下不讓搜尋失敗，也不藏起行內那份，結尾講明沒存到。
          options.warn?.(
            `search-overflow: ${toolName} 的完整結果存不下（${(error as Error).message}），只留前段`,
          );
        }
      }
      // 只換內容，其餘每一格原樣帶過去。
      return new ToolMessage({
        content: decorate(text, overflow, ref),
        tool_call_id: result.tool_call_id,
        name: result.name ?? toolName,
        id: result.id,
        status: result.status,
        artifact: result.artifact,
        additional_kwargs: result.additional_kwargs,
        response_metadata: result.response_metadata,
      });
    },
  }) as AgentMiddleware;
}
