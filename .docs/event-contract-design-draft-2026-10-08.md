# 事件契約設計草稿 —— 讓 `@nexus/core` 取代 LangChain middleware 的那一層

**狀態：草稿，沒有任何東西動工，也沒有決議。** 這份筆記回答一個問題：如果要照 dsh 的方式，用「型別化事件加 waterfall」取代我們現在的 LangChain middleware，**契約該長什麼樣、要先決定哪些事**。它不排期，不寫實作。

**範圍與前提**：demian 2026-10-08 表示目標是「控制權」與「對齊 dsh」兩者都要，並要求先寫這份草稿。**兩個前提還沒拍板**：要不要正式推翻 [#190](https://github.com/DemianLi/nexus-agent/issues/190) 的偏離登記（「沒有事件匯流排」），以及核心替換相對於企業功能（管理員後台、身分、稽核）的時序。這份草稿把它們當成待決，不預設答案。

**對讀版本**：nexus develop `8ec64ea0`；dsh `5badb15009a`（`references/deepseek-harness`，HEAD 日期 2026-10-03）。

相關決議與筆記：[`decisions-2026-10-08.md`](decisions-2026-10-08.md)（不以 Rust 重寫容器）、[`rust-and-langchain-removal-2026-10-06.md`](rust-and-langchain-removal-2026-10-06.md) §五、§七（拿掉 LangChain 家族的順序與成本）、[`admin-plugin-swap-decision-draft-2026-10-07.md`](admin-plugin-swap-decision-draft-2026-10-07.md)（後台插拔）。

## 一、來源與可信度

| 區塊 | 來源 | 核對狀況 |
| --- | --- | --- |
| §二 dsh 的事件匯流排與事件清單 | 讀 `vendor/cordis/src/events.ts`（352 行，全文）、`packages/core/agent/src/runtime-types.ts` 的事件宣告、`packages/core/tools/src/index.ts` 與 `packages/llm/llm/src/index.ts` 的 waterfall 宣告、`docs/event-producer-consumer.zh.md`、`docs/tool-execution-pipeline.zh.md`、`docs/architecture.zh.md` | 第一手 |
| §二 dsh 的迴圈**實作** | 初稿沒讀；2026-10-08 補讀：`agent-loop/src/agent.ts`（全文）、`tool-calls.ts`、`inbox.ts`、`index.ts`（前 300 行與 `resume` 段，300–800 行的組裝段沒讀）、`interaction/user-approval/src/{index,types}.ts`、`core/session/src/repair.ts` 與 `deriveMessages()` | 第一手；結論在 §六；`assistant-stream.ts`、`runtime-context.ts`、持久化實作沒讀 |
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

- **#190 的偏離登記**：`registry.ts:664`（`TelemetryRegistrationPoint` 的說明）現在寫「我們沒有事件匯流排」，並指出 `deepagents`／LangChain JS／LangGraph JS 三者都不提供可掛任意具名事件的 waterfall。（#190 當年的版本還多一句「沒有 service 註冊」，#459 之後那半句已經不成立、已被改掉。）所以 #190 把 dsh 的九個攔截時刻逐格退到 middleware 鉤子上，佔住四格，索引在 `apps/harness/src/interception-index.test.ts`（有防漂移的絆索）。
- **已經有一條 waterfall**：`approvals` 註冊點，一條 pre-execute waterfall（`registry.ts:504`），順序就是載入順序（`apps/harness/src/approval-gate-order.test.ts` 守著）。事件匯流排不是從零開始，是把這個機制一般化。
- **服務查找已有**（#459：`registry.services.provide/use/get`）。與 Cordis 對照表裡，仍是「退到」或「部分」的是：型別化事件、`inject` 排序、可逆註冊的 reload 撤銷。
- **插件沒有被隔離在 LangChain 之外**：21 個 `nexus-plugin-*` 套件有 13 個直接 import LangChain 家族（`langchain`、`@langchain/*`、`deepagents`），且 registry 的 `middleware` 註冊點收的是 LangChain 的 `AgentMiddleware` 型別。這是上限，不是工作量——沒逐個看是只用 `tool()` 還是用了 middleware。

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

以下 D1–D3 已依 2026-10-08 補讀 dsh 迴圈實作更新（`references/deepseek-harness`，`5badb15009a`）。

**D1 模型歷史的真相來源。** dsh 的答案是：**會話日誌是唯一真相，沒有第二份狀態，也沒有 checkpoint。**
- 每一步請求都從 `session.deriveMessages()` 現推（`agent.ts:671`）。該函式走日誌裡標了 `surfaceOp` 的事件；壓縮是 `replace` 掉被蓋住的節點；結果有快取，只在尾端長出新節點時增量計算（`session/src/index.ts:856`）。
- 送進模型的東西一律先 append 進日誌，才組請求：`user/message`、`system/message`、`request/header` 都在 `buildRequest` 之前寫入（`agent.ts:410-425`）。這是「model-visible ⟺ logged」在程式裡的落點。
- `agent/request` 只能換 `LlmCallConfig`，不能改訊息（`agent.ts:576`，種子 config 是 deepFreeze 過的）。
- 待處理輸入（inbox）也是日誌事件 `agent/inbox/spliced` 的折疊，不是記憶體佇列（`inbox.ts`），所以崩潰後排隊中的訊息還在。

nexus 今天是 LangGraph 狀態加另一份會話日誌，`PrunedMemorySaver`（保留 1 份）是權宜之計。照 dsh 做，就是**拿掉 LangGraph 狀態那一份，歷史由日誌推導**，而**今天靠 `wrapModelCall` 改寫訊息的插件**（`system-prompt`、`agent-instructions`、`file-references`、`plan-mode` 等，名單未逐檔核對）都要改成走「已記錄」的通道。我看不出只要「重啟後任何狀態都能從日誌還原」這個性質就能折衷的路線。**這是整份草稿最大的缺口**，也是不能靠橋接 middleware 輕鬆跨過去的一步。

**D2 迴圈本體住哪裡。** dsh 的迴圈是一個普通 class（`ReactLoopAgent`，`agent.ts` 約 690 行），不是圖：`turn()` 外層 `while` 循環 `step()`，每步是「準備請求 → 串流 → 寫 assistant 訊息 → 執行工具」；狀態只有 idle／running／maintenance 三個 phase，中止靠 `AbortController`。擴充點全是事件：`agent/pre-step`、`agent/request`、`agent/request-error`、`agent/turn-stopping`，工具端是 `tools/*`。工具排程獨立在 `tool-calls.ts`：獨占的工具當屏障，可並行的走有上限的滾動池，結果按模型順序提交；中止時沒啟動的呼叫補一筆合成錯誤結果，讓日誌保持可重播。

今天 pump 在圖外，圖在 LangGraph；`step-inbox.ts` 與 `turn-cancel.ts` 靠 `configurable` 把圖外的東西交進圖裡。事件化之後迴圈是 core 的 driver，這類載體應該消失；`beforeModel`／`afterModel` 每步多一個圖節點的成本也隨之消失，在 dsh 裡它們是函式呼叫。這是收益，也是範圍：driver 要自己寫，尺寸大約是 dsh 這幾個檔的量級，不等於工期。

**D3 核准與中斷。** dsh 的做法是 `approval.request()` 在 `tools/pre-execute` 內 `await` 一條 `approval/request` waterfall；**待核准請求不會跨重啟存活**：
- 等待是記憶體裡的 Promise。`approval/asked` 與 `approval/decided` 只是「log-only audit」，不進模型對話，也不是狀態機（`user-approval/src/types.ts`）。
- 預設失敗收斂：沒有 answerer、answerer 拋錯、回傳非詞彙內的值，都得到 `unavailable`；中止得到 `cancelled`；`never` 政策在 service 自己的路徑先決定，不依賴 listener 順序。
- 要求必須在開著的 turn 裡發出（`hasOpenTurn`），因為 turn 是日誌的 commit／replay 邊界。
- **重啟時**，`resume()` 讀日誌後用 `interruptedTurnClosers` 補收尾事件（`agent-loop/src/index.ts:855`、`session/src/repair.ts`）：缺結果的工具呼叫補合成錯誤、補 `step/end`、補 `turn/end(reason: interrupted)`。已啟動但沒結果的呼叫，錯誤文字明講「結果未知，只有唯讀或冪等才重試，有副作用先驗證外部狀態或問使用者」。所以重啟後，等待核准中的工具呼叫變成「已中斷、結果未知」，由模型決定怎麼辦，**使用者不會再看到那張核准卡**。

對 nexus 的意義有兩面。我們的 async 核准 gate（`approvals` 註冊點，pre-execute waterfall）與 dsh 同形，搬過去不用發明新機制。但今天的 HITL 用 LangGraph 的 `interrupt`／`resume`，我們這邊的核准**是否**能跨行程重啟，這份草稿從沒驗過，需要確認；若現況確實可以，放棄 `interrupt` 就是**能力倒退**，必須按 AGENTS.md「偏離規則」登記，並且要問客戶（國家儀器中心）是否需要「核准卡在重啟後仍在」。另外 `approval/asked` 沒有配對 `decided` 的日誌（崩潰在等待中）要如何被稽核方理解，要和 10/12 之後的稽核規劃一起處理。

**D4 子代理的事件歸屬。** 事件帶 agent 身分、監聽者自己過濾，或匯流排過濾？牽涉「同層報錯、跨層遮蔽」的既有規則。

**D5 推翻 #190。** 事件匯流排一旦存在，#190 的偏離登記與索引的前提就沒了；`interception-index.test.ts` 的絆索要**翻面**（不是刪除），每一格要改記「現在由哪個事件佔住」。

**D6 與企業功能的關係。** 管理員後台、插拔與稽核**不依賴**這份契約：「新舊並存」靠每個 thread 組裝一次，與迴圈長什麼樣無關。反過來，事件契約也讓稽核更好做（`tools/pre-execute` 本來就是審計的天然切點），但不是前置。

## 七、這份草稿沒有回答的

- **dsh 迴圈實作只讀了一部分**。`agent.ts`、`tool-calls.ts`、`inbox.ts`、`user-approval` 已讀（§六 D1–D3）；`assistant-stream.ts`（串流重試與中途出錯）、`runtime-context.ts`（system prompt 投影）、`index.ts` 的組裝段（300–800 行）沒讀。
- **dsh 日誌的持久化到什麼程度沒讀**：崩潰時最多掉幾個事件、事件是否逐筆落盤。這決定 nexus 能不能承諾「重啟不丟資料」，D1 若要採納，這一項要先查。
- **nexus 現有核准是否真的跨重啟存活沒驗**（D3）。
- **28 顆 middleware 每一顆做什麼、是否改寫訊息**，只有分類，沒有逐檔核對；§三 3-2 的表要在 S1 動工前重做。
- **13 個插件各自用了 LangChain 的什麼**（`tool()` 還是 middleware），沒看。
- **橋接 middleware 的語意落差**（`wrapModelCall` 對 `llm/stream`）沒驗。
- **沒估人力**。行數與檔數只能當尺寸，不能換算成工期（同 `rust-and-langchain-removal-2026-10-06.md` §7-7）。
- **模型面行為沒量**：任何一段事件化後，工具描述、摘要觸發、`task` 描述是否逐位元組相同，都要 live A/B。

## 八、下一步（要你決定的）

1. **要不要正式推翻 #190？** 這決定這份草稿能不能升級成決議卡。
2. **時序**：核心替換排在企業功能（10/12 之後的身分、角色、稽核）之前、之後，還是並行？D6 說兩者不互相依賴，但人力是共用的。
3. **「會話日誌是唯一真相」這個前提要不要走？**（補讀迴圈實作後，D1 收斂成這一題。）要，就是拿掉 LangGraph 狀態那一份；不要，事件化只能停在 S1（工具事件），S2 之後走不下去。

   **2026-10-08 demian 採納建議（方向拍板，不排期）：**
   - **方向是走**：以會話日誌為唯一真相，最終拿掉 LangGraph 狀態那一份。
   - **S0、S1 不依賴這個前提**，可先做。
   - **S2 之前必須先過兩道檢查**：(a) [#1158](https://github.com/DemianLi/nexus-agent/issues/1158)：查清 dsh 日誌的持久化保證（崩潰時最多掉幾個事件、是否逐筆落盤）；(b) [#1159](https://github.com/DemianLi/nexus-agent/issues/1159)：拿錄下來的真實會話，驗證「從日誌推出的歷史」與 LangGraph 現在送給模型的訊息逐位元組相同，不同之處就是 D1 的真實工作量。
   - **退回條件**：持久化保證比我們現在弱得多，或比對發現大量插件的訊息改寫無法記錄成事件，則退回只做 S1。
   - **兩道檢查的結論**：(a) [`session-log-durability-comparison-2026-10-08.md`](session-log-durability-comparison-2026-10-08.md)——退回條件未觸發；(b) [`log-derived-history-vs-wire-2026-10-08.md`](log-derived-history-vs-wire-2026-10-08.md)——退回條件未觸發：兩輪共 41 個場景（含 CLI 非串流、serve 串流、子代理、核准、中止、插話、重啟）、153 次主模型呼叫裡，134 次在校正三處機械差異後逐位元組相同；其餘 19 次都只差一則訊息或一段前綴：14 次來自核心的工具結果剪刀與舊工具參數截斷（只改請求、不寫日誌，需要補事件；參數截斷 dsh 沒有對應機制），1 次是空的助手訊息在送出前被丟掉（推導時丟掉即可），2 次是整份日誌叫過模型卻沒有回覆時推導函式整份拒推（今天的續接就會少掉使用者第一句；dsh 沒有這道限制），2 次是前景 `task` 子代理的日誌沒有它的輸入事件（背景子代理與 dsh 都有）；核准在同一行程內全部相同、但停在核准點時重啟核准就沒了；真供應商的串流分塊、真模型沒有量。
   - 這是方向而非決議卡：#190 要不要推翻、時序（第 1、2 題）仍待決。
4. **核准要不要跨重啟存活？**（D3）dsh 的答案是否；若客戶需要，這條是偏離，要自己設計並登記。
