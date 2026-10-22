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
 * 而當時寫它的人都把 `append` 的例外吞掉（記不進去不能扳倒模型呼叫；#1665 起回覆這一則改成拋，這一步失敗），結果是日誌上**安靜地少一則**：
 * 從日誌推模型歷史的讀方分不出那是「沒記成」還是「那次沒有回覆」。所以在這裡先壓成 JSON——
 * `undefined` 的 key 消失、形狀照舊，那一條會安靜失敗的路從源頭就不存在。jsonl 落盤時本來就是這樣
 * 序列化的，這一步只是讓記憶體裡那一份與磁碟上那一份提早長成同一個樣子。
 */

import {
  mapChatMessagesToStoredMessages,
  mapStoredMessagesToChatMessages,
} from '@langchain/core/messages';
import type {
  BaseMessage,
  ContentBlock,
  MessageContent,
  StoredMessage,
  StoredMessageData,
} from '@langchain/core/messages';

import {
  SESSION_EVENT_MAX_DEPTH,
  SessionEventDepthError,
  snapshotJsonValue,
} from './session-log.js';

/**
 * 日誌裡的一則訊息。`type` 是 `ai`／`human`／`tool` 這些，`data` 是那一則的欄位。
 *
 * LangChain 的 `StoredMessageData.content` 宣告是 `string`，但實際落盤時會是區塊陣列。
 * 改正型別為實際形狀：`MessageContent`（`string | ContentBlock[]`），讀方透過 {@link loggedContentBlocks}
 * 拿到型別化的區塊陣列（字串也轉成單塊 text）。
 *
 * `role`、`name`、`tool_call_id` 同理：LangChain 宣告成必填的 `string | undefined`，但 {@link toLoggedMessage}
 * 落盤前做一次 JSON 往返，值是 `undefined` 的鍵在那一步就消失，日誌上它們是**選填的字串**。型別照實際形狀寫，
 * 持久化型別圖（`apps/harness/src/persistence-schema.ts`，#1856）才表示得出來——必填卻可以是 `undefined` 的欄位不是 JSON。
 */
export interface LoggedMessage {
  readonly type: string;
  readonly data: Omit<StoredMessageData, 'content' | 'role' | 'name' | 'tool_call_id'> & {
    readonly content: MessageContent;
    readonly role?: string;
    readonly name?: string;
    readonly tool_call_id?: string;
  };
}

/** {@link toLoggedMessage} 在交給 `toDict()` 之前先量的門檻：日誌上限的兩倍（理由見那裡）。 */
const PRECHECK_DEPTH = SESSION_EVENT_MAX_DEPTH * 2;

/**
 * `value` 巢狀的物件與陣列有沒有超過 `limit` 層（根是容器的話算第 1 層，純量不算）。迭代走訪，超過就停。
 *
 * 走的是自有、可列舉的值。同一顆物件只走一次：`BaseMessage` 的 `lc_kwargs` 跟欄位指到同一份，繞回自己的也不會走不完。
 * 只走一次可能少算從較深那條路到它的層數，所以這裡只會**少報**、不會多報。
 */
function nestingExceeds(value: unknown, limit: number): boolean {
  const seen = new Set<object>();
  const stack: [unknown, number][] = [[value, 1]];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const [current, depth] = item;
    if (current === null || typeof current !== 'object' || seen.has(current)) continue;
    if (depth > limit) return true;
    seen.add(current);
    for (const child of Object.values(current)) stack.push([child, depth + 1]);
  }
  return false;
}

