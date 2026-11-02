# R1：nexus 追溯鏈盤點（對照藍圖 T3／T4、E3／E5／E6）

唯讀研究，沒有改 repo 任何檔。

## 0　來源與可信度

| 來源 | 版本 | 備註 |
| --- | --- | --- |
| nexus 程式 | `develop` @ `501e153`（2026-10-04） | 會話日誌格式版本 `SESSION_LOG_FORMAT_VERSION = 29`（`packages/nexus-core/src/session-store.ts:314`） |
| 真實日誌（真模型） | `/private/tmp/live877-v1imaI/home/sessions/--Users-demian-Projects_vibecoding-project_nexus_agent--/t1.jsonl`（＋子代理 `t1%2fbg-af9d2e204b19.jsonl`） | header `version: 27`，模型 `nvidia/nemotron-3-super-120b-a12b`。**這是 v27 的實跑，不是現行 v29 程式的證據**；用來示範「日誌長什麼樣、能答什麼」 |
| 真實日誌（假模型） | `~/.nexus-agent/sessions/2026-09-30…/cli.jsonl`、`2026-09-25…/`（含前景子代理 `cli%2ftools%3a53c40c2c-…`） | ScriptedChatModel 產的，`response_metadata` 是空的 |
| dsh（標準） | `references/deepseek-harness` @ `5badb15`（2026-10-03） | 只讀了 `packages/core/session/src/types.ts` 與 `llm/src/call-config.ts` 的事件形狀 |
| 藍圖 | `.docs/chat-agent-research/blueprint.md` | T3：387–497；T4：498–599；E3／E5／E6：1071–1111；M3／M4：1215–1285 |

shell 註記：所有 rg 都用 `/opt/homebrew/bin/rg`，範圍與指令附在各否定宣稱旁，總表在第 7 節。

---

## 1　事件詞彙總表（31 種，`packages/nexus-core/src/session-log.ts:153-184`）

每筆事件只有四格：`type`、`seq`（append 當下＝日誌長度）、`time`（epoch ms）、`data`（`session-log.ts:946-955`）。**沒有 turn、step、parent 這類欄位**。持久化是一個 thread 一份 `<thread>.jsonl` 加一份 `<thread>.header.json`；header 欄位是 `version/id/createdAt/cwd/workspaceRoot/parentSession`（`session-store.ts:322-354`）。

寫入點用 `rg -n -o "\.append\(\s*'[a-z/-]+'" apps/harness/src packages -g '!*.test.ts' -g '!*.test.tsx' -g '!**/node_modules/**'` 掃出來，再補上非字面量的那幾處（`model-calls.ts:82`、`cli.ts:548`、`background-subagents.ts:856`、`thread-pump.ts:2076`、`interrupted-turn.ts:124`）。

| 事件 | 寫者（file:line） | data 欄位 | 進模型 | 子代理那份有 |
| --- | --- | --- | --- | --- |
| `turn/start` | `thread-pump.ts:1578,1981`、`cli.ts:502`、`background-subagents.ts:853` | `kind`（message／resume／agent-message／subagent-settled／goal）＋`text` 等（`session-log.ts:330-375`） | 是 | 是（背景子代理） |
| `turn/end` | `thread-pump.ts:1605,2076,2093`、`cli.ts:548`、`background-subagents.ts:856`、`interrupted-turn.ts:124`（續接補寫） | `reason?`：aborted{cause}／max-tokens／interrupted（`:206-209,390`） | 否 | 是 |
| `turn/failed` | `thread-pump.ts:1609,2100`、`cli.ts:542`、`background-subagents.ts:874` | **只有 `message`**（`:392`） | 否 | 是 |
| `interrupt/raised` | `thread-pump.ts:2174`、`cli.ts:529` | `interruptId`（`:394`） | 否 | — |
| `command/run`／`command/done` | `nexus-plugin-commands/src/index.ts:243／201,222` | commandId、name、args?／kind、text?（`:414-430`） | 否 | 否 |
| `goal/change` | `nexus-plugin-goal/src/service.ts:565` | 整份 goal 快照，含 `blockedReason?`（`:441`） | 否 | 否 |
| `todo/write` | `nexus-plugin-todo/src/index.ts:259` | `todos`（`:450`） | 否 | 是 |
| `model/usage` | `nexus-core/src/model-usage.ts:161` | input／output／totalTokens 三個數（`:464-468`） | 否 | 是 |
| `model/start`／`model/end` | `model-calls.ts:82`（`tryAppend`） | **空物件**（`:477,484`） | 否 | 是 |
| `llm/retry`／`llm/retry-started` | `llm-retry.ts:109／124` | retryId、retry、maxRetries、failure{message,code,status?}／waitedMs（`:496-512`） | 否 | 是 |
| `assistant/message` | `model-calls.ts:105`、`thread-pump.ts:2148`（中止的半段） | `message`（LangChain StoredMessage 壓成 JSON）、`interrupted?`（`:543`） | 是 | 是 |
| `user/message` | `repeat-reminder.ts:460`、`containment.ts:336`、`agent-instructions/src/index.ts:265`、`thread-pump.ts:1882,1890`、`background-subagents.ts:934` | `message`＋`source`（plugin／user／session-reference／subagent-settled／agent-message）（`:572-575`） | 是 | 是 |
| `compaction/summary` | `summarization.ts:492` | cutoffIndex、messagesBefore、filePath\|null、summary?（`:616-625`） | 是 | 是 |
| `context/measure` | `summarization.ts:611` | approxTokens、messageCount、thresholds（`:642-652`） | 否 | 是 |
| `sandbox/mode` | `nexus-plugin-sandbox-policy/src/{index.ts:183, sandbox-mode.ts:339,356}` | mode、source?（`:682-686`） | 否 | 是（delegation） |
| `plan/mode` | `nexus-plugin-plan-mode/src/index.ts:112,404,668` | active（`:700`） | 否 | 否 |
| `subagent/model-selection-policy` | `apps/harness/src/agent-factory.ts:1006` | allowedModels（`:719`） | 否 | 否 |
| `tool/call` | `containment.ts:309` | callId、name、arguments（字串）（`:748-753`） | 否 | 是 |
| `tool/result` | `containment.ts:321`、`thread-pump.ts:1592`（核准點停止） | callId、isError、error?{name,code}、message?、meta?（`:799-815`） | 是 | 是 |
| `feedback/message-put`／`-delete`／`record` | `nexus-plugin-feedback/src/index.ts:151／161／172` | 評分、備註（`:825-835`） | 否 | 否 |
| `deliverables/presented` | `nexus-plugin-present/src/index.ts:265` | callId、files（`:855-860`） | 否 | 是 |
| `workspace/changes` | `nexus-plugin-workspace-changes/src/recorder.ts:473` | **空物件**，內容留在 server（`:861-876`） | 否 | 否 |
| `inbox/spliced` | `thread-pump.ts:1737` | 送出佇列變動（`:890`） | 否 | 否 |
| `session/title`、`session/title-llm-request` | `session-title.ts:173`、`session-title-llm.ts:225／144` | 標題／**標題模型的 system、messages、route、maxTokens**（`:902-921`） | 否 | 否 |
| `session/end-seed` | `SessionLog` 建構子（`session-log.ts:1165-1184`） | 空 | 否 | 是 |

