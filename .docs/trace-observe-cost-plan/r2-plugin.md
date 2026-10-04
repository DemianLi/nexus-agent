# R2：插件契約能承載什麼、web 怎麼吃插件資料、做「觀測插件」會撞到什麼

對讀：nexus `develop` 501e153（2026-10-04）；dsh clone `references/deepseek-harness` `5badb15`（2026-10-03）。
唯讀研究，未改 repo 任何檔。標「讀碼推得」＝沒實測；標「待驗」＝我沒查到底。

---

## 0. 一段話結論

1. **後端那半大致做得到、而且大半已經記著**：插件經 `registry.sessions.join` 拿得到每一份會話日誌（root＋每個子代理，CLI 與 serve 都接），日誌上已有 `turn/*`、`model/start|end|usage`、`llm/retry*`、`assistant/message`（含推理）、`tool/call|result`、`compaction/summary`、`context/measure`、`interrupt/raised`。dsh 的 `ui-trajectory` 本身就是「對既有會話日誌的純投影」（`references/deepseek-harness/packages/client/ui-trajectory/README.zh.md` 理解實現段：「視圖是純投影」），所以「觀測」的檢視那半**主要缺投影與畫面，不是缺記錄**。
2. **前端那半今天做不到「插件宣告一個面板」**：從插件到畫面的每一跳都是寫死的封閉集合（見 §3 的鏈）。web 沒有面板／分頁註冊點，harness 沒有 HTTP 路由註冊點，pump 的事件→frame 是 if/else，wire 的 frame 表與 reducer 是窮舉，`ConversationState` 欄位固定。
3. **真正缺的記錄**（各有 dsh 對應物）：每次請求的 prompt／工具／模型（dsh `request/header`）、失敗的那次嘗試（`assistant/attempt`）、每次呼叫的模型 id、核准的問與決（`approval/asked|decided`）、`turn/failed` 的分類碼（#434）、快取讀寫兩桶（#724）、串流計時／TTFT。這些多數要改 **core 的記錄器**，而 core 記錄器**不是插件條目能關掉的東西**——與「萬物皆可插件」有張力，要 demian 拍板。
4. **插件自己要寫新事件種類，今天寫不進去**：`SessionLog.append<T extends SessionEventType>` 吃的是 core 手寫的封閉聯集；#679 第 4 步（`keyof SessionEventMap` 開放詞彙）還沒做、等 demian 拍板。

---

## 1. `NexusPlugin` 契約全貌

### 1.1 plugin 與條目

- `NexusPlugin<TConfig> = { name, requires?, Config?, apply(registry, config) }` —— `packages/nexus-core/src/plugin.ts:53-81`。
  - `name` 不唯一，是停用視圖與 core 條目開關的比對鍵（`plugin.ts:54-59`）。
  - `requires` 只做存在性檢查、不排序（`plugin.ts:61-65`），服務名也查得到（`registry.ts:303-306`）。
  - `Config` 是 zod schema，每層 `strictObject`、未知欄位載入失敗（登記過的偏離，`plugin.ts:27-35`）。
  - plugin 是模組層級常數，**每次掛載的狀態要活在 `apply` 裡**（`plugin.ts:47-49`）。
- 條目 `PluginEntry = { id?, disabled?, plugin, config? }` —— `plugin.ts:95-130`；`disabled: true` 時 `apply` 一次都不跑、設定不驗（`plugin.ts:108-122`）。
- 產品路徑上條目來自 `apps/harness/cordis.yml`＋home patch＋`--patch`，`name` 以動態 `import(entry.name)` 載入（`apps/harness/src/plugin-config.ts:675`）——**裸套件名要能從 `apps/harness` 解析，所以新套件要進 `apps/harness/package.json` 的 dependencies**（現有 `@nexus/plugin-telemetry-otel` 就在 `apps/harness/package.json:59`）。

### 1.2 `PluginRegistry` 的 17 個欄位（`registry.ts:904-924`）

9 個**折進 `createDeepAgent`** 的註冊點（`registry.ts:4-7`，折疊在 `fold.ts`）：

