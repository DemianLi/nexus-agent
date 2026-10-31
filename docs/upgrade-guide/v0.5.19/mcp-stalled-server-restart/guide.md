---
kind: upgrade-guide
description: stdio MCP server 在呼叫逾時或被停止之後回不了探活，會被收掉重啟；一次只處理一個請求的 server 跑長呼叫時也算。
---

# 不回應的 stdio MCP server 會被重啟

## 變更

舊行為：v0.5.19 的工具呼叫逾時之後，nexus 不再等那個呼叫，子行程不動，也不檢查它還回不回應。事件迴圈卡死的 server 留在原地，同一條連線之後的呼叫都等滿 `toolCallTimeoutMs` 才失敗。

新行為：呼叫逾時或被停止之後，nexus 送一次 `tools/list` 探活。`livenessTimeoutMs`（預設 15000）內沒有回應，就收掉子行程、照 `reconnect` 的退避重連。收掉時進行中的呼叫回連線關閉，不重送；重連期間的呼叫當場失敗。工具不回、但 server 回得了探活的，不受影響。

受影響的是一次只處理一個請求的 stdio server：跑長呼叫時回不了探活，會被當成卡死。例如在處理函式裡做同步阻塞工作的 server。那個呼叫的逾時或停止已經發生，這次重啟會中斷它在 server 端還沒做完的事，以及 server 記在記憶體裡的狀態。

## 遷移

1. 在 `cordis.yml`（或 `--patch` 覆寫檔）找出 `transport: stdio` 的 MCP 列，確認哪些 server 會一次跑超過 15 秒、期間不回其他請求。
2. 這種 server，在那一列加 `livenessTimeoutMs`，值要大於它最長的一次呼叫，上限 2147483647（約 24.8 天）。沒有關閉探活的設定。
3. 重啟 `serve`，讓那一列的工具跑一次到逾時，確認伺服器日誌沒有 `server stopped responding`；有的話把值再調大。