會進模型的就五種（`ModelVisibleEventType`，`session-log.ts:976-977`）：`turn/start`、`assistant/message`、`tool/result`、`user/message`、`compaction/summary`。

---

## 2　追溯鏈逐段盤點

### 一覽

| 段 | 有沒有記 | 記在哪 | 主要缺口 |
| --- | --- | --- | --- |
| (a) 使用者輸入 | 有 | `turn/start.text`；插話在 `user/message{source:user}`；佇列在 `inbox/spliced` | 記的是換過 `@標題` 的文字，引用網址不進日誌（`session-log.ts:566-568`） |
| (b) 系統提示詞與完整請求 | **沒有** | 只有增量訊息可以重推 | 系統提示詞、工具清單、請求期改寫都不落盤 |
| (c) 推理 | 有（落盤） | `assistant/message.message.data.content[type=reasoning]`（串流路）或 `additional_kwargs.reasoning_content`（CLI 非串流路） | web 只畫串流路那一種；CLI 會話的推理有落盤但畫面看不到 |
| (d) token／延遲／模型 id／設定 | 部分 | `model/usage`、`model/start`／`end` 的 `time`、訊息裡的 `response_metadata.model_name` | 沒有溫度、topP、max_tokens、reasoning_effort；沒有首字延遲；用量細項只在訊息裡 |
| (e) 工具 | 有 | `tool/call` ＋ `tool/result`，以 `callId` 配對 | 耗時要自己用兩顆的 `time` 相減；外溢時只記預覽；錯誤碼有誤標實例（見下） |
| (f) 閘門／決策 | 部分 | 見 (f) 表 | 核准決定不結構化；壓縮失敗不留痕；`turn/failed` 沒有分類碼 |
| (g) 最終輸出 | 有 | 最後一顆 `assistant/message` ＋ `turn/end` | 「最後一則」靠位置推 |
| (h) 連結鍵 | 部分 | `seq`、`callId`、`retryId`、`commandId`、`interruptId`、訊息 id、`parentSession` | **沒有 turn id、沒有 step id**；前景子代理連不回父呼叫 |

### (a) 使用者輸入

- 一輪開頭那句：`turn/start {kind:'message', text}`。寫者是 pump（`thread-pump.ts:1578,1981`）與 CLI（`cli.ts:502`）。`text` 記的是把引用換成 `@標題` 之後的版本（`session-log.ts:566-568`）。
- 輪中插話：`user/message {source:{kind:'user'}}`（`thread-pump.ts:1882,1890`）。佇列的進出記在 `inbox/spliced`（`:1737`）。
- 引用別的會話時附的快照：`user/message {source:{kind:'session-reference', references}}`，內容凍在事件裡（`session-log.ts:560-565`）。
- 斜線命令：`command/run` 記原話。`/feedback` 宣告 `recordInput:false`，所以它的原話記在 `feedback/record`（`:409-412`）。
- 缺口：沒有。這一段齊全。

### (b) 系統提示詞與送進模型的完整訊息：**沒有落盤，只存增量**

- 日誌裡的 `system` 只出現在標題模型的請求事件：`rg -n "\bsystem\b" packages/nexus-core/src/session-log.ts` 只命中 `:918`（`session/title-llm-request.system`）。主對話的系統提示詞**沒有任何事件帶它**。
- 訊息部分是**增量**：五種進模型的事件各帶一則訊息，續接時由 `conversation-replay.ts` 推回歷史（`session-log.ts:957-977`）。推得回的是「圖狀態裡的訊息串」，不是「那一次請求實際送出的東西」。下面這些請求期改寫都不落盤：
  - **系統提示詞由多顆 middleware 現組**：`nexus-plugin-system-prompt`（persona，子代理也走這裡，`packages/nexus-plugin-system-prompt/src/index.ts:32`）、觀測政策提示 `observation.ts:236`（`systemMessage.concat(...)`）、計劃模式、skills、memory、sandbox 提示等。
  - **工具清單被改寫**：`background-delegation.ts:9-15,373-385` 在 `wrapModelCall` 把 `task` 從模型視野拿掉、換上 `subagent`；`subagent-tool-filter.ts:110` 篩工具。模型看到的工具清單與註冊的不同，而日誌一份都沒記。
  - **訊息被改寫**：摘要器送的是 `[摘要, ...messages.slice(cutoffIndex)]`（`compaction/summary` 只記切點與摘要）；`tool-result-pruner.ts` 在請求裡把大結果剪成頭尾；`read-continuation.ts:394` 讀 `request.tools`。剪裁有沒有發生、剪了哪幾則，不留紀錄。
  - `context/measure` 只記估算 token 與則數（`session-log.ts:642-652`），不記內容。
- `agent-instructions` 的基線（AGENTS.md 一類）倒是有記，記成 `user/message{source:plugin}`（`packages/nexus-plugin-agent-instructions/src/index.ts:255-270`）。
- **唯一會送出完整請求的機制是 LangSmith tracing**：只要設了 `LANGSMITH_TRACING` 這類環境變數，基座就自動掛 tracer，把 inputs／outputs 原文外送（`apps/harness/src/tracing.ts:1-30`）。預設端點在外網，跟「完全內網」的部署前提衝突，所以在本專案是不能用的旁路。
- **標準那側有**：dsh 的 `system/message {turn, step, message}`（渲染後的系統提示詞）與 `request/header {header:{config, tools}, reason}`（變更時才記一份完整快照），見 `references/deepseek-harness/packages/core/session/src/types.ts:330,390-397,240-251`。nexus 補這一段是**照 dsh**，不是偏離。

### (c) 模型的思考／推理