| 欄位 | 能貢獻 | 掛點／語意 |
| --- | --- | --- |
| `tools` | `StructuredTool`（可 `scope`、`rootOnly`、`outputSchema`） | 同層同名報錯、跨層遮蔽（`registry.ts:76-166`） |
| `subagents` | deepagents `SubAgent` | 同名報錯（`:170-188`） |
| `capabilities` | 能力名 | 冪等、多提供者，給 `requires` 用（`:191-214`） |
| `backend` | 檔案 backend 掛到 `routePrefix` | **是檔案系統路由，不是 HTTP**（`:368-384`） |
| `middleware` | `AgentMiddleware`（`use`／`useWithBackend`，`prepend`／`last`） | 同一份實例掛 root 與每個子代理，**不能放逐 agent 的閉包狀態**（`:427-472`，尤其 `:435-440`） |
| `permissions` | deny glob | 只擋讀寫意外（`:483-497`） |
| `approvals` | `PreToolListener`（waterfall，allow/deny/ask） | 註冊順序即執行順序（`:517-533`；`approval.ts:57-72`） |
| `skills` / `memory` | 來源路徑 | `:536-571` |

8 條**不折進去**的通道（`registry.ts:9-26`）：

| 欄位 | 能貢獻 | 掛點／語意 |
| --- | --- | --- |
| `services` | 具名物件 | **單一佔位，重名直接拋**（`:298-301`、`:327-365`）；型別靠 `NexusServices` 宣告合併（`:217-285`） |
| `lifecycle` | 關機 disposer | `:590-611` |
| `telemetry` | 遙測**脫敏規則** | 後端本身不在這，在 `services` 的 `sessionTelemetry`（`:643-681`） |
| `invariants` | 每份會話的不變量配套入口 | 只看、拿到 `SessionLogView`（無 `append`），否決不了（`:684-734`） |
| `commands` | 斜線命令 | 由進入點發派、不經模型（`:736-771`） |
| `sessions` | 會話參與者 `join(installer)`；工具用 `forCall(config)` 取自己那份日誌；`flush` | **唯一寫得動會話日誌的路**（`sessions.ts:20-23`、`registry.ts:773-843`） |
| `logger` | `apply` 當下的警告 | 只收掛上那一刻（`:619-641`） |
| `disabledEntries` | 唯讀視圖，不是註冊點 | `:866-902` |

**沒有的**（否定宣稱，搜尋見括號）：
- 沒有 HTTP 路由／wire 方法的註冊點（`rg -n -i "http|route" packages/nexus-core/src/registry.ts` 只命中 backend 的 `routePrefix` 與 issue 連結）。
- 沒有 wire frame／投影的註冊點；`sessions.ts:36-38` 自己寫明 dsh `sessionProjections` 的「後半還沒有：沒有 `stateVersion`、沒有 `wire.view`」。
- 沒有「宣告自己的會話事件種類」的路：`SessionEventType` 是手寫聯集（`session-log.ts:153-184`），`append<T extends SessionEventType>`（`session-log.ts:1225`）。#679 第 4 步未做。

### 1.3 參與者（`sessions.join`）的實際語意 —— 觀測插件最可能用的掛點

- 接線在組裝點：`agent-factory.ts:970-1026` 的 `attachSession` 對**每一份**會話（`sessions.observe`）各跑一次 `createSessionRunner`；wire 那層包成 `attachSessions`（`apps/harness/src/wire-handler.ts:186`、`:770`；`assembly-root.ts:674`）。CLI 與 serve 都接。
- `subject.observe(listener)` **先重播 `log.events`（含續接帶進來的 seed）再收後續**（`sessions.ts:186-193`）。
- listener 跑在 `SessionLog.append` 的同步發佈裡，**不能回頭 `append`**（重入護欄，`sessions.ts:145-146`；`session-log.ts:1228-1233`），拋錯只換一行 warn（`sessions.ts:166-172`）。
- 事件是 deepFreeze 過的（`session-log.ts:1052-1056`、`:1172-1173`）；拿訊息內容要走 `fromLoggedMessage`（它先 `structuredClone`，`logged-message.ts:80-83`）。

---

## 2. `.docs/plugin-architecture-gap-survey.md` 重點（只抓跟本題有關的）

- 契約層落地且被用過：17 欄位（9＋8），`packages/` 下生產 plugin 全走這條契約（`§一`，`:66`）。
- **觀測相關列**：
  - 「可觀測性 ✅ #100」（`:120`）——指的是 OTLP 遙測後端＋披露，**不是 web 上的觀測面板**。
  - dsh `client` 列（`:149`）：「`apps/web/src/` … **不是插件化 UI**」，判「部分」。
  - dsh `host` 列（`:164`）：「沒有目錄選擇、**插件清單投影**」，判「部分」。
  - dsh `session` 列（`:178`）：projection 那半「沒有」。
