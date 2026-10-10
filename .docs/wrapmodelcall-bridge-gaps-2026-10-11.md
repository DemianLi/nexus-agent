# `wrapModelCall` 橋接成模型呼叫三事件的語意落差（#1341）

地圖 [#1339](https://github.com/DemianLi/nexus-agent/issues/1339)（S2）的第二張研究卡，回答草稿
[`event-contract-design-draft-2026-10-08.md`](event-contract-design-draft-2026-10-08.md) §五 指名「要先驗」的那一題：
LangChain 的 `wrapModelCall` 不是串流包裝，dsh 的 `llm/stream` 是。**只有量測與結論，不落地任何事件**。

## 一句話結論

**三個事件塞不進同一顆 `wrapModelCall` middleware。** 量出來它們各自要住在洋蔥的不同位置：

| dsh 事件 | 在 nexus 要住哪 | 為什麼 |
| --- | --- | --- |
| `agent/request` | middleware 層，`modelSelection` 那一格或更外 | 它決定後面每一格讀到的 `request.model`；能換的只有 model 實例，`modelSettings` 的詞彙不含 `max_tokens`／`temperature`／推理強度 |
| `agent/request-error` | middleware 層，`streamRetry` 那一格（起訖紀錄器**外面**） | 放在裡面，失敗那次沒有 `model/end(error)`、沒有 `assistant/attempt`、畫面不擦；放在外面才對得上日誌 |
| `llm/stream` | **model 層**（`_streamChatModelEvents` 的子類，先例 `attachment-chat-openai.ts`） | `wrapModelCall` 只拿得到整則 `AIMessage`，串流在 callback 旁路上；middleware 層取代、變形串流都會讓「畫面」與「日誌／模型看到的」分叉 |

**`llm/stream` 一定要在 model 層，另外兩個在 middleware 層、位置不同，所以不是「一顆橋接 middleware」。** 這不是 LangChain 整體表達不出來——model 層表達得出來，而且 repo
裡已經有同一個接縫的先例；只是那個接縫不在 `wrapModelCall` 上。

另外三件事（不是橋接的問題，但 S2 動手前會撞到）：

- **重試有四種，分在洋蔥的四個位置，記帳各不相同**（§四）；dsh 把它們放在同一條 `agent/request-error` waterfall 上，記帳只有一種。
- **`streamRetry` 私有的 `STREAM_RETRY_SIGNAL` 是畫面擦除的唯一觸發**；任何不經過它的重打都會在畫面上留下半段字（§三 G3）。
- **「模型看得到的」有沒有記下來**，不能只看 `model/end` 配對：短路在外層時配對全是 0 懸空，第二句的請求卻帶著一則日誌上沒有的助手訊息（§三 G2）。

## 方法與可信度

- **拋棄式原型**：一個 40 行的 waterfall 匯流排（照 dsh `events.ts:234-243`：監聽者由外而內，不叫 `next()` 就是取代），加兩種橋接——
  **A**＝`wrapModelCall` middleware（以 plugin 掛，`prepend` 與預設兩個位置各量）；**B**＝`ChatOpenAI` 子類，覆寫 `_streamChatModelEvents`
  （web 的 v3 串流實際走的那一條）。原型全文在 [`wrapmodelcall-bridge-prototype-2026-10-11.md`](wrapmodelcall-bridge-prototype-2026-10-11.md)。
- **走的是產品路徑**：假 SSE 端點 → `createLiveModel`（真的 fetch 疊層、真的 `AsyncCaller`）→ `createNexusAgent`（真的 middleware 疊）→
  `ThreadPump`（日誌、`message-discard`）→ `@nexus/wire` 折疊器。每個實驗同時量**日誌**、**線上 frame（畫面）**、**打到端點的請求本文**。
- **基準**：develop `58c69808`；`@langchain/openai@1.5.10`、`langchain@1.5.10`、`@langchain/core@1.2.9`。dsh `d7432673886`。
- **16 個實驗全部可重跑**，每一列的 `-t` 名稱見下表；結果 JSON 每個實驗一個鍵。
- **沒量**（卡上也寫了不做）：live A/B、真供應商的 SSE 分塊、真模型。**也沒量**：子代理與背景子代理（它們走同一疊，但沒單獨跑）、
  CLI 的真實入口（P9 用的是裸 `agent.invoke`）、摘要器的溢出重打與 `imageOffloadRecovery` 在橋接下的行為（只讀碼，§四）。
- 「讀碼」與「量到」在每一列分開標。

## 一、nexus 今天的洋蔥（外 → 內，與模型呼叫有關的）

來源 `packages/nexus-core/src/fold.ts` 的槽位表；dsh 對應物見 §二。

| 序 | 槽 | 行 | 備註 |
| --- | --- | --- | --- |
| 0 | 摘要器（同名取代基座那顆，落在基座原位） | — | **在所有自家槽外面**，含 `modelSelection`、`streamRetry`、起訖（`model-calls.ts` 檔頭；F1，[#1354](https://github.com/DemianLi/nexus-agent/issues/1354)）。溢出時先摘要再叫一次內層，日誌算兩步（登記的偏離） |
| 1 | `modelSelection`（換 model 實例） | 621 | `agent/request` 的對應物：`handler({ ...request, model: instance })`（`model-selection.ts:236`） |
| 2 | `imageOffload` | — | 只把已下的決定標在請求上 |
| 3 | `plugins.prepended` | 677 | **A 的 `prepend` 位置**：在 `streamRetry`、起訖外面 |
| 4 | `streamRetry` | 711 | 串流第一則事件**之後**才出錯的整次重打（#520）；每次嘗試各是一對起訖 |
| 5 | `modelCalls`／`modelUsage` | 712／713 | `model/start`、`assistant/message`、`model/end`；`model/usage` |
| 6 | `plugins.rest` | 719 | **A 的預設位置**：在起訖裡面、`streamRetry` 裡面 |
| 7 | `maxTokens` | 749 | 撞輸出上限時清掉工具呼叫 |
| 8 | `imageOffloadRecovery` | — | 接 `IMAGE_OFFLOAD_REQUIRED`、下決定、再送；失敗那次不算一次呼叫 |
| 9 | `requestSnapshot`／`turnCancelModelSignal` | 763／765 | 最內層 |
| — | model 本體：fetch 疊（用量回報／空助手內容／串流內錯誤／閒置逾時）＋SDK `AsyncCaller`（`maxRetries` 預設 6，`live-model.ts:166`） | | 失敗在這裡被分類、回報 |

## 二、先校正：dsh 的實際形狀與卡上、草稿的描述有四處不同

這四點決定了「落差」怎麼讀；每一點都是讀 `d7432673886` 的原始碼，不是記憶。

1. **失敗是串流內的收尾值，不是例外。** `llm.stream()` 把 adapter 的拋出轉成 `finish{kind:'error'|'aborted'}` 片段（`adapterFailureChunk`，
   `packages/llm/llm/src/index.ts`）；迴圈讀到這種收尾才派 `agent/request-error`（`packages/core/agent-loop/src/agent.ts:508-512`，`assistant/attempt` 在 508、派發在 512）。
2. **重試不在 `llm/stream` 上。** `llm/stream` 的 JSDoc 寫「retry, replay, routing」，但整個 repo 裡 `llm/stream` 的實際監聽者只有
   `session-title`（`index.ts:374`）與 `session-checkpoint-policy`（`index.ts:64`）。重試是 `agent/request-error` 的監聽者
   （`packages/llm/llm-retry/src/index.ts:243`），回 `{ kind: 'retry' }`，迴圈 `continue`（同一步，失敗那次先記成 `assistant/attempt`，`agent.ts:508-523`）。
3. **`agent/request-error` 有三個監聽者，不是一個**：`llm-retry`（退避、記 `llm/retry`）、`compaction-basic`（`CONTEXT_WINDOW_EXCEEDED` → 先壓縮再重打，
   `index.ts:190`，自己一份 `overflowRetries` 預算，成功回覆時清零）、`compaction-image-offload`（`IMAGE_OFFLOAD_REQUIRED` → 持久地搬圖再重打，`index.ts:27`，
   原話「spends no retry budget and logs no retry event」）。三者靠 waterfall 的 `next()` 串起來。
4. **dsh 的 SDK 層不重試**：`maxRetries: 0`（`packages/llm/llm-pi-ai/src/adapter.ts:141`，註解「The agent recovery layer owns visible attempts」）。
   重試只有一層。可重試碼集合是 `EMPTY_RESPONSE`／`RATE_LIMIT`／`SERVER`／`TIMEOUT`／`TRANSPORT`（`packages/llm/llm/src/retry-policy.ts:18-24`），
   **首事件逾時與閒置逾時都是 `TIMEOUT` 一碼**。

另外兩點與橋接直接相關：`max-tokens` 在 dsh 是 `finish` 的一種（`kind: 'max-tokens'`），工具呼叫由組訊息的 assembler 丟掉
（`packages/llm/llm/src/assembler.ts:135-140`，引自 `max-tokens.ts` 檔頭），listener 看到的是原始片段；dsh 的摘要也走 `ctx.llm.stream()`
（`compaction-basic` `summarize`），所以**摘要呼叫也會經過 `llm/stream` 監聽者**。

## 三、落差表（每列：觀察、dsh 同情境怎樣、最小重現、算不算 LangChain 表達不出來）

「A」＝`wrapModelCall` middleware 橋接；「B」＝model 層子類橋接。「日誌」「畫面」「線上請求」是三個獨立的量測面。`-t` 後面接測試名前綴。

### G1 串流：A 看得到的只有整則，變形只改得到日誌

| | 觀察（量到） |
| --- | --- |
| 穿透（P1，`-t "P0"`） | A、B 與無橋接基準三者：日誌事件序列相同、畫面 frame 計數相同（4 個 `content-block-delta`）、顯示文字相同。**穿透不變形。** |
| 變形（P4，`-t "P4"`） | 監聽者把回覆換成「變形」：**A**——畫面逐字顯示原片段「甲乙丙丁」，日誌與第二句請求帶出去的歷史都是「變形」（P11）。**B**——把每個文字 delta 包成 `<…>` 並同步改 `content-block-finish` 的累積文字：畫面與日誌同為 `<甲><乙><丙><丁>`。 |

dsh 同情境：`llm/stream` 監聽者可以改任何片段，迴圈用的就是改過的片段組出訊息並餵給畫面（`for await (const chunk of stream) live.push(chunk)`）。**畫面與日誌天生同源。**
**LangChain**：middleware 這一格表達不出來（`handler` 回 `Promise<AIMessage>`，delta 走 callback 旁路）；model 層表達得出來。
**注意一個細節**：LangChain 的事件協議在 `content-block-finish` 裡重複帶累積文字，變形監聽者要自己維持兩者一致（B 的原型做了）；dsh 的 assembler 是從片段組，沒有這個問題。

### G2 取代（不叫 `next()`）：位置決定記了什麼，外層取代會讓模型看到沒記的東西

| 位置（P3，`-t "P3"`；P11，`-t "P11"`） | 日誌 | 畫面 | 打到端點 | 第二句請求帶出去的助手歷史 |
| --- | --- | --- | --- | --- |
| A 預設位置（起訖裡面） | `model/start`、`assistant/message`、`model/end(ok)`，**沒有 `model/usage`** | **沒有任何 `messages` frame**（只有 lifecycle／custom），回覆在畫面上不存在 | 0 次 | 「罐頭回覆」，與日誌一致 |
| A `prepend`（起訖外面） | **只有 `turn/end`**：沒有 start／end／`assistant/message` | 同上，沒有 messages frame | 0 次 | 「罐頭回覆」——**日誌上沒有這一則，模型看得到** |
| B（model 層，重播真事件換字） | 完整的一組，`model/usage` 隨重播的 usage 事件 | 4 個 delta，顯示「罐頭回覆」 | 0 次 | 沒跑第二句；畫面與日誌的文字一致（P3） |

- **`Z_pairing` 的 `dangling` 全為 0 也不代表沒事**：`prepend` 那列沒有任何 `model/start`，沒東西可懸空。判準要問「第二句請求帶的歷史，每一則助手訊息日誌上有沒有」（P11）。
- 原因是 A 回的 `AIMessage` 直接進 graph state，`assistant/message` 只由 `modelCalls` 在 `handler` 回來之後寫；它在外面就整個被繞過。
- 畫面上沒有 `messages` frame：`pump` 讀的是 LLM run 的 callback 串流，沒有 LLM run 就沒有這個通道。

dsh 同情境：取代的監聽者自己產片段，迴圈照常 `session.append('assistant/message')`；沒有「model 看得到但沒記」的路徑（`agent.ts` 的 `model-visible ⟺ logged`）。
**LangChain**：middleware 這一格表達不出來「取代但仍記錄＋仍上畫面」；model 層表達得出來。

### G3 重試歸屬：不經過 `streamRetry` 的重打，畫面留下半段字、日誌沒有那次失敗

腳本 `mid503, ok`（串流吐兩個字後送 503，再來一次成功）：

| 誰重打（P5b／P5c／P5d，`-t "P5b"`、`"P5c"`、`"P5d"`） | 打到端點 | 日誌 | 畫面 |
| --- | --- | --- | --- |
| 只有 `streamRetry`（基準） | 2 | 兩對起訖，第一對 `model/end(error)`，`llm/retry`、`assistant/attempt`、`llm/retry-started` | 一則「甲乙丙丁」，半段被擦掉 |
| A 預設位置，`request-error` 監聽者回 retry（**`streamRetry` 開著也一樣**） | 2 | **一對起訖**、無 `llm/retry`、無 `assistant/attempt`、`streamRetry` 沒被叫到 | 兩則：「甲乙」殘留＋「甲乙丙丁」 |
| A `prepend`（起訖與 `streamRetry` 外面） | 2 | 兩對起訖，第一對 `model/end(error)`；**無 `assistant/attempt`、無 `llm/retry`** | 兩則：「甲乙」殘留＋「甲乙丙丁」 |
| A `prepend` ＋ `streamRetry`（預算 2），腳本三次失敗再成功 | 4 | 四對起訖；`streamRetry` 那兩次有 `assistant/attempt`，**bridge 接手的第三次沒有** | 前兩次的半段擦掉，第三次的「甲乙」殘留 |
| B 的 `llm/stream` 監聽者自己抓錯再叫 `next()` | 2 | 一對起訖 | 一則「甲乙甲乙丙丁」（delta 接在同一則上）＋一則「甲乙丙丁」 |

- **擦除的唯一觸發是 `streamRetry` 用 `config.writer` 送的 `STREAM_RETRY_SIGNAL`**（`stream-retry.ts` 檔頭）。其他重打者要嘛重做這一整套（signal、
  `llm/retry` 兩顆、`assistant/attempt`），要嘛在畫面上留殘影。
- **B 的 P5c 要如實讀**：dsh 同情境也會把兩次的片段接成一串——`llm/stream` 裡自己重打，迴圈照樣把兩次的片段 `live.push` 在一起，**這就是 dsh 把重試放在
  `agent/request-error` 的原因**（§二 2）。所以這一列不是 LangChain 的落差，是「重試放錯層」，**兩邊相同**。
- 「A 預設位置」的失敗那次**連 `model/end(error)` 都沒有**：失敗的呼叫在 `modelCalls` 裡面被吞掉了，日誌上只有一對起訖。

dsh 同情境：失敗那次一律先記 `assistant/attempt` 再派 `request-error`，畫面由迴圈的 `live.settle` 收掉。
**LangChain**：表達得出來——只要把「擁有重試的那一格」放在 `streamRetry` 的位置，並承接它的 signal 與記帳。這是搬家，不是偏離。

### G4 重試相乘，而且日誌少報

腳本全是 HTTP 503（第一則事件之前，歸 SDK 層；`-t "P5 重試層疊"`），SDK 重試 2 次：

| | 打到端點 | `llm/retry` 顆數 |
| --- | --- | --- |
| 只有 SDK | 3 | 2 |
| SDK ＋ A 預設位置的 `request-error` retry（上限 2） | **9**（3 × 3） | **2** |

- 第 4–9 次請求在日誌上完全沒有痕跡：`llm-retry.ts` 的範圍是**整次模型呼叫**（`runInRetryScope`），`noteFailedAttempt` 對 `scope.retries` 累加，超過
  `maxRetries` 之後被當成預算用盡、不寫（`llm-retry.ts` `noteFailedAttempt`）。外層再重打時計數沒有歸零，後面的失敗全被吞——**這是讀碼推出來的機制，數字（2 顆）與它吻合，沒有另外隔離驗證。**
- 這是**算得出來、量到了一組**；**正式環境的乘數沒量**：SDK 6 次（`live-model.ts:166`）、`streamRetry` 3 次嘗試（第一次＋2 次重打，卡上 2026-10-06 拍板）、
  再乘 `request-error` 允許的次數，最壞是三者的乘積，每次嘗試的 `llm/retry` 只記到 SDK 預算那一段。
- dsh 的單層（SDK `maxRetries: 0`）沒有這個問題；`DEFAULT_LIVE_MAX_RETRIES = 6` 是 nexus 的設定，不是 LangChain 的限制（`live-model.ts:147-166` 解釋了當初的理由）。

### G5 中止：配對不變形，但橋接要先檢查中止

| （P6／P6b／P6c，`-t "P6"`） | 觀察 |
| --- | --- |
| A、B 穿透，串流中按停止 | 日誌與基準相同：`model/start`、`model/end(aborted)`、被打斷的半段記成 `assistant/message`、`turn/end(aborted)`。B 的監聽者那邊看到的是產生器被 `return`（`finally` 跑、沒有「完成」）。 |
| A 的 `request-error` 監聽者 | 第一版原型沒擋，**中止時也被派**（`TurnCancelledError`）。照 dsh（串流之後先 `signal.throwIfAborted()`，`agent.ts:461`）先檢查 `signal.aborted` 之後 0 次（dsh 在讀完串流之後、進收尾分支之前就 `signal.throwIfAborted()`，`agent.ts:461`，所以使用者按停止時走不到派發）。 |

dsh 同情境：中止不派 `request-error`。所以「中止時也派」是**原型缺陷**，不是 LangChain 的落差；橋接要自己做這個檢查。

### G6 逾時拆分：分類沒變形，兩種逾時在 `request-error` 裡都是 `TIMEOUT`

| （P7，`-t "P7"`） | 錯誤名 | `classifyLlmFailure` |
| --- | --- | --- |
| 連線後掛住（SDK `timeout`） | `TimeoutError` | `code: TIMEOUT` |
| 吐了字之後停住（閒置） | `StreamIdleTimeoutError` | `code: TIMEOUT` |

- 橋接收到的是拋出的錯誤；用 `classifyLlmFailure` 就拿得到 dsh 同形的 `{code, message, status?}`。**要分首事件／閒置，只能看錯誤名**，與 dsh 同（只有 `TIMEOUT` 一碼）。
- `streamRetry` 靠的 `StreamFailure.retryable`（fetch 層回報進這次嘗試的範圍）**不在這個 payload 裡**：橋接 listener 看不到「adapter 判這次重打有沒有用」。
  這是 dsh `retryPolicy` 欄位的對應物，S2 要決定放進 payload 還是讓 `streamRetry` 的判定留在監聽者外。
- **兩套預算（SDK 6 次、串流重打 2 次）是 demian 拍板的**；合成一條政策是要他決定的事，這張卡不替他定。

### G7 `max-tokens`：A 看不到原始的，B 看得到

| （P8／P8b，`-t "P8"`、`"P6b"`） | 監聽者看到 |
| --- | --- |
| A 預設位置（`maxTokens` 外面） | `tool_calls: 0`、`invalid_tool_calls: 0`、`finish_reason: length`——**已經清過** |
| B | `content-block-start(tool_call_chunk)`、對應的 delta、`message-finish(reason: length)`——**原始片段** |

兩者日誌都是 `turn/end(max-tokens)`、`tool/call` 0 顆。B 的形狀與 dsh 相同（listener 看原始片段，assembler 才丟）。A 的位置在 `maxTokens` 外面是 plugin 能放的最內側
（`plugins.last`，`fold.ts:726`）——plugin 放不進 `maxTokens` 裡面，所以 A 永遠看不到被切斷的原始呼叫。**不影響 `max-tokens` 判準本身**（讀 `finish_reason`，A 也看得到）。

### G8 `agent/request` 的設定替換：只有 call option 詞彙裡的鍵到得了線上

`request.modelSettings` 會被展開進 `bindTools` 的選項（`AgentNode.js` 的 `bindTools(model, allTools, { ...options, ...preparedOptions?.modelSettings, tool_choice })`）。
`-t "P10"` 對九組鍵各跑一次、讀打到端點的本文：

| 到得了線上 | 到不了線上 |
| --- | --- |
| `seed`、`stop`、`verbosity` | `max_tokens`、`maxTokens`、`max_completion_tokens`、`temperature`、`reasoning_effort`、`reasoning: {effort}` |

- 原因（讀碼，`@langchain/openai` `chat_models/completions.js` 的 `invocationParams`）：`max_tokens` 取 `this.maxTokens`（第 61 行）、`temperature` 取
  `this.temperature`（第 29 行），都是**建構時**的欄位，不讀 call options；推理強度走 `_getReasoningParams` 的條件，這個假模型名沒進去。
- 所以 dsh `LlmCallConfig`（`provider`、`model`、`reasoningEffort`、`maxTokens`）的逐次替換，**`modelSettings` 表達不了**。**最接近的表達是換實例**——
  `modelSelection` 已經這樣做（`model-selection.ts:236`），不算「表達不出來」，是現成的退法。
- **「不能改訊息」沒有被量到**：dsh 的 `agent/request` 拿到的種子 config 是 `deepFreeze` 過的，原型沒有驗證橋接能不能強制同樣的限制，**不宣稱**。
  `request.messages`、`systemMessage`、`tools` 在 LangChain 是同一個物件上的可改欄位，要不要擋是 S2 設計題（與 [#1340](https://github.com/DemianLi/nexus-agent/issues/1340) W10 同一條）。

### G9 非串流入口：CLI 那條是一個結果，不是串流

| （P9，`-t "P9"`） | 觀察 |
| --- | --- |
| `agent.invoke`，B 的三個入口計數 | `_generate` 1 次、`_streamChatModelEvents` 0 次、`_streamResponseChunks` 0 次；線上請求 `stream: false` |

- B 要涵蓋非串流入口，得包第三個方法，且 `llm/stream` 在這條路上只有**一個元素**。若要「永遠串流」讓兩條路同形，會改線上請求位元組（`stream: false → true`），
  夾具（[#1299](https://github.com/DemianLi/nexus-agent/issues/1299)）比對的就是這個，要另算。
- 注意量的是裸 `agent.invoke`；**CLI 的真實入口有沒有走 `_generate`，沒對 CLI 再確認**。

### G10 B 的涵蓋範圍（讀碼，未實測）

- **model 層的裝飾不能用 `Object.create`**：原型第一版就是這樣做，B 的入口被叫 **0 次**——`ChatOpenAI.withConfig`／`bindTools` 是 `new ChatOpenAI(this.fields)`
  （`@langchain/openai` `chat_models/index.js:606`），裝飾被丟掉。`attachment-chat-openai.ts:72` 已經為同一個原因覆寫 `withConfig`，B 要照做。
- **產品的 root 模型是 `AttachmentChatOpenAI`**（`live-model.ts:1188`；沒有附件來源時是 `new ChatOpenAI(fields)`，1187）：B 不能另開一個平行子類，要在
  `createLiveModel` 這個唯一的建構點接上，換模型、子代理、標題那幾顆實例才會一起走到。這一點沒量。
- **摘要器直接叫模型**（`model-calls.ts` 檔頭：「產摘要的那次呼叫是摘要器直接叫模型，不經過內層」）：A 完全看不到這次呼叫，B 看得到——與 dsh 一致
  （摘要也走 `llm.stream`，`session-checkpoint-policy` 的 `llm/stream` 監聽者因此會看到它）。
- **`session-checkpoint-policy` 是 dsh 自己唯一像樣的 `llm/stream` 監聽者**（`index.ts:64`，`afterCheckpoint` 包住 `next()`）；nexus 的對應物是 `sessionCheckpoint`
  middleware（`fold.ts` 在 `modelUsage` 內側）。可以當 B 的第一個移植案例。

## 四、三題的回答

### 1. 串流、重試、中止、逾時拆分、`max-tokens` 清理各自會不會變形？

| 面向 | A（middleware） | B（model 層） |
| --- | --- | --- |
| 串流（穿透） | 不變形（G1） | 不變形 |
| 串流（變形／取代） | **畫面與日誌分叉**（G1）；取代在外層還會讓模型看到沒記的（G2） | 一致（G1、G2） |
| 重試 | 要擁有 `streamRetry` 的 signal 與記帳，否則殘影、漏記（G3）；與 SDK 層相乘（G4） | 不適合放（dsh 也不放，§二 2） |
| 中止 | 配對不變形；要先檢查 `signal.aborted`（G5） | 不變形（G5） |
| 逾時拆分 | 分類不變形，首事件／閒置只能靠錯誤名（G6） | 同 |
| `max-tokens` | 只看得到清過的（G7） | 看得到原始片段（G7） |

### 2. 事件監聽者能不能做到 dsh 的 waterfall 語意，而不破壞 `model/start`／`model/end`／`model/usage` 的配對與 `modelCall` 識別？

- **穿透與重試（在 `streamRetry` 位置）：配對與識別完好**。`Z_pairing` 總表 39 次執行，`model/end`、`model/usage`、`assistant/message`、`assistant/attempt` 的 `modelCall`
  沒有一顆指向不存在的 `model/start`。
- **取代：只有 B 對**。A 在起訖裡面，日誌有、畫面沒有、少一顆 `model/usage`；A 在起訖外面，日誌整組缺、模型卻看得到（G2）。**取代語意要在 model 層做。**
- 配對判準要加一條：**「第二句請求帶出去的助手訊息，日誌上都有」**，只看 `modelCall` 懸空抓不到最嚴重的那種。

### 3. `agent/request-error` 的 `RequestErrorAction` 與現有的重試各層怎麼並存？

nexus 今天有**四種恢復**，分在洋蔥四個位置，記帳各不相同；dsh 是同一條 waterfall 上的三個監聽者。

| 恢復 | nexus 位置 | 失敗那次怎麼記 | 重試額度 | dsh 對應 |
| --- | --- | --- | --- | --- |
| 供應商 HTTP 錯誤、首事件前的失敗 | model 本體，SDK `AsyncCaller`（預設 6 次） | 同一對起訖之內，`llm/retry`＋`llm/retry-started`（範圍是整次呼叫，G4） | 自己一份 | `llm-retry`（但 SDK 不重試，只有一層） |
| 串流第一則事件之後的失敗 | `streamRetry`（起訖外面，預設 2 次） | **每次嘗試各一對起訖**，失敗那次 `model/end(error)`、`assistant/attempt`；`llm/retry` 帶 `delayMs` | 自己一份 | `llm-retry`（同一個監聽者，不分首事件前後） |
| 上下文溢出 | 摘要器（基座原位，**在 `streamRetry` 與起訖外面**） | 摘要器自己抓 `ContextOverflowError` 再叫內層，**日誌算兩步**（登記的偏離） | 不經 `llm-retry` | `compaction-basic`（`agent/request-error`，自己的 `overflowRetries`） |
| 圖片額度 | `imageOffloadRecovery`（起訖裡面、`maxTokens` 內側） | **不算一次呼叫**、不記 `llm/retry` | 不花額度 | `compaction-image-offload`（同樣「spends no retry budget」） |

並存的方式（**建議，不是決議**）：

1. **擁有 `request-error` 的那一格放在 `streamRetry` 現在的位置**，不是 middleware 洋蔥的任何別處（G3）。它要承接 `streamRetry` 的三件事：`STREAM_RETRY_SIGNAL`、
   `llm/retry` 兩顆、每次嘗試各一對起訖。
2. **後三種恢復變成同一條 waterfall 上的監聽者**，各自回 `{ kind: 'retry' }` 或 `next()`。順序要明定（dsh 靠註冊順序，`prepend`）。
3. **SDK 那層要不要關**（`maxRetries: 0`）是政策題（G4、G6），不是橋接題。留給 demian。
4. `request-error` 的 payload 要帶 `failure`（`classifyLlmFailure` 拿得到）、`signal`，並決定 `streamRetry` 的 `retryable` 怎麼進來（G6）。

### 4. 哪些落差是 LangChain 表達不出來的？（依 AGENTS.md，只有這些准偏離，並要登記退到什麼）

| 落差 | 是 LangChain 的限制嗎 | 退到什麼 |
| --- | --- | --- |
| `llm/stream` 在 `wrapModelCall` 這一格（G1、G2） | **是**：`handler` 回 `Promise<AIMessage>`，delta 在 callback 旁路上 | model 層子類包 `_streamChatModelEvents`；先例 `attachment-chat-openai.ts`。**要登記**。 |
| `llm/stream` 在非串流入口（G9） | **是**：`_generate` 一次回整個 `ChatResult` | 包第三個入口、單元素串流。若要永遠串流，另開卡（改請求位元組）。 |
| `agent/request` 逐次替換 `maxTokens`／`reasoningEffort`／`temperature`（G8） | **是**：不是 call option | 換 model 實例（`modelSelection` 先例）。 |
| in-band 的失敗收尾值（dsh 的 `finish{kind:'error'}`，§二 1） | **是**：LangChain 的失敗是拋出 | 在橋接邊界上把拋出的錯誤轉成 `request-error` payload（`classifyLlmFailure`）；B 的原型沒做轉換，讓例外原樣往外拋。 |
| 重試放在 `llm/stream` 裡（G3 的 B 那列） | **否**：dsh 也會接成一串 | 不是落差。放 `request-error`。 |
| 重試相乘、`llm/retry` 少報（G4） | **否**：nexus 的設定與計數範圍 | 不是落差。 |
| 中止時也派 `request-error`（G5） | **否**：原型缺陷 | 不是落差。 |
| 首事件／閒置逾時同碼（G6） | **否**：與 dsh 相同 | 不是落差。 |

## 五、這張卡沒回答的（S2 開排前要補）

- **真供應商的 SSE 分塊、真模型**：全是假端點。B 在 `_streamChatModelEvents` 上包一層，真實分塊下的背壓與取消沒量。
- **子代理與背景子代理**：同一疊，但沒單獨跑；`subagentOnly` 的槽與 `imageOffloadRecovery` 只折進 root 這件事會影響「誰擁有 `request-error`」。
- **摘要器溢出重打與 `imageOffloadRecovery` 在橋接下的行為**：只讀碼。摘要器在最外面、`streamRetry` 在它裡面：溢出的那次失敗，內層重打與外層摘要誰先接，這個順序問題沒實測。
- **CLI 的真實入口**（G9）。
- **B 的單一建構點**（G10）：換模型、子代理、標題實例是否真的都經過 `createLiveModel`，沒逐一數。
- **`messages` 不可變的強制**（G8）。
- **live A/B**：照卡上寫明不做；S2 落地時模型面行為（工具描述、摘要觸發）仍要過。

## 六、給下一步的

1. **#1342**（`name` 與系統訊息區塊）：這張卡的 G1 顯示，B 在 `_streamChatModelEvents` 上看到的是 LangChain 的事件協議，**不是** `AIMessage`——`name`
   欄位要不要保留，取決於從事件組訊息的那一步由誰做。這題與 B 的設計相依。
2. **S2 的第一刀可以是 B 的最小版**：model 層子類只穿透、只讓 `session-checkpoint-policy` 的對應物搬上去，驗證「所有模型實例都走同一個建構點」。這一刀不改任何行為，
   對照 G10。
3. **`streamRetry` 變成 `request-error` 監聽者的前置**：先把它的三件事（signal、`llm/retry`、每次嘗試一對起訖）整理成可被別的監聽者呼叫的介面，不然四種恢復各自重做一遍。
4. **要 demian 決定**（這張卡不替他定）：SDK 層與串流層兩套預算要不要合成一條政策（G4、G6）。
