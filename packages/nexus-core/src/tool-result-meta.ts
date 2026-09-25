/**
 * 工具結果的結構化 `meta`：讀檔讀到哪幾行、搜尋命中什麼、改檔改了哪幾段
 * （[#617](https://github.com/DemianLi/nexus-agent/issues/617)）。
 *
 * ## 照 dsh 的哪些
 *
 * 標準是 dsh 的 `tool/result.meta`（`packages/core/session/src/types.ts:363-385`，`477b4f4`）：工具私有、
 * 對核心不透明、必須是無損 JSON、**跟 `message` 並列，模型看不到**（surface 投影只回 `message`，
 * `core/session/src/surface.ts:150-151`）。它原封不動上線，由 web 的卡片模型驗。**形狀逐字照 dsh**，
 * web 的驗證器才抄得過去：
 *
 * - `read_file` ↔ dsh `read` 的 `FsReadMeta`（`fs/tool-fs/src/read-render.ts:192-203`）。
 * - `grep`／`glob` ↔ dsh 的 `SearchMeta`（`fs/tool-fs-search/src/presentation.ts:60-68`）。
 * - `edit_file`／`write_file` ↔ dsh 的 `FsDiffMeta`（`fs/tool-fs/src/diff.ts:22`），hunk 照
 *   `computeHunkDiffs`（同檔 `:35-59`）逐行抄。
 * - `ls` 不帶：dsh 沒有這顆工具。失敗的呼叫不帶：client 對失敗一律走 generic，不看 meta。
 *
 * ## 載體退了什麼
 *
 * dsh 的 meta 由工具自己的 `presentationMeta(args, value)` 產生——`value` 是工具本體交出的結構化結果。
 * **`deepagents@1.13.1` 的檔案工具沒有那一格**：它們在自己裡面就把 backend 的結構化結果壓成文字
 * （`dist/langsmith-zm0ILQsV.js:2029-2297`），交出來的只有字串或一則 ToolMessage。所以退到最接近的
 * 實作：**在 backend 那一層、結構還沒被壓扁之前抓下來**，放進這次呼叫的槽，由圍堵寫進 `tool/result`。
 * 同 #603 的 `recordReadExtent`（讀檔的那一份就由它產生，見 `read-continuation.ts`）。
 *
 * **不從工具輸出的文字解析**——那等於把 #601「web 不從文字猜」搬到 harness 做。
 *
 * ## 槽
 *
 * 圍堵在每次工具呼叫外面開一個槽（{@link runInToolMetaSlot}），記著是哪顆工具。產生者只在**自己那顆
 * 工具的槽裡、而且只寫一次**：摘要器 offload、工具結果暫存也會呼叫 backend 的 `write`，但它們在
 * 圍堵外面，沒有槽；同一次呼叫裡的第二次 backend 呼叫也不是工具那一次。子代理的工具各自在自己
 * 的圍堵裡開槽，ALS 的巢狀 `run` 讓內層蓋掉外層。
 *
 * **不用 WeakMap 綁在訊息物件上**：`read-continuation.ts` 會換一顆新的 ToolMessage，綁上去的東西會斷。
 *
 * ## 上限不在這裡
 *
 * 會話日誌存完整的一份，**上限在上線那一刻才截**（`apps/harness` 的 `tool-result-text.ts`），同工具
 * 文字——日誌裡的文字本來就是截斷之前的那份。
 *
 * @module
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { adaptBackendProtocol } from 'deepagents';
import type { AnyBackendProtocol } from 'deepagents';
import { structuredPatch } from 'diff';

/** 一段 diff：每個 hunk 一組前後片段，不是 patch。同 dsh 的 `FileDiff`（`core/tools/src/presentation.ts:34-40`）。 */
export interface FileDiff {
  readonly path: string;
  /** 上下文加 `-` 行；純新增是 `null`。 */
  readonly oldText: string | null;
  /** 上下文加 `+` 行。 */
  readonly newText: string;
}

/** 讀檔的 meta，同 dsh 的 `FsReadMeta`。 */
export interface ReadResultMeta {
  /** 模型給的路徑。 */
  readonly path: string;
  /** 從第幾行讀起，**1 起算**（基座的 `offset` 是 0 起算，這裡轉過）。 */
  readonly offset: number;
  /** 這一次交給模型的每一行，帶著它在檔案裡的行號。 */
  readonly lines: readonly { readonly number: number; readonly text: string }[];
  /** 檔案總行數。 */
  readonly totalLines: number;
  /** 語法上色的提示，由副檔名推；認不得的不放這一格。 */
  readonly lang?: string;
}

