# 事件契約設計草稿 —— 讓 `@nexus/core` 取代 LangChain middleware 的那一層

**狀態：草稿，沒有任何東西動工，也沒有決議。** 這份筆記回答一個問題：如果要照 dsh 的方式，用「型別化事件加 waterfall」取代我們現在的 LangChain middleware，**契約該長什麼樣、要先決定哪些事**。它不排期，不寫實作。

**範圍與前提**：demian 2026-10-08 表示目標是「控制權」與「對齊 dsh」兩者都要，並要求先寫這份草稿。**兩個前提還沒拍板**：要不要正式推翻 [#190](https://github.com/DemianLi/nexus-agent/issues/190) 的偏離登記（「沒有事件匯流排」），以及核心替換相對於企業功能（管理員後台、身分、稽核）的時序。這份草稿把它們當成待決，不預設答案。

**對讀版本**：nexus develop `8ec64ea0`；dsh `5badb15009a`（`references/deepseek-harness`，HEAD 日期 2026-10-03）。

相關決議與筆記：[`decisions-2026-10-08.md`](decisions-2026-10-08.md)（不以 Rust 重寫容器）、[`rust-and-langchain-removal-2026-10-06.md`](rust-and-langchain-removal-2026-10-06.md) §五、§七（拿掉 LangChain 家族的順序與成本）、[`admin-plugin-swap-decision-draft-2026-10-07.md`](admin-plugin-swap-decision-draft-2026-10-07.md)（後台插拔）。

## 一、來源與可信度

| 區塊 | 來源 | 核對狀況 |
| --- | --- | --- |
| §二 dsh 的事件匯流排與事件清單 | 讀 `vendor/cordis/src/events.ts`（352 行，全文）、`packages/core/agent/src/runtime-types.ts` 的事件宣告、`packages/core/tools/src/index.ts` 與 `packages/llm/llm/src/index.ts` 的 waterfall 宣告、`docs/event-producer-consumer.zh.md`、`docs/tool-execution-pipeline.zh.md`、`docs/architecture.zh.md` | 第一手 |
| §二 dsh 的迴圈**實作** | **沒讀**。`packages/core/agent-loop/src/agent.ts`（688 行）與 `index.ts`（893 行）我只讀了它們宣告的事件，沒讀迴圈怎麼走 | 見 §七 |
| §三 nexus 的 middleware 盤點 | `grep` 正式碼（排除測試與夾具）的 `createMiddleware` 與六種鉤子名 | 第一手的計數；**「每顆做什麼」只讀了檔名與 `step-inbox.ts` 的檔頭，分類是初步的** |
| §三 #190 的偏離登記與索引 | `gh issue view 190`、`apps/harness/src/interception-index.test.ts` 檔頭 | 第一手 |
| §四、§五 | 判斷，不是事實 | — |

## 二、dsh 的事實

### 2-1 匯流排本體很小

- `EventsService` 全檔 352 行，其中大半是型別與 JSDoc。五種分派：`emit`、`parallel`、`serial`、`bail`、`waterfall`。
- **`waterfall` 的實作約十行**（`events.ts:234-243`）：取出該事件的所有監聽者，最後一個參數當成最內層的 `next`，監聽者由外而內執行；**監聽者沒呼叫 `next()` 就是否決**，連內建行為一起略過。
- 註冊走 `ctx.on(name, listener, { prepend })`，經 `fiber.effect` 登記，回傳撤銷函式。**撤銷隨插件卸載自動發生**。
- 宣告靠 TypeScript 的 declaration merging 擴充 `Events` 介面，JSDoc 必須有 `@mode` 與參數說明（AGENTS.md 的規矩，並有閘門檢查）。

### 2-2 迴圈自己就是插件，靠這幾個事件讓別人介入

dsh 宣告了 81 個 harness 事件（`event-producer-consumer.zh.md`），迴圈相關的是這幾個：

| 事件 | 模式 | 誰能做什麼 |
| --- | --- | --- |
| `agent/pre-step` | waterfall | 拒絕這一步，或替換進入這一步的訊息；`next()` 保持原樣 |
| `agent/request` | waterfall | **只能替換呼叫設定**（`LlmCallConfig`）；**明寫不能改訊息**，模型看得到的內容必須走「已記錄」的通道 |
| `agent/request-error` | waterfall | 一次請求失敗後，回 `{ kind: 'retry' }`（自己接手恢復）或 `next()`（交給下一個） |
| `llm/stream` | waterfall | 包住每一次串流模型呼叫（重試、重放、路由）；可以產自己的片段把它短路 |
| `tools/pre-execute` | waterfall | 允許、拒絕、取消、或問人；`next()` 等於允許 |
| `tools/execute` | waterfall | 環繞派發：逾時、重試、計量；只能改 `exec.signal` |
| `tools/post-execute` | waterfall | 接受、替換、補上下文或擋下一個結果 |
| `tools/result` | emit | 觀察最終凍結的結果，不能改 |
| `agent/turn-stopping` | serial | 輪要收了；監聽者可以 `agent.steer(...)` 要求再跑一步 |
| `system-prompt/assemble` | waterfall | 組裝系統提示的片段 |
| `approval/request` | waterfall | 核准請求 |
| `fs/write-intent`、`fs/edit-intent` | waterfall | 檔案寫入意圖 |
| `agent/assistant-stream`、`session/event`、`agent/error`、`agent/status`… | emit | 觀察 |

### 2-3 dsh 的設計原則，直接影響我們

- **每個階段的權限不同是刻意的**（#190 開圖時引用 dsh 的原文）：混為一談的話，插件會拿到不該有的改寫通道，而終結性會取決於註冊順序。所以 `agent/request` 不能改訊息，`tools/result` 只能看。
- **模型可見即已記錄**（`AGENTS.md`）：每個進模型的內容都必須能從會話日誌重建；新增模型可見輸入要有會話事件。這使得歷史由日誌推出（`deriveMessages()`），不存在另一份「圖狀態」。
- **事件分三個域**：會話事件（持久的事實，進日誌）、agent 事件（活著的擴充點）、能力事件（`fs/*`、`tools/*`，不必 import 迴圈）。
- agent 事件用 `Scoped<Agent>` 過濾：註冊在某個 agent 範圍內的監聽者，只收到那個 agent 的事件。
- dsh 的迴圈（`core/agent-loop`，非測試 2,425 行）**沒有 LangChain、沒有 LangGraph**，狀態以 append-only 日誌為準（沒有逐步存檔點）。

## 三、nexus 今天的事實

### 3-1 middleware 盤點

正式碼有 **27 個檔、28 顆** `createMiddleware`（`turn-cancel.ts` 一檔兩顆）。各鉤子被幾個檔用：

| 鉤子 | 檔數 | 圖裡的代價 |
| --- | --- | --- |
| `wrapModelCall` | 18 | 包住模型呼叫，不另佔節點 |
| `wrapToolCall` | 18 | 包住工具呼叫，不另佔節點 |
| `beforeModel` | 7 | **每個都是圖裡的一個節點，每一步多一個 super-step** |
| `beforeAgent` | 5 | 每次執行一次 |
| `afterAgent` | 4 | 每次執行一次 |
| `afterModel` | 4 | **同 `beforeModel`，每步一個節點** |

`step-inbox.ts` 的檔頭自己寫了這個價錢，並因此把「說完了還有插話」那一半改掛 `afterAgent`；遞迴上限的換算在 `apps/harness/src/settings/recursion-limit.ts`。**換成事件之後，這個價錢消失**：事件派發不是圖節點。

### 3-2 初步分類（**未逐檔核對**，依檔名與鉤子組合）

| 類 | 檔 | 對到 dsh 的事件 |
| --- | --- | --- |
| 工具攔截：圍堵、核准、輸出整形 | `containment`、`approval`、`sandbox-policy`、`spill-policy`、`search-overflow`、`fs-tool-errors`、`output-schema`、`read-continuation`、`invalid-tool-args`（工具那半）、`workspace-changes`、`max-tokens`（工具那半） | `tools/pre-execute`、`tools/execute`、`tools/post-execute`、`tools/result` |
| 模型呼叫：計量、觀測、快照 | `model-calls`、`model-usage`、`request-snapshot`、`observation`、`session-checkpoint-policy`、`max-tokens`（模型那半） | `llm/stream`、`agent/request`、emit 類 |
| 提示與上下文注入 | `system-prompt`、`agent-instructions`、`file-references`、`plan-mode`、`repeat-reminder`、`subagent-delegation` | `system-prompt/assemble`、`agent/pre-step`、`agent.inject()` |
| 流程控制 | `turn-cancel`、`step-inbox`、`patch-tool-calls`、`background-delegation`、`subagent-tool-filter` | `agent/pre-step`、`agent/turn-stopping`、迴圈本身 |

### 3-3 已登記的偏離與既有的先例

- **#190 的偏離登記**：`TelemetryRegistrationPoint` 檔頭寫「我們沒有 service 註冊也沒有事件匯流排，`deepagents`／LangChain JS／LangGraph JS 三者都不提供可掛任意具名事件的 waterfall」。所以 #190 把 dsh 的九個攔截時刻逐格退到 middleware 鉤子上，佔住四格，索引在 `apps/harness/src/interception-index.test.ts`（有防漂移的絆索）。
- **已經有一條 waterfall**：核准閘門 `approvals.gate`，順序就是載入順序（`apps/harness/src/approval-gate-order.test.ts` 守著）。事件匯流排不是從零開始，是把這個機制一般化。
- **服務查找已有**（#459：`registry.services.provide/use/get`）。與 Cordis 對照表裡，仍是「退到」或「部分」的是：型別化事件、`inject` 排序、可逆註冊的 reload 撤銷。
- **插件沒有被隔離在 LangChain 之外**：22 個插件有 13 個直接 import LangChain 家族，且 registry 的 `middleware` 註冊點收的是 LangChain 的 `AgentMiddleware` 型別。這是上限，不是工作量——沒逐個看是只用 `tool()` 還是用了 middleware。

## 四、契約設計（建議，不是決議）

### 4-1 匯流排本體：先只做三種分派

- **`emit`、`waterfall`、`serial`**。dsh 的 81 個宣告事件裡，模式只有 `emit`、`waterfall`、`serial`、`parallel` 四種；**`bail` 只有框架內部事件用**（`internal/listener`），所以我們不需要。
- **`parallel` 有需求再加**：dsh 只有 `feedback/committed`、`session/flush`、`workspace/session-stop` 三個用它，我們目前沒有對應的消費者。
- `waterfall` 直接照 `events.ts:234-243` 的語意：監聽者由外而內，沒呼叫 `next()` 即否決。

### 4-2 宣告與歸屬

- 事件表住在 `@nexus/core`，用介面宣告，每個事件必須標 `@mode` 與參數說明，並有閘門檢查（照 dsh 的規矩）。
- 插件只相依 `@nexus/core` 的約束不變：插件要加自己的事件，靠 TypeScript 的模組擴充（declaration merging）對 `@nexus/core` 的事件介面擴充。**這一點我沒驗證過在我們的 pnpm 隔離下可行。**
- 註冊走 `registry.events.on(name, listener, { prepend })`，回傳撤銷函式，並與現有的 `origin`（是誰註冊的）機制一致，這樣 `loadPlugins` 的載入期回滾與關機的 `dispose()` 都能沿用。

### 4-3 作用域

- dsh 靠 `Scoped<Agent>` 過濾。nexus 是**一個 thread 一個 registry、一個 agent**，thread 之間天然隔離，所以不需要這一層。
- **子代理怎麼辦是真問題**：我們有「全域（root）↔ 各子代理」的層，且「同層報錯、跨層遮蔽」。事件的 payload 要帶 agent 身分（root 或哪個子代理），監聽者自己過濾，還是匯流排替它過濾？見 §六 D4。

### 4-4 命名

**照 dsh 的名字**（`agent/pre-step`、`tools/pre-execute`…）。理由：對齊 dsh 是這次的目標之一；對照文件與 dsh 原始碼時不必翻譯；`interception-index.test.ts` 的索引本來就用 dsh 的時刻名。

## 五、可能的切法（只談契約，不排期）

**策略：絞殺式，不是一次換。** 先加一顆橋接 middleware，把 LangChain 的鉤子轉成事件派發；插件逐顆從 middleware 搬到事件上；最後拿掉橋接與 LangChain。橋接的語意落差要先驗：LangChain 的 `wrapModelCall` 不是串流包裝，dsh 的 `llm/stream` 是。

| 階段 | 內容 | 為什麼這個順序 |
| --- | --- | --- |
| S0 | 匯流排本體、事件表、與 registry 整合；不改任何行為 | 最小，且是其他階段的前置 |
| S1 | 工具三事件（`tools/pre-execute`、`tools/execute`、`tools/post-execute`）加 `tools/result` | 最獨立：18 個檔用 `wrapToolCall`；dsh 的契約最清楚（`tool-execution-pipeline.zh.md` 有完整流程圖）。**模型看得到工具結果，要 live A/B** |
| S2 | 模型呼叫事件（`agent/request`、`llm/stream`、`agent/request-error`） | 牽涉 §六 D1（歷史的真相來源） |
| S3 | 輪邊界（`agent/pre-step`、`agent/turn-stopping`），取代 `beforeAgent`／`afterAgent`／`beforeModel`／`afterModel` | 這幾顆都是圖節點；換掉之後遞迴上限的換算要重寫 |

## 六、最難的設計決定（列出來，不替你決定）

**D1 模型歷史的真相來源。** dsh 是會話日誌，`agent/request` 不能改訊息；nexus 今天是 LangGraph 的狀態加另一份會話日誌，`PrunedMemorySaver`（保留 1 份）是權宜之計。照 dsh 做，就要有一個從日誌推出訊息的投影（`deriveMessages()` 那種），而**今天靠 `wrapModelCall` 改寫訊息的插件**（`system-prompt`、`agent-instructions`、`file-references`、`plan-mode` 等，名單未逐檔核對）都要改成走「已記錄」的通道。**這是整份草稿最大的缺口**，也是不能靠橋接 middleware 輕鬆跨過去的一步。

**D2 迴圈本體住哪裡。** 今天 pump 在圖外，圖在 LangGraph；`step-inbox.ts` 與 `turn-cancel.ts` 靠 `configurable` 把圖外的東西交進圖裡。事件化之後迴圈是 core 的 driver，這類載體應該消失。這是收益，也是範圍：driver 要自己寫。

**D3 核准與中斷。** 今天的 HITL 用 LangGraph 的 `interrupt`／`resume`，核准可以跨行程重啟。dsh 的做法是 `tools/pre-execute` 裡的 async 等待。**dsh 在行程重啟後怎麼恢復一個等待中的核准，我沒查**（需要讀 `agent.ts` 與 `user-approval`）。這決定我們能不能放棄 `interrupt`。

**D4 子代理的事件歸屬。** 事件帶 agent 身分、監聽者自己過濾，或匯流排過濾？牽涉「同層報錯、跨層遮蔽」的既有規則。

**D5 推翻 #190。** 事件匯流排一旦存在，#190 的偏離登記與索引的前提就沒了；`interception-index.test.ts` 的絆索要**翻面**（不是刪除），每一格要改記「現在由哪個事件佔住」。

**D6 與企業功能的關係。** 管理員後台、插拔與稽核**不依賴**這份契約：「新舊並存」靠每個 thread 組裝一次，與迴圈長什麼樣無關。反過來，事件契約也讓稽核更好做（`tools/pre-execute` 本來就是審計的天然切點），但不是前置。

## 七、這份草稿沒有回答的

- **沒讀 dsh 迴圈的實作**（`agent.ts`、`index.ts`）。事件宣告和文件我讀了，迴圈怎麼走、取消與錯誤怎麼收斂、D3 的答案，都還沒讀。**這是把草稿升成決議前最該補的一步。**
- **28 顆 middleware 每一顆做什麼、是否改寫訊息**，只有分類，沒有逐檔核對；§三 3-2 的表要在 S1 動工前重做。
- **13 個插件各自用了 LangChain 的什麼**（`tool()` 還是 middleware），沒看。
- **橋接 middleware 的語意落差**（`wrapModelCall` 對 `llm/stream`）沒驗。
- **沒估人力**。行數與檔數只能當尺寸，不能換算成工期（同 `rust-and-langchain-removal-2026-10-06.md` §7-7）。
- **模型面行為沒量**：任何一段事件化後，工具描述、摘要觸發、`task` 描述是否逐位元組相同，都要 live A/B。

## 八、下一步（要你決定的）

1. **要不要正式推翻 #190？** 這決定這份草稿能不能升級成決議卡。
2. **時序**：核心替換排在企業功能（10/12 之後的身分、角色、稽核）之前、之後，還是並行？D6 說兩者不互相依賴，但人力是共用的。
3. **要不要先補讀 dsh 的迴圈實作**（§七 第一項），再決定 D1～D3？我建議是：它是升成決議前的前置，成本是一次讀 `agent.ts` 與 `user-approval`。
