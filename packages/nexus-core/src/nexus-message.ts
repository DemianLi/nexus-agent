/**
 * nexus 自己的訊息型別（[#2350](https://github.com/DemianLi/nexus-agent/issues/2350)）：與會話日誌落盤的那一則同形（`{ type, data }`），
 * 從日誌推模型歷史的那一側（`conversation-replay.ts`、`model-history.ts`）只用它，不碰 LangChain 的訊息類別。
 * 交給 LangGraph 的那一側由 `langchain-message-adapter.ts` 的 `toBaseMessage` 轉成 `BaseMessage`。
 *
 * ## 形狀
 *
 * `type` 是 `ai`／`human`／`tool`／`system` 這些，`data` 是那一則的欄位，與 LangChain `StoredMessage` 的 `data` 同一組鍵：
 * 轉成 `BaseMessage` 時 `data` 原樣交給建構子（`mapStoredMessagesToChatMessages`），所以 nexus 這側造出來的 `data`
 * 跟直接 `new ToolMessage({ … })` 傳的那一包相同時，轉出來的訊息也相同。
 *
 * ## 讀的時候要照建構子的規矩
 *
 * `BaseMessage` 的建構子會補欄位，推導讀的是補過的值：{@link nexusToolCalls} 照 `AIMessage` 建構子的規則算出工具呼叫，
 * {@link nexusContent} 照 `BaseMessage` 建構子的規則算出內容。日誌上的訊息都由建構過的訊息落盤，這兩支讀到的通常就是 `data` 上那一格；
 * 例外是舊格式（只有 `additional_kwargs.tool_calls`）與 v1 的區塊，`nexus-message.test.ts` 逐條釘住。
 *
 * @module
 */

/** 內容裡的一個區塊，同 LangChain 的 `ContentBlock`（`type` 必填、`id` 選填，其餘任意）。 */
export interface ContentBlock {
  readonly type: string;
  id?: string;
  [key: string]: unknown;
}

/** 一則訊息的內容：一串字或區塊陣列，同 LangChain 的 `MessageContent`。 */
export type MessageContent = string | Array<ContentBlock>;

/**
 * 一則訊息的欄位。
 *
 * `role`、`name`、`tool_call_id` 是**選填的字串**：落盤前做過一次 JSON 往返，值是 `undefined` 的鍵在那一步就消失。持久化型別圖
 * （`apps/harness/src/persistence-schema.ts`，#1856）要表示得出來，必填卻可以是 `undefined` 的欄位不是 JSON。
 * `additional_kwargs`、`response_metadata` 照 LangChain 宣告成 `Record<string, any>`，型別圖裡是 `any`；收窄屬
 * [#1883](https://github.com/DemianLi/nexus-agent/issues/1883)。其餘欄位（`tool_calls`、`status`、`artifact`…）不宣告，讀的地方自己收窄。
 */
export interface NexusMessageData {
  readonly content: MessageContent;
  readonly role?: string;
  readonly name?: string;
  readonly tool_call_id?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同 LangChain StoredMessageData，收窄屬 #1883
  additional_kwargs?: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
  response_metadata?: Record<string, any>;
  id?: string;
}

/** 一則訊息。日誌記的那一則（`LoggedMessage`）就是這個形狀。 */
export interface NexusMessage {
  readonly type: string;
  readonly data: NexusMessageData;
}

/** 助手訊息要的一次工具呼叫，同 LangChain 的 `ToolCall`。 */
export interface NexusToolCall {
  readonly id?: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly type?: 'tool_call';
}

/** `data` 上不宣告的那些欄位，讀的時候收窄。 */
function fieldsOf(message: NexusMessage): Readonly<Record<string, unknown>> {
  return message.data as unknown as Readonly<Record<string, unknown>>;
}

/** 字串變成一塊文字（空字串是空陣列），陣列原樣，其餘是空陣列或單塊。同 LangChain `ai.js` 的 `coerceToContentBlocks`。 */
function coerceToContentBlocks(value: unknown): unknown[] {
  if (typeof value === 'string') return value.length > 0 ? [{ type: 'text', text: value }] : [];
  if (Array.isArray(value)) return value as unknown[];
  if (value === null || value === undefined) return [];
  return [value];
}

