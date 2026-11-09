---
kind: upgrade-guide
description: 工具登記處的契約跳到 2.0.0，宣告 `need(toolsToken, '^1.x')` 的外部插件掛不起來。
---

# 工具登記處的契約跳到 2.0.0

## 變更

`@nexus/tools` 的契約版本（`TOOLS_CONTRACT_VERSION`）從 `1.4.0` 跳到 `2.0.0`（#2351）。這一版的 `register` 除了 LangChain 的工具，
也收 `NexusTool`：參數是 JSON Schema，執行時拿到的 `ToolExec` 帶這次呼叫的身分，失敗用結果上的 `ok: false` 與 `error` 表示，不靠
LangChain。介面本身沒有拿掉任何東西，舊的 LangChain 工具照樣登記得進去。

`develop` 目前是 `2.1.0`（#2352）：`ToolExec` 再多 `deferContext(text, marks?)` 與 `interrupt(payload)`。這是次版號的新增，
宣告 `^2.0.0` 的外部插件照樣掛得上。

跳的是主版號，所以範圍檢查不認舊的宣告：

- 在 `inject` 寫 `need(toolsToken, '^1.0.0')`（或 `^1.1.0`～`^1.4.0`）的插件，`^1.x` 不滿足 `2.0.0`，那一列停在等服務（PENDING），
  它登記的工具不會出現在任何對話裡。
- 錯誤寫進伺服器日誌，指名插件那一列、`tools` 那一列、兩邊的版本與範圍；`plugin-snapshot.json` 裡那一列是
  `state: "dropped"`、`dropStage: "requires"`。

**受影響的是：** 自己寫、而且消費 `tools` 服務的函式插件。出廠的插件已經改成 `^2.0.0`。沒有自己寫插件、或插件不登記工具的部署
不受影響。

## 遷移

1. 找出受影響的插件：在插件的原始碼裡找 `need(toolsToken,`，或 `inject` 裡的 `tools: { range: … }`，看宣告的範圍是不是 `^1.` 開頭。
2. 把 `inject` 的範圍改成 `'^2.0.0'`（插件要用 `ToolExec` 的 `deferContext` 或 `interrupt` 的話改成 `'^2.1.0'`），
   `manifest.consumes` 裡 `token: 'tools'` 那一格的 `range` 改成同一個值。兩邊要一致，
   一致性套件的 `export-form` 那一格會比對。插件原本的工具寫法不必改，`register` 照收 LangChain 的工具。
3. 有跑一致性套件（`checkConformance`）的插件，重跑一次，`manifest` 與 `export-form` 兩格要過。
4. 確認：重啟 serve，跑
   `jq '.rows[] | select(.id == "<列 id>") | .running' "$NEXUS_AGENT_HOME/plugin-snapshot.json"`，應是 `{"state":"mounted"}`，
   不是 `dropped`。
   最後開一條新對話，請模型列出能用的工具，它登記的工具名要在裡面。
