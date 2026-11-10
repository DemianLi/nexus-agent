---
kind: upgrade-guide
description: "CLI 單機模式在 `--agent-loop native` 下改打串流請求：模型回覆不再被 `timeoutMs`（出廠 180 秒）整段封頂，改由首事件與閒置兩個逾時管。"
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
  - `timeoutMs`（出廠 180000）：連線到回應標頭。
  - `streamIdleTimeoutMs`（出廠 90000）：標頭之後，相鄰兩段位元組之間最多等多久。
  - 舊行為：非串流的端點要生成完才回標頭，`timeoutMs` 實際上就是整段回覆的上限。生成超過 180 秒的回覆會逾時、重打。
  - 新行為：只要端點持續吐位元組，再長也不會逾時。反過來，吐到一半停住超過 `streamIdleTimeoutMs`，會判逾時（`TIMEOUT`）並重打。舊版在標頭之後不計時。
  - 重打仍走 `retryPolicy`，同一份次數。
- **多出串流才有的失敗種類**，跟 serve 今天一樣：
  - 串流中段的錯誤；
  - 閒置逾時；
  - 收到 `finish_reason` 之前串流就結束（`TRANSPORT`）。
- **失敗那次可能多一筆 `model/usage`**：端點吐了用量之後才失敗時，會話日誌多一筆帶 `outcome` 的 `model/usage`，跟 serve 今天一樣。成功的呼叫照舊一筆。
- **CLI 沒有一輪的時鐘上限**：`turn-timeout` 那一列只有 serve 套（見 `docs/operations.md`〈一輪也有時鐘上限〉）。所以升上來之後，CLI 單機下一次模型呼叫的時間只受上面兩格限制。
- 受影響的：
  - 用 CLI 單機模式跑批次、靠「一次回覆最多 `timeoutMs`」估計最壞耗時或收尾的腳本；
  - 數 `model/usage` 筆數當成請求數的工具。

## 遷移

1. 確認用法：CLI 的指令有沒有 `--agent-loop native`、有沒有經 serve。沒帶 `--agent-loop native`，或者走 serve 的，不用往下做。
2. 靠 180 秒（或你設定的 `timeoutMs`）收尾的腳本，要自己在外面加整體時限，例如用 `timeout <秒數> <CLI 指令>` 包住。CLI 裡沒有設定可以把整次回覆再封頂。
3. 想讓吐到一半停住的回覆更快失敗：調 `live-model` 的 `streamIdleTimeoutMs`。想讓連不上的端點更快失敗：調 `timeoutMs`。兩格互不連動，寫法見 `docs/operations.md` 的〈逾時拆兩格〉。
4. 數 `model/usage` 的工具：要算成功的請求數，只數不帶 `outcome` 的那幾筆。
5. 確認改好了：用 `--agent-loop native` 跑一次 CLI 單機，問一句會回很長的話。會話日誌的 `model/usage` 照常寫入，回覆超過 `timeoutMs` 也沒有被切斷。
