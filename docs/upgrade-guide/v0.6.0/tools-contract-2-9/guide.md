---
kind: upgrade-guide
description: 工具事件契約 `2.9.0`：視圖多 `shape`、`command` 視圖帶內容、`tools/execute` 能只換 `Command` 裡那一則；插件監聽者看到的時刻有兩處改變。
---

# 工具事件契約 `2.9.0`：`shape`、`command` 的內容與兩處時刻改變

## 變更

`@nexus/tools` 的契約版本（`TOOLS_CONTRACT_VERSION`）從 `2.8.0` 跳到 `2.9.0`（#2575）。`@nexus/tools` 自己的型別不變；改的是 `@nexus/core` 的工具事件契約（`tools/execute`、`tools/post-execute`、`tools/result`），經 `registry.events.on` 登記的監聽者看得到。

**新增的欄位**（向後相容）：

- **`shape: 'text' | 'blocks'`**：生產者交給監聽者的結果視圖（`PipelineResultView`）多這一格，標出工具本體那則的 `content` 原本是字串還是陣列。`tools/post-execute` 的 `replace` 給 `content` 落成字串、給 `blocks` 落成陣列，要照原本的形狀交回就看它。
  監聽者自己造來交回的結果（`PipelineResult`、`PipelineMessageInput`）不必帶，只帶舊欄位的照樣編得過。
- **`command` 視圖帶內容**：工具回 `Command` 時，`Command` 裡有這次呼叫的那則訊息（`tool_call_id` 等於 `callId`），視圖就帶它的 `blocks`、`content`、`shape`；沒有就三格都不帶。
- **`tools/execute` 能交回改過內容的 `command` 結果**（`PipelineCommandInput`）：只換 `Command` 裡這次呼叫的那則，`update` 的其餘鍵與 `graph`、`goto` 原樣。那則在原位換，`update.messages` 裡沒有就加在最後。
  - 內容給 `content` 或 `blocks` 其中一個，同 `PipelineMessageInput`。
  - 本體回的 `Command` 的 `update` 不是物件（例如 tuple 陣列）時拋 `TypeError`：放不進一則訊息。
  - 舊行為：交回的 `command` 結果不是 `next()` 回的那一個，一律拋 `TypeError`。
- **`fresh: true`**：`tools/execute` 交回的訊息結果帶它，換上的那則就是新造的，只帶 `tool_call_id`、`name`、`status` 與錯誤碼，不沿用本體那則的 `artifact`、`id`、`additional_kwargs`。不帶的照舊沿用。

**插件監聽者看到的兩處時刻改變**（行為改變）：

輸出校驗、子代理撞到輸出上限的 `task` 替換、共用區的讀檔前綴，原本是三顆各自的 middleware，現在是工具事件上的 core 監聽者。模型收到的內容、會話日誌、工具清單都跟以前一樣。

- **`tools/execute`**：輸出校驗與撞限替換排在插件監聽者內側。
  - 舊行為：插件監聽者的 `next()` 交回的是還沒驗輸出、還沒換掉撞限結果的那一份，校驗與替換在插件監聽者外面才發生。
  - 新行為：`next()` 交回的就是驗過、換過的那一份。輸出不合 schema 時，`next()` 交回的已是那則錯誤（`isError: true`，碼是 `INVALID_TOOL_OUTPUT`）。
  - `ToolThread.on('tools/execute', …)` 登記的監聽者拿到的是不透明的 `ToolExecuteOutcome`，讀不到內容，只有時刻變了。
- **`tools/post-execute`**：共用區的讀檔前綴排在匯流排上的插件監聽者內側。
  - 舊行為：插件監聽者收到的 `result` 已經加過前綴。
  - 新行為：`result` 是加前綴之前的那份。監聽者接受（`next()`）時，模型收到的仍是加過前綴的。
  - 監聽者自己 `replace` 時，前綴不會再加：以前從 `result` 改出來的內容帶著前綴，現在不帶。
- **`tools/result`、`onResult` 不變**：看到的仍是模型最後收到的那一則。

**受影響的是：**

- 經 `registry.events.on('tools/post-execute', …)` 登記、讀 `read_file` 或 `grep` 結果內容的插件。出廠的插件都沒有掛 `tools/post-execute`。
- 經 `registry.events.on('tools/execute', …)` 登記、讀 `next()` 交回內容的插件，在宣告了輸出 schema 的工具上，或在 `task` 撞到輸出上限時。出廠的兩位（`@nexus/plugin-sandbox-policy`、`@nexus/plugin-workspace-changes`）都只原樣交回 `next()` 的結果。
- 想用新欄位的插件。

`@nexus/core` 拿掉四個匯出：`createOutputSchemaMiddleware`、`createSharedReadMarkMiddleware`，以及它們的名字常數 `OUTPUT_SCHEMA_MIDDLEWARE_NAME`、`SHARED_READ_MARK_MIDDLEWARE_NAME`；換成 `createOutputSchemaListener`、`createSharedReadMarkListener`。`createMaxTokensMiddleware` 還在，只剩模型那一半，工具那一半是 `createMaxTokensListener`。這幾個由 `fold.ts` 組裝，插件不經它們。

## 遷移

1. 掛 `tools/post-execute`、讀 `read_file` 或 `grep` 的 `result.content`、`result.blocks` 的監聽者：前綴已不在 `result` 裡。
   - 要看模型最後收到的內容，改掛 `tools/result`（或 `onResult`）。
   - 會 `replace` 這兩顆結果、又要模型看到前綴的，自己把前綴接回去。
2. 掛 `tools/execute`、讀 `next()` 交回內容的監聽者：在宣告了輸出 schema 的工具上，不合的輸出已經換成錯誤。
   要看本體原本回的輸出，這個時刻已經看不到。
3. 要讀 `shape`、`command` 視圖的內容，或交回 `PipelineCommandInput`、`fresh` 的插件：把 `inject` 裡 `tools` 的範圍改成 `'^2.9.0'`，`manifest.consumes` 裡 `token: 'tools'` 那一格的 `range` 改成同一個值。
   不用的插件不必動。
4. 確認改好了：跑一次在共用區叫到 `read_file` 的對話，日誌上那顆 `tool/result` 的內容應符合你的監聽者的決定（接受就以共用區前綴開頭）：
   `jq -c 'select(.type == "tool/result") | .data.message.data.content' <會話日誌>`。
