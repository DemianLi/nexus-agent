# S2 前置盤點：誰改了模型看到的請求（#1340）

地圖 [#1339](https://github.com/DemianLi/nexus-agent/issues/1339) 的一張卡。把 `.docs/event-contract-design-draft-2026-10-08.md` §六 D1 列為「沒做」的逐檔盤點做完。基準是 `origin/develop`（`ba9337ae`）。**這份文件沒有改任何產品程式碼。**

## 一句話結論

**S2 的真實工作量不在「已經事件化的四種改寫」，在下面四塊**（細目見 §四）：

1. **三處改了訊息、卻沒有事件也推不回來的**：子代理的 `modelCallLimitMiddleware` 往 state 寫一則有內容的 AIMessage（日誌上沒有、推導濾不掉）；基座 `FilesystemMiddleware` 把超過 200,000 字元的 human message 搬走（無事件、推導不套）；`image/offload` 的決定寫進日誌了，**但推導端根本不套它**，而且事件落在該次呼叫的 `model/start` 之後。
2. **兩處「同一件事有兩套規則」**：基座的 `patchToolCallsMiddleware` 補懸空呼叫／丟孤兒結果，跟 `replayConversation` 的 `closer` 與孤兒處理句子與規則都不同；HTTP 層的 `withEmptyAssistantContent` 與 replay 的 `isEmptyAssistant` 只部分重疊。
3. **從 `state.messages` 讀歷史的人**：`rawArgumentsOf`（三個讀者）、`toolBarrier`、`patchToolCalls`、`repeatReminder`、摘要器的 `effectiveMessages`＋切點、`agent-instructions`。state 不再持有歷史之後，每一處讀取路徑都要改。
4. **「寫日誌失敗就吞掉、改寫照做」**：至少五處（§四 W7）。日誌變成唯一真相之後，這些都是「模型看到了、日誌沒有」。

另一件**不屬於 S2、但盤點時發現**的事：摘要器實際排在換模型的**外面**，跟 `fold.ts` 與 `model-selection.ts` 的註解寫的相反（§五 F1）。

## 方法與可信度

- 四個研究子代理（Opus 5.5、effort high）分四組逐檔讀全文，每個結論要附 `檔案:行號`，否定性結論要配 grep。我自己獨立核了下列幾條（其餘為子代理讀碼，未逐條核）：
  - 堆疊順序：`agent-assembly.ts` 的 `mergeMiddlewareStack` 原地換同名、LangChain `AgentNode.js:194` 先列者最外層、`apps/harness/src/summarization.test.ts:181-200` 已經釘著「摘要器第三格」。
  - `modelCallLimitMiddleware`：`fold.ts:648-658` 建它，langchain `modelCallLimit.js` 的 `beforeModel` 回 `{ jumpTo:'end', messages:[new AIMessage(...)] }`，對 `conversation-replay.ts`／`session-log.ts` grep 零命中。
  - `image/offload`：`conversation-replay.ts` 對圖只有 `stampImageOrigin`（:91、:277）。
  - `containment.ts:285` 的 `readInjectedMessages` 型別是 `readonly HumanMessage[]`。
  - sandbox-policy 的「未圍堵分支」疑點：LangChain 初始請求的 `systemMessage` 一定有值（`AgentNode.js:259-261`），所以該分支從基座走不到。
- **沒有跑任何實測**。標「待複核」的是讀碼推論。
- 數字更正：卡上寫 `wrapModelCall` 在 38 個非測試檔、插件 13 個。實測：含 `wrapModelCall` 字樣的非測試檔 37 個，**非註解行真的實作它的約 25 個**（其餘是註解或 helper）；`packages/nexus-plugin-*` 有 **21 個**（卡上的 13 是哪幾個沒有定義，這裡全數）。

## 一、實際的 middleware 堆疊（由外到內）

**要點：我們的摘要器與基座同名 `SummarizationMiddleware`，被 `mergeMiddlewareStack` 原地換進基座的第三格，所以它在所有「新名字」的 fold middleware 外面。** `fold.ts` 槽位表的順序只決定「新名字」那一段的內部順序。（`agent-assembly.ts:77-100、190-217`；`summarization.test.ts:181-200` 釘著。）

### Root

| 段 | 順序 | middleware | 掛載條件 | 鉤子 |
| --- | --- | --- | --- | --- |
| core | 1 | skills（基座，包 `QuietWhenEmpty`） | 有 skills 來源 | beforeAgent、wrapModelCall |
| core | 2 | 基座 `FilesystemMiddleware` | 永遠 | beforeAgent（200k 字元 human 搬走）、wrapModelCall（濾 execute／delete、接檔案提示、換截斷版 human）、wrapToolCall（80k 字元結果換預覽） |
| core | 3 | 基座 `subAgentMiddleware`（`task`） | 永遠 | wrapModelCall（接 task 提示、組 `task` 描述） |
| core | 4 | **我們的摘要鏈**：`withToolResultPruning` → `withTokenBudget` → `withArgTruncationLog` → `withCompactionLog` → `withQuietSummaryCall` → `withAttachmentText` → 基座摘要器 | 永遠（關掉時為同名空殼） | wrapModelCall |
| core | 5 | `patchToolCallsMiddleware` | 永遠 | beforeAgent、wrapModelCall |
| fold | 6 | stepInbox | 只 root、選項開 | beforeModel、afterAgent |
| fold | 7 | modelSelection（換模型） | 有 modelSelection | wrapModelCall |
| fold | 8 | imageOffload | 只 root、有 `modelLimits` | wrapModelCall |
| fold | 9 | toolBarrier | 每個 agent 各一顆 | wrapToolCall |
| fold | 10 | containment | 共用一顆 | wrapToolCall（`tool/call`、`tool/result`、注入的 `user/message` 的生產者） |
| fold | 11 | turnCancel | 共用 | wrapToolCall、wrapModelCall |
| fold | 12 | spill、searchOverflow | 有對應服務 | wrapToolCall |
| fold | 13 | plugins.prepended（plan-mode、background-delegation） | — | wrapModelCall |
| fold | 14 | toolPreExecute、approvalGate | — | wrapToolCall |
| fold | 15 | observationPolicy | 每個 agent 各一顆 | wrapModelCall（接系統提示）、wrapToolCall |
| fold | 16 | repeatReminder（或 stepNotice） | 共用 | beforeModel |
| fold | 17 | streamRetry | `maxRetries > 0` | wrapModelCall |
| fold | 18 | modelCalls | 永遠 | wrapModelCall（`model/start`、`assistant/message`、`model/end`） |
| fold | 19 | modelUsage | 可關 | wrapModelCall |
| fold | 20 | sessionCheckpoint | 可關 | wrapModelCall、wrapToolCall |
| fold | 21 | plugins.rest（agent-instructions、sandbox-policy、workspace-changes、MCP hub／hideTools、file-references） | — | 各自 |
| fold | 22 | plugins.last（system-prompt） | — | wrapModelCall |
| fold | 23 | toolPostExecute、outputSchema、fsToolErrors | — | wrapToolCall |
| fold | 24 | readContinuation | 有 backend | wrapModelCall（改 `read_file` schema）、wrapToolCall |
| fold | 25 | invalidToolArgs | — | wrapModelCall（改回應）、wrapToolCall |
| fold | 26 | toolExecute、maxTokens | — | wrapModelCall（maxTokens：清工具呼叫）、wrapToolCall |
| fold | 27 | imageOffloadRecovery | 只 root、有 `modelLimits` | wrapModelCall |
| fold | 28 | requestSnapshot | 永遠 | wrapModelCall（記錄點在 callback） |
| fold | 29 | turnCancelModelSignal | 永遠 | wrapModelCall（綁中止 signal） |
| tail | 30 | memory（基座） | 有 memory 來源 | beforeAgent、wrapModelCall |

另有 `beforeModel`／`beforeAgent` 是圖裡獨立的節點，不在 wrap 洋蔥裡。**HTTP 層不是 middleware**，在 adapter 之下：`AttachmentChatOpenAI`（附件投影、`imageBudgetGuard` 超額拋 `IMAGE_OFFLOAD_REQUIRED`）；`createLiveModel` 的 fetch 由外到內：`withRequestStartNotice` → `withStreamIdleTimeout` → `withInbandStreamErrors` → `withEmptyAssistantContent` → `withStreamUsageReport`（`live-model.ts:1118、1426、760、574、944、1030`）。

### 子代理的差異

子代理的 core 段由 `subagentDefaultMiddleware`（`agent-assembly.ts:112-130`）組成：Filesystem、我們的摘要器、patchToolCalls，有 skills 再加 skills；**沒有 `task` 提示、沒有 memory**。fold 那段：沒有 stepInbox、modelSelection 換成 `subagentModelFollow`、沒有 imageOffload 與 imageOffloadRecovery，多出 `subagentMaxTurns`（`modelCallLimitMiddleware`）、`toolFilter`、`delegation`、`spec.middleware`。背景圖另把核准閘門換成只回 never 的版本、委派聲明換回預設句（`agent-factory.ts:870-893`）。

## 二、每個生產者對請求做了什麼

欄位：**改什麼**是對模型看到的請求；**事件**是今天對應的日誌事件；**推導**是 `replayConversation` 能不能還原。分類 (a) 純函式於日誌已有的資料、(b) 依賴日誌沒有的狀態、(c) 該歸模型設定（dsh `LlmCallConfig`）。行號是子代理讀碼的結果。

### 2.1 改 messages（含回應）

| 生產者 | 檔案 | 改什麼 | 事件 | 推導 | 建議 |
| --- | --- | --- | --- | --- | --- |
| 摘要（基座＋我們的包裝） | `summarization.ts:487-524、803-853` | 有效串＝`[摘要, ...messages.slice(cutoff)]`；達門檻生摘要 | `compaction/summary`（`beforeCall:true`，記在 `model/start` 之前） | 是（`settle` 切點） | 不用動 |
| 工具結果剪刀 | `tool-result-pruner.ts:342-371` | 壓力下把超過門檻的結果換成頭＋標記＋尾 | `compaction/prune` | 是，`applyPrunes`（預設關） | 不用動 |
| 舊工具參數截斷 | `summarization.ts:875-913`、`tool-arg-truncation-log.ts` | 把舊 `write_file`／`edit_file` 長參數縮短 | `compaction/truncate-args` | 是，`applyArgTruncations`（預設關） | 不用動 |
| 圖片省略 | `image-offload.ts:306-319、331-363` | 依 `image/offload` 把 HumanMessage 的圖標成 `offloaded` | `image/offload` | **否**：replay 只蓋來源 `seq`，不套；套用在請求端 middleware | **S2 要補**（§四 W2） |
| 重複呼叫提醒、換模型通知 | `repeat-reminder.ts:416-450、581-592` | `beforeModel` 附加 HumanMessage | `user/message`（`source.plugin`） | 是 | 不用動；吞錯另議（W7） |
| 步驟插話 | `step-inbox.ts:131-153` | 併進領走的插話並 `jumpTo:'model'` | `inbox/spliced` ＋ `user/message`（pump 寫） | 是 | 不用動 |
| agent-instructions 基線 | `nexus-plugin-agent-instructions/src/index.ts:228-251` | `beforeAgent` 補一則帶標記的 HumanMessage | `user/message`（`source.plugin`） | 是 | 寫入失敗不能再吞；標記檢查改從日誌導出 |
| goal `update_goal` 的收尾訊息 | `nexus-plugin-goal/src/tools.ts:599-618` | 工具回 `Command`，注入 HumanMessage | `user/message`（`source.plugin:'update_goal'`），重播掛回該顆結果 | 是 | 不用動；約束見 W6 |
| 回應改寫：invalid-tool-args | `invalid-tool-args.ts:251-276` | 參數解不開的呼叫改寫成正常 `tool_calls`＋`{}`，原字串放 `additional_kwargs` | 記的就是改寫後的 `assistant/message` | 是 | 不用動；讀取路徑見 W6 |
| 回應改寫：maxTokens | `max-tokens.ts:263-299` | `finish_reason=length` 時清掉全部工具呼叫 | 同上 | 是 | 不用動 |
| 子代理收尾：turnCancel／封存閘門 | `turn-cancel.ts:167-190、338-347` | 子代理回合成的空 AIMessage（帶 `INTERRUPTED_REPLY_MARKER`） | **無**（`model-calls.ts:115` 明確跳過） | 空訊息被濾掉，但**在子代理 state 佔一格座標** | 待複核（W8） |
| **子代理上限：`modelCallLimitMiddleware`** | `fold.ts:648-658`；langchain `modelCallLimit.js:112-153` | `beforeModel` 到上限就寫一則有內容的 AIMessage 並結束 | **無** | **否**（有內容，`isEmptyAssistant` 濾不掉） | **記事件**（W1） |
| 基座 `patchToolCallsMiddleware` | `patch-tool-calls.ts:48-125` | 補懸空呼叫（"cancelled - another message came in…"），丟孤兒結果 | 無 | 與 replay 的規則**不同** | 拿掉，或與 replay 共用同一套（W4） |
| 基座 `FilesystemMiddleware`：human 搬走 | deepagents `langsmith-*.js:2364、2483` | human 超過 200,000 字元搬到 `/conversation_history`，換截斷版 | **無** | **否**（依賴 state 的 `lc_evicted_to` 與歷史檔） | W3 |
| 基座 `FilesystemMiddleware`：80k 預覽 | 同上 `:2507` | 工具結果超過 80,000 字元換成預覽 | `tool/result` 記全文 | 靠 `toolResultAsSeen` 依設定重算（**未實跑比對逐字一致**） | W3 |
| HTTP 層 `withEmptyAssistantContent` | `live-model.ts:864/944` | 有 `tool_calls` 而 content 為空陣列→`null`；空內容無 `tool_calls` 的助手訊息整則刪掉 | 無 | 與 `isEmptyAssistant` 只部分重疊（replay 不濾「只有推理」的） | 同一份函式（W5） |
| 寫 state 的 goal／submit-record `Command` | `submit-record/src/index.ts:213` | 回 `Command({files, messages:[ToolMessage]})` | `tool/result` 有；**`files` state 沒有** | messages 是；`files` 否 | 不動；S3 邊界（W9） |

### 2.2 只改 `systemMessage`／工具清單／模型設定（歸 (c)）

這些都**只有 `request/system`、`request/header` 兩種快照**（`request-snapshot.ts:303-329`，`ignorable:true`、變了才記、落在 `model/start` 之後、不進模型、replay 不讀——對 `conversation-replay.ts` grep 零命中）。夾具目前就是從 `request/system` 取系統提示詞比對。

| 生產者 | 檔案 | 改什麼 | 依賴 | 建議 |
| --- | --- | --- | --- | --- |
| observation | `observation.ts:233-237` | 無條件在系統提示後接 `OBSERVATION_POLICY_NOTICE` | 程式碼常數、有沒有掛 | (c) |
| subagent-delegation | `subagent-delegation.ts:69-84` | 子代理系統提示後接委派聲明（前景／背景兩種） | 組裝時前景或背景 | (c) |
| system-prompt 插件 | `nexus-plugin-system-prompt/src/index.ts:281` | 前後夾 identity／persona | 設定、模型路由 | (c) |
| plan-mode | `nexus-plugin-plan-mode/src/index.ts:444` | root 且 `plan/mode` 開著時接 guidance | `plan/mode` 事件＋設定 | (a)＋(c) |
| sandbox-policy | `nexus-plugin-sandbox-policy/src/index.ts:211-225` | 接 `sandboxPolicySentence(mode)` | `sandbox/mode` 事件＋有無圍堵 | (a)＋(c) |
| mcp-prompt | `nexus-plugin-mcp/src/hub.ts:234-248` | 接資源 server 清單、`CITATION_PROMPT`、各 server 指示 | 設定、server 狀態 | (c) |
| file-references | `file-references.ts:470、490` | 接 `FILE_REFERENCE_PROMPT` | 有 `workspaceRoot` | (c) |
| background-delegation | `background-delegation.ts:156、422-435` | root 把 `task` 換成 `subagent` 並改描述；接 `PARALLEL_SENTENCE` | 有 `backgroundSubagents` | (c)，搬到設定面 |
| skills（基座） | `skills-middleware.ts`、deepagents `:4516-4552` | 掃 backend skill 目錄、接清單到系統提示 | backend 檔案內容與掃描時刻 | (b)／(c)；`skillsMetadata` 是 messages 以外的 state |
| memory（基座） | `agent-assembly.ts:207-211` | 讀記憶檔接到系統提示 | backend 檔案內容 | (c)；只在 root |
| 基座 `FilesystemMiddleware` 的工具過濾與檔案提示 | deepagents `:2483` | 濾 execute／delete、接檔案提示 | 設定 | (c) |
| 基座 `subAgentMiddleware` 的 `task` 描述 | agent-assembly.ts:197 | 現組 `task` 工具描述與提示 | 子代理清單 | (c) |
| subagent-tool-filter | `subagent-tool-filter.ts:107-114` | 子代理工具清單濾掉 `hidden` 的基座工具 | 組裝時決定 | (c) |
| read-continuation | `read-continuation.ts:393-400` | 把 `read_file` 換成 OpenAI 形狀的 schema（預設 2000 行、`limit` 選填） | 設定 | (c) |
| mcp hideTools | `nexus-plugin-mcp/src/index.ts:414-431` | `gaveUp` 之後從工具清單濾掉該 server 的工具 | **記憶體旗標** `supervisor.gaveUp` | (c)；要重現「為什麼這輪看不到某 server」得補 `mcp/server-gave-up` 之類事件，不擋 S2 |
| model-selection（換模型／子代理跟隨） | `model-selection.ts:228-239、267-289` | 換 `request.model` | `model/selection` 事件 | (c)，就是 `LlmCallConfig` 的模型那一格 |
| request-snapshot | `request-snapshot.ts:396-401` | 往 `request.model` 綁 callback，不碰 messages | — | 不用動 |
| turnCancelModelSignal | `turn-cancel.ts:361-377` | 往 `request.model` 綁中止 signal | — | 不用動（本就是呼叫設定） |
| 摘要器的 quiet call | `summarization.ts:690-739` | 換成 `nostream` tag 的 Proxy，不碰 messages | — | 不用動 |

### 2.3 只讀或只動工具端（不碰請求）

下列經子代理逐檔讀全文＋grep 核對：`llm-retry.ts`、`stream-retry.ts`（重打用同一份 `request`）、`model-calls.ts`、`model-usage.ts`、`token-usage.ts`（純折疊）、`archive-gate.ts`、`session-address.ts`、`session-checkpoint-policy.ts`、`session-log.ts`、`conversation-replay.ts`、`registry.ts`（只寫子日誌第一顆 `user/message`，見 W7）、`nexus-wire/src/message-discard.ts`、`approval.ts`、`containment.ts`、`fs-tool-errors.ts`、`search-overflow.ts`、`spill-policy.ts`、`tool-barrier.ts`、`tool-pipeline.ts`、`output-schema.ts`、`agent-factory.ts`、`assembly-root.ts`、`cli.ts`、`thread-pump.ts`、`wire-handler.ts`、`looping-model.ts`、`settings/recursion-limit.ts`、`eval/compare.ts`。

只動工具端的結果（`tool/result` 記的就是改過的那則，由最外層圍堵寫）：`containment`、`approval`（拒絕）、`fs-tool-errors`、`search-overflow`（截斷並前綴總數）、`spill-policy`（頭尾預覽＋通知；`read_file` 豁免）、`tool-pipeline`（pre／execute／post）、`output-schema`、`turn-cancel` 的 `wrapToolCall`、`sessionCheckpoint` 的 `wrapToolCall`、`maxTokens` 的 `task` 結果、`read-continuation` 的結果尾註。

## 三、插件（21 個，不是 13 個）

| 插件 | 用 LangChain 的什麼 | 改請求 | 事件化 | 建議 |
| --- | --- | --- | --- | --- |
| agent-instructions | `createMiddleware`、`stateSchema`（讀 deepagents 私有鍵 `_summarizationEvent`）、`HumanMessage` | `beforeAgent` 補基線訊息 | `user/message`；**寫入失敗被吞** | 失敗不吞；標記檢查改從日誌 |
| ask-user | `tool()`、`interrupt` | 無 | `tool/result` | 不動 |
| commands | 無 | 無 | `command/*` | 不動 |
| echo | `tool()` | 無 | `tool/result` | 不動 |
| feedback | 無 | 無 | `feedback/*` | 不動 |
| goal | `tool()`×3、`Command` | `update_goal` 注入 HumanMessage | `user/message`；續行輪在 `turn/start` | 不動 |
| mcp | `MultiServerMCPClient`、`tool()`×3、`createMiddleware`×2 | `hideTools` 改工具清單；`mcp-prompt` 改系統提示 | 無（快照） | (c) |
| memory | 基座 `createMemoryMiddleware`（核心代掛） | 系統提示 | 無（快照） | (c) |
| permission-presets | 無 | 間接經 sandbox 控制器 | `permission/preset`、`sandbox/mode` | 不動 |
| plan-mode | `tool()`、`interrupt`、`createMiddleware` | 系統提示 | `plan/mode`（開關）；提示詞無 | (a)＋(c) |
| present | `tool()` | 無 | `deliverables/presented`＋`tool/result` | 不動 |
| quickjs | `tool()` | 無 | `tool/result` | 不動 |
| sandbox-policy | `createMiddleware`、`tool()`、`interrupt` | 系統提示 | `sandbox/mode`；提示詞無 | (a)＋(c) |
| skills | 基座 skills middleware（核心代掛） | 系統提示、state `skillsMetadata` | 無（快照） | (c) |
| submit-record | `tool()`、`Command` | 無（工具端） | `tool/result`；**`files` state 沒有** | 不動；S3 邊界 |
| system-prompt | `createMiddleware`（`last:true`） | 系統提示 | 無（快照） | (c) |
| telemetry-otel | 無 | 無 | 不適用 | 不動 |
| todo | `tool()` | 無 | `todo/write`＋`tool/result` | 不動 |
| token-meter | 無（投影單元） | 無 | 不適用 | 不動 |
| trajectory | 無（投影單元） | 無 | 不適用 | 不動 |
| workspace-changes | `createMiddleware` | 無（`wrapToolCall` 原樣交給 handler） | `workspace/changes`（給 web 的指標） | 不動 |

**真正會改「訊息串」的插件只有 3 個**（agent-instructions、goal、submit-record 的工具回傳），今天都有事件。**改系統提示的 6 個**（mcp-prompt、plan-mode、sandbox-policy、system-prompt、memory、skills）與**改工具清單的 1 處**（mcp hideTools）歸 (c)。

## 四、改了模型看到的東西、今天沒有事件或推導不套的列（S2 的真實工作量）

每條附一句建議。「記事件／搬到 config／拿掉」就是卡上要的三選一。

| # | 項目 | 為什麼是缺口 | 建議 |
| --- | --- | --- | --- |
| W1 | 子代理的 `modelCallLimitMiddleware` 上限訊息 | `beforeModel` 寫一則有內容的 AIMessage，不經 `wrapModelCall`，所以沒有 `model/start`／`assistant/message`；`isEmptyAssistant` 濾不掉，**子日誌推出來的串比子代理 state 少一則**。背景子代理可續接／冷復活（#1271），撞 `maxTurns` 後再 `subagent.send` 是實際會發生的路徑（待實測） | **記事件**：子日誌上記一顆 `assistant/message`（或專用事件帶文字）；或改成我們自己的 middleware 並在跳出時寫日誌 |
| W2 | `image/offload`：推導端不套＋事件位置 | replay 只 `stampImageOrigin`；套用靠請求端 `createImageOffloadMiddleware` 每次叫模型前讀日誌；夾具沒傳任何跟圖有關的選項（`log-derived-history.fixture.ts:435-439`）。`imageOffloadRecovery` 排在 `modelCalls` **內側**（`fold.ts:753-760` 對 `:712`），所以新的決定落在這次呼叫的 `model/start` 之後。另：`selectImagesToOffload` 不限 HumanMessage、`applyImageOffload` 卻只處理 HumanMessage（`:163`）——續接後若選到工具結果裡的圖，可能標不上而拋（推論，未實測） | **記事件／補推導**：replay 加一個套用選項，並明訂「推導讀到哪裡」（`model/start` 之前，還是請求送出之前） |
| W3 | 基座 `FilesystemMiddleware` 的兩種截斷 | human 超過 200,000 字元被搬走：無事件、replay 不套、依賴 state 的 `lc_evicted_to` 與 `/conversation_history` 檔，**推出來的歷史是全文，與實際送出的不一致**；80k 工具結果預覽靠 `toolResultAsSeen` 重算，**是否與基座逐字一致沒有實跑比對** | human 搬走：記事件或拿掉這條（改由我們自己的上限處理）；80k：補一個實跑比對的夾具場景 |
| W4 | 基座 `patchToolCallsMiddleware` | 補懸空呼叫的句子與 replay 的 `closer`（dsh 兩句）不同；配不到呼叫的孤兒 `ToolMessage`：patch 丟掉、replay 照 push（`conversation-replay.ts:306-310`）。S2 之後缺的結果由日誌推導補，這顆變成第二套且不一致的修補 | **拿掉**，或改成與 replay 同一套句子與孤兒規則 |
| W5 | HTTP 層 `withEmptyAssistantContent` | 與 `isEmptyAssistant` 只部分重疊；夾具的 sink 沒有這一層（#1300 時已具名） | 同一份函式，讓推回的請求與送出的逐位一致 |
| W6 | **讀 `state.messages`／`request.state` 的人** | 資料在日誌推得回，但 state 不再持有歷史之後讀取路徑要改：`rawArgumentsOf` 的三個讀者（`invalid-tool-args.ts:190/312`、`containment.ts:429`、`approval.ts:411`）；`tool-barrier.ts:125`（排序）；`patch-tool-calls.ts:110`；`repeat-reminder.ts:429`（提醒鏈由 `state.messages` 現算）；摘要器 `summarization.ts:556、815-816、1021、1176`（`effectiveMessages(request.messages, request.state)` ＋ `previousCutoffOf(request.state)`）；`agent-instructions/src/index.ts:235`。另 `containment` 的 `readInjectedMessages` **只把 HumanMessage 抬進日誌**：工具回傳的 `Command` 以後若注入別種訊息，會從日誌消失——寫成 S2 的約束 | 逐一改成讀日誌導出的串或 `tool/call.arguments`；把「Command 注入只許 HumanMessage」寫進約束 |
| W7 | **寫日誌失敗就吞、改寫照做** | `summarization.ts:569、844、906`、`repeat-reminder.ts:467`、`model-selection.ts:213`、`agent-instructions/src/index.ts:270`、`registry.ts:1603-1605`（前景子代理第一顆 `user/message`）。日誌是唯一真相之後，每一處都是「模型看到了、日誌沒有」 | S2 要決定 fail-closed（記不進去就不改）或接受缺口並登記 |
| W8 | 子代理 state 與子日誌的座標落差 | turnCancel／封存閘門的合成空訊息（state 有、日誌沒有，推導會濾掉但 state 裡佔一格）；W1 的上限訊息。再加背景子代理續接（#1271）與子代理內的壓縮，**切點座標會不會錯開，需要實跑**一次「背景子代理撞 `maxTurns` 或被中止後再 `subagent.send`」 | 實測；W1 做完後只剩可濾的那種 |
| W9 | messages 以外的 state | `skillsMetadata`（skills）、`files`（submit-record 的 StateBackend）、`_summarizationEvent`／`_summarizationSessionId`（基座摘要器，agent-instructions 也讀它）、`runModelCallCount`／`threadModelCallCount`（上限計數）。S2 若只拿掉 `messages` 這條 channel 就沒事；**整個 checkpoint state 都丟掉就會壞** | 決定 S2／S3 的邊界畫在哪（地圖 Fog 已列「S2 與 S3 邊界沒切」） |
| W10 | 系統提示與工具清單只有快照 | §2.2 前 15 列（改系統提示或工具清單的）：`request/system`／`request/header` 是可略過、`model/start` 之後的快照，**不是推導的輸入**。夾具靠它比系統提示，但 S2 要讓「請求前就能算出設定」的話，得決定這兩個事件的位置與 `ignorable` 屬性，或把這些改寫收進 `LlmCallConfig` 那條 | 與 #1342（`name` 與系統訊息區塊邊界）一起決定 |

## 五、順帶發現（不屬於 S2，各自值得一張卡或一條註解修正）

| # | 發現 | 證據 | 嚴重度 |
| --- | --- | --- | --- |
| F1 | **摘要器排在換模型外面，註解寫反**。`fold.ts:616、636-638`、`model-selection.ts:222-223`、`image-offload.ts:303` 都說摘要器看到的是換過的模型、省略過的圖；實際上摘要器被原地換進基座第三格，在這兩顆外面。後果：摘要的觸發門檻 `limitsOf(request.model)`（`summarization.ts:519、1017`）與生摘要的 `request.model`（`:697`）拿到的是**換模型之前**那顆；`token` 估算看到的圖還沒標省略。`tool-result-pruner.ts` 沒讀 `request.model`，不受影響。`fold.test.ts` 只斷言換模型 middleware 出現（`:2537-2545`），沒有驗合併後順序 | `agent-assembly.ts:77-100、204`；`summarization.test.ts:181-200`（把「摘要器第三格」釘著）；`model-calls.ts` 的偏離一節 | 中。**行為影響是讀碼推論，沒有實測**；#723「換模型之後窗口跟著換」可能沒有實際作用 |
| F2 | `skills/src/index.ts:76-80` 說「memory 只有 fork 模式的子代理拿得到」，但自家組裝點拒絕 fork（`agent-assembly.ts:138`），註解過時 | 子代理 D 報告 | 低 |
| F3 | `sandbox-policy/src/index.ts:222-223` 在 `systemMessage === undefined` 時把 `systemPrompt` 整個換成那一句，與註解「用 concat 不用取代」字面不符。**從基座走不到**（初始請求 `systemMessage` 一定有值），只有手工呼叫（測試）才會進 | `AgentNode.js:259-261` | 低 |
| F4 | `agent-instructions` 靠 `stateSchema` 讀 deepagents 私有鍵 `_summarizationEvent` | `index.ts:210、227` | 低（升版時會紅） |

## 六、沒有核實的，與方法上的缺口

- **子代理自己說沒逐行讀完**：`token-meter/fold.ts`、`trajectory/trajectory.ts`、`goal` 的 `service/fold/authority/command`、`workspace-changes` 的 `recorder/git`、`telemetry-otel`。這些靠 G1–G7 grep（middleware 鉤子、`request.messages`、`Command`、`interrupt`、`'user/message'`）得「不碰請求」，建議有人抽讀。
- **大檔只讀了碰請求的部分**：`session-log.ts`、`fold.ts`、`registry.ts`、`thread-pump.ts`、`wire-handler.ts`、`cli.ts`、`live-model.ts`、`agent-factory.ts`、`assembly-root.ts`。
- **插件在 `cordis.yml`／出貨清單裡的實際順序沒有核**：§一 的 `plugins.prepended／rest／last` 是依 fold 三段推論。
- **dsh 側沒有重核**：skills 子代理報「dsh 的 skill 目錄是一則已發佈訊息」只出自 nexus 自己的註解（`skills-middleware.ts:14-16`），沒有對 dsh 原始碼核實。
- **全部是讀碼，沒有實測**：W1、W2 的邊界情況、W3 的 80k 預覽逐字一致、F1 的行為影響，都該各補一個夾具場景或實跑再下結論。

## 七、建議後續（不在這張卡）

- **F1** 開一張卡複現（同時給 `modelSelection` 與 `modelLimits` 的組裝，斷言摘要器看到的 `request.model` 與合併後順序）。
- **W1、W2、W3、W4** 是 S2 實作卡的候選；形狀與位置的決定看 #1341（橋接語意）與 #1342。
- **W6、W7** 各是一條跨檔的約束，S2 實作卡開之前要先寫成約束或護欄測試（對 `state.messages` 的讀取加一條「只許白名單」的 AST 護欄會直接把 W6 變成可數的清單）。
