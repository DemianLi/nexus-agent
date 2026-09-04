# 萬物皆可插件：實作到哪、還缺什麼 —— 對照 dsh 與 Proteus 的調研

這份筆記回答兩個問題：[開發計劃](development-plan.md)「萬物皆可插件」那套架構**今天落地到什麼程度**；以及以 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（dsh，本 repo 的技術實現標準）與 [Proteus](https://github.com/proteus-evolve/Proteus) 為對照，**agent 架構裡很需要、而我們還沒有的東西是什麼**。

**調研日期**：2026-09-02。對讀版本：dsh `4e84901e6471b79ec0338099867ebb4606d12bb5`（master，2026-09-01 的 `dsh-0.1.2-alpha.4`）；Proteus `962304b320c57475227f056f52a71f3cd3d437f0`（main，2026-08-28，v0.3.0）；基座 `deepagents@1.13.1`。兩份 clone 都在 `references/`，不進版控。

## 這份筆記的來源與可信度

| 區塊 | 誰做的 | 核對狀況 |
| --- | --- | --- |
| 我們這側的落地狀況（§二） | 主代理讀 | 第一手；每個 PR／issue 編號都用 `gh … view --json title` 核過 |
| dsh 51 個頂層套件的對照（§三） | 主代理讀 | 第一手；套件清單出自 `ls -d packages/*/`，每列的「它做什麼」出自該套件 `README.zh.md` 的 `description:` 欄位 |
| Proteus（§四） | 主代理讀 | 第一手；`README.md`、`ROADMAP.md`、`docs/ADAPTERS.md`、`docs/EPISODE.md`、`docs/MEASUREMENTS.md`、`proteus/adapters/` |
| 缺口排序（§五） | 主代理 | 判斷，不是事實；理由逐條附出處 |

**前兩版由子代理產出，兩版都整份丟掉了。** 第一版把 dsh 的套件數寫成 43（實際 51）、把 `hooks/` 讀成「IDE 集成」（實際是執行使用者既有的 shell 鉤子）、抽核七個 issue 編號錯四個、compaction 那節的核心主張（「基座不知道自己壓過什麼」）與 `dist` 原始碼相反。第二版是刪掉錯的段落而不是修正，2.4 把 26 個套件塞成一句話，還留著我指出不存在的路徑。這一版是主代理重讀第一手材料寫的；沒把握的部分收在 §六，不混進正文。

## 一、結論

**契約層落地了，而且被用過。** `PluginRegistry` 有 14 個欄位（9 個折進 `createDeepAgent` 的註冊點 ＋ 5 條不折的通道），`packages/` 底下 11 個生產 plugin 全走這條契約，`@nexus/plugin-echo` 靠 pnpm 相依隔離證明契約沒有偷偷要求伸手進組裝點。計劃書 §1 寫的形狀（命令式註冊、同層報錯、跨層遮蔽、fail-closed、載入期失敗）每一條都有對應的程式碼與測試。

**廣度比 dsh 窄很多，但窄的地方分兩種。** dsh `packages/` 的 51 個頂層套件裡，我們有等價物的 8 個、部分的 12 個、沒有的 29 個、不適用的 2 個。29 個「沒有」裡超過一半是企業級與分散式的東西（`api`／`host`／`client`／`typert`／`sdk`／`acp`／`identity`／`settings`／`credentials`／`webhook`／`attachment`／`lsp`／`web`／`e2b`）——那是定位差異，不是缺口。**真正算缺口的是 agent 迴圈本身會用到、而 dsh 的 base 組合預設就開著的那幾個**：compaction 由誰選門檻（#142／#143 進行中）、迴圈衛生的兩個 guard（重複呼叫提醒、單次工具逾時）、生命週期鉤子面（會話開始／提示詞提交／停止三個時刻）、以及所有東西都只在記憶體裡（會話日誌不落盤、checkpointer 是 `MemorySaver`、沒有 storage——決策 4 的三軸還沒收斂）。shell／sandbox／subprocess／terminal 是決策 3 明文延後的，不算意外。

**Proteus 不是另一個 harness，是量 harness 的儀器。** 它用 Docker 把 dsh、Pi、Aki 這些 harness 包起來，讓它們跨多個 episode 改寫自己的原始碼，然後量「harness 本身變了什麼」（結構距離、結晶測試、帶排列檢定的行為距離）。它對我們的意義不是抄設計——它是 Python、從外面包、是 research preview——而是它定義了一個 harness **可以被量**要具備什麼：無頭入口（有）、可讀的執行軌跡（會話日誌有但不落盤）、具名的可編輯 surface（memory／skills 目錄有，plugin 清單是程式碼）。**這三件裡缺的那一件，正好跟持久化是同一個缺口。**

## 二、原計劃 vs 現況

對著 [`development-plan.md`](development-plan.md) 的結構逐項對。「證據」欄的編號全部核過標題。

### 2.1 §1 契約的每一條

| 計劃寫的 | 狀態 | 證據 |
| --- | --- | --- |
| `NexusPlugin { id?, name, requires?, disabled?, apply }`，zod 只驗條目層四欄 | ✅ | `packages/nexus-core/src/plugin.ts`；#28 決議 9、#43（`name` 不唯一）、#104（`id`／`disabled`） |
| 九個折疊註冊點：`tools`／`subagents`／`capabilities`／`backend`／`middleware`／`permissions`／`approvals`／`skills`／`memory` | ✅ | `packages/nexus-core/src/registry.ts:559-567`；折疊在 `fold.ts` |
| 「九個之外有一條 `lifecycle` 通道」 | ✅ 但**數字過時** | 現在是**五條**不折的通道：`lifecycle`（#59 為 MCP 的 stdio 子行程引進）、`telemetry`（#89→#100）、`invariants`（#101）、`commands`（#118→#119）、`sessions`（#132→#138）。`registry.ts:559-572` 是 14 個欄位。`registry.ts` 檔頭與計劃 §1 原本寫「四條」／「一條」，**與這份筆記同一張 PR 改正** |
| 一個 plugin 只相依 `@nexus/core`，靠 pnpm 隔離擋住 `import '@nexus/harness'` | ✅ | `packages/nexus-plugin-echo/src/index.ts` 檔頭；#30 |
| `requires` 對能力集合做存在性檢查、不排序 | ✅ | `registry.capabilities`；#28 決議 10、#29 |
| 同層報錯、跨層遮蔽、fail-closed、載入期失敗 | ✅ | `registry.ts`、`load.ts`；`packages/nexus-core/src/registry.test.ts`（20KB） |
| `subagents` 沒有層、同名一律報錯 | ✅ | `registry.ts:112` |
| 組裝點所有、plugin 不得提供：backend、工具順序、model、checkpointer／store、核准開關 | ✅ | `apps/harness/src/agent-factory.ts`（`CreateNexusAgentOptions`） |
| 工具呈現順序自建（顯式清單＋rest entry＋字典序） | ✅ | `apps/harness/src/base-tools.ts`；`fold.ts` 的 `orderTools` |
| `permissions` 只是意外防護、圍堵靠換 backend | ✅ 而且被量過 | #62 `ContainedFilesystemBackend`；#66／#70／#82 釘住「寫不經過 permissions、讀不經過 fence」 |
| `interruptOn` 詞彙封閉、缺 checkpointer 即拒絕、全域標記併進 subagent | ✅ | #111／#112 把閘門搬到 `wrapToolCall`、逐次判；`apps/harness/src/interrupt.test.ts` |
| （計劃沒列）基座會依模型改寫組裝，組裝點要自證 | ✅ 後補 | #140→#141 `apps/harness/src/harness-profile.ts`，`expectedHarnessProfile` 宣告 |

### 2.2 §2 七層架構

| 層 | 計劃自評 | 今天 | 證據 |
| --- | --- | --- | --- |
| 感知輸入 | 足夠 | ✅ | `apps/harness/src/messages.ts`；`cli.ts`、`serve.ts` 兩個入口 |
| 意圖與理解 | 薄 | ⚠️ 仍薄 | 單一供應商單一模型（`live-model.ts` 的 `openai/gpt-oss-120b`，量出來的）；模型層完全外包 LangChain；#141 把基座按模型改組裝這件事守住了，但沒有 dsh 那種提供方無關的 `ctx.llm` seam |
| 規劃與編排 | 完整 | ✅ | deepagents 迴圈 ＋ `@nexus/plugin-plan-mode`（#117）＋ `@nexus/plugin-todo`（#139）＋ `@nexus/plugin-goal`（#128／#129）。#16 原列的自我批判／意圖分類兩方向已被 dsh 否掉（計劃 §2 記了理由） |
| 記憶 | 三個都在但只注入不保存 | ⚠️ 同 | `@nexus/plugin-memory`（#68）、`@nexus/plugin-skills`（#69）都刻意薄，靠基座 middleware；摘要層 #70 釘住了縫，**但生產路徑沒用那條縫**——這是 #142 |
| 執行與工具 | 完整 | ✅ 有界 | MCP（#59）、fs 圍堵（#62）、QuickJS（#64）；shell／sandbox 決策 3 延後，且基座三條件互斥（`sandbox-backend-conflict.test.ts`） |
| 反思與反饋 | 薄 | ⚠️ 有實作 | `@nexus/plugin-validation`（#73）：輸出 schema 校驗。把「工具拋錯整場死」修回回饋的那一半 **#159 之後歸 `@nexus/core`**（`packages/nexus-core/src/containment.ts`，由 `foldRegistry` 打底進 root 與每個 subagent），不再是掛不掛隨人的 plugin |
| 輸出 | 串流完整、UI 待做 | ✅ 兩半都有了 | `@nexus/wire` ＋ `thread-pump.ts`／`wire-handler.ts`／`wire-server.ts`（#76 定形、#77 pump）；`apps/web/src/App.tsx` 對話介面 ＋ `approval-card.tsx`／`transcript.tsx`／`status-line.tsx` |

### 2.3 Phase 0–5

| Phase | 項目 | 狀態 | 證據 |
| --- | --- | --- | --- |
| 0 | spike ＋ 真實供應商接線 | ✅ | #37；#31 記了驗收與模型比較的落差 |
| 1 | 核心迴圈 ＋ plugin 契約 | ✅ | §2.1 全表 |
| 2 | MCP plugin | ✅ | #59 |
| 2 | fs backend ＋ 圍堵 | ✅ | #62 |
| 2 | QuickJS 直譯器 | ✅ | #64（同張 PR 釘了 sandbox backend 互斥） |
| 2 | DeepSeek 供應商驗收 | ❌ | #61 開著，卡在帳號與 key |
| 3 | 記憶來源 | ✅ | #68 |
| 3 | skill 來源 | ✅ | #69 |
| 3 | 摘要層調校 | ⚠️ | #70 釘住設定入口與兩個靜默失敗；#144 釘住 `fraction` 門檻的兩個相反失敗；**生產未配置** → #142（三個決定已做）、#143（留痕，等 #142） |
| 3 | checkpointer／store／backend 三軸收斂 | ❌ | 決策 4 未收斂；checkpointer 仍是 `MemorySaver`，會話日誌不落盤（`session-log.ts` 對 `node:fs` 零命中） |
| 4 | HITL 核准 | ✅ | 擴充點 Phase 2 就落地；#111／#112 改逐次判；web 端 `approval-card.tsx` |
| 4 | 可觀測性 | ✅ | #100 OTLP 後端 ＋ 遙測披露（`telemetry-disclosure.ts`）；tracing 那半是基座自己開的，我們補的是「說出來」與脫敏 |
| 4 | 工具失敗回饋 ＋ 輸出校驗 | ✅ | #73 |
| 5 | web 傳輸線 | ✅ | #76（形狀）、#77（pump）；`packages/nexus-wire` |
| 5 | 對話 UI | ✅ 存在 | `apps/web/src/App.tsx`、`App.test.tsx`（13KB）。**沒有逐條核 Phase 5 的驗收句**，見 §六 |
| 5 | 核准 UI | ✅ 存在 | `apps/web/src/components/approval-card.tsx` |
| 5 | eval suite | ✅ | `apps/harness/src/eval/`（`compare`／`survey`／`tiers`／`scorers`）；[`model-inventory.md`](model-inventory.md) |

### 2.4 §6 六大補強項

| 補強項 | 狀態 |
| --- | --- |
| Human-in-the-loop | ✅ 閘門 ＋ CLI 說出來 ＋ web 卡片 |
| 權限控制 | ⚠️ 檔案那半有（fs 圍堵 ＋ permissions），行程那半延後（決策 3） |
| 可靠性 | ✅ #73 ＋ eval；**迴圈衛生那塊沒有**（見 §五第 2 條） |
| 可觀測性 | ✅ #100 |
| 狀態儲存選型 | ❌ 未收斂 |
| 業務邏輯解耦 | ✅ 契約本身 |

## 三、dsh 51 個頂層套件對照

清單出自 `ls -d references/deepseek-harness/packages/*/`。「它做什麼」是該套件 `README.zh.md` 的 `description:` 欄位改寫成繁體、壓成一句。「狀態」四值：**有**（功能等價，形狀可以不同）／**部分**／**沒有**／**不適用**。

| # | dsh 套件 | 它做什麼 | 我們 | 狀態 |
| --- | --- | --- | --- | --- |
| 1 | `acp` | 經 JSON-RPC stdio 把 agent 暴露給程式化客戶端的無 UI 伺服器 | 沒有。`@nexus/wire` 是給 `apps/web` 的 HTTP＋SSE，不是給程式的協定 | 沒有 |
| 2 | `api` | Remote 層：型別化的 Client→Host 能力呼叫、結果與轉發事件（gateway／session／settings／workspace controller） | `wire-handler.ts`＋`thread-pump.ts`＋`@nexus/wire`——一個 route、一條下行的極簡版 | 部分 |
| 3 | `attachment` | 持久圖片附件 | 沒有 | 沒有 |
| 4 | `boot` | app 啟動：環境載入、profile 與 patch 層、清楚的啟動失敗訊息、命令列 | `apps/harness/src/cli.ts`（41KB）、`serve.ts`。沒有 profile／patch 層——plugin 清單由程式碼寫死，外部覆寫是 #46 明文「需要時再啟動」 | 部分 |
| 5 | `bundle` | 現成的 profile bundle：base／headless／web-app／acp-app／sdk-app／sdk-minimal | 沒有。組裝由 `createNexusAgent` 的呼叫端逐一寫 | 沒有 |
| 6 | `client` | web GUI 瀏覽器側：外殼、Remote 通訊、40 多個 `ui-*` 功能插件 | `apps/web/src/`：`App.tsx`＋`transcript`／`approval-card`／`status-line` 三個元件。功能對得上三格；不是插件化 UI | 部分 |
| 7 | `code-runtime` | 程式碼執行 seam：python、worker-thread 兩個提供方 | `@nexus/plugin-quickjs`：一個 JS 直譯器、走 custom tool。不是 seam | 部分 |
| 8 | `compaction` | 自動壓縮、按需 `/compact`、工具輸出修剪 | 基座無條件掛 `SummarizationMiddleware`；門檻是基座選的（對我們的模型退到 fallback 常數）、subagent 射程、留痕、`/compact`、pruner、溢出恢復全缺。#142 三個決定已做、#143 等它 | 部分 |
| 9 | `context` | 不定義工具、每次請求加模型可見上下文：`agent-instructions`（AGENTS.md）、`time-context`、`file-reference`、`session-reference`、`tmux-context` | `@nexus/plugin-memory` ≈ `agent-instructions`（靠基座 `createMemoryMiddleware`）。其餘四個沒有 | 部分 |
| 10 | `core` | 會話日誌、系統提示詞組裝、工具註冊表、agent 詞彙與預設迴圈、scope | `session-log.ts`（會話日誌）、`registry.tools`＋`fold.ts`＋`base-tools.ts`（工具註冊與呈現順序）、迴圈外包 deepagents、系統提示詞由基座組而 `harness-profile.ts`（#141）守著它。沒有 `ctx` 服務樹——那是 Cordis 的 | 有 |
| 11 | `credentials` | 憑證引用 seam：設定裡只放引用不放值、按操作解析、環境與檔案提供方 | 沒有 seam。`docs/standards.md:19-25` 是規範（一律環境變數、不得有 fallback），不是機制 | 沒有 |
| 12 | `e2b` | 遠端 Linux 沙箱（fs＋subprocess） | 沒有 | 沒有 |
| 13 | `examples` | 示範 | `apps/harness/src/spike/`、`*.fixture.ts` | 不適用 |
| 14 | `experimental` | 不進正式發布的原型：agent-team、inspector、webworker 等 | 沒有 | 沒有 |
| 15 | `extensions` | 模型側工具定義、運行與移除**動態** Cordis 套件 | 沒有。計劃 §1 明文「射程限定為載入期回滾，不承諾執行期熱插拔」 | 沒有 |
| 16 | `feedback` | 使用者對會話與 assistant 訊息的反饋 | 沒有 | 沒有 |
| 17 | `fs` | `ctx.fs` 提供方約定、本地與沙箱後端、編輯前讀取策略、面向模型的檔案與搜尋工具 | `registry.backend`＋`ContainedFilesystemBackend`（#62）＋基座 filesystem 工具＋`registry.permissions`。`fs-sandbox` 那格沒有 | 有 |
| 18 | `goal` | 每會話一個持久目標：域、模型工具、使用者命令、自動續行 | `@nexus/plugin-goal`（#128、#129）。檔頭自述四個子套件只做兩個——沒有 `tool-goal`、`goal-round-driver` | 部分 |
| 19 | `guard` | 迴圈衛生：`repeat-tool-reminder`（同參數重複呼叫 3／5／8 次時建議性提醒）、`timeout-policy`（單次工具呼叫協作式逾時→清楚的模型錯誤）。**dsh base 兩個預設開著** | 沒有。近似物是 `recursionLimit`（硬上限；`looping-model.ts` 量過換算）與供應商層的 `LIVE_TIMEOUT_MS`——前者不看重複、後者不是每次工具呼叫 | 沒有 |
| 20 | `hooks` | 在 agent 運行期執行使用者**既有的** Claude Code／Codex `hooks.json` shell 鉤子：會話開始、提示詞提交、工具前後、停止時觸發；可帶模型可見訊息阻塞、附加上下文、強制繼續 | 沒有。近似物：`wrapToolCall`／`wrapModelCall`（工具、模型前後）、`registry.approvals`（阻塞工具）、`lifecycle.onDispose`（關機）。缺會話開始、提示詞提交、停止三個時刻；也沒有跑外部 shell 鉤子的引擎 | 沒有 |
| 21 | `host` | Web GUI Host 側：HTTP 與 SPA 伺服器、工作區目錄選擇、插件清單投影 | `wire-server.ts`（不綁 port 的 handler ＋ 一個 socket）；沒有目錄選擇、插件清單投影 | 部分 |
| 22 | `identity` | 匿名的 per-harness-home 關聯 id | 沒有 | 沒有 |
| 23 | `interaction` | 人機協作：`commands`、`permission-presets`、`tool-ask-user`、`user-approval`、`user-questions` | `commands` ✅（`@nexus/plugin-commands`，形狀照 `dsh-commands`）；`user-approval` ≈ `registry.approvals`＋`approval.ts`＋`approval-card.tsx`。`permission-presets`、`tool-ask-user`、`user-questions` 沒有 | 部分 |
| 24 | `jobs` | 背景任務：註冊表約定、行程本地儲存、模型側任務工具 | 沒有。執行模型是一次 `invoke` | 沒有 |
| 25 | `llm` | 提供方無關的模型呼叫服務、DeepSeek 與 pi-ai adapter、重試執行器、回放感知的 token 計量 | `live-model.ts`（`ChatOpenAI` 指 NVIDIA 端點；retry 在檔頭有偏離登記）；模型呼叫外包 LangChain。沒有 `token-meter` | 部分 |
| 26 | `lsp` | LSP 程式碼導航 | 沒有 | 沒有 |
| 27 | `mcp` | 掛外部 MCP server，工具作原生工具呼叫 | `@nexus/plugin-mcp`（#59），一實例一 server，照 `mcp-client` | 有 |
| 28 | `plan` | 計劃模式 | `@nexus/plugin-plan-mode`（#117），帶一筆已登記的偏離（`stateSchema` 而非會話事件） | 有 |
| 29 | `preset` | 按會話從 preset 檔組裝 agent；persona | 沒有。組裝來源是程式碼不是檔案（#140 卡裡已對照） | 沒有 |
| 30 | `runtime-diagnostics` | 套件自有的運行時不變量檢查 | `registry.invariants`＋`invariant.ts`／`invariants.ts`＋`apps/harness/src/package-invariants.ts`（#101） | 有 |
| 31 | `sandbox` | 行程沙箱 seam：隔離、各平台後端（bwrap／Landlock／Seatbelt／Windows ACL）、策略解析 | 沒有。`@nexus/plugin-quickjs` 檔頭登記為結構性偏離；決策 3 延後 | 沒有 |
| 32 | `schedule` | 會話本地的持久提醒（`schedule_create`／`list`／`delete`） | 沒有 | 沒有 |
| 33 | `sdk` | JSON-RPC 協定 ＋ 行程外 SDK 的 client／server | 沒有 | 沒有 |
| 34 | `session-query` | 搜尋、追蹤、讀取實時與持久會話歷史；日誌匯出 | 沒有 | 沒有 |
| 35 | `session` | 持久會話資料平面：persistence seam（jsonl／sqlite）、checkpoint 策略、投影、標題、統計、對外遙測 | `session-log.ts`（行程內 append-only，**不落盤**）、`session-telemetry.ts`＋coordinator＋`@nexus/plugin-telemetry-otel`（#100）、`sessions.ts`／`session-registry.ts`（#138 subagent 各一份）。persistence／checkpoint-policy／projection／title 沒有 | 部分 |
| 36 | `settings` | 使用者設定 seam ＋ YAML／JSON 檔提供方 | 沒有（#46） | 沒有 |
| 37 | `shell` | bash／pwsh 本地與沙箱執行器、持久與一次性工具 | 沒有。決策 3 延後 | 沒有 |
| 38 | `skill` | 由提供方發現、經會話目錄與 skill 工具載入的可複用指令 | `@nexus/plugin-skills`（#69）靠基座 `createSkillsMiddleware`。沒有 `tool-skill`、`skill-badge` | 有（薄） |
| 39 | `spill` | 過大的工具文字外溢到儲存、回傳可檢索定位 | 沒有。基座的 `truncateArgsSettings` 是截斷不是外溢 | 沒有 |
| 40 | `storage` | 非會話資料的持久化：具名後端、型別化領域資料 | 沒有。checkpointer 是 `MemorySaver`；決策 4 三軸未收斂 | 沒有 |
| 41 | `subagent` | 委派 seam、in-process／fork／spawn／acp／claude-code／codex／dsh-sdk 後端、控制與回報工具 | `registry.subagents` → deepagents `SubAgent`（in-process）；#136 root-only 工具、#138 各自的會話日誌。沒有其他後端與控制工具 | 部分 |
| 42 | `subprocess` | 共享的子行程 seam 與本地提供方 | 沒有（MCP 的 stdio 子行程由 `@langchain/mcp-adapters` 自己管） | 沒有 |
| 43 | `terminal` | 持久終端：owner 範圍的 `ctx.terminals`、互動式 bash／pwsh、6 個工具 | 沒有 | 沒有 |
| 44 | `test-support` | 無密鑰測試工具、LLM mock 與回放伺服器、loader 冒煙測試 | `scripted-model.ts`、`looping-model.ts`、`fixtures.ts`、`mcp-fixture-server.ts`。不是獨立套件 | 有（形狀不同） |
| 45 | `todo` | 基於會話日誌的模型側 `todo_write` | `@nexus/plugin-todo`（#139），照 `tool-todo` | 有 |
| 46 | `typert` | 建構時型別圖 ＋ 運行時註冊表，支撐型別化 Host→Client 呼叫 | 沒有；in-process 架構用不到 | 沒有 |
| 47 | `util` | 共享工具函式 | — | 不適用 |
| 48 | `web` | 搜尋／抓取服務、提供方後端、模型側工具 | 沒有 | 沒有 |
| 49 | `webhook` | 經驗證的外部事件建會話 | 沒有 | 沒有 |
| 50 | `workflow` | 模型編寫、可扇出 subagent 的編排腳本 | 沒有 | 沒有 |
| 51 | `workspace` | 持久工作區實體、成員資格記賬 | 沒有。`ContainedFilesystemBackend({ rootDir })` 是組裝期的一個 root | 沒有 |

**小計**：有 8（`core`、`fs`、`mcp`、`plan`、`runtime-diagnostics`、`skill`、`todo`、`test-support`）；部分 12（`api`、`boot`、`client`、`code-runtime`、`compaction`、`context`、`goal`、`host`、`interaction`、`llm`、`session`、`subagent`）；沒有 29；不適用 2。

**29 個「沒有」怎麼分**：企業級與分散式 14 個（`acp`、`api` 以外的 Remote 家族 `sdk`／`typert`、`identity`、`settings`、`credentials`、`webhook`、`attachment`、`lsp`、`web`、`e2b`、`feedback`、`experimental`、`extensions`、`bundle`／`preset`）——定位差異；決策 3 明文延後 4 個（`shell`、`sandbox`、`subprocess`、`terminal`）；需求未出現 5 個（`jobs`、`schedule`、`workflow`、`session-query`、`workspace`）；**agent 迴圈自己會用到、dsh base 預設開著、我們沒有的 3 個：`guard`、`hooks`、`storage`**（加上 `session` 那列的 persistence 那半）。這三個是 §五排序的主角。

## 四、Proteus 讀後

### 4.1 它是什麼

「Self-evolution for any agent harness. Plug in. Evolve. Measure.」（`README.md`）。Python 3.10+、MIT、v0.3.0、自標 research preview（`proteus/__init__.py`、README 徽章）。把**任何** harness × **任何**模型接進來，讓它跨多個 context-fresh 的 episode 改寫自己的 harness，然後量 **harness 本身變了什麼**——在有目標、多目標、或**沒有目標**的條件下。

README 的「Why Proteus is different」列三點，每一點都對應到程式碼：

1. **Harness-agnostic**：實作一個 `HarnessAdapter` 就能接（`docs/ADAPTERS.md`）。內建五個 adapter：`minimal`（離線 mock，CLI 預設）、`llm`（OpenAI 相容的 live 模型）、`dsh`、`pi`、`aki`（`proteus/adapters/*.py`）。
2. **有目標與無目標、評估器可見或隱藏**：`no-goal | one goal | many goals`，無目標的無壓力進化是一級模式。
3. **測量儀而非分數**：結構距離（per surface、路徑長度）、結晶／交換測試（移除 disposition 後讀回 harness）、行為距離（帶排列檢定的行動偏好統計）。

### 4.2 它跟 dsh 的關係

**dsh 是 Proteus 量的對象之一，不是競品。** `proteus/adapters/dsh.py`（25KB）、`environments/deepseek-harness/`、`environments/dsh-src/` 三處：Proteus 把 dsh 的 headless profile 裝進釘死 SHA 的 Docker 映像，每個 episode 啟動一份「上次通過驗證」的凍結副本，模型在旁邊寫一份 candidate，reflect 之後才重建與驗證那份 candidate（`docs/ADAPTERS.md` 的 External, source-evolving CLI 一段）。disposition 以可移除的標記區塊寫進 `AGENTS.md`，軌跡從 dsh 自己的會話日誌解析。

也就是說：**dsh 是 harness，Proteus 是儀器，兩者是不同層。** 對我們而言 dsh 仍是實現標準，Proteus 是「如果要量自己，得長成什麼樣」的規格。

### 4.3 契約與 episode 迴圈

adapter 是七個方法加三個旗標（`docs/ADAPTERS.md:40-58`）：`surfaces()`、`required_edit_tools()`、`seed()`、`install_disposition()`、`run_episode()`、`validate_candidate()`（可選的邊界閘門）、`read_trace()`、`disposition_fingerprint()`；旗標 `continuity_mode`、`staged_activation`、`disposition_in_files`。

分工一句話（`docs/EPISODE.md`）：**框架擁有交易，adapter 擁有 harness 的執行。** 快照、candidate 接受／拒絕、回滾、記錄、恢復是框架的；某個 harness 怎麼跑一個 phase、怎麼驗 candidate 是 adapter 的。每個 episode：組 prompt → 具現上一份有效快照 → 對它跑四個 phase（observe／propose／act／reflect）同時寫一份獨立 candidate → 讀軌跡 → 邊界可行性閘門 → 評估器 → 選擇 → 晉升或保留＋還原 → 記錄與反饋 → 下一個 episode 啟用。

三件跟我們的設計對得上的事：

- **Surface 宣告成資料**（`Surface("memory", "memory", unit="file", write_tools={...})`）。這是「讓任何 harness 可量」的關鍵——量的單位（檔案、目錄、程式碼裡的頂層定義）是宣告出來的，不是猜的。我們的 memory 目錄、skills 目錄天然是 surface；plugin 清單今天是程式碼，不是。
- **Staged activation ＋ `validate_candidate()`**：編輯在這個 episode 提案，通過閘門的才在下一個 episode 生效；失敗不會卡住整個 harness，框架退回上一份好快照。這跟我們「載入期 fail-closed」是同一種直覺，顆粒度從「一次啟動」放大到「一個 episode」。
- **框架私有記錄放在受量對象之外**（`.proteus-records/<run-id>/` 在 `<run-id>/` 外面，`docs/MEASUREMENTS.md`）：隱藏評估器的歷史連暴露整個 run root 的 adapter 都看不到。快照則**關掉所有 ignore 規則**——「harness 是受量對象，裡面沒有東西可以對儀器不可見」（`docs/EPISODE.md`）。

### 4.4 不適合當我們參考的部分

- **語言與整合方式**：Python；從外面用 Docker 包 harness；實作層一行都對不上，能借的只有概念。
- **進化對象不同**：Proteus 進化的是 harness 的**原始碼**（dsh／pi 的 adapter 把 TypeScript 抽進 `harness/src/` 讓 episode 改、重建、驗證）；我們的可變面是**執行期組裝**（plugin 清單、memory、skills）。要被它量，得先定義我們的 surface 是什麼。
- **成熟度**：research preview；`ROADMAP.md` 的 T2 說 SWE-bench 已實作但「heavy」、grading 還沒完全走 sandbox。
- **它不是 harness**：沒有 compaction、hooks、permissions 這些東西可以拿來對照——它對 §三那張表沒有貢獻。

### 4.5 對我們的實際意義

Proteus 定義了「一個 harness 可以被量」的三個前提，對著我們今天的樹：

| 前提 | 我們 |
| --- | --- |
| 無頭入口（一個 episode 跑得起來、跑得完） | ✅ `apps/harness/src/cli.ts`、`serve.ts` |
| 可讀的執行軌跡（`read_trace` 從 harness 自己的日誌解析） | ⚠️ 會話日誌有（`session-log.ts`，八種事件），**但不落盤**；dsh 的 adapter 讀的是它落盤的 jsonl |
| 具名的可編輯 surface | ⚠️ memory／skills 目錄是；plugin 清單是程式碼；`goal`／`todo` 在會話日誌裡 |

**兩個 ⚠️ 指向同一件事：持久化。** 這是 §五把它排到第 4 而不是更後面的理由。

（子代理第一版寫「dsh 的 measurement 只有任務通過率」。那是 Proteus README 對「其他系統」的泛稱，不是對 dsh 的核對，已刪。）

## 五、缺口排序

排序準則：**agent 迴圈自己會碰到**（不是部署面、不是分散式）× **dsh base 預設就開著**（表示它認為每個 harness 都該有）× **我們的基座表達得出來**（表達不出來的要標偏離）× **大小**。企業級那 14 個不排；決策 3 延後的 4 個登記不排。

### 1. Compaction 的門檻與去向由我們選 —— 進行中

**缺什麼**：生產路徑跑的是基座無條件掛的 `SummarizationMiddleware`，門檻是基座依模型 profile 二選一挑的，對我們的模型退到一個與模型無關的固定常數，而且沒人在檢查。摘要發生時完全靜默。

**為什麼需要**：dsh 把它做成能力 seam（`compaction/` 四個子套件），門檻是設定且按模型可覆寫、載入時驗、有 `start`／`summary`／`end` 三個事件加一把鎖。

**表達得出來嗎**：可以——root 同名取代、subagent spec 上的 `middleware`、`getState()` 讀 `_summarizationEvent`，三條都實測過（#144 釘住）。表達不出來的部分（手動 `/compact`、指定範圍、鎖、溢出後恢復）已在 #142 登記為偏離。

**狀態**：#142 三個決定做完（配置且禁用 `fraction`；在 `foldSubAgents` 打底；留痕另開 #143）。**這是下一張最便宜的卡，不必再調研。**

### 2. 迴圈衛生的兩個 guard —— 一張小卡，最直接的插隊候選

**缺什麼**：`repeat-tool-reminder`（模型以同參數重複呼叫同一工具——反覆跑失敗的命令、反覆讀沒變的檔——在第 3／5／8 次送一條**建議性**提醒，要求它分析上一次結果、換方法或收工；每個 agent 分開計、新的使用者訊息清零）；`timeout-policy`（為宣告了限時的工具呼叫設協作式截止，經 `exec.signal` 請求停止，把已完成的取消映成 `Error: tool call timed out after <ms>ms`；絕不硬殺）。**兩個都隨 dsh base 預設啟用**（各自 `README.zh.md` 概述段）。

**我們有什麼**：`recursionLimit` 是硬上限，不分辨「在進展」與「在打轉」（`looping-model.ts` 量過換算是 `2 × 模型輪數 + 2`）；`LIVE_TIMEOUT_MS` 是供應商 HTTP 層的逾時，不是每次工具呼叫的。**沒有任何東西看「同一工具同參數重複」。**

**表達得出來嗎**：重複提醒——一個 `wrapToolCall` middleware：比對 `(name, args)`、每 agent 計數、命中時在 `ToolMessage` 後附一則提醒或改寫 `systemMessage`。deepagents 自己的 `createPatchToolCallsMiddleware` 就是這種形狀。逾時——需要 `AbortSignal` 能傳進工具執行；LangChain 工具的 `config.signal` 有沒有一路傳到 `wrapToolCall` 的 handler，**沒查**（§六）。

**大小**：一張卡（兩個 middleware 各一個 plugin，或一個 `@nexus/plugin-guard`）。**不動 #142 要動的三個檔。**

### 3. 生命週期鉤子面 —— 地圖卡

**缺什麼**：dsh `hooks/` 給五個時刻：會話開始、提示詞提交、工具前、工具後、停止；鉤子可以帶模型可見訊息**阻塞**提示詞或工具呼叫、**附加**上下文、或**強制運行繼續**（`hooks/README.zh.md`）。我們有工具前後（`wrapToolCall`）、模型前後（`wrapModelCall`）、阻塞工具（`registry.approvals`）、關機（`lifecycle.onDispose`）；**沒有**會話開始（`turn/start` 事件只寫日誌，不能注入或阻塞）、提示詞提交攔截、停止攔截（「你還沒做完，繼續」這種）。

**為什麼需要**：這是 plugin 能介入 agent 生命週期的完整面。今天一個 plugin 想「每個會話開頭注入一段上下文」或「agent 說做完了之前先跑一次檢查」，沒有地方掛。dsh 的 `context/` 那整組（time-context 等）就是掛在這個面上。

**兩個要分開問的問題**：(a) 要不要這個**面**（我們自己的 plugin 用）；(b) 要不要**執行外部 `hooks.json`**（dsh 的兩個 bridge 做的事）。(a) 是架構題，(b) 是相容性題，先答 (a)。

**表達得出來嗎**：langchain 1.x middleware 除了 `wrapToolCall`／`wrapModelCall` 還有沒有 `beforeAgent`／`afterAgent` 一類的鉤子，**沒查**（§六）。查出來是「有」的話這是一張卡，「沒有」的話要標偏離、退到入口層（`cli.ts`／`serve.ts` 手上有會話日誌）做。

### 4. 持久化 —— 地圖，決策 4 的續集

**缺什麼**：會話日誌在行程內（`session-log.ts` 對 `node:fs` 零命中）、checkpointer 是 `MemorySaver`、沒有 storage。行程一結束，會話、todo、goal、摘要事件全部消失。

**為什麼需要**：三個獨立的理由指向它。(a) dsh `session/` 那組的 persistence seam（jsonl／sqlite）是它整個資料平面的地基；(b) #143 要留痕、#138 給了 subagent 各自的日誌——寫進一個不落盤的日誌，價值只到行程結束；(c) §4.5：被 Proteus 量的前提之二就是軌跡可讀。

**表達得出來嗎**：checkpointer 那軸 LangGraph 有現成的（`SqliteSaver`／`PostgresSaver`）；會話日誌那軸是我們自己的東西，落盤格式可以直接照 dsh 的 jsonl。決策 4 說三軸要一起收斂——這是它還沒收斂的原因，不是表達力問題。

### 5. Context 注入插件 —— 一張小卡，等第 3 條

`time-context`（現在時間、時區、經過時長）是 dsh `context/` 裡最小的一個；`agent-instructions` 我們有（`@nexus/plugin-memory`）。dsh 讓注入的上下文以 user 角色訊息進會話歷史，所以可回放、可壓縮。表達得出來（`wrapModelCall` 加訊息），但它自然掛在第 3 條那個面上——面定了再做。

### 6. subagent 的其他後端 —— 待驗

dsh 有 in-process／fork／spawn／acp／claude-code／codex 六種委派後端；我們只有 deepagents 的 in-process `SubAgent`。deepagents 的 `.d.ts` 裡有 `ForkedSubAgent`、`AsyncSubAgent`，我們的 `foldSubAgents` 有沒有處理它們，**沒查**（§六）。查完再決定是缺口還是已經有。

### 7. 登記不排

- `shell`／`sandbox`／`subprocess`／`terminal`：決策 3 明文延後直到容器方案明朗；基座三條件互斥（`sandbox-backend-conflict.test.ts`）讓 QuickJS 走了 custom tool。
- `jobs`／`schedule`／`workflow`／`extensions`／`session-query`／`workspace`：dsh 有、我們沒有、需求沒出現。
- **Proteus 的測量軸**：不是我們的缺口，是「能不能被它量」——三個前提裡缺的那個就是第 4 條。持久化落地之後再開地圖，內容是：定義 surface、匯出軌跡、寫 adapter。

## 六、沒查清楚的

1. **Phase 5 的驗收句沒有逐條核。** `apps/web` 只確認了檔案存在與 `App.tsx` 檔頭；「完成度」是「存在」不是「驗過」。
2. **langchain 1.x middleware 有沒有 `beforeAgent`／`afterAgent` 或會話級鉤子**——決定第 3 條是一張卡還是一筆偏離。
3. **LangChain 工具執行的 `AbortSignal` 有沒有一路傳到 `wrapToolCall` 的 handler**——決定 `timeout-policy` 表達得出來嗎。
4. **`foldSubAgents` 對 `ForkedSubAgent`／`AsyncSubAgent` 的處理**——決定第 6 條是缺口還是已有。
5. **Proteus `environments/` 底下的 `openhands/`、`swe-agent/`** 是 adapter 還是 bench 環境——`proteus/adapters/` 裡沒有對應檔，`ROADMAP.md` T1 把它們列為待做 harness，所以傾向是環境骨架，沒有進一步讀。
6. **dsh `docs/subsystems/README.zh.md` 列的 53 個子系統頁與 51 個套件目錄的對應**——我以套件目錄為對照單位，沒有以子系統頁再對一次（例如 `agent-team` 在 `experimental/`、`token-meter` 在 `llm/`、`scope` 在 `core/`）。
7. **`interaction/user-approval` 與我們 `registry.approvals` 的語意差**——只對了「一次性核准」這個標籤，沒有對 `ApprovalOutcome`、策略、審計事件的形狀。
8. **兩處過時的數字**：`packages/nexus-core/src/registry.ts` 檔頭「四條」、`development-plan.md` §1「一條 `lifecycle` 通道」，實際都是五條。查清楚了，與這份筆記同一張 PR 改正。