/** 搜尋的 meta，同 dsh 的 `SearchMeta`。 */
export type SearchResultMeta =
  | {
      readonly shape: 'matches';
      readonly files: readonly {
        readonly path: string;
        readonly matches: readonly { readonly lineNumber: number; readonly line: string }[];
      }[];
      readonly truncated: boolean;
      readonly total: number;
    }
  | {
      readonly shape: 'paths';
      readonly paths: readonly string[];
      readonly truncated: boolean;
      readonly total: number;
    };

/** 改檔的 meta，同 dsh 的 `FsDiffMeta`。`operation` 只有 `write_file` 帶。 */
export interface DiffResultMeta {
  readonly diffs: readonly FileDiff[];
  readonly operation?: 'create' | 'update';
}

/** 這一次工具呼叫的槽。 */
interface ToolMetaSlot {
  /** 開槽的那顆工具。產生者只認自己那顆。 */
  readonly toolName: string;
  /** 那次呼叫的參數。 */
  readonly args: Readonly<Record<string, unknown>>;
  /** 寫過就不再寫。 */
  meta?: unknown;
}

const currentSlot = new AsyncLocalStorage<ToolMetaSlot>();

/**
 * 在一次工具呼叫的槽裡跑 `fn`，回它的結果與產生者寫進來的 meta。**只給圍堵用。**
 *
 * @param toolName - 這次呼叫的工具名。
 * @param args - 這次呼叫的參數。
 * @param fn - 往內層走的那一步。
 */
export async function runInToolMetaSlot<T>(
  toolName: string,
  args: unknown,
  fn: () => T | Promise<T>,
): Promise<{ readonly result: T; readonly meta: unknown }> {
  const slot: ToolMetaSlot = {
    toolName,
    args: typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {},
  };
  const result = await currentSlot.run(slot, fn);
  return { result, meta: slot.meta };
}

/**
 * 產生者在這次呼叫的槽裡放 meta。不在那顆工具的槽裡、或已經放過，就什麼都不做。
 *
 * @param toolName - 產生者負責的工具。
 * @param meta - 要放的東西（必須是無損 JSON，進日誌時驗）。
 */
export function putToolResultMeta(toolName: string, meta: unknown): void {
  const slot = currentSlot.getStore();
  if (slot === undefined || slot.toolName !== toolName || slot.meta !== undefined) return;
  slot.meta = meta;
}

/** 這次呼叫的槽是不是這顆工具的、而且還沒放過。產生者在做額外的 backend 讀取前先問。 */
function slotFor(toolName: string): ToolMetaSlot | undefined {
  const slot = currentSlot.getStore();
  return slot !== undefined && slot.toolName === toolName && slot.meta === undefined
    ? slot
    : undefined;
}

// ── diff ─────────────────────────────────────────────────────────────────────

/** hunk 兩側各留幾行上下文，同 dsh 的 `DIFF_CONTEXT`。 */
export const DIFF_CONTEXT = 3;

/**
 * 每個 hunk 算一段 {@link FileDiff}。**逐行照抄 dsh 的 `computeHunkDiffs`**（`fs/tool-fs/src/diff.ts:35-59`，
 * `477b4f4`）：純新增的 `oldText` 是 `null`，patch 才有的「沒有結尾換行」記號不進內容。
 *
 * @param path - 蓋在每一段上的路徑（模型給的 `file_path`）。
 * @param before - 改之前的全文。
 * @param after - 改之後的全文。
 * @returns 依檔案順序的每一段；兩邊相同就是空陣列。
 */
export function computeHunkDiffs(path: string, before: string, after: string): FileDiff[] {
  const patch = structuredPatch('', '', before, after, undefined, undefined, {
    context: DIFF_CONTEXT,
  });
  const diffs: FileDiff[] = [];
  for (const hunk of patch.hunks) {
    const oldLines: string[] = [];
    const newLines: string[] = [];
    for (const line of hunk.lines) {
      if (line.startsWith('\\')) continue;
      const text = line.slice(1);
      if (line.startsWith('-')) oldLines.push(text);
      else if (line.startsWith('+')) newLines.push(text);
      else {
        oldLines.push(text);
        newLines.push(text);
      }
    }
    diffs.push({
      path,
      oldText: oldLines.length > 0 ? oldLines.join('\n') : null,
      newText: newLines.join('\n'),
    });
  }
  return diffs;
}

