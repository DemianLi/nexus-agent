---
kind: upgrade-guide
description: 匯流排 waterfall 的監聽者呼叫第二次 `next()` 改成拋錯；`tools/post-execute` 也收得到工具拋的錯；工具契約升 `2.4.0`。
---

# 匯流排 waterfall 的 `next()` 只能叫一次，工具事件契約 `2.4.0`

## 變更

**`next()` 叫兩次改成拋錯。** 這是不相容的變更（#2416）。

- 舊行為：經 `registry.events.on` 登記的 waterfall 監聽者共用同一支 `next()`。呼叫第二次不會拋，而是交給鏈上下一位還沒被叫過的監聽者；後面的人都叫過了，就再跑一次最內層（例如工具本體）。
- 新行為：每位監聽者拿到自己的一支 `next()`，呼叫第二次就在那一次呼叫裡拋：`<事件名> 的監聽者呼叫了第二次 next()`。async 監聽者因此回 rejected promise。
- 受影響的：經 `registry.events.on` 登記 waterfall 事件的監聽者，也就是 `tools/pre-execute`、`tools/execute`、`tools/post-execute`、`agent/pre-step`、`agent/request-error`、`llm/stream`（`agent/*` 與 `llm/stream` 只在 `--agent-loop=native` 下派發）。如果你的監聽者靠「叫兩次往下推」重跑或跳過後面的人，升上來就會壞。出廠的插件都沒有這種監聽者。
- 不受影響的：
  - 核准閘門（`registry.approvals.gate`、`tools.gate()`）走自己的鏈，不經匯流排；
  - `tools/result`、`onResult` 是 emit，不是 waterfall；
  - 插件的 `agent/pre-step` 經 `@nexus/agent-loop` 轉成 middleware，也不上匯流排。

**`tools/post-execute` 也收得到工具拋的錯。** 這也是行為改變。

- 舊行為：工具本體拋錯時不派發 `tools/post-execute`。
- 新行為：照樣派發。`result` 是圍堵會翻出來的那則錯誤訊息，`isError: true`，碼照拋的錯分類；逾時那句的毫秒數由 `tools/post-execute` 那一層自己量，可能比模型最後收到的少幾毫秒。
  - 接受（`next()`）：同一個錯物件原樣往外拋，模型收到的訊息與日誌都跟以前一樣。
  - 替換：模型收到替換過的那則，`status` 是 `error`，碼沿用。
- 不派發的兩種錯：
  - 中斷與 `Command` 這類控制流；
  - 這一輪被中止的錯。
- 受影響的：`tools/post-execute` 的每位監聽者在工具拋錯的呼叫上也會被叫。會替換結果的，以前看不到這些呼叫，現在看得到；只接受的，模型收到的訊息與日誌不變，但監聽者自己的副作用（計量、記錄）會多跑這幾次，它自己拋錯時往外丟的是它的錯。

**新增的欄位**（向後相容）：

- `exec.signal`：這次呼叫的中止訊號，唯讀。
- 結果視圖多 `blocks`（內容區塊）；`content` 由 `blocks` 導出，只串 `text` 區塊。`tools/execute` 交回的結果兩者都在時以 `blocks` 為準，例外見下一點。
  - 例外（工具契約 `2.6.1`，#2416）：交回的 `blocks` 跟工具本體那則造出的視圖是同一個參照（`{ ...view, … }` 一路展開帶過去的也算）時，算沒給新的區塊，形狀照本體回的那則：
    `content` 沒換就沿用原本的內容，換了就照原本是字串或陣列給新的文字；陣列裡的圖之類的非文字塊這時不留，要留就自己給新的 `blocks`。
- `tools/pre-execute` 的 `deny` 可帶 `error: { name, code }`。拒絕的那則訊息掛這個碼，日誌照它分類。`error` 的 `name` 或 `code` 不是字串就拋 `TypeError`。
- `tools/post-execute` 的 `replace` 可改給 `blocks`。`content` 與 `blocks` 只能給一個，兩個都給或都不給會拋 `TypeError`。
- `tools/execute` 的監聽者叫了 `next()`、本體回的是 `ToolMessage`、又交回別的訊息結果時，`artifact`、`id`、`additional_kwargs` 沿用本體那則，內容、狀態與錯誤碼照交回的結果（`isError` 為假或省略 `error` 就不掛碼）。替換也沿用 `additional_kwargs`。
- `@nexus/tools` 的契約版本（`TOOLS_CONTRACT_VERSION`）從 `2.3.0` 升到 `2.4.0`：`onResult` 的 listener 看到的 `ToolResultExecution` 多 `signal`，`ToolResultOutcome` 多 `blocks` 與 `content`。

## 遷移

1. 找出你經 `registry.events.on` 登記的 waterfall 監聽者，確認每一位在每條路上最多呼叫一次 `next()`。
   要重試時不能重叫 `next()`：最內層（工具本體、模型呼叫）只經 `next()` 跑一次。`agent/request-error` 要重試就回 `{ kind: 'retry' }`；其餘的監聽者重跑不了最內層，要改成自己做那件事、不呼叫 `next()`，直接回結果。
   要跳過後面的人只能整段短路：不呼叫 `next()`，最內層也不跑，直接回自己的結果。
2. 會替換結果的 `tools/post-execute` 監聽者：決定工具拋錯時要不要替換。
   不想碰拋錯的呼叫，就在 `result.isError` 為真時直接 `return next()`。注意這也會略過工具自己回的錯誤訊息：結果視圖分不出是拋的還是回的。
3. 要讀新欄位的 `onResult` 插件：把 `inject` 裡 `tools` 的範圍改成 `'^2.4.0'`，`manifest.consumes` 裡 `token: 'tools'` 那一格的 `range` 改成同一個值。
   不讀的插件不必動。
4. 確認改好了：
   - 跑一次會走到你的監聽者的對話，宿主的錯誤輸出與會話日誌裡都不應出現「呼叫了第二次 next()」：
     `grep -c '呼叫了第二次 next()' <會話日誌>` 應該是 `0`。
   - 讓一顆工具拋錯，日誌上那顆 `tool/result` 的訊息與碼應符合你的監聽者的決定：
     `jq -c 'select(.type == "tool/result") | [.data.error.code, .data.message.data.content]' <會話日誌>`。
