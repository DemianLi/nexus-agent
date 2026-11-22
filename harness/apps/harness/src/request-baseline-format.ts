/**
 * 請求基準檔的存檔格式：無損壓縮，讀回來要與錄到的逐位元組相同。
 *
 * 一份請求 body 最大的兩塊是 `tools`（每次呼叫都是同一份出貨工具表）與 `messages`（每次呼叫都帶著前面全部）。
 * 這裡只做兩件無損的事：`tools` 換成共用表裡的鍵；`messages` 與同一個端點前面某一份共用到哪一則就存到哪一則。
 * 內容不做雜湊、不做摘要，讀回來是完整的 body。
 *
 * @module
 */

import { createHash } from 'node:crypto';

/** 共用的工具表：鍵是內容雜湊，值是原本的 `tools`。 */
export type ToolsTable = Record<string, unknown>;

/** 壓縮後的一份請求。 */
export interface EncodedBody {
  /** 原 body 的鍵順序（序列化成線上位元組時順序有差）。 */
  readonly order: readonly string[];
  /** 除了 `tools` 與 `messages` 之外的欄位，原樣。 */
  readonly rest: Record<string, unknown>;
  /** 工具表的鍵；原 body 沒有 `tools` 就沒有這一格。 */
  readonly tools?: string;
  readonly messages: {
    /** 與同一端點的第 `base` 份共用前 `keep` 則；沒有共用就沒有這兩格。 */
    readonly base?: number;
    readonly keep?: number;
    /** 接在共用的那段後面的訊息。 */
    readonly items: readonly unknown[];
  };
}

/** 一個測試案例存下來的樣子。 */
export interface EncodedCase {
  readonly version: 1;
  readonly case: string;
  /** 比對狀態；`known-difference` 時另有 `note`。 */
  readonly status?: string;
  readonly note?: string;
  readonly endpoints: readonly (readonly EncodedBody[])[];
}

interface WireLike {
  readonly messages?: readonly unknown[];
  readonly tools?: unknown;
  readonly [key: string]: unknown;
}

const stable = (value: unknown): string => JSON.stringify(value);

function toolsKey(tools: unknown): string {
  return createHash('sha256').update(stable(tools)).digest('hex').slice(0, 16);
}

/** 兩份訊息串從頭起共有幾則（逐則比序列化）。 */
function commonPrefix(left: readonly string[], right: readonly string[]): number {
  let n = 0;
  while (n < left.length && n < right.length && left[n] === right[n]) n += 1;
  return n;
}

/**
 * 壓縮一個端點收到的一串請求。
 *
 * @param bodies - 請求 body，照收到的順序。
 * @param table - 共用的工具表，會被補上新出現的工具表。
 * @returns 壓縮後的一串。
 */
export function encodeEndpoint(
  bodies: readonly unknown[],
  table: ToolsTable,
): readonly EncodedBody[] {
  const serialized: string[][] = [];
  return bodies.map((raw, index) => {
    const order = Object.keys(raw as object);
    const { messages = [], tools, ...rest } = raw as WireLike;
    const lines = messages.map(stable);
    serialized.push(lines);
    let base = -1;
    let keep = 0;
    for (let earlier = 0; earlier < index; earlier += 1) {
      const n = commonPrefix(lines, serialized[earlier]!);
      if (n > keep) {
        keep = n;
        base = earlier;
      }
    }
    let key: string | undefined;
    if (tools !== undefined) {
      key = toolsKey(tools);
      table[key] ??= tools;
    }
    return {
      order,
      rest,
      ...(key !== undefined && { tools: key }),
      messages: base >= 0 ? { base, keep, items: messages.slice(keep) } : { items: messages },
    };
  });
}

/**
 * 還原一個端點收到的一串請求。
 *
 * @param encoded - {@link encodeEndpoint} 的輸出。
 * @param table - 共用的工具表。
 * @returns 與當初錄到的逐位元組相同的 body。
 * @throws 工具表缺鍵，或 `base` 指到後面的請求。
 */
export function decodeEndpoint(
  encoded: readonly EncodedBody[],
  table: ToolsTable,
): Record<string, unknown>[] {
  const restored: Record<string, unknown>[] = [];
  for (const [index, item] of encoded.entries()) {
    let messages: unknown[];
    if (item.messages.base === undefined) {
      messages = [...item.messages.items];
    } else {
      const { base, keep } = item.messages;
      if (keep === undefined || base >= index) {
        throw new Error(`基準檔壞了：第 ${String(index)} 份請求的 base ${String(base)} 不在它前面`);
      }
      const earlier = restored[base]!['messages'] as unknown[];
      messages = [...earlier.slice(0, keep), ...item.messages.items];
    }
    let tools: unknown;
    if (item.tools !== undefined) {
      if (!(item.tools in table)) throw new Error(`基準檔壞了：工具表沒有 ${item.tools}`);
      tools = table[item.tools];
    }
    const parts: Record<string, unknown> = { ...item.rest, messages };
    if (item.tools !== undefined) parts['tools'] = tools;
    restored.push(Object.fromEntries(item.order.map((key) => [key, parts[key]])));
  }
  return restored;
}