- 結論速查（`:17-45`）跟本題有關的兩格：核准的**審計事件**判「不做——射程選擇，非可行性；今天零消費者」（`:30`）；核准**應答者掛點**「不做」（`:29`）。**觀測插件要畫核准決策，就是那個「零消費者」的前提被推翻**，要重開。
- 已補：compaction 門檻、迴圈衛生、會話日誌落盤、生命週期鉤子面（＝#190 九格）、`services`、`logger`、`disabledEntries`。

---

## 3. 既有插件資料怎麼到 web，以及「插件能不能宣告面板」

### 3.1 逐顆走一遍

| 插件 | 鉤子（file:line） | 日誌事件／服務 | harness 轉送 | wire 型別 | web 元件 |
| --- | --- | --- | --- | --- | --- |
| `todo` | `tools.register` → 工具內 `sessions.forCall`（`packages/nexus-plugin-todo/src/index.ts:238`、`:255`） | `todo/write`（種類在 core） | pump `thread-pump.ts:2380-2382` → `todosData` | `TODOS` frame，`conversation.ts` 的 `reduceTodos` → `ConversationState.todos`（`conversation.ts:510`） | `TodoPanel`（`App.tsx:29`、`:482`） |
| `goal` | `sessions.join`（`nexus-plugin-goal/src/index.ts:270`）、`services.provide(GOALS_SERVICE)`（`:293`）、`tools.register`（`:310`）、`commands.register`（`:315`） | `goal/change` | pump `#goal.apply`（harness 的 `goal-wire.ts`，`thread-pump.ts:2364-2365`） | `GOAL` frame → `state.goal`（`conversation.ts:522`） | `GoalBar`（`App.tsx:13`、`:480`） |
| `present` | `tools.register`＋`forCall`（`nexus-plugin-present/src/index.ts:218`、`:232`），讀 `fs` 服務（`:240`） | `deliverables/presented` | pump `thread-pump.ts:2371-2372`、`:2405-2407` | `DELIVERABLES_PRESENTED` → entries 的 `deliverables` 條目（`conversation.ts:788-802`） | `deliverables-card.tsx`；檔案內容走 harness 的交付路由＋右側欄 `DeliverablePreviewTab` |
| `workspace-changes` | `sessions.join`（`nexus-plugin-workspace-changes/src/index.ts:254`）、`middleware.use`（`:306`）、`services.provide(WORKSPACE_CHANGES_SERVICE)`（`:302`）、`lifecycle`（`:294`） | `workspace/changes` | pump `thread-pump.ts:2373-2374`；**diff 內容走 HTTP**：harness 直接 import 服務名（`assembly-root.ts:65`、`:893`）→ `wire-handler.ts:1588-1620` 的 `/threads/:id/changes/{summary,diff}` | `WORKSPACE_CHANGES` frame | `changes-card.tsx`、右側欄 `ChangesReviewTab`（`right-sidebar.tsx:416-424`） |
| `feedback` | `services.provide(MESSAGE_FEEDBACK_SERVICE)`、`commands.register`（`nexus-plugin-feedback/src/index.ts:202-203`） | `feedback/*`（種類在 core） | **不走 custom frame**：wire 上固定的 `feedback.put/delete/list/record` 命令（`packages/nexus-wire/src/protocol.ts:322-327`），wire-handler 把服務交給 thread（`wire-handler.ts:544`、`:815`） | 命令回應 | `feedback-dialog.tsx`（`App.tsx:11`） |
| `telemetry-otel` | `services.provide(SESSION_TELEMETRY_SERVICE)`（`nexus-plugin-telemetry-otel/src/index.ts:366`） | 不寫事件；組裝點 `attachTelemetry` 每份日誌建一個協調器鏡像出去（`agent-factory.ts:872-906`） | **不到 web**；serve 啟動時印披露（`serve.ts:885`） | — | 只有回饋框文案依模式（`apps/web/src/lib/feedback.ts:5-6`） |

另：`telemetry-otel` **不在出貨清單**（`rg -n -i telemetry apps/harness/cordis.yml` 零命中），部署方用 patch 加——這是觀測插件「預設不掛、可加可關」的現成先例。

### 3.2 關鍵答案：插件**不能**宣告 web 面板或側邊欄分頁

