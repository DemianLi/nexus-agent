# dsh 在觀測、追溯、成本與評估上的實際做法（r3）

## 版本與量具

- **dsh SHA**：`5badb15009ae1756c3afe0ae0cef1faafc290ccc`，預設分支是 `master`，commit 時間 2026-10-03 11:48:13 +0800（release dsh-0.2.1-alpha.1 的 merge）。
  - `git fetch` 加 `pull --ff-only` 回報 Already up to date。
  - `git ls-remote https://github.com/deepseek-ai/deepseek-harness.git HEAD` 拿到的也是同一個 SHA。
  - 這份 clone 是 shallow（`--is-shallow-repository` 回 true），但舊盤點用的 `477b4f4`（2026-09-24）commit 物件還在本機，所以能直接 diff。
- **查證日期**：2026-10-04。
- **路徑寫法**：下文的 `檔案:行號` 都相對於上面那個 SHA 的 dsh 根目錄。
- **範圍**：本文只陳述原始碼證據，不替 nexus 做決定。
- **掃描工具**：
  - 直接呼叫 `/opt/homebrew/bin/rg` 與 `/usr/bin/git`，繞開 rtk。
  - 否定搜尋用的是 scratchpad 裡的 `scan.sh`。它用 bash 陣列傳參數，避開 zsh 不分詞的問題。
  - 範圍是 `packages/` 與 `apps/`，排除 `node_modules`、`tests/`、`*.spec.ts`、`*.i18n.yaml`、`*.zh.md`、`docs/i18n`、`*.json`，以及 `packages/extensions/tool-cordis/src/api-catalog.ts`（自動生成的型別目錄）。
  - **量具校準**：`imageCompressionConcurrency` 用同一支腳本命中 2 個檔案，證明排除規則沒有把整棵樹濾掉。
  - `package.json` 被腳本排除了，所以相依套件另外單獨搜。
- **profile 怎麼數**：
  - `packages/boot/app-boot/src/profile.ts:179-195` 的 `PROFILE_TEMPLATES` 有五個：acp、web、headless、sdk、sdk-minimal。前四個都是 base 加一個模式 bundle，sdk-minimal 只用自己那個 bundle。
  - web 另有四個 preset：standard、ptc、cordis、minimal（`packages/bundle/web-app/presets/*.patch.yml`）。
  - **第七個 profile `desktop` 不在 `PROFILE_TEMPLATES` 裡**。它由 `apps/desktop-host/src/index.ts:23-27` 啟動（`loadProfileDirectory('dsh', …)` 讀進 profile 目錄後，以 `profile: 'desktop'` 執行）。web-app bundle 與 base bundle 裡有幾列用 `ctx.get('profileContext')?.name === 'desktop'` 條件開關。
  - 「desktop 疊在 web-app bundle 上」是從這些條件列推論出來的，**沒有讀到它的 bundle 清單，標為待驗**。
  - 「dsh 出廠」以往只數 base、模式 bundle、sdk-minimal 和四個 preset，這次要把 desktop 也算進去。

---

## 1. 事件與日誌

### 1.1 日誌的樣子

- **單一事件溯源日誌**：
  - `SessionEventMap` 是可用 declaration merging 擴充的介面（`packages/core/session/src/types.ts:281`）。
  - 每一筆事件是 `{type, seq, time, data, ignorable?}`，再加上只出現在 surface 事件上的 `surfaceOp` 與 `sourceEventSeqs`（`types.ts:493-516`）。
  - 每一筆都帶 `time`（Unix 毫秒），所以各段延遲都能從日誌導出。
- **格式版本**：`SESSION_FORMAT_VERSION = 4`（`types.ts:89`）。新增一般事件種類不升版，靠每顆事件自己的 `ignorable` 旗標處理（`types.ts:74-88`、`:511`）。
- **落盤**：base 的 `session-persistence-jsonl` 與 sdk-minimal 的 `sessions`，跟舊盤點 O-02 相同，這次沒有重驗行號。
- **核心事件**（`types.ts:288-427`）：
  - `turn/start`、`turn/end{reason}`、`step/start`、`step/end`
  - `user/message`（有 `source` 區分真人、注入、goal 續行）、`developer/message`、`system/message`
  - `assistant/message{message, stream, usage?, interrupted?}`、`assistant/attempt{stream}`
  - `tool/call{name, arguments(原始字串)}`、`tool/result{message, error?{name,code,reason}, meta?}`
  - `request/header{header: {config(provider/model/reasoningEffort/取樣參數), adapterDefaults, tools}, reason}`、`request/context{provider, model, contextWindow}`、`session/end-seed`
- **`TurnEndReason`**（`types.ts:201-229`）：`completed`、`aborted{reason}`、`blocked`、`error{error: LlmFailure}`、`max-tokens`、`interrupted`、`forked`，可擴充。

### 1.2 各類內容有沒有記