// ── backend 那一層的產生者 ───────────────────────────────────────────────────

/** `FileData.content` 在 v1 是行陣列、v2 是字串或位元組。位元組與認不得的回 `undefined`。同 `observation.ts`。 */
function textOf(data: unknown): string | undefined {
  const content = (data as { readonly content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && content.every((line) => typeof line === 'string')) {
    return content.join('\n');
  }
  return undefined;
}

/**
 * 讀一個檔的全文。**三種結局分開**：讀到文字、不存在（`absent`）、以及其他（讀不動、是二進位）。
 * 把「其他」當成不存在的話，一次覆寫會被標成新建。
 *
 * 判法同 `observation.ts`：`'data' in result` 才算讀到。`{ error }` 算不存在——deepagents 的後端只在
 * 找不到時回這個形狀（`StateBackend`／`StoreBackend`／sandbox 都是 `File '…' not found`）；落磁碟的
 * 那個對缺檔直接拋 `ENOENT`。**拋別的**（`EISDIR`、`EACCES`……）才是「不知道」。
 */
async function readText(
  backend: AnyBackendProtocol,
  path: string,
): Promise<{ readonly text: string } | 'absent' | 'unknown'> {
  let result: unknown;
  try {
    result = await adaptBackendProtocol(backend).readRaw(path);
  } catch (error) {
    return (error as { readonly code?: unknown } | undefined)?.code === 'ENOENT'
      ? 'absent'
      : 'unknown';
  }
  if (result !== null && typeof result === 'object' && 'data' in result) {
    const text = textOf((result as { readonly data: unknown }).data);
    return text === undefined ? 'unknown' : { text };
  }
  return 'absent';
}

/** `edit` 回來的 `filesUpdate` 裡那個檔改之後的全文（`StateBackend` 給這一格；落磁碟的不給）。 */
function textFromFilesUpdate(result: unknown, path: string): string | undefined {
  const update = (result as { readonly filesUpdate?: unknown } | undefined)?.filesUpdate;
  if (typeof update !== 'object' || update === null) return undefined;
  return textOf((update as Record<string, unknown>)[path]);
}

/** backend 方法回傳的形狀，只取這裡用得到的。 */
interface BackendResultLike {
  readonly error?: unknown;
}

/** 選項。 */
export interface RecordToolResultMetaOptions {
  /**
   * 搜尋（`grep`／`glob`）要不要帶 meta。**有任何 `permissions` 規則的組裝要關**：基座的工具拿 backend 的
   * 結果之後還會照 `permissions` 濾一次（`filterByPermissions`，沒匯出），而這一層看到的是**濾之前**那份
   * ——照樣放進 meta 的話，模型看不到的路徑會出現在畫面上。自己重寫一份比對規則，寫錯的代價是外洩，
   * 所以在組裝期整類關掉（見 `fold.ts`）。讀檔與改檔不受影響：基座在呼叫 backend 之前就擋掉了。
   */
  readonly search: boolean;
}

/**
 * 把 backend 包一層，在 `grep`／`glob`／`write_file`／`edit_file` 那一次呼叫裡抓下 meta。
 *
 * **必須包在最內層**（直接包 fold 折出來的 backend）：`write` 之前那一次讀原檔，要讀的是原物件，
 * 不能經過 `recordBackendOutcomes`——新建檔案時那次讀會「讀不到」，被記成一次 backend 失敗的話，
 * fs-tool-errors 會把一次成功的寫入改判成失敗。
 *
 * **轉交的是同一個實例**，同 `recordReadExtent`：方法以原物件為 `this` 呼叫，其餘屬性原樣讀出。
 *
 * @param backend - fold 折出來的那個。
 * @param options - 見 {@link RecordToolResultMetaOptions}。
 * @returns 交給外面幾層的那一份。
 */
export function recordToolResultMeta<T extends object>(
  backend: T,
  options: RecordToolResultMetaOptions,
): T {
  const raw = backend as unknown as AnyBackendProtocol;
  return new Proxy(backend, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      const method = (value as (...args: unknown[]) => unknown).bind(target);
      switch (property) {
        case 'grep':
          return options.search ? withGrepMeta(method) : method;
        case 'glob':
          return options.search ? withGlobMeta(method) : method;
        case 'write':
          return withWriteMeta(raw, method);
        case 'edit':
          return withEditMeta(raw, method);
        default:
          return method;
      }
    },
  });
}

