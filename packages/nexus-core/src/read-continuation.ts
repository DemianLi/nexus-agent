/**
 * 讀檔結果的最後一行告訴模型讀到哪了：沒讀完寫下一頁從哪讀，讀完寫檔尾與總行數
 * （[#594](https://github.com/DemianLi/nexus-agent/issues/594)）。
 *
 * ## 缺口在基座
 *
 * `deepagents@1.13.1` 的 `read_file` 一次回一段切片（預設 100 行），結果只有編了號的那幾行：
 * 沒有總行數，也沒有「後面還有」（`dist/langsmith-zm0ILQsV.js:2058-2132`）。backend 其實算出了
 * 總行數——`FilesystemBackend.read` 整份讀進來、split 成行，只回切片
 * （`dist/src-C9o7b5C6.js:708-714`）——只是沒往上交。模型得自己記得翻頁；推理想得少一點就不翻，
 * 拿第一頁作答。2026-09-23 量過：低推理強度下 B6（數 ERROR）只讀前 100 行答 7、正解 17，
 * B7（最後一筆 WARN）讀了 200 行，拿到的是第 191 行那筆、真正的最後一筆在第 230 行。
 *
 * ## 對 dsh
 *
 * dsh 的 `read` 每次結果的結尾都帶一行（`packages/fs/tool-fs/src/read-render.ts:156-161`，
 * SHA `477b4f4`）：
 *
 * - 位元組上限截掉：`(Output capped. Showing lines A-B. Use offset=B+1 to continue.)`
 * - 還沒到檔尾：`(Showing lines A-B of N. Use offset=B+1 to continue.)`
 * - 到檔尾：`(End of file - total N lines)`
 *
 * **措辭照抄，offset 的值不照抄。** dsh 的 `offset` 從 1 起算，deepagents 從 0 起算，所以下一頁的
 * `offset` 是**畫面上最後一行的行號**，不是它加一。照抄 `B+1` 會每翻一頁跳過一行。
 *
 * **預設行數不跟 dsh**（dsh 一次 2000 行、50 KiB）：這一張只補提示，預設留在基座的 100。
 * 改預設會讓每次讀大檔多吃到約兩萬 token，要先量上下文成本，demian 2026-09-25 拍板另議。
 *
 * **偏離：在工具外面補，不是在工具裡寫。** 基座的工具我們改不了，退到同
 * {@link ./fs-tool-errors.ts} 的做法——一顆貼著工具本體的 `wrapToolCall`，時刻是 dsh 的
 * `tools/execute`。它要的總行數從 backend 取：
 *
 * - {@link recordReadExtent} 包住交給基座的 backend。**在一次 `read_file` 裡**，它把 `read` 的
 *   `limit` 放開成讀到檔尾，自己數行，再照原本的 `limit` 切回去交給工具。工具拿到的內容與原本
 *   一字不差，backend 也只讀一次檔（`FilesystemBackend.read` 本來就整份讀進來）。
 * - middleware 讀這次記下的範圍，接在文字結果的最後。
 *
 * 「這一次呼叫」同樣由 `AsyncLocalStorage` 界定；不在 `read_file` 裡的 `read`（摘要器、測試直接
 * 呼叫 backend）原樣轉交，參數不動。
 *
 * ## 已知的界線
 *
 * - 只認得切片語意的 backend（`read(path, offset, limit)` 回 `lines[offset, offset+limit)`）。
 *   樹上掛得到的 `FilesystemBackend`、`StateBackend`、`CompositeBackend` 都是；plugin 自己帶的
 *   backend 若語意不同，提示會算錯。
 * - 空檔：`FilesystemBackend` 回的是一句提醒而不是內容（`EMPTY_CONTENT_WARNING`），那一次不補。
 * - 基座在格式化後超過 `4 × toolTokenLimitBeforeEvict` 字元時自己截斷並附一段說明
 *   （`READ_FILE_TRUNCATION_MSG`，`dist/langsmith-zm0ILQsV.js:1559-1561`）。那時顯示到第幾行要從
 *   輸出本身讀；最後一行可能只顯示了一半，所以下一頁從**那一行**重讀，寧可重複一行也不跳過。
 *
 * @module
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { ToolMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from './base-types.js';
import { resolveToolName } from './containment.js';

/** 這個 middleware 的名字。排序斷言用得到。 */
export const READ_CONTINUATION_MIDDLEWARE_NAME = 'nexusReadContinuation';