| 項目 | 有沒有記 | 生產者證據 |
| --- | --- | --- |
| 思考內容（reasoning） | **有，全文加上逐片段時間** | 型別：`AssistantStreamRecord` 有一種 `reasoning-chunks{time0, dt[], texts[]}`（`packages/llm/llm/src/assistant-stream.ts:20-44`），內容塊有 `ReasoningBlock`（`packages/llm/llm/src/types.ts:67-71`、`:139`）。生產者：DeepSeek adapter 發出 `reasoning-delta`（`packages/llm/llm-deepseek/src/translate.ts:76`），pi-ai adapter 也發（`packages/llm/llm-pi-ai/src/stream.ts:169`）。agent-loop 把整段 `stream` 嵌進 `assistant/message`／`assistant/attempt` 再寫入（`packages/core/agent-loop/src/agent.ts:451`、`:469`、`:475`、`:492`、`:522`）。`rg -i reasoning` 掃 `session-persistence-jsonl/src`、`session-telemetry/src`、`session-log-deepseek/src`、`session-telemetry-otel/src`：**0 筆**，所以持久化與外送路徑上沒有程式專門剝掉 reasoning。遙測的脫敏走部署方自己掛的 waterfall，預設不脫敏（`packages/session/session-telemetry/README.md:12`）。用量另有 `TokenUsage.reasoningTokens`（`llm/src/types.ts:188`）。 |
| 模型請求 | **有，但只記重建請求需要的部分** | 每一步送出前寫 `request/header`（`agent.ts:620`、`:627`、`:633`），內含 call config 與工具 schema。系統提示走 `system/message`（`types.ts:234-251`）。請求本體不另存，原則是「模型看得到的，日誌裡就有」（dsh `AGENTS.md`，Conventions 段 "Model-visible ⟺ logged"）。 |
| 模型回應 | **有** | 成功的一步寫 `assistant/message`，附上完整串流與逐片段時間，並帶 `usage`（`types.ts:341-349`）。失敗、重試或中止的嘗試寫 `assistant/attempt`（`:355`）。重試另有 `llm/retry{provider, retry, delayMs, failure: LlmFailure}` 與 `llm/retry-started`（`packages/llm/llm-retry/src/types.ts:9-11`、`:13-37`）。 |
| 工具呼叫與結果 | **有** | `tool/call`（`packages/core/agent-loop/src/tool-calls.ts:264`）與 `tool/result`（`:282-289`）。`tool/result` 帶 `error.info` 與工具私有的 `meta`。 |
| 閘門：拒絕 | **有，但沒有獨立的事件種類** | `PreToolDecision` 的 `deny{reason, info?}` 會變成一筆 `isError` 的 `tool/result`，`info` 進 `error{name, code, reason}`（`packages/core/tools/src/index.ts:599-611`、`tool-calls.ts:282-289`）。 |
| 閘門：核准 | **有** | `approval/asked{id, toolName, callId?, reason?}` 與 `approval/decided{id, outcome}`（`packages/interaction/user-approval/src/types.ts:44-58`），寫入者在 `user-approval/src/index.ts:225`、`:232`。政策切換寫 `approval/policy`（`index.ts:40`）。`user-approval` 是 base 的一列（`packages/bundle/base/cordis.patch.yml:246`）。 |
| 閘門：重複呼叫提醒 | **有，但不是獨立事件** | 提醒放在 post-execute 決策的 `additionalContexts` 裡，source 是 `{kind:'repeat-tool-reminder', form:'notice', summary:'<tool> × <count>'}`（`packages/guard/repeat-tool-reminder/src/index.ts:212`）。agent-loop 把它寫成一筆注入的 `user/message`，看 `source` 就分得出來（README `:89` 起的 "Reminder delivery" 段）。計數只在記憶體，resume 之後歸零（README `:87`）。base 掛在 `cordis.patch.yml:456`。 |
| 閘門：goal 阻擋 | **有** | goal 狀態寫 `goal/change`（`packages/goal/goal/src/domain.ts:66`），內容是變更後的完整狀態。阻擋帶穩定碼，生產者有三個：`goal-round-driver` 的 `round-limit`（`packages/goal/goal-round-driver/src/index.ts:167-169`）、`queue-failed`（`:199-201`）、`prompt-rejected`（`:408-409`）；以及 `tool-goal` 的 `ctx.goals.block`（`packages/goal/tool-goal/src/index.ts:315`）。另一條路：pre-step 回 `reject` 時，那一輪以 `turn/end{kind:'blocked'}` 收尾（`agent.ts:316-318`）。會回 reject 的有 goal-round-driver（`:385`、`:426`）、hooks-claude-code、hooks-codex、session-controller 的封存閘門（`packages/api/session-controller/src/archived-session-gate.ts:29`）。 |
| hook | 有詞彙，**出廠不掛** | 事件是 `hook/invoked` 與 `hook/result`（`packages/hooks/hook-protocol/src/types.ts:19`、`:31`），寫入者在 `hook-protocol/src/events.ts:76`。`rg -n hook packages/bundle -g '*.yml'` 沒有任何 hooks 套件的列，所以出廠路徑上不會有這兩種事件。 |
| 其他決策與狀態 | 有 | `plan/mode`、`todo/write`、`compaction/start|summary|end|prune`、`sandbox/mode`、`permission/preset`、`agent-preset/selected`、`model/selection`、`command/run|done`、`feedback/record`、`feedback/message-put|delete`、`workspace/changes`、`deliverables/presented`、`subagent/descriptor|catalog`、`tool/ptc-dispatch(-start)`、`tool-workflow/*`、`schedule/change`、`session/title`、`image/offload`、`agent/inbox/spliced`、`session-log-deepseek/delivery-accepted`，共 30 個擴充檔（清單由 `rg -l "declare module '@deepseek-ai/dsh-session(/types)?'" packages apps` 取得）。 |

