# nexus-agent 開發計劃：萬物皆可插件的 Deep Agents Harness（TypeScript）

狀態：方向已確認（2026-08-23）。
需求基準：《企業級 AI Agent 系統架構與 Harness 開發範圍說明 v1.0》（deepagents 1.13.1 / LangChain JS 1.5.x / LangGraph JS 1.4.x）。

## 0. 已確認的決策

| # | 決策 | 內容 |
|---|---|---|
| 1 | 技術棧全 TypeScript | LangChain JS + LangGraph JS + deepagentsjs（官方 TS 版），零 Python 基座 |
| 2 | 插件化程度 | agent 推理迴圈為固定基座（deepagentsjs），迴圈周圍的擴充點全部走 NexusPlugin 契約；不 fork、不做「連迴圈都可替換」的徹底插件化 |
| 3 | 兩層薄覆蓋 | 反思與反饋層、意圖與理解層先採薄覆蓋，後續強化追蹤於 [issue #16](https://github.com/DemianLi/nexus-agent/issues/16)，Phase 0–5 全部完成後啟動 |
| 4 | 選型決策點 | 模型供應商、狀態儲存後端保留為決策點。模型供應商拆三段收斂：Phase 0 定預設（Anthropic）、Phase 2 驗 DeepSeek 相容性、Phase 5 比品質與成本；狀態儲存 Phase 3 收斂（見第 7 節） |

核心路線：**不從零重造**。deepagentsjs 已內建虛擬檔案系統（可插拔 backends）、宣告式檔案權限、subagents、TodoListMiddleware（opt-in）、SummarizationMiddleware、skills（SKILL.md 標準）、memory（AGENTS.md）、human-in-the-loop（`interruptOn`）、typed streaming。需求約七成由基座覆蓋；自建部分為 plugin 統一註冊、結果校驗、可觀測性接線、web UI。

**更正（`feat/mcp-plugin`）：MCP 不在基座裡。** 原文把「MCP 工具接入」列進 deepagentsjs 的內建清單，第 2 節的架構表與第 4 節的選型表也照著寫。實測 `deepagents@1.13.1` 整包沒有一處提到 MCP —— LangChain JS 這一側的 MCP 是 `@langchain/mcp-adapters` 這個獨立套件（`MultiServerMCPClient` / `loadMcpTools`），它產出的是 `DynamicStructuredTool`，以一般自訂工具的身分進來。所以 MCP 是**一個新相依**，不是零成本的內建功能。

## 1. 萬物皆可插件的落地定義

deepagentsjs 的擴充入口原本分散（`tools`、`middleware`、`backend`、`subagents`、`permissions`、`interruptOn` 各傳各的）。nexus 的差異化價值是收斂成單一契約。

契約形狀是**命令式註冊**，不是靜態宣告（[#28](https://github.com/DemianLi/nexus-agent/issues/28) 決議 9，照 DeepSeek Harness 全命令式的做法）：

```ts
// 形狀示意，非最終簽章
interface NexusPlugin {
  name: string;
  requires?: string[]; // 能力名而非 plugin 名；只做存在性檢查，不排序
  apply(registry: PluginRegistry): void | Promise<void>;
}

// apply 內部
registry.capabilities.provide(name); // 能力宣告；重複提供冪等、不報錯
registry.tools.register(tool); // 同層同名報錯、跨層遮蔽
registry.subagents.register(sub); // 同名報錯；只有全域一層，沒有遮蔽
registry.backend.mount('/memories/', backend); // 同 routePrefix 報錯
registry.middleware.use(mw, { prepend: false }); // 清單順序，prepend 為唯一例外閥
registry.permissions.deny(paths, { except }); // deny-only
registry.interrupts.require(toolName, { reason, when }); // 同工具多方標記不報錯，when 取 OR
registry.skills.addSource(path); // 同一來源路徑重複註冊報錯
registry.memory.addSource(path); // 純累加，基座自理
```

- **一個 plugin = 一個 workspace 模組**，只相依 `@nexus/core`（[#30](https://github.com/DemianLi/nexus-agent/issues/30)）。契約住 `packages/nexus-core`，不住 `apps/harness` —— 封裝邊界靠 pnpm 的相依隔離機械保證：plugin 若 import `@nexus/harness`，`tsc` 會以 `TS2307` 擋下（實測），而契約留在 app 裡時這條保護不存在，因為 plugin 為了拿型別本來就得相依整個 app。zod manifest 仍在，但只驗 `name` / `requires`，不驗擴充內容。
- `requires` 比對的是各 plugin 用 `registry.capabilities.provide(name)` 宣告的能力集合（[#28](https://github.com/DemianLi/nexus-agent/issues/28) 決議 10 要求的「能力 → 提供者」對照表，其輸入端由 [#29](https://github.com/DemianLi/nexus-agent/issues/29) 補上）。**能力是集合不是註冊表**：重複 `provide` 冪等、不報錯，獨佔性由各擴充點自己的規則守（同名 tool、同 `routePrefix`）。
- **`name` 不唯一，plugin 層級不做唯一性檢查**（[#43](https://github.com/DemianLi/nexus-agent/issues/43)）。同一個 plugin 掛載多次是合法的 —— `createMcpPlugin({ server: 'github' })` 與 `createMcpPlugin({ server: 'linear' })` 兩個都叫 `mcp`，井水不犯河水。共同軸線的「同層報錯」管的是**註冊表**（同名 tool、同名 subagent、同 `routePrefix`），plugin 清單不是註冊表而是一份輸入序列；真撞了會撞在它們註冊的東西那一層。`name` 因此是**純標籤，唯一用途是錯誤訊息指名** —— registry 每次註冊要記住是誰註冊的，訊息用清單位置區分同名者（`plugins[1] (mcp)`）。`version` 欄位不存在：版本號是給安裝的人看的，npm 已經在做（[#33](https://github.com/DemianLi/nexus-agent/issues/33) 的範圍規則 ＋ lockfile）。從外部指認某一次掛載的機制見 [#46](https://github.com/DemianLi/nexus-agent/issues/46)，現在不需要。
- `PluginRegistry` 是活的具名註冊表：插入順序、同名報錯、每次註冊回一個撤銷函式（**射程限定為載入期回滾**，不承諾執行期熱插拔——deepagents 建構後不可變）。最終仍折疊成一次 `createDeepAgent(...)` 呼叫。
- **九個註冊點之外有一條 `lifecycle` 通道**（`registry.lifecycle.onDispose(fn)`，`feat/mcp-plugin`）。它**不是第十個註冊點**：九個註冊點回答「這個 agent 由什麼組成」、會折進 `createDeepAgent` 的參數，這條回答「這些東西怎麼收掉」、什麼都不折。`loadPlugins()` 因此多回一個 `dispose()`，組裝點的 `createNexusAgent()` 跟著回 `{ agent, dispose }`。引進它的是 MCP：MCP server 是外部程序，stdio 子行程的 pipe 是活的 handle，沒人關的話 CLI 印完答案不會退出（實測：拿掉 `dispose()` 之後 `pnpm --filter @nexus/harness run cli --plugins src/cli-mcp.fixture.ts` 停在那裡不動）。**回滾與關機是兩條路**：`apply` 中途拋錯時的資源釋放由 plugin 自己的 `try` / `catch` 負責——dsh 的 `ctx.effect` 一個函式兼兩職，那靠的是 Cordis 的 context 樹，我們沒有。**載入失敗時仍然收**：靠前的 plugin 已經開好的東西由 `loadPlugins()` 在拋出之前收掉，因為失敗的呼叫端拿到的是 exception、不是 handle（註冊內容則刻意留著，診斷要有東西可看）。
- 共同軸線：**同層報錯、跨層遮蔽、fail-closed、載入期失敗**。「層」指全域（root agent）↔ 各 subagent。**`subagents` 註冊點自己沒有層**：deepagents 的 `SubAgentBase` 沒有巢狀 subagents 欄位（`name` / `description` / `systemPrompt` / `mode` / `tools` / `model` / `middleware` / `interruptOn` / `skills`），遮蔽在那裡表達不出來，所以 subagent 只有全域一層、同名一律報錯。
- **組裝點所有、plugin 不得提供**：default backend、工具呈現順序、model、checkpointer / store、核准政策的 session 開關。
- 換模型、換儲存、換工具組合 = 換 plugin 清單，core 不動。此契約同時滿足補強項 6「業務邏輯解耦」。

三點要特別記著：

- **`permissions` 不是授權邊界，是意外防護。** 它只覆蓋 `FILESYSTEM_TOOL_NAMES` 那八個內建工具裡「當前 backend 實際註冊的那些」，而且基座無規則命中即 allow。真正的檔案圍堵靠換 backend（Phase 2 `feat/fs-backends` 已落地 `ContainedFilesystemBackend`，[#34](https://github.com/DemianLi/nexus-agent/issues/34)）。而**外部 MCP server 的工具連 backend 都不經過** —— deepagents 明文「custom tools from the agent or other middleware are left untouched」，所以那些工具自己碰檔案系統不在任何管束範圍內。這是一條明文限制，不是待補的功能。
- **`interruptOn` 的核准詞彙是封閉的。** plugin 只能貢獻 `{ toolName, reason, when? }`；`allowedDecisions` 由 harness 固定為 `["approve", "reject"]`，`argsSchema` 不使用（dsh 明文「Input rewrite is deliberately not offered」）。宣告了需核准的工具卻沒有 checkpointer，registry 要在載入期報錯——缺席即拒絕，不是放行；**核准政策的 session 開關關著卻有人宣告要核准，同樣報錯**，因為沒人回答的中斷只會把 agent 掛在那裡，靜默丟掉那些標記則是把政策解除武裝。全域的核准標記也**主動併進每個 subagent**，理由與 deny 同一條：基座是 `agentParams.interruptOn ?? defaultInterruptOn`，自帶設定的 subagent 會把全域那些整組蓋掉。
- **工具呈現順序要自建。** deepagents 沒有對應機制，dsh 有專門的 Agent Note（註冊順序造成過真實 CI flake）。組裝點要有一份顯式清單＋`'<unlisted-tools>'` rest entry＋字典序預設，屬 Phase 1 `feat/nexus-plugin-contract` 的範圍。

## 2. 七層架構 ↔ 實作映射

| 架構層 | nexus 實作 | 來源 | 覆蓋程度 |
|---|---|---|---|
| 感知輸入層 | 訊息標準化（LangChain messages）+ CLI / web 入口 | 自建（薄） | 足夠 |
| 意圖與理解層 | 可插拔 model provider + system prompt 組裝 | LangChain model layer | **薄覆蓋**，強化見 issue #16 |
| 規劃與編排層 | deepagents 迴圈 + TodoListMiddleware + subagents | deepagentsjs 內建 | 完整 |
| 記憶層 | memory（AGENTS.md）+ skills + summarization/offloading | deepagentsjs 內建 | 完整 |
| 執行與工具層 | tools + 虛擬 FS + 權限 + sandbox/QuickJS（內建）＋ MCP（`@langchain/mcp-adapters`） | deepagentsjs 內建，MCP 除外 | 完整 |
| 反思與反饋層 | 結果校驗 middleware + LangSmith 回饋 | **自建** | **薄覆蓋**，強化見 issue #16 |
| 輸出層 | typed streaming → apps/web UI | deepagentsjs stream + 自建 UI | 完整 |

harness 五大範圍對應：解析標準化（PluginRegistry + zod）、編排迴圈（deepagents）、記憶層（內建）、工具層（內建）、結果校驗（自建 plugin——deepagents 無現成方案，為驗證插件架構價值的第一個實戰 plugin）。

## 3. 套件結構（pnpm workspace）

```
packages/nexus-core      契約：NexusPlugin 型別、zod manifest、PluginRegistry 九個註冊點 ＋ lifecycle 通道、fold
packages/nexus-plugin-*  plugin 系列，只相依 @nexus/core
apps/harness             組裝點：agent 工廠、訊息標準化、CLI；唯一呼叫 createDeepAgent 的地方
apps/web                 輸出層：對話 + 事件流 + HITL 核准 UI（現有骨架續用）
```

`pnpm-workspace.yaml` 的 glob 為 `apps/*` 與 `packages/*`。

**`packages/nexus-core` 在 Phase 1 就拆出**（[#30](https://github.com/DemianLi/nexus-agent/issues/30)），不等 Phase 2。切線是**誰呼叫 `createDeepAgent`**：core 是純轉換層，只產出參數；harness 發出唯一那次呼叫。core 相依 deepagents 的型別是必然的（`subagents.register` 收 `SubAgent`、`backend.mount` 收 backend），「core 不碰 deepagents」不是可行的切線。

**組裝點自有的那些（default backend、工具呈現順序清單、model、checkpointer / store、核准政策的 session 開關，加一份基座工具名單）作為 fold 的輸入參數傳進 core**：所有權留在 harness，檢查（rest entry 恰好一個、宣告 interrupt 卻沒有 checkpointer、以工具名為 key 的設定沒有指向不存在的工具）跑在 core。plugin 仍然不得提供它們。

那份**基座工具名單**（`baseToolNames`）照 dsh 的 `ToolProviderResult.knownNames`：「這一次可見的工具」與「設定驗證用的名字宇宙」是兩件事，宇宙由提供者貢獻。基座自己帶進來、不經過我們 registry 的工具（`write_file` / `delete` / `execute` / `task` 那些）只有組裝點知道，而它們恰好是最該被核准、也最該排進呈現順序的那幾個——沒有這份名單，`interrupts.require('delete', ...)` 與 `toolOrder: ['write_file', ...]` 都會被誤判成「沒人註冊」。

**「不准叫這些名字」是另一件事，不共用同一個旋鈕。** 基座在 `createDeepAgent()` 開頭拿 `BUILTIN_TOOL_NAMES` 擋自訂工具撞名（丟 `ConfigurationError('TOOL_NAME_COLLISION')`），組裝點在 fold 之前先擋一次同樣的事，理由是它比基座多知道兩件：**是清單裡哪一個 plugin 註冊的**（registry 記著 origin），以及**註冊到 subagent 層或 subagent 自帶的同名工具**（基座只查 root 的 `tools`，那一層的撞名它不查，結果是無聲的遮蔽）。這份「保留名單」與 `baseToolNames` 目前同一份內容，但刻意是兩個常數：一個寬了只是多認得幾個名字，另一個寬了會擋掉合法的組裝。

實測（[#30](https://github.com/DemianLi/nexus-agent/issues/30)）：新增一個 package 的成本是 `package.json` + `tsconfig.json` + `eslint.config.js`，**沒有建置產物** —— `main: "src/index.ts"` 加 `moduleResolution: "bundler"`，workspace 內直接吃 TS source，`tsc` / `vitest` / `tsx` 三條路徑都解析得到。`strictPeerDependencies: true` 不受影響，`zod` 仍只解析出一份。

原有 `apps/harness/src/harness.ts` 的 step runner 與 deepagents 迴圈語義重疊，已於 `feat/agent-factory` 整個移除（`Step<TContext>` 沒有留下薄殼 —— 批次任務管線沒有出現需求，而 deepagents 的迴圈本來就在做同一件事）。組裝點現在是 `agent-factory.ts`（`loadPlugins` → `foldRegistry` → 唯一那次 `createDeepAgent`）加一層薄的訊息標準化 `messages.ts`。

## 4. 技術選型（全 TypeScript）

| 項目 | 選擇 | 備註 |
|---|---|---|
| 基座 | `deepagents`（deepagentsjs，官方 TS） | **`~1.13.1`，只跟 patch。** minor 會動 peer 契約（見第 7.1 節），升 minor 走一張要人 review 的 PR |
| 核心 | `langchain`（`createAgent` middleware API）、`@langchain/core` | **`^1.5.10` / `^1.2.9`** — 照抄基座當版 `peerDependencies` |
| 執行 | `@langchain/langgraph`、`@langchain/langgraph-checkpoint`、`@langchain/langgraph-sdk` | **`^1.4.10` / `^1.1.5` / `^1.9.23`**；interrupts、checkpointer、store |
| 工具 | `@langchain/core` tools + `zod` + **`@langchain/mcp-adapters`**（MCP 不在基座裡） | **`zod` 用 `^4.3.6`** — 與基座的直接相依同範圍，確保只解析出一份。`@langchain/mcp-adapters` 用 **`~1.1.4`**：它不是 `deepagents` 的 peer，[#33](https://github.com/DemianLi/nexus-agent/issues/33) 的「範圍照抄基座當版 `peerDependencies`」對它沒有答案，所以退到 repo 裡最保守的既有先例（基座自己的 `~`，只跟 patch）。實測：`pnpm install` 在 `strictPeerDependencies: true` 下通過、不必補宣告它的 peer `@langchain/langgraph`，`pnpm why zod -r` 仍是 Found 1 version |
| 觀測 | `langsmith`（tracing + evaluators） | **`>=0.7.1 <0.10.0`**。套件名是 `langsmith`，不是 `@langchain/langsmith`（後者不存在）。補強項 4 |
| 模型 | 預設 **Anthropic**（prompt caching 自動）；唯一備選 **DeepSeek**（`@langchain/deepseek`）。OpenAI 未排入評估，需要時另開決策 | Phase 0 只驗接線不比較（接線對象是 NVIDIA 閘道，不是預設供應商 —— 見第 5 節 Phase 0）；DeepSeek 相容性 Phase 2、品質與成本 Phase 5（[#31](https://github.com/DemianLi/nexus-agent/issues/31)） |
| 狀態儲存 | **決策點**：Phase 0 用 `MemorySaver`，Phase 3 評估 `@langchain/langgraph-checkpoint-postgres` | 補強項 5 |
| Sandbox | deepagentsjs sandbox providers（`SandboxBackendProtocolV2`）+ QuickJS interpreter | Phase 2 之後，安全優先 |

**版本範圍規則**（[#33](https://github.com/DemianLi/nexus-agent/issues/33)）。基座 `deepagents` 用 `~` 只跟 patch；它的六個 peer 與 `zod`，**每個 workspace package 顯式宣告它自己直接 import 的那幾個**，範圍一律照抄基座當版 `peerDependencies` 的原文 — 範圍誰說了算，答案是基座說了算。`apps/harness` 呼叫 `createDeepAgent` 並接 tracing，宣告的最多；`packages/nexus-core` 只用型別，宣告 `deepagents` / `@langchain/core` / `zod`（實測：只宣告這三個，`pnpm install` 在 `strictPeerDependencies: true` 下照樣通過，`zod` 仍只解析出一份 —— 見 [#30](https://github.com/DemianLi/nexus-agent/issues/30)）。升 `deepagents` 時把新的 peer 表重抄一次，那份 diff 就是這次升版真正動到的相依契約。

顯式宣告不是為了裝得起來（pnpm 8+ 預設 `auto-install-peers`，基座自己跑得動），是因為 harness 會直接 import 這幾個套件，而自動安裝的 peer 沒有連到 top-level；順帶讓版本在 `package.json` 上看得見，不是只躲在 lockfile 裡。

`pnpm-workspace.yaml` 設 `strictPeerDependencies: true`，讓範圍不符在 `pnpm install` 當場失敗而不是印 warning。實際跑什麼版本由已進版控的 `pnpm-lock.yaml` 決定，CI 用 `--frozen-lockfile`；範圍只決定 Dependabot 開出什麼 PR。

## 5. 開發階段

每個 PR 照 repo 流程：`<type>/<kebab-case>` 分支 → squash 進 develop，PR 標題 `<type>: <中文描述>`（見 [AGENTS.md](../AGENTS.md)）。以下 PR 切分為建議粒度。

### Phase 0 — 技術驗證（spike，2 個 PR）

- `feat/harness-deepagents-spike`（[#37](https://github.com/DemianLi/nexus-agent/pull/37)，已完成）：安裝 deepagentsjs，最小 agent（`StateBackend` + 一個 custom tool）以腳本假模型跑通。驗的是基座組裝，不是模型。
- `feat/harness-live-provider`：接上真實供應商，並依 [`docs/standards.md`](../docs/standards.md) 建立 `.env.example`（Phase 0 的必要 key 只有一把）。**接線對象是 NVIDIA 的 OpenAI 相容端點**（`https://integrate.api.nvidia.com/v1`）上的 `deepseek-ai/deepseek-v4-flash-0731`，用 `@langchain/openai` 指過去 —— JS 這邊沒有 NVIDIA 專用的 LangChain 整合（`@langchain/nvidia-ai-endpoints` 只有 Python 版）。**預設供應商的決策不動**：第 0 節決策表、第 4 節選型表與第 7 節決策點 2 仍然是 Anthropic —— Phase 0 只驗接線不比較，接線對象因此不必是預設。接線用的模型雖然是 DeepSeek，但**這證明不了 Phase 2 的「DeepSeek 相容性」**：那條驗的是同一份 plugin 清單在 middleware stack 下跑得通，而 Phase 0 還沒有任何 middleware。
- 驗收分兩段（[#31](https://github.com/DemianLi/nexus-agent/issues/31)）。**假模型那段進 CI**：CLI 下一個指令 → agent 呼叫工具 → 寫虛擬檔案 → 回覆，不需任何 API key，可重複跑。**真模型那段是一次性人工驗證**，記錄寫進 PR 內文「驗證方式」，四項：(1) 真實供應商完成一輪 tool call，工具參數以合法 JSON 回到 harness；(2) `streamMode: ['updates','values']` 的事件形狀與假模型一致；(3) Node 22 下無 warning、無相依問題；(4) key 只從環境變數讀，缺少時直接失敗、不 fallback。**prompt caching 不列** —— 那是成本優化不是接線。
- **CI 不放模型 secret** —— 打真實 API 會讓每次 push 都花錢且會 flake。假模型（`ScriptedChatModel`）因此不是鷹架而是長期測試基座，後續 phase 的端到端驗證都靠它；它與基座真實行為的分歧由 [#32](https://github.com/DemianLi/nexus-agent/issues/32) 的升版檢查清單擋（見第 7.1 節），長期落點留在 `apps/harness`，與 `createDeepAgent` 的呼叫點同處（[#30](https://github.com/DemianLi/nexus-agent/issues/30)）。

### Phase 1 — 核心迴圈 + Plugin 契約（約 4–5 個 PR）

- `feat/nexus-plugin-contract`（`packages/nexus-core`，**與測試同一個 PR 到齊** —— [#32](https://github.com/DemianLi/nexus-agent/issues/32) 的「沒有測試的套件不得通過 gate」是機械生效的，空殼 package 會讓 `pnpm -r run test` 直接紅）：`NexusPlugin` 型別 + zod manifest 驗證 + 具名註冊表原語（插入順序、同層同名報錯、跨層遮蔽、每次註冊回一個撤銷函式）+ 三個具名註冊點（`tools` / `subagents` / `capabilities`）。
- `feat/plugin-registry-fold`（`packages/nexus-core`）：其餘六個註冊點（`backend` / `middleware` / `permissions` / `interrupts` / `skills` / `memory`）+ 每個 subagent 的有效集合計算 + 工具呈現順序 + 載入期前置條件檢查 + 折疊成 `createDeepAgent` 參數。**九個註冊點在 Phase 1 一次到齊**（[#29](https://github.com/DemianLi/nexus-agent/issues/29)）：registry 是純轉換層，不依賴下游擴充點是否已落地。
- `feat/agent-factory`（`apps/harness` + `packages/nexus-plugin-echo`）：agent 工廠 + 訊息標準化入口 + 唯一那次 `createDeepAgent` 呼叫；淘汰舊 step runner，並一併移除 [`docs/standards.md`](../docs/standards.md) 的「harness 迴圈的狀態轉換」條文（[#32](https://github.com/DemianLi/nexus-agent/issues/32)：條文與它描述的程式碼同生共死，step runner 走了它才變成死條文）。
- `feat/harness-cli`：基本 REPL/CLI，作為後續 phase 的手動驗證工具。
- 驗收（[#29](https://github.com/DemianLi/nexus-agent/issues/29)。判準是**能不能只靠 fold 的輸入輸出斷言**——registry 是純 fold，衝突規則全部是 fold 的性質；「規則真的產生效果」屬各擴充點落地的 phase）：
  - **註冊表原語**（`feat/nexus-plugin-contract`，單測）：同名 tool（同層）→ 載入期報錯且訊息指名兩個 plugin 與 tool 名；同名 subagent（同層）→ 報錯；全域與 subagent 層同名 tool → **不報錯**，該層查找到最近的那個；`requires` 缺件 → 報錯，同一能力被兩個 plugin `provide` → **不報錯**。
  - **載入期回滾**：plugin 註冊了一個 tool 與一個 subagent 後在 `apply` 中途 throw → 兩者都不在結果裡，先前成功載入的 plugin 不受影響；撤銷後同名 tool 可由後續 plugin 重新註冊而不撞名（證明撤銷是真的移除，不是留墓碑佔名）——這一段在 `feat/nexus-plugin-contract`，當時只有三個註冊點。**九個註冊點各放一樣東西後 throw → 一個都不剩**，在 `feat/plugin-registry-fold`：匿名追加（middleware / deny / interrupt / memory）的撤銷路徑與具名插入不同，而且那組測試是 `load.ts` 漏包某個註冊點的 undo 時唯一會紅的地方。
  - **fold 規則**（`feat/plugin-registry-fold`，單測）：同 `routePrefix` 的 backend 掛載點 → 報錯；三個 plugin 各一個 middleware → 順序等於清單順序且 `prepend: true` 插到最前；兩個 plugin 各一條 deny → 取聯集，且全域 deny 出現在每個 subagent 的 `permissions` 裡（**聯集只在一個方向上成立**：`deny` 的 `except` 折成排在它前面的 allow，射程是整份規則表往後全部，所以靠前的 plugin 的例外會贏過靠後的 plugin 對同一路徑的 deny。glob 的差集算不出來，這是明文限制）；兩個 plugin 對同一 tool 給不同 `interruptOn` → 逐欄位 OR、**不報錯**；宣告了 `interrupts.require(...)` 但組裝點沒給 checkpointer → 報錯，給了則正常 fold；**核准標記指向不存在的工具 → 報錯**（基座那端查不到就 auto-approve，打錯字的閘門什麼都不擋，比沒宣告更糟；名字宇宙含各層、subagent 自帶的 `tools` 與組裝點宣告的基座工具名）；全域 tool 出現在每個 subagent 的有效集合裡，該 subagent 自己註冊的同名 tool 遮蔽掉它；**有工具註冊到沒人註冊過的 subagent 名上 → 報錯**（層是按名字延遲建立、刻意不在註冊時驗，所以那是 fold 的後置條件）。
  - **工具呈現順序**（`feat/plugin-registry-fold`）：未列出的工具依字典序落在 `'<unlisted-tools>'`；rest entry 缺席或超過一個 → 載入期報錯；清單列了沒人註冊的工具 → 報錯；有工具真的叫 `'<unlisted-tools>'` → 報錯（那一格不能有歧義）；**清單省略即純字典序**（照 dsh：省略不代表隨便排，代表另一種確定的排法）。
  - **正面路徑**（`feat/agent-factory`）：兩個假 plugin 各自在 `apply(registry)` 裡註冊一個 tool，一份清單 fold 出的 agent 用 `ScriptedChatModel` 跑得起來，兩邊的 tool 都呼叫得到。**其中一個是 `packages/nexus-plugin-echo` —— 真的 workspace package、只相依 `@nexus/core`、零 harness import**（[#30](https://github.com/DemianLi/nexus-agent/issues/30)：這是「契約沒有偷偷要求你伸手進 harness 內部」的唯一證據；它自帶一條薄測試斷言 `apply` 註冊了那個 tool，否則撞 [#32](https://github.com/DemianLi/nexus-agent/issues/32) 的 gate）；另一個留在 `apps/harness` 的 fixture。衝突單測用的一次性假 plugin 全部留在 `packages/nexus-core` 的測試裡。**「plugin 不得 import `@nexus/harness`」不寫成測試** —— 那要從測試裡跑 `tsc` 子行程；這條保護的來源是 pnpm 的相依隔離加 typecheck gate。
  - **端到端，只此一條**（`feat/harness-cli`）：兩個假 plugin 同名 tool → CLI **非零退出**，stderr 指名撞的是哪兩個 plugin 與哪個 tool 名。驗的是錯誤傳播路徑不被吞掉，不是衝突規則本身（那是單測的事，而傳播路徑只有一條）。

### Phase 2 — 工具層 + 權限（約 3 個 PR）

- `feat/mcp-plugin`（`packages/nexus-plugin-mcp`）：第一個正式 plugin——MCP server 工具接入，走 `@langchain/mcp-adapters`（**基座沒有內建 MCP**，見第 0 節的更正）。一個 plugin 實例對一台 server，工具以 `mcp__<serverName>__<rawName>` 註冊，名字照 dsh 正規化到供應商的 64 字元 `[A-Za-z0-9_-]` 契約、換字或截斷時補一段確定性指紋。連不上、列不出、註冊撞名都讓整份清單載入失敗（共同軸線的 fail-closed；dsh 的 `failOnStartupError: false` 是刻意不照抄的那一條）。**契約多了一條 `lifecycle` 通道**：見第 1 節。**明文限制**（[#34](https://github.com/DemianLi/nexus-agent/issues/34)）：MCP 工具**自己**的檔案存取不受 `permissions` 也不受 backend 管束，它們是外部程序、走自己的檔案系統。harness 管得住的是「MCP 讀來的資料經由內建 `write_file` 寫進虛擬 FS」那條路。要圍堵 MCP server 本身只能從啟動它的方式下手（沙箱／容器），不在 Phase 2 範圍。同一條推論的另一半：plugin 經 `registry.backend.mount()` 掛上的 backend 由 plugin 自己負責圍堵，組裝點只管 default backend。
- `feat/fs-backends`（`apps/harness`）：filesystem backends（State → Disk → composite routing）+ **含路徑圍堵的 default backend 實作**（`ContainedFilesystemBackend`）+ `permissions` 擴充點的行為驗收。CLI 多一個 `--workspace <dir>`：給了就跑在真實磁碟上、變更圍堵在它之下，省略即 `StateBackend`（不碰磁碟）。圍堵照 dsh 的 `fs-sandbox` 形狀（[#34](https://github.com/DemianLi/nexus-agent/issues/34)）：**繼承** `FilesystemBackend` 而不是平行實作、**只在寫入路徑加 fence**（`write` / `edit` / `delete`）、**讀一律通過**（讀的策略歸 `permissions`）、canonicalize-then-contain 且在委派前重新 canonicalize（接住中途被換掉的祖先 symlink）、三個 mode（`read-only` / `workspace-write` / `danger-full-access`）留一個不設防的逃生模式。**威脅模型明文降級**：這是 policy fence 不是 kernel boundary，是 containment 不是 security boundary——TOCTOU 殘留被接受，核心級隔離是 shell sandbox 的事。
  - **落地時查到的兩件事，都改變了原本的理由。** 第一：基座的 `virtualMode` 本來就會擋 `..` 與 `~` 並檢查結果落在 `rootDir` 之下，**但那是純字串比對**（基座自己的註解寫著「containment is lexical in resolvePath()」）。實測：`write` 與 `edit` 經 symlink 祖先**寫得出根外**，`delete` 擋得住（基座唯一補過的那個，`resolveDeletePath()` 會逐層 lstat），`read` 讀得出去（照定案，讀歸 `permissions`）。所以這個 class 不是「照 dsh 的形狀多加一層」，是**補基座圍堵的一個實測破口**；`delete` 也一起覆寫，理由不是基座錯，是拒絕的措辭要只有一種。那組對著沒加工的 `FilesystemBackend` 跑的斷言留著當**升版絆索**——哪天基座自己補上 canonicalize，它會紅。
  - 第二：**決議 4 的「整組替換」只發生在 subagent 自帶了 `permissions` 的時候**。基座解析的是 `input.permissions ?? permissions`，什麼都沒帶的 subagent 本來就沿用 root 那份，fold 併不併都一樣。所以行為驗收要用**自帶規則**的 subagent——拿一個什麼都沒帶的去測等於什麼都沒測到（實測：拿掉 fold 併入那一行，自帶規則的 subagent 當場把 `.env` 寫穿）。
- `feat/sandbox-plugin`：sandbox `execute` 工具（或先只做 QuickJS interpreter，shell 沙箱隔離方案明朗前不開）。**與 `feat/fs-backends` 的界線**（[#34](https://github.com/DemianLi/nexus-agent/issues/34)）：fs-backends 管**路徑**，sandbox-plugin 管**執行**。
- **主路徑驗收**（[#34](https://github.com/DemianLi/nexus-agent/issues/34)。判準是 [#28](https://github.com/DemianLi/nexus-agent/issues/28) 收下的政策 4「test denial through the executor」—— 這裡的 executor 是 **backend 的方法**，不是 middleware 也不是規則表）：agent 能經 MCP 讀外部資料並經內建 `write_file` 寫進虛擬 FS；在 **Disk backend** 上（不是 `StateBackend` —— 它的「檔案」只是 state 裡的一個 map，擋住它證明不了路徑圍堵）deny 規則擋得住 `.env` 類路徑，**且 subagent 內執行的操作同樣被擋住**（[#28](https://github.com/DemianLi/nexus-agent/issues/28) 決議 4「全域 deny 主動併進每個 subagent」的行為證據——Phase 1 只驗到物件形狀，形狀對而行為錯正是這個擴充點最容易出的錯，因為基座無規則命中即 allow）。
- **圍堵驗收**（[#34](https://github.com/DemianLi/nexus-agent/issues/34)）：目標路徑 canonicalize 後落在可寫根之外 → 被拒，**含經由 symlink 繞出去的那條**（那是 fence 唯一有趣的失敗法；只測 `../` 是在測字串處理）。
- **供應商相容性驗收**（[#31](https://github.com/DemianLi/nexus-agent/issues/31)）：同一份 plugin 清單在 DeepSeek（`@langchain/deepseek`）上跑得通 —— MCP 工具呼叫成功、permissions middleware 不失效。**只驗相容，不比品質**；不相容則決策點 2 當場關閉、DeepSeek 出局。前置是人工步驟：開 DeepSeek 帳號、取得 key、補進 `.env.example`，開始這條驗收前先開一張 `wayfinder:task` 處理。

### Phase 3 — 記憶層（約 3 個 PR）

- `feat/memory-plugin`：AGENTS.md memory + backend 選型落地（狀態儲存決策在此收斂）；一併補上「多來源併入 prompt」的形狀斷言（[#32](https://github.com/DemianLi/nexus-agent/issues/32)）。
- `feat/skills-plugin`：SKILL.md 載入與 progressive disclosure；一併補上 skills last-wins 的形狀斷言（[#32](https://github.com/DemianLi/nexus-agent/issues/32)——這裡才是第一個真的靠 last-wins 決定誰勝出的地方）。
- `feat/summarization-tuning`：SummarizationMiddleware 參數化（長任務 token 控制）。
- 驗收：跨 thread 記憶保留；長對話在 token 上限內完成多步任務。

### Phase 4 — HITL + 可觀測性 + 反思（約 3 個 PR）

- `feat/interrupt-rules`：`interruptOn` 擴充點（哪些工具暫停核准）—— 補強項 1。
- `feat/observability`：LangSmith tracing 接線 + 執行事件流結構化輸出 —— 補強項 4。
- `feat/validation-middleware`：結果校驗 middleware：工具輸出 schema 驗證、失敗自動回饋重試 —— 反思與反饋層的薄覆蓋實作（完整強化見 issue #16）。
- 驗收：破壞性操作必須人工核准才執行；LangSmith 能看到完整 trace；校驗失敗的工具結果會帶錯誤回饋給 agent 重試。

### Phase 5 — Web UI + 評測（約 3–4 個 PR）

- `feat/web-chat-stream`：apps/web 對話介面 + typed event stream 呈現（含 subagent 事件）。
- `feat/web-hitl`：核准 UI（對應 interrupt）。
- `feat/eval-suite`：LangSmith evaluators 跑基準任務 —— 補強項 3。模型供應商的品質與成本比較掛在這裡（[#31](https://github.com/DemianLi/nexus-agent/issues/31)）：同一組基準任務跑 Anthropic 與 DeepSeek，比工具呼叫成功率、參數正確性、token 成本。
- 驗收：瀏覽器完成「提問 → 看事件流 → 核准工具 → 收結果」全迴圈；eval 有可比較的通過率數據，且該數據足以讓模型供應商定案。

## 6. 六大補強項落點

| 補強項 | 落點 |
|---|---|
| Human-in-the-loop | Phase 4 `interruptOn` 擴充點 + Phase 5 web 核准 UI |
| 權限控制 | Phase 2 filesystem permissions +（延後）sandbox 隔離 |
| 可靠性 | Phase 4 validation middleware + Phase 5 eval suite |
| 可觀測性 | Phase 4 LangSmith + streaming |
| 狀態儲存選型 | Phase 0 暫定 MemorySaver → Phase 3 收斂 |
| 業務邏輯解耦 | NexusPlugin 契約本身（全程貫徹） |

## 7. 風險與決策點

1. **deepagentsjs 演進速度快，且 minor 會動相依契約**：`deepagents` 從 2025-08-03 的 1.0.0 到 2026-08-21 的 1.13.1，12 個月出了 14 個 minor、53 個穩定版。1.x 的 minor 在 semver 上宣稱相容，但實測**相依契約會在 minor 裡變動** — 1.11.0 一次新增五個 required peer（此前只有 `langsmith` 一項），1.13.0 把 `@langchain/core`、`langchain`、`@langchain/langgraph` 的下限整組抬高。對策：`deepagents` 鎖 `~1.13.1` 只跟 patch、peer 顯式宣告並照抄基座範圍、`strictPeerDependencies: true` 讓範圍不符在 install 就失敗、一組薄 smoke test 斷言擴充點的形狀事實、接觸面集中在 agent 工廠一處。

   smoke test 的邊界（[#32](https://github.com/DemianLi/nexus-agent/issues/32)）：**只斷言「契約明文依賴、而且基座改掉時型別檢查攔不到」的執行期行為**，落點跟著 agent 組裝點走。`createDeepAgent` 的參數名不另外斷言（呼叫本身就是斷言，改名會 compile 失敗）；同名 subagent 行為不斷言（[#28](https://github.com/DemianLi/nexus-agent/issues/28) 已把它擋在載入期，基座怎麼做不再是我們的依賴）。

   **升版檢查清單**：`deepagents` 升 minor 或 major 的 PR 上，重跑一次 [#31](https://github.com/DemianLi/nexus-agent/issues/31) 那四項人工真實模型驗證——tool call 參數以合法 JSON 回傳／`streamMode: ['updates','values']` 的事件形狀與假模型一致／Node 22 相容／key 只從環境變數讀且缺少即失敗。這是擋「`ScriptedChatModel` 與基座真實行為悄悄分歧」的唯一機制：CI 不放模型 secret（#31），所以那個分歧在結構上斷言不出來——寫得出來的斷言只能斷言假模型與我們對基座的想像一致，那正是分歧發生時仍然全綠的東西。
2. **模型供應商決策**（[#31](https://github.com/DemianLi/nexus-agent/issues/31)）：Anthropic 功能最全但成本高；DeepSeek 便宜。原文要在 Phase 0「兩者都跑基本驗證再定」，但 Phase 0 的驗收判定不了品質，也碰不到 middleware —— 那時還沒有任何 middleware。拆成三段：**Phase 0 只定預設**（Anthropic）並驗真實接線；**Phase 2 驗 DeepSeek 相容性**，二元判定，不相容就出局；**Phase 5 才比品質與成本**，掛在 eval suite 的基準任務上。理由是相容性是二元的、早驗早止血；品質比較是統計性的，小樣本手工跑出來的數字噪音大過訊號。
3. **shell sandbox 安全**：`execute` 工具本質是跑任意指令。先只用 QuickJS interpreter，shell sandbox 延後到有明確隔離方案（容器）再做。**權限規則對 `execute` 不生效，原因是它的參數是命令字串、沒有路徑可比對**（`execute(command: string)` 是 backend 協定上的方法，而 `FilesystemPermission.paths` 的比對單位是路徑 glob），與 backend 是不是 sandbox 無關 —— 任何支援命令執行的 backend 都一樣。**此條待驗證**（[#34](https://github.com/DemianLi/nexus-agent/issues/34)）：`StateBackend` 不註冊 `execute`，手上沒有支援執行的 backend 驗不到；`feat/sandbox-plugin` 引進時當場驗一次。
4. **結果校驗範圍（Phase 4 前）**：需定義「校驗什麼」——schema、不變量、還是業務規則。屆時拍板。
