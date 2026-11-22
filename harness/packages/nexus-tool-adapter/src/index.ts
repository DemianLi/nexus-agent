/**
 * `NexusTool`（`@nexus/tools` 契約 `2.x`，#2351、#2352）轉成 LangChain 的工具，讓還跑在 LangGraph 上的組裝照樣叫得到它。
 * 插件原始碼不 import 這個套件（SDK lint 擋），插件只看見 `NexusTool`、不碰 LangChain；插件的測試要拿真的 LangChain 工具時，
 * 從 devDependencies 用它。
 *
 * - **`parameters` 是 input 模式；送上線時，帶 `properties`、沒寫 `additionalProperties` 的物件補 `false`**（record 不動）：
 *   LangChain 送 zod 工具時就是這樣補的，所以兩種工具送出的位元組相同。轉出來的工具經 LangChain 編回 JSON Schema 之後，
 *   必須與補過 `false` 的 `parameters` 逐字相同，不同就在轉的當下拋錯。
 * - **驗證交給 zod**：`parameters` 轉成 zod 交給 LangChain 驗。寫了 `additionalProperties: false` 的物件多帶鍵就拒，沒寫的收下後丟掉，
 *   錯誤句是 zod 的逐項訊息。JSON Schema 直接交給 LangChain 的話，它改用另一套驗證，錯誤句只剩一行。
 * - **`rawParameters: true` 的工具例外**：JSON Schema 原樣交給 LangChain，由它那一套驗、錯誤句是那一行；不補 `additionalProperties`。
 * - **`timeoutMs` 轉成 `defaultConfig.timeout`**：基座到期舉起 `signal`，圍堵的逾時措辭讀同一格。
 * - **`artifact` 跟著結果走**：一律用 `content_and_artifact`，沒帶的就是 `undefined`，那則 `ToolMessage` 跟只回內容時一樣。
 * - **身分是資料**：`ToolExec` 的 `threadId`、`agent` 從 LangGraph 的呼叫設定算一次，`forCall` 直接收它，結果與收呼叫設定時相同。
 *   `signal` 是這一輪的停止訊號（放在 `configurable`，見 `@nexus/core` 的 `turn-cancel.ts`）併上 LangGraph 自己的 `signal`。
 * - **錯誤是結果上的資料欄**：`ok: false` 轉成 `toolRefusal`，碼掛在那則訊息上，`tool/result` 讀得到。
 *   `execute` reject 不接，照 LangChain 工具拋錯的路走。
 * - **`interrupt()` 先找 loop 放的等人服務**（`@nexus/core` 的 `humanInputOf`，[#2358](https://github.com/DemianLi/nexus-agent/issues/2358)）：
 *   讀得到就 await 它，答覆就是回傳值、本體不重跑；讀到「這裡沒人可問」（`NO_HUMAN_INPUT`）就以 `HumanInputUnavailable` 拒絕；
 *   都沒有才用 LangGraph 的 `interrupt()`，掛起靠拋例外，恢復時工具本體重跑。
 * - **`concludesTurn: true` 轉成 `returnDirect: true`**：沒宣告的工具不帶它，`concludeTurn()` 標了也不收。
 * - **`deferContext()` 補的訊息**：成功的結果與補的訊息包成一顆 `Command`，那則工具結果的 `ToolMessage` 由這裡造。
 *
 * 入口另外轉出 `runThreadSources`（`thread-source.ts`）：把樹上插件登記的逐條 thread 工具來源接到相容層 registry 的橋。宿主（harness 的
 * `plugin-config.ts`）與插件自己的測試用同一份；哪些宿主服務授權給哪顆插件不在這裡，由呼叫端決定。
 *
 * @module
 */

import { HumanMessage, ToolMessage } from '@langchain/core/messages';
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
  humanInputOf,
  humanInputUnavailable,
  sourceKwargs,
  toolCallSessionAddress,
  toolRefusal,
  turnCancelSignalOf,
} from '@nexus/core';
import { Command, interrupt } from '@langchain/langgraph';
import { HumanInputUnavailable, isNexusTool } from '@nexus/tools';
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
 * @throws `parameters` 用了轉接器不認得的關鍵字或 type、enum 不是非空字串、record 的鍵不是字串、物件同時帶 `properties` 與
 *   `additionalProperties` schema，或轉出來的工具送上線的 schema 與補過 `false` 的 `parameters` 不同。
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
 * @param name - 工具名，`concludeTurn()` 與 `deferContext()` 用。
 * @param config - LangChain 工具收到的第二個參數。
 * @param deferred - `deferContext()` 補的訊息收在這裡；省略是丟掉。
 * @returns 這次呼叫的 `ToolExec`。
 */