/**
 * 把一則訊息轉成日誌收得下的形狀。
 *
 * **太深的先拒**（[#1668](https://github.com/DemianLi/nexus-agent/issues/1668)）：`toDict()` 一路的 `escapeIfNeeded`
 * （`@langchain/core@1.2.9` 的 `load/validation.js`）與下面那一次 `JSON.stringify` 都是遞迴的，交錯巢狀幾千層就
 * `Maximum call stack size exceeded`——輪不到 `SessionLog.append` 那一關的層數檢查，回合失敗只剩一顆認不出來的 `RangeError`。
 * 實測（macOS、Node 25.9.0、真的 `serve`）同台模型回 6000 層前後的工具參數就是這樣，邊界隨堆疊大小變。所以先迭代量訊息本身，
 * 超過 {@link PRECHECK_DEPTH} 就拋跟日誌那一關同一種 {@link SessionEventDepthError}。
 *
 * **門檻不是上限本身**：這裡量的是 `BaseMessage` 物件，跟日誌裡那一份的形狀不同，層數對不齊；取上限本身的話，日誌那一關會拒的訊息
 * 改由這裡拒，錯誤訊息就少了事件種類、路徑與層數（core 的 `containment`、`model-calls` 測試釘著那一句）。取上限的兩倍：
 * 比它淺的照舊走 `toDict()` 再由日誌那一關拒（幾千層才爆，這段沒有風險），只有更深的在這裡先拒。
 * 超過兩倍的訊息包進事件後一定也超過上限，所以這一步**不改變哪些訊息記得進去**。
 *
 * **與 dsh 的偏離（理由 1）**：dsh 的訊息走自己的迭代快照，沒有這一步。我們記的是 LangChain 的 `BaseMessage`，轉成純 JSON 只能
 * 經基座那一組遞迴的 `toDict()`（見檔頭），退到在交給它之前先量。
 *
 * @param message - 模型看到的那一則。
 * @returns 純 JSON 的 `StoredMessage`。
 * @throws {SessionEventDepthError} 訊息本身巢狀超過 {@link PRECHECK_DEPTH} 層。
 */
export function toLoggedMessage(message: BaseMessage): LoggedMessage {
  if (nestingExceeds(message, PRECHECK_DEPTH)) {
    throw new SessionEventDepthError(
      `要記的訊息巢狀超過 ${PRECHECK_DEPTH} 層，日誌收不下（上限 ${SESSION_EVENT_MAX_DEPTH} 層；轉成日誌的形狀之前就先拒）`,
    );
  }
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
 * **拷法用日誌自己那支迭代快照（{@link snapshotJsonValue}），不用 `structuredClone`**：V8 的 `structuredClone` 是遞迴的，
 * 物件與陣列交錯兩千層上下就 `RangeError`，而日誌收得下更深的（#1526）。續接時每一則訊息都經過這裡，
 * 一則推不回來，整條 thread 就建不起來。
 *
 * @param logged - 日誌裡記的那一則。
 * @returns 同一則訊息。
 */
export function fromLoggedMessage(logged: LoggedMessage): BaseMessage {
  // LangChain 的 StoredMessageData.content 宣告是 string，但我們落盤的是 string | ContentBlock[]。
  // mapStoredMessagesToChatMessages 預期 StoredMessage，所以轉型回去。
  const copy = snapshotJsonValue(logged, '日誌訊息') as StoredMessage;
  const [message] = mapStoredMessagesToChatMessages([copy]);
  return message!;
}

/**
 * 把日誌訊息的內容轉成型別化的區塊陣列。
 *
 * 讀方透過它拿到寬度統一的區塊陣列，各自的讀法政策（取 text、取 reasoning、判斷有沒有內容）
 * 就是在型別化的區塊上操作，不用再檢查形狀。
 *
 * - 字串 → 一塊 `{ type: 'text', text }`（空字串也是一塊，不是空陣列）。
 * - 區塊陣列 → 原樣回傳，只收窄型別。
 * - 其他（undefined、null、一般物件） → 空陣列。
 *
 * @param content - 日誌訊息的 `data.content`。
 * @returns 區塊陣列。
 */
export function loggedContentBlocks(content: unknown): readonly ContentBlock[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  if (Array.isArray(content)) {
    return content as readonly ContentBlock[];
  }
  return [];
}

/**
 * 一顆 `assistant/message` 記的訊息 id；沒記的是 `undefined`。
 *
 * @param message - 日誌裡的訊息。
 * @returns 訊息的 id（如果有且非空）。
 */
export function loggedMessageId(message: LoggedMessage): string | undefined {
  const id: unknown = message.data.id;
  return typeof id === 'string' && id !== '' ? id : undefined;
}