/** 基座 `GrepMatch` 的形狀（`dist/agent-D50BBbJT.d.ts:269-276`）：`line` 是行號，`text` 是那一行。 */
interface GrepMatchLike {
  readonly path?: unknown;
  readonly line?: unknown;
  readonly text?: unknown;
}

function withGrepMeta(method: (...args: unknown[]) => unknown) {
  return async (...args: unknown[]): Promise<unknown> => {
    const result = (await method(...args)) as BackendResultLike & {
      readonly matches?: readonly GrepMatchLike[];
      readonly truncated?: unknown;
    };
    const slot = slotFor('grep');
    if (slot === undefined || result.error !== undefined || !Array.isArray(result.matches)) {
      return result;
    }
    // 只有 `content` 模式的輸出是一行一行的命中；另兩種模式模型看到的是檔名或計數，卡片不畫它沒看到的東西。
    const mode = slot.args.output_mode;
    if (mode !== undefined && mode !== 'content') return result;
    const byFile = new Map<string, { lineNumber: number; line: string }[]>();
    for (const match of result.matches) {
      if (typeof match.path !== 'string' || typeof match.line !== 'number') continue;
      const entry = {
        lineNumber: match.line,
        line: typeof match.text === 'string' ? match.text : '',
      };
      const group = byFile.get(match.path);
      if (group === undefined) byFile.set(match.path, [entry]);
      else group.push(entry);
    }
    const meta: SearchResultMeta = {
      shape: 'matches',
      files: Array.from(byFile, ([path, matches]) => ({ path, matches })),
      // **`total` 只能是交出來的筆數**：backend 照 `max_count` 截過才回，截之前有幾筆它不講。dsh 的
      // `total` 是截之前的數；截了的時候兩者不同，`truncated` 說得出來，數字說不出來（偏離，見 PR）。
      truncated: result.truncated === true,
      total: result.matches.length,
    };
    putToolResultMeta('grep', meta);
    return result;
  };
}

function withGlobMeta(method: (...args: unknown[]) => unknown) {
  return async (...args: unknown[]): Promise<unknown> => {
    const result = (await method(...args)) as BackendResultLike & {
      readonly files?: readonly { readonly path?: unknown }[];
      readonly truncated?: unknown;
    };
    if (slotFor('glob') === undefined || result.error !== undefined) return result;
    if (!Array.isArray(result.files)) return result;
    const paths = result.files.flatMap((info) =>
      typeof info.path === 'string' ? [info.path] : [],
    );
    // 同 grep：`total` 是交出來的筆數，走檔被截時 `truncated` 講得出來、數字講不出來。
    const meta: SearchResultMeta = {
      shape: 'paths',
      paths,
      truncated: result.truncated === true,
      total: paths.length,
    };
    putToolResultMeta('glob', meta);
    return result;
  };
}

function withWriteMeta(backend: AnyBackendProtocol, method: (...args: unknown[]) => unknown) {
  return async (...args: unknown[]): Promise<unknown> => {
    const [path, content] = args;
    if (
      slotFor('write_file') === undefined ||
      typeof path !== 'string' ||
      typeof content !== 'string'
    ) {
      return method(...args);
    }
    const before = await readText(backend, path);
    const result = (await method(...args)) as BackendResultLike;
    if (result.error !== undefined || before === 'unknown') return result;
    const meta: DiffResultMeta =
      before === 'absent'
        ? { operation: 'create', diffs: [] }
        : { operation: 'update', diffs: computeHunkDiffs(path, before.text, content) };
    putToolResultMeta('write_file', meta);
    return result;
  };
}

function withEditMeta(backend: AnyBackendProtocol, method: (...args: unknown[]) => unknown) {
  return async (...args: unknown[]): Promise<unknown> => {
    const [path] = args;
    if (slotFor('edit_file') === undefined || typeof path !== 'string') return method(...args);
    const before = await readText(backend, path);
    const result = (await method(...args)) as BackendResultLike;
    if (result.error !== undefined || typeof before !== 'object') return result;
    // 改之後的全文**不自己重算**（`$` 樣式、`replace_all` 的語意跟基座對不齊就是錯的 diff）：`StateBackend`
    // 在 `filesUpdate` 裡給；落磁碟的已經寫下去了，再讀一次。
    let after = textFromFilesUpdate(result, path);
    if (after === undefined) {
      const reread = await readText(backend, path);
      if (typeof reread !== 'object') return result;
      after = reread.text;
    }
    putToolResultMeta('edit_file', { diffs: computeHunkDiffs(path, before.text, after) });
    return result;
  };
}
