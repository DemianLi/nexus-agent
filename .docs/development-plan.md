# nexus-agent 開發計劃：萬物皆可插件的 Deep Agents Harness（TypeScript）

狀態：方向已確認（2026-08-23）。
需求基準：《企業級 AI Agent 系統架構與 Harness 開發範圍說明 v1.0》（deepagents 1.13.1 / LangChain JS 1.5.x / LangGraph JS 1.4.x）。

## 0. 已確認的決策

| # | 決策 | 內容 |
|---|---|---|
| 1 | 技術棧全 TypeScript | LangChain JS + LangGraph JS + deepagentsjs（官方 TS 版），零 Python 基座 |
| 2 | 插件化程度 | agent 推理迴圈為固定基座（deepagentsjs），迴圈周圍的擴充點全部走 NexusPlugin 契約；不 fork、不做「連迴圈都可替換」的徹底插件化 |
| 3 | 兩層薄覆蓋 | 反思與反饋層、意圖與理解層先採薄覆蓋，後續強化追蹤於 [issue #16](https://github.com/DemianLi/nexus-agent/issues/16)，Phase 0–5 全部完成後啟動 |
| 4 | 選型決策點 | 模型供應商、狀態儲存保留為決策點。模型供應商拆三段收斂：Phase 0 定預設（Anthropic）、Phase 2 驗 DeepSeek 相容性、Phase 5 比品質與成本；狀態儲存**不是一個後端而是三個正交的軸**（checkpointer／store／backend），Phase 3 分別收斂（見第 7 節決策 4） |

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
| 記憶層 | memory（AGENTS.md）+ skills + summarization/offloading | deepagentsjs 內建 | **三個都在，但都是「注入」不是「保存」**——見第 5 節 Phase 3 |
| 執行與工具層 | tools + 虛擬 FS + 權限 + sandbox 協定與 provider（內建）＋ QuickJS 直譯器（`@nexus/plugin-quickjs`）＋ MCP（`@langchain/mcp-adapters`） | deepagentsjs 內建，QuickJS 與 MCP 除外 | 完整 |
| 反思與反饋層 | 結果校驗 middleware + LangSmith 回饋 | **自建** | **薄覆蓋**，強化見 issue #16 |
| 輸出層 | typed streaming → apps/web UI | deepagentsjs stream + 自建 UI | 完整 |

harness 五大範圍對應：解析標準化（PluginRegistry + zod）、編排迴圈（deepagents）、記憶層（內建，但只注入不保存——見第 5 節 Phase 3）、工具層（內建）、結果校驗（自建 plugin——deepagents 無現成方案，為驗證插件架構價值的第一個實戰 plugin）。

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
| 工具 | `@langchain/core` tools + `zod` + **`@langchain/mcp-adapters`**（MCP 不在基座裡） | **`zod` 用 `^4.3.6`** — 與基座的直接相依同範圍，確保只解析出一份。`@langchain/mcp-adapters` 用 **`^1.1.4`**：它不是 `deepagents` 的 peer，走下面第 3 層（[#60](https://github.com/DemianLi/nexus-agent/issues/60)）。實測：`pnpm install` 在 `strictPeerDependencies: true` 下通過、不必補宣告它的 peer `@langchain/langgraph`，`pnpm why zod -r` 仍是 Found 1 version |
| 觀測 | `langsmith`（tracing + evaluators） | **`>=0.7.1 <0.10.0`**。套件名是 `langsmith`，不是 `@langchain/langsmith`（後者不存在）。補強項 4 |
| 模型 | 預設 **Anthropic**（prompt caching 自動）；唯一備選 **DeepSeek**（`@langchain/deepseek`）。OpenAI 未排入評估，需要時另開決策 | Phase 0 只驗接線不比較（接線對象是 NVIDIA 閘道，不是預設供應商 —— 見第 5 節 Phase 0）；DeepSeek 相容性 Phase 2、品質與成本 Phase 5（[#31](https://github.com/DemianLi/nexus-agent/issues/31)） |
| 狀態儲存 | **決策點，而且是三個正交的軸，不是一個**：`checkpointer`（thread 內的對話狀態）／`store`（跨 thread 的 `BaseStore`，`StoreBackend` 用它）／`backend`（檔案落在哪——AGENTS.md、skills、`/conversation_history` 都住這裡）。Phase 0 的 `MemorySaver` 只覆蓋第一軸。`@langchain/langgraph-checkpoint-postgres@1.0.5` 同一個套件收前兩軸（`.` 出 checkpointer、`./store` 出 `PostgresStore`（實測 1.0.5 的 tarball，不是照子路徑名推的），peer 是 `@langchain/core ^1.1.44` ＋ `@langchain/langgraph-checkpoint ^1.1.4`，與我們現有範圍相容）；第三軸是 backend plugin 的事 | 補強項 5 |
| Sandbox | deepagentsjs sandbox providers（`SandboxBackendProtocolV2`）**只有協定與 provider，沒有直譯器**；QuickJS 走自建的 `@nexus/plugin-quickjs`（`quickjs-emscripten`） | Phase 2 之後，安全優先 |

**版本範圍規則**（[#33](https://github.com/DemianLi/nexus-agent/issues/33) 定基座那一層，[#60](https://github.com/DemianLi/nexus-agent/issues/60) 補其餘）。判準是**壞掉時 semver 管不管得到**，不是「這個套件危不危險」：

| 層 | 範圍 | 什麼落在這裡 | 為什麼 |
| --- | --- | --- | --- |
| 1 | **鎖死**（無前綴） | 版本號追的是 npm 以外的契約：原生二進位／ABI、遠端服務 API、外部行程或 agent 二進位、線上協議的對端 | semver 對這些沒有約束力——契約的另一端不在 npm 上。**本 repo 目前沒有這一類**；Phase 3 的 `@langchain/langgraph-checkpoint-postgres` 是第一個候選——它在資料庫裡建表與跑 migration，那份 schema 的另一端在 Postgres 不在 npm。層級在真的收下這個相依的那張 PR 上拍板 |
| 2 | **`~`** | 基座 `deepagents` 與它的六個 peer（照抄原文） | 基座的 minor 會動 peer 契約，[#33](https://github.com/DemianLi/nexus-agent/issues/33) 有實測表 |
| 3 | **`^`**（預設） | 其餘全部——純 JS／WASM 套件、生態內套件、工具鏈、devDependency | 壞了在載入期或 typecheck 就看得到，CI 當場紅 |

判準**鍵在失敗浮現的位置，不在套件的用途**。`feat/sandbox-plugin` 的 `quickjs-emscripten` 是第 3 層而不是第 1 層：它跑不受信任的程式碼，但它自己是純 WASM，沒有安裝腳本、沒有 node-gyp、沒有伺服器契約（實測：`npm view quickjs-emscripten` 無 `gypfile`、無 `install` script，相依全是它自己的 `@jitl/quickjs-wasmfile-*`）。把它歸進第 1 層是把用途當判準。

這一分層照 dsh 的實際做法（`references/deepseek-harness`，實測其 package.json）：絕大多數 `^`；鎖死的那批是 `e2b`（遠端沙箱服務 client）、`node-pty`（`install: node scripts/prebuild.js || node-gyp rebuild`）、`@openai/codex` 與 `@anthropic-ai/claude-agent-sdk`（外部 agent 二進位）、`@agentclientprotocol/sdk`（跨行程協議對端）——全部都是「契約的另一端不在 npm 上」。

**跨 package 共享單一實例的套件，範圍在每個 package 都要一模一樣**（目前是 `zod` 四處、`deepagents` 兩處、`@langchain/core` 多處）。讓它們各自漂移會把 `pnpm why zod -r` 的單一實例保證變回運氣。

基座 `deepagents` 用 `~` 只跟 patch；它的六個 peer 與 `zod`，**每個 workspace package 顯式宣告它自己直接 import 的那幾個**，範圍一律照抄基座當版 `peerDependencies` 的原文 — 範圍誰說了算，答案是基座說了算。`apps/harness` 呼叫 `createDeepAgent` 並接 tracing，宣告的最多；`packages/nexus-core` 只用型別，宣告 `deepagents` / `@langchain/core` / `zod`（實測：只宣告這三個，`pnpm install` 在 `strictPeerDependencies: true` 下照樣通過，`zod` 仍只解析出一份 —— 見 [#30](https://github.com/DemianLi/nexus-agent/issues/30)）。升 `deepagents` 時把新的 peer 表重抄一次，那份 diff 就是這次升版真正動到的相依契約。

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
- `feat/sandbox-plugin`（`packages/nexus-plugin-quickjs`）：**只做 QuickJS 直譯器**，shell 沙箱隔離方案明朗前不開（第 7 節決策 3）。**與 `feat/fs-backends` 的界線**（[#34](https://github.com/DemianLi/nexus-agent/issues/34)）：fs-backends 管**路徑**，這個管**執行**。以 `run_javascript` 註冊成 custom tool，工具名刻意避開基座的 `execute`。
  - **落地時查到的兩件事，都改變了原本的形狀。** 第一：**基座沒有 QuickJS 直譯器**。`deepagents@1.13.1` 整包 grep `quickjs` 零命中；唯一的痕跡是 skill frontmatter 的 `module` 欄位——基座解析它、驗證它，用途只有在 skills 清單裡多印一行 `→ Import: await import("@/skills/<name>")` 給模型看，**沒有任何東西實作那個 import**。那是懸空的 seam，不是「完全沒有」，但也不是可以拿來用的東西。所以直譯器是自建的（`quickjs-emscripten`，第 4 節版本範圍規則的第 3 層）。
  - 第二：**做成 sandbox backend 這條線走不通**。見第 7 節決策 3 的更正。
  - **與 dsh 的結構性偏離**（AGENTS.md 的偏離規則）：dsh 的 sandbox 是**行程沙箱**（bwrap/Landlock、Seatbelt、Windows ACL），整個 repo grep `quickjs` 同樣零命中——**dsh 沒有「JS 直譯器」這個 seam**，它有的那一個正是決策 3 延後掉的那一個。沒有可照抄的做法，退到最接近的實作：用行程內的 WASM 直譯器換掉「跑任意 shell 指令」。可以對齊的只有詞彙（dsh 的 `SandboxMode` 三個模式與 `ContainedFilesystemBackend` 的三個一字不差），而那條軸線管檔案效果，這個套件一格都沒碰。
- **主路徑驗收**（[#34](https://github.com/DemianLi/nexus-agent/issues/34)。判準是 [#28](https://github.com/DemianLi/nexus-agent/issues/28) 收下的政策 4「test denial through the executor」—— 這裡的 executor 是 **backend 的方法**，不是 middleware 也不是規則表）：agent 能經 MCP 讀外部資料並經內建 `write_file` 寫進虛擬 FS；在 **Disk backend** 上（不是 `StateBackend` —— 它的「檔案」只是 state 裡的一個 map，擋住它證明不了路徑圍堵）deny 規則擋得住 `.env` 類路徑，**且 subagent 內執行的操作同樣被擋住**（[#28](https://github.com/DemianLi/nexus-agent/issues/28) 決議 4「全域 deny 主動併進每個 subagent」的行為證據——Phase 1 只驗到物件形狀，形狀對而行為錯正是這個擴充點最容易出的錯，因為基座無規則命中即 allow）。
- **圍堵驗收**（[#34](https://github.com/DemianLi/nexus-agent/issues/34)）：目標路徑 canonicalize 後落在可寫根之外 → 被拒，**含經由 symlink 繞出去的那條**（那是 fence 唯一有趣的失敗法；只測 `../` 是在測字串處理）。
- **供應商相容性驗收**（[#31](https://github.com/DemianLi/nexus-agent/issues/31)）：同一份 plugin 清單在 DeepSeek（`@langchain/deepseek`）上跑得通 —— MCP 工具呼叫成功、permissions middleware 不失效。**只驗相容，不比品質**；不相容則決策點 2 當場關閉、DeepSeek 出局。前置是人工步驟：開 DeepSeek 帳號、取得 key、補進 `.env.example`，開始這條驗收前先開一張 `wayfinder:task` 處理。

### Phase 3 — 記憶層（約 3 個 PR）

**動工前查過一輪基座（`deepagents@1.13.1`，`dist/langsmith-zm0ILQsV.js`）。這次「基座已內建」是真的**——`createMemoryMiddleware`、`createSkillsMiddleware`、`createSummarizationMiddleware` 三個都在，`createDeepAgent` 上還有一等公民的 `memory?: string[]` 與 `skills?: string[]` 參數，而且 `@nexus/core` 的 `skills` / `memory` 註冊點與 fold 在 Phase 1 就接好了。**錯的是「完整」**：三個都只做「注入」，沒有一個做「保存」。以下每條都標了實測依據。

- `feat/memory-plugin`：AGENTS.md memory 來源 plugin ＋ 狀態儲存決策收斂。三件實測事實決定它的形狀：

  1. **memory middleware 是唯讀的。** 只有 `beforeAgent`（讀）與 `wrapModelCall`（注入 system prompt），**不註冊任何工具**。記憶要寫回去，唯一的路是模型自己呼叫 `write_file`。所以「記憶留不留得住」是 **backend** 的問題，跟 checkpointer 無關。
  2. **來源路徑不展開 `~`。** `loadMemoryFromBackend` 把路徑原樣交給 backend 的 `downloadFiles` / `read`。基座 JSDoc 裡那個 `"~/.deepagents/AGENTS.md"` 是**已 deprecated 的 `createAgentMemoryMiddleware`** 留下的——`os.homedir()` 只出現在 node-only 的 `createSettings`，backend-agnostic 這條路上一次都沒有。照抄那個例子的下場：`ContainedFilesystemBackend` 讀時放行、找不到字面上的 `~` 目錄 → 靜默沒有記憶；而寫回去會撞上我們自己那條 `"~"` 檢查。**來源一律用 backend 命名空間下的絕對路徑。**
  3. **載入失敗是靜默的。** 每個來源包在 `try / console.debug` 裡，`memoryContents` 又快取在 state（`if ("memoryContents" in state ...) return`），配上 checkpointer 就是**一個 thread 只載一次**，thread 中途改 AGENTS.md 不生效。一條蓋到記憶檔的 deny 規則 = agent 安靜地沒有記憶。這條要用測試釘住，不能只寫在註解裡。

  「多來源併入 prompt」的形狀斷言照舊補（[#32](https://github.com/DemianLi/nexus-agent/issues/32)）——這一條查過是真的：`formatMemoryContents(contents, sources)` 依 `sources` 順序串。

- `feat/skills-plugin`：SKILL.md 來源 plugin。**progressive disclosure 是純 prompt，不是機制**——middleware 只把 name／description／path 注入 system prompt，然後用文字叫模型自己 `read_file`。三個推論：

  1. skills 的讀取**走 `permissions` 與我們的 fence**。deny 規則蓋到 skills 路徑時，清單照樣列出來、讀取失敗——「看得到、讀不到」是這個擴充點的預設失敗模式，要有測試。
  2. `allowedTools` frontmatter **解析了、印進 prompt、零強制**（整包 9 個出現點全是解析與格式化）。不能當權限用。
  3. `module` frontmatter 只印一行 `await import("@/skills/<name>")`，**沒有東西實作那個 import**——[#64](https://github.com/DemianLi/nexus-agent/pull/64) 已記錄過同一件事。
  4. 快取比 memory 更硬：`loadedSkills` 是**閉包變數**，per-agent-instance，跨 thread 都不重載。agent 建好之後新增的 skill 一律看不見。

  skills last-wins 的形狀斷言照舊補（[#32](https://github.com/DemianLi/nexus-agent/issues/32)）——這一條也查過是真的：`allSkills.set(skill.name, skill)` 依 `sources` 順序覆蓋。

- `feat/summarization-tuning`：**基座上沒有「參數化」這個參數。** `createSummarizationMiddleware({ backend })` 被無條件寫死進 root 與每一個 subagent 的 stack，`CreateDeepAgentParams` 上沒有任何 summarization 欄位。唯一的縫是 `mergeMiddlewareStack` **按 `.name` 原地取代**：自己建一個同名（字串 `"SummarizationMiddleware"`）的 middleware 從 `middleware` 參數傳進去，就換掉內建那個。fold 這一側是通的（`foldMiddleware` 只做 `prepend` 排序，不包不改）。兩件事要寫進 PR：

  1. **這條縫掛在一個字串上**，要有絆索測試——基座改名或改合併語意時它該紅。
  2. **root 換掉不影響 subagent。** `createSubagentDefaultMiddleware` 每個 subagent 各建一份新的，`buildSubagentMiddleware` 只併 `input.middleware`。而長任務的 token 大戶正是 subagent，所以「長任務 token 控制」靠換掉 root 那個是**結構上就不完整的**——要嘛每個 subagent 定義自己帶，要嘛承認這個邊界並寫下來。

- **跨 Phase 的坑（Phase 2 埋的）**：summarization 的 offload 寫到 `/conversation_history`，走 backend 的 `uploadFiles`。我們的 `ContainedFilesystemBackend` 在 `read-only` mode 下會擋掉它——而基座對 offload 失敗是 **fail-open**：`console.warn` 之後照樣把訊息換成摘要（`Proceeding with summary generation.`）。也就是**完整歷史靜默消失，只留一行 warn**。同理，一條蓋到 `/conversation_history*` 的 deny 規則有一樣的效果。這要在 Phase 3 有測試，不能等它在長對話裡自己發生。

- 驗收：**跨 thread 記憶保留**——注意這一條**不是 checkpointer 能滿足的**（它是 thread 內的狀態），要靠 `store`（`StoreBackend`：「persist across all threads」）或落磁碟的 backend；長對話在 token 上限內完成多步任務，且 `/conversation_history` 真的寫得出來。

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
| 狀態儲存選型 | Phase 0 暫定 MemorySaver（只覆蓋 checkpointer 一軸）→ Phase 3 收斂 checkpointer／store／backend 三軸 |
| 業務邏輯解耦 | NexusPlugin 契約本身（全程貫徹） |

## 7. 風險與決策點

1. **deepagentsjs 演進速度快，且 minor 會動相依契約**：`deepagents` 從 2025-08-03 的 1.0.0 到 2026-08-21 的 1.13.1，12 個月出了 14 個 minor、53 個穩定版。1.x 的 minor 在 semver 上宣稱相容，但實測**相依契約會在 minor 裡變動** — 1.11.0 一次新增五個 required peer（此前只有 `langsmith` 一項），1.13.0 把 `@langchain/core`、`langchain`、`@langchain/langgraph` 的下限整組抬高。對策：`deepagents` 鎖 `~1.13.1` 只跟 patch、peer 顯式宣告並照抄基座範圍、`strictPeerDependencies: true` 讓範圍不符在 install 就失敗、一組薄 smoke test 斷言擴充點的形狀事實、接觸面集中在 agent 工廠一處。

   smoke test 的邊界（[#32](https://github.com/DemianLi/nexus-agent/issues/32)）：**只斷言「契約明文依賴、而且基座改掉時型別檢查攔不到」的執行期行為**，落點跟著 agent 組裝點走。`createDeepAgent` 的參數名不另外斷言（呼叫本身就是斷言，改名會 compile 失敗）；同名 subagent 行為不斷言（[#28](https://github.com/DemianLi/nexus-agent/issues/28) 已把它擋在載入期，基座怎麼做不再是我們的依賴）。

   **升版檢查清單**：`deepagents` 升 minor 或 major 的 PR 上，重跑一次 [#31](https://github.com/DemianLi/nexus-agent/issues/31) 那四項人工真實模型驗證——tool call 參數以合法 JSON 回傳／`streamMode: ['updates','values']` 的事件形狀與假模型一致／Node 22 相容／key 只從環境變數讀且缺少即失敗。這是擋「`ScriptedChatModel` 與基座真實行為悄悄分歧」的唯一機制：CI 不放模型 secret（#31），所以那個分歧在結構上斷言不出來——寫得出來的斷言只能斷言假模型與我們對基座的想像一致，那正是分歧發生時仍然全綠的東西。
2. **模型供應商決策**（[#31](https://github.com/DemianLi/nexus-agent/issues/31)）：Anthropic 功能最全但成本高；DeepSeek 便宜。原文要在 Phase 0「兩者都跑基本驗證再定」，但 Phase 0 的驗收判定不了品質，也碰不到 middleware —— 那時還沒有任何 middleware。拆成三段：**Phase 0 只定預設**（Anthropic）並驗真實接線；**Phase 2 驗 DeepSeek 相容性**，二元判定，不相容就出局；**Phase 5 才比品質與成本**，掛在 eval suite 的基準任務上。理由是相容性是二元的、早驗早止血；品質比較是統計性的，小樣本手工跑出來的數字噪音大過訊號。
3. **shell sandbox 安全**：`execute` 工具本質是跑任意指令。先只用 QuickJS interpreter，shell sandbox 延後到有明確隔離方案（容器）再做。

   **原本的預測錯了，`feat/sandbox-plugin` 當場驗出來的是更強的一件事。** 原文寫「權限規則對 `execute` 不生效，原因是它的參數是命令字串、沒有路徑可比對」。實際上基座不是讓規則靜靜失效，而是**不讓這兩件事共存**：`createFilesystemMiddleware` 在 `permissions` 非空、`execute` 工具開著、而 backend 又通過 `isSandboxBackend()` 時**直接拋錯**（`deepagents@1.13.1`，`dist/langsmith-zm0ILQsV.js:2368`），除非所有規則路徑都收斂在 `CompositeBackend` 的 route 前綴下；`createExecuteTool` 在執行期還有第二道同樣判準的關卡。「不生效」與「構造期硬失敗」是兩件事，而基座選的是後者——理由它自己寫在訊息裡：shell 指令碰得到任何路徑，路徑規則因此形同虛設。

   **這直接決定了 `feat/sandbox-plugin` 的形狀**：QuickJS 做成 sandbox backend 會讓 `permissions` 擴充點與它互斥，現有的權限行為驗收會在組裝期炸掉。所以走 custom tool（基座明文「custom tools from the agent or other middleware are left untouched」），完全不經過那條路。絆索測試在 `apps/harness/src/sandbox-backend-conflict.test.ts`，形狀照 `contained-backend.test.ts` 那組升版絆索——它紅了代表基座改了主意，那正是該回頭看這個決定的時刻。

   `isSandboxBackend()` 是純 duck-type（`execute` 是函式 ＋ 非空的 `id` 字串），所以「這個 backend 算不算會執行指令」不看繼承關係，看形狀。
4. **狀態儲存決策點是三個軸，不是一個**（Phase 3 收斂）：原文把它寫成「`MemorySaver` → 評估 `checkpoint-postgres`」，那只覆蓋 `checkpointer`（thread 內的對話狀態）。實測基座之後拆開：`store`（`BaseStore`，`StoreBackend` 明文「persist across all threads」）才是跨 thread 記憶的載體；`backend` 才是 AGENTS.md、skills 與 `/conversation_history` 實際落在哪。**三軸各自可選、失敗方式不同**——checkpointer 缺席是接不回 interrupt（fold 已經在擋，見 `foldRegistry` 對核准政策的前置檢查），store 缺席是換個 thread 就失憶，backend 選錯是記憶根本寫不回去（memory middleware 唯讀，寫回去只有模型的 `write_file` 一條路）。Phase 3 的三個 PR 要分別對上，不能用一個「狀態儲存選好了」收掉。

   `@langchain/langgraph-checkpoint-postgres@1.0.5` 前兩軸同一個套件收（`.` 出 checkpointer、`./store` 出 `PostgresStore`），peer 是 `@langchain/core ^1.1.44` ＋ `@langchain/langgraph-checkpoint ^1.1.4`，與我們現有範圍相容——但那是**兩個決定**，只是剛好同一個相依。

5. **結果校驗範圍（Phase 4 前）**：需定義「校驗什麼」——schema、不變量、還是業務規則。屆時拍板。