- **有落盤**：`assistant/message.message` 是完整的 `StoredMessage`（`logged-message.ts:64-67`）。
  - 串流路（web）：推理在 `content` 的 `{type:'reasoning'}` 區塊。真實日誌第 10 顆就是這樣，推理全文約 3,000 字元。
  - 非串流路（CLI 的 `_generate`）：推理在 `additional_kwargs.reasoning_content`（`conversation-history.ts:154-158` 的註解）。
- **web 怎麼顯示**：`conversation-history.ts:160-171` 的 `reasoningOf` 只讀 content 區塊，交給 `apps/web/src/components/reasoning-row.tsx:18-60` 的 `ReasoningRow`，預設收合，一步一列，收合時顯示一行摘要。
- 缺口：
  - CLI 會話的推理有落盤，但 web 不畫，這是刻意的（`conversation-history.ts:154-158`）。
  - 推理是不是「供應商只回摘要版」，日誌沒有標記。藍圖 T3-09 的條件（「只拿得到摘要時這條無法照做」）需要這個標記才判得出來。
  - 中止時寫的半段 `assistant/message{interrupted:true}` 帶不帶推理：**待驗**（`apps/harness/src/interrupted-reasoning.test.ts` 存在，沒讀）。

### (d) token、延遲、模型 id、設定

| 項目 | 有沒有 | 在哪 |
| --- | --- | --- |
| 每次呼叫的 input／output／total token | 有 | `model/usage`（`session-log.ts:464-468`）。供應商沒報就整顆沒有 |
| 快取讀取、推理 token 細項 | 只在訊息裡 | `assistant/message.message.data.usage_metadata.input_token_details.cache_read`、`output_token_details.reasoning`（真實日誌第 10 顆：輸出 1203、推理 1119） |
| 模型呼叫耗時 | 用位置推 | `model/start`→`model/end` 的 `time` 差；`session-stats.ts` 折成 `llmMs`。真實日誌第一次呼叫 6→11 是 62.1 秒 |
| 首字延遲（TTFT） | **沒有** | `session-stats.ts:27-29` 明寫「沒有記串流第一個 token 的時間」。dsh 的 `assistant/message.stream` 帶逐塊時間（`types.ts:341-353`） |
| 模型 id | 只在訊息裡 | `response_metadata.model_name`。真實日誌（串流路）有；假模型的日誌是空的。真模型走 CLI 時有沒有：**待驗**。header 沒有模型 id（`session-store.ts:322-354`）；serve 只在 stdout 印（`serve.ts:857`） |
| 溫度、topP、max_tokens、reasoning_effort | **沒有** | 寫死在 `live-model.ts:922-925`（`temperature: 1, topP: 0.95`）。`rg -n "temperature\|topP\|modelName\|model_name" packages/nexus-core/src/session-log.ts` 零命中。dsh 的 `request/header.config` 帶 `LlmCallConfig{provider, model, reasoningEffort, temperature, maxTokens, stop}`（`llm/src/call-config.ts:23-30`） |
| 重試 | 有 | `llm/retry` 帶分類碼 RATE_LIMIT／SERVER／TIMEOUT／TRANSPORT（`live-model.ts:1031-1048`）；`waitedMs` 是實際等待 |
| 金額 | **沒有單價資料** | `rg -n -i "pricePer\|costUsd\|usdPer\|per_million\|perMillion" apps packages -g '!**/node_modules/**' -g '!*.test.*'` 零命中。eval 的「成本」只算 token（`eval/compare.ts:258-260,590-598`） |
| web 的累計 | 只折 root | `packages/nexus-wire/src/session-totals.ts` 檔頭：兩個投影都「讀整份 root 日誌折出來的」。子代理那份的 token 不在畫面上的總數裡 |

### (e) 工具呼叫

- `tool/call`：在進任何一層之前記，被核准閘門擋下的也有（`session-log.ts:720-723`）。`arguments` 平常是解析後再序列化的字串；JSON 不合格的那顆記原字串（`:727-731`）。
- `tool/result`：`isError`、`error?{name, code}`、`message?`（模型收到的那則）、`meta?`（給畫面的結構化結果）（`:799-815`）。
- 耗時：沒有欄位，要用兩顆的 `time` 相減（`session-stats.ts` 的 `toolMs`）。圍堵自己有 `startedAt`（`containment.ts:378`），只用在逾時訊息（`:413`），沒有寫進事件。
- 缺口：
  1. **錯誤碼誤標的實例**。真實日誌第 14 顆把一次合法的參數拒絕（`subagent` 前景不能指定 reasoning_effort）記成 `{name:'ToolNotFoundError', code:'UNKNOWN_TOOL'}`。
     - 機制：`containment.ts:391-397` 以 `request.tool === undefined` 判「沒有這顆工具」；`approval.ts:35-38` 的註解說動態註冊的工具 `request.tool` 本來就是 `undefined`；`subagent` 正是在 `wrapModelCall` 裡動態加上的（`background-delegation.ts:9-15,373-385`），拒絕由 `toolRefusal` 回（`:424-428`）。
     - 結論的強度：舊版（v27）日誌觀察到，機制與現行程式一致。現行 develop 是否仍觸發、有沒有測試釘住：**待驗**。
     - 後果已經量到：`pnpm --filter @nexus/harness eval:sessions scan /private/tmp/live877-v1imaI/home/sessions` 印出 `工具錯誤 UNKNOWN_TOOL×1`。離線追溯工具因此會得出「模型叫了不存在的工具」這個錯誤結論。
  2. **外溢時只記預覽**。外溢層開著時日誌記的是頭尾預覽，原文在 spill 檔，過了保留期（預設 30 天）就沒了（`session-log.ts:767-779`）。
  3. **核准被拒、一般拋錯都不帶碼**（`:781-782`）。分不出「被人拒」與「工具自己失敗」，只能讀文字。
  4. #273、#293 之前的日誌把拒絕與 fence 擋下記成成功，格式版本沒升（`:784-788`）。

### (f) 閘門與決策類事件