export function toolExecOf(
  name: string,
  config: ToolRunnableConfig | undefined,
  deferred: HumanMessage[] = [],
): ToolExec {
  return Object.freeze({
    callId: config?.toolCall?.id ?? '',
    threadId: callThreadId(config),
    agent: toolCallSessionAddress(config),
    signal: signalOf(config),
    concludeTurn: () => concludeTurn(name),
    deferContext: (text: string, marks: { readonly [key: string]: JsonValue } = {}) => {
      deferred.push(
        new HumanMessage({
          content: text,
          additional_kwargs: { ...marks, ...sourceKwargs({ kind: 'plugin', plugin: name }) },
        }),
      );
    },
    // LangGraph 的 `interrupt` 用拋例外傳播，呼叫端不能吞掉，要 catch 就原樣重拋（`@langchain/langgraph@1.4.19`，`dist/pregel/runnable_types.d.ts:56-58`）。
    interrupt: (payload: JsonValue) => {
      if (humanInputUnavailable(config)) return Promise.reject(new HumanInputUnavailable());
      const service = humanInputOf(config);
      return service === undefined
        ? Promise.resolve(interrupt(payload))
        : (service.ask(payload) as Promise<JsonValue>);
    },
  });
}

function signalOf(config: ToolRunnableConfig | undefined): AbortSignal | undefined {
  const own = config?.signal;
  const turn = turnCancelSignalOf(config);
  if (turn === undefined) return own;
  return own === undefined ? turn : AbortSignal.any([own, turn]);
}

function convert(tool: NexusTool): StructuredTool {
  const { timeoutMs } = tool;
  if (timeoutMs !== undefined && !(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    throw new Error(`工具 ${tool.name} 的 timeoutMs 要是正的有限數：${String(timeoutMs)}`);
  }
  const raw = tool.rawParameters === true ? rawSchemaOf(tool.parameters) : undefined;
  const schema = raw ?? zodOf(tool.parameters, tool.name);
  const converted = langChainTool(
    async (args: Record<string, JsonValue>, config?: ToolRunnableConfig) => {
      const deferred: HumanMessage[] = [];
      const exec = toolExecOf(tool.name, config, deferred);
      const result = await tool.execute(args, exec);
      if (result.ok && deferred.length > 0) {
        // 回 `Command` 時 LangChain 不替結果包 `ToolMessage`（`@langchain/core@1.2.9` `dist/tools/index.js:335` 的 `isDirectToolOutput`），
        // 要自己帶這次呼叫的 id。
        if (exec.callId === '')
          throw new Error(`工具 ${tool.name} 要補訊息，但這次呼叫沒有 tool_call_id`);
        const message = new ToolMessage({
          content: result.content as ToolMessage['content'],
          ...(result.artifact !== undefined && { artifact: result.artifact }),
          tool_call_id: exec.callId,
          name: tool.name,
        });
        return [new Command({ update: { messages: [message, ...deferred] } }), undefined];
      }
      if (result.ok) return [result.content, result.artifact];
      return [
        toolRefusal(result.content, {
          callId: exec.callId,
          name: tool.name,
          ...(result.error !== undefined && { error: result.error }),
        }),
        undefined,
      ];
    },
    {
      name: tool.name,
      description: tool.description,
      schema,
      // 每個 return 都是兩格：這個格式不是兩格就拋（`@langchain/core@1.2.9` `dist/tools/index.js:147`）；第一格是 `ToolMessage`
      // 或 `Command` 時原樣交出去，第二格不看（`:335`）。
      responseFormat: 'content_and_artifact',
      // 基座把 `defaultConfig.timeout` 變成併進 `signal` 的 `AbortSignal.timeout`；圍堵讀同一格講出預算（`@nexus/core` 的 `containment.ts`）。
      ...(timeoutMs !== undefined && { defaultConfig: { timeout: timeoutMs } }),
      // 基座的 tools 路由只認靜態的 `returnDirect` 名單，標了 `concludeTurn()` 的結果才留住 `name` 而收這一輪（`@nexus/core` 的 `turn-conclusion.ts`）。
      ...(tool.concludesTurn === true && { returnDirect: true }),
    },
  );
  const wire = JSON.stringify(toJsonSchema(converted.schema));
  if (wire !== JSON.stringify(raw ?? closed(tool.parameters))) {
    throw new Error(
      `工具 ${tool.name} 的 parameters 轉成 LangChain 工具之後，送上線的 schema 不同：${wire}`,
    );
  }
  return converted;
}

/**
 * `rawParameters` 的工具送上線的形狀：原樣，根物件沒有 `properties` 時補一個空的。MCP 插件的工具送的就是這個形狀
 * （同 `@langchain/mcp-adapters@2.0.0` `dist/tools.js:206`，#2353 的對照組釘住）。
 */
function rawSchemaOf(parameters: JsonSchema): JsonSchema {
  return parameters.properties === undefined ? { ...parameters, properties: {} } : parameters;
}

/** 送上線的形狀：每個帶 `properties`、沒寫 `additionalProperties` 的物件補 `false`，LangChain 送 zod 工具時就是這樣補的。 */
function closed(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(closed);
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, JsonValue> = {};
  for (const [key, inner] of Object.entries(value)) out[key] = closed(inner);
  if (out.type === 'object' && out.properties !== undefined && !('additionalProperties' in out)) {
    out.additionalProperties = false;
  }
  return out;
}

const KNOWN_KEYS = new Set([
  '$schema',
  'type',
  'description',
  'properties',
  'required',
  'additionalProperties',
  'propertyNames',
  'items',
  'enum',
]);

/**
 * `parameters` 轉成驗證用的 zod。只收出廠工具用到的關鍵字，其餘當場拋。
 *
 * 不用 `z.fromJSONSchema`：它把 `description` 排到 `type` 後面，送上線的位元組會變；選填欄位的說明寫在選填那一層，
 * 這裡照 `parameters` 的鍵序決定 `describe` 包在哪一層。
 */
function zodOf(schema: JsonValue, toolName: string, required = true): z.ZodType {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new Error(`工具 ${toolName} 的 parameters 有一格不是物件：${JSON.stringify(schema)}`);
  }
  const node = schema as { readonly [key: string]: JsonValue };
  for (const key of Object.keys(node)) {
    if (!KNOWN_KEYS.has(key))
      throw new Error(`工具 ${toolName} 的 parameters 用了轉接器不認得的 ${key}`);
  }
  let inner = bareZodOf(node, toolName);
  const description = typeof node.description === 'string' ? node.description : undefined;
  const outer = description !== undefined && Object.keys(node)[0] === 'description';
  if (description !== undefined && !outer) inner = inner.describe(description);
  if (!required) inner = inner.optional();
  if (description !== undefined && outer) inner = inner.describe(description);
  return inner;
}