### 1.3 replay、resume、inspect、export 類功能

- **續接（resume）**：
  - headless 收 `--session-id <id>`，接手已存的會話；找不到就當場失敗（`packages/bundle/headless/src/startup.ts:44`、`packages/bundle/headless/README.md:54`）。
  - launcher 自己只有 `--dump-config` 系列（`apps/cli/src/args.ts:171`），沒有 resume 或 replay 旗標。
- **headless `--json`**：
  - 在 stdout 輸出換行分隔的事件流：`session`、`status`、`text`、`thinking`、`tool_call`、`tool_result`、`final`、`error`（`headless/README.md:58`）。
  - `thinking` 與 `text` 在那一步 commit 時才送，不是逐 token 送。
  - 預設模式下，reasoning 逐片段寫到 stderr（`:36`）。
- **匯出（export）**：
  - web-app 的 `session-log-download`（`dsh-session-log-export`）提供 `/export` 命令和會話標頭選單，把會話、子會話與附件打成 ZIP 下載（`packages/session-query/session-log-export/README.md:12`、`packages/bundle/web-app/cordis.patch.yml:74-76`）。
  - 只產生瀏覽器下載，沒有寫到 Host 路徑的匯出（README 第 30 行起的 "When to choose it" 段）。
- **查詢與追溯（inspect／trace）**：
  - `ctx.sessionQuery`（`packages/session-query/session-query/README.md:12`）提供清單、精確讀、有上限的事件前後文，以及會話或事件之間的關係追溯（trace）。
  - 全文搜尋出廠是關的：base 的 `session-query-sqlite` 設 `openAt: never`（`base/cordis.patch.yml:141-153`），web-app 在 `:22-30` 重述同一個值。
  - 給模型用的五顆唯讀工具 `tool-session-query`（`tool-session-query/README.md:12`）**不在任何 bundle 裡**（`rg -n tool-session-query packages/bundle -g '*.yml'`：0 筆）。
- **原始日誌檢視器**：
  - `packages/experimental/session-inspector` 提供 Raw Log 與 Chat Group 兩種檢視，以右側欄分頁 `session-inspector-log` 呈現（`packages/experimental/session-inspector/README.md:12`、`src/client/views/index.ts:28-29`）。
  - 它隸屬預設關的 `inspector-profile`（`packages/experimental/inspector-profile/README.md:12`），不在任何出廠 profile。
- **錄製重播**：`test:snapshot` 用錄好的會話重播 shipped profile，是 dsh 自己的測試工具，不是產品功能（dsh `AGENTS.md` Commands 段）。
- **否定搜尋**：
  - `scan.sh "name: 'replay'|'/replay'|replaySession|session-replay"`：0 個檔案。
  - 結論：dsh 沒有「重放一輪」這類產品功能；它的重建是讀日誌折疊出狀態。

### 1.4 trace、span、OTel 類套件

**有 OTel，但只用到 logs，不用 trace 或 span。**

- `packages/telemetry/otel`（`dsh-otel`，477b4f4 之後才新增）開出兩條通道：一般事件與 Session-log，每條各有自己的 exporter 與佇列（`packages/telemetry/otel/README.md:12`）。base 掛在 `base/cordis.patch.yml:188-189`。
- `session-telemetry`（擷取接縫，`SessionTelemetryRecord`）有兩個 channel：
  - `ledger`：與日誌事件一對一。
  - `ops`：只有 `agent-error` 與 `shutdown` 兩種訊號（`docs/subsystems/session-telemetry.md:10-60`）。
- 唯一的出廠後端是 `session-telemetry-otel`（`base/cordis.patch.yml:204-213`）：
  - 預設 `FEEDBACK_ONLY`：只有使用者送出回饋時，才把那一段會話前綴送到 `https://dsh-otel-collector.deepseeksvc.com/v1/logs`。
  - 它用 `capture: 'on-demand'` 建協調器（`packages/session/session-telemetry-otel/src/index.ts:218-221`），而 `agent/error` 的中繼只在 `capture: 'live'` 時註冊（`session-telemetry/src/coordinator.ts:116`）。所以出廠路徑上一筆 `agent-error` 都不會發，跟舊盤點 O-05 結論相同。
