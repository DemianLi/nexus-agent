---
kind: upgrade-guide
description: MCP 的工具改成預設要人核准才會呼叫；唯讀的 server 要在那一列寫 approval 才回到不問。
---

# MCP 工具預設要人核准

## 變更

v0.5.19 的 `@nexus/plugin-mcp` 掛上的工具，模型叫了就直接送 `tools/call` 給 server，不問人。新版那一列多一個 `approval` 設定
（[#1622](https://github.com/DemianLi/nexus-agent/issues/1622)），**沒寫就是 `{ default: ask }`：這台 server 的每一支工具都要人核准**：

- 前景對話：模型叫到時先跳核准面板，人按允許之前 server 收不到呼叫；按不允許回 `APPROVAL_REJECTED_BY_USER`。
- **核准政策是 `never` 時一律回絕**，不問，碼 `APPROVAL_POLICY_NEVER`。
- **背景子代理叫到一律回絕**（背後沒有人），同一個碼。前景子代理問主對話的人。
- **CLI 叫到一律回絕**：一次性（`cli "…"`）與 REPL 都沒有核准管道，同一個碼。
- 三支資源工具（`list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource`）不經這個核准，`approval` 管不到讀資源。
- `approval: { default: allow }` 整台不問，跟 v0.5.19 一樣；`approval: { exempt: [<名字>…] }` 只讓這幾支不問。
- `default: allow` 又寫了 `exempt`（空陣列也算）是設定錯誤，那一列載入失敗。`exempt` 裡有 server 的 `tools/list` 沒列出的名字時，
  啟動輸出與每次組裝各有一則警告：`MCP 伺服器 "<serverName>" 的 approval.exempt 有 tools/list 沒列出的名字：…`，那一支以外照問。

受影響的：用 `--patch` 插了 MCP 列的主機。升級之後原本直接跑的 MCP 工具會停下來等人按；用 CLI 跑、
或靠背景子代理這類沒有人在場的流程叫 MCP 工具的，升級後那些呼叫會被回絕（工具結果帶 `APPROVAL_POLICY_NEVER`）。

## 遷移

1. 列出每一台 MCP server 的工具，分成「只讀」與「會寫、會動外部系統」兩類。工具名用 server 自己公告的名字（`tools/list` 回的
   `name`），不是模型看到的 `mcp__<serverName>__…`：名字帶 `[A-Za-z0-9_-]` 以外的字元或太長的，模型看到的那個被換過字、補了指紋，
   對不上。
2. 整台都只讀的 server，在那一列的 `config` 加 `approval: { default: allow }`。
3. 有寫入的 server，保留預設（或明寫 `approval: { default: ask }`），把只讀的那幾支列進 `exempt`：

   ```yaml
   approval:
     exempt: [search_orders, get_order]
   ```

4. CLI（一次性與 REPL）、背景子代理或其他沒有人在場的流程要叫的工具，必須在 `exempt` 裡或在 `default: allow` 的那台；
   要人看過的寫入不能交給它們。
5. 確認：重啟 serve，啟動輸出沒有 `approval.exempt 有 tools/list 沒列出的名字` 的警告；`--dump-config` 裡寫了 `approval` 的那幾列
   看得到它（沒寫的列不印預設值，預設見 `--dump-config-schema`）；開一條對話叫一支要問的工具，畫面跳出核准面板，叫一支 `exempt`
   裡的工具，直接有結果。