/** 基座的讀檔工具。名字是 `deepagents@1.13.1` 取的，不是我們（同 `observation.ts` 的 `OBSERVED_*`）。 */
const READ_TOOL = 'read_file';

/** 基座空檔時回的那句（`deepagents@1.13.1`，`dist/langsmith-zm0ILQsV.js:22`）。 */
const EMPTY_CONTENT_WARNING = 'System reminder: File exists but has empty contents';

/** 基座自己截斷時附的那段說明的開頭（`READ_FILE_TRUNCATION_MSG`，見檔頭）。 */
const BASE_TRUNCATION_MARK = '[Output was truncated due to size limits.';

/** 一次 `read_file` 裡，backend 讀到的範圍。 */
interface ReadExtent {
  /** 從第幾行讀起，0 起算，同基座的 `offset`。 */
  readonly offset: number;
  /** 交給工具的行數。 */
  readonly shown: number;
  /** 檔案總行數。結尾的換行不算一行，同基座的編號。 */
  readonly total: number;
}

/** 一次工具呼叫裡記下的東西。`extent` 沒有 ＝ 這一次沒有讀到文字內容。 */
interface CallRecord {
  extent?: ReadExtent;
}

/** 正在跑的那一次 `read_file`。每次呼叫各 `run` 一份，平行的兩次不共用。 */
const currentRead = new AsyncLocalStorage<CallRecord>();

/** 切片語意的 backend `read` 回的形狀，只取這裡用得到的兩格。 */
interface ReadResultLike {
  readonly content?: unknown;
  readonly error?: unknown;
}

/**
 * 數行，同基座的編號：結尾那個換行後面的空字串不算一行
 * （`formatContentWithLineNumbers`，`dist/langsmith-zm0ILQsV.js:145-150`）。
 */
function countLines(lines: readonly string[]): number {
  return lines.at(-1) === '' ? lines.length - 1 : lines.length;
}

/**
 * 在一次 `read_file` 裡：讀到檔尾、數行、切回原本的 `limit`。
 *
 * @returns 交給工具的那一份——跟不放開 `limit` 時一字不差。
 */
async function readWithExtent(
  read: (path: unknown, offset: number, limit: number) => unknown,
  record: CallRecord,
  args: readonly unknown[],
): Promise<unknown> {
  const [path, rawOffset, limit] = args;
  // 基座的工具三個都會給；沒給 `limit` 的不是它，原樣轉交。
  if (typeof limit !== 'number') return read(...(args as [unknown, number, number]));
  const offset = typeof rawOffset === 'number' ? rawOffset : 0;
  const result = (await read(path, offset, Number.MAX_SAFE_INTEGER)) as ReadResultLike;
  if (typeof result !== 'object' || result === null || typeof result.content !== 'string') {
    return result;
  }
  if (result.content === EMPTY_CONTENT_WARNING) return result;
  const rest = result.content.split('\n');
  const remaining = countLines(rest);
  record.extent = { offset, shown: Math.min(limit, remaining), total: offset + remaining };
  return { ...result, content: rest.slice(0, limit).join('\n') };
}

/**
 * 把 backend 包一層，在一次 `read_file` 裡記下讀到的範圍。
 *
 * **轉交的是同一個實例**，同 {@link ./fs-tool-errors.ts} 的 `recordBackendOutcomes`：方法以原物件
 * 為 `this` 呼叫，非方法的屬性原樣讀出，`CompositeBackend.isInstance` 與 `instanceof` 照樣成立。
 *
 * @param backend - fold 折出來的那個。
 * @returns 交給基座的那一份。
 */
export function recordReadExtent<T extends object>(backend: T): T {
  return new Proxy(backend, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      const method = (value as (...args: unknown[]) => unknown).bind(target);
      if (property !== 'read') return method;
      return (...args: unknown[]): unknown => {
        const record = currentRead.getStore();
        // 不在 `read_file` 裡，或這次呼叫已經讀過一次（工具只讀一次；第二次的不是它）：原樣轉交。
        if (record === undefined || record.extent !== undefined) return method(...args);
        return readWithExtent(method as never, record, args);
      };
    },
  });
}