| 閘門 | 日誌上的樣子 | 缺什麼 |
| --- | --- | --- |
| 重複呼叫提醒器 | `user/message{source:{kind:'plugin', plugin:<middleware 名>}}`，訊息的 `additional_kwargs` 帶 `{tool, count}` 記號（`repeat-reminder.ts:440-466`） | 沒觸發的不記（沒有「檢查過、沒事」）；離線重算鏈的規則在 `session-scan.ts` 檔頭 |
| 核准 | `tool/call` → `interrupt/raised{interruptId}` → `turn/end` → 下一輪 `turn/start{kind:'resume'}` → 同 callId 再一顆 `tool/call` → `tool/result` | **人的決定（核准、拒絕、理由）沒有結構化欄位**。拒絕只是一顆沒碼的 `isError` 結果；哪一個 listener 回了 `deny`、理由是什麼，只剩訊息文字（`approval.ts:56-59` 的 `PreToolDecision` 不落盤） |
| goal 阻擋 | `goal/change` 整份快照，含 `blockedReason?`（`session-log.ts:431-441`）；goal 工具的拒絕是 `isError` 的 `tool/result` | goal 續行輪 `turn/start{kind:'goal', goalId, revision, round}` 有記 |
| 計劃模式 | `plan/mode{active}`（`:700`），三個寫者（`nexus-plugin-plan-mode/src/index.ts:112,404,668`） | 計劃模式期間被擋的工具在結果裡是拒絕；計劃模式改了哪段系統提示詞不落盤（同 (b)） |
| 摘要壓縮 | `compaction/summary`（成功才有）＋每次呼叫一顆 `context/measure` | **壓縮失敗在日誌裡是沉默的**（`session-log.ts:585-589`）；`tool-result-pruner` 剪了什麼不記 |
| 重試 | `llm/retry`＋`llm/retry-started`，落在那一對 `model/start`／`end` 之間 | 放棄的那次（不重試）不寫；最終失敗只剩 `turn/failed{message}`，沒有分類碼（`:392`；`LlmFailure` 的註解說 #434 要定，`:211-217`） |
| 限流分類 | 在 `llm/retry.failure.code`（429→RATE_LIMIT） | 同上：沒排重試就沒有碼 |
| 輸出上限 | `turn/end{reason:{kind:'max-tokens'}}`；那則回覆的 `finish_reason` 原樣留著 | — |
| 中止 | `turn/end{reason:{kind:'aborted', cause}}`；半段回覆 `assistant/message{interrupted:true}` | — |
| 停止閘門、沙箱 fence | fence 擋下帶 `FS_SANDBOX_DENIED`（`tool-events.ts` 檔頭） | 停止閘門本身沒有事件（**待驗**：只看到 `context/measure` 的註解提到它） |

### (g) 最終輸出

- 一輪的最後一顆 `assistant/message`（沒有 `tool_calls`）就是最終回覆，後面接 `turn/end`。web 的歷史從它重畫。
- 缺口：沒有「這是最終輸出」的標記，要用位置判斷。被 `max-tokens` 截斷的那則清掉了呼叫，`finish_reason` 留著（`session-log.ts:521-522`）。

### (h) 輪次與連結鍵

| 鍵 | 有沒有 | 怎麼用 |
| --- | --- | --- |
| 會話 id | 有 | header `id`；子代理是 `<root>/<runId>` 或 `cli/tools:<uuid>` |
| `seq` | 有 | 單一日誌內單調 |
| turn id | **沒有** | 用位置推：往前找最近一顆不是 `resume` 的 `turn/start`（`isLogicalTurnStart`，`session-log.ts:1327-1329`）。各讀方共用這條規則 |
| step id | **沒有** | `model/start`／`model/end` 兩顆都是空物件，靠位置配對 |
| `callId` | 有 | `tool/call`↔`tool/result`↔`deliverables/presented`；也等於訊息 `tool_calls[].id` |
| `retryId` | 有 | 一次呼叫的所有重試共用 |
| 訊息 id | 部分 | `assistant/message` 帶供應商的 `chatcmpl-…`；`feedback/message-put` 靠它指到回覆 |
| 父子會話 | 部分 | header `parentSession`。**背景子代理**：父那顆 `tool/result.meta.runId` 對得上子會話 id（真實日誌第 21 顆）。**前景子代理**：`rg -n "53c40c2c" ~/.nexus-agent/sessions/2026-09-25T12-15-38-007Z-eef8c1ff/cli.jsonl` 零命中，父那顆 `task` 的 `callId` 與子會話 id 互不相指，只能用 `parentSession`＋時間窗猜 |

**只靠位置串不起一個步驟，真實日誌有三處現成反例**：

1. 第 7 顆 `session/title-llm-request`（標題模型，背景跑）落在主呼叫 6→11 那一對起訖之間。照位置歸，它會被算成主呼叫的一部分。
2. 第 23、24 顆 `inbox/spliced`（子代理回報進佇列）落在 22→27 那一對裡面。
3. `context/measure` 量的是送出之前的那份請求，卻寫在 `model/end` 之後（第 12、19、28 顆）。

dsh 的每一顆 `step/*`、`assistant/message`、`tool/call`、`tool/result`、`system/message` 都帶 `{turn, step}`（`types.ts:288-385`）。藍圖要的五個鍵（`episode_id`、`turn_idx`、`step_idx`、`attempt_id`、`source`，`blueprint.md:1130`）對到 nexus：`episode_id`≈會話 id（有）、`turn_idx`（位置推得出）、`step_idx`（**缺**）、`attempt_id`（**缺**，重試只有 `retryId`、沒有 `assistant/attempt`）、`source`（部分：`turn/start.kind` 與 `user/message.source`）。

---

## 3　遙測與離線工具

### 3.1　`@nexus/plugin-telemetry-otel`

- **輸出的是 OTel LogRecord，不是 span**。`rg -n "startSpan|Tracer|sdk-trace|getTracer|span" packages/nexus-plugin-telemetry-otel -g '!**/node_modules/**'` 零命中；相依只有 `api-logs`、`exporter-logs-otlp-http`、`otlp-exporter-base`、`resources`、`sdk-logs`（`package.json`）。
- 形狀：一筆會話事件鏡像成一筆 `ledger` 記錄，`attributes={session.id, event.type, event.seq}`，`body`＝事件 `data` 的深拷貝；另有 `ops` 通道，今天只有 `telemetry.op: 'shutdown'`（`session-telemetry.ts:36-56`；`session-telemetry-coordinator.ts:199-202`）。嚴重度：`turn/failed` 與 `isError` 的 `tool/result` 是 error，其餘 info（`session-telemetry.ts:20-27`）。
- **預設關閉**：`DEFAULT_TELEMETRY_MODE = 'disabled'`，只開 `feedback-only`（人送出回饋時把日誌補送到那一顆），`full` 拒收（`packages/nexus-plugin-telemetry-otel/src/index.ts:84-89,232-279`）。
- 跟會話日誌的關係：**純鏡像**，不加任何日誌裡沒有的資料，所以 (b)(d) 的缺口在遙測裡一樣缺。協調器在組裝點建（`apps/harness/src/agent-factory.ts:872` 的 `attachTelemetry`），不在 plugin 裡。
- 另一條旁路：LangSmith tracing 由環境變數開，送完整 inputs／outputs，`tracing.ts` 只負責披露（`apps/harness/src/tracing.ts:1-30`）。

