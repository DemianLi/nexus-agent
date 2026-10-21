---
kind: upgrade-guide
description: serve 上一列 MCP 改成整台共用一條連線，server 記在連線上的狀態會跨對話、跨使用者共用。
---

# serve 的 MCP 連線整台共用

## 變更

v0.5.19 的 `serve` 一條對話組一個 agent，MCP 每次組裝各連一次：一列 stdio 的 MCP，開過幾條對話就有幾個子行程，
每條對話各有自己的一條連線，到 `serve` 收掉才一起收。新版（[#1677](https://github.com/DemianLi/nexus-agent/issues/1677)，照 dsh 的全域實例）：

- **一份設定整台一條連線**：一列 stdio 就是一個子行程，所有對話、所有使用者共用，`serve` 收掉才收。
  server 記在連線上的狀態（登入的身分、游標、暫存）**不再一條對話一份**。
- **改了那一列的設定**（`approval` 以外的任何鍵），新對話連到新的一份，開著的對話照舊用舊的；**舊的一份留到 `serve` 重啟**。
  重啟之前出現過幾種設定，那一列最多就有幾個子行程。

CLI 不變：每次組裝自己連。設定的形狀沒變，`--dump-config` 與變更紀錄裡的列照舊。掛上那一刻連不上時怎麼辦，見
[`mcp-connect-failure-not-fatal`](../mcp-connect-failure-not-fatal/guide.md)。

受影響的：在 `serve` 上 insert 了 MCP、而那台 server 在連線上記使用者狀態的主機。

## 遷移

1. 逐台確認接上的 MCP server 沒有連線級的狀態（例如連上之後登入一次、之後的呼叫都算那個人）。有的話自己隔開，例如每個使用者一份 `serve`；
   nexus 今天沒有身分可以交給 server。
2. 常改 MCP 那一列設定的主機，改完之後找時間重啟 `serve`，收掉舊設定留下的子行程。
3. 確認：`serve` 起來、開兩三條用到同一台 stdio MCP 的對話之後，那台 server 的子行程只有一個（例如 `pgrep -f <server 的指令>` 只回一個 pid）。
