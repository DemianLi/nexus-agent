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
registry.memory.addSource(path); // 純累加；路徑格式在註冊期擋（見第 5 節 Phase 3）
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
| 輸出層 | typed streaming（基座 v3 `streamEvents`）→ apps/web UI | deepagentsjs 內建；**協定用基座的 `@langchain/protocol`**，pump／handler／client 與 UI 自建 | **串流的形狀完整，但基座自己標為 experimental；瀏覽器到 agent 之間的線已接好（上行 HTTP、下行單向 SSE，第 7 節決策 6），UI 待做** —— 見第 5 節 Phase 5 |

harness 五大範圍對應：解析標準化（PluginRegistry + zod）、編排迴圈（deepagents）、記憶層（內建，但只注入不保存——見第 5 節 Phase 3）、工具層（內建）、結果校驗（自建 plugin——deepagents 無現成方案，為驗證插件架構價值的第一個實戰 plugin）。

## 3. 套件結構（pnpm workspace）

```
packages/nexus-core      契約：NexusPlugin 型別、zod manifest、PluginRegistry 九個註冊點 ＋ lifecycle 通道、fold
packages/nexus-plugin-*  plugin 系列，只相依 @nexus/core
packages/nexus-wire      web 與 agent 之間那條線的協定：封包型別、SSE codec、route 與 channel 白名單、瀏覽器端 client
apps/harness             組裝點：agent 工廠、訊息標準化、CLI、下行 pump 與 fetch handler；唯一呼叫 createDeepAgent 的地方
apps/web                 輸出層：對話 + 事件流 + HITL 核准 UI（現有骨架續用；線已接好，UI 待做，見第 7 節決策 6）
```

`pnpm-workspace.yaml` 的 glob 為 `apps/*` 與 `packages/*`。

**`packages/nexus-wire` 存在的唯一理由是它有兩個消費者**：Node 那端的 pump 與 handler 在 `apps/harness`，瀏覽器那端在 `apps/web`，而 SSE 的編解碼、route 常數與 channel 白名單兩邊必須是同一份。這也照 dsh —— 它把 SSE 的 frame 解碼放在**共用**的 `AbstractApiClient` 而不是各載體各寫一份。它只 `import type` 基座的 `@langchain/protocol`，沒有任何執行期相依，所以 `apps/web` 不會因此把 Node 那半邊拖進瀏覽器（`deepagents` 的 `./browser` 進入點少掉 16 個 Node 專屬匯出，而我們的 `ContainedFilesystemBackend` 繼承的正是其中的 `FilesystemBackend`）。

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
| 觀測 | `langsmith`（tracing + evaluators） | **`>=0.7.1 <0.10.0`**。套件名是 `langsmith`，不是 `@langchain/langsmith`（後者不存在）。**tracing 不需要我們接線**——`@langchain/core` 的 `CallbackManager.configure` 讀到環境變數就自己掛 tracer，所以這個相依對 tracing 而言是**被動生效**的：它在不在依賴表裡與它會不會送東西出去無關（見第 5 節 Phase 4）。補強項 4 |
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