### 3.2　離線讀日誌：`eval:sessions scan|draft`

- 進入點 `apps/harness/src/eval/sessions-cli.ts:21-33`：零憑證、不連線、不寫檔。
- `scan`（`session-scan.ts`）：逐份報步數、工具呼叫數、最長重複串（用提醒器同一把鍵）、工具錯誤依碼計數、中止輪、點踩輪、回饋，標出疑似打轉（第二道門檻 5）。
- `draft`（`session-draft.ts`）：以輪為單位撈四種信號（點踩、取消、`turn/failed`、打轉），排序後印成 `BenchmarkCase` 殼，`expected` 留給人填。
- **對真實日誌實跑的結果**（指令：`pnpm --silent --filter @nexus/harness eval:sessions scan|draft /private/tmp/live877-v1imaI/home/sessions`）：
  - scan：`t1 步數 5｜工具呼叫 3｜最長重複 subagent × 1｜工具錯誤 UNKNOWN_TOOL×1`。錯誤碼是錯的，見 2(e)。
  - draft：`候選 0 輪`、`沒有命中任何信號的輪`。這一輪模型沒照使用者要求做（見第 4 節），但四種信號都抓不到：沒有點踩、沒取消、沒失敗、沒打轉。
- 做得到：統計、打轉、錯誤分佈、從負向信號撈題。做不到：解釋**為什麼**某一輪回得不好，因為那需要第 4 節列的缺件；也沒有 trace 檢視器，只印終端。
- web 也沒有觀測面板：右側欄只有改動比對、交付預覽、計劃三種分頁（`apps/web/src/components/right-sidebar.tsx:35-37` 的 import）；`rg -n -i "trace|trajectory|軌跡|observab" apps/web/src -g '!*.test.*'` 零命中。成本只有頂列一顆 `SessionUsage` popover（`apps/web/src/components/session-usage.tsx`），只算 root。

---

## 4　重建能力：今天能不能回答「這一輪為什麼回得不聰明」

### 主例：真實日誌 `t1.jsonl` 第 3–21 顆

使用者說「用 subagent 在**背景**派一個子代理，reasoning_effort 指定 off……等它回報再告訴我」。

- 第 10 顆的推理寫著它不知道背景子代理怎麼回報結果，決定「改用前景比較安全」，於是違反使用者指示送出 `run_in_background:false`。
- 第 14 顆工具拒絕：前景不能指定 reasoning_effort。
- 第 17 顆模型才改回背景。最後答對了，但多花一次 62 秒、1203 token 的呼叫。

| 今天答得出來的 | 答不出來的 |
| --- | --- |
| 使用者原話（第 3 顆） | **模型讀到的 `subagent` 工具說明原文**：推理裡引用了說明（「You will be notified when a subagent finishes…」），但日誌沒有那份工具清單，無從核對說明有沒有講清楚背景子代理怎麼回報 |
| 推理全文（第 10 顆 content） | **系統提示詞**：有沒有講背景委派的回報機制 |
| 呼叫參數、拒絕原文（第 13、14 顆） | **那次請求實際生效的訊息串與工具清單**：`task`→`subagent` 的替換在 `wrapModelCall` 裡做，日誌看不到 |
| 模型 id、finish_reason（`response_metadata`） | **取樣設定**：溫度、topP、max_tokens、reasoning_effort |
| token 與推理 token（`usage_metadata`） | **寫這份日誌的程式版本**：header 是 v27、現行是 v29，工具說明這段期間有沒有改，無法從日誌確認；header 沒有 commit SHA、沒有外掛設定 |
| 第一次呼叫耗時 62.1 秒 | 首字延遲與解碼時間 |
| — | 正確的錯誤分類：日誌把拒絕記成 UNKNOWN_TOOL，scan 照著報錯 |

結論：**看得到「模型做了什麼、想了什麼」，看不到「模型當時被給了什麼」**。後者正是藍圖 M3 該傳 1(b)「每一步模型實際收到的完整輸入」，見第 5 節的特別標註。

### 最小缺件清單（照影響排序）

1. **每次呼叫送出的系統提示詞**，變了才記一份。對應 dsh `system/message`（`types.ts:319-330`）。
2. **每次呼叫送出的工具清單（schema）與呼叫設定**（provider、model、reasoning_effort、temperature、max_tokens），變了才記快照。對應 dsh `request/header{config, tools}`（`types.ts:240-251,390-397`）。
3. **步驟 id，以及每顆事件的 turn／step**。沒有它，第 2(h) 節的三個反例會讓歸因錯位。對應 dsh 所有事件帶 `{turn, step}`。
4. **請求期改寫的標記**：摘要切點已有；還缺 `tool-result-pruner` 剪了哪幾則、工具篩選拿掉哪些、外溢換掉哪些。對應藍圖 M3 該傳 3。
5. **header 補建置版本與外掛設定**（commit SHA、啟用的 plugin 與設定、模型型錄 id）。藍圖 M4 該傳 3 的「設定欄位」。
6. **結構化的決定**：核准的決定與理由（哪個 listener、allow／deny／ask、人怎麼回）；`turn/failed` 帶 `LlmFailure` 分類碼。
7. **修正 UNKNOWN_TOOL 誤標**（先驗現行是否仍觸發）。不修的話，離線工具會繼續報錯的結論。
8. （次要）每塊串流的時間，用來算首字延遲：dsh `assistant/message.stream`。失敗、沒有回覆的那次呼叫：dsh `assistant/attempt`。

### 這幾項跟 dsh 的關係：分兩類，不要當成同一包

第 1、2、3、8 項在 dsh 都是**核心 session 事件**（`types.ts:288-410`），但 nexus 這側的登記狀態不一樣：

**甲、已經登記成偏離、附了理由的**。方案要回頭檢驗這些理由今天還成不成立，不能直接寫「照 dsh 補」：

- 沒有 `turn`／`step`：`session-log.ts:538`（`assistant/message`）、`:732-735`（`tool/call`）、`llm-retry.ts` 檔頭、`model-calls.ts:6-18`（`model/start` 不是 `step/start`，因為 `wrapModelCall` 只包模型那一段）。
- 沒有 `stream`（所以沒有首字延遲）：`session-log.ts:533-535`。理由是寫入點看不到 v3 的逐字片段，只有 pump 看得到。這條理由若仍成立，首字延遲就不是在 core 照抄能補的，要從 pump 那側記。
- 沒有 `assistant/attempt`：`session-log.ts:536-537`，理由是沒有 `stream` 可記。