- **相依清單**：`@opentelemetry/api`、`api-logs`、`core`、`otlp-exporter-base`、`otlp-transformer`、`resources`、`sdk-logs`。**沒有 `sdk-trace`**，用 `rg "@opentelemetry/[^\"]+" packages apps -g package.json` 確認。
- **否定搜尋**：
  - `scan.sh "sdk-trace|startSpan|getTracer|SpanKind|@opentelemetry/sdk-trace"`：0 個檔案。
  - `scan.sh "langsmith|langfuse|opik|phoenix|helicone"`：0 個檔案。
- **另一條外送通道 `session-log-deepseek`**：
  - base 與 sdk-minimal 都掛著（`base/cordis.patch.yml:43-44`、`sdk-minimal/cordis.patch.yml:20-21`），預設 `enabled: true`。
  - 它在請求的 `dsh_session_log` 欄位裡增量上傳日誌的後綴，並寫一筆 `session-log-deepseek/delivery-accepted` 當水位（`packages/session/session-log-deepseek/README.md:12`、`:30`、`:33`、`src/types.ts:81`）。
  - **哪些請求會帶**：欄位是透過 `ctx.deepseekLlmApiExtensions` 註冊的，而全樹只有 `dsh-llm-deepseek` 這個 adapter 會呼叫 `prepareExtensions`（`packages/llm/llm-deepseek/src/host.ts:36`；`rg -n deepseekLlmApiExtensions packages/llm -g '*.ts'`，排除 tests）。所以只有走 `llm-deepseek` adapter 的請求會帶上；pi-ai 等其他 adapter 不會。
  - 如果 `llm-deepseek` 的 base URL 被改成非官方端點，是否仍然會送，**沒有驗**。
  - web 設定頁有開關 `ui-settings-session-log`（`web-app/cordis.patch.yml:414-415`）。
- **產品分析 `product-telemetry`**：
  - `desktop-product-telemetry` 與 `product-analytics` 兩列（`web-app/cordis.patch.yml:45-63`）只在 `profileContext.name === 'desktop'` 時才開。
  - 它送的是挑選過的互動事件，**不自動收集任何 Session 資料**（`docs/subsystems/product-telemetry.md:5`）。

---

## 2. 成本與用量

### 2.1 token 分桶

- **單次呼叫的用量 `TokenUsage`**（`packages/llm/llm/src/types.ts:175-189`）：
  - 欄位有 `inputTokens`、`outputTokens`、`totalTokens?`、`cacheReadTokens?`、`cacheWriteTokens?`、`reasoningTokens?`。
  - 三個輸入桶**互斥**：`inputTokens` 只算未命中快取的輸入，計費的輸入是三者相加。DeepSeek 的 `prompt_tokens` 由 adapter 扣掉快取部分（`:169-174`）。
- **寫在哪裡**：
  - 用量跟著 `assistant/message.usage` 一起寫，沒有獨立的用量事件（`session/src/types.ts:331-347`）。
  - 失敗或重試的嘗試，用量留在 `assistant/attempt.stream` 的最後一個 `usage` chunk 裡（`packages/llm/token-meter/src/usage-projection.ts:80-85`）。

### 2.2 總帳的所有權（誰寫、誰讀、持久化嗎）

- **唯一的事實來源是會話日誌**。總帳全部都是從日誌導出的折疊結果，沒有另外一份帳。
- **`tokenUsage` 投影**（`token-meter`，base 掛在 `cordis.patch.yml:338-339`）：
  - 四桶加總：`uncachedInputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens`（`usage-projection.ts:14-26`、`:112-145`）。
  - 同一步的新樣本會取代舊的；遇到 `llm/retry-started` 就關掉取代槽，所以重試的那次也會加進總帳（`:116-121`）。
  - 失敗的 attempt 只要報了用量就算進去。
  - 透過 `wire` 欄位交給 client（`:144`）。
- **`contextPressure` 投影**（`:173-212`）：上下文占用量，分子是最新一次的 usage，分母是 `request/context.contextWindow`。
- **`contextBreakdown` 投影**（`breakdown-projection.ts:1-40`）：把上下文拆成 system、tools、messages 三份的啟發式估算。
- **`TokenMeter.measure()`**（`docs/subsystems/token-meter.md:5-40`）：給 compaction 用的請求壓力估算，**不是帳本**。README 明寫它不是 billing（`packages/llm/token-meter/README.md:68`）。
- **逐輪用量 `TurnTokenUsage`**（`turn-usage.ts:6-26`）：
  - 欄位有每輪的 `uncachedInputTokens`、`outputTokens`、`totalTokens`、`cacheRead/Write?`、`reasoningTokens?`、`routes[{provider, model}]?`。
  - **這是 client 端的折疊，不是 host 投影**：它由 `@deepseek-ai/dsh-token-meter/client` 匯出（`client.ts:8`），在 `ui-chat` 的 `conversation-nodes/turn-tail.ts:91` 對那一輪的事件呼叫 `deriveTurnTokenUsage`。
  - 這跟投影文件「clients never fold domain events」（`docs/subsystems/session-projection.md:5`）的說法有落差，只陳述、不判斷。