function bareZodOf(node: { readonly [key: string]: JsonValue }, toolName: string): z.ZodType {
  if (Array.isArray(node.enum)) {
    if (!node.enum.every((value) => typeof value === 'string') || node.enum.length === 0) {
      throw new Error(`工具 ${toolName} 的 parameters 只收非空的字串 enum`);
    }
    return z.enum(node.enum as [string, ...string[]]);
  }
  switch (node.type) {
    case 'string':
      return z.string();
    case 'number':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'null':
      return z.null();
    case 'array':
      if (node.items === undefined) break;
      return z.array(zodOf(node.items, toolName));
    case 'object':
      return objectZodOf(node, toolName);
  }
  throw new Error(`工具 ${toolName} 的 parameters 有一格轉接器不認得：${JSON.stringify(node)}`);
}

function objectZodOf(node: { readonly [key: string]: JsonValue }, toolName: string): z.ZodType {
  const extra = node.additionalProperties;
  if (node.properties === undefined) {
    if (typeof extra !== 'object' || extra === null || Array.isArray(extra)) {
      throw new Error(`工具 ${toolName} 的 parameters 有一個物件既沒有 properties 也不是 record`);
    }
    if (JSON.stringify(node.propertyNames) !== '{"type":"string"}') {
      throw new Error(`工具 ${toolName} 的 parameters 的 record 鍵只收字串`);
    }
    return z.record(z.string(), zodOf(extra, toolName));
  }
  const properties = node.properties as { readonly [key: string]: JsonValue };
  const required = new Set(Array.isArray(node.required) ? node.required : []);
  const shape: Record<string, z.ZodType> = {};
  for (const [key, inner] of Object.entries(properties)) {
    shape[key] = zodOf(inner, toolName, required.has(key));
  }
  if (extra === false) return z.strictObject(shape);
  if (extra === undefined) return z.object(shape);
  throw new Error(
    `工具 ${toolName} 的 parameters 有一個物件同時帶 properties 與 additionalProperties`,
  );
}

export { runThreadSources } from './thread-source.js';
export type { FoldedThreadSource, ThreadSourceOwner } from './thread-source.js';