**乙、沒有獨立的偏離決定，只在別處被當成既成事實提到**：`system/message`、`request/header`、`request/context`。

- 搜尋：`rg -n "system/message|request/header|request/context" packages/nexus-core/src apps/harness/src -g '!*.test.ts'`，只命中三處，全是**因為沒有它而退一步**的註解：`summarization.ts:545-547`（「我們的日誌不記 system、工具定義與請求標頭，重建不出這份請求，所以退到只帶量測結果的一顆」）、`session-title-llm.ts:15-18`（「我們沒有 `request/header` 這種事件」）。
- 沒有找到一個說明「為什麼不記 system 與請求標頭」的決定。所以這一類照 AGENTS.md 是**照 dsh 補**；要不補，得先寫出「基座表達不出來」的理由並登記。

---

## 5　藍圖逐卡對照

### 「能不能做成插件」的三級

| 級 | 意思 | 先例 |
| --- | --- | --- |
| **L1 離線讀檔** | 不在產品路徑上，讀 jsonl | `eval/session-scan.ts`。地圖 #263 拍板：超出標準的評估只做在這一級（`session-scan.ts:8-10`） |
| **L2 日誌訂閱者** | 同一個行程，只訂閱日誌、不改呼叫鏈 | `apps/harness/src/session-title-llm.ts`（root 日誌的訂閱者，背景跑） |
| **L3 呼叫鏈上的 middleware** | `registry.middleware.use` 掛上，用 `sessions.forCall` 拿到該寫的那份日誌 | 提醒器、agent-instructions |

兩條限制要先講清楚：

- **今天插件不能自己新增事件種類，但這是 nexus 跟 dsh 的落差，不是標準的形狀**：
  - nexus：`SessionEventType` 是另寫的字面量聯集（`session-log.ts:153-184`），`append<T extends SessionEventType>` 綁的是它（`:1225`）。`SessionEventMap` 雖然是 interface（`:312`），宣告合併也進不了那個聯集。`rg -n "interface SessionEventMap|keyof SessionEventMap|SessionEventType =" packages apps -g '!**/node_modules/**'` 顯示只有 core 宣告它，沒有任何套件做過合併（套件裡的 `declare module '@nexus/core'` 全是擴 `NexusServices`，例如 `nexus-plugin-goal/src/index.ts:233-237`）。
  - dsh：`export type SessionEventType = keyof SessionEventMap`，註解寫「plugin-merged extensions included」（`references/deepseek-harness/packages/core/session/src/types.ts:430-431`）。擁有者套件用宣告合併加自己的事件。
  - nexus 已經在往那邊走：#679（`deliverables.ts:10`、`todo.ts:13`、`session-telemetry.ts:144`）說詞彙要由擁有者那側宣告；`interception-index.test.ts:325-327` 的絆索已經預備掃 `declare module '@nexus/core'` 裡的事件鍵。
  - 推論（C）：先把 `SessionEventType` 改成 `keyof SessionEventMap`（這一步本身就是照 dsh），之後只有 dsh 放在 core 的那幾顆（`system/message`、`request/header`、`step/*`）進 core；監控器分數、偵測器判定、修正嘗試這類 E3／E5 事件可以由插件自己宣告、自己寫。代價：要升格式版本，還要掃過各套件窮舉事件種類的地方（例如 goal 的 `fold.test`）。
  - 改之前的退路：另寫一份側檔，以 `(sessionId, seq)` 為鍵。這是偏離，要登記。
- **插件 middleware 看到的是被外層改寫過的請求**：`model-calls.ts:24-26` 說呼叫記錄器排在 plugin middleware 外層，摘要器、計劃模式提示詞、基座那幾顆又在更外層。插件那一格之內還有哪幾層改寫（例如 `invalid-tool-args`、`max-tokens` 排在內側，`model-calls.ts:49-52`）、插件 middleware 彼此的順序，要逐一列：**待驗**。也就是說，用插件記「模型實際收到的請求」不保證是最內層那一份。

類型縮寫：建＝建議做，避＝避免，量＝量測規則，待＝待決。「追溯」欄標 ★ 的卡跟「事後追溯一輪對話」直接相關。

### T3　觀測（12 張）

| 卡 | 類型 | 等級 | 一句話 | nexus 現況 | 插件級 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| T3-01 | 建 | B（雜訊） | 工具回傳先經「給模型看的介面」改寫：摘要式搜尋、固定視窗讀檔、空輸出明示、編輯後 lint 守門 | **部分**：有讀檔續讀（`read-continuation.ts`）、搜尋溢出（`search-overflow.ts`）、外溢（`spill-policy.ts`）、`fs-tool-errors.ts`；沒有 lint 守門；沒做過消融 | L3（`wrapToolCall`） | ★ 改寫後的版本才進日誌，原始回傳在外溢時只剩預覽 |
| T3-03 | 建 | B（雜訊） | GUI 動作用編號＋文字或專用 grounder，不讓通用 VLM 吐座標 | **不適用**（沒有 GUI agent） | — | |
| T3-09 | 建 | B（雜訊） | 監控器讀推理＋行動＋前一步上下文；推理沒寫出惡意只算弱證據 | **缺**監控器；推理有落盤（2(c)），原料在 | L1（離線），要即時則 L2 | ★ 監控器讀日誌就是事後追溯 |
| T3-11 | 建 | B（雜訊） | 有外部效果的動作執行前逐步打可疑分數，門檻校準到固定誤報率 | **部分**：有 pre-execute 核准 waterfall（`approval.ts:1-17`），沒有分數與校準；決定不落盤 | L3（`registry.approvals.gate`） | ★ 決定要結構化落盤才查得到 |
| T3-06 | 避 | B（雜訊） | 不拿單步離線分數當觀測改動的驗收 | **已遵守**：eval 是整題計分（`eval/compare.ts`） | L1 | |
| T3-10 | 避 | B（雜訊） | 不把讀推理的監控分數當 reward | **不適用**（不訓練） | — | |
| T3-05 | 量 | B（雜訊、稽核降級） | 觀測改動要同時贏過 FAIL 地板與重跑雜訊；記每題成本 | **部分→已有**：`eval/floor.ts` 三個平凡 agent（#1001）、題目區間與失敗計入成本（#1010）；成本只有 token | L1 | |
| T3-07 | 量 | **A**（雜訊） | 監控器的 F1／precision 旁邊列平凡分類器；recall 與誤報分開報 | **缺**：沒有監控器。最近的類比是 scan 的「疑似打轉」偵測，沒量過誤報 | L1 | ★ 任何事後偵測器上線前都要照這條 |
| T3-02 | 待 | — | 舊觀測留幾輪、截斷／摺疊／摘要 | **部分**：有摘要器、剪裁、`context/measure`；剪了什麼不記 | L3 | ★ M3 該傳 3「被摺疊的標記」 |
| T3-04 | 待 | — | GUI 觀測用截圖、a11y tree 還是 API | **不適用** | — | |
| T3-08 | 量 | C | 監控器評估資料別把答案、攻擊特徵或同一方的判斷放進去 | **缺**（沒有監控器） | L1 | |
| T3-12 | 待 | — | 非安全類異常（重複、迴圈、停滯）怎麼偵測 | **部分**：提醒器 3／5／8 是精確比對規則（`repeat-reminder.ts:1-14`），scan 用第二道門檻；沒有人工標註量誤報漏報 | L1／L3 | ★ |

