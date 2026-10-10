/**
 * 舊工具呼叫參數被縮短這件事在會話日誌裡的樣子，與把它們換上去的純函式
 * （[#1303](https://github.com/DemianLi/nexus-agent/issues/1303)，日誌格式 47）。
 *
 * 縮短是基座（`deepagents@1.13.1`）摘要器的 `truncateArgs` 做的：每次請求前，在 `keep` 之前的助手訊息裡，`write_file`／`edit_file` 的字串參數
 * 超過 `maxLength` 的換成「開頭 20 個字＋標記」。它只改請求，不寫日誌，所以從日誌推不回模型實際看到的那一份。我們不擁有那段程式碼，
 * 所以**不重寫它的規則，改成觀察結果**：基座把請求交下去的那一刻拿交下去的串跟進來的串比（{@link newlyTruncatedArgs}），縮短了的記一筆
 * `compaction/truncate-args`（`session-log.ts`），**每個參數只記一次，之後每次請求都沿用**——形狀與 `compaction/prune`（{@link ./tool-result-prune-log.ts}）同。
 * 兩個讀者共用這個檔：請求端（`summarization.ts` 的 `withArgTruncationLog`，每次呼叫前把記過的換上去再交給基座）與推導端
 * （`replayConversation` 的 `applyArgTruncations` 選項），所以**兩邊換出來的東西逐位元組相同**不是巧合，是同一個函式。
 *
 * ## 換出來的訊息只改參數，不學基座整則重建
 *
 * 基座縮短時整則重建：`new AIMessage({ content, tool_calls, additional_kwargs })`，丟掉 `id`、`name`、`response_metadata`、`usage_metadata`
 * （`apps/harness/src/live-model.ts` 那段 `[]` 註解提到的那件事——`response_metadata.output_version` 沒了，`@langchain/openai` 走另一條轉換，
 * 沒有文字的推理＋工具呼叫那則送成 `[]`）。**這裡不學**：保留原訊息的其他欄位、只換 `tool_calls[i].args`（v1 訊息裡同 id 的 `tool_call` content block 一併換，
 * 不然同一則訊息裡有兩份對不上的參數），所以這張卡不讓那個丟失惡化，
 * 而且換過的訊息之後基座看到參數已經短了，不會再因為共用的 `modified` 旗標把後面的鄰居也整則重建。
 * 代價：同一則訊息第一次（基座重建）與之後（這裡換）在 `@langchain/openai` 那一層走不同的路，空內容那一格是 `[]` 對 `null`；
 * 產品的 `fetch` 層（`withEmptyAssistantContent`）把前者換成後者，所以兩者在 wire 上逐位元組相同。
 *
 * ## 對得上才換
 *
 * 以 `callId`（`tool_calls[i].id`）加參數名指到被縮短的那個參數，**再比一次長度**（`originalChars`，UTF-16 code unit，同基座的 `value.length`）：
 * 供應商可能重用工具呼叫 id，不能把另一個呼叫的縮短套上去。對不上就原樣放過，不拋。
 *
 * @module
 */

import { AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { SessionEvent } from './session-log.js';

/** 日誌上記的一個被縮短的參數。 */
export interface RecordedArgTruncation {
  /** 縮短之前的長度（UTF-16 code unit）。兼作對得上的檢查。 */
  readonly originalChars: number;
  /** 縮短後的字串，模型實際看到的那一份。 */
  readonly value: string;
}

/** 日誌上記過的縮短，鍵是工具呼叫 `id`，再來是參數名。 */
export type RecordedArgTruncations = ReadonlyMap<
  string,
  ReadonlyMap<string, RecordedArgTruncation>
>;

/** 一個工具呼叫剛被縮短的參數，形狀同事件的 `calls[i]`。 */
export interface NewlyTruncatedCall {
  readonly callId: string;
  readonly args: Readonly<Record<string, RecordedArgTruncation>>;
}

/**
 * 從日誌讀出所有縮短。
 *
 * 同一個參數記了不只一次（不該發生）時以**後記的**為準。
 *
 * @param events - 日誌事件，照 `seq` 排。
 * @returns 沒有 `compaction/truncate-args` 就是空 Map。
 */
export function recordedArgTruncationsOf(events: readonly SessionEvent[]): RecordedArgTruncations {
  const recorded = new Map<string, Map<string, RecordedArgTruncation>>();
  for (const event of events) {
    if (event.type !== 'compaction/truncate-args') continue;
    for (const call of (event as SessionEvent<'compaction/truncate-args'>).data.calls) {
      let args = recorded.get(call.callId);
      if (args === undefined) recorded.set(call.callId, (args = new Map()));
      for (const [key, truncation] of Object.entries(call.args)) {
        args.set(key, { originalChars: truncation.originalChars, value: truncation.value });
      }
    }
  }
  return recorded;
}

/** 一則訊息的工具呼叫；不是助手訊息、或沒有工具呼叫就是 `undefined`。 */
function toolCallsOf(message: BaseMessage): AIMessage['tool_calls'] {
  if (!AIMessage.isInstance(message)) return undefined;
  return message.tool_calls !== undefined && message.tool_calls.length > 0
    ? message.tool_calls
    : undefined;
}

/**
 * 把一則訊息裡每個記過的參數換上縮短後的字串。
 *
 * @param message - 任何一則訊息；不是助手訊息、或沒有一個參數對得上的原樣回。
 * @param recorded - {@link recordedArgTruncationsOf} 的結果。
 * @returns 有換的時候是只換了 `tool_calls[i].args` 的新 `AIMessage`（其餘欄位原樣）；否則是傳進來的那一則。
 */
export function applyRecordedArgTruncation(
  message: BaseMessage,
  recorded: RecordedArgTruncations,
): BaseMessage {
  const calls = toolCallsOf(message);
  if (calls === undefined) return message;
  let changed = false;
  const next = calls.map((call) => {
    const truncations = call.id === undefined ? undefined : recorded.get(call.id);
    if (truncations === undefined) return call;
    const args: Record<string, unknown> = { ...(call.args as Record<string, unknown>) };
    let callChanged = false;
    for (const [key, truncation] of truncations) {
      const current = args[key];
      if (typeof current !== 'string' || current.length !== truncation.originalChars) continue;
      args[key] = truncation.value;
      callChanged = true;
    }
    if (!callChanged) return call;
    changed = true;
    return { ...call, args };
  });
  if (!changed) return message;
  const source = message as AIMessage;
  // 帶 `output_version: 'v1'` 的訊息（串流那條）建構子會替 `tool_calls` 補 `tool_call` content block，block 裡也有一份參數；
  // 只換 `tool_calls` 會留下兩份對不上的參數，所以同 id 的 block 一併換。沒有 block 的訊息（字串內容、舊路）不動 `content`。
  const argsById = new Map(next.map((call) => [call.id, call.args]));
  const content = Array.isArray(source.content)
    ? source.content.map((block) => {
        const candidate = block as { type?: unknown; id?: unknown };
        const args = typeof candidate.id === 'string' ? argsById.get(candidate.id) : undefined;
        return candidate.type === 'tool_call' && args !== undefined ? { ...block, args } : block;
      })
    : source.content;
  return new AIMessage({ ...source, content, tool_calls: next });
}

/**
 * 把一串訊息裡每個記過的參數換上縮短後的字串。
 *
 * @param messages - 原訊息串。
 * @param recorded - {@link recordedArgTruncationsOf} 的結果。
 * @returns 一則都沒換時是**原本那個陣列**；否則長度與順序與輸入相同的新陣列。
 */
export function applyRecordedArgTruncations(
  messages: readonly BaseMessage[],
  recorded: RecordedArgTruncations,
): readonly BaseMessage[] {
  if (recorded.size === 0) return messages;
  let changed = false;
  const next = messages.map((message) => {
    const replaced = applyRecordedArgTruncation(message, recorded);
    if (replaced !== message) changed = true;
    return replaced;
  });
  return changed ? next : messages;
}

/**
 * 拿基座交下去的串跟進來的串比，找出哪些工具呼叫的哪些參數被縮短了。
 *
 * 用工具呼叫 `id` 對，不用位置：交下去的串開頭可能多一則摘要、少一截舊訊息。**進來的串裡同一個 `id` 出現不只一次的不比**
 * （供應商重用 id，分不出是哪一個，同 {@link applyRecordedArgTruncation} 的理由）。字串參數的值不同就算，不管變長變短——
 * 日誌要證明的是「模型看到的那一份」，不是基座的規則。
 *
 * @param before - 交給基座之前的串（已套過記過的縮短）。
 * @param sent - 基座交下去的串。
 * @returns 新縮短的呼叫，照 `sent` 的順序；沒有就是空陣列。
 */
export function newlyTruncatedArgs(
  before: readonly BaseMessage[],
  sent: readonly BaseMessage[],
): NewlyTruncatedCall[] {
  const baseline = new Map<string, Readonly<Record<string, unknown>> | null>();
  for (const message of before) {
    for (const call of toolCallsOf(message) ?? []) {
      if (call.id === undefined) continue;
      baseline.set(call.id, baseline.has(call.id) ? null : (call.args as Record<string, unknown>));
    }
  }
  const found: NewlyTruncatedCall[] = [];
  for (const message of sent) {
    for (const call of toolCallsOf(message) ?? []) {
      if (call.id === undefined) continue;
      const original = baseline.get(call.id);
      if (original === undefined || original === null) continue;
      const args: Record<string, RecordedArgTruncation> = {};
      for (const [key, value] of Object.entries(call.args as Record<string, unknown>)) {
        const was = original[key];
        if (typeof value === 'string' && typeof was === 'string' && value !== was) {
          args[key] = { originalChars: was.length, value };
        }
      }
      if (Object.keys(args).length > 0) found.push({ callId: call.id, args });
    }
  }
  return found;
}
