---
kind: upgrade-guide
description: 工具契約 `2.3.0` 加三格選填的欄位；要用 `rawParameters`、`timeoutMs` 或成功結果的 `artifact` 的插件宣告 `^2.3.0`。
---

# 工具契約 `2.3.0`：`rawParameters`、`timeoutMs`、成功結果的 `artifact`

## 變更

`@nexus/tools` 的契約版本（`TOOLS_CONTRACT_VERSION`）從 `2.2.0` 跳到 `2.3.0`（#2353）。三格都是選填的，不寫的工具行為不變：

- **`NexusTool.rawParameters`**：寫 `true` 時，`parameters` 原樣送上線、照 JSON Schema 驗。宿主不補 `additionalProperties`，任何關鍵字都收（`$ref`、`anyOf`、`format` 等）。
  根物件沒有 `properties` 時補一個空的。參數驗不過時，模型看到的錯誤句是「Received tool input did not match expected schema」，不是逐項訊息。
- **`NexusTool.timeoutMs`**：一次呼叫的預算（毫秒），不送模型。到期時宿主舉起 `exec.signal`，逾時句講出這個數字。不是正的有限數，轉換時就拋。
- **成功結果的 `artifact`**：`{ ok: true, content, artifact }`。`artifact` 不送模型，落在那則工具結果上，跟著會話日誌落盤、還原時讀回。省略與 `[]` 是兩種值。

**受影響的是：** 想用這三格的插件。現有的插件、出廠的插件不用改。`2.2.0` 的宿主不認得這三格：
`rawParameters` 的 schema 用了宿主不認得的關鍵字時，轉換時就拋，沒用到的照舊轉（補 `additionalProperties: false`、多帶鍵丟掉）；
`timeoutMs` 與 `artifact` 靜靜忽略，不設期限、不落 `artifact`。

## 遷移

1. 不用這三格的插件不必動。
2. 要用的插件：在工具物件上加需要的那一格，再把 `inject` 裡 `tools` 的範圍改成 `'^2.3.0'`，`manifest.consumes` 裡 `token: 'tools'` 那一格的 `range` 改成同一個值。
   有跑一致性套件（`checkConformance`）的插件，重跑一次。
3. 確認 `timeoutMs`：讓那顆工具卡住超過預算，日誌上它的 `tool/result` 的碼是 `TOOL_TIMEOUT`，訊息講出宣告的毫秒數：
   `jq -c 'select(.type == "tool/result") | [.data.error.code, .data.message.data.content]' <會話日誌>`。
4. 確認 `artifact`：呼叫一次會回 `artifact` 的工具，日誌上那顆 `tool/result` 的訊息帶著它：
   `jq -c 'select(.type == "tool/result") | .data.message.data.artifact' <會話日誌>`。