/** 基座輸出裡一行的行號：`     12\t…` 或長行切出來的 `  12.1\t…`。取整數那一段。 */
const LINE_NUMBER = /^\s*(\d+)(?:\.\d+)?\t/;

/** 基座自己截斷時，輸出裡最後一個看得到的行號。 */
function lastVisibleLine(text: string): number | undefined {
  const lines = text.slice(0, text.indexOf(BASE_TRUNCATION_MARK)).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = LINE_NUMBER.exec(lines[i] ?? '');
    if (match !== null) return Number(match[1]);
  }
  return undefined;
}

/**
 * 接在結果最後的那一行。措辭照 dsh，`offset` 照基座（0 起算，見檔頭）。
 *
 * @param extent - backend 讀到的範圍。
 * @param text - 基座交回來的文字，用來認出它自己截斷了沒有。
 */
export function continuationFooter(extent: ReadExtent, text: string): string {
  const first = extent.offset + 1;
  if (text.includes(BASE_TRUNCATION_MARK)) {
    const visible = lastVisibleLine(text) ?? first;
    // 最後看得到的那一行可能只顯示了一半：下一頁從它重讀，所以完整顯示的到它前一行，而重讀它的
    // `offset`（0 起算）剛好是它前一行的行號。它就是第一行的話，重讀只會再截一次，那就跳過它。
    return visible > first
      ? `(Output capped. Showing lines ${first}-${visible - 1}. Use offset=${visible - 1} to continue.)`
      : `(Output capped. Use offset=${visible} to continue.)`;
  }
  const last = extent.offset + extent.shown;
  return last < extent.total
    ? `(Showing lines ${first}-${last} of ${extent.total}. Use offset=${last} to continue.)`
    : `(End of file - total ${extent.total} lines)`;
}

/** 把一行接在文字結果最後：字串直接接，文字塊陣列接在最後一個文字塊上。其餘原樣。 */
function appendFooter(
  content: ToolMessage['content'],
  footer: (text: string) => string,
): ToolMessage['content'] | undefined {
  if (typeof content === 'string') return `${content}\n\n${footer(content)}`;
  let index = content.length - 1;
  while (index >= 0 && (content[index] as { readonly type?: unknown }).type !== 'text') index--;
  const block = content[index] as { readonly type: 'text'; readonly text?: unknown } | undefined;
  if (block === undefined || typeof block.text !== 'string') return undefined;
  const next = [...content];
  next[index] = { ...block, text: `${block.text}\n\n${footer(block.text)}` };
  return next;
}

/**
 * 造一顆在讀檔結果最後補上讀到哪的 middleware。**無狀態**：記錄每次呼叫各一份，root 與每個
 * subagent 共用同一顆。
 *
 * @returns 交給 fold 排位置的 middleware。
 */
export function createReadContinuationMiddleware(): AgentMiddleware {
  return createMiddleware({
    name: READ_CONTINUATION_MIDDLEWARE_NAME,
    wrapToolCall: async (request, handler) => {
      if (resolveToolName(request) !== READ_TOOL) return handler(request);
      const record: CallRecord = {};
      const result = await currentRead.run(record, () => handler(request));
      const extent = record.extent;
      // 失敗的、沒讀到文字的（二進位、空檔）、包在 `Command` 裡的：原樣交出。
      if (extent === undefined || !ToolMessage.isInstance(result) || result.status === 'error') {
        return result;
      }
      const content = appendFooter(result.content, (text) => continuationFooter(extent, text));
      if (content === undefined) return result;
      // 只換內容，其餘每一格原樣帶過去（id、狀態、別的 middleware 記在訊息上的東西）。
      return new ToolMessage({
        content,
        tool_call_id: result.tool_call_id,
        name: result.name ?? READ_TOOL,
        id: result.id,
        status: result.status,
        artifact: result.artifact,
        additional_kwargs: result.additional_kwargs,
        response_metadata: result.response_metadata,
      });
    },
  }) as AgentMiddleware;
}
