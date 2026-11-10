---
kind: upgrade-guide
description: "`llm/stream` 的 `next()` 改回 chunk 串流、不再回整則 AI 訊息；監聽者要改成逐顆轉交，短路時自己 yield 的也要是 chunk。"
---

# `llm/stream` 改成環繞串流

## 變更

只影響用 `--agent-loop native` 跑的 serve 與 CLI。`langgraph`（沒給 `--agent-loop` 時的預設）不派 `llm/stream`，跟以前一樣。

- **`next()` 回的東西變了。**
  - 舊行為：`next: () => Promise<unknown>`。`next()` 打模型，回一整則 AI 訊息；監聽者回的值就是這一步的 AI 訊息。
  - 新行為：`next: () => AsyncIterable<ModelStreamChunk>`。`next()` 回這次請求的 chunk 串流，監聽者也要回一個 `AsyncIterable<ModelStreamChunk>`。
  - `ModelStreamChunk` 從 `@nexus/core` 匯出，形狀照 OpenAI Chat Completions 的串流 chunk，只列監聽者會讀的格：
    - `id`、`model`；
    - `choices[].index`、`choices[].delta`（`role`、`content`、`reasoning_content`、`tool_calls`）、`choices[].finish_reason`；
    - `usage`。

    端點送什麼，監聽者就看到什麼，中間不翻譯。
- **監聽者不能是回 Promise 的 `async` 函式。** 要寫成 `async function*`，或不帶 `async`、直接回 `next()`。舊寫法 `async (payload, next) => …` 回的是 Promise，這次模型呼叫會拋 `TypeError`，訊息寫明「回 Promise 的 async 函式不行」。有兩位以上的監聽者時，內層回 Promise 也可能讓外層在迭代 `next()` 時拋 JS 自己的 `TypeError`（外層用 `for await` 時是 `… is not async iterable`，用 `yield*` 時是 `undefined is not a function`），一樣是這個原因。
- **派發的時機與次數不變**：每一次模型呼叫派一次，root 與子代理都派；`agent/request-error` 回 `retry` 再打的那一次另外再派一次。payload 不變：`threadId`、`step`、`signal`。
- **`next()` 改成在 native 下一律打串流請求。** 以前 CLI 單機模式沒有串流 handler 時打的是非串流請求，現在也一樣經過 `next()` 交出 chunk。
- **短路**：不呼叫或不迭代 `next()`、自己 yield chunk，請求就不會送出。但這一步的 `request/*` 快照與 `model/start` 在派 `llm/stream` 之前就寫進會話日誌了。所以日誌裡會有一次「開了頭、但端點沒收到」的模型呼叫；你 yield 的 chunk 帶了 `usage`，用量就照它記。
- **沒有接上 `llm/stream` 的模型會拋錯。** native 下，模型要從這次呼叫 config 的 `configurable["__nexus_llm_stream"]`（`@nexus/core` 匯出成 `LLM_STREAM_CONFIG_KEY`）取出環繞函式，用它包住自己打端點的串流。沒有這樣做的模型，這次呼叫會失敗，訊息開頭是「native agent loop：模型 <類別名> 沒有接上 llm/stream」，後面寫明要怎麼接。出廠的模型都已經這樣做；只有自己帶模型進 native 的插件才會碰到。
- 受影響的：經 `registry.events.on('llm/stream', …)` 登記監聽者的插件；在 native 下用自己的 `BaseChatModel` 的插件或嵌入方。
- 不受影響的：跑 `langgraph` 的主機；出廠的插件（都沒有 `llm/stream` 的監聽者）。

## 遷移

1. 確認主機跑的是哪個 loop：看 `serve` 或 CLI 的啟動參數有沒有 `--agent-loop native`。沒有就不用往下做。
2. 找出監聽者：`grep -rn "events\.on('llm/stream'" <插件原始碼目錄>`。
3. 只觀察、不改內容的監聽者，從等一整則訊息改成逐顆轉交。

   改前：

   ```ts
   registry.events.on('llm/stream', async (payload, next) => {
     const started = Date.now();
     const message = await next();
     audit(payload.threadId, Date.now() - started);
     return message;
   });
   ```

   改後：

   ```ts
   registry.events.on('llm/stream', async function* (payload, next) {
     const started = Date.now();
     for await (const chunk of next()) yield chunk;
     audit(payload.threadId, Date.now() - started);
   });
   ```

   函式要寫成 `async function*`，不要寫成 `async (payload, next) => …`：後者回 Promise，會拋 `TypeError`。`next()` 只能呼叫一次。要在串流結束時做事，放在 `for await` 之後；要在失敗時做事，用 `try`／`finally` 包住迴圈。
4. 短路的監聽者（重放、快取），改成 yield chunk，不要回 AI 訊息。至少要有：
   - 帶內容的 chunk：`choices: [{ index: 0, delta: { role: 'assistant', content: '…' }, finish_reason: null }]`；
   - 最後一顆帶 `finish_reason`（`stop`，或有工具呼叫時的 `tool_calls`）；
   - 要記用量，就在最後一顆帶 `usage`。

   工具呼叫放 `delta.tool_calls`，格式同 Chat Completions 的串流：每一顆帶 `index`，第一顆帶 `id` 與 `function.name`，`function.arguments` 可以分段。
5. 短路時日誌會留下沒送出的那一次呼叫（`request/*` 與 `model/start`）。依日誌計算請求數或成本的工具，不要用 `model/start` 的筆數；改數不帶 `outcome` 的 `model/usage`，並記得短路監聽者 yield 了 `usage` 的那幾筆不是端點收到的請求。
6. 自己帶 `BaseChatModel` 進 native 的：環繞函式在 `invoke` 收到的 config 的 `configurable[LLM_STREAM_CONFIG_KEY]`，型別是 `ModelStreamAround`。在 `invoke` 取出它，打端點時把「送請求、回 chunk 串流」包成 `next` 交給它，改讀它回的那一條串流。它回的就是串流，不要 `await`；回的不是 `AsyncIterable` 時拋 `TypeError`，當成監聽者寫錯。不這樣做，這個模型在 native 下每次呼叫都會拋錯。
7. 確認改好了：用 `--agent-loop native` 開一條新會話送一句，回覆照常出現；監聽者被叫到，次數等於這一輪的模型呼叫數，包括子代理的。
