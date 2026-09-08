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

**廣度比 dsh 窄很多，但窄的地方分兩種。** dsh `packages/` 的 51 個頂層套件裡，我們有等價物的 8 個、部分的 14 個、沒有的 27 個、不適用的 2 個（**2026-09-05 更新過**：`guard` 與 `spill` 從「沒有」改成「部分」，理由見 §三小計）。27 個「沒有」裡 16 個是企業級與分散式的東西（`acp`／`sdk`／`typert`／`identity`／`settings`／`credentials`／`webhook`／`attachment`／`lsp`／`web`／`e2b`／`feedback`／`experimental`／`extensions`／`bundle`／`preset`）——那是定位差異，不是缺口。**真正算缺口的是 agent 迴圈本身會用到、而 dsh 的 base 組合預設就開著的那幾個**：compaction 由誰選門檻、迴圈衛生的兩個 guard（重複呼叫提醒、單次工具逾時）、生命週期鉤子面（會話開始／提示詞提交／停止三個時刻——**2026-09-07 更正**：那是三個**格號**不是三個空缺，見 §五第 3 條）、以及狀態幾乎都只在記憶體裡。**這份清單 2026-09-05 被 [#146](https://github.com/DemianLi/nexus-agent/issues/146) 消耗掉大半**（十七張卡，逐張的產出與偏離索引在那張圖的結案留言）：前兩項收完（§五第 1、2 條）；狀態那項做掉**會話日誌**這一軸（[#172](https://github.com/DemianLi/nexus-agent/issues/172)、[#174](https://github.com/DemianLi/nexus-agent/issues/174)，CLI 與 `serve` 的 `--session-log <dir>`），checkpointer 仍是 `MemorySaver`、仍沒有 storage，但那兩軸今天零消費者，判過不做（[#155](https://github.com/DemianLi/nexus-agent/issues/155)，見決策 4 的補記——**原文寫的「決策 4 的三軸」是錯的**：那三軸問的都是「LangGraph 的狀態存在哪」，會話日誌不在其中任何一軸上）。~~**留下來的是生命週期鉤子面**（§五第 3 條，開圖條件部分滿足——面要不要做已經答了，掛在哪個縫上還沒有）**與等著它的 context 注入**（第 5 條）。~~ **2026-09-07 這兩項都不再開著**（[#212](https://github.com/DemianLi/nexus-agent/issues/212)）：那個「面」不是第十個東西，它就是 [#190](https://github.com/DemianLi/nexus-agent/issues/190) 的九格——dsh 自己的橋接把五個鉤子逐個訂在其中五格上——而五格逐格有結局；縫因此也定了（第 2 格），~~第 5 條剩下的是開卡時選射程~~——**那句 2026-09-07 又被推翻兩次**：射程不是獨立的選擇（[#216](https://github.com/DemianLi/nexus-agent/pull/216)），而整項判為不是缺口（#215）。~~**留下來的是第 6 條那半沒查的問題**（`ForkedSubAgent`）。~~ **2026-09-07 那半也查完了**：`ForkedSubAgent` 與 fork-mode 的 `CompiledSubAgent` 在型別上都進不到我們的註冊點，第 6 條判為認帳不做，那條窄由 `registry.test.ts` 的欄位絆索釘著。**這張表因此沒有「待驗」的項目了**——上面點名的四項全部有結局，還沒動的只剩第 5 條，而它 2026-09-07 開成 [#215](https://github.com/DemianLi/nexus-agent/issues/215) 並當天答完：**判為不是缺口，降到第 7 條登記不排**——base 的六個 `context/` 套件只掛一個，而那一個我們有等價物，`time-context` 那型的三個讀數逐個量過都沒有來源或不需要每步（第 5 條）。**這張表七條因此全部有結局。** shell／sandbox／subprocess／terminal 是決策 3 明文延後的，不算意外。

**Proteus 不是另一個 harness，是量 harness 的儀器。** 它用 Docker 把 dsh、Pi、Aki 這些 harness 包起來，讓它們跨多個 episode 改寫自己的原始碼，然後量「harness 本身變了什麼」（結構距離、結晶測試、帶排列檢定的行為距離）。它對我們的意義不是抄設計——它是 Python、從外面包、是 research preview——而是它定義了一個 harness **可以被量**要具備什麼：無頭入口（有）、可讀的執行軌跡（**2026-09-05 起有了**，見 §4.5）、具名的可編輯 surface（memory／skills 目錄有，plugin 清單是程式碼）。**原文寫「這三件裡缺的那一件正好跟持久化是同一個缺口」，那句話 2026-09-05 起不成立**——落盤做完之後，缺的變成第三件（可編輯 surface），而它跟持久化無關。

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
| 意圖與理解 | 薄 | ⚠️ 仍薄 | 單一供應商單一模型（`live-model.ts` 的 `nvidia/nemotron-3-super-120b-a12b`，量出來的；前一個 `openai/gpt-oss-120b` 2026-09-03 下架，見 #165）；模型層完全外包 LangChain；#141 把基座按模型改組裝這件事守住了，但沒有 dsh 那種提供方無關的 `ctx.llm` seam |
| 規劃與編排 | 完整 | ✅ | deepagents 迴圈 ＋ `@nexus/plugin-plan-mode`（#117）＋ `@nexus/plugin-todo`（#139）＋ `@nexus/plugin-goal`（#128／#129）。#16 原列的自我批判／意圖分類兩方向已被 dsh 否掉（計劃 §2 記了理由） |
| 記憶 | 三個都在但只注入不保存 | ⚠️ 同 | `@nexus/plugin-memory`（#68）、`@nexus/plugin-skills`（#69）都刻意薄，靠基座 middleware；摘要層 #70 釘住了縫，**但生產路徑沒用那條縫**——這是 #142 |
| 執行與工具 | 完整 | ✅ 有界 | MCP（#59）、fs 圍堵（#62）、QuickJS（#64）、「先讀後改」策略（#154，`packages/nexus-core/src/observation.ts`，照 dsh 的 `fs-observation-policy`，同樣由 `foldRegistry` 打底進 root 與每個 subagent）；shell／sandbox 決策 3 延後，且基座三條件互斥（`sandbox-backend-conflict.test.ts`） |
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
| 3 | checkpointer／store／backend 三軸收斂 | ⚠️ | **這一列的題目本身被 [#155](https://github.com/DemianLi/nexus-agent/issues/155) 改寫了**：那三軸問的都是「LangGraph 的狀態存在哪」，而先落地的是不在其中任何一軸上的**會話日誌**（[#172](https://github.com/DemianLi/nexus-agent/issues/172)／[#174](https://github.com/DemianLi/nexus-agent/issues/174)，`--session-log <dir>`）。checkpointer 仍是 `MemorySaver`、仍沒有 storage，兩軸今天零消費者 |
| 4 | HITL 核准 | ✅ | 擴充點 Phase 2 就落地；#111／#112 改逐次判；web 端 `approval-card.tsx` |
| 4 | 可觀測性 | ✅ | #100 OTLP 後端 ＋ 遙測披露（`telemetry-disclosure.ts`）；tracing 那半是基座自己開的，我們補的是「說出來」與脫敏 |
| 4 | 工具失敗回饋 ＋ 輸出校驗 | ✅ | #73 |
| 5 | web 傳輸線 | ✅ | #76（形狀）、#77（pump）；`packages/nexus-wire` |
| 5 | 對話 UI | ✅ | `apps/web/src/App.tsx`、`App.test.tsx`（13KB）。驗收句由 [#124](https://github.com/DemianLi/nexus-agent/pull/124) 的實跑走過（`serve:live`、真模型、現行機制），見 §六第 1 條 |
| 5 | 核准 UI | ✅ | `apps/web/src/components/approval-card.tsx`。#124 那次核准卡片跳出來、送出框鎖住，按「全部核准」之後工具真的跑完 |
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
| 8 | `compaction` | 自動壓縮、按需 `/compact`、工具輸出修剪 | 基座無條件掛 `SummarizationMiddleware`。門檻與 subagent 射程已由 #142 收回（`createSummarizer` 同名取代 ＋ `foldSubAgents` 打底）；**工具結果修剪已由 #149 補上**，包在同名摘要器外面、壓力達標才剪、剪完可讓摘要那次模型呼叫整個不發生（射程 8,192–80,000 字元，上界是基座自己的 `toolTokenLimitBeforeEvict`）。**留痕已由 #143 補上**：一顆 `compaction/summary` 會話事件（切點、當時長度、歷史落點），root 與 subagent 各記在自己那份——dsh 的 `start`／`end` 兩顆湊不出來，因為基座只在成功走完之後才交出東西，硬記一顆 `start` 只能記在「我們猜它要壓了」的時間點。**溢出恢復已由 [#150](https://github.com/DemianLi/nexus-agent/issues/150)→[#166](https://github.com/DemianLi/nexus-agent/pull/166) 補上**：基座不做字串嗅探、認的是型別化的 `ContextOverflowError`，而我們的端點不在 `wrapOpenAIClientError` 比對的那四個字串裡，所以分類補在最靠近 adapter 的地方。仍缺：`/compact`、指定範圍、壓縮鎖。修剪原文落日誌那條**理由換過一次**——不是「日誌不落盤」（2026-09-05 已落盤），是事件詞彙對不上 | 部分 |
| 9 | `context` | 不定義工具、每次請求加模型可見上下文：`agent-instructions`（AGENTS.md）、`time-context`、`file-reference`、`file-reference-local`、`session-reference`、`tmux-context`（**六個**，原本這列漏了 `file-reference-local`） | `@nexus/plugin-memory` ≈ `agent-instructions`（靠基座 `createMemoryMiddleware`）。其餘五個沒有，而**那五個 base 一個都沒掛**——2026-09-07 判為不是缺口，降到 §五第 7 條 | 部分 |
| 10 | `core` | 會話日誌、系統提示詞組裝、工具註冊表、agent 詞彙與預設迴圈、scope | `session-log.ts`（會話日誌）、`registry.tools`＋`fold.ts`＋`base-tools.ts`（工具註冊與呈現順序）、迴圈外包 deepagents、系統提示詞由基座組而 `harness-profile.ts`（#141）守著它。沒有 `ctx` 服務樹——那是 Cordis 的 | 有 |
| 11 | `credentials` | 憑證引用 seam：設定裡只放引用不放值、按操作解析、環境與檔案提供方 | 沒有 seam。`docs/standards.md:19-25` 是規範（一律環境變數、不得有 fallback），不是機制 | 沒有 |
| 12 | `e2b` | 遠端 Linux 沙箱（fs＋subprocess） | 沒有 | 沒有 |
| 13 | `examples` | 示範 | `apps/harness/src/spike/`、`*.fixture.ts` | 不適用 |
| 14 | `experimental` | 不進正式發布的原型：agent-team、inspector、webworker 等 | 沒有 | 沒有 |
| 15 | `extensions` | 模型側工具定義、運行與移除**動態** Cordis 套件 | 沒有。計劃 §1 明文「射程限定為載入期回滾，不承諾執行期熱插拔」 | 沒有 |
| 16 | `feedback` | 使用者對會話與 assistant 訊息的反饋 | 沒有 | 沒有 |
| 17 | `fs` | `ctx.fs` 提供方約定、本地與沙箱後端、編輯前讀取策略、面向模型的檔案與搜尋工具 | `registry.backend`＋`ContainedFilesystemBackend`（#62）＋基座 filesystem 工具＋`registry.permissions`＋**編輯前讀取策略**（[#154](https://github.com/DemianLi/nexus-agent/issues/154)→[#161](https://github.com/DemianLi/nexus-agent/pull/161)，沒讀過的檔不准改）。`fs-sandbox` 那格沒有 | 有 |
| 18 | `goal` | 每會話一個持久目標：域、模型工具、使用者命令、自動續行 | `@nexus/plugin-goal`（#128、#129、#177）。四個子套件做了三個——`goal`、`command-goal`、`tool-goal`；**沒有 `goal-round-driver`**，那是 #152 決議登記的空缺，前置條件是 `turn/start` 的 `source` 判別欄 | 部分 |
| 19 | `guard` | 迴圈衛生：`repeat-tool-reminder`（同參數重複呼叫 3／5／8 次時建議性提醒）、`timeout-policy`（單次工具呼叫協作式逾時→清楚的模型錯誤）。**dsh base 兩個預設開著** | **兩個行為都有了，載體沒有。** 重複提醒 [#147](https://github.com/DemianLi/nexus-agent/issues/147)→[#157](https://github.com/DemianLi/nexus-agent/pull/157)（`repeat-reminder.ts`，投遞掛在 `beforeModel`）；超時措辭 [#162](https://github.com/DemianLi/nexus-agent/issues/162)→[#176](https://github.com/DemianLi/nexus-agent/pull/176)（`containment.ts`，主詞是「等了多久」，判別式 `error.name === 'TimeoutError'` 分得開使用者按的取消）。**`@nexus/plugin-guard` 這個載體是一筆偏離登記**：基座自己就武裝截止時間（`defaultConfig:{timeout}` → `AbortSignal.timeout`），一個只剩措辭的 plugin 沒東西可武裝，而照 [#159](https://github.com/DemianLi/nexus-agent/issues/159) 的結論，圍堵旁邊的行為藏在選配 plugin 裡等於沒有。仍缺 `TOOL_TIMEOUT` 分類碼（三個消費者一個都不在，刻意不發） | 部分 |
| 20 | `hooks` | 在 agent 運行期執行使用者**既有的** Claude Code／Codex `hooks.json` shell 鉤子：會話開始、提示詞提交、工具前後、停止時觸發；可帶模型可見訊息阻塞、附加上下文、強制繼續 | 沒有。近似物：`wrapToolCall`／`wrapModelCall`（工具、模型前後）、`registry.approvals`（阻塞工具）、`lifecycle.onDispose`（關機）。**2026-09-07 更正**（[#212](https://github.com/DemianLi/nexus-agent/issues/212)）：原文寫「缺會話開始、提示詞提交、停止三個時刻」——那三個是**格號**不是空缺，兩格佔住、一格判過不是缺口（見 §五第 3 條）。這一列判「沒有」**照舊成立**，但理由只剩一條：**沒有跑外部 shell 鉤子的引擎**，而要不要做那個引擎就是 §五第 3 條的 (b) | 沒有 |
| 21 | `host` | Web GUI Host 側：HTTP 與 SPA 伺服器、工作區目錄選擇、插件清單投影 | `wire-server.ts`（不綁 port 的 handler ＋ 一個 socket）；沒有目錄選擇、插件清單投影 | 部分 |
| 22 | `identity` | 匿名的 per-harness-home 關聯 id | 沒有 | 沒有 |
| 23 | `interaction` | 人機協作：`commands`、`permission-presets`、`tool-ask-user`、`user-approval`、`user-questions` | `commands` ✅（`@nexus/plugin-commands`，形狀照 `dsh-commands`）；`user-approval` ≈ `registry.approvals`＋`approval.ts`＋`approval-card.tsx`（**2026-09-08 量過語意差**，[#220](https://github.com/DemianLi/nexus-agent/issues/220)：提問側對得上，**應答側不是掛點、結果詞彙窄一格、審計事件零顆**，逐條見 §六第 7 條，結局在 §五第 7 條）。`permission-presets`、`tool-ask-user`、`user-questions` 沒有 | 部分 |
| 24 | `jobs` | 背景任務：註冊表約定、行程本地儲存、模型側任務工具 | 沒有。執行模型是一次 `invoke` | 沒有 |
| 25 | `llm` | 提供方無關的模型呼叫服務、DeepSeek 與 pi-ai adapter、重試執行器、回放感知的 token 計量 | `live-model.ts`（`ChatOpenAI` 指 NVIDIA 端點；retry 在檔頭有偏離登記）；模型呼叫外包 LangChain。**每一輪的 token 用量已由 [#153](https://github.com/DemianLi/nexus-agent/issues/153)→[#158](https://github.com/DemianLi/nexus-agent/pull/158) 進會話日誌**；沒有 dsh 那種可注入、回放感知的 `token-meter`——pruner 至今拿不到一個可注入的計量器 | 部分 |
| 26 | `lsp` | LSP 程式碼導航 | 沒有 | 沒有 |
| 27 | `mcp` | 掛外部 MCP server，工具作原生工具呼叫 | `@nexus/plugin-mcp`（#59），一實例一 server，照 `mcp-client` | 有 |
| 28 | `plan` | 計劃模式 | `@nexus/plugin-plan-mode`（#117），帶一筆已登記的偏離（`stateSchema` 而非會話事件） | 有 |
| 29 | `preset` | 按會話從 preset 檔組裝 agent；persona | 沒有。組裝來源是程式碼不是檔案（#140 卡裡已對照） | 沒有 |
| 30 | `runtime-diagnostics` | 套件自有的運行時不變量檢查 | `registry.invariants`＋`invariant.ts`／`invariants.ts`＋`apps/harness/src/package-invariants.ts`（#101） | 有 |
| 31 | `sandbox` | 行程沙箱 seam：隔離、各平台後端（bwrap／Landlock／Seatbelt／Windows ACL）、策略解析 | 沒有。`@nexus/plugin-quickjs` 檔頭登記為結構性偏離；決策 3 延後 | 沒有 |
| 32 | `schedule` | 會話本地的持久提醒（`schedule_create`／`list`／`delete`） | 沒有 | 沒有 |
| 33 | `sdk` | JSON-RPC 協定 ＋ 行程外 SDK 的 client／server | 沒有 | 沒有 |
| 34 | `session-query` | 搜尋、追蹤、讀取實時與持久會話歷史；日誌匯出 | 沒有 | 沒有 |
| 35 | `session` | 持久會話資料平面：persistence seam（jsonl／sqlite）、checkpoint 策略、投影、標題、統計、對外遙測 | `session-log.ts`（append-only）、**`session-store.ts`＋`session-persistence.ts`＋`jsonl-session-store.ts`（persistence seam，#172／#174：CLI 與 `serve` 的 `--session-log <dir>`，選擇性、無預設路徑）**、`session-telemetry.ts`＋coordinator＋`@nexus/plugin-telemetry-otel`（#100）、`sessions.ts`／`session-registry.ts`（#138 subagent 各一份）。sqlite provider／checkpoint-policy／projection／title 沒有 | 部分 |
| 36 | `settings` | 使用者設定 seam ＋ YAML／JSON 檔提供方 | 沒有（#46） | 沒有 |
| 37 | `shell` | bash／pwsh 本地與沙箱執行器、持久與一次性工具 | 沒有。決策 3 延後 | 沒有 |
| 38 | `skill` | 由提供方發現、經會話目錄與 skill 工具載入的可複用指令 | `@nexus/plugin-skills`（#69）靠基座 `createSkillsMiddleware`。沒有 `tool-skill`、`skill-badge` | 有（薄） |
| 39 | `spill` | 過大的工具文字外溢到儲存、回傳可檢索定位 | **基座已經占住這個 seam，而且在產品路徑上**（[#151](https://github.com/DemianLi/nexus-agent/issues/151) 實測）：`createFilesystemMiddleware` 在 80,000 字元之上把工具結果寫進 `/large_tool_results/<callId>.txt`，換成頭尾預覽加一句 `read_file` 指路，取回路徑實測通。原文寫的「`truncateArgsSettings` 是截斷不是外溢」對照錯了對象——那是另一個機制。[#170](https://github.com/DemianLi/nexus-agent/issues/170)→[#171](https://github.com/DemianLi/nexus-agent/pull/171) 補掉基座在寫入失敗時把原文一起丟掉的缺陷。仍缺：門檻調不動也關不掉、非文字區塊被吃掉 | 部分 |
| 40 | `storage` | 非會話資料的持久化：具名後端、型別化領域資料 | 沒有。checkpointer 是 `MemorySaver`。**「決策 4 三軸未收斂」那句 2026-09-05 由 [#155](https://github.com/DemianLi/nexus-agent/issues/155) 推翻**：那三軸問的都是「LangGraph 的狀態存在哪」，而 storage 這一軸今天零消費者（memory／skills 是檔案、backend 管），判過不做 | 沒有 |
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

**小計（2026-09-05 更新）**：有 8（`core`、`fs`、`mcp`、`plan`、`runtime-diagnostics`、`skill`、`todo`、`test-support`）；部分 14（`api`、`boot`、`client`、`code-runtime`、`compaction`、`context`、`goal`、**`guard`**、`host`、`interaction`、`llm`、`session`、**`spill`**、`subagent`）；沒有 27；不適用 2。**`guard` 與 `spill` 是這次從「沒有」改過來的**——前者兩個行為都落地了只是載體不同，後者基座本來就占著而我們一直對照錯了機制。

**27 個「沒有」怎麼分**：企業級與分散式 16 個（`acp`、`sdk`、`typert`、`identity`、`settings`、`credentials`、`webhook`、`attachment`、`lsp`、`web`、`e2b`、`feedback`、`experimental`、`extensions`、`bundle`、`preset`）——定位差異，**原文寫「14 個」但列了 16 個名字，而且把 `api`／`host`／`client` 三個「部分」的算了進去，一併改正**；決策 3 明文延後 4 個（`shell`、`sandbox`、`subprocess`、`terminal`）；需求未出現 5 個（`jobs`、`schedule`、`workflow`、`session-query`、`workspace`）；**agent 迴圈自己會用到、dsh base 預設開著、我們沒有的 2 個：`hooks`、`storage`**。（原本是 3 個，`guard` 已於 2026-09-05 落地；`session` 那列的 persistence 那半也落地了。）**這兩個就是 §五 收完之後留下來的東西**：`hooks` 是下一張圖，`storage` 判過零消費者不做。

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
| 可讀的執行軌跡（`read_trace` 從 harness 自己的日誌解析） | ⚠️ 落盤有了（[#172](https://github.com/DemianLi/nexus-agent/issues/172)、[#174](https://github.com/DemianLi/nexus-agent/issues/174)：`session-log.ts` 十種事件，CLI 與 `serve` 的 `--session-log <dir>` 寫成 jsonl）。**剩下的落差在 adapter 那側，不在我們這側**——見下 |
| 具名的可編輯 surface | ⚠️ memory／skills 目錄是；plugin 清單是程式碼；`goal`／`todo` 在會話日誌裡 |

**2026-09-05 更新：這兩個 ⚠️ 曾經指向同一件事（持久化），現在不是了。**

第二列的落差原本是「不落盤」，[#172](https://github.com/DemianLi/nexus-agent/issues/172) 之後不成立。**去讀了 adapter 才知道剩下的落差是什麼**（`references/Proteus/proteus/adapters/dsh.py`，SHA `962304b3`）：

- **它跑的是一次無頭 CLI 呼叫**——`sandbox.run(run_root, ["--profile", "headless", <prompt>], env={"DEEPSEEK_API_KEY", "DSH_PERMISSION_MODE"}, mounts=… (state, "/state") …)`（`:408`）。所以要被它量的入口是 **CLI**，不是我們自己的基準跑者（eval 那條連會話註冊表都沒有，那是一個登記過的決定，見 `eval/runner.ts` 檔頭與 `eval/session-absence.test.ts`）。
- **日誌刻意落在 harness 樹外面**：檔頭第 20 行 `.dsh-state/ DSH_HOME (sessions land here; not part of the harness)`，理由是那棵樹會被快照、被當成自我演化量進去。**我們的 `resolveSessionLogDir` 拒絕 `--workspace` 之內或之下的目錄**——同一條約束，兩邊各自到達（我們那條的出處是 [#170](https://github.com/DemianLi/nexus-agent/issues/170) 的「歷史是基礎建設，不是 agent 的工作區」）。
- **它靠「不給旗標，日誌也會出現在一個已知目錄」**：adapter 傳的 env 只有那兩個，`DSH_HOME` 在 image 裡設好，然後 `root.rglob("session.jsonl.zstd")` 差集出這一 phase 新增的 session 目錄（`:302-304`、`:395`、`:421`）。**我們是每次呼叫的旗標、沒有預設路徑**，那是 [#172](https://github.com/DemianLi/nexus-agent/issues/172) 明文的設計選擇，[#174](https://github.com/DemianLi/nexus-agent/issues/174) 決定維持。
- **它 mid-run 就在讀**（`:397-402` 的 `stop_check` 輪詢決定要不要停容器），所以「行程結束才 flush」不夠。我們的寫入是固定窗口到期就寫（`session-persistence.ts` 的 `#schedule()`），這條對得上。
- `docs/ADAPTERS.md:112-115`：`read_trace` 是**唯一**的行為通道，而且明文「解析 harness 自己的日誌，不要為了測量往 harness 裡加儀器」。

**所以這一列是 ⚠️ 而不是 ✅，代價落在寫 adapter 的人身上，不是落在這棵樹上**：他要明著傳 `--session-log`，而且 run 目錄的命名（`<ISO 時間戳>-<uuid8>/<檔名基底>.jsonl`，基底是 session id 的百分號編碼）要餵得進他的 glob。**這不是缺口，是一份給未來那張卡的規格。**

第三列（具名的可編輯 surface）沒有變，而它現在是三個前提裡唯一還缺東西的那個——這也是 §五第 4 條的排序理由不再成立的原因，見該節。

（子代理第一版寫「dsh 的 measurement 只有任務通過率」。那是 Proteus README 對「其他系統」的泛稱，不是對 dsh 的核對，已刪。）

## 五、缺口排序

排序準則：**agent 迴圈自己會碰到**（不是部署面、不是分散式）× **dsh base 預設就開著**（表示它認為每個 harness 都該有）× **我們的基座表達得出來**（表達不出來的要標偏離）× **大小**。企業級那 14 個不排；決策 3 延後的 4 個登記不排。

**這張表的消耗狀況（2026-09-07 更新）**：第 1、2 條收完，第 4 條做掉會話日誌那一軸、另兩軸判為零消費者不做——十七張卡掛在 [#146](https://github.com/DemianLi/nexus-agent/issues/146) 底下走完，逐張的產出與**偏離登記的索引**在那張圖的結案留言。~~**還開著的是第 3 條**（生命週期鉤子面，開圖條件部分滿足）**與等它的第 5 條**~~——**2026-09-07 起不是了**（[#212](https://github.com/DemianLi/nexus-agent/issues/212)）：第 3 條收完（那個「面」就是 #190 的九格，五格逐格有結局），第 5 條的縫因此定了、不再等，~~剩下的是它開卡時要選的射程~~（**那句已作廢**，見第 5 條）。~~**這張表今天還開著的只有第 6 條**，而它其中一問也順帶答了（§六第 4 條）。~~ **2026-09-07 第 6 條也收完了**（另一半的 `ForkedSubAgent` 查完，判為認帳不做，§六第 4 條整條結案）——**這張表從此沒有待驗的項目**，唯一還沒動的第 5 條 2026-09-07 開成 [#215](https://github.com/DemianLi/nexus-agent/issues/215) 並當天答完，**判為不是缺口、降到第 7 條**——**這張表七條從此全部有結局**，第 7 條是登記不排的。

### 1. Compaction 的門檻與去向由我們選 —— 收完

**缺什麼**：生產路徑跑的是基座無條件掛的 `SummarizationMiddleware`，門檻是基座依模型 profile 二選一挑的，對我們的模型退到一個與模型無關的固定常數，而且沒人在檢查。摘要發生時完全靜默。

**為什麼需要**：dsh 把它做成能力 seam（`compaction/` 四個子套件），門檻是設定且按模型可覆寫、載入時驗、有 `start`／`summary`／`end` 三個事件加一把鎖。

**表達得出來嗎**：可以——root 同名取代、subagent spec 上的 `middleware`、`getState()` 讀 `_summarizationEvent`，三條都實測過（#144 釘住）。表達不出來的部分（手動 `/compact`、指定範圍、鎖、溢出後恢復）已在 #142 登記為偏離。

**狀態（2026-09-05，六張卡走完，這一條收完了）**：

- **門檻與去向**由 [#156](https://github.com/DemianLi/nexus-agent/pull/156) 落地（[#142](https://github.com/DemianLi/nexus-agent/issues/142)）：trigger `[{tokens}, {messages}]` 並聯、keep `{messages}`、`fraction` 禁用，掛在 `foldSubAgents` 打底，所以 root 與每個 subagent 同一份。
- **留痕**由 [#164](https://github.com/DemianLi/nexus-agent/pull/164) 落地（[#143](https://github.com/DemianLi/nexus-agent/issues/143)）：摘要發生過這件事進會話日誌。
- **壓縮前先剪過大的工具結果**由 [#163](https://github.com/DemianLi/nexus-agent/pull/163) 落地（[#149](https://github.com/DemianLi/nexus-agent/issues/149)）。**它與 spill 不是二選一，是兩個時刻**——[#151](https://github.com/DemianLi/nexus-agent/issues/151) 實測：>80,000 字元歸基座的 eviction（`createFilesystemMiddleware` 寫進 `/large_tool_results`，取回路徑實測通），8,192–80,000 歸剪刀。**基座已經占住 spill 那個 seam 而且在產品路徑上，所以不開實作卡。**
- **溢出後恢復**由 [#166](https://github.com/DemianLi/nexus-agent/pull/166) 落地（[#150](https://github.com/DemianLi/nexus-agent/issues/150)）：基座不做字串嗅探，認的是型別化的 `ContextOverflowError`；而**我們的端點不在 `wrapOpenAIClientError` 比對的那四個字串裡**（NVIDIA 回「Input length N exceeds maximum allowed token size M」），所以分類補在最靠近 adapter 的地方。
- **spill 掉出來的缺陷**由 [#171](https://github.com/DemianLi/nexus-agent/pull/171) 落地（[#170](https://github.com/DemianLi/nexus-agent/issues/170)）：`read-only` 組裝下基座的 eviction 寫入必失敗、而它把原文一起丟了；修在 backend 層（`withToolResultStash` 把 `/large_tool_results` 路到一個獨立的 `StateBackend`），不在 middleware。**代價實量過**：那份暫存進 graph state，**會進 checkpoint**，持久化一落地就變成磁碟成本。
- 仍是偏離登記的：手動 `/compact`、指定範圍、鎖（#142 登記）；以及 pruner 的原文不進日誌——**那條登記的理由 2026-09-05 整條換過**，不是「日誌不落盤」（已落盤），是**事件詞彙對不上**（日誌刻意不記訊息內容，也還沒有可注入的 token meter），結論沒變（`tool-result-pruner.ts:63`）。

### 2. 迴圈衛生的兩個 guard —— 收完，兩個都不是原本設想的形狀

**缺什麼**：`repeat-tool-reminder`（模型以同參數重複呼叫同一工具——反覆跑失敗的命令、反覆讀沒變的檔——在第 3／5／8 次送一條**建議性**提醒，要求它分析上一次結果、換方法或收工；每個 agent 分開計、新的使用者訊息清零）；`timeout-policy`（為宣告了限時的工具呼叫設協作式截止，經 `exec.signal` 請求停止，把已完成的取消映成 `Error: tool call timed out after <ms>ms`；絕不硬殺）。**兩個都隨 dsh base 預設啟用**（各自 `README.zh.md` 概述段）。

**我們有什麼**：`recursionLimit` 是硬上限，不分辨「在進展」與「在打轉」（`looping-model.ts` 量過換算是 `2 × 模型輪數 + 2`）；`LIVE_TIMEOUT_MS` 是供應商 HTTP 層的逾時，不是每次工具呼叫的。**沒有任何東西看「同一工具同參數重複」。**

**表達得出來嗎**：重複提醒——一個 `wrapToolCall` middleware：比對 `(name, args)`、每 agent 計數、命中時在 `ToolMessage` 後附一則提醒或改寫 `systemMessage`。deepagents 自己的 `createPatchToolCallsMiddleware` 就是這種形狀。~~逾時——需要 `AbortSignal` 能傳進工具執行；……**沒查**（§六）。~~ **2026-09-04 [#148](https://github.com/DemianLi/nexus-agent/issues/148) 實測完畢：通。**（§六第 3 題已結案，見該節。）

**大小**：一張卡（兩個 middleware 各一個 plugin，或一個 `@nexus/plugin-guard`）。**不動 #142 要動的三個檔。**

**狀態（2026-09-05，兩個都做完了，而且都不是原本設想的形狀）**：

- **重複提醒**由 [#157](https://github.com/DemianLi/nexus-agent/issues/157) 落地（`packages/nexus-core/src/repeat-reminder.ts`），投遞掛在 `beforeModel` 不是 post-execute。
- **逾時那張的分量被 [#159](https://github.com/DemianLi/nexus-agent/issues/159) 吃掉了大半**：「超時殺掉整場 run」是圍堵的缺口，不是逾時的，而圍堵已經搬進 `fold` 打底。剩下的由 [#162](https://github.com/DemianLi/nexus-agent/issues/162) 收：**認出超時、說出等了多久**，做在 `containment.ts` 裡。
- **`@nexus/plugin-guard` 這個載體最後沒有出現，而那是一筆偏離登記**：dsh 的 `guard/timeout-policy` 同時武裝截止時間、分類、措辭；我們的基座**自己就武裝**（工具上的 `defaultConfig: { timeout }` 經 `ensureConfig` 變成 `AbortSignal.timeout`，實測），樹上唯一有預算的 MCP 工具走的正是這條。一個只剩措辭的 plugin 沒有東西可武裝，而且照 #159 的結論，圍堵旁邊的行為藏在選配 plugin 裡等於沒有。**載體丟掉、紀律照抄**，理由與量到的東西寫在 `containment.ts` 檔頭。
- **`TOOL_TIMEOUT` 分類碼刻意不發**：dsh 給 retry／sandbox／replay 路由用，我們三個消費者一個都不在。

### 3. 生命週期鉤子面 —— 收完（2026-09-07）：它不是第十個東西，是九格裡的五格

**這一條原本寫著我們「沒有會話開始、提示詞提交攔截、停止攔截」。那是三個格號，而三格都已經有答案**（[#212](https://github.com/DemianLi/nexus-agent/issues/212)）。**過期的是理由，不是結論，所以沒有任何測試會紅**——這一條的散文從來沒有絆索守著，防過期靠的是它不再是第一手來源，見本條末。

**缺什麼（原文，保留）**：dsh `hooks/` 給五個時刻：會話開始、提示詞提交、工具前、工具後、停止；鉤子可以帶模型可見訊息**阻塞**提示詞或工具呼叫、**附加**上下文、或**強制運行繼續**（`hooks/README.zh.md`）。

**那五個時刻逐個訂在 [#190](https://github.com/DemianLi/nexus-agent/issues/190) 的九格上。** dsh 自己的橋接就是證據（`packages/hooks/hooks-claude-code/src/index.ts`，對讀 SHA `d347e703908d0406b7a7ef80e3a0e594d86b2215`，已 `fetch` 對過與 upstream master 同顆）：

| Claude Code 鉤子 | 訂的攔截點 | 位置 | #190 格號 |
| --- | --- | --- | --- |
| `SessionStart` | `agent/session-start` | `:206` | 第 1 格 |
| `UserPromptSubmit` | `agent/pre-step` | `:219` | 第 2 格 |
| `PreToolUse` | `tools/pre-execute` | `:238` | 第 4 格 |
| `PostToolUse` | `tools/post-execute` | `:247` | 第 7 格 |
| `Stop` | `agent/turn-stopping` | `:270` | 第 3 格 |

`hooks-codex` 訂**同樣五個**（`:188`／`:199`／`:225`／`:234`／`:260`）。dsh 明寫「『原生钩子』不是一个包——原生钩子只是一个普通的 Cordis 插件，订阅规范的生命周期事件」，`packages/hooks/` 三個套件是**橋接**，把使用者現成的 CC／Codex shell `hooks.json` 翻譯到那個介面。**所以「生命週期鉤子面」不是一個要另建的面，它就是那九格。**

五格逐格的結局（`apps/harness/src/interception-index.test.ts` 是那份索引，#190 的結案留言是逐格的核對過程）：

| 格 | 時刻 | 現況 |
| --- | --- | --- |
| 1 | `agent/session-start` | [#201](https://github.com/DemianLi/nexus-agent/issues/201) 判過**不是缺口**：dsh 那格是 `mode: 'emit'`、明著寫「a deliberate gap」；權限最弱＋消費者零＋時刻以 `SessionRegistry` 的建構存在（`session-registry.ts:169` 的 `new SessionLog(...)`；#190 記的 `:170` 已漂一行），三條缺一不可 |
| 2 | `agent/pre-step` | **佔住**：`beforeAgent`，唯一實作是 plan-mode（`packages/nexus-plugin-plan-mode/src/index.ts:390`）。`jumpTo: 'end'` 這條 reject 路徑實測做得到（[#192](https://github.com/DemianLi/nexus-agent/issues/192)）但我們零使用。權限差與**紀錄差**都登記在索引裡 |
| 3 | `agent/turn-stopping` | **佔住，只佔一半**：`apps/harness/src/goal-driver.ts` 做的正是 dsh 那句「通过 continuation 实现的 `stop`」——目標沒達成時自己再開一輪（[#181](https://github.com/DemianLi/nexus-agent/issues/181)）。`agent.steer()` 沒有等價物，輪迴圈歸入口點所有，載體偏離已登記在該檔檔頭 |
| 4 | `tools/pre-execute` | **佔住**，逐字對得上：`approvals.gate()`，`allow`／`deny`／`ask` 三欄與鏈底 allow 都對得上 |
| 7 | `tools/post-execute` | **佔住**：`wrapToolCall` 的 `await handler(request)` 之後那一段。`additionalContexts` 的射程只到單一生產者，**第二個生產者出現就變偏離** |

**「會話級 vs 每次 agent 呼叫不是同一個縫」這句話是對的，不要跟過期的結論一起丟掉。** dsh 確實有 `agent/session-start` **和** `agent/pre-step` 兩個不同的事件名，橋接把 `SessionStart` 訂到前者、`UserPromptSubmit` 訂到後者——它示範的是這兩個時刻**各有專屬的縫**。原文把這個區分當成「未答的第一題」，而它已經被答了：正因為第 1 格是專屬的會話級縫，我們這側對得上的不是 `beforeAgent`，是 `SessionRegistry` 的建構，而 #201 判過那不是缺口。

**`afterAgent` 我們在用**：`packages/nexus-plugin-plan-mode/src/index.ts:394`，全樹**唯一**一處實作（`beforeAgent` 同樣唯一，`:390`）。所以缺的從來不是鉤子。

**為什麼需要（原文那兩個例子要分開，其中一個舉錯了縫）**：

- 「agent 說做完了之前先跑一次檢查」——**第 3 格，goal-driver 就在做**，差別在它走的是入口點自己的輪迴圈，不是一條可訂閱的通道。
- 「每個會話開頭注入一段上下文」——原文接著寫「dsh 的 `context/` 那整組就是掛在這個面上」，而那句話指錯了格。逐個量過：`context/` **六個套件裡四個訂 `agent/pre-step`**（`agent-instructions:313`、`session-reference:113`、`time-context:180`、`tmux-context:236`），`file-reference-local` 訂的是 `agent/created:90`／`agent/disposed:91`／`session/event:96`，`file-reference` 是純語法 seam 不訂事件。**零個訂 `agent/session-start`。** 所以第 5 條要掛的縫是**第 2 格**，我們今天就有，還有一個現成的佔用者示範。

**兩個要分開問的問題**：

- **(a) 要不要這個面（我們自己的 plugin 用）——答完了，面不必另建。** 九格就是那個面，五格逐格有結局；#190 走完之後這一格剩下的是索引裡登記的那幾筆權限差與紀錄差，不是一個缺席的面。原本「開圖條件部分滿足」那句連同它的理由一起作廢。
- **(b) 要不要執行外部 `hooks.json`（dsh 兩個 bridge 做的事）——前置沒了，現在可以問。** 開卡之前先把價錢寫在這裡，三條都是量到的，不是推測：
  1. **dsh 在這一格自己有沒解的瑕疵。** `hooks-claude-code/src/index.ts:205` 帶著 `TODO(session-start-gating): add a startup gate before promising first-turn delivery`——注入是 detached、best-effort，**可能錯過第一個請求**，快照測試因此 10 次重放 10 次失敗、被移出快照矩陣（#201 量過）。
  2. **那個瑕疵不只在 session-start。** `SubagentStart`（`:284`）走的是**同一個** `detached.track`，所以照抄會把它一起抄過來。
  3. **兩個橋接的覆蓋不對稱。** `hooks-codex` 只訂五個，**沒有 subagent 那兩格**。

**subagent 的兩個時刻，這張表跟 #190 都漏了**：`subagent/start`（`hooks-claude-code:281`）／`subagent/end`（`:291`）。**兩張圖都漏是因為來源本身沒列**——#190 的九格出自 dsh 的設計筆記 `2026-06-30-interception-extension-points.zh.md`，那份筆記 grep `subagent` **零命中**。逐個的處置見下：

- **`subagent/end` 判為不是缺口**，理由是**消費者一個都不存在**，與第 9 格（`tools/result`）同型：dsh 那格是 `mode: 'emit'`、只觀測；我們的 `SessionEventType` 十種（`session-log.ts:71-81`）**一顆 subagent 事件也沒有**，而更近的那個缺席（工具事件）已經婉拒過一個指名道姓的消費者（#180 第五節，理由在 `goal-driver.ts` 檔頭）。
- **`subagent/start` 認帳，持有人是第 5 條那張卡。** dsh 那格與第 1 格**逐字同型**：`api-catalog.ts:3333` 是 `mode: 'emit'`，描述與第 1 格（`:3037`）一樣寫「Use `agent.inject()` to seed model-facing context. This is a notification, not a veto」——橋接能 `child.inject(context)` 是因為窗口裡從 `ctx.agents` 拿得到活著的子 agent，那是**服務**給的，不是事件給的權限。但 #201 那三條在這一格**只成立兩條半**：權限最弱 ✓、我們這側零佔用者（`grep -rn "subagent/" packages apps --include='*.ts'` 零命中）✓、而「時刻以建構存在」~~**只覆蓋靜態注入**——`foldSubAgents` 組裝期逐個 subagent 注的是 middleware／tools／permissions，`time-context` 那型要的每次新鮮的值組裝期表達不出來~~。**2026-09-07 這條理由被推翻了**（[#215](https://github.com/DemianLi/nexus-agent/issues/215) 開卡時量到）：`repeat-reminder` 就是組裝期注進每個 subagent、執行期每步現算一條新鮮 `HumanMessage` 的東西（`repeat-reminder.ts:396-415`）——**靜態的載體不等於靜態的內容**。dsh 的 `inject()` 剩下的差別是**帶外**（子代理已經存在之後，由第三方而不是父代理寫進它的歷史）。**2026-09-07 [#215](https://github.com/DemianLi/nexus-agent/issues/215) 答完了那個殘值：它成立，而持有人不是第 5 條那張卡，是下面的 (b)。** 理由是消費者只有一個，而那一個就住在 (b) 裡：`ctx.on('subagent/start', ...)` 在 dsh 全樹扣掉 `tests/` 只有兩處——`hooks-claude-code/src/index.ts:281`（真的消費者）與 `subagent/subagent/src/invariant.ts:74`（不變式伴生插件，只校驗不注入）。前者做的事是跑外部 `SubagentStart` 鉤子點，再把**鉤子行程回傳的** `contextFrom(merged)` `child.inject(context)` 進子代理——**種什麼由外部 `hooks.json` 決定，父代理不知道也編碼不進任務字串**，這正是帶外。**所以認帳移交給 (b)，不是收掉**；(b) 的價錢第 2 條已經指著同一行（`:284` 的 `detached.track`），而 `hooks-codex` 不訂 subagent 兩格這件事表示這個殘值是 **CC 方言專屬**的。
- 順帶量到、不在這張卡射程內：`agent/created`／`agent/disposed`（`file-reference-local` 訂的）**也不在九格裡**，一併記給 #190 的索引，這裡不判。

**改完之後靠什麼讓它下次過期時被發現**：**不加新絆索，改讓這段散文不再是第一手來源。** 兩條硬約束擋著加絆索——`interception-index.test.ts` 的軸是「誰佔住」（subagent 兩格零佔用者，沒有列可寫），而一個掃空的結構 gate 會永遠綠。所以上面每一條結論都明著 cite 到帶絆索或帶論證的地方：五格逐格 → `interception-index.test.ts` 與 #190、第 1 格 → #201、第 2 格的 reject 路徑 → #192、佔用者的行號 → 那幾個檔案自己的 JSDoc（索引那條斷言要求佔用者身上出現時刻名）。**這段散文只轉述，不承重**；它下次過期時，紅的會是那些地方。

### 4. 持久化 —— 會話日誌那一軸收完，另兩軸判過不做

**2026-09-05：會話日誌那一軸已經做完**（[#172](https://github.com/DemianLi/nexus-agent/issues/172)、[#174](https://github.com/DemianLi/nexus-agent/issues/174)），下面留的是原文與逐條的現況。

**缺什麼**：~~會話日誌在行程內~~（已落盤：CLI 與 `serve` 的 `--session-log <dir>`，JSONL，`jsonl-session-store.ts`）、checkpointer 仍是 `MemorySaver`、仍沒有 storage。行程一結束，todo、goal 與摘要事件仍然消失——**它們住在 graph state 裡，不在會話日誌裡**，所以那兩軸的缺席還是真的。

**為什麼需要**：三個獨立的理由指向它，**而 2026-09-05 三個都已經消耗掉了**。(a) dsh `session/` 那組的 persistence seam（jsonl／sqlite）是它整個資料平面的地基——照著做了；(b) #143 要留痕、#138 給了 subagent 各自的日誌——subagent 各自一個檔，懶建的沒寫過就沒有檔；(c) §4.5 的前提之二——已滿足，剩下的在 adapter 那側。**剩下兩軸（checkpointer／storage）今天零消費者**，[#155](https://github.com/DemianLi/nexus-agent/issues/155) 判過，理由記在 [#146](https://github.com/DemianLi/nexus-agent/issues/146) 的 Decisions 與 `.docs/development-plan.md` 決策 4 的補記。

**表達得出來嗎**：checkpointer 那軸 LangGraph 有現成的（`SqliteSaver`／`PostgresSaver`，但它拉原生的 `better-sqlite3`，而 `onlyBuiltDependencies` 只放了 `esbuild`）；會話日誌那軸是我們自己的東西，落盤格式照了 dsh 的 jsonl。**「決策 4 說三軸要一起收斂」那句話本身是錯的**——[#155](https://github.com/DemianLi/nexus-agent/issues/155) 查出來那三軸（checkpointer／store／backend）問的都是「LangGraph 的狀態存在哪」，會話日誌不在其中任何一軸上；真正的三軸是**會話日誌／checkpointer／storage**，而三者的「何時寫／寫什麼／誰讀回」沒有一格重疊，所以不必也收不到一起去（`.docs/development-plan.md` 決策 4 的補記）。

### 5. Context 注入插件 —— 答完了（2026-09-07，[#215](https://github.com/DemianLi/nexus-agent/issues/215)）：判為不是缺口，降到第 7 條

`time-context`（現在時間、時區、經過時長）是 dsh `context/` 裡最小的一個；`agent-instructions` 我們有（`@nexus/plugin-memory`）。dsh 讓注入的上下文以 user 角色訊息進會話歷史，所以可回放、可壓縮。

**縫定了（2026-09-07，[#212](https://github.com/DemianLi/nexus-agent/issues/212)）**：原文寫「它自然掛在第 3 條那個面上——面定了再做」，而第 3 條收完之後那個等待對象不存在了。**縫是第 2 格（`agent/pre-step`）**，而且不是推論——dsh 自己的 `context/` 六個套件裡四個訂的就是 `agent/pre-step`，零個訂 `agent/session-start`（逐個量在第 3 條）。

~~**開卡的第一個決定是射程，因為那條線正好切在一個已知缺口上。** 一個掛 `beforeAgent` 的 plugin middleware 射程只到 root，所以要嘛選 root only（`subagent/start` 維持認帳不做），要嘛選涵蓋 subagent（那半沒有現成的縫，是一張獨立的卡）。~~

**2026-09-07 開卡時逐條量過，上面那段有兩處站不住，處置在 [#215](https://github.com/DemianLi/nexus-agent/issues/215)**：

1. **「≒ `beforeAgent`」對錯了頻率。** dsh 的 `agent/pre-step` 是**每步**跑一次的（handler 拿得到 `step`，README 分「第 1 步／後續步驟」）；`beforeAgent` 是**每次 agent 呼叫一次**，plan-mode 自己登記的措辭也是「`agent/pre-step` **邊界提交**的對應物」。要每步新鮮的讀數，對得上的是 `beforeModel`（`repeat-reminder.ts:38-56` 已逐字論證過那個縫），**而每一個 `beforeModel` middleware 在圖裡各自是一個節點**——每輪多一格。**事件名定了，鉤子沒定。**
2. **「射程二選一」的前提是錯的，射程其實是載體的後果。** 原文說組裝期只注得了靜態的東西、「每次新鮮的值表達不出來」——**樹上就有反例**：`repeat-reminder` 是組裝期由 `foldSubAgents` 逐個 subagent 注進去的，執行期每步從 `state.messages` 現算出一條新鮮的 `HumanMessage`（`repeat-reminder.ts:396-415`），`model-usage` 同型。**靜態的載體，新鮮的內容。** 所以：選 `@nexus/plugin-*` 就只到 root（`fold.ts:714`），選 `@nexus/core` 打底就涵蓋每個 subagent，**沒有「另一張獨立的卡」那個選項**。

**而排在這兩題前面的那一題把它們一起收掉了：這一項不是缺口。** #215 逐條量完的判定，三條理由。

1. **排序準則第二條不成立。** §五的準則第二條是「dsh base 預設就開著」，而 `packages/bundle/base/package.json` 的 83 個相依裡，**六個 `context/` 套件只有 `agent-instructions` 在內**（`grep -nE 'dsh-(time-context|agent-instructions|file-reference|session-reference|tmux-context)'` 只回 `:120`），**而那一個我們有等價物**——`@nexus/plugin-memory` 的檔頭寫著「基座的 `createMemoryMiddleware` 已經做完了載入與注入」，預設來源 `/AGENTS.md`。
2. **dsh 自己把它歸給一個我們判過不排的東西。** `time-context/README.zh.md` 概述段：「本插件需主动启用：默认组合不启用它，**Schedule Web overlay 会挂载它**」。而 `schedule` 就在第 7 條那一列。**它不是「每個 harness 都該有」，它是 Schedule 的配件。**
3. **三個讀數逐個量，沒有一個撐得起那格節點。** 這一條要分開算，不能讓其中一個的理由蓋掉另外兩個——`time-context` 每次注的是**現在時間**、**瀏覽器時區**、**經過時長**三行。
   - **瀏覽器時區：今天沒有來源，而且不是加個 middleware 就有的。** dsh 從開放輪次的 `user-rpc` 訊息派生（`src/request-zone.ts`）；我們全樹 `timeZone`／`timezone`／`Intl.`（含 `.tsx`、扣 `node_modules` 與測試）**零命中**。`apps/web` 在，所以來源不是不可能——瀏覽器自己知道 `Intl.DateTimeFormat().resolvedOptions().timeZone`——但 `@nexus/wire` 的 `protocol.ts` 上沒有那個欄位，**要有得先擴 wire，這抬高價錢不是降低**。
   - **現在幾點：零個模型可見的讀數。** `new Date(`／`Date.now()`／`toISOString`／`toLocale*` 全樹 11 處，逐處看過**沒有一處把牆上時鐘 render 進模型看得到的東西**：三處是日誌／遙測時間戳，`plugin-goal` 那個進耐久快照（`prompt.ts` 不 render 它），`jsonl-session-store.ts:205` 是檔名，`quickjs` 是 deadline，`eval/compare.ts` 是計時。
   - **經過時長：已經有一個模型可見的，但它是別的形狀。** `containment.ts:222` 的 `formatToolTimeout(...)` 交出來的是一則 `status: 'error'` 的 `ToolMessage`（`工具 t 超時：等了 121ms。`）——真的模型可見的經過時長讀數，但它**每次工具逾時一則**，不是每步一則。這個維度我們不是零，是有一個窄的、事件驅動的版本。

**價錢是量過的**：每輪多一格 `beforeModel` 節點（0→4／1→5／2→6），加上每步一條累積到壓縮的 user message。**一個要先擴 wire 才有來源、一個零生產者零消費者、一個已經有更窄但有針對性的版本——付不起這格節點。**

**第 2、3 題因此不必決，但量到的兩件不隨卡片一起丟**：頻率差（`agent/pre-step` 每步 vs `beforeAgent` 每次呼叫）**是 `interception-index.test.ts` 第 2 列該有的一欄**，跟這一項做不做無關，另開小卡補；而 `repeat-reminder.ts:38-56` 的「我們是那張圖裡唯一的 `beforeModel` 節點」在這個結局下**仍然成立，不必改**——明著寫出來，免得下一個人以為它漏改了。

**重開的條件寫在第 7 條那一列。**

### 6. subagent 的其他後端 —— 查完了（2026-09-07），判為認帳不做，而那條窄現在有絆索釘著

dsh 有 in-process／fork／spawn／acp／claude-code／codex 六種委派後端；我們只有 deepagents 的 in-process `SubAgent`。deepagents 的 `.d.ts` 裡有 `ForkedSubAgent`、`AsyncSubAgent`，我們的 `foldSubAgents` 有沒有處理它們，原本整條都**沒查**（§六）。**兩半都查完了，答案一樣是「進不來」，但兩半的理由不同**——這個差別重要，因為它決定了絆索該釘在哪。

**基座這一側有三種 in-process 形狀，`createDeepAgent` 的 `subagents` 三種都收**（`subagents?: (SubAgent | CompiledSubAgent | ForkedSubAgent)[]`）：

| 形狀 | 判別 | 我們這側 |
| --- | --- | --- |
| `SubAgent` | `mode?: 'handoff'` | **唯一收的那種**（`registry.subagents.register(subagent: SubAgent)`） |
| `ForkedSubAgent` | **`mode: 'fork'` 必填** | 型別上進不來：`SubAgent.mode` 被窄成 `'handoff'` 這個**字面量**，寫 `'fork'` 是型別錯誤。**但 cast 得進來**，見下 |
| `CompiledSubAgent` | 帶 `runnable`，`mode?: 'handoff' \| 'fork'` | 進不來：形狀對不上 `SubAgent` |
| `AsyncSubAgent` | **`graphId` 必填** | 進不來：缺欄位（`apps/harness/src/base-tools.ts:52-62` 檔頭） |

**`AsyncSubAgent` 是「缺必填欄位」，`ForkedSubAgent` 是「欄位被窄成別的字面量」。** 前者不可能誤入——沒有人會憑空長出 `graphId`；後者是 `SubAgent` 自己就有的欄位被限制了取值，**而那種擋法會隨升版無聲消失**：`SubAgent.mode` 哪天被加寬回 `'handoff' | 'fork'`，這條窄就沒了，而不會有任何東西紅。所以這一格加了一條**釘欄位**的絆索（`packages/nexus-core/src/registry.test.ts` 的「fork 與 compiled 兩種形狀在型別上進不來，handoff 進得來」），配一條正面斷言擋相反方向的漂移。

**擋的是 `tsc`，而且只有 `tsc`——組裝期不補第二道。** `foldSubAgents` 是 `{ ...spec }` 展開，**它不剝也不擋 `mode`**：實測把一個 `mode: 'fork'` 的 spec 用 `as` cast 註冊進去，`foldRegistry` 交出來的 `subagents[0].mode` 原樣是 `'fork'`（`fold.test.ts` 的「被 cast 進來的 fork 標記，fold 原樣帶到基座」釘住這件事）。所以正確的說法不是「基座看不到 fork」，是**「型別是這條路上唯一的守衛，一個 cast 就繞得過去」**——守衛與真正在擋的東西不是同一個。

**基座的判別式認的是存在的標記，不是欄位的缺席。** `isForkedSubAgent()` 的三行是 `'mode' in value && value.mode === 'fork'`（`langsmith-*.js:3287`），不是「沒有 `systemPrompt`」——所以一個沒寫 `systemPrompt` 的普通 `SubAgent` **不會**被誤判成 fork。這件事查之前不知道，而它是兩種很不一樣的世界：如果判別式認的是缺席，fork 語意就是**任何人少寫一個欄位就踩得到**的東西；認的是存在的標記，就得有人明著寫 `mode: 'fork'` 才碰得到。

**生產路徑上只有一個生產者，而它是原樣傳遞的那種**：`foldRegistry`（`fold.ts:290` → `agent-factory.ts:359` → `createDeepAgent`）。我們自己的程式碼裡那條路上沒有 cast、沒有 `@ts-expect-error`——但那擋的是**我們**，不是未來寫 plugin 的人。**而今天這條路上零佔用者**：扣掉測試與 fixture 之後，沒有任何生產 plugin 呼叫過 `subagents.register()`。

**判定：認帳不做，這是這一條唯一值得推翻的判斷。** 理由三條——(1) 今天零消費者，也零註冊者，沒有任何 plugin 要求「繼承父代理的對話」；(2) 這條窄是**我們自己選的**，不是基座缺，放寬的成本是一行型別加上想清楚 fork 的權限與 middleware 怎麼折（`foldSubAgents` 的 `{ ...spec }` 展開對 `ForkedSubAgent` 不會直接成立，它沒有 `systemPrompt`）；(3) 其餘四種後端（spawn／acp／claude-code／codex）基座根本沒有，那是決策 3 延後的那一類與定位差異，不在這一格。**需求出現時再開卡，而兩條絆索保證那天不會是「咦，什麼時候變得進得來了」。**

**沒做、而且是刻意沒做的：組裝期不加執行期的剝除或拒絕。** 那要先決定「有人明著 `as` cast 進來」算不算威脅模型裡的事——今天零註冊者，這個問題沒有人在等答案。**但它現在是一個被釘住的現況，不是一個沒人知道的洞**：`fold.test.ts` 那條測試會在有人加了剝除的那天紅。

**生命週期時刻那一軸不在這條裡。** `subagent/start`／`subagent/end` 兩個時刻的處置在第 3 條末——那問的是「時刻」，這條問的是「後端種類」，兩條接得上但不合併。

### 7. 登記不排

- `shell`／`sandbox`／`subprocess`／`terminal`：決策 3 明文延後直到容器方案明朗；基座三條件互斥（`sandbox-backend-conflict.test.ts`）讓 QuickJS 走了 custom tool。
- `jobs`／`schedule`／`workflow`／`extensions`／`session-query`／`workspace`：dsh 有、我們沒有、需求沒出現。
- **`context/` 那五個非預設的套件**（`time-context`／`file-reference`／`file-reference-local`／`session-reference`／`tmux-context`）：**2026-09-07 從第 5 條降下來的**（[#215](https://github.com/DemianLi/nexus-agent/issues/215)），理由三條見第 5 條。第六個 `agent-instructions` 是 base 唯一掛的，我們有等價物。**這一列照第 7 條的慣例不掛絆索**——一個掃空的結構 gate 會永遠綠（紀律見第 3 條末），**改為明著寫重開條件，任一成立就重開**：(1) **wire 上出現 client 時區**（`apps/web` 送上來、`@nexus/wire` 的 protocol 收得下），那時「按用戶時區解釋未限定的時間」才有來源；(2) **有 plugin 指名要每步新鮮的讀數**（不只是時鐘），那時第 5 條第 2 題的鉤子選擇才值得付那一格 `beforeModel` 節點。
- **核准的應答者掛點與審計事件**：**2026-09-08 從 §六第 7 條降下來的**（[#220](https://github.com/DemianLi/nexus-agent/issues/220)）。**兩半的理由完全不同，所以分開寫。**
  - **應答者掛點——不做，而理由是 dsh 自己寫的。** 那條 waterfall 是**兩個提問者**逼出來的：`tools/pre-execute` 的 `ask` 決策，以及沙箱拒絕後的一次性升級重試。被否掉的替代方案講得更死——內聯進 ACP 橋不行，因為「无法服务第二个发起方（沙箱升级发生在执行开始之后，没有 pre-execute 时刻）」（`.agents/notes/implemented/feature/2026-07-06-approval-seam.zh.md:97`）。**我們今天只有一個提問者**（`nexus-plugin-plan-mode/src/index.ts:525`，`exit_plan_mode` 回 `ask`），沒有沙箱升級也沒有鉤子橋，**逼出可組合 seam 的那件事在我們樹上還沒發生**。順帶：dsh 也否掉過 `registerProvider()`（同檔 `:96`），所以「單一提供方」不是它沒想到，是它想過不要。
  - **審計那半——也不做，但這是射程的選擇，不是可行性的選擇。** **原本寫的理由（「與 #190 第 2 格的紀錄差是同一個結構成因，紀錄由入口點在圖外附加」）是錯的**：`model/usage` 就是 **fold 自建的 middleware 在圖裡 append**（`fold.ts:282` → `model-usage.ts:160`），`compaction/summary` 同形（`fold.ts:664`），而 `foldApprovalGate`（`fold.ts:527`）手上本來就有整張 `registry`。`session-log.ts` 檔頭那條加事件種類的門檻（「加種類要同時回答『兩條路都產得出來嗎』」）核准也過得了，理由與 `model/usage` 一字不差——**它就是那一份組裝本身**。**不做的理由只剩一條：今天沒有人要從日誌回答核准的事**（判法照第 6 條：零消費者、零註冊者，需求出現時再開卡）。另外量到一件會抬價的：**閘門在恢復時整條 waterfall 會重跑一次**（實測，`apps/harness/src/interrupt.test.ts` 加探針：暫停時 listener 跑 1 次，恢復後累計 2 次），所以 `asked` 那顆要配一個冪等守衛，不能照抄 `model/usage`。
  - **照第 7 條的慣例不掛絆索**——`interception-index.test.ts` 第 4 列已經有一條翻得了面的（`SessionEventType` 不含 `| 'approval/`，那兩顆事件落地那天它會紅）。這裡寫**重開條件，任一成立就重開**：(1) **出現第二個提問者**——樹上有第二處產生 `{ kind: 'ask' }`，而它拿不到 `tools/pre-execute` 那個時刻（例如執行開始之後才決定要升級），那時共享的應答者 seam 才在解決一個真的問題；(2) **有人要從日誌回答「某次工具為什麼沒跑」而答不出來**——今天 `interrupt/raised` 只帶 `interruptId`，而 `deny`／`policy-never`／`no-channel` 三條路連那一顆都沒有。
- **核准線那組絆索守的是基座的舊機制**：**2026-09-08 從 §六第 1 條窄化出來的**——那一條原本寫「Phase 5 沒有逐條核」，問句判為不成立（見 §六第 1 條），剩下來的是這一樣。形狀是「能力不在產品路徑上」的鏡像：**守錯了對象，不是測壞了**，基座那三條行為多半還真。`apps/harness/src/hitl-wire.test.ts` 檔頭寫明「三條是**基座行為的絆索**，紅了代表基座改了主意而不是我們寫壞了」，所以它直接 `createDeepAgent({ interruptOn })`（`:66`）是**刻意的**，不是漏改；但 [#112](https://github.com/DemianLi/nexus-agent/pull/112) 把產品路徑換成 `wrapToolCall` 上的閘門時**沒有動這個檔**（它動的是 `interrupt.test.ts` +207、`agent-factory.test.ts`、`cli.test.ts`、`approval.fixture.ts`、`summarization.test.ts` 與 core 那一整組），三條的地位因此沒有跟著重估：(1) **絆索 2「混合批次在下行上與全拒絕一模一樣，被核准的那筆連一顆 frame 都沒有」（`:249`）守的行為 #112 明說「不存在了」**，它還綠著是因為自己用 `interruptOn` 建 agent，繞過了我們的閘門；(2) **`:226` 的行內註解「中斷發生在 `afterModel`，tools node 從沒跑」對產品路徑不成立**；(3) **絆索 1 驗的 n>1 在產品路徑上恆為 1**（`packages/nexus-core/src/approval.ts` 的 JSDoc：「這裡是逐次呼叫各自判斷，所以 `actionRequests` 恆長度 1」），折疊器為 n>1 寫的三樣（取交集、一致性檢查、長度不符擋下）只有測試餵得到。**不排的理由**：刪掉會一起賠掉「基座改主意時會紅」，而重寫成產品路徑的形狀要先有東西餵得進去——今天沒有。**照第 7 條的慣例不掛絆索，改為明著寫重開條件，任一成立就重開**：(1) **產品路徑上出現同一批的第二顆中斷**（`actionRequests` 長度 > 1，或「核准的應答者掛點與審計事件」那一列講的「第二個提問者」出現），那時折疊器的 n>1 邏輯才有真的餵給它的東西；(2) **有人要斷言 `input.requested` 前後的 frame 順序**——新機制的代價是「同一批裡排在被擋工具前面的那些，在人被問到時已經跑完了」，而折疊器對 `tools` frame 是到達順序 append（`packages/nexus-wire/src/conversation.ts` 的 `tool-started`／`tool-finished` 兩支，沒有相對於 pending 的正規化），所以 `tool-started` 可以排在 `input.requested` **前面**，舊的 `afterModel` 中斷產不出這個順序。#124 那次實跑沒有觸發它（`exit_plan_mode` 是單顆）。

- **Proteus 的測量軸**：不是我們的缺口，是「能不能被它量」。~~三個前提裡缺的那個就是第 4 條~~——**2026-09-05 起不是了**：持久化那一格已經落地（#172／#174），三個前提裡剩下的是**具名的可編輯 surface**（§4.5 第三列）。開地圖的條件因此已經滿足，內容仍是：定義 surface、匯出軌跡、寫 adapter，而「匯出軌跡」那一項現在是**寫 adapter 的人明著傳 `--session-log` 並認得 run 目錄的命名**，不是我們這側再補東西。

## 六、沒查清楚的

1. ~~**Phase 5 的驗收句沒有逐條核。** `apps/web` 只確認了檔案存在與 `App.tsx` 檔頭；「完成度」是「存在」不是「驗過」。~~ **問句不成立（2026-09-08，只讀原始碼與 PR 內文）。** 這一條講的是**這份調研 2026-09-02 當天自己的核對深度**，不是「沒人驗過」——[`development-plan.md`](development-plan.md) 早在 **2026-08-28 就宣告 Phase 5 完成（demian 拍板）**，所以這一條從一開始就不是在追一個沒答的問題，是在記「我這份筆記沒有自己去核」，而當時計劃書引的證據（#79）確實是舊機制的。驗收句（[`development-plan.md`](development-plan.md) Phase 5：「瀏覽器完成『提問 → 看事件流 → 核准工具 → 收結果』全迴圈；eval 有可比較的通過率數據」）兩半各有出處。
   - **前半由 [#124](https://github.com/DemianLi/nexus-agent/pull/124)（2026-09-01）的「驗證方式」走完**，而且是**今天這個機制**：`serve:live`、真模型 `openai/gpt-oss-120b`、**沒有 `--plugins`**。模型先 `ls` 探索再交計劃 → 送出 `exit_plan_mode` → 核准卡片跳出來、送出框鎖成「先回答上面那個核准請求…」 → 按「全部核准」→ 留下「已核准：exit_plan_mode」 → `write_file` 與 `read_file` 都跑完；伺服器日誌零不變量違規。那顆核准來自 `packages/nexus-plugin-plan-mode/src/index.ts` 的 `registry.approvals.gate(...)`，不是基座的 `interruptOn`。
   - **[#79](https://github.com/DemianLi/nexus-agent/pull/79) 是載體的出處，不是等價的證據。** 它第一次走完整條（含「全部拒絕」那一半：第二顆中斷「等待核准：write_file」→ 全部拒絕 → transcript 留下「已拒絕：write_file（沒有執行）」），並交了 `apps/harness/src/approval.fixture.ts` 與 README 那道 `--plugins` 指令（今天都還在）——**但它跑在舊機制上**（基座 `interruptOn`、中斷在 `afterModel`），fixture 隨後被 [#112](https://github.com/DemianLi/nexus-agent/pull/112) 改寫成 `approvals.gate`。#112 自己複驗過，**載體是 CLI 不是瀏覽器**（`printInterrupt` 讀 `actionRequests[].name` 與 `.description`，證明酬載形狀相容）；瀏覽器那個載體是 #124 補的。
   - **後半（eval 數據）**由 [#83](https://github.com/DemianLi/nexus-agent/pull/83)／[#84](https://github.com/DemianLi/nexus-agent/pull/84)／[#86](https://github.com/DemianLi/nexus-agent/pull/86)／[#87](https://github.com/DemianLi/nexus-agent/pull/87) 三輪數據收掉，[#167](https://github.com/DemianLi/nexus-agent/issues/167) 收掉階梯裝置時結論一個字都沒變。

   **窄化之後剩下一樣，而且不是原文寫的那件事**——是核准線那組絆索守錯了對象（守著基座的舊機制，而產品路徑在 #112 之後走我們自己的閘門）。判為不排，降到 §五第 7 條，重開條件寫在那裡。
2. ~~**langchain 1.x middleware 有沒有 `beforeAgent`／`afterAgent` 或會話級鉤子**——決定第 3 條是一張卡還是一筆偏離。~~ **半題結案（2026-09-05）**：`langchain@1.5.10` 的 `agents/middleware/types.d.ts` 六個鉤子齊全（`beforeAgent`／`beforeModel`／`wrapModelCall`／`afterModel`／`afterAgent`／`wrapToolCall`），而且我們早就靠著它——`repeat-reminder.ts` 數過基座自己用 `beforeAgent` 7 次、`afterAgent` 1 次，`thread-pump.ts` 與 `wire-handler.ts` 都在跟 `beforeAgent` 的時序賽跑。所以「一張卡還是一筆偏離」這半：**卡**。~~**另一半仍未答**⋯第 3 條的開圖條件因此是**部分滿足**。~~ **另一半 2026-09-07 結案（[#212](https://github.com/DemianLi/nexus-agent/issues/212)，只讀原始碼）**：「會話級與每次 agent 呼叫不是同一個縫」這個**區分是對的**——dsh 確實有 `agent/session-start` 與 `agent/pre-step` 兩個不同的事件名，橋接分別訂它們——**但它不是未答的題**。那三個會話級時刻逐個對得到 #190 的第 1／2／3 格，三格都已經有結局，其中第 1 格由 [#201](https://github.com/DemianLi/nexus-agent/issues/201) 判為不是缺口。第 3 條因此收完，不是部分滿足。
3. ~~**LangChain 工具執行的 `AbortSignal` 有沒有一路傳到 `wrapToolCall` 的 handler**——決定 `timeout-policy` 表達得出來嗎。~~ **結案（2026-09-04，[#148](https://github.com/DemianLi/nexus-agent/issues/148) 實測三條路都通）**。載體是工具上的 `defaultConfig: { timeout }`；dsh 原地換 `exec.signal` 那招在這個基座上不成立（`baseHandler` 用的是閉包裡的 `config.signal`）。[#162](https://github.com/DemianLi/nexus-agent/issues/162) 已據此落地，見 §五第 2 條的狀態。
4. ~~**`foldSubAgents` 對 `ForkedSubAgent` 的處理**——決定第 6 條是缺口還是已有。~~ **兩半都結案了（2026-09-07）**，答案同樣是「進不來」但理由不同：`AsyncSubAgent` 缺必填的 `graphId`（`apps/harness/src/base-tools.ts:52-62` 檔頭），`ForkedSubAgent` 是 `SubAgent.mode` 被窄成 `'handoff'` 字面量。**後者那種擋法會隨升版無聲消失**，所以釘了一條欄位絆索（`registry.test.ts`）；而**擋的只有 `tsc`**——`foldSubAgents` 不剝也不擋 `mode`，一個 `as` cast 就能把 `mode: 'fork'` 原樣送到基座，那個現況由第二條測試釘住（`fold.test.ts`）。逐條見 §五第 6 條。
5. **Proteus `environments/` 底下的 `openhands/`、`swe-agent/`** 是 adapter 還是 bench 環境——`proteus/adapters/` 裡沒有對應檔，`ROADMAP.md` T1 把它們列為待做 harness，所以傾向是環境骨架，沒有進一步讀。
6. **dsh `docs/subsystems/README.zh.md` 列的 53 個子系統頁與 51 個套件目錄的對應**——我以套件目錄為對照單位，沒有以子系統頁再對一次（例如 `agent-team` 在 `experimental/`、`token-meter` 在 `llm/`、`scope` 在 `core/`）。
7. ~~**`interaction/user-approval` 與我們 `registry.approvals` 的語意差**——只對了「一次性核准」這個標籤，沒有對 `ApprovalOutcome`、策略、審計事件的形狀。~~ **查完了（2026-09-08，[#220](https://github.com/DemianLi/nexus-agent/issues/220)，只讀原始碼）。**

   **先窄化：「只對了標籤」是低估的。** 樹上已經有三處引著 dsh 的核准原始碼——`packages/nexus-core/src/approval.ts` 檔頭引 `core/tools/src/index.ts:152`（形狀）與 `:589`（`PreToolDecision` 三格封閉）；同檔 `ApprovalChannel` 的 JSDoc 對過 dsh 那幾條刻意各不相同的 deny reason，連理由（讓模型分得出「有人說不」與「根本沒有核准管道」）都引了過來；`fold.ts:111` 把 `approvals.enabled === false` 對到 dsh 的 `ApprovalPolicy: 'never'`。**這一條原本的問句因此不是它自己寫的那一句。**

   **真正沒對過的是五樣**：

   1. **應答者在 dsh 是掛點，在我們這側是寫死的一格。** `approval/request`（`interaction/user-approval/src/types.ts:85`）是一條 Cordis waterfall：回一個結果就是替那個 agent 作答，否則 `next()`；UI 通道與 ACP 橋接**各是一位應答者**，提問者也不只一個（`core/tools`、`sandbox/escalation.ts`、`shell/tool-bash`）。我們的 `registry.approvals` **只收提問者**（`gate()`），應答者是 `approval.ts` 裡寫死的 `interrupt(...)`，`ApprovalChannel` 是 fold 當下的一個判決、不是掛點。
   2. **結果詞彙四值 vs 兩值。** `ApprovalOutcome`（`types.ts:32`）＝ `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`，`serviceAsk` 一對一映回 deny，並把 `cancelled` 抬成一個 `approvalCancelled` 旗標餵給呼叫端的中止判斷。我們只有 approve／reject，**`cancelled` 沒有表達式**。
   3. **審計事件我們一顆都沒有。** dsh 每次 request 追加 `approval/asked` ＋ `approval/decided`（`types.ts:44-58`，log-only audit，**是自己的事件種類、不是 `tool/*`**），另有 `invariant.ts` 在同一個未結束的輪次內按 id 配對。我們這側：`deny`／`policy-never`／`no-channel` 三條路一顆都不記；人那條只有一顆**只帶 `interruptId`** 的 `interrupt/raised`；**結果從來沒進日誌**（`wire-handler.ts` 收到 `decisions` 之後零個 `append`），日誌上只剩 `turn/start` 的 resume 那一格，而它分不出核准與拒絕。兩個生產者都在圖外（`thread-pump.ts:384`、`cli.ts:733`）——**與 #190 第 2 格的紀錄差同一個結構成因**。
   4. **政策只對了 `never` 那一半。** dsh 的 `ask` 是預設，而且**當前政策會貢獻進模型看得到的執行期上下文快照**（`user-approval/src/index.ts:156` 的 `'approval:policy'`），`setPolicy()` 還活著切換得了、並為下一步注一則帶來源的 user message。我們的 `approvals.enabled` 是 fold 當下定死的，模型看不到政策。
   5. **輪次邊界。** dsh 的 `request()` 要求身處未結束的輪次，空閒或輪次之間呼叫**在審計之前就拋**——理由是輪次是持久日誌的提交／回放邊界。我們沒有這個要求，也沒有審計可以保護。

   **落地處**：`apps/harness/src/interception-index.test.ts` **第 4 列**（[#221](https://github.com/DemianLi/nexus-agent/pull/221)）。那一列原本 `permissionDelta` 與 `recordDelta` 都是 `undefined`，而在那份索引裡 `undefined` 是有意義的斷言（「三欄逐欄對得上」／「沒有紀錄面的缺口」）——**兩句都比量過的多**，與這一條並存時互相矛盾。這是 [#218](https://github.com/DemianLi/nexus-agent/issues/218) 剛在第 2 列改掉的同一型病。

   **判為認帳不做，降到 §五第 7 條**，重開條件寫在那一列。dsh SHA `c389f96bf3a9b6807cb71ed6bdad5849be0df6d8`（`interaction/user-approval/` 相對 `d347e70` 一行沒動）。
8. ~~**兩處過時的數字**：`packages/nexus-core/src/registry.ts` 檔頭「四條」、`development-plan.md` §1「一條 `lifecycle` 通道」，實際都是五條。~~ **已改正**：兩處今天都寫「五條」（`registry.ts:9`、`development-plan.md` §1）。2026-09-05 順手補了第三處——`development-plan.md` §3 的套件表也只寫「lifecycle 通道」。
