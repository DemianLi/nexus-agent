---
kind: upgrade-guide
description: "`process-model: per-thread` 下 MCP 由宿主連，只講舊式 HTTP+SSE 的 server 連不上；單行程不受影響。"
---

# per-thread：只講 SSE 的 MCP server 連不上

## 變更

`per-thread` 下由宿主連，`single`（預設）與 CLI 由 TS 的客戶端連；兩條路現在都不退回 SSE（#1827 D279），TS 那條路的拿掉在 [#3001](https://github.com/DemianLi/nexus-agent/issues/3001)。

- **舊行為。** 對話行程自己連 MCP；Streamable HTTP 連不上時，TS 的客戶端會退回舊式 HTTP+SSE。
- **新行為。** 對話行程連 MCP 一律經宿主（Rust）。宿主的客戶端（rmcp）沒有舊式 HTTP+SSE，只講這種協定的 server 在 `per-thread` 下連不上，這一列照 `failOnStartupError` 處理：預設掛上、沒有工具並交出警告，寫 `true` 則這一列失敗。

受影響的：接了只提供 SSE 端點（沒有 Streamable HTTP）的 MCP server 的。

## 遷移

1. 改用 Streamable HTTP 的端點（多數 server 兩種都提供），或把該 server 換成 stdio 連線。
2. `single` 與 CLI 也不再退回 SSE，沒有可以暫時改用的模式；暫時不能改的，server 端要先開 Streamable HTTP。
3. 升級後重啟 serve，看啟動警告有沒有那一台 server 連不上的訊息。