從插件到畫面每一跳都是封閉的，逐跳證據：

1. **事件詞彙封閉**：`SessionEventType` 手寫聯集（`session-log.ts:153-184`），append 只收它（`:1225`）。
2. **pump 轉 frame 是 if/else**：`#noteLogEvent`（`thread-pump.ts:2360-2396`）逐種判 `event.type`；歷史那條另有一份（`conversation-history.ts:244-245` 的 `customFrame`，十幾處呼叫，例如 `:961-970`、`:1168-1190`）。**即時與歷史兩條都要補**。
3. **圖自己發的 custom frame 一律丟掉**：`thread-pump.ts:2249-2253`（註解：「放行它的話，任何一顆用 `config.writer` 的工具都能往瀏覽器寫東西」）；`protocol.ts:61-63`：「放行這一格不等於放行任何工具或 plugin 往瀏覽器寫東西」。
4. **wire 的名字→酬載表＋窮舉 reducer**：`custom-frame.ts`（#685／PR #933 已合）是可宣告合併的 `CustomFramePayloads`，但 `CUSTOM_REDUCERS`（`conversation.ts:808-825`）對 `CustomFrameName` 窮舉；`ConversationState` 欄位固定（`conversation.ts:480-549` 一帶：`todos`、`planMode`、`goal`、`tokenUsage`、`sessionStats`、`title`…）。
   - `CustomFramePayloads` 有從 `@nexus/wire` 公開入口匯出型別（`packages/nexus-wire/src/index.ts:101`），**外部套件技術上能 `declare module` 加一格**——但加了之後任何看得到那份擴充的編譯單位，`CUSTOM_REDUCERS` 就缺一格編不過；誰看得到取決於誰在跑 tsc（同 #679 描述的病）。**讀碼推得，未實測。**
   - 上行命令也是固定清單（`protocol.ts:114` `UPLINK_METHODS`、`:147` `SLASH_METHODS`、`:322` `FEEDBACK_METHODS`…）。
5. **harness 沒有 HTTP 路由註冊點**：workspace-changes 的 diff 路由存在，是因為 harness 直接 import 了那顆插件的服務名並寫死路由（`assembly-root.ts:65`、`:893`；`wire-handler.ts:1588-1620`）。
6. **web 全部靜態掛**：`App.tsx` 逐個 import 面板並讀特定 state 欄位（`App.tsx:6-29`、`:374-624`）；右側欄分頁是封閉聯集 `SidebarTab = changes | deliverable | plan`（`apps/web/src/lib/right-sidebar.ts:23-35`），`TabBody` 逐 kind 分派（`right-sidebar.tsx:404-433`）；工具卡按寫死的插件工具名分派（`apps/web/src/lib/tool-view.ts:5`、`:40-44`；`question-view.ts:22`；`plan-review.ts:29`；`todo-view.ts:13`）。
   - 否定搜尋：`rg -n -i "registerPanel|panelRegistry|slot|plugin" apps/web/src -g '!*.test.*'` 只命中 CSS 的 `data-slot` 與註解裡的插件工具名，沒有任何面板／分頁註冊機制。

對照 dsh：dsh 的右側欄有 tab 類型註冊表 `ctx.sidebarRightTabs.register({ id, kind, … })`（`references/deepseek-harness/packages/client/ui-sidebar-right/README.zh.md:83`），`client/` 下 40 多個 `ui-*` 插件，含 `ui-trajectory`、`ui-slots`。但依 AGENTS.md，**web UI/UX 不以 dsh 為準**（shadcn＋Tailwind 為基底，dsh 只參考元件多樣性）——「web 要不要長出面板註冊點」是 UI 架構選擇，**要 demian 拍板**，dsh 只能當「有這種面」的參考。

---

## 4. 相關 issue 狀態與跟觀測插件的關係

