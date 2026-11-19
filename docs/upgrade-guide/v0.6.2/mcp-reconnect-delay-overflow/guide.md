---
kind: upgrade-guide
description: "MCP 重連延遲超過 2^31−1 毫秒時，`per-thread` 下照設定等；單行程仍受計時器上限影響。"
---

# per-thread：MCP 重連延遲超過 2^31−1 ms

## 變更

只影響 `process-model` 設成 `per-thread` 的部署，且 `reconnect.initialDelayMs` 或 `maxDelayMs` 設得大於 2^31−1（約 24.8 天）。

- **舊行為。** 重連由 TS 的計時器等，Node 把超過 2^31−1 毫秒的延遲改成約 1 毫秒，設很大的延遲反而變成立刻重連。
- **新行為。** `per-thread` 下 MCP 重連由宿主退避，延遲照設定等，不再縮成約 1 毫秒。單行程（`single`）與 CLI 仍是舊行為。

## 遷移

1. 檢查設定裡 `reconnect.initialDelayMs`、`maxDelayMs` 有沒有超過 2147483647。
2. 想要「不要重連」的，改寫 `reconnect.enabled: false`，不要用超大的延遲。