**`@langchain/protocol` 是第 3 層，但 `^0.0.18` 讀起來會騙人。** npm 的 semver 對 `0.0.x` 不放行任何一位，所以 `^0.0.18` **在效果上等於鎖死 0.0.18** —— 寫成 `^` 只是遵守「其餘全部用 `^`」的規則，不代表它跟得到新版。判準沒變（它是純型別套件，解析不到或形狀變了 typecheck 當場紅，semver 管得到），但它同時被 `@langchain/langgraph` 與 `@langchain/langgraph-sdk` 拉進來，屬於上一段那條「跨 package 共享單一實例」的名單：`packages/nexus-wire`、`apps/harness`、`apps/web` 三處的範圍必須一字不差。它的 `exports` 把 `types` 與 `default` 都指向未編譯的 `protocol.ts`，**所以只能 `import type`** —— 一旦出現值層 import，plain node 那條路會當場爆。

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
  3. **載入失敗是靜默的，而且靜默是構造出來的。** 每個來源包在 `try / console.debug` 裡，收進來的條件又是 `if (content)`——空字串是 falsy，所以**讀不到、不存在、讀到空檔三者同形**，都塌成 `(No memory loaded)`。`memoryContents` 再快取在 state（`if ("memoryContents" in state ...) return`），配上 checkpointer 就是**一個 thread 只載一次**，thread 中途改 AGENTS.md 不生效。

     **原文這裡寫「一條蓋到記憶檔的 deny 規則 = agent 安靜地沒有記憶」，實測是反的。** `loadMemoryFromBackend` 呼叫的是 `backend.downloadFiles` / `backend.read`——**backend 方法，不是工具**，而 `checkPermission` 只活在七個工具工廠裡。所以 deny 規則**擋不住記憶載入**：檔案內容照樣被注入 system prompt，同時模型被指示「學到東西就用 `edit_file` 存起來」——存去一個規則明文禁止它寫的檔。**讀得到、寫不回去**，而不是沒有記憶。

     這是 [#66](https://github.com/DemianLi/nexus-agent/issues/66) 那件事的第三次現身：**規則表管工具，管不到 backend 方法**。差別在方向——offload 那邊是「該寫的沒寫成」，這邊是「該擋的沒擋住」，後者把檔案內容送進了模型的 context，比前者嚴重。

     真正會造成「安靜地沒有記憶」的是**路徑寫錯**（`~`、相對路徑、`..`）。這一條因此收在 `@nexus/core` 的 `assertLoadableMemoryPath`：**在註冊期擋，不在跑起來之後**。放在 registry 而不是 plugin，是因為一道只有某個 plugin 做的檢查補不住一個「不經過那個 plugin 就沒人擋」的洞——也因此 `registry.memory` 原本「純累加、基座自理」的契約要跟著改。這跟 `permissions.deny()` 刻意不驗第二次是相反情況而非不一致：那邊基座自己會拋，這邊基座什麼都不做。

     **對 dsh 的偏離（標註）**：dsh 的對應機制 `@deepseek-ai/dsh-agent-instructions` 收的是**檔名候選**（`['AGENTS.md', 'CLAUDE.md']`），`resolveInstructionFileCandidates` 把任何含 `/` 的候選連同 `RESERVED_PATH_SEGMENTS`（`''` / `'.'` / `'..'`）**靜默濾掉**——因為往上找 project root 的走查與 `~` / `$DSH_HOME` 的展開都由 loader 自己擁有。**這個形狀在 deepagents 上表達不出來**：`memory` 參數收的就是 backend 路徑，它的 loader 不走查也不展開任何東西。退到最接近的：**擋下 dsh 濾掉的同一組路段，但改成拋錯**。靜默濾掉在 dsh 那邊無害（濾完還有其他候選與走查），在這裡等於把唯一的來源刪掉，正好製造出這道檢查要防的那種靜默。

  4. **subagent 拿不到 root 的記憶，而且沒有任何公開介面給得了。** `buildSubagentMiddleware(input, isForkable)` 只在 `isForkable` 為真時併入 root 的 memory middleware，`SubAgent` 定義上**沒有 `memory` 欄位**可以自帶（`createSubagentDefaultMiddleware` 有 `input.skills` 分支，沒有 memory 的）。內建的 general-purpose subagent 也一樣：它走 `normalizeSubagentSpec`（`isForkable` 為 false），而它那次 `mergeMiddlewareStack` 帶 `{ appendNew: false }`，連從 `middleware` 參數塞一個同名的進去都會被丟掉。只有 `mode: 'fork'` 的 subagent 有。這跟下面 `feat/summarization-tuning` 記的「root 換掉不影響 subagent」是同一種邊界，要有絆索測試。

  「多來源併入 prompt」的形狀斷言照舊補（[#32](https://github.com/DemianLi/nexus-agent/issues/32)）——這一條查過是真的：`formatMemoryContents(contents, sources)` 依 `sources` 順序串。

- `feat/skills-plugin`：SKILL.md 來源 plugin。**progressive disclosure 是純 prompt，不是機制**——middleware 只把 name／description／path 注入 system prompt，然後用文字叫模型自己 `read_file`。動工前又查了一輪，原本的四條有兩條要更正、另外三條是原本沒寫的：

  1. **skills 的讀取走 `permissions`——但不走我們的 fence。原文寫「與我們的 fence」是錯的。** `ContainedFilesystemBackend` 只在寫入路徑加 fence，讀一律通過（那是 Phase 2 的定案：讀的策略歸 `permissions`，兩層正交）。所以擋人的自始至終只有 `permissions` 一層。

     「看得到、讀不到」本身成立，而且是這個擴充點的預設失敗模式：清單走 `listSkillsFromBackend` 的 `ls` / `downloadFiles`（**backend 方法，不經規則表**），正文走 `read_file` 工具（**經規則表**）。一條蓋到 skill 路徑的 deny 規則因此不會讓 skill 消失，只會讓它好端端列在 prompt 裡、模型每次去讀都被拒。已有測試（實測回傳 `Error: permission denied for read on /skills/<name>/SKILL.md`）。

     這是 [#66](https://github.com/DemianLi/nexus-agent/issues/66) 那件事的第四次現身，但**後果比記憶那次輕**：記憶那邊 deny 擋不住整份內容進 context，這邊只有 name 與 description 進得去，正文真的擋住了。差別在於 skills 的兩條路一半經過規則表、一半不經過。

  2. `allowedTools` frontmatter **解析了、印進 prompt、零強制**——原文寫「9 個出現點」，實測是 **7 個**（zod schema、解析、`formatSkillsList` 印一行），沒有一個是強制點。不能當權限用。
  3. `module` frontmatter 只印一行 `await import("@/skills/<name>")`，**沒有東西實作那個 import**（全包 `@/skills` 只有那一個出現點）——[#64](https://github.com/DemianLi/nexus-agent/pull/64) 已記錄過同一件事。
  4. **快取比 memory 更硬，但只在載到東西的時候。原文的「per-agent-instance，跨 thread 都不重載」兩個方向都不完整。**

     - **空的不算。** 載入結果為空時 `loadedSkills.length > 0` 是 false，於是**每一次 `beforeAgent` 都重掃整個來源**。實測：有 skill 的來源兩次 `invoke` 只掃 1 次，空的來源掃 2 次。一個沒有 skill 的工作區是最貴的那種，這件事原文完全沒提到。
     - **閉包與 state 是雙向的，不是單向快取。** 空閉包 + state 有 `skillsMetadata` → `loadedSkills = state.skillsMetadata`；非空閉包 + state 沒有 → 回寫 `{ skillsMetadata: loadedSkills }`。所以配上 checkpointer，一個**全新的 agent 實例**會從 thread 的 checkpoint 撿回舊 skills——「per-agent-instance」在有 checkpointer 時不成立。

  5. **skills 與 memory 的 subagent 繼承規則正好相反。**（原本沒寫）`createSubagentDefaultMiddleware` 有 `input.skills` 分支，而內建的 general-purpose subagent 在 `normalizeSubagentSpec` 時被塞進了 root 的 `skills`——**它拿得到**；自訂 subagent 沒人幫它塞，要自帶 `skills` 才有。基座註解明說：「Custom subagents do NOT inherit skills from the main agent by default. Only the general-purpose subagent inherits the main agent's skills.」

     對照上面 `feat/memory-plugin` 第 4 條：memory 只有 `mode: 'fork'` 的 subagent 拿得到，general-purpose **拿不到**。淨結果是同一組 subagent 上兩個擴充點互為反面——**fork 有 root memory 沒 root skills，general-purpose 有 root skills 沒 root memory**。已有兩條絆索釘著。

  6. **基座驗證 skill 的名字，但驗完不擋。**（原本沒寫）`validateSkillName` 檢查 kebab-case、長度、以及「`name` 必須等於目錄名」，任一條不過都只是 `console.warn`，**metadata 照樣進清單**。三種失敗還是三種音量：讀不到（`ls` 失敗 / `SKILL.md` 讀不到）**完全無聲**、frontmatter 壞掉有 `console.warn`、名字不合規範有 warn 但照收。

  7. **來源路徑的註冊期檢查比照 memory，但規則不同**（`assertLoadableSkillsPath`，`@nexus/core`）。**不能重用 `assertLoadableMemoryPath`**：那個明文拒絕結尾斜線（「記憶來源是檔不是目錄」），而 skill 來源**就是目錄**，基座還會自己補斜線。路徑寫錯的下場是 prompt 裡出現 `(No skills available yet...)`，字面上像「這個工作區還沒有 skill」，實際上是「那個目錄根本不存在」——比記憶那邊的 `(No memory loaded)` 更難察覺。順帶刻意收窄一格：基座支援 `\` 分隔，我們擋掉，理由是 backend 命名空間不是宿主檔案系統。

     **接受結尾斜線就得讓重複檢查跟上。** `/skills/` 與 `/skills` 是同一個目錄，而 `skills` 註冊點的重複檢查原本拿原字串當 key——兩個 plugin 各寫一種就兩筆都進去，基座載兩次只會讓同名 skill 自己覆蓋自己，正好是那個檢查要擋的事。改成 **key 用正規化後的、value 留 plugin 寫下的原文**：交給基座的仍是原文，撞名看的是目錄。

  **對 dsh 的偏離（標註）**：dsh **有**這個 seam，而且比 deepagents 完整得多——`packages/skill/` 下四個套件（`skill` 純註冊表、`skill-filesystem` 本地提供方、`tool-skill` 面向模型的 loader、`skill-badge`）。三格表達不出來：

  - **progressive disclosure 在 dsh 是真機制**：`ctx.skills.get(name)` 由 loader 工具執行、每次載入重讀當前檔案，所以「正文編輯不需要 hash、修訂號、快取失效」。deepagents 這邊正文讀取是模型呼叫 `read_file`，那一格意外地同向；真正不同向的是**目錄**——dsh 有 Chokidar watcher 失效，deepagents 載到就凍住。退到：絆索釘住「目錄凍住」。
  - **調用策略是 fail-closed**：dsh 的 `disable-model-invocation` / `user-invocable` 遇到駝峰拼寫或非布林值會**把整個 skill 從發現結果排除**，理由明文寫著「忽略無效資料可能在已停用的介面上暴露 skill」。deepagents 的 frontmatter 解析整個關在 `parseSkillMetadataFromContent` 裡，plugin 這側碰不到。退到：不動基座行為，用絆索釘住「不合規範的名字照樣進清單」。
  - **rank 與預設根**：dsh 收的是 `customSkillDirs`（**額外**根），疊在五個 rank 過的預設根之上（project `.dsh/skills`=100、`.agents/skills`=200、custom=300、user `<dshHome>/skills`=400、`<agentsHome>/skills`=500），project root 由「最近含 `.git` 的祖先」走查決定。deepagents 的 `skills` 就是一組平等的 backend 路徑，沒有 rank、沒有走查、沒有 `$DSH_HOME`。退到：照 `sources` 的有序 last-wins，把 rank 語意能保留的唯一一格（順序即優先序）寫進 plugin 文件，並在註冊期擋掉 dsh 的 `RESERVED_PATH_SEGMENTS` 那一組路段。

  skills last-wins 的形狀斷言照舊補（[#32](https://github.com/DemianLi/nexus-agent/issues/32)）——這一條查過是真的：`allSkills.set(skill.name, skill)` 依 `sources` 順序覆蓋。**但只說對一半**：`Map` 的迭代順序是**第一次**插入的順序，所以覆蓋換的是內容與路徑，**不換它在清單裡的位置**。斷言要照這個形狀寫。

- `feat/summarization-tuning`：**基座上沒有「參數化」這個參數。** `createSummarizationMiddleware({ backend })` 被無條件寫死進 root 與每一個 subagent 的 stack，`CreateDeepAgentParams` 上沒有任何 summarization 欄位。唯一的縫是 `mergeMiddlewareStack` **按 `.name` 原地取代**：自己建一個同名（字串 `"SummarizationMiddleware"`）的 middleware 從 `middleware` 參數傳進去，就換掉內建那個。fold 這一側是通的（`foldMiddleware` 只做 `prepend` 排序，不包不改）。動工前又查了一輪，原本的兩件變成**四件**：

  1. **這條縫掛在一個字串上**，要有絆索測試——基座改名或改合併語意時它該紅。**而且絆索要斷言「取代」而不是「有生效」**：兩者在行為上分不出來，差別只在內建那個還在不在（還在的話對話會被摘要兩次）。實測是原地取代——stack 仍是四個、位置沒動、`SummarizationMiddleware` 那一格換成我們的。

  2. **這條縫的價值不只是「換掉」，而是它是唯一的設定入口。**（原本沒寫）`historyPathPrefix` 是 `createSummarizationMiddleware` 的選項（預設 `/conversation_history`），`trigger` / `keep` / `summaryPrompt` / `trimTokensToSummarize` 也都是——而基座無條件建的那個**只吃 `{ backend }`**。所以同名取代不是「調校的手段之一」，是**唯一**能碰到這些參數的路。原文把 `/conversation_history` 當成寫死的常數，那是錯的。

  3. **root 換掉不影響 subagent。** `createSubagentDefaultMiddleware` 每個 subagent 各建一份新的，`buildSubagentMiddleware` 只併 `input.middleware`。而長任務的 token 大戶正是 subagent，所以「長任務 token 控制」靠換掉 root 那個是**結構上就不完整的**——要嘛每個 subagent 定義自己帶，要嘛承認這個邊界並寫下來。已有絆索。

     **`harnessProfile.excludedMiddleware` 是第二條縫，但它不是這個邊界的解法。**（原本沒寫）`REQUIRED_MIDDLEWARE_NAMES` 只有 `FilesystemMiddleware` 與 `SubAgentMiddleware`，所以排除 `SummarizationMiddleware` 是被允許的，而 `buildSubagentMiddleware` 結尾那個 filter 讓排除**對每個 subagent 都生效**——射程確實比同名取代大。但兩件事讓它出局：它只能**排除**不能替換（排掉等於 subagent 完全沒有摘要，長對話直接爆 context），而且它走的是**全域 profile registry**（`registerHarnessProfile` / `resolveHarnessProfile`）、靠 model spec 字串或 provider hint 查表，`CreateDeepAgentParams` 上沒有這個欄位。那是全域可變狀態加模型識別綁定，不是組裝點的參數，更不是 plugin 表達得出來的東西。

  4. **offload fail-open 的測試收在這張 PR。**（原本沒指派給任何一張）機制全在這裡，不收進來就會夾在兩張 PR 中間掉下去。詳見下面「跨 Phase 的坑」。

- **跨 Phase 的坑（Phase 2 埋的）**：summarization 的 offload 寫到 `/conversation_history`。我們的 `ContainedFilesystemBackend` 在 `read-only` mode 下會擋掉它——而基座對 offload 失敗是 **fail-open**：`console.warn` 之後照樣把訊息換成摘要（`Proceeding with summary generation.`）。也就是**完整歷史靜默消失，只留一行 warn**。已收進 `feat/summarization-tuning` 並有測試（實測 warn：`Failed to offload conversation history to /conversation_history/session_*.md: [containment] 拒絕 write ...`，而四次 invoke 全部正常回話）。

  **原文寫「走 backend 的 `uploadFiles`」只對了三分之一。** `offloadToBackend` 有三條分支：沒有既有檔走 `write()`、有既有檔且 backend 有 `uploadFiles` 走 `uploadFiles()`、有既有檔但沒有 `uploadFiles` 走 `edit()`。三條我們的 fence 都覆寫了，所以三條都擋得住——結論不變，但理由要對。

  **而 `/conversation_history` 有第二個寫入者，比這個更安靜。**（原本完全沒寫）`createFilesystemMiddleware` 的 `beforeAgent` 有一條**超大 human message 的 eviction**：最後一則 human message 超過 `4 * humanMessageTokenLimitBeforeEvict` 字元（預設 `5e4`，即 20 萬字元）時，把它寫進 `/conversation_history/<uuid>` 並在送進模型時換成一句佔位。兩個差別都往壞的方向：**路徑寫死**（不吃 `historyPathPrefix`，同名取代那條縫救不了它），**失敗完全靜默**（`if (writeResult.error) return;`，連 `console.warn` 都沒有）。

  而它失敗的**方向跟直覺相反**：fence 擋住的時候不是「原話消失」，是原話**原封不動**送進模型——20 萬字元直接灌進 context，正是 eviction 本來要避免的事。已有兩條測試（可寫時落檔一個檔、模型只收到 `Message content too large`；`read-only` 時零落檔、原話完整進 prompt）。

  兩個寫入者都要在 Phase 3 有測試，不能等它們在長對話裡自己發生——現在都有了。

  **而 `permissions` 對這條路完全沒有作用**——`checkPermission` 只在七個工具工廠裡被呼叫（`createWriteFileTool` / `createEditFileTool` / `createReadFileTool` / `createLsTool` / `createGlobTool` / `createGrepTool` 與 delete 那條），**不在 backend 方法上**。`uploadFiles` 是 backend 方法、不是工具，所以 offload 從來不經過規則表：一條蓋到 `/conversation_history*` 的 deny 規則**擋不住它**，歷史照樣寫進一個規則名義上禁止的路徑。這正好是 `contained-backend.test.ts` 那句「讀不經過 fence——讀的策略歸 permissions，兩層正交」的另一面：**寫不經過 permissions，寫的圍堵歸 fence**。

  兩件事都要在 Phase 3 有測試，不能等它們在長對話裡自己發生。

- 驗收：**跨 thread 記憶保留**——注意這一條**不是 checkpointer 能滿足的**（它是 thread 內的狀態），要靠落磁碟的 backend，或把 `store` 包成 `StoreBackend` 當 backend 用。**`store` 參數本身對記憶是惰性的**：memory middleware 不碰 `store`，`StoreBackend.getStore()` 才從 LangGraph 的執行 context 把它取出來——所以那不是「兩個選項」，是「backend 這一軸的兩種選法」。長對話在 token 上限內完成多步任務，且 `/conversation_history` 真的寫得出來。

### Phase 4 — HITL + 可觀測性 + 反思（約 3 個 PR）

- ~~`feat/interrupt-rules`：`interruptOn` 擴充點（哪些工具暫停核准）~~ —— 補強項 1。**擴充點 Phase 2 就落地了**（`registry.interrupts` ＋ `foldInterrupts` ＋ 缺 checkpointer 即拒絕 ＋ 工具名存在檢查 ＋ 多方標記 OR）。動工前一驗才發現這一項寫的是已經做完的事；真正缺的是**暫停之後**——過去唯一的行為斷言是 `expect(result.__interrupt__).toBeDefined()`，只證明「停下來了」。改成 `fix/interrupt-resume`：

  - 拒絕 → 工具真的沒跑、模型收到 `status: "error"` 的 ToolMessage；核准 → 工具真的跑了。**兩邊都要**：只驗拒絕的話，「模型根本沒呼叫那個工具」也讓 `ran === []` 過關。
  - **一批裡有人被拒，被核准的那些會靜靜地不執行**，而且從 AI 訊息的 `tool_calls` 裡被抹掉——沒有 ToolMessage、沒有痕跡（`langchain@1.5.10`，`dist/agents/middleware/hitl.js:483-496`）。這是驗收句的反面：核准了也可能不執行。fold 擋不掉，是基座的批次語義。
  - **`context: { interruptOn: {} }` 在 invoke 時整組覆蓋**（`hitl.js:421` 取 `{ ...options, ...runtime.context }`）。fold 的保證全是建構期的，一個欄位就整組繞過，不警告。入口層不得把使用者可控的東西直接當 `context` 傳下去。
  - `edit` 決定被基座當場拒收（`hitl.js:407`），所以 `mergeInterrupt` 那個封閉詞彙是真的約束；`when` 收到的 `request.tool` 恆為 `undefined`（`afterModel` 批次語境，`hitl.js:359-367`），伸手拿 `request.tool.name` 編得過、跑起來炸。
  - **CLI 對中斷一個字都不印**：`__interrupt__` 在 `updates` 串流裡的值是陣列不是 `{ messages }`，印訊息的迴圈跳過它，於是停在核准點與正常收工在畫面上一模一樣。這一版只補「說出來」，收決定的介面留給 Phase 5。
- ~~`feat/observability`：LangSmith tracing 接線~~ + 執行事件流結構化輸出 —— 補強項 4。**「接線」是不存在的工作**：`CallbackManager.configure` 自己讀環境變數，`isTracingEnabled()` 為真就 `new LangChainTracer()` 掛進去（`@langchain/core@1.2.9`，`dist/callbacks/manager.js:523-541`）。我們一行都不用寫，它就已經開著。動工前一驗撞到的是**第二次**「這一項不用做」——跟 Phase 4 第一項同型，但這次不是做完了，是從來不需要做。改成 `feat/tracing-disclosure`：

  - **可斷言，而且不需要憑證也不需要對外網路**：起一個 `127.0.0.1` 的 http server 當 `LANGSMITH_ENDPOINT`，配一把假 key，`LANGCHAIN_CALLBACKS_BACKGROUND=false` 讓它同步送（`dist/singletons/tracer.js` 把它翻成 `blockOnRootRunFinalization: true`）。一輪之後收到 `/info` 與 `/runs/multipart` 兩個請求，不必 sleep。原本「CI 沒憑證所以驗不了」的判斷是錯的——那句話裡的「憑證」其實只是「一個會收東西的端點」。
  - **驗收句要反過來寫。** 風險不是看不到完整 trace，是**完整到什麼程度**：實測工具參數 `sk-機密值-12345` 原封不動出現在 multipart body 裡。這一句和 `docs/standards.md` 的「秘密只從環境變數進來」直接衝突——秘密沒進版控，但只要 agent 讀得到它，它就跟著 trace 出境。
  - **兩道煞車都驗過，射程不同。** `LANGSMITH_HIDE_INPUTS` / `LANGSMITH_HIDE_OUTPUTS=true` 讓 `inputs` / `outputs` 變成 `{}`（`langsmith@0.9.0`，`dist/client.js:1162-1185`）——**全有全無**，trace 還在但沒有內容。要按規則脫敏就自己 `new LangChainTracer({ client: new Client({ hideInputs: fn }) })` 從 `callbacks` 傳進去，**基座會讓路**（`configure` 看到已有 `langchain_tracer` 就不再加自己那個，實測只送出一份、且帶著我們的脫敏標記）。所以 dsh 的脫敏 waterfall 在這裡**表達得出來**，不是偏離。
  - **但只有一次機會**：`getDefaultLangChainClientSingleton()` 是 module-private 的 `let client`，**沒有 setter**（`dist/singletons/tracer.js`）。第一次觸發 tracing 時的設定就定生死，之後改環境變數沒用。「跑起來之後才想開脫敏」做不到；同理，一個開過 tracing 的測試會污染同檔案後面的每一條。
  - **這一版做披露，照 dsh 的共享披露**（`docs/subsystems/session-telemetry.zh.md`）：後端必須說出當前的共享策略、且**只陳述策略不承諾投遞**，沒掛任何東西時才渲染「未配置」。CLI 現在的 banner 說了模型與檔案系統，對「這一輪會不會有東西送出這台機器」一個字都沒有——與 #71 的「CLI 對中斷一個字都不印」同一型。
  - **事件流那一半的名字是有的**（更正動工前的初判）：`handleToolStart` 第 7 個參數 `runName` 就是工具本名，`streamEvents({version:'v2'})` 直接給 `on_tool_start:probe_tool`。之前看到的 `DynamicStructuredTool` 是我讀了 `serialized.id`（類別名），**基座給名字，是我沒去拿**。subagent 也分得出來：`metadata.lc_agent_name` 是 subagent 名，`langgraph_checkpoint_ns` 帶 `tools:<id>|` 前綴標出巢狀深度，而 `task` 工具本身留在 root——Phase 5「含 subagent 事件」那句因此有根據了。v2 在 `@langchain/langgraph@1.4.12` 未標 deprecated，但 v3 已存在且回傳 `Promise`，形狀不同（§7 第 1 點）。
  - **基座的 containment 不是 fail-closed**：handler 拋錯只換來一行 `console.error`，agent 照跑（`manager.js:407`，實測），那一筆事件無聲消失。dsh 的 waterfall 是**扣下那一條**；基座是丟掉那一條、其餘照送。要 fail-closed 得自己來。
- ~~`feat/validation-middleware`：結果校驗 middleware：工具輸出 schema 驗證、失敗自動回饋重試~~ —— 反思與反饋層的薄覆蓋實作（完整強化見 issue #16）。動工前一驗，這一句的兩個子句**壞的方向不一樣**：前半是真的缺口，後半不是「還沒做」，是**我們自己把基座的預設踩掉了**。改成 `feat/tool-failure-feedback`：

  - **任何工具拋錯，整場 run 直接死。** `ToolNode.runTool` 只要 `this.wrapToolCall` 存在，就把工具自己拋的錯當成 middleware 的錯（`langchain@1.5.10`，`dist/agents/nodes/ToolNode.js:275-282`），而 `#handleError:150` 對 middleware 的錯是 `handleToolErrors !== true` 即重拋——`ReactAgent` 建 `ToolNode` 時只傳 `{ signal, wrapToolCall }`（`:174-179`），**`handleToolErrors: true` 經由 `createAgent` 根本到不了**。而 `createDeepAgent` 永遠掛 `FilesystemMiddleware`，它**永遠帶 `wrapToolCall`**（`deepagents@1.13.1`，`dist/langsmith-zm0ILQsV.js:2507`）。實測對照組講得很清楚：沒有 middleware 時工具拋錯換來一則 `Error: ...` 的 ToolMessage；**只要加一個什麼都不做的 `wrapToolCall`，同一個工具就讓整場 invoke reject**。這不是「還沒做」，是一個功能把另一個功能的預設踩掉了，而 dsh 明文把它寫成不可違反的性質：「抛出异常的工具都会变为结构化错误……**调用失败但不终止当前轮次**」（`docs/subsystems/tools.zh.md`）。
  - **唯一活下來的是輸入校驗。** `#handleError` 沿 `.cause` 走到根、是 `ToolInvocationError` 就 un-mark（`:138-145`），而工具參數不合 schema 正好走這條（`ToolInputParsingException` → `ToolInvocationError`）。所以「輸入 schema 驗證」不必做第二次，缺的是**輸出**那一半。
  - **基座自己的錯誤回饋沒有 `status: "error"`。** `defaultHandleToolErrors` 兩條分支都不設 `status`（`:32-36`、`:40-44`），實測 `status === undefined`——錯誤散文以一則結構上**成功**的訊息送進模型。我們設 `status: 'error'` 是比基座嚴，要講明，不能寫成對齊。
  - **借基座那條自我修正路的代價太高。** 從 middleware 拋 `ToolInvocationError` 確實會被翻成回饋（實測），但它的訊息把 `JSON.stringify(toolCall.args)` 與整段 `error.stack` 都塞進模型 context——#72 那個外洩形狀掉頭往內指。看得見，不走。
  - **天真的圍堵會把 HITL 的中斷吃掉。** 實測工具內 `interrupt()` 撞上不分辨的 `try/catch`：`__interrupt__` 消失，變成一則假的 error ToolMessage。加 `isGraphBubbleUp(e) → throw` 之後中斷回來、`Command({ resume })` 續跑正常。這條直接撞上 #71 釘的那些行為，要有對照組。
  - **校驗器自己炸掉同樣致命，而 `prepend` 剛好接得住。** `wrapToolCall` body 裡的 bug 一樣讓整場 reject。把圍堵用 `prepend: true` 註冊在最外、校驗器 append 在最內，實測順序 `containment-in → validator-in → containment-caught`，整場沒拋。dsh 對這件事的答案是 fail-closed：渲染器／投影器自己失敗也「转为 JSON 安全的 `isError`」，不是靜默放行。
  - **`Command` 是一行字就能造出來的靜默旁路。** 工具回 `Command` 時 `wrapToolCall` 收到的就是 `Command`，`ToolMessage.isInstance` 為 false（實測），ToolMessage 在 `update.messages` 裡。`if (!ToolMessage.isInstance(r)) return r;` 會讓所有 Command 工具整個跳過校驗，而所有回字串的測試都照過。基座自己的 `FilesystemMiddleware.wrapToolCall` 兩個分支都處理，照抄它。
  - **兩條偏離**（[AGENTS.md](../AGENTS.md) 要求標註）：①dsh 的 `defineTool` 要求每個工具**強制**宣告 `output`、註冊表在註冊時驗，但 LangChain 的 `StructuredTool` 沒有輸出 schema 這個欄位（`ToolParams` 只有 `responseFormat`），表達不出來 → 退到 plugin 這一層逐工具選加，沒宣告的明文放行。②dsh 在渲染成 content **之前**驗 canonical value，基座的 `ToolNode` 先 `JSON.stringify` 再交出來（`:244-248`），值救不回來 → 退到對 content 字串 `JSON.parse` 再驗，宣告了 schema 卻不是合法 JSON 本身即失敗。
  - **排序缺口，記著不補。** `MiddlewareRegistrationPoint` 只有 `prepend` 一根槓桿，給的是「最外」；「最內」現在只是「沒 prepend 而且剛好註冊在最後」，沒有任何 plugin 有義務尊重它。這一版釘住現況，加槓桿留給真的有第二個 plugin 要搶位置的時候。
- 驗收：**破壞性操作必須人工核准才執行**（已有可執行證據，見上）；~~LangSmith 能看到完整 trace~~ **→ tracing 開沒開、送去哪、送出去的東西脫敏到什麼程度，這三件事說得出來**（已有可執行證據，見上——原句驗過之後發現它問錯方向了）；~~校驗失敗的工具結果會帶錯誤回饋給 agent 重試~~ **→ 工具失敗（拋錯或輸出不合宣告的 schema）都變成帶更正回饋的 error ToolMessage，而且那一輪不會因此中止**（已有可執行證據，見上——原句預設了「回饋」是要加的東西，實測它本來就在，被我們自己踩掉了）。

### Phase 5 — Web UI + 評測（約 3–4 個 PR）

**動工前先驗過一輪**（`deepagents@1.13.1`、`langchain@1.5.10`、`@langchain/core@1.2.9`、`langsmith@0.9.0`，以下每一條都是實測，探針跑完即棄）。

- ~~`feat/web-chat-stream`：apps/web 對話介面 + typed event stream 呈現（含 subagent 事件）。~~ **這一句的三個部分壞的方向各不相同。**
  - **「typed event stream」是基座內建的，而且入口是 v3 不是 v2。** `DeepAgent.streamEvents(state, { version: "v3" })` 回一個 `DeepAgentRunStream`。**實際跑過的投影**：`messages`（逐則訊息的 token 串流）、`toolCalls`（`.input` / `.output` / `.status`）、`subagents`、`values`、`output`、`interrupts`、`interrupted`、`subgraphs`（吐 agent 自己的內部節點，`path` 形如 `["model_request:<uuid>"]` / `["tools:<uuid>"]`）、`extensions`（沒註冊 transformer 時是 `{}`）。**JSDoc 列了 `middleware`，但 1.13.1 的 run 物件上沒有這個東西**（實測 `typeof run.middleware === "undefined"`）；反過來，實際有而 JSDoc 沒列的是 `lifecycle`（`{ namespace, timestamp, event, graph_name }`，一次跑吐 8 筆）與 `messagesFrom`。**要用哪個投影，以 run 物件上真的有的為準，不要照 JSDoc 抄。**基座自己的 JSDoc 寫著：預設那條 legacy stream「should not be used for new user-facing agent streaming」，而 v3「will become the default in a future major release」。Phase 4 記下的「v2 沒有被標成 deprecated」是真的，但它會誤導 —— 沒被標 deprecated 不等於該拿它做面向使用者的串流。**同一段 JSDoc 也寫著 v3「experimental and its API may change in future releases」**，那句話與第 4 節把 `deepagents` 釘在 `~1.13.1`（放行 patch）撞在一起，見第 7 節決策 1。
  - **`streamTransformers` 是第十個擴充點。** `CreateDeepAgentParams.streamTransformers` 原樣轉交 `createAgent`，產物落在 `run.extensions`。第 1 節寫的是「九個註冊點在 Phase 1 一次到齊」，而 1.13.1 的參數表上是十個。**`streamTransformers` 是哪個版本加進來的沒查**，所以「Phase 1 當時漏了」或「是後來才有的」兩種都還開著 —— 缺口本身跟這個無關，反正現在少一個。**這次不補**，照 [#70](https://github.com/DemianLi/nexus-agent/pull/70)–[#73](https://github.com/DemianLi/nexus-agent/pull/73) 的先例：釘住邊界，不順手加擴充點。
  - **「含 subagent 事件」不用自建。** root 呼叫 `task` 派給名為 `writer` 的 subagent，`run.subagents` 吐出 `{ name: "writer", cause: { type: "toolCall", tool_call_id: "call_0" }, messages }`，subagent 自己那幾輪的訊息串流是分開的一條。**對照組**（一個 subagent 都沒註冊）吐零筆而且 iterator 正常收掉 —— 少了這一組，「`run.subagents` 其實是把 root 自己的內部節點也吐出來」也會過。
  - **`ScriptedChatModel` 在 v3 這條路上是瞎的，而且是靜默的。** 同一份腳本：`invoke` 與 v2 `streamEvents` 都跑到工具；**v3 只跑一輪模型就結束，工具從沒被呼叫，`run.toolCalls` 是空的，而且沒有任何東西拋錯**。原因是兩段接不上 —— v3 掛的 callback handler 讓 `_generateUncached` 走 `_streamChatModelEvents` 那一支（`@langchain/core@1.2.9`，`chat_models.js:231`），而它的預設實作是 `convertChunksToEvents(this._streamResponseChunks(...))`，那個轉換器**只讀 `msg.tool_call_chunks`、從不讀 `msg.tool_calls`**（`compat.js:174`），我們的假模型偏偏把工具呼叫掛在後者。第二個坑緊接著：`tool_call_chunk` 的 `index` 與文字 content block 共用同一個編號空間，`index: 0` 會撞上那段文字的 block 並把它寫壞（實測 `index: i` 不通、`index: i + 1` 通）。
    → **已修**（[#75](https://github.com/DemianLi/nexus-agent/pull/75)）：`_streamResponseChunks` 改吐 `tool_call_chunks`、`index` 從 1 起跳，配一組雙路徑對照測試（`stream-parity.test.ts`）。反向驗過兩次：退回 `tool_calls` 六條全紅；`index` 退成 0 四條紅，而且單一呼叫時工具**完全沒跑**（比原本記的「文字被寫壞」更嚴重），兩個呼叫時只有 `index: 1` 的那筆活下來。在它修好之前，任何走 v3 的 Phase 5 測試都是綠的而且什麼都沒驗到。這也是 [#32](https://github.com/DemianLi/nexus-agent/issues/32) 那份「假模型與基座真實行為悄悄分歧」清單上第一個真的被抓到的分歧 —— 而它是被 CI 抓不到的那種：分歧發生時測試不會紅，會靜靜地少驗一半。
  - **`apps/web` 與 agent 之間沒有線，而計劃從沒記過要選哪一條。** 現有骨架是純 Vite + React：沒有 server、沒有相依 `@nexus/harness`、沒有任何 HTTP / SSE / WebSocket。agent 跑在 Node（backend、MCP 的 stdio 子行程、QuickJS 的組裝都在 Node 這側），所以中間一定要有一段傳輸 —— 那是一個決策點，「現有骨架續用」把它藏起來了。**`deepagents` 確實有 `./browser` 進入點，但那不是「整包搬進瀏覽器」的許可**：機械比對兩份 `.d.ts` 的匯出，browser 少掉的正好是 16 個 Node 專屬的名字（`FilesystemBackend`、`LocalShellBackend`、`Settings` / `findProjectRoot` / `listSkills` / `parseSkillMetadata`、`createAgentMemoryMiddleware`、`createSubAgent` 等），而我們的 `ContainedFilesystemBackend` 正是繼承 `FilesystemBackend` 的那一個。
    → **已拍板並實作，見第 7 節決策 6**：上行 HTTP POST、下行單向事件串流（先做 SSE）。這一項因此是**兩張 PR** —— `feat/web-transport`（server 端的 pump ＋ 兩個方向的線，不含 UI）與 `feat/web-chat-stream`（UI）。**動工前一驗又推翻了依據的一半**：這條線不必自己發明，`@langchain/protocol`（`@langchain/langgraph` 的直接相依，早就在 `node_modules` 裡）已經把封包、channel 名、SSE 的 route 與 HITL 的兩個 method 都規格化了，而 v3 的 run 物件**本身就是 `AsyncIterable<ProtocolEvent>`**，吐出來的 frame 全部可 JSON 序列化。詳見決策 6。**已落地的與明著沒做的**：`packages/nexus-wire`（協定型別、SSE codec、route 與 channel 白名單、瀏覽器端 client）、`@nexus/harness` 的 `ThreadPump` ＋ 不綁 port 的 handler ＋ `node:http` 載體、`apps/web` 的連線接點；**沒有任何可執行的進入點**（沒有 `serve` script、CLI 也沒接），所以 `feat/web-chat-stream` 的第一件事就是補它——那需要決定跑哪份 plugin 清單、哪個模型、哪個 port，屬於 UI 那張的組裝決定。
- `feat/web-hitl`：核准 UI（對應 interrupt）。**混合批次要當成全有全無**：基座在一批裡只要有一筆被拒，被核准的那幾筆會靜靜地不執行、還會從歷史裡消失（見 Phase 4 那條），所以逐筆按的介面會生出一種「按了核准卻等同從沒問過」的狀態，而那件事在畫面上看不出來。**另外三件動工前查到的事：**
  - **核准 UI 要顯示的東西，基座已經整理好了。** `run.interrupts` 吐 `{ interruptId, payload: { actionRequests: [{ name, args, description }], reviewConfigs: [{ actionName, allowedDecisions: ["approve", "reject"] }] } }` —— `allowedDecisions` 就是 harness 在第 1 節固定下來的那套封閉詞彙，從串流這一端看得到。所以「畫面上能按什麼」不必另外約定，讀 payload 就是。
  - **暫停時 `await run.output` 會炸，而且炸得沒有意義**：`TypeError: Cannot read properties of undefined (reading "length")`。它不是「這一輪停住了」的訊號，是一個沒指名任何東西的錯。**要先問 `run.interrupted`**（實測回 `true`）。**這個陷阱屬於這裡，不屬於下行 pump** —— pump 抽的是 run 的 raw iteration，中斷時它乾淨結束、不拋，所以 pump 從頭到尾不必碰 `run.output`（見決策 6）。三組對照排除了「是不是我先讀了別的投影才害它壞掉」：什麼都不 drain 就 `await`、只 drain `messages`、drain 完 `messages` 與 `interrupts` —— 三種順序炸的訊息一模一樣；而**沒有中斷的那一組正常 resolve**（拿得到完整 4 則訊息）。所以炸的原因就是「這一輪停住了」本身。這是個陷阱 —— 最自然的寫法正好是壞的那個。
  - **接得回去，而且不必換路。** `streamEvents(new Command({ resume: { decisions: [{ type: "approve" }] } }), { version: "v3" })` 實測跑得通：工具真的執行、ToolMessage 的 `status` 是 `success`。所以一場對話從頭到尾只有一條呼叫路徑，不會變成「串流用 `streamEvents`、核准用 `invoke`」。
- `feat/eval-suite`：LangSmith evaluators 跑基準任務 —— 補強項 3。模型供應商的品質與成本比較掛在這裡（[#31](https://github.com/DemianLi/nexus-agent/issues/31)）：同一組基準任務跑 Anthropic 與 DeepSeek，比工具呼叫成功率、參數正確性、token 成本。**「CI 沒憑證所以驗不了」第二次是錯的**（第一次是 [#72](https://github.com/DemianLi/nexus-agent/pull/72) 的 tracing），但這次的界線比較細：
  - `langsmith/vitest` 的 `ls.describe` / `ls.test` 配上 `LANGSMITH_TEST_TRACKING=false` **完全不連外、也不要 key**（實測跑得過，評分函式的本體真的執行）。evaluator 的邏輯與資料集的形狀因此進得了 CI。
  - `langsmith/evaluation` 的 `evaluate()` 則**一定連外**：對著 loopback 假端點實測，任何 evaluator 跑起來之前它就已經發了 `POST /sessions`、`GET /datasets/<id>`、`GET /sessions`。`data` 收得下記憶體裡的 `Example[]`（資料集不必是託管的），但那個 experiment 必須是。
  - → 照 Phase 0 的切法分兩段：**evaluator 與資料集形狀進 CI，零憑證**；**`evaluate()` 的編排與 #31 的供應商數字是一次性人工驗證**，記進 PR 內文的「驗證方式」。
- 驗收：瀏覽器完成「提問 → 看事件流 → 核准工具 → 收結果」全迴圈；eval 有可比較的通過率數據，且該數據足以讓模型供應商定案。

## 6. 六大補強項落點

| 補強項 | 落點 |
|---|---|
| Human-in-the-loop | Phase 4 `interruptOn` 擴充點 + Phase 5 web 核准 UI |
| 權限控制 | Phase 2 filesystem permissions +（延後）sandbox 隔離 |
| 可靠性 | Phase 4 工具失敗回饋＋輸出校驗（先修好「工具拋錯就整場死」）+ Phase 5 eval suite |
| 可觀測性 | Phase 4 tracing 披露（LangSmith 自己會開，我們要說出來）+ streaming |
| 狀態儲存選型 | Phase 0 暫定 MemorySaver（只覆蓋 checkpointer 一軸）→ Phase 3 收斂 checkpointer／store／backend 三軸 |
| 業務邏輯解耦 | NexusPlugin 契約本身（全程貫徹） |

## 7. 風險與決策點

1. **deepagentsjs 演進速度快，且 minor 會動相依契約**：`deepagents` 從 2025-08-03 的 1.0.0 到 2026-08-21 的 1.13.1，12 個月出了 14 個 minor、53 個穩定版。1.x 的 minor 在 semver 上宣稱相容，但實測**相依契約會在 minor 裡變動** — 1.11.0 一次新增五個 required peer（此前只有 `langsmith` 一項），1.13.0 把 `@langchain/core`、`langchain`、`@langchain/langgraph` 的下限整組抬高。對策：`deepagents` 鎖 `~1.13.1` 只跟 patch、peer 顯式宣告並照抄基座範圍、`strictPeerDependencies: true` 讓範圍不符在 install 就失敗、一組薄 smoke test 斷言擴充點的形狀事實、接觸面集中在 agent 工廠一處。

   smoke test 的邊界（[#32](https://github.com/DemianLi/nexus-agent/issues/32)）：**只斷言「契約明文依賴、而且基座改掉時型別檢查攔不到」的執行期行為**，落點跟著 agent 組裝點走。`createDeepAgent` 的參數名不另外斷言（呼叫本身就是斷言，改名會 compile 失敗）；同名 subagent 行為不斷言（[#28](https://github.com/DemianLi/nexus-agent/issues/28) 已把它擋在載入期，基座怎麼做不再是我們的依賴）。

   **`~` 放行 patch，但基座有一個 experimental 的公開 API。** v3 `streamEvents`（第 5 節 Phase 5 要用的那個）的 JSDoc 明文「experimental and its API may change in future releases」。`~1.13.1` 擋得住 minor，擋不住 patch —— 而一個標成 experimental 的 API 是可以在 patch 裡動的。這不改分層（判準仍是「壞掉時 semver 管不管得到」，而這一條正是 semver 管不到的例子），但它讓升版檢查清單多一項：**碰過 v3 串流之後，`deepagents` 每次升版都要重跑一次事件流那組測試**，而不是只跑那四項人工驗證。

   **升版檢查清單**：`deepagents` 升 minor 或 major 的 PR 上，重跑一次 [#31](https://github.com/DemianLi/nexus-agent/issues/31) 那四項人工真實模型驗證——tool call 參數以合法 JSON 回傳／`streamMode: ['updates','values']` 的事件形狀與假模型一致／Node 22 相容／key 只從環境變數讀且缺少即失敗。這是擋「`ScriptedChatModel` 與基座真實行為悄悄分歧」的機制之一。

   **但「那個分歧在結構上斷言不出來」這句是錯的，Phase 5 動工前的驗證當場撞到反例。** 原文的推論是：CI 不放模型 secret（#31），所以寫得出來的斷言只能斷言假模型與我們對基座的想像一致，而那正是分歧發生時仍然全綠的東西。**漏掉的是第三種斷言：同一份腳本走兩條基座路徑，比對兩邊的結果。** `ScriptedChatModel` 在 v3 串流下對工具呼叫視而不見（見第 5 節 Phase 5），這件事完全不需要任何 key 就斷言得出來 —— 拿同一份腳本分別走 `invoke` 與 v3 `streamEvents`，斷言兩邊都跑到工具，分歧當場紅。**假模型與基座的分歧，只要基座自己有兩條路可以互為對照，就驗得出來**；驗不出來的是「真實供應商會不會這樣回」，那才是要 key 的那一半。
2. **模型供應商決策**（[#31](https://github.com/DemianLi/nexus-agent/issues/31)）：Anthropic 功能最全但成本高；DeepSeek 便宜。原文要在 Phase 0「兩者都跑基本驗證再定」，但 Phase 0 的驗收判定不了品質，也碰不到 middleware —— 那時還沒有任何 middleware。拆成三段：**Phase 0 只定預設**（Anthropic）並驗真實接線；**Phase 2 驗 DeepSeek 相容性**，二元判定，不相容就出局；**Phase 5 才比品質與成本**，掛在 eval suite 的基準任務上。理由是相容性是二元的、早驗早止血；品質比較是統計性的，小樣本手工跑出來的數字噪音大過訊號。
3. **shell sandbox 安全**：`execute` 工具本質是跑任意指令。先只用 QuickJS interpreter，shell sandbox 延後到有明確隔離方案（容器）再做。

   **原本的預測錯了，`feat/sandbox-plugin` 當場驗出來的是更強的一件事。** 原文寫「權限規則對 `execute` 不生效，原因是它的參數是命令字串、沒有路徑可比對」。實際上基座不是讓規則靜靜失效，而是**不讓這兩件事共存**：`createFilesystemMiddleware` 在 `permissions` 非空、`execute` 工具開著、而 backend 又通過 `isSandboxBackend()` 時**直接拋錯**（`deepagents@1.13.1`，`dist/langsmith-zm0ILQsV.js:2368`），除非所有規則路徑都收斂在 `CompositeBackend` 的 route 前綴下；`createExecuteTool` 在執行期還有第二道同樣判準的關卡。「不生效」與「構造期硬失敗」是兩件事，而基座選的是後者——理由它自己寫在訊息裡：shell 指令碰得到任何路徑，路徑規則因此形同虛設。

   **這直接決定了 `feat/sandbox-plugin` 的形狀**：QuickJS 做成 sandbox backend 會讓 `permissions` 擴充點與它互斥，現有的權限行為驗收會在組裝期炸掉。所以走 custom tool（基座明文「custom tools from the agent or other middleware are left untouched」），完全不經過那條路。絆索測試在 `apps/harness/src/sandbox-backend-conflict.test.ts`，形狀照 `contained-backend.test.ts` 那組升版絆索——它紅了代表基座改了主意，那正是該回頭看這個決定的時刻。

   `isSandboxBackend()` 是純 duck-type（`execute` 是函式 ＋ 非空的 `id` 字串），所以「這個 backend 算不算會執行指令」不看繼承關係，看形狀。
4. **狀態儲存決策點是三個軸，不是一個**（Phase 3 收斂）：原文把它寫成「`MemorySaver` → 評估 `checkpoint-postgres`」，那只覆蓋 `checkpointer`（thread 內的對話狀態）。實測基座之後拆開：`store`（`BaseStore`，`StoreBackend` 明文「persist across all threads」）才是跨 thread 記憶的載體；`backend` 才是 AGENTS.md、skills 與 `/conversation_history` 實際落在哪。**三軸各自可選、失敗方式不同**——checkpointer 缺席是接不回 interrupt（fold 已經在擋，見 `foldRegistry` 對核准政策的前置檢查），store 缺席是換個 thread 就失憶，backend 選錯是記憶根本寫不回去（memory middleware 唯讀，寫回去只有模型的 `write_file` 一條路）。Phase 3 的三個 PR 要分別對上，不能用一個「狀態儲存選好了」收掉。

   `@langchain/langgraph-checkpoint-postgres@1.0.5` 前兩軸同一個套件收（`.` 出 checkpointer、`./store` 出 `PostgresStore`），peer 是 `@langchain/core ^1.1.44` ＋ `@langchain/langgraph-checkpoint ^1.1.4`，與我們現有範圍相容——但那是**兩個決定**，只是剛好同一個相依。

   **`feat/memory-plugin` 收斂了 backend 這一軸，而且是可執行的證據**（`apps/harness/src/memory.test.ts` 的「記憶的保存軸」）：兩個全新建的 agent、不共用 checkpointer、不共用 state，差別只有 backend——落磁碟的那個讀得到前一個 agent 寫的 `/AGENTS.md`，`StateBackend` 那個拿到 `(No memory loaded)`。**「記憶留不留得住」因此是 backend 的問題，換 checkpointer 改變不了任何事。**

   同一輪也釐清了 `store` 與 `backend` 不是兩條平行的路：memory middleware 完全不碰 `store`，只有 `StoreBackend` 會去 LangGraph 的執行 context 把它取出來。所以 `store` 這一軸對記憶而言是「backend 的一種選法」，不是獨立選項。

   **checkpointer 與 store 兩軸維持在 `MemorySaver` 與「未選」，理由是收下 `@langchain/langgraph-checkpoint-postgres` 會把一個活的 Postgres 拖進測試路徑**，而 CI 上沒有任何服務憑證（[#31](https://github.com/DemianLi/nexus-agent/issues/31)），測試必須是自足的。版本層級也仍然懸在那張 PR 上（見第 3 節鎖死那一列）。這兩軸目前**沒有可執行證據**，只有寫下來的判斷——照實記著，別讓它看起來像已經驗過。

5. **結果校驗範圍（Phase 4 前）**：需定義「校驗什麼」——schema、不變量、還是業務規則。屆時拍板。
6. **`apps/web` 與 agent 之間的傳輸**（Phase 5 拍板）：原文從沒把它記成決策點，「現有骨架續用」那句把它藏起來了（見第 5 節 Phase 5）。**決定：上行 HTTP POST，下行單向事件串流；下行載體先做 SSE，WebSocket 覆寫留到需要時再加。形狀不變，但依據換了一半 —— 見下面「動工前一驗」。**

   **依據是 dsh 的實際做法**（AGENTS.md 的技術實現標準；以下都是讀 `references/deepseek-harness` 的原始碼，不是搜尋來的）：

   - 瀏覽器載體的形狀寫在檔案第一行：`packages/client/connection/src/client/web-api-client.ts` —— 「Browser API carrier: HTTP upstream plus one WebSocket per downstream event stream.」下行單向是**明文的協定不變量**，不是實作細節：`websocket-downlink.ts` 的類別註解寫「Client messages are a protocol violation: upstream traffic remains on HTTP.」
   - **同一組 frame 在 host 這側同時有 SSE 路由**：`packages/host/apiproxy/src/fetch/handler.ts` 的 `GET /api/events.mux` 與 `/api/events.host` 回 `text/event-stream`，而 SSE 的 frame 解碼就在共用的 `AbstractApiClient` 裡；`WebApiClient` 是**覆寫**掉那條預設改用 WS。所以 SSE 不是測試用的假縫，是同一份協定的另一個載體 —— 走 SSE 的 `InProcessApiClient` 定位為「同構接點……跑完整的協定序列化與校驗路徑而不經過網路」。**先做 SSE 等於做 dsh 兩層裡的基礎那層；但 dsh 出貨給瀏覽器的是 WS，停在 SSE 就是少了那一層覆寫，這裡明著記著。**（dsh 自己也註明 SSE 那條用的是 streaming fetch 而不是 `EventSource`，見 `packages/host/apiproxy/src/fetch/client.ts`。）
   - **事件不是「每個請求回一條串流」。** dsh 只有兩條長期下行：`mux`（跨全部 session 彙總）與 `host`（session 生命週期）。agent 的實際事件以 `session/event` 搭在 mux 上，核准請求也是（`approval/requested` 是一個可回答的 server-request），回覆走 HTTP 上行。**這一點與基座的 HITL 形狀正好對得上**：`run.interrupts` 在串流這一端、`Command({ resume })` 在下一次呼叫這一端。
   - 重連照 dsh：`since` 在它的 v1 沒實作，明文 `reconnection = reopen the stream + refetch history`。
   - **handler 的形狀也照抄**（`fetch/handler.ts`）：`(Request) => Response`，不綁 port；**路徑指名 method、封包裡也帶 method，兩者不合就是錯誤**；載體層的錯用 HTTP status（415 非 JSON media type、400 body 不是 JSON、404 不認得的 method），協定層的錯用 200 ＋ error 封包。那個 415 是有理由的安全閘：瀏覽器對 `text/plain` 之類的「simple POST」不發 preflight，只收 `application/json` 等於逼出一個這個 server 從不回答的 preflight。

   **動工前一驗（第八次，形狀對、依據不完整）：`@langchain/protocol` 已經把這條線規格化了，而且更具體。** 它是 `@langchain/langgraph` 與 `@langchain/langgraph-sdk` 的直接相依，**早就在我們的 `node_modules` 裡**，只是計劃從沒提過。原文整段從 dsh 推出來，漏掉了「既有基礎建設自己出了規格書」這件事。AGENTS.md 的偏離規則是「**基礎建設表達不出來**才退到最接近的實作」——這裡基礎建設不但表達得出來，還把 route、封包、channel 名、HITL 的兩個 method 都指定死了。**自己發明 frame 才是需要標註的那一邊。** 實測到的內容：

   - **v3 的 run 本身就是 `AsyncIterable<ProtocolEvent>`。** `GraphRunStream implements AsyncIterable<ProtocolEvent>`（`@langchain/langgraph@1.4.12`，`dist/stream/run-stream.d.ts`），`for await (const ev of run)` 直接吐 `{ type:'event', seq, method, params:{ namespace, timestamp, node?, data } }`。實測整場 56 顆 frame **全部 `JSON.parse(JSON.stringify(ev))` 過得去**，method 落在 `lifecycle` / `checkpoints` / `values` / `tasks` / `updates` / `messages` / `tools` 七個名字上，與 protocol 的 `Channel` union 一字不差。→ **pump 是一個 map，不是一層轉譯**；沒有 frame 要發明，也沒有序列化工作要做。`run.messages` / `run.toolCalls` 那些投影是給 in-process 消費者的，不是線上的東西。
   - **protocol 明文規定 SSE 那條線**：`POST /threads/:thread_id/stream`，body 是 `EventStreamRequest`（`channels` / `namespaces` / `depth` / `since`），server 回 `text/event-stream`；`Event.event_id` 的註解寫「maps to SSE `id:`」。整份協定是 thread-centric 的。上行的 `Command` 封包（`{ id, method, params }`）在 WS 那條路上直接送，HTTP 那條路上協定沒指定 route —— 那一格由 dsh 的 `fetch/handler.ts` 補：**路徑指名 method**。
   - **HITL 在協定裡有名字**：下行 `input.requested`、上行 `input.respond`。我們自己不必替核准這件事發明詞彙。
   - **已考慮並排除 `@langchain/langgraph-sdk` 的 client**：它打的是 LangGraph Platform 的 API（`client.runs.stream(threadId, assistantId, …)`），前提是跑一台 LangGraph Server。我們的組裝點是 `createDeepAgent`，不跑那台 server，所以不走它。它與 protocol 共用同一份型別，這是它們形狀相似的原因，不是可以直接接上的理由。

   **基座這側量到的六件事決定了 server 端要做什麼**（`deepagents@1.13.1` ＋ `@langchain/langgraph@1.4.12`，探針跑完即棄）：

   1. **run 不必被抽就會自己前進。** 開了 v3 串流之後什麼都不抽，300 ms 後工具已經跑完；`await run.output` 收完整場之後再抽 `run.messages`，兩輪都還在。**但這只證明了同一個 run 物件在同一個行程內可以重播** —— 跨連線、跨行程的重連沒有驗過，所以重連策略照 dsh 的 reopen ＋ refetch，不要拿這個 buffer 當重連機制。
   2. **一場對話不是一個 run 物件。** 停在核准點時 run 就收掉，`run.messages` 只有中斷前那一段（實測 `['我來記。']`）；`streamEvents(new Command({ resume }), …)` 回的是**另一個** run 物件（實測 `run2 !== run`），而且只帶 resume 之後的訊息（`['記好了。']`），舊的 run 再抽一次仍然只有前半段。→ **持久下行串流必須由 server 端把 N 個 run 物件接起來**，不能把某一個 run 直接交給瀏覽器。這正是 dsh 那條「一條長期下行、上行另走 HTTP」的形狀在我們這邊也成立的理由。
   3. **`seq` 在每個 run 上從 0 重新開始。** 實測 resume 那個 run 的第一顆 frame 是 `seq: 0`。而 protocol 的 `Event.seq` 是「monotonic sequence number for ordering」、`event_id` 是重連用的 key —— 兩者都預設整條下行是單調的。→ **server 端接起 N 個 run 的時候必須重新編號**，照原樣轉出去會讓瀏覽器那側的排序與去重靜靜地壞掉：seq 不會變小到看得出來，它是一段一段重來。
   4. **中斷時 raw iteration 乾淨結束，不拋。** 中斷本身以 `updates` frame 出現（`node: "__interrupt__"`，data 就是 `run.interrupts` 那份 `actionRequests` / `reviewConfigs`）。→ **pump 完全不必碰 `run.output`**，抽完 iteration 就是這一段的結束。第 5 節 Phase 5 記的「不能無條件 `await run.output`」仍然成立，但它是**核准 UI 那一端**的陷阱，不是 pump 的。
   5. **`lifecycle` 的 `{ event: 'completed', graph_name: 'root' }` 在中斷時照樣會發。** → 它不是「對話結束、可以關線」的訊號。拿它當關線條件的話，每按一次核准就會斷線一次。
   6. **失敗會先上線再拋。** 實測 run 失敗時最後一顆 frame 是 `lifecycle { event:'failed', graph_name:'root', error:'…' }`，**然後** iteration 才 throw。→ 瀏覽器從協定 frame 就知道為什麼死的，pump 的 try/catch 是用來收線的，不是用來補一顆錯誤 frame 的。（工具拋錯那一組另外還有一顆 `graph_name:'tools'` 的 failed，而且會多一個 `run.output.catch()` 攔不掉的 unhandled rejection —— 但那是第 5 節 Phase 4 那條「工具拋錯就整場死」的老問題，我們的組裝有 `@nexus/plugin-validation` 圍堵著，裸 `createDeepAgent` 才踩得到。模型拋錯那一組沒有這個副作用。）

   **channel 白名單是安全邊界，不是效能調校。** 實測 `tasks` 的每一顆 frame 都夾著整份 input message list、`updates` 夾著完整序列化的 `{"lc":1,…}` 訊息、`values` 夾整個 state。全頻道往瀏覽器倒等於每個 task event 重送一次對話狀態，而且 state 裡有什麼就送什麼。protocol 的 `EventStreamRequest.channels` 存在正是為這件事。→ **白名單預設只放 `messages` / `tools` / `lifecycle` ＋ 中斷那條**，`tasks` / `checkpoints` / `values` 要放行得是一個明白的決定。

   **瀏覽器斷線不得中止 run。** `run.abort()` 與 `run.signal` 就在手邊，把 HTTP response 的 abort signal 接上去是最自然的寫法，而它是錯的 —— 下行是**長期的**、與單一 run 無關，斷線之後靠 reopen 接回來。接反了不會有任何錯誤訊息，只會變成「使用者關掉分頁 agent 就停了」。

   **這張 PR 的採納範圍，與明著不做的部分。** 收：封包（`Command` / `CommandResponse` / `ErrorResponse` / `Event`）、channel 名、SSE 的 route 形狀、HITL 的 `input.respond`。**不收，而且明著記著**：`subscription.*`（SSE 那條路上訂閱就是開線本身）、`state.get` / `state.fork` / `state.listCheckpoints`、`agent.getTree`、`input.inject`、`custom:*` 頻道、`namespaces` / `depth` 過濾。**`since` 收到就明確回 `not_supported`，不靜靜忽略** —— 靜靜忽略會生出看不見的斷檔。這麼切本身就是照 dsh：它自己也只有兩條長期下行、`since` 在 v1 沒實作。跨連線的 replay 要能做得先有 frame 的持久化，而狀態儲存目前只收斂了 backend 一軸（見決策 4）。

   **偏離標記**：無協定層偏離，而且比原本記的更強 —— 這條線用的是**基座自己的協定詞彙**，dsh 提供的是它沒指定的那一格（HTTP 上行的 route 形狀與錯誤分層）。兩處未完成，都不是表達力問題：載體層先出 SSE 不出 WS 覆寫；協定層只實作上面那份採納範圍。