| # | 狀態（2026-10-04 查） | 一句話 | 跟觀測插件的關係 |
| --- | --- | --- | --- |
| #679 | OPEN；第 1–3 步已合，第 4 步等 demian（留言 2026-10-01） | `SessionEventType` 改 `keyof SessionEventMap`、各套件宣告自己的事件 | **最大前置**。沒有它，觀測插件要寫自己的事件只能改 core 聯集，或照「偏離一」寫側邊檔（`.docs/decisions-2026-09-25.md:91-101`），而偏離一的重開條件正是「判斷要進畫面時」——側邊欄就是這個觸發 |
| #685 | OPEN（卡沒關），harness／wire 那刀 PR #933 **已合**（2026-10-01）；web 的 `downlink.ts` 那刀未做 | custom frame 名字→酬載一張表 | 給了「加一種 frame 要動哪幾處」的編譯期保證；但表與窮舉 reducer 都在 wire 內，**不是插件擴充點** |
| #507 | OPEN、needs-triage | 事件加 `ignorable`，詞彙成長不必升版 | 沒做之前，每加一種觀測事件都要升 `SESSION_LOG_FORMAT_VERSION`；舊版 server 遇到新版號整份拒讀（`jsonl-session-store.ts:389`、`session-store.ts:508-524`）。多人共用主機混版本時，**一個預設關的觀測插件也會讓開了它的那份日誌被舊 server 拒讀**（讀碼推得） |
| #669 | OPEN；PR #935 做了第 1、2 步（ask-user、submit-record 進清單），第 3、4 步（sandbox-policy、workspace-changes 進清單）等 demian | 組裝點寫死的 plugin 搬進出貨清單 | 反面教材：code-mount 的插件 `--dump-config` 印不出、patch 指不到。觀測插件**要掛成 cordis.yml 列或 patch insert**，不要學 workspace-changes 寫在 `assembly-root.ts:775-811` |
| #670 | OPEN；第二刀 PR #940 已合（`withScriptedModel`、`scripted-serve.ts`） | 模型提供者由清單列選、測試改走產品組裝 | 觀測插件的驗收可直接在出貨組裝上插腳本模型跑（照 dsh「Product-visible plugins require a REAL-composition test」） |
| #721 | OPEN（卡沒關），實作 PR #934 **已合**（`1bbd66a`，格式升到 29）；三題待 demian | 續接時補寫 `tool/result`＋`turn/end{interrupted}` | 觀測的「這輪是當掉收的」有正式事件可讀；但「開著的 `model/start` 不補 `model/end`」（題 2）表示軌跡上的模型呼叫可能永遠沒結尾 |
| #434 | OPEN、needs-triage | 模型失敗在 `turn/failed` 帶分類碼 | 今天 `turn/failed` 只有 `message: string`（`session-log.ts:392`）；觀測面板分不出限流／溢出／斷線。`llm/retry` 已帶 `LlmFailure`（`:496-502`），但最後那次失敗沒有 |
| #667 | OPEN；harness＋wire 那刀 PR #927 **已合**（`ToolEntry.errorCode`），web 那刀歸 dev-ui | 工具結果錯誤碼送上線 | 觀測面板在 web 上讀得到工具錯誤碼了（即時與歷史都帶）；核准被拒仍**不帶碼**（`approval.ts:247-249`） |
| #724 | OPEN，demian 2026-09-26 拍板「晚點做」 | token 總帳分快取讀／寫兩桶 | 「評估任務成本」面板若要畫快取命中或算錢，**正好滿足它的重開條件 1 與 3**；而且拍板留言指出：型錄不帶價格（dsh catalog 價格全 0），所以「錢」在 dsh 沒有先例 |

另外查到的：#263（已關）的開圖拍板第 2 條「**dsh 也沒做的格子一律不進執行期，只准做在產品路徑外**」——直接約束「算錢」這一格；#725（OPEN）投影快取要不要做，跟「web 讀投影」同一軸。

---

## 5. 新增一種觀測事件的真實步驟與會紅的地方

**前提**：今天（#679 第 4 步未做）只能改 core 的聯集。以下照「怎麼響」分類。

### 5.1 型別層絆索——只有跑到**那個套件**的 tsc 才會紅

1. `packages/nexus-core/src/session-log.ts:153-184` 加種類、`SessionEventMap` 加酬載（`:312` 起），檔頭 `:47-151` 依慣例補「兩條路都產得出來嗎」那段。
2. `packages/nexus-plugin-goal/src/fold.test.ts:510-546`：`KNOWN` 陣列＋`Exhaustive` 型別，漏列就 `never`。還要在 `:440-509` 寫一句「推不推 `roundsStarted`」的理由。
3. `apps/harness/src/eval/session-scan.ts:108-140`：`KNOWN_EVENT_TYPES: Record<SessionEventType, true>`，漏列 typecheck 紅。
4. 若會進模型：`ModelVisibleEventType`＋`MODEL_VISIBLE_EVENT_TABLE`＋replay 的 `switch`（`session-log.ts:969-994`）。觀測事件**不該**進模型，這格應該不碰。

