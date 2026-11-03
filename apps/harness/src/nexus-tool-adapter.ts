/**
 * `NexusTool`（`@nexus/tools` 契約 `2.0.0`，#2351）轉成 LangChain 的工具，讓還跑在 LangGraph 上的組裝照樣叫得到它。
 * 轉接器只住在宿主：插件只看見 `NexusTool`，不碰 LangChain。
 *
 * - **送上線的 schema 就是 `parameters`**：轉出來的工具經 LangChain 編回 JSON Schema 之後，必須與 `parameters` 逐字相同，
 *   不同就在轉的當下拋錯，不送出另一份位元組。
 * - **驗證交給 zod**：`parameters` 轉回 zod 交給 LangChain 驗，未宣告的鍵收下後丟掉，錯誤句是 zod 的逐項訊息。
 *   JSON Schema 直接交給 LangChain 的話，它改用另一套驗證，多帶鍵的呼叫整次拒收、錯誤句也只剩一行。
 * - **身分是資料**：`ToolExec` 的 `threadId`、`agent` 從 LangGraph 的呼叫設定算一次，`forCall` 直接收它，結果與收呼叫設定時相同。
 *   `signal` 是這一輪的停止訊號（放在 `configurable`，見 `@nexus/core` 的 `turn-cancel.ts`）併上 LangGraph 自己的 `signal`。
 * - **錯誤是結果上的資料欄**：`ok: false` 轉成 `toolRefusal`，碼掛在那則訊息上，`tool/result` 讀得到。
 *   `execute` reject 不接，照 LangChain 工具拋錯的路走。
 *
 * @module
 */

import { tool as langChainTool } from '@langchain/core/tools';
import type {
  StructuredTool,
  StructuredToolInterface,
  ToolRunnableConfig,
} from '@langchain/core/tools';
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import {
  callThreadId,
  concludeTurn,
  toolCallSessionAddress,
  toolRefusal,
  turnCancelSignalOf,
} from '@nexus/core';
import { isNexusTool } from '@nexus/tools';
import type { JsonSchema, JsonValue, NexusTool, ToolExec } from '@nexus/tools';
import { z } from 'zod';

const adapted = new WeakMap<NexusTool, StructuredTool>();

/**
 * 登記處裡的一個工具，交給 LangGraph 組裝的那個形狀。
 *
 * @param tool - 登記進來的工具。
 * @returns LangChain 的工具；本來就是的原樣交回，`NexusTool` 經 {@link toLangChainTool}。
 */
export function langChainToolOf(
  tool: NexusTool | StructuredToolInterface,
): StructuredToolInterface {
  return isNexusTool(tool) ? toLangChainTool(tool) : tool;
}

/**
 * 一個 `NexusTool` 轉成的 LangChain 工具。同一個 `NexusTool` 每次拿到同一個實例：組裝用工具實例當選項表的鍵。
 *
 * @param tool - 要轉的工具。
 * @returns 轉出來的工具。
 * @throws 轉出來的工具送上線的 schema 與 `parameters` 不同。
 */
export function toLangChainTool(tool: NexusTool): StructuredTool {
  let converted = adapted.get(tool);
  if (converted === undefined) {
    converted = convert(tool);
    adapted.set(tool, converted);
  }
  return converted;
}

/**
 * 從 LangGraph 交給工具的呼叫設定算出 `ToolExec`。
 *
 * @param name - 工具名，`concludeTurn()` 用。
 * @param config - LangChain 工具收到的第二個參數。
 * @returns 這次呼叫的 `ToolExec`。
 */
export function toolExecOf(name: string, config: ToolRunnableConfig | undefined): ToolExec {
  return Object.freeze({
    callId: config?.toolCall?.id ?? '',
    threadId: callThreadId(config),
    agent: toolCallSessionAddress(config),
    signal: signalOf(config),
    concludeTurn: () => concludeTurn(name),
  });
}

function signalOf(config: ToolRunnableConfig | undefined): AbortSignal | undefined {
  const own = config?.signal;
  const turn = turnCancelSignalOf(config);
  if (turn === undefined) return own;
  return own === undefined ? turn : AbortSignal.any([own, turn]);
}

function convert(tool: NexusTool): StructuredTool {
  const schema = z.fromJSONSchema(
    lenient(tool.parameters) as Parameters<typeof z.fromJSONSchema>[0],
  );
  const converted = langChainTool(
    async (args: Record<string, JsonValue>, config?: ToolRunnableConfig) => {
      const exec = toolExecOf(tool.name, config);
      const result = await tool.execute(args, exec);
      if (result.ok) return result.content;
      return toolRefusal(result.content, {
        callId: exec.callId,
        name: tool.name,
        ...(result.error !== undefined && { error: result.error }),
      });
    },
    { name: tool.name, description: tool.description, schema },
  );
  const wire = JSON.stringify(toJsonSchema(converted.schema));
  if (wire !== JSON.stringify(tool.parameters)) {
    throw new Error(
      `工具 ${tool.name} 的 parameters 轉成 LangChain 工具之後，送上線的 schema 不同：${wire}`,
    );
  }
  return converted;
}

/** 拿掉 `additionalProperties: false` 與根上的 `$schema`：zod 的 `z.object` 收下未宣告的鍵再丟掉，送上線時 LangChain 再加回去。 */
function lenient(schema: JsonSchema): JsonValue {
  const { $schema: _, ...rest } = schema;
  return strip(rest);
}

function strip(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(strip);
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, JsonValue> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (key === 'additionalProperties' && inner === false) continue;
    out[key] = strip(inner);
  }
  return out;
}
