---
kind: upgrade-guide
description: "CLI 單機模式在 `--agent-loop native` 下改打串流請求：模型回覆不再被 `timeoutMs`（出廠 180 秒）整段封頂，改由首事件與閒置兩個逾時管；會話日誌的 assistant 訊息與送出的請求改成跟 serve 同形狀。"
---

# CLI 單機模式（native）的模型請求改成串流

## 變更

只影響**不經 serve、直接跑 CLI**，而且帶 `--agent-loop native` 的用法，前景子代理也算在內。下面這些不受影響：
- serve：今天就是串流；
- 背景子代理；
- `langgraph`（沒給 `--agent-loop` 時的預設）。

- **請求改成串流。**
  - 舊行為：CLI 沒有串流 handler，每次模型呼叫都打非串流請求，端點生成完才一次回整段。
  - 新行為：一律打串流請求，請求本文多 `stream: true` 與 `stream_options: {"include_usage": true}`，其他格不變。
- **逾時改由兩格管，沒有總上限。** 兩格都是 `live-model` 那一列的設定，值不變：
  - `timeoutMs`（出廠 180000）：連線到第一則串流事件。
  - `streamIdleTimeoutMs`（出廠 90000）：第一則事件之後，相鄰兩段位元組之間最多等多久；只在有人讀串流時計時。
  - 舊行為：非串流請求的計時器一直跑到讀完整份回覆，`timeoutMs` 實際上就是整段回覆的上限。生成超過 180 秒的回覆會逾時、重打。
  - 新行為：只要端點持續吐位元組，再長也不會逾時。反過來，吐到一半停住超過 `streamIdleTimeoutMs`，會判逾時（`TIMEOUT`）並重打。舊版沒有閒置逾時。
  - 重打仍走 `retryPolicy`，同一份次數。
- **多出串流才有的失敗種類**，跟 serve 今天一樣：
  - 串流中段的錯誤；
  - 閒置逾時；
  - 收到 `finish_reason` 之前串流就結束（`TRANSPORT`）。
- **失敗那次可能多一筆 `model/usage`**：端點吐了用量之後才失敗時，會話日誌多一筆帶 `outcome` 的 `model/usage`，跟 serve 今天一樣。成功的呼叫照舊一筆。
- **會話日誌的 `assistant/message` 改成跟 serve 同形狀。** 日誌格式版本不變；舊版寫下的日誌照樣讀得回來，`--resume` 續接也照常。
  - `content`：舊行為是字串；新行為是 v1 區塊陣列（推理、文字、工具呼叫各一塊），另多一格 `content_blocks`。
  - 推理：舊行為在 `additional_kwargs.reasoning_content`；新行為在 `content` 的 `reasoning` 區塊，`additional_kwargs` 不再有這一格。
  - `response_metadata`：
    - 沒了 `tokenUsage` 與端點原始的 `usage`；
    - 多了 `output_version: "v1"`；
    - `finish_reason` 照 LangChain 的 v1 對應記：`tool_calls`（與 `function_call`）記成 `tool_use`，`max_tokens` 記成 `length`，`stop`、`length`、`content_filter` 不變，其他值記成 `stop`。
  - `usage_metadata`：數字不變，沒有快取細節時不再帶空的 `input_token_details: {}`。
- **送給端點的請求裡，前一則 assistant 的文字改成 text 區塊。** 舊行為是 `"content": "我來讀"`；新行為是 `"content": [{"type": "text", "text": "我來讀"}]`，跟 serve 今天送的相同。推理照舊不回送。從舊日誌續接的那幾則照舊送字串。
- **CLI 沒有一輪的時鐘上限**：`turn-timeout` 那一列只有 serve 套（見 `docs/operations.md`〈一輪也有時鐘上限〉）。所以升上來之後，CLI 單機下一次模型呼叫的時間只受上面兩格限制。
- 受影響的：
  - 用 CLI 單機模式跑批次、靠「一次回覆最多 `timeoutMs`」估計最壞耗時或收尾的腳本；
  - 數 `model/usage` 筆數當成請求數的工具；
  - 直接讀會話日誌 `assistant/message` 的腳本；
  - 只收字串 `content` 的 assistant 訊息、不認 text 區塊的 OpenAI 相容端點。

## 遷移

1. 確認用法：CLI 的指令有沒有 `--agent-loop native`、有沒有經 serve。沒帶 `--agent-loop native`，或者走 serve 的，不用往下做。
2. 靠 180 秒（或你設定的 `timeoutMs`）收尾的腳本，要自己在外面加整體時限，例如用 `timeout <秒數> <CLI 指令>` 包住。CLI 裡沒有設定可以把整次回覆再封頂。
3. 想讓吐到一半停住的回覆更快失敗：調 `live-model` 的 `streamIdleTimeoutMs`。想讓連不上的端點更快失敗：調 `timeoutMs`。兩格互不連動，寫法見 `docs/operations.md` 的〈逾時拆兩格〉。
4. 數 `model/usage` 的工具：要算成功的請求數，只數不帶 `outcome` 的那幾筆。
5. 直接讀 `sessions/` 底下會話日誌的腳本：
   - 文字改從 `content` 的 `text` 區塊拼（字串照舊也要收，舊日誌是字串）；
   - 推理改從 `reasoning` 區塊讀，同時保留讀 `additional_kwargs.reasoning_content` 的舊路；
   - 用量改讀 `usage_metadata`（或 `model/usage` 事件），不要讀 `response_metadata.tokenUsage` 或 `response_metadata.usage`；
   - 判斷要不要呼叫工具，`finish_reason` 要同時認 `tool_calls` 與 `tool_use`。
6. 自架的 OpenAI 相容端點：確認它收得下 assistant 訊息的 `content` 是 text 區塊陣列。serve 今天就是這樣送，serve 正常的端點不用改。
7. 確認改好了：用 `--agent-loop native` 跑一次 CLI 單機，問一句會回很長的話。會話日誌的 `model/usage` 照常寫入，回覆超過 `timeoutMs` 也沒有被切斷；讀日誌的腳本讀得出那一輪 `assistant/message` 的文字、推理與用量。
