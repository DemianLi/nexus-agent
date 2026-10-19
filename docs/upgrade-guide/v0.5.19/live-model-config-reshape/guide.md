---
kind: upgrade-guide
description: live-model 那一列改了形狀，v0.5.19 寫的 maxOutputTokens、maxRetries 被拒收，換過的 modelId 要先進 models 型錄，否則 --live 起不來。
---

# `live-model` 設定改形狀

## 變更

v0.5.19 的 `live-model` 那一列是五格：`baseUrl`、`modelId`、`maxOutputTokens`（16384）、`timeoutMs`（90000，管整個請求）、
`maxRetries`（6）。新版（PR #805、#1256、#1436）：

- **`maxOutputTokens` 拿掉**，輸出上限改寫在模型型錄 `models[].maxTokens`。這一列是 `strictObject`，多寫一格就驗不過。
- **`modelId` 必須在 `models` 型錄裡**。出貨型錄只有出貨的那幾顆；換過 `modelId` 的部署要自己把那顆加進型錄。
- **頂層 `maxRetries` 拿掉**，改成 `retryPolicy`，首事件之前與之後共用一份次數。舊鍵被拒收，訊息會說怎麼改寫。
- **`timeoutMs` 只管等第一則事件**（預設 180000），之後的閒置另由 `streamIdleTimeoutMs`（預設 90000）管。

帶 `--live` 時這一列驗不過，serve 與 CLI 都起不來，訊息指名這一列。

受影響的：在 home 的 `cordis.patch.yml` 或 `--patch` 覆寫檔裡改過 `live-model` 的主機。沒改過的不受影響。

## 遷移

1. 照 [`docs/operations.md`](../../../operations.md) 的「`live-model` 的五格」那一段，把這一列整份重寫：
   - 換過的 `modelId` 加進 `models`，一筆寫 `id`、`contextWindow`、`maxTokens`（原本的 `maxOutputTokens`），收圖的加 `input: [text, image]`。
     **`models` 是整份取代**，出貨那幾筆要用的話也要一起寫出來。
   - 原本的 `maxRetries` 改成 `retryPolicy: { mode: normal, maxRetries: <次數> }`。
   - 原本的 `timeoutMs` 想保留「整個請求」的意思，把同一個值也寫到 `streamIdleTimeoutMs`。
2. 這一列在 home 的 `cordis.patch.yml` 裡、升級時會被遷進變更紀錄的：升級後用 `plugin config set live-model --file -` 整份換掉；
   在 `--patch` 檔裡的直接改檔。
3. 確認：`serve --live` 起得來，啟動輸出沒有「N 列沒有掛上」；`--dump-config` 的 `live-model` 那一列是你要的值。