### T4　軌跡（12 張）

| 卡 | 類型 | 等級 | 一句話 | nexus 現況 | 插件級 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| T4-04 | 避 | B（雜訊） | 沒量過 precision／recall 前，不接 LLM 評審判成敗 | **已遵守**：eval 評分器是純函式（`eval/scorers.ts:1-18`），沒有 LLM 評審 | L1 | ★ 事後評審要先量 |
| T4-05 | 避 | B（雜訊、稽核降級） | 結果成功的軌跡不等於過程正確；失敗模式要看成功組與失敗組的出現率差 | **缺**：draft 只撈負向信號、不算成功組的出現率 | L1 | ★ |
| T4-06 | 避 | B（雜訊） | 學出來的評分器併進獎勵後不能拿自己的分數判進度 | **不適用**（不訓練） | — | |
| T4-01 | 量 | **A**（雜訊） | 步驟評分器要直接量「最早錯誤步」，兩類 F1 取調和平均，BoN 對多數決 | **缺**：沒有步驟評分器；也沒有 step id 可以指 | L1 | ★ 要先有 step id |
| T4-02 | 量 | **A**（雜訊） | 錯誤偵測器的評估集要放進成功軌跡，分兩類報 | **缺** | L1 | ★ |
| T4-03 | 量 | **A**（雜訊） | 偵測器的頭條數字旁邊列多數類、猜第一步、隨機；命中用完全比對；長度分桶 | **缺**（沒有偵測器）；eval 那側已有地板（`floor.ts`），概念相同 | L1 | ★ |
| T4-07 | 量 | B（雜訊、稽核降級） | 自產軌跡反覆重訓時用驗證集挑輪數、報完整曲線 | **不適用**（不訓練） | — | |
| T4-08 | 待 | — | 軌跡用哪種格式記、失敗用哪套分類法標 | **部分**：有自訂的事件格式（31 種），沒有失敗分類法，也沒比較格式的轉換損失 | 核心（格式在 core） | ★ |
| T4-09 | 待 | — | SFT 時觀測 token 要不要算 loss | **不適用** | — | |
| T4-10 | 待 | — | 失敗軌跡要丟、降權、當負例還是 RL | **不適用** | — | |
| T4-11 | 待 | — | 要不要拆步驟層級訊號訓練 | **不適用** | — | |
| T4-12 | 待 | — | 軌跡異常偵測器能不能在執行期直接觸發修正 | **部分**：提醒器是「建議、不阻止」的執行期觸發，沒量淨效益與對→錯翻轉 | L3 | ★ |

### 邊 E3／E5／E6（只列跟追溯直接相關的欄位）

| 邊 | 要點 | nexus 現況 |
| --- | --- | --- |
| E3（T4→T5，異常觸發自我修正） | 生產端要帶：判定、位置（步驟索引、agent／span id，註明命中定義）、類別與分類法版本、偵測器身分與版本、在含成功與失敗的集合上量的兩種錯誤率；**不能傳** oracle、只在失敗軌跡上評過的位置（`blueprint.md:1071-1084`）。兩端「FPR／FNR」方向相反，欄位要寫成「把對的判錯的比率」與「把錯的放行的比率」（`:1129`） | 唯一的執行期觸發是提醒器：日誌有 `{tool, count}` 記號與觸發的那則訊息，**沒有偵測器版本、沒有錯誤率、沒有步驟索引** |
| E5（T5→T7，修正紀錄） | 每次修正嘗試的紀錄**含沒觸發的**：前後輸出、觸發判定與分數、送出的回饋、token 與呼叫數；迴圈內驗證器的「修好了」不能當標籤（`:1095-1102`） | 提醒器沒觸發的不記；沒有 `attempt_id`；提醒之後模型有沒有改，要離線自己比對（scan 的鏈重算可以借） |
| E6（T6→T7，互動紀錄） | 每集要帶模擬器身分、真人或模擬、誰結束與原因、逐則訊息原文；只有終態的紀錄不及格（`:1104-1111`） | 真人互動：逐則原文有（`turn/start`、`user/message`、`assistant/message`）、結束原因有（`turn/end.reason`）；**「真人或模擬」沒有標記**，eval 的 runner 跑的會話跟真人會話在日誌上分不出來（**待驗**：eval runner 有沒有寫會話日誌） |
| 共同連結鍵 | 五個鍵（`:1130`） | 見 2(h)：缺 `step_idx`、`attempt_id` |

### 特別標註：M3 該傳 1(b)「每一步模型實際收到的完整輸入」

- 整段裡跟「事後追溯一輪對話」最直接相關、證據也最硬的是這一欄（`blueprint.md:1221`）：TraceElephant 用同一個歸因器、同一份標籤，拿掉每一步的 input 欄位後，Static Agentic 的步驟層歸因從 0.30 掉到 0.19，agent 層從 0.66 掉到 0.56。作者說關鍵是「每次呼叫的實際決策脈絡有沒有被記錄」。證據標記是【直接（帶毛病：F1；F2 疑慮）】。
- 這一欄正好是 nexus 的 (b) 缺口，第 4 節主例也正是缺這一欄才答不出來。
- 同節「可能漏掉的欄位」裡還有兩條直接相關（`:1258,1268`）：模型的原始輸出與實際執行的動作（nexus 有：`assistant/message` 是改寫後的、`tool/call.arguments` 在解不開時是原字串，兩處不同，`session-log.ts:519-521`）；系統層中繼資料（拿掉後步驟層從 0.30 降到 0.23）。後者對到 nexus 的 header 缺建置版本與設定。
- M4 該傳 3（`:1278`）要的設定欄位（scaffold、預算、步數上限、種子、環境指紋、基礎設施狀態如限流）在 nexus 只有限流（`llm/retry`）落盤。