### 5.2 慣例，沒有測試守

5. **`SESSION_LOG_FORMAT_VERSION` 升一版並補一段說明**（`packages/nexus-core/src/session-store.ts:314`，說明段落慣例見 `:205-313`）。
   - 否定搜尋：`rg -ln SESSION_LOG_FORMAT_VERSION -g '*.test.ts' packages apps | xargs rg -n "SessionEventType|KNOWN|詞彙"` 沒有任何測試把詞彙與版本號綁在一起；唯一的數值斷言是 `log-content.test.ts:299` 的 `>= 9`。**忘了升不會紅**。
   - 後果見 #507：版本號是唯一守衛，升了之後舊 server 拒讀（`jsonl-session-store.ts:389`）。

### 5.3 條件式絆索

6. `apps/harness/src/interception-index.test.ts:332-337`、`:399-418`：**只要新種類叫 `approval/…` 就紅**（翻面寫的，紅了要回去重寫第 4 列紀錄差 `:211-223`）。觀測插件記核准決策就會中這條，**這是刻意的**。
7. `apps/harness/src/registry-channel-count.test.ts`：只有在 `PluginRegistry` 加通道時紅（例如加「投影」通道）。
8. `apps/harness/src/shipped-service-reads.test.ts`：插件在 `apply` 當下讀別的插件提供的服務時紅（`registry.ts:321-325`）。
9. `apps/harness/src/approval-gate-order.test.ts`：插件掛 `approvals.gate` 進出貨清單時，`EXPECTED_APPROVAL_GATES` 要跟著改（#669 留言說它從 `e33b859` 起是 `[]`，PR #935 加了 submit-record）。
10. **把事件序列寫死的測試**：如果觀測插件**預設掛**，又在每份日誌寫新事件，很多斷言事件順序的測試會紅。`rg -ln "\.map\(\(e(vent)?\) => e(vent)?\.type\)" -g '*.test.ts'` 有二十多檔（例如 `cli.test.ts`、`goal-driver-pump.test.ts`、`tool-card-from-log.test.ts`）。**哪幾條真的會紅：待驗**。預設不掛的話，這類測試碰不到它。

### 5.4 要上畫面才多出來的

11. pump 即時那條：`thread-pump.ts:2360-2396` 加分支。
12. 歷史那條：`conversation-history.ts`（`customFrame`，`:244`）也要長出同一顆 frame，否則重新整理後就不見了。
13. wire：領域檔宣告常數＋`declare module './custom-frame.js'`，`conversation.ts:808-825` 補 reducer，`ConversationState` 加欄位與初值（`:572` 一帶）。
14. web：新元件＋`App.tsx` 或右側欄掛載點；右側欄要加 `SidebarTab` 成員（`lib/right-sidebar.ts:23`），還有 `tabKey`／序列化（`:142-155`）。這一段歸 dev-ui（記憶「分工」）。
15. 測試要走產品組裝：wire 測試沒接 `attachSessions` 的話，圍堵不記日誌，「從日誌導出」的斷言會假綠（記憶 `wire-test-assembly-needs-attach-session`；今天 wire 層名字是 `attachSessions`，`wire-handler.ts:186`）。

### 5.5 記憶過期的地方（已對現樹核過）

- 記憶說 core `session-telemetry.ts` 有逐種放行表要改——**已不成立**：#679 第 2 步改成 `switch`＋`default: false`（`session-telemetry.ts:151-160`）。
- 記憶說新增 package 要有 `src/invariant.ts`——**已翻面**：#974 之後「沒有可檢的關係就不要發布配套入口，空 installer 本身是違規」（`apps/harness/src/package-invariants.ts:8-14`）。
- 記憶寫 `attachSession`：core 組裝那層仍叫 `attachSession`（`agent-factory.ts:970`），wire／assembly-root 那層是 `attachSessions`。

---

## 6. 觀測插件怎麼放、用哪個鉤子、今天做不到什麼

### 6.1 主要設計點

**記錄那半大多已經在日誌上**，檢視那半缺的是投影與畫面。dsh 的 trajectory 也是讀既有日誌（`ui-trajectory/README.zh.md`「視圖是純投影」，對 `5badb15`）。所以建議拆兩顆：

