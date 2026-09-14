/**
 * 一則訊息在會話日誌裡長什麼樣：LangChain 自己的 `StoredMessage`，再壓成純 JSON
 * （[#305](https://github.com/DemianLi/nexus-agent/issues/305)）。
 *
 * ## 為什麼是這個形狀，不是 dsh 的 `Message`
 *
 * dsh 在 `assistant/message`、`tool/result`、`user/message` 裡帶的是它自己的 `Message`
 * （`packages/llm/llm/src/message.ts`，`c291e79`）：`{ id, role, content: ContentBlock[], source }`，
 * 供應商要的私有重播資料放在 `source.replayState`。它的紀律是**重播無損**——從日誌推回來的
 * 訊息就是當時送給模型的那一則（`packages/core/session/src/surface.ts` 的 `deriveEventMessage`
 * 直接回事件裡那一顆）。
 *
 * **我們模型看到的訊息是 LangChain 的 `BaseMessage`，不是 dsh 的 `Message`。** 換成 dsh 的形狀
 * 得在寫入時翻一次、讀回時再翻回來，而 `additional_kwargs`（DeepSeek 的 `reasoning_content`
 * 就住在這裡）、`response_metadata`、`tool_calls` 與 v3 的 content block 都要有對應——翻得不齊，
 * 推回來的就不是同一則。基座自己有一組無損的來回：`mapChatMessagesToStoredMessages` 與
 * `mapStoredMessagesToChatMessages`（`@langchain/core@1.2.9` 的 `messages/utils`）。**退到那一組，
 * 紀律照抄**：記下來的東西推得回同一則訊息。偏離登記在 #305 的 PR。
 *
 * ## 為什麼還要再壓一次 JSON
 *
 * `SessionLog.append` 的 `snapshotJsonValue` 對 `undefined` 是當場拋的，而 `toDict()` 取的是建構子
 * 收到的那份欄位（`toJSON().kwargs`）：**建訊息的人明著傳了 `undefined` 的欄位，就照樣列成 key**。
 * 實測 `new ToolMessage({ ..., artifact: undefined })` 的 `data` 帶著 `artifact` 與 `metadata` 兩個
 * `undefined`，而基座搬移大結果時就是這樣建的（`artifact: msg.artifact`）。拋的話那一顆整筆不算，
 * 而寫它的人都把 `append` 的例外吞掉（記不進去不能扳倒模型呼叫），結果是日誌上**安靜地少一則**：
 * 從日誌推模型歷史的讀方分不出那是「沒記成」還是「那次沒有回覆」。所以在這裡先壓成 JSON——
 * `undefined` 的 key 消失、形狀照舊，那一條會安靜失敗的路從源頭就不存在。jsonl 落盤時本來就是這樣
 * 序列化的，這一步只是讓記憶體裡那一份與磁碟上那一份提早長成同一個樣子。
 */

import {
  mapChatMessagesToStoredMessages,
  mapStoredMessagesToChatMessages,
} from '@langchain/core/messages';
import type { BaseMessage, StoredMessage } from '@langchain/core/messages';

/** 日誌裡的一則訊息。`type` 是 `ai`／`human`／`tool` 這些，`data` 是那一則的欄位。 */
export type LoggedMessage = StoredMessage;

/**
 * 把一則訊息轉成日誌收得下的形狀。
 *
 * @param message - 模型看到的那一則。
 * @returns 純 JSON 的 `StoredMessage`。
 */
export function toLoggedMessage(message: BaseMessage): LoggedMessage {
  const [stored] = mapChatMessagesToStoredMessages([message]);
  return JSON.parse(JSON.stringify(stored)) as LoggedMessage;
}

/**
 * 把日誌裡的一則訊息推回 `BaseMessage`。
 *
 * **先拷一份再推。** 日誌裡的事件是凍過的（`SessionLog` 的 `deepFreeze`），而
 * `mapStoredMessagesToChatMessages` 把 `data` 原樣交給建構子，`AIMessage` 的建構子會回頭改那份欄位
 * （補 `tool_calls`）——實測對凍過的那一則拋 `Cannot assign to read only property 'tool_calls'`。
 * 讀日誌的人拿到的一律是凍過的，所以這一步不是防禦，是每一次都會走到的路。
 *
 * @param logged - 日誌裡記的那一則。
 * @returns 同一則訊息。
 */
export function fromLoggedMessage(logged: LoggedMessage): BaseMessage {
  const [message] = mapStoredMessagesToChatMessages([structuredClone(logged)]);
  return message!;
}