---

## 6　給方案的三點觀察（推論，標明）

1. **(b)(d)(h) 的缺口對到 dsh 的核心事件，但要分兩類處理**（見第 4 節末）：
   - `system/message`、`request/header`、`request/context` 沒有獨立的偏離決定，照 AGENTS.md 要照 dsh 補進 core。
   - `{turn, step}`、`stream`、`assistant/attempt` 已經登記成偏離、附了理由，要先檢驗理由今天還成不成立。例如「寫入點看不到逐字片段」若仍成立，首字延遲要從 pump 那側記。
   - 插件化與核心事件的分工：先把 `SessionEventType` 改成 `keyof SessionEventMap`（照 dsh，#679 的方向）。之後 dsh 放在 core 的那幾顆進 core，監控器、偵測器、修正紀錄這類事件由插件自己宣告、自己寫，正好符合需求 (2)。這是推論（C），代價見第 5 節開頭。
2. **「觀測對話與決策」側邊欄的資料**大部分已經在日誌裡（推理、工具卡、重試、壓縮、核准中斷），缺的是上面那組。**「評估任務成本」**今天只有 root 的 token，缺子代理加總、快取與推理細項（在訊息裡，要另折）、單價。單價在本 repo 完全沒有資料，見 memory「查不到單價可能是它不按 token 賣」。
3. **離線追溯工具要先修量具**：UNKNOWN_TOOL 誤標會讓 scan 報錯的結論；draft 的四種負向信號抓不到「照做但做錯方向」的輪（第 4 節主例，候選 0 輪）。要能抓這類，至少要一個「使用者明示指令 vs 實際參數」的偵測器，上線前照 T3-07、T4-02、T4-03 量誤報與漏報。

---

## 7　否定宣稱與搜尋紀錄

| 宣稱 | 指令（範圍） | 結果 |
| --- | --- | --- |
| 主對話系統提示詞沒有事件帶它 | `rg -n "\bsystem\b" packages/nexus-core/src/session-log.ts` | 只命中 `:918`（標題模型） |
| 日誌沒有溫度、topP、模型 id 欄位 | `rg -n "readonly tools\|temperature\|topP\|modelName\|model_name\|readonly model\b" packages/nexus-core/src/session-log.ts` | 只命中 `:230,246`（標題模型的 `SessionTitleModelIdentity`） |
| 沒有 turn id、step id | `rg -n -i "turnId\|turn_id\|stepId\|step_idx\|episode" packages/nexus-core/src/session-log.ts packages/nexus-core/src/session-store.ts` | 零命中；另讀 `SessionEvent` 定義 `session-log.ts:946-955` |
| 產品程式沒有請求 body 錄製 | `rg -n -i "record(ed)?Bod\|requestBody\|body.?log\|dumpBody\|capture.?body\|withRequestStartNotice" apps/harness/src packages -g '!*.test.ts' -g '!**/node_modules/**'` | 只命中 `withRequestStartNotice`（重試計時用）與 jsonl 讀檔的 `readBody` |
| 沒有單價資料 | `rg -n -i "pricePer\|costUsd\|usdPer\|per_million\|perMillion" apps packages -g '!**/node_modules/**' -g '!*.test.*'`；另 `rg -n -i "price\|pricing\|cost\|usd" apps/harness/src/model-catalog.ts` | 兩者都零命中（後者只命中 `$var`） |
| 遙測不產 span | `rg -n "startSpan\|Tracer\|sdk-trace\|getTracer\|span" packages/nexus-plugin-telemetry-otel -g '!**/node_modules/**'` | 零命中 |
| web 沒有 trace／觀測面板 | `rg -n -i "trace\|trajectory\|軌跡\|observab" apps/web/src -g '!*.test.*'` | 零命中 |
| 前景子代理連不回父呼叫 | `rg -n "53c40c2c" ~/.nexus-agent/sessions/2026-09-25T12-15-38-007Z-eef8c1ff/cli.jsonl` | 零命中（只查了這一份樣本） |
| 環境變數層沒有 debug／trace 開關 | `rg -n "NEXUS_[A-Z_]+" apps packages -g '*.ts' -g '!*.test.ts' -o` | 只有 `NEXUS_AGENT_HOME`、`NEXUS_OTLP_LOGS_URL` |
| `system/message`、`request/header`、`request/context` 沒有獨立的偏離決定 | `rg -n "system/message\|request/header\|request/context" packages/nexus-core/src apps/harness/src -g '!*.test.ts'` | 只命中 `summarization.ts:545`、`session-title-llm.ts:15,17,18`，全是「因為沒有而退」的註解 |
| 沒有套件合併 `SessionEventMap` | `rg -n "interface SessionEventMap\|keyof SessionEventMap\|SessionEventType =" packages apps -g '!**/node_modules/**'`；`rg -n "declare module '@nexus/core'" packages apps -g '!**/node_modules/**'` | 前者只有 core 宣告（其餘是測試裡的 `keyof`）；後者在非測試檔有 7 處，全是擴 `NexusServices` |
| 沒有測試釘住 subagent 拒絕的碼 | `rg -n "UNKNOWN_TOOL\|ToolNotFoundError" apps/harness/src/*subagent*.test.ts apps/harness/src/background-*.test.ts` | 零命中（範圍只有這兩組檔名） |

### 待驗清單

- UNKNOWN_TOOL 誤標在現行 develop 是否仍觸發。上面那條搜尋在 subagent／background 測試裡零命中，所以沒有測試釘住任一方向。
- 真模型走 CLI（非串流）時 `response_metadata.model_name` 有沒有。
- 中止的半段回覆帶不帶推理（`interrupted-reasoning.test.ts`）。
- 插件 middleware 之內還有哪幾層改寫請求；插件之間的順序。
- 停止閘門有沒有自己的事件。
- eval runner 跑的會話有沒有寫會話日誌、能不能跟真人會話分開。
- dsh 只讀了事件形狀，沒讀 `system/message`、`request/header` 的寫入時機與壓縮規則；要照抄前整份讀過。
