---
kind: upgrade-guide
description: MCP 連不上不再讓每條對話都建不起來，改成那台 server 沒有工具加一則警告；server 指引超過 32 KB 也算連不上；模型多三支資源工具與一段提示詞。
---

# MCP 連不上不再擋對話

## 變更

v0.5.19 的 `@nexus/plugin-mcp` 在掛上那一刻連不上、列不出工具、或工具註冊不上時，那次組裝整個失敗：serve 起得來，但**每條對話都建不起來**，
`run.start` 回 `這條 thread 建不起來：<id> (mcp) 的 apply 失敗…`。新版：

- **預設收住**（PR #768，照 dsh 的 `failOnStartupError: false`）：那一列照樣掛上，**這台 server 沒有工具**，對話照常。
  啟動輸出與每次組裝各有一則警告：`MCP 伺服器 "<serverName>" 連不上、列不出工具或工具註冊不上，這一次沒有它的工具（要讓這一列失敗就寫 failOnStartupError: true）：…`。
  掛上那一刻就連不上的不重連，下一條對話重新組裝時再連一次；掛上之後才掉的線會退避重連（PR #1237）。
- 新增 `failOnStartupError: true` 讓那一列失敗，但 insert 的列是可少掛的，結果是**那一列掉了加一行警告**，對話照常，不會回到 v0.5.19 那樣每條都建不起來。
- **server 的使用指引進提示詞**（PR #1235）：`initialize` 回的 `instructions` 會加進系統提示詞，上限 `maxInstructionBytes`（預設 32768 位元組）。
  **超過就算這台連不上**，走上面那一條：預設撤掉工具、交出警告。
- **模型多三支資源工具與一段提示詞**（同 PR #1235）：只要掛了任何一台 MCP，就有 `list_mcp_resources`、`list_mcp_resource_templates`、
  `read_mcp_resource`，用 `server` 參數選問哪一台（連不上的那台照樣列名，叫了回 `server is disconnected`）；系統提示詞多一段列出可用的
  server 名字。同一段還要求模型引用出處、只講結果裡有的事實、查無資料先明說（[#1319](https://github.com/DemianLi/nexus-agent/issues/1319)、
  [#1345](https://github.com/DemianLi/nexus-agent/issues/1345)）；工具結果裡有 resource link 時，結尾多一句請模型用 markdown 連結標出來
  （PR #1323）。v0.5.19 都沒有。

設定的其餘形狀沒變：一列一台 server，`serverName`、`connection`、`toolCallTimeoutMs` 照舊。

受影響的：insert 了 MCP 的主機。依賴「MCP 連不上就沒有對話」當訊號的部署，升級後要改看警告。

## 遷移

1. 升級後看啟動輸出與 serve 日誌裡 MCP 的警告；連得上的 server 不會有。
2. 某台 server 的指引很長、被判成連不上的，把那一列的 `maxInstructionBytes` 調大。
3. 要在連不上時讓那一列掉列（`--dump-config` 與變更紀錄看得到），寫 `failOnStartupError: true`。
4. 確認：模型那一側看得到每台 server 的工具（工具名是 `mcp__<serverName>__…`）與那三支資源工具，啟動輸出沒有 MCP 的警告。