- **`sessionStats` 投影**（`session-stats`，只在 web-app 掛，`web-app/cordis.patch.yml:100-103`）：
  - 欄位有 `turns`、`steps`、`llmMs`、`toolMs`、`ttftMs`、`ttftSteps`、`decodeMs`、`decodeTokens`（`packages/session/session-stats/src/projection.ts:31-48`）。
  - 時間怎麼取：模型時間是 `step/start` 到 `assistant/message`；首字是第一個非空的 delta；工具時間按 callId 配對 `tool/call` 到 `tool/result`（`:1-23`）。
- **持久化**：
  - 投影狀態只是加速用的檢查點。base 的 `session-projection-cache`（`cordis.patch.yml:182-183`）在建會話、每個 `turn/end`、釋放會話時都會寫（`packages/session/session-projection-cache/README.md:57`）。
  - 快取壞掉就當作不存在，由需要的人重新從日誌折疊（`:85`、`:129`）。
- **金額**：**dsh 沒有**任何以貨幣計的單次、每輪或整個會話成本，也沒有預算。
  - goal 的上限只算輪數，「does not meter tokens, currency, wall time」（`packages/goal/goal/README.md:158`）。
  - 唯一跟貨幣有關的是帳戶錢包餘額（`currency: 'CNY'|'USD'`，`packages/credentials/deepseek-account/src/types.ts:55`、`:72`）。它由 base 的 `deepseek-account` 與 web-app 的 `ui-settings-account` 在設定頁顯示，屬於帳戶層級的餘額，不是會話成本。
  - 否定搜尋 `scan.sh "costUsd|cost_usd|totalCost|pricePer|per.?million|spend.?limit"`：0 個檔案。`scan.sh "\bUSD\b|\bCNY\b"`：3 個檔案，全是帳戶錢包。
  - `route-pricing.ts` 算的是圖片轉成多少 token，不是金額（`route-pricing.ts:1-5`）。

### 2.3 UI 顯示什麼

**只列有哪些面，不當設計依據。**

- **`ui-chat` 的 `StatsPills`**：放在 composer dock，用 `conversation.composer.dock` 的 list entry（`packages/client/ui-chat/src/client/chat/StatsPills.tsx:1-5`）。
  - 活動 pill：輪數、步數、LLM 時間、工具時間、TTFT、tokens/s。
  - 用量 pill：快取命中率、輸入、快取讀、快取寫、輸出（locale key 在 `:244-328`）。
- **`TurnUsagePanel`**：每一輪完成後出現一個 pill 加一個明細對話框，內容有總量、快取命中率、各桶數字、provider/model 路由（`TurnUsagePanel.tsx:1-60`）。
- **`ui-subagent`**：子代理清單顯示 token 用量與這一輪的執行時間（`packages/client/ui-subagent/README.md` Summary）。
- **`ui-trajectory`** 的 record inspector：顯示每筆紀錄的 token 用量、耗時、輸入與輸出（`packages/client/ui-trajectory/README.md:12`）。

---

## 3. dsh 的 UI 與面板

**只列有哪些面，不當設計依據。**

### 3.1 插件怎麼貢獻 UI（宣告式機制）

- **Slots**（`docs/subsystems/slots.md:5-16`）：
  - feature plugin 用 `ctx.slots.register()` 貢獻 React 元件，不 import 別的 feature plugin 的元件。
  - `SlotMap` 用 declaration merging 宣告插槽的鍵、基數（cardinality）、作用域與 owner props。
- **右側欄分頁**（`docs/subsystems/sidebar-right.md:13-46`）：
  - 用 `ctx.sidebarRightTabs.register({id, kind, patterns?, priority, canOpen?, title, guide?, keepMounted?})` 宣告一種分頁類型。
  - 正文用 `ctx.slots.register({name:'sidebar.right.pane.tab', key:id}, Body)` 掛上去。
- **資料路徑**：
  - host 端的 domain 註冊一個純折疊 `ProjectionDefinition`，帶 `wire` 欄位的才會送到 client。
  - 再由 `session-controller` 的 history tail 與 `session/projection` 推送幀送達（`docs/subsystems/session-projection.md:5-20`）。
  - client 用 `useProjection` 讀（`packages/api/session-controller/src/client/contract/session.ts`）。
- **瀏覽器 roster**：瀏覽器端要載哪些模組，由 `dsh.client` 的 roster 列決定（`web-app/cordis.patch.yml:41-42` 的註解）。

### 3.2 有哪些面

- **右側欄分頁種類**（由 `rg -A3 "sidebarRightTabs.register\(" packages` 取得）：
  - `guide`、`files`、`text`（文件預覽）、`browser`、`terminal`
  - `plan`（`packages/client/ui-plan/src/client/index.ts:65-66`）
  - changes-review（`ui-deliverables/src/client/index.ts:86`）
  - schedule task（`ui-schedule/src/client/index.ts:155`）
  - `subagentchat`（`ui-subagent/src/client/sidebar-chat/index.tsx:181-183`）
  - `session-inspector-log`（實驗性，不出廠）