/** 舊格式的 `additional_kwargs.tool_calls` 解出來的呼叫：參數是合法 JSON 的才算，同 LangChain 的 `defaultToolCallParser`。 */
function parsedRawToolCalls(raw: unknown): NexusToolCall[] {
  const calls: NexusToolCall[] = [];
  for (const entry of raw as Iterable<unknown>) {
    const call = entry as { id?: string; function?: { name?: string; arguments?: string } };
    if (!call.function) continue;
    try {
      const args = JSON.parse(call.function.arguments as string) as Record<string, unknown> | null;
      calls.push({ name: call.function.name || '', args: args || {}, id: call.id });
    } catch {
      // 參數不是 JSON 的進 `invalid_tool_calls`，不算要了的呼叫。
    }
  }
  return calls;
}

/** `AIMessage` 建構子補過之後的工具呼叫與區塊（沒有區塊時是 `undefined`）。 */
function constructedAi(message: NexusMessage): {
  readonly calls: readonly NexusToolCall[];
  readonly blocks: readonly unknown[] | undefined;
} {
  const data = fieldsOf(message);
  const raw = (data.additional_kwargs as { tool_calls?: unknown } | undefined)?.tool_calls;
  let calls: NexusToolCall[];
  try {
    calls =
      raw !== null && raw !== undefined && data.tool_calls === undefined
        ? parsedRawToolCalls(raw)
        : [...((data.tool_calls as NexusToolCall[] | undefined) ?? [])];
  } catch {
    calls = [];
  }
  const metadata = data.response_metadata as { output_version?: unknown } | undefined;
  const source =
    metadata?.output_version === 'v1' && data.content !== undefined
      ? coerceToContentBlocks(data.content)
      : data.contentBlocks === undefined
        ? undefined
        : coerceToContentBlocks(data.contentBlocks);
  if (source === undefined) return { calls, blocks: undefined };
  type Block = { type?: unknown; id?: string; name?: string; args?: unknown };
  const blocks = [
    ...(source as Block[]),
    ...calls
      .filter(
        (call) =>
          !(source as Block[]).some(
            (block) =>
              block.type === 'tool_call' && block.id === call.id && block.name === call.name,
          ),
      )
      .map((call) => ({ type: 'tool_call', id: call.id, name: call.name, args: call.args })),
  ];
  const missing = blocks
    .filter((block) => block.type === 'tool_call')
    .filter((block) => !calls.some((call) => call.id === block.id && call.name === block.name));
  return {
    calls: [
      ...calls,
      ...missing.map((block) => ({
        type: 'tool_call' as const,
        id: block.id,
        name: block.name as string,
        args: block.args as Record<string, unknown>,
      })),
    ],
    blocks,
  };
}

/**
 * 一則助手訊息要的工具呼叫，與它轉成 `AIMessage` 之後的 `tool_calls` 相同；不是助手訊息就是空陣列。
 *
 * 照 `AIMessage` 建構子（`@langchain/core@1.2.9` 的 `messages/ai.js`）：有 `tool_calls` 就用它；沒有、但有舊格式的
 * `additional_kwargs.tool_calls`，就解那一份；解的時候拋了就當沒有。v1 的訊息（`response_metadata.output_version === 'v1'`）
 * 或帶 `contentBlocks` 的，區塊裡有、`tool_calls` 沒有的 `tool_call` 接在後面。
 */
export function nexusToolCalls(message: NexusMessage): readonly NexusToolCall[] {
  return message.type === 'ai' ? constructedAi(message).calls : [];
}

/**
 * 一則訊息轉成 `BaseMessage` 之後的 `content`，**只用來判斷**（空不空、有沒有圖），不拿來重建。
 *
 * 照 `BaseMessage` 建構子：有 `content` 就用它（`null` 算空陣列）；沒有、但有 `contentBlocks`，用那一份。v1 助手訊息的 `content`
 * 換成區塊、再補上 `tool_call` 區塊（`AIMessage` 建構子），同 {@link nexusToolCalls}。
 */
export function nexusContent(message: NexusMessage): MessageContent {
  const data = fieldsOf(message);
  const blocks = message.type === 'ai' ? constructedAi(message).blocks : undefined;
  if (blocks !== undefined) return blocks as MessageContent;
  if (data.content === undefined && data.contentBlocks !== undefined) {
    return data.contentBlocks as MessageContent;
  }
  return (data.content ?? []) as MessageContent;
}
