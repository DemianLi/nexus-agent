---
kind: upgrade-guide
description: live-model 那一列改了形狀，v0.5.19 寫的 maxOutputTokens、maxRetries 被拒收，換過的 modelId 要先進 models 型錄，否則 --live 起不來；不送 finish_reason 的端點每一輪都會失敗。
---

# `live-model` 設定改形狀

## 變更

v0.5.19 的 `live-model` 那一列是五格：`baseUrl`、`modelId`、`maxOutputTokens`（16384）、`timeoutMs`（90000，管整個請求）、
`maxRetries`（6）。新版（PR #805、#1256、#1436）：

- **`maxOutputTokens` 拿掉**，輸出上限改寫在模型型錄 `models[].maxTokens`。這一列是 `strictObject`，多寫一格就驗不過。
- **`modelId` 必須在 `models` 型錄裡**。出貨型錄只有出貨的那幾顆；換過 `modelId` 的部署要自己把那顆加進型錄。
- **頂層 `maxRetries` 拿掉**，改成 `retryPolicy`，首事件之前與之後共用一份次數。舊鍵被拒收，訊息會說怎麼改寫。
- **`timeoutMs` 只管等第一則事件**（預設 180000），之後的閒置另由 `streamIdleTimeoutMs`（預設 90000）管。
- **串流一定要帶結束原因**（PR #1750）：從沒收到 `finish_reason` 就結束的串流當成被切斷（`TRANSPORT`），照 `retryPolicy` 整次重打，
  預算用盡這一輪失敗；`finish_reason` 是 nexus 不認得的值也算失敗（`UNKNOWN`，不重打）。v0.5.19 的 harness 不看 `finish_reason`（原始碼裡只有註解提到它），這兩種都照正常結束往下走。
  串流不送 `finish_reason` 的端點（內網自架的 vLLM 之類），型錄那一筆要寫 `compat: { supportsFinishReason: false }`。

帶 `--live` 時這一列驗不過，serve 與 CLI 都起不來，訊息指名這一列。

受影響的：在 home 的 `cordis.patch.yml` 或 `--patch` 覆寫檔裡改過 `live-model` 的主機。沒改過的不受影響。
結束原因那一條只影響把 `baseUrl` 換成別的端點、而那個端點的串流不送 `finish_reason` 的主機，症狀是每一輪都以 `TRANSPORT` 失敗、
端點收到 `1 + maxRetries` 次請求。

## 遷移

1. 照 [`docs/operations.md`](../../../operations.md) 的「`live-model` 的五格」那一段，把這一列整份重寫：
   - 換過的 `modelId` 加進 `models`，一筆寫 `id`、`contextWindow`、`maxTokens`（原本的 `maxOutputTokens`），收圖的加 `input: [text, image]`。
     **`models` 是整份取代**，出貨那幾筆要用的話也要一起寫出來。
   - 原本的 `maxRetries` 改成 `retryPolicy: { mode: normal, maxRetries: <次數> }`。
   - 原本的 `timeoutMs` 想保留「整個請求」的意思，把同一個值也寫到 `streamIdleTimeoutMs`。
   - 換過 `baseUrl` 的，看那個端點的串流有沒有一則帶 `finish_reason`、值是不是 `stop`、`length`、`max_tokens`、`tool_calls`、`function_call`、`content_filter` 之一；沒有、或是別的值，那一筆型錄加 `compat: { supportsFinishReason: false }`（兩項檢查一起關）。
2. 這一列在 home 的 `cordis.patch.yml` 裡、升級時會被遷進變更紀錄的：升級後用 `plugin config set live-model --file -` 整份換掉；
   在 `--patch` 檔裡的直接改檔。
3. 確認：`serve --live` 起得來，啟動輸出沒有「N 列沒有掛上」；`--dump-config` 的 `live-model` 那一列是你要的值；
   開一條對話送一句話，回得出來、server 日誌沒有 `TRANSPORT`。