- **檢視／投影**（新套件，例如 `@nexus/plugin-trajectory`）：只讀日誌、折出軌跡與成本投影。**不碰產品路徑**（不掛 middleware、不掛 gate），關掉＝整個不在。
- **補記錄**：依缺口逐項判斷是改 core 記錄器還是插件可宣告（見 6.3）。

**命名風險**：`observation` 已經被「先讀後改」佔走——`OBSERVATION_POLICY_PLUGIN_NAME = 'observation-policy'`（`packages/nexus-core/src/observation.ts:320`），條目 `cordis.yml:217-218`，匯出 `@nexus/core/observation-policy`。`disabledEntries.has` 比的是 name 全字串（`registry.ts:890-895`），`observation` 不會跟它撞名，但人會混淆。建議照 dsh 叫 `trajectory`（軌跡）與 `token-meter`／`session-cost`（成本）。

### 6.2 鉤子對照（含陷阱）

| 想看的 | 鉤子 | 在不在產品路徑 | 陷阱 |
| --- | --- | --- | --- |
| 整條日誌（輪、模型起訖、用量、重試、回覆含推理、工具呼叫與結果、壓縮、中斷） | `registry.sessions.join` → `subject.observe` | **不在**（只是 log 的訂閱者，拋錯被圍堵） | ①每份會話一次，root＋每個子代理，要自己看 `subject.address`（`sessions.ts:77-83`）；②`observe` **先重播含 seed 的歷史**（`sessions.ts:186-193`），寫側邊庫的話續接會重複計，要照遙測協調器用 `(sessionId, seq)` 去重（`session-telemetry.ts:32-34`）；③同步跑在 append 熱路徑，重活要排到下一個 tick，且**不能 append**（`sessions.ts:145-146`） |
| 每次模型請求的完整輸入（messages、model、tools）、真實延遲 | `registry.middleware.use({ wrapModelCall })` | **在**（每次模型呼叫多一層） | ①`plugins.rest` 在 `modelCalls` 記錄器**內側**（`fold.ts:566-575`），看到的是記錄器已記 `model/start` 之後的那次；②同一實例走遍 root 與子代理，**逐 agent 狀態不能放閉包**，要用 `sessions.forCall` 查身分（`registry.ts:435-440`）；③本體要自己 try/catch，記錄失敗不能扳倒呼叫 |
| 工具呼叫的參數與結果 | 日誌上的 `tool/call`／`tool/result` 已足；要更早的切面才用 `middleware.use({ wrapToolCall }, { prepend: true })` | prepend 那條**在** | `prepend` 槽在核准閘門**外側**（`fold.ts:537-554`），看得到閘門回的拒絕訊息，但拒絕**不帶碼、分不出誰拒、為什麼**（`approval.ts:247-249`；`interception-index.test.ts:211-223`） |
| 閘門決策 | `registry.approvals.gate(listener)`，呼叫 `next()` 看下游判決 | **在**（waterfall 一位） | ①只看得到排在它後面的人的判決，順序＝清單順序（`registry.ts:519-523`）；②`ask` 之後**人的回答在圖外**（wire-handler／cli），gate 看不到（`interception-index.test.ts:216-219`）；③會動到 `approval-gate-order.test.ts`；④prepend 的 `wrapToolCall` 能不能在 resume 後推得出人的決定：**待驗** |
| 往外送 | `services.provide(SESSION_TELEMETRY_SERVICE, …)` | 不在 | **服務單一佔位**（`registry.ts:298-301`），會跟 otel 撞；用 `sessions.join` 才能多位並存 |

**掛法**：做成 `cordis.yml` 的一列或 patch `insert`，預設不掛（同 telemetry-otel），這樣 `--dump-config` 印得出、`disabled: true` 關得掉；不要 code-mount（#669 的教訓）。裸名載入要在 `apps/harness/package.json` 加依賴（`plugin-config.ts:675`）。

### 6.3 今天做不到、要先改契約或拍板的

逐項缺口（「core」＝要改 core 記錄器，**插件條目關不掉**；「#679」＝開放詞彙後插件可自己宣告）：

