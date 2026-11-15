/**
 * `history_read`、`history_search`：讓模型從會話日誌讀回被摘要遮掉的原文（[#2777](https://github.com/DemianLi/nexus-agent/issues/2777)）。
 *
 * - 讀的是**這次呼叫自己的那份日誌**（`registry.sessions.forCall`）：子代理讀到的是它自己被摘掉的那幾段。
 * - 唯讀，不掛核准；嵌入版靠 `embed-profile.ts` 的 `EMBED_READ_ONLY_TOOLS` 免核准。結果是一般的工具結果，落在訊息串尾端。
 * - 沒接上日誌、但開著摘要的組裝照樣有這兩個工具，呼叫時回 `ok: false` 加一句原因，不拋；摘要關掉的組裝不掛（`agent-factory.ts`）。
 * - 註冊了這兩個工具、而且這次呼叫解得到會話日誌時，摘要的前言指向它們（`@nexus/core` 的 `fold.ts` 與 `summarization.ts`）。
 *   `/conversation_history` 的歷史檔照寫。
 *
 * 怎麼從日誌推回那幾段、輸出長什麼樣，在 `@nexus/core` 的 `history-recall.ts`。
 *
 * @module
 */

import {
  HISTORY_READ_PAGE_CHARS,
  HISTORY_READ_TOOL_NAME,
  HISTORY_SEARCH_DEFAULT_LIMIT,
  HISTORY_SEARCH_MAX_LIMIT,
  HISTORY_SEARCH_TOOL_NAME,
  historyRead,
  historySearch,
} from '@nexus/core';
import type { PluginEntry, SessionLookup } from '@nexus/core';
import type { JsonSchema, NexusTool, NexusToolResult, ToolExec } from '@nexus/tools';
import { z } from 'zod';

// 轉接器不收 `integer`、`minimum`、`maximum`，所以數字的形狀與範圍在這裡驗。
function outOfRange(args: {
  entry?: number;
  segment?: number;
  offset?: number;
  limit?: number;
}): string | undefined {
  const floors = { entry: 1, segment: 0, offset: 0, limit: 1 } as const;
  for (const [key, floor] of Object.entries(floors) as [keyof typeof floors, number][]) {
    const value = args[key];
    if (value !== undefined && (!Number.isInteger(value) || value < floor)) {
      return `"${key}" must be an integer of ${floor} or greater.`;
    }
  }
  return undefined;
}

const NOT_ATTACHED =
  'This conversation has no session log attached, so summarized messages cannot be read back.';
const UNKNOWN_CALLER =
  'Cannot tell which session this call belongs to, so its session log cannot be read.';

const address = {
  entry: z
    .number()
    .optional()
    .describe('Entry number from the summary <index>, e.g. 2 for "[#2 messages …]".'),
  segment: z
    .number()
    .optional()
    .describe(
      `Segment id as printed by ${HISTORY_SEARCH_TOOL_NAME}, for stretches that have no index entry.`,
    ),
};

const readSchema = z.strictObject({
  ...address,
  offset: z.number().optional().describe('Character offset to start from. Defaults to 0.'),
});

const searchSchema = z.strictObject({
  query: z.string().describe('Literal string to look for. Case-insensitive, not a regex.'),
  ...address,
  limit: z
    .number()
    .optional()
    .describe(
      `Maximum matches to return. Defaults to ${HISTORY_SEARCH_DEFAULT_LIMIT}, at most ${HISTORY_SEARCH_MAX_LIMIT}.`,
    ),
});

/** 沒給的鍵整個拿掉：core 的參數是 `exactOptionalPropertyTypes` 下的選填。 */
function defined<T extends object>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, each]) => each !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}

function build<Args extends object>(
  name: string,
  description: string,
  schema: z.ZodType<Args>,
  lookup: (exec: ToolExec) => SessionLookup,
  run: (events: Parameters<typeof historyRead>[0], args: Args) => NexusToolResult,
): NexusTool {
  return {
    name,
    description,
    parameters: z.toJSONSchema(schema, { io: 'input' }) as JsonSchema,
    execute: async (args, exec): Promise<NexusToolResult> => {
      const parsed = schema.safeParse(args);
      if (!parsed.success) return { ok: false, content: z.prettifyError(parsed.error) };
      const problem = outOfRange(parsed.data);
      if (problem !== undefined) return { ok: false, content: problem };
      const found = lookup(exec);
      if (found.kind === 'not-attached') return { ok: false, content: NOT_ATTACHED };
      if (found.kind !== 'ok') return { ok: false, content: UNKNOWN_CALLER };
      return run(found.log.events, parsed.data);
    },
  };
}

/**
 * @param lookup - 這次呼叫的會話查找，呼叫當下才問。
 * @returns `history_read`。
 */
export function createHistoryReadTool(lookup: (exec: ToolExec) => SessionLookup): NexusTool {
  return build(
    HISTORY_READ_TOOL_NAME,
    'Read back, verbatim, a stretch of this conversation that was replaced by a summary. ' +
      'Pass the entry number shown in the summary <index> (or a segment id from ' +
      `${HISTORY_SEARCH_TOOL_NAME}). Returns a transcript page of up to ${HISTORY_READ_PAGE_CHARS} characters; ` +
      'the last line gives the offset of the next page. Use it when you need an exact detail ' +
      '(a value, an error string, a file path, what a tool returned) that the summary does not give.',
    readSchema,
    lookup,
    (events, args) => historyRead(events, defined(args)),
  );
}

/**
 * @param lookup - 這次呼叫的會話查找，呼叫當下才問。
 * @returns `history_search`。
 */
export function createHistorySearchTool(lookup: (exec: ToolExec) => SessionLookup): NexusTool {
  return build(
    HISTORY_SEARCH_TOOL_NAME,
    'Search the stretches of this conversation that were replaced by a summary for a literal string ' +
      '(case-insensitive, not a regex, not semantic). Returns each match with its entry number, a character offset ' +
      `and surrounding text; pass that entry and offset to ${HISTORY_READ_TOOL_NAME} to read around it. ` +
      'Messages still in context are not searched.',
    searchSchema,
    lookup,
    (events, args) => historySearch(events, defined(args)),
  );
}

/** 掛這兩個工具的條目。 */
export function historyRecallEntry(): PluginEntry {
  return {
    plugin: {
      name: 'history-recall',
      apply: (registry) => {
        const lookup = (exec: ToolExec): SessionLookup => registry.sessions.forCall(exec);
        registry.tools.register(createHistoryReadTool(lookup));
        registry.tools.register(createHistorySearchTool(lookup));
      },
    },
  };
}