- **其他位置**：
  - Trajectory：對話 view ring 裡的一個分頁（`ui-trajectory/README.md:28`），web-app 掛在 `:445-446`。它把 User、Assistant、Tool、Subtool、compaction 排成一份帳，加上時間軸，點開有 record inspector。
  - 輪次大綱：`session-turn-outline` 投影供對話旁的 turn rail 使用（`web-app/cordis.patch.yml:105-108`）。
  - Goal：輸入框上方的 GoalBar（`web-app/cordis.patch.yml:392-394`、`ui-goal/README.md:12`）。
  - 統計：在 composer dock（見 2.3）。
  - 背景工作：`ui-jobs` 放在會話標頭（`ui-jobs/README.md:12`）。
  - 核准：`ui-approval` 接管 composer（`ui-approval/README.md:12`）。
  - todo：由 `ui-tool` 的工具卡渲染，有 `todo-history` 模型（`packages/client/ui-tool/src/client/tool/models/todo-history.ts`）。
  - 回饋：`ui-message-feedback` 在訊息動作列放讚與倒讚（`web-app/cordis.patch.yml:396-400`）。
  - workflow：`ui-workflow-run` 是一個對話節點。
- **dsh 沒有**任何叫「觀測」「決策紀錄」「成本」的面板或側欄分頁。
  - 否定搜尋 `scan.sh "decision.?(log|panel|trace|view)|audit.?(panel|view|log)"`：2 個檔案，都是誤中（Windows inspector，以及 user-approval README 說 approval 事件是 log-only 稽核紀錄）。
  - 最接近的是 Trajectory（逐筆紀錄加用量與耗時）和 StatsPills（整個會話的總計）。

---

## 4. 評估

- **結論不變**：開源 repo 的產品路徑上沒有評估、評分或回歸機制。
- `.docs/dsh-measurement-practice-2026-10-04.md` **用的就是同一個 SHA 5badb15**，所以不可能有版本漂移。這次沒有重做它的全面掃描，搜尋清單見該檔第 70-85 行。
- **抽查四處引用，全部吻合**：
  - `BENCHMARK.md:3`：只教人用 Python SDK 驅動 sdk-minimal。
  - `packages/goal/goal/README.md:159`："No independent evaluator"。
  - `docs/testing.md:33-35`："Verify the world, not the self-report"。
  - `session/src/types.ts:331-347`：usage 跟著 `assistant/message` 走。
- **補跑兩條**：
  - `scan.sh "evaluator|grader|scorer|rubric|llm.?as.?a.?judge"`：15 個檔案，都是 goal、ralph 的「沒有 evaluator」聲明，或 cordis、typert 的表達式求值器，跟該檔第 79 行的判讀一致。
  - `benchmarks/` 底下的情境全是效能題：`active-stream-reconnect`、`agent-continuation`、`conversation-fold`、`long-session-browser`、`session-corpus`、`session-open`、`terminal-io`。
- **有關但不是評估**：
  - `command-feedback` 寫 `feedback/record{text?, category?}`（`packages/feedback/command-feedback/src/types.ts:27-43`）。
  - `message-feedback` 寫 `feedback/message-put|delete`（`packages/feedback/message-feedback/src/types.ts:56-58`）。
  - 兩者都是 log-only，不進模型上下文。這些回饋的唯一出廠用途是授權 OTel 送出那一段前綴（`session-telemetry-otel/src/index.ts:45`、`:222-223`），沒有彙總或評分。
- **盲區**：
  - 「dsh 沒有」只對這份開源 repo 成立；評分程式與任務集不在樹上。
  - 只讀了單一 SHA。

---

## 5. 意圖、狀態、反思（藍圖 T1、T2、T5）

