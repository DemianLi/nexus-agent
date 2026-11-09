---
kind: upgrade-guide
description: 要收輪的 NexusTool 要宣告 `concludesTurn`，沒宣告的 `exec.concludeTurn()` 不會收這一輪。
---

# 要收輪的 NexusTool 改成宣告 `concludesTurn`

## 變更

`@nexus/tools` 的契約版本（`TOOLS_CONTRACT_VERSION`）從 `2.1.0` 跳到 `2.2.0`（#2353）。`NexusTool` 多一格選填的
`concludesTurn`：宣告「這顆工具可能在本體裡呼叫 `exec.concludeTurn()`，讓這一輪在這次呼叫之後收」。

`exec.concludeTurn()` 只對宣告了 `concludesTurn: true` 的工具有效。`2.1.0` 的 `NexusTool` 沒有地方宣告，所以那時呼叫它也不收這一輪：
模型照樣被叫第二次。宣告了之後，也只有本體真的呼叫了 `exec.concludeTurn()`、結果不是錯誤、而且那一則回覆只叫了這一個工具，
這一輪才收；其餘結局照常回頭叫模型。

**受影響的是：** 自己寫、登記 `NexusTool`、而且在本體裡呼叫 `exec.concludeTurn()` 的插件。沒呼叫 `concludeTurn()` 的工具、
LangChain 的工具（照舊用 `returnDirect: true`）與出廠的插件不受影響。

## 遷移

1. 找出受影響的工具：在插件的原始碼裡找 `exec.concludeTurn()`（或 `.concludeTurn()`），看它所在的 `NexusTool` 物件有沒有 `concludesTurn`。
2. 在那個 `NexusTool` 物件上加 `concludesTurn: true`。
3. 樹上的插件把 `inject` 裡 `tools` 的範圍改成 `'^2.2.0'`，`manifest.consumes` 裡 `token: 'tools'` 那一格的 `range` 改成同一個值。
   `2.1.0` 的宿主不認得這一格，宣告 `^2.2.0` 才保證收得了輪。有跑一致性套件（`checkConformance`）的插件，重跑一次。
4. 確認：重啟 serve，開一條新對話，讓模型走到會呼叫 `exec.concludeTurn()` 的那個結局。日誌上那顆工具的 `tool/result` 之後，
   不應再有同一輪的 `model/start`，下一顆就是 `turn/end`：
   `jq -c 'select(.type == "tool/result" or .type == "model/start" or .type == "turn/end") | .type' <會話日誌>`。