| 缺口 | dsh 對應 | 歸誰改 | 證據 |
| --- | --- | --- | --- |
| 每次請求的 prompt／工具／模型 | `request/header`（`packages/core/session/src/types.ts:390-395`）、`request/context`（`:402`） | core（dsh 的「Model-visible ⟺ logged」原則，dsh `CLAUDE.md` Conventions） | 我們只記回覆不記請求；`model/start` 是 `Record<string, never>`（`session-log.ts:477`） |
| 失敗的那次嘗試 | `assistant/attempt`（`types.ts:355`） | core | `model-calls.ts` 檔頭「拋錯的呼叫不記」 |
| 每次呼叫的模型 id | `request/header` 裡 | core | `model/usage` 只有三個計數、「不含模型 id」（`session-log.ts:461-468`）；子代理可選不同模型（#875），成本無法按模型歸屬 |
| 核准的問與決 | `approval/asked`、`approval/decided` | #679＋生產者在圖外（pump／cli） | `interception-index.test.ts:211-223`；gap survey 判「零消費者不做」（`:30`）——側邊欄就是第一個消費者 |
| `turn/failed` 分類碼 | `turn/end{kind:'error', error: LlmFailure}` | core（#434） | `session-log.ts:392` |
| 快取讀寫 | `cacheReadTokens`／`cacheWriteTokens` | core 用量記錄器（#724） | `token-usage.ts:11` |
| 串流計時、TTFT | `assistant/message.stream` | core＋adapter | `model-calls.ts` 檔頭（#266 首字延遲「整組不做」，見 #263 Decisions） |
| 錢 | **dsh 沒有**（型錄價格全 0，#724 留言） | 依 #263 拍板 2：**只准做在產品路徑外**（例如 `apps/harness/src/eval/`） | — |
| 插件自己的事件種類 | `declare module` 補 `SessionEventMap` | #679 第 4 步 | `session-log.ts:153`、`:1225` |
| 插件推資料到 web | `sessionProjections`＋`wire.view` | 新通道（會紅 `registry-channel-count.test.ts`） | `sessions.ts:36-38` |
| 插件宣告面板／分頁 | `ctx.sidebarRightTabs.register` | web 架構選擇，**不以 dsh 為準** | §3.2 |
| 插件加 HTTP 路由 | host 的路由面 | harness | §3.2 第 5 點 |

### 6.4 要 demian 拍板的（我不替他定）

1. **core 記錄器 vs 萬物皆插件**：上表多數缺口要改 core 記錄器，那些記錄關不掉。可以接受，還是要先開「記錄器也是可關條目」的軸（#46 那條路）？
2. **#679 第 4 步要不要現在做**：偏離一的重開條件（「判斷要進畫面時」，`decisions-2026-09-25.md:101`）會被觀測側邊欄觸發。
3. **web 要不要長出面板／分頁註冊點**（UI 架構，dev-ui 的領域）；不要的話，每加一種觀測面板都是 wire＋harness＋web 三處寫死。
4. **錢放哪**：依 #263 拍板 2 放在產品路徑外；但畫在側邊欄就是進產品路徑。要嘛改拍板，要嘛側邊欄只畫 token／耗時，算錢留在 `eval:` 離線報表。
5. **#507 要不要先做**：沒有它，每加一顆觀測事件都要升版。
6. **分工**：記錄＋投影歸 dev-harness（`packages/*`、`apps/harness`），面板歸 dev-ui（`apps/web`）；wire 的表與 reducer 在 `packages/nexus-wire`，屬 dev-harness。

---

## 7. 搜尋紀錄（否定宣稱用）

- `rg -n -i "http|route" packages/nexus-core/src/registry.ts` → 只有 backend `routePrefix`。
- `rg -n -i "registerPanel|panelRegistry|slot|plugin" apps/web/src -g '!*.test.*'` → 只有 CSS `data-slot` 與註解。
- `rg -n -i telemetry apps/harness/cordis.yml` → 0。
- `rg -n "^declare module" packages apps -g '*.ts' -g '!*.test.ts'` → `'@nexus/core'` 七處（harness settings 三處、goal、sandbox-policy、system-prompt、workspace-changes），下一行全是 `interface NexusServices`；`'./custom-frame.js'` 十一處全在 wire 內；**沒有任何套件補 `SessionEventMap`**。
- `rg -n "Record<SessionEventType|satisfies Record<SessionEventType" packages apps` → 只有 `session-scan.ts:108`。
- 版本號與詞彙綁定的測試：見 §5.2，無。
- issue 狀態：`gh issue view N --json title,state` 對 679/685/507/669/670/721/434/667/724/725/263；PR 狀態：`gh pr view 933|934|927 --json state,mergedAt`。