| 藍圖項 | dsh 對應機制 | 判定 | 證據 |
| --- | --- | --- | --- |
| T1 意圖偵測 | compaction 摘要指令裡的「Primary Request and Intent」段 | **像但不是**：只在壓縮上下文時，讓模型把使用者意圖寫成摘要的一段，沒有分類器，也沒有在每一輪偵測 | `packages/compaction/compaction-basic/src/summarizer.ts:37`（同一份指令還有 `:46` Errors and Fixes、`:55` Next Step）。出廠：base 第 341-342 行，加上 standard／ptc／cordis 三個 preset。 |
| T1 意圖偵測 | 獨立的意圖分類或偵測 | **沒有** | `scan.sh "intent.?(detect|classif)|classify.?intent|user.?intent|intent.?classif"`：5 個檔案，都是「user intent」的一般用語（`permission-presets/src/index.ts:54` 的「durable, log-only user intent」指使用者選了哪個 preset；speech-to-text、ui-schedule 也是一般用語）。 |
| T2 狀態追蹤 | goal（跨輪的持久目標，有狀態、輪數、阻擋碼） | **有** | `packages/goal/goal/README.md` Summary 段、`domain.ts:66`。出廠：base 的 goal、goal-round-driver、command-goal、tool-goal（`cordis.patch.yml:314-320`、`:438`），加上 standard、ptc、cordis 三個 preset。minimal preset 與 sdk-minimal 沒有。 |
| T2 狀態追蹤 | todo（模型維護的任務清單，跨輪、resume 後還在） | **有** | `packages/todo/tool-todo/README.md` Summary 段、`todo/write` 事件（`tool-todo/src/types.ts:31`）。出廠：base 第 431 行，加上三個 preset。 |
| T2 狀態追蹤 | plan mode | **像但不是**：它記的是「目前在不在規劃模式」，加上一份待審的計劃文件，不追蹤執行狀態 | `plan/mode` 事件（`packages/plan/plan-mode/src/index.ts:52`）、README Summary 段。 |
| T2 狀態追蹤 | 外部世界或工作區的狀態追蹤器 | **沒有** | `workspace/changes` 只記 agent 寫了哪些檔，供交付物使用（`packages/deliverables/workspace-changes/src/types.ts:106`），沒有通用的狀態模型。 |
| T5 反思與自我修正 | repeat-tool-reminder | **像但不是**：只在偵測到完全相同的重複呼叫時，注入一段提醒；只建議，從不阻擋，也沒有評估成果 | 見 1.2 那一列。 |
| T5 反思與自我修正 | goal 完成或阻擋 | **像但不是**：由模型自己宣告完成或卡住，明文寫「No independent evaluator」 | `goal/README.md:159`、`tool-goal/README.md:149`（引自量測文件）。 |
| T5 反思與自我修正 | tool-ralph（每一輪開新的子代理，只帶上一輪的報告） | **像但不是**：重複迭代，但報告「not independently verified」；base 與三個 preset 都 `disabled` | `packages/workflow/tool-ralph/README.md` Summary 段、量測文件的 profile 表。 |
| T5 反思與自我修正 | PTC 失敗時把 logs 回給模型「so the model can self-correct」 | **像但不是**：這是工具錯誤回報的格式，不是反思機制 | `packages/core/tools/src/ptc.ts:173`。 |
| T5 反思與自我修正 | 實驗性 auto-review 閘門 | **像但不是**：由另一次模型呼叫審查工具效果；不在任何 profile | 量測文件第 47 行。 |
| T5 反思與自我修正 | 專門的反思或自我批評步驟 | **沒有** | `scan.sh "self.?critique|\bcritique\b"`：0 個檔案。`scan.sh "self.?reflect|\breflection\b"`：15 個檔案，都是 typert 的型別 reflection 與 pwsh 的一般用語。`scan.sh introspect`：3 個檔案，都是 ui-settings 的 schema introspection。`scan.sh "self.?correct"`：3 個檔案，都是錯誤回報的說明。`.agents/notes`（不含 zh 與 i18n）搜 `reflect|critique|self.?correct|introspect|intent`：命中的都是一般用語；最相近的提案 `2026-08-04-task-surface.md` 是結構化 UI 表單，不是反思。 |

---

## 6. 對照我們兩份文件，有沒有被推翻

### 6.1 `.docs/dsh-measurement-practice-2026-10-04.md`

**同一個 SHA，沒有被推翻。**抽查見第 4 節。

### 6.2 `.docs/seven-layer-inventory-2026-09-26.md`

- **用的版本**：O 層的 dsh 欄是以 477b4f4 為準。
- **怎麼比的**：
  - 跑 `git diff --stat 477b4f4 5badb15 -- packages/bundle packages/session packages/llm/token-meter packages/telemetry packages/host/product-telemetry-otel packages/client/product-analytics packages/session-query packages/client/ui-trajectory packages/feedback`：209 個檔案。
  - 逐條讀了 bundle 與 telemetry 的程式碼 hunk，其餘只看了 stat。

| 列 | 原本的 dsh 結論 | 5badb15 的狀況 |
| --- | --- | --- |
| **O-09 執行期不變量** | 「只在 sdk-minimal 出廠」 | **推翻**：dsh 已經整組移除。`packages/runtime-diagnostics/` 從版控消失（`git ls-tree 5badb15 packages/runtime-diagnostics/` 為空；本機只剩 `invariants/node_modules` 殘留）。sdk-minimal 的五列被刪掉（diff 的 `sdk-minimal/cordis.patch.yml` 第 103 行附近）。升級指南 `docs/upgrade-guide/v0.2.0-rc.2/remove-runtime-invariants/guide.md:12-14` 寫明不再發佈 `@deepseek-ai/dsh-invariants` 與任何 `<package>/invariant`。`rg dsh-invariants packages apps`：0 個檔案（不含 node_modules）。這跟 nexus 的 invariant 配套決策（記憶 invariant-companions-decision）直接相關。 |
| **O-03 OTel 遙測** | 只講 `session-telemetry-otel` 的 FEEDBACK_ONLY 與 DISABLED；否定搜尋 `product-telemetry` 在 bundle 裡 0 筆 | **不完整，兩處要修**：① `session-log-deepseek` **在 477b4f4 就已經**在 base 與 sdk-minimal 裡（`git show 477b4f4:packages/bundle/base/cordis.patch.yml` 第 43 行），預設 `enabled: true`，打官方 API 時就在請求裡上傳日誌後綴。這是第二條外送通道，舊盤點漏了。② `product-telemetry` 的否定搜尋已不成立：現在 web-app 的 `:45-63` 有它，但只在 desktop profile 開，而且不收 Session 資料。另外 base 新增一列 `otel`（`dsh-otel`，`:188`），collector 網址換成 `dsh-otel-collector.deepseeksvc.com`，並新增 `maxRequestBytes: 4000000`。後端仍然只有 FEEDBACK_ONLY 與 DISABLED 兩種模式（`session-telemetry-otel/src/index.ts:34-39`）。 |
| O-05 agent-error | 出廠不發 | **成立**：仍是 on-demand（`session-telemetry-otel/src/index.ts:218-221`），relay 在 `coordinator.ts:116` 只對 live 註冊。這次的 diff 只把 record 改成 envelope 加 body。 |
| O-06 token 用量 | 四桶 | **成立**；行號沒變（`llm/src/types.ts:186-187`）。補充：還有 client 端的逐輪 `TurnTokenUsage`，帶 reasoningTokens 與 routes，舊盤點沒列。 |
| O-07、O-08 session-stats、ttft、decode | web-app `:83` | **成立**；行號漂到 `:102-103`。 |
| O-12 匯出 | web-app `:56` | **成立**；行號漂到 `:74-76`。 |
| O-14 軌跡、大綱、清單 | web-app `:425`、`:89`、`:97` | **成立**；行號漂到 `:445-446`、`:107-108`、`:117-118`。 |
| O-15 成本、預算、metrics、health | dsh 也沒有 | **成立**：見 2.2 的否定搜尋。補充：設定頁會顯示帳戶錢包餘額，那是帳戶層級，不是會話成本。 |
| O-16 sessionQuery | 全文搜尋出廠關 | **成立**（`base/cordis.patch.yml:141-153`）。補充：`tool-session-query` 不在任何 bundle。 |
| O-01、O-02、O-13、O-18 | — | 這次沒有看到推翻的證據。`SESSION_FORMAT_VERSION` 仍是 4。照舊盤點的量法重數 `declare module '@deepseek-ai/dsh-session/types'` 的非測試命中行數，結果是 30，跟舊盤點相同。 |

---

## 7. 後設：每個「沒有」用的搜尋

**共同設定**：範圍與排除見開頭；scan.sh 的校準對照組命中 2 個檔案。

| 宣稱 | 指令（範圍 `packages/`＋`apps/`） | 命中 |
| --- | --- | --- |
| 沒有 OTel trace 或 span | `scan.sh "sdk-trace|startSpan|getTracer|SpanKind|@opentelemetry/sdk-trace"`；相依另外用 `rg '"@opentelemetry/[^"]+"' -g package.json` | 0；相依裡沒有 sdk-trace |
| 沒有第三方 tracing | `scan.sh "langsmith|langfuse|opik|phoenix|helicone"` | 0 |
| 沒有 replay 命令或功能 | `scan.sh "name: 'replay'|'/replay'|replaySession|session-replay"`；`apps/cli/src/args.ts` 的旗標 | 0；launcher 只有 `--dump-config` 系列 |
| 沒有金額成本或預算 | `scan.sh "costUsd|cost_usd|totalCost|pricePer|per.?million|spend.?limit"`、`scan.sh "\bUSD\b|\bCNY\b"` | 0；3 個檔案全是帳戶錢包 |
| 沒有觀測、決策、成本面板 | `scan.sh "decision.?(log|panel|trace|view)|audit.?(panel|view|log)"`；外加逐一列出 `sidebarRightTabs.register` | 2 個誤中 |
| 持久化與外送路徑不剝 reasoning | `rg -n -i reasoning` 掃 session-persistence-jsonl、session-telemetry、session-log-deepseek、session-telemetry-otel 四個套件的 `src` | 0 |
| hooks 不出廠 | `rg -n hook packages/bundle -g '*.yml'` | 只中一句無關的註解 |
| tool-session-query 不出廠 | `rg -n tool-session-query packages/bundle -g '*.yml'` | 0 |
| invariants 不出廠、不存在 | `rg dsh-invariants packages apps`；`git ls-tree 5badb15 packages/runtime-diagnostics/` | 0；空 |
| 沒有意圖分類 | 見第 5 節 | 誤中 |
| 沒有反思或自我批評 | 見第 5 節 | 0 或誤中 |
| 沒有評估器 | `scan.sh "evaluator|grader|scorer|rubric|llm.?as.?a.?judge"` | 15 個，全是聲明或誤中 |

### 待驗

- hooks 與 user-approval：`rg -n "hooks-|user-approval" apps/desktop apps/desktop-host apps/cli/config` 為 0 筆，所以 apps 這一側也沒有掛 hooks。
- desktop profile 的完整條目沒有逐列列出，只確認了 product-telemetry 與 deepseek-account 的條件式。
- `llm-deepseek` 的 base URL 改成非官方端點時，`dsh_session_log` 會不會照送，還沒有驗。
- `ui-trajectory` 與 `StatsPills` 的實際畫面沒有跑起來看，只讀了原始碼與 README。
