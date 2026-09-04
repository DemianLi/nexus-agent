# nexus-agent 開發計劃：萬物皆可插件的 Deep Agents Harness（TypeScript）

狀態：方向已確認（2026-08-23）。
需求基準：《企業級 AI Agent 系統架構與 Harness 開發範圍說明 v1.0》（deepagents 1.13.1 / LangChain JS 1.5.x / LangGraph JS 1.4.x）。

## 0. 已確認的決策

| # | 決策 | 內容 |
|---|---|---|
| 1 | 技術棧全 TypeScript | LangChain JS + LangGraph JS + deepagentsjs（官方 TS 版），零 Python 基座 |
| 2 | 插件化程度 | agent 推理迴圈為固定基座（deepagentsjs），迴圈周圍的擴充點全部走 NexusPlugin 契約；不 fork、不做「連迴圈都可替換」的徹底插件化 |
| 3 | 兩層薄覆蓋 | 反思與反饋層、意圖與理解層先採薄覆蓋，後續強化追蹤於 [issue #16](https://github.com/DemianLi/nexus-agent/issues/16)，Phase 0–5 全部完成後啟動 |
| 4 | 選型決策點 | 模型供應商**已收斂**（2026-08-28）：**`openai/gpt-oss-120b`**，走 NVIDIA 的 OpenAI 相容端點。原本的三段收斂（Phase 0 定預設 Anthropic、Phase 2 驗 DeepSeek 相容性、Phase 5 比品質與成本）只走完第一段與第三段，**中間那段從沒跑過**，而第三段的結果讓它失去了對象 —— 詳見第 7 節決策 2。狀態儲存**不是一個後端而是三個正交的軸**（checkpointer／store／backend），Phase 3 分別收斂（見第 7 節決策 4） |

核心路線：**不從零重造**。deepagentsjs 已內建虛擬檔案系統（可插拔 backends）、宣告式檔案權限、subagents、TodoListMiddleware（opt-in）、SummarizationMiddleware、skills（SKILL.md 標準）、memory（AGENTS.md）、human-in-the-loop（`interruptOn`）、typed streaming。需求約七成由基座覆蓋；自建部分為 plugin 統一註冊、結果校驗、可觀測性接線、web UI。

**更正（`feat/mcp-plugin`）：MCP 不在基座裡。** 原文把「MCP 工具接入」列進 deepagentsjs 的內建清單，第 2 節的架構表與第 4 節的選型表也照著寫。實測 `deepagents@1.13.1` 整包沒有一處提到 MCP —— LangChain JS 這一側的 MCP 是 `@langchain/mcp-adapters` 這個獨立套件（`MultiServerMCPClient` / `loadMcpTools`），它產出的是 `DynamicStructuredTool`，以一般自訂工具的身分進來。所以 MCP 是**一個新相依**，不是零成本的內建功能。

## 1. 萬物皆可插件的落地定義

deepagentsjs 的擴充入口原本分散（`tools`、`middleware`、`backend`、`subagents`、`permissions`、`interruptOn` 各傳各的）。nexus 的差異化價值是收斂成單一契約。

契約形狀是**命令式註冊**，不是靜態宣告（[#28](https://github.com/DemianLi/nexus-agent/issues/28) 決議 9，照 DeepSeek Harness 全命令式的做法）：

```ts
// 形狀示意，非最終簽章
interface NexusPlugin {
  id?: string; // 這一次掛載的識別；省略即補 `<name>#<序號>`（#104）
  name: string;
  requires?: string[]; // 能力名而非 plugin 名；只做存在性檢查，不排序
  disabled?: boolean; // 這一次掛載不跑；apply 一次都不呼叫（#104）
  apply(registry: PluginRegistry): void | Promise<void>;
}

// apply 內部
registry.capabilities.provide(name); // 能力宣告；重複提供冪等、不報錯
registry.tools.register(tool); // 同層同名報錯、跨層遮蔽
registry.subagents.register(sub); // 同名報錯；只有全域一層，沒有遮蔽
registry.backend.mount('/memories/', backend); // 同 routePrefix 報錯
registry.middleware.use(mw, { prepend: false }); // 清單順序，prepend 為唯一例外閥
registry.permissions.deny(paths, { except }); // deny-only
registry.approvals.gate(listener); // pre-execute waterfall；next() 委派，鏈底 allow
registry.skills.addSource(path); // 同一來源路徑重複註冊報錯
registry.memory.addSource(path); // 純累加；路徑格式在註冊期擋（見第 5 節 Phase 3）
```

- **一個 plugin = 一個 workspace 模組**，只相依 `@nexus/core`（[#30](https://github.com/DemianLi/nexus-agent/issues/30)）。契約住 `packages/nexus-core`，不住 `apps/harness` —— 封裝邊界靠 pnpm 的相依隔離機械保證：plugin 若 import `@nexus/harness`，`tsc` 會以 `TS2307` 擋下（實測），而契約留在 app 裡時這條保護不存在，因為 plugin 為了拿型別本來就得相依整個 app。zod manifest 仍在，但只驗 `id` / `name` / `requires` / `disabled` 這四個條目層欄位，不驗擴充內容。
- `requires` 比對的是各 plugin 用 `registry.capabilities.provide(name)` 宣告的能力集合（[#28](https://github.com/DemianLi/nexus-agent/issues/28) 決議 10 要求的「能力 → 提供者」對照表，其輸入端由 [#29](https://github.com/DemianLi/nexus-agent/issues/29) 補上）。**能力是集合不是註冊表**：重複 `provide` 冪等、不報錯，獨佔性由各擴充點自己的規則守（同名 tool、同 `routePrefix`）。
- **`name` 不唯一，plugin 層級不做唯一性檢查**（[#43](https://github.com/DemianLi/nexus-agent/issues/43)）。同一個 plugin 掛載多次是合法的 —— `createMcpPlugin({ server: 'github' })` 與 `createMcpPlugin({ server: 'linear' })` 兩個都叫 `mcp`，井水不犯河水。共同軸線的「同層報錯」管的是**註冊表**（同名 tool、同名 subagent、同 `routePrefix`），plugin 清單不是註冊表而是一份輸入序列；真撞了會撞在它們註冊的東西那一層。`name` 因此是**純標籤，唯一用途是錯誤訊息指名** —— registry 每次註冊要記住是誰註冊的，而區分同名者的是 `PluginOrigin.id`（[#104](https://github.com/DemianLi/nexus-agent/issues/104)）：plugin 沒寫就補一個 `<name>#<序號>`（`mcp#0`、`mcp#1`），要一個不隨清單變動的名字就自己寫 `id`。條目也可以 `disabled: true` 關掉——`apply` 一次都不跑，但 id 與它在診斷裡的位置留著，所以其他條目的自動編號不會因為關掉一個而位移。`version` 欄位不存在：版本號是給安裝的人看的，npm 已經在做（[#33](https://github.com/DemianLi/nexus-agent/issues/33) 的範圍規則 ＋ lockfile）。從外部**覆寫**個別 plugin 設定的機制仍然不做，見 [#46](https://github.com/DemianLi/nexus-agent/issues/46) 與 #104 的「這張不包含」。
- `PluginRegistry` 是活的具名註冊表：插入順序、同名報錯、每次註冊回一個撤銷函式（**射程限定為載入期回滾**，不承諾執行期熱插拔——deepagents 建構後不可變）。最終仍折疊成一次 `createDeepAgent(...)` 呼叫。
- **九個註冊點之外有五條不折疊的通道，第一條是 `lifecycle`**（`registry.lifecycle.onDispose(fn)`，`feat/mcp-plugin`；其餘四條 `telemetry` / `invariants` / `commands` / `sessions` 是後來各自的 PR 加的，總表見 `packages/nexus-core/src/registry.ts` 檔頭）。它**不是第十個註冊點**：九個註冊點回答「這個 agent 由什麼組成」、會折進 `createDeepAgent` 的參數，這條回答「這些東西怎麼收掉」、什麼都不折。`loadPlugins()` 因此多回一個 `dispose()`，組裝點的 `createNexusAgent()` 跟著回 `{ agent, dispose }`。引進它的是 MCP：MCP server 是外部程序，stdio 子行程的 pipe 是活的 handle，沒人關的話 CLI 印完答案不會退出（實測：拿掉 `dispose()` 之後 `pnpm --filter @nexus/harness run cli --plugins src/cli-mcp.fixture.ts` 停在那裡不動）。**回滾與關機是兩條路**：`apply` 中途拋錯時的資源釋放由 plugin 自己的 `try` / `catch` 負責——dsh 的 `ctx.effect` 一個函式兼兩職，那靠的是 Cordis 的 context 樹，我們沒有。**載入失敗時仍然收**：靠前的 plugin 已經開好的東西由 `loadPlugins()` 在拋出之前收掉，因為失敗的呼叫端拿到的是 exception、不是 handle（註冊內容則刻意留著，診斷要有東西可看）。
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
| 反思與反饋層 | 結果校驗 middleware + LangSmith 回饋 | **自建** | **薄覆蓋**，強化見 issue #16 —— **但 #16 原本列的兩個方向已經作廢**，見下面那段 |
| 輸出層 | typed streaming（基座 v3 `streamEvents`）→ apps/web UI | deepagentsjs 內建；**協定用基座的 `@langchain/protocol`**，pump／handler／client 與 UI 自建 | **串流的形狀完整，但基座自己標為 experimental；瀏覽器到 agent 之間的線已接好（上行 HTTP、下行單向 SSE，第 7 節決策 6），UI 待做** —— 見第 5 節 Phase 5 |

**2026-08-30，#16 的兩個強化方向被 dsh 否掉了。** 動工前照 AGENTS.md 讀了原始碼
（`cd5ef8148158c3a752a658978873241fdf8e2bbc`）：「Reflection plugin（每步多一次 LLM 呼叫做
自我批判）」與「Intent plugin（顯式意圖分類）」在 dsh **全樹都不存在** —— `reflection` 的
命中全是 TypeScript 型別反射，`intent classif` 零命中。它對「先想再做」的答案是
**計劃模式 ＋ todo ＋ goal**：讓模型自己承擔規劃、把狀態外顯、人可以介入。

這一條不能靠「標註偏離」繞過去：AGENTS.md 的偏離條款只涵蓋「基礎建設表達不出來」，
而 per-step 自我批判用一個 middleware 就寫得出來 —— 那是**設計上的分歧**，不是表達力落差。

`TodoListMiddleware` 已經蓋掉 todo 那塊。計劃模式那塊補在
[#116](https://github.com/DemianLi/nexus-agent/issues/116)（`packages/nexus-plugin-plan-mode`），
**它自己帶著一筆標註過的偏離**：模式狀態走 middleware 的 `stateSchema` ＋ checkpointer，
不走 dsh 的 `plan/mode` 會話事件 ＋ 純折疊 —— plugin 拿不到 `SessionLog`，而
`SessionEventType` 是封閉 union（#101 已明文把「加會話事件種類」排除在包自有不變量之外）。

（誠實的一句：`.agents/notes/rejected/` 底下**沒有**明文拒絕過自我批判的 note，
所以能主張的是「它不存在、它做了別的」，不是「dsh 拒絕過」。）

**2026-08-30 續：#116 留下的「誰關得掉計劃模式」，答案也在 dsh 原始碼裡。**
`packages/plan/plan-mode/src/index.ts:5` 的檔頭明寫 `/plan off` 讓使用者直接離開，同檔
`:294` 用 `ctx.inject(['commands'], …)` 把命令掛成可選子節點。命令註冊面因此補在
[#118](https://github.com/DemianLi/nexus-agent/issues/118)（`packages/nexus-plugin-commands`
＋ `registry.commands`，第十三個註冊點）。

**#118 沒有偏離要標，而這件事本身值得記著。** #116 退到 `stateSchema` 的原因是
**plugin** 拿不到 `SessionLog`；命令的產生者是**進入點**（`runRepl` 手上就有那份日誌），
所以 `command/run` / `command/done` 走的就是 dsh 的形狀。`SessionEventType` 的門檻
（「兩條路都產得出來嗎」）在這裡答得乾淨：命令事件根本不是模型串流事件，當初排除訊息
內容的顆粒度問題沒有指涉對象。

順帶正名一件 #116 的事：dsh 離開計劃模式的兩條路（`/plan off`、`exit_plan_mode` 的人工
評審）**都需要人**。所以「headless 下模式鎖死」是規格不是缺陷。

harness 五大範圍對應：解析標準化（PluginRegistry + zod）、編排迴圈（deepagents）、記憶層（內建，但只注入不保存——見第 5 節 Phase 3）、工具層（內建）、結果校驗（自建 plugin——deepagents 無現成方案，為驗證插件架構價值的第一個實戰 plugin）。

## 3. 套件結構（pnpm workspace）

```
packages/nexus-core      契約：NexusPlugin 型別、zod manifest、PluginRegistry 九個註冊點 ＋ lifecycle 通道、fold
packages/nexus-plugin-*  plugin 系列，只相依 @nexus/core
packages/nexus-wire      web 與 agent 之間那條線的協定：封包型別、SSE codec、route 與 channel 白名單、瀏覽器端 client
apps/harness             組裝點：agent 工廠、訊息標準化、CLI、下行 pump 與 fetch handler；唯一呼叫 createDeepAgent 的地方
apps/web                 輸出層：對話 + 事件流 + HITL 核准 UI（線與 UI 都已接好，見第 7 節決策 6）
```

`pnpm-workspace.yaml` 的 glob 為 `apps/*` 與 `packages/*`。

**`packages/nexus-wire` 存在的唯一理由是它有兩個消費者**：Node 那端的 pump 與 handler 在 `apps/harness`，瀏覽器那端在 `apps/web`，而 SSE 的編解碼、route 常數與 channel 白名單兩邊必須是同一份。這也照 dsh —— 它把 SSE 的 frame 解碼放在**共用**的 `AbstractApiClient` 而不是各載體各寫一份。它只 `import type` 基座的 `@langchain/protocol`，沒有任何執行期相依，所以 `apps/web` 不會因此把 Node 那半邊拖進瀏覽器（`deepagents` 的 `./browser` 進入點少掉 16 個 Node 專屬匯出，而我們的 `ContainedFilesystemBackend` 繼承的正是其中的 `FilesystemBackend`）。

**`packages/nexus-core` 在 Phase 1 就拆出**（[#30](https://github.com/DemianLi/nexus-agent/issues/30)），不等 Phase 2。切線是**誰呼叫 `createDeepAgent`**：core 是純轉換層，只產出參數；harness 發出唯一那次呼叫。core 相依 deepagents 的型別是必然的（`subagents.register` 收 `SubAgent`、`backend.mount` 收 backend），「core 不碰 deepagents」不是可行的切線。

**組裝點自有的那些（default backend、工具呈現順序清單、model、checkpointer / store、核准政策的 session 開關，加一份基座工具名單）作為 fold 的輸入參數傳進 core**：所有權留在 harness，檢查（rest entry 恰好一個、宣告 interrupt 卻沒有 checkpointer、以工具名為 key 的設定沒有指向不存在的工具）跑在 core。plugin 仍然不得提供它們。

那份**基座工具名單**（`baseToolNames`）照 dsh 的 `ToolProviderResult.knownNames`：「這一次可見的工具」與「設定驗證用的名字宇宙」是兩件事，宇宙由提供者貢獻。基座自己帶進來、不經過我們 registry 的工具（`write_file` / `delete` / `execute` / `task` 那些）只有組裝點知道，而它們恰好是最該被核准、也最該排進呈現順序的那幾個——沒有這份名單，`toolOrder: ['write_file', ...]` 會被誤判成「沒人註冊」。（**核准曾經是這份宇宙的第二個消費者**，[#111](https://github.com/DemianLi/nexus-agent/issues/111) 把閘門搬到 `wrapToolCall` 之後那一條走了 —— 名字是執行當下拿到的，沒有東西要對齊。）

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
| 模型 | **`openai/gpt-oss-120b`**，經 `@langchain/openai` 指向 NVIDIA 的 OpenAI 相容端點（2026-08-28 定案）。**原本寫的是預設 Anthropic、唯一備選 DeepSeek，兩者都沒有留下來** | **三輪獨立測量**（四條難題 × 2 次 → 兩條難題 × 6 次 → 四條難題 × 6 次）都是同一個結果：品質五階打平（四條難題上 `0.92`–`0.96`，判準沒飽和），所以選型落回成本 —— 這一個 token 最省（少四到五成）、多叫最低、品質並列第二。（第三輪一度量到它「跑不完難題」，**那個判斷已更正撤回** —— 是端點限流加上基座不重試，接住之後重跑 42 次零失敗、難題全部滿分。詳見第 5 節 Phase 5。）**Anthropic 那條路從頭到尾沒有被建起來**（`@langchain/anthropic` 不在任何 `package.json` 裡），所以它不是被比下去的，是**從來沒有進過場**；要重新排入評估得先補那段接線。見第 5 節 Phase 5 與 [#31](https://github.com/DemianLi/nexus-agent/issues/31) |
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
- `feat/harness-live-provider`：接上真實供應商，並依 [`docs/standards.md`](../docs/standards.md) 建立 `.env.example`（Phase 0 的必要 key 只有一把）。**接線對象是 NVIDIA 的 OpenAI 相容端點**（`https://integrate.api.nvidia.com/v1`）上的 `deepseek-ai/deepseek-v4-pro-0813`（**原本是 `deepseek-v4-flash-0731`，它不回應，2026-08-28 換成同系列的 pro —— 見 [#57](https://github.com/DemianLi/nexus-agent/issues/57)；端點沒修好，是我們換了 id**），用 `@langchain/openai` 指過去 —— JS 這邊沒有 NVIDIA 專用的 LangChain 整合（`@langchain/nvidia-ai-endpoints` 只有 Python 版）。**預設供應商的決策不動**：第 0 節決策表、第 4 節選型表與第 7 節決策點 2 仍然是 Anthropic —— Phase 0 只驗接線不比較，接線對象因此不必是預設。（**這句是 Phase 0 當時的狀態，2026-08-28 已經不成立**：那三處現在都是 `openai/gpt-oss-120b`，見第 7 節決策 2。留著不改是因為它記的是當時為什麼可以不動，而那個理由本身沒有錯。）接線用的模型雖然是 DeepSeek，但**這證明不了 Phase 2 的「DeepSeek 相容性」**：那條驗的是同一份 plugin 清單在 middleware stack 下跑得通，而 Phase 0 還沒有任何 middleware。
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
    → **這一段裡跟核准有關的四條在 2026-08-30 全部作廢**（[#111](https://github.com/DemianLi/nexus-agent/issues/111)，(a)① ／ (b) 兩個都要 ／ (c) 拿掉）。`interrupts.require` 這份宣告式清單換成 `approvals.gate(listener)` 的 pre-execute waterfall 之後：**逐欄位 OR** 被 waterfall 的「第一個回非 allow 的人說了算」取代；**缺 checkpointer 即報錯**改成執行期的確定性拒絕（headless 下 agent 跑得起來，這是整件事的動機）；**核准標記指向不存在的工具即報錯**沒有主體可檢了 —— 名字是執行當下拿到的，那個 bug class 不存在。留著這一段是因為它記的是當時真的交付了什麼。
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

- **`feat/summarization-tuning` 的動工前一驗（第十二次）：上面那四點與「跨 Phase 的坑」**已經**在 [#70](https://github.com/DemianLi/nexus-agent/pull/70) 落地了**（`test: 釘住摘要層的設定入口與兩個歷史寫入者的靜默失敗`）—— 同名取代的絆索、subagent 邊界、offload fail-open 的兩條、eviction 那個第二寫入者的兩條，全在 `summarization.test.ts` 裡。**這張因此不是一張 feat，是三件收尾**：

  1. **`permissions` 那個洞只有散文，沒有行為證據** —— 而它是最該有證據的那一種：一條寫對的規則看起來在保護一個它碰不到的東西。實測的四格對照：同一條 `deny(['/conversation_history*', '/conversation_history/**'])`，**經工具**（`write_file` 寫 `/conversation_history/x.md`）換來 `Error: permission denied for write`、磁碟零檔案；**經 backend 方法**（summarization 的 offload）`session_*.md` **照樣寫進去**。同一條規則、同一個路徑、兩個呼叫者、相反的結果。→ 這條測試補進去，並把 `permissions.test.ts` 檔頭那句「無規則命中即 allow」補上更大的那一半：**backend 方法根本不經過規則表**。

  2. **`read-only` ✕ 長對話的三選一，決定是「(c) 為預設 ＋ (b) 為逃生口」。** (a)「組裝期擋下這個組合」**在結構上不可行**：summarization 是被無條件加進 stack 的，所以「read-only ＋ summarization」就是**每一個** read-only 組裝，擋掉它等於禁用 read-only 這個 mode 本身 —— 連根本不會觸發摘要的短對話也一起禁掉。所以預設是 (c)：**`read-only` 就是不留歷史**，寫進 `ContainedFilesystemBackend` 的文件。

  3. **而 (b) 這條逃生口是真的存在的，實測過**：`createSummarizationMiddleware` 的 `backend` **是獨立的一格**，不必是 agent 的那個。預設 backend 用 `read-only`、摘要器指向另一個 `workspace-write` 的 backend，實測唯讀根一個檔案都沒多、歷史落在另一個根裡、四輪對話全部正常回話。→ 這是 `historyPathPrefix` 那條路之外更直接的一條，而且它連 `backend.mount()` 都不需要。**代價要寫清楚**：走這條就得自己建摘要器，也就等於接管 `trigger` / `keep` 的預設值。

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
  - **校驗器自己炸掉同樣致命，而外圍內驗剛好接得住。** `wrapToolCall` body 裡的 bug 一樣讓整場 reject。把圍堵註冊在最外、校驗器在最內，實測順序 `containment-in → validator-in → containment-caught`，整場沒拋。dsh 對這件事的答案是 fail-closed：渲染器／投影器自己失敗也「转为 JSON 安全的 `isError`」，不是靜默放行。（當時圍堵是用 `prepend: true` 掛在這個 plugin 上的。**[#159](https://github.com/DemianLi/nexus-agent/issues/159) 之後它歸 `@nexus/core`**，由 fold 打底在整份陣列的第 0 格——這個排法因此被保住而且放大了：連 `prepend` 的 registry middleware 都在它裡面，而且不再取決於清單有沒有掛這個 plugin。）
  - **`Command` 是一行字就能造出來的靜默旁路。** 工具回 `Command` 時 `wrapToolCall` 收到的就是 `Command`，`ToolMessage.isInstance` 為 false（實測），ToolMessage 在 `update.messages` 裡。`if (!ToolMessage.isInstance(r)) return r;` 會讓所有 Command 工具整個跳過校驗，而所有回字串的測試都照過。基座自己的 `FilesystemMiddleware.wrapToolCall` 兩個分支都處理，照抄它。
  - **兩條偏離**（[AGENTS.md](../AGENTS.md) 要求標註）：①dsh 的 `defineTool` 要求每個工具**強制**宣告 `output`、註冊表在註冊時驗，但 LangChain 的 `StructuredTool` 沒有輸出 schema 這個欄位（`ToolParams` 只有 `responseFormat`），表達不出來 → 退到 plugin 這一層逐工具選加，沒宣告的明文放行。②dsh 在渲染成 content **之前**驗 canonical value，基座的 `ToolNode` 先 `JSON.stringify` 再交出來（`:244-248`），值救不回來 → 退到對 content 字串 `JSON.parse` 再驗，宣告了 schema 卻不是合法 JSON 本身即失敗。
  - **排序缺口，記著不補。** `MiddlewareRegistrationPoint` 只有 `prepend` 一根槓桿，給的是「最外」；「最內」現在只是「沒 prepend 而且剛好註冊在最後」，沒有任何 plugin 有義務尊重它。這一版釘住現況，加槓桿留給真的有第二個 plugin 要搶位置的時候。
- 驗收：**破壞性操作必須人工核准才執行**（已有可執行證據，見上）；~~LangSmith 能看到完整 trace~~ **→ tracing 開沒開、送去哪、送出去的東西脫敏到什麼程度，這三件事說得出來**（已有可執行證據，見上——原句驗過之後發現它問錯方向了）；~~校驗失敗的工具結果會帶錯誤回饋給 agent 重試~~ **→ 工具失敗（拋錯或輸出不合宣告的 schema）都變成帶更正回饋的 error ToolMessage，而且那一輪不會因此中止**（已有可執行證據，見上——原句預設了「回饋」是要加的東西，實測它本來就在，被我們自己踩掉了）。

### Phase 5 — Web UI + 評測（約 3–4 個 PR）

**動工前先驗過一輪**（`deepagents@1.13.1`、`langchain@1.5.10`、`@langchain/core@1.2.9`、`langsmith@0.9.0`，以下每一條都是實測，探針跑完即棄）。

- ~~`feat/web-chat-stream`：apps/web 對話介面 + typed event stream 呈現（含 subagent 事件）。~~ **這一句的三個部分壞的方向各不相同。**
  - **「typed event stream」是基座內建的，而且入口是 v3 不是 v2。** `DeepAgent.streamEvents(state, { version: "v3" })` 回一個 `DeepAgentRunStream`。**實際跑過的投影**：`messages`（逐則訊息的 token 串流）、`toolCalls`（`.input` / `.output` / `.status`）、`subagents`、`values`、`output`、`interrupts`、`interrupted`、`subgraphs`（吐 agent 自己的內部節點，`path` 形如 `["model_request:<uuid>"]` / `["tools:<uuid>"]`）、`extensions`（沒註冊 transformer 時是 `{}`）。**JSDoc 列了 `middleware`，但 1.13.1 的 run 物件上沒有這個東西**（實測 `typeof run.middleware === "undefined"`）；反過來，實際有而 JSDoc 沒列的是 `lifecycle`（`{ namespace, timestamp, event, graph_name }`，一次跑吐 8 筆）與 `messagesFrom`。**要用哪個投影，以 run 物件上真的有的為準，不要照 JSDoc 抄。**基座自己的 JSDoc 寫著：預設那條 legacy stream「should not be used for new user-facing agent streaming」，而 v3「will become the default in a future major release」。Phase 4 記下的「v2 沒有被標成 deprecated」是真的，但它會誤導 —— 沒被標 deprecated 不等於該拿它做面向使用者的串流。**同一段 JSDoc 也寫著 v3「experimental and its API may change in future releases」**，那句話與第 4 節把 `deepagents` 釘在 `~1.13.1`（放行 patch）撞在一起，見第 7 節決策 1。
  - **`streamTransformers` 是第十個擴充點。** `CreateDeepAgentParams.streamTransformers` 原樣轉交 `createAgent`，產物落在 `run.extensions`。第 1 節寫的是「九個註冊點在 Phase 1 一次到齊」，而 1.13.1 的參數表上是十個。**`streamTransformers` 是哪個版本加進來的沒查**，所以「Phase 1 當時漏了」或「是後來才有的」兩種都還開著 —— 缺口本身跟這個無關，反正現在少一個。**這次不補**，照 [#70](https://github.com/DemianLi/nexus-agent/pull/70)–[#73](https://github.com/DemianLi/nexus-agent/pull/73) 的先例：釘住邊界，不順手加擴充點。
  - **「含 subagent 事件」不用自建 —— 這句在 in-process 那條路上對，在線上只對一半。** root 呼叫 `task` 派給名為 `writer` 的 subagent，`run.subagents` 吐出 `{ name: "writer", cause: { type: "toolCall", tool_call_id: "call_0" }, messages }`，subagent 自己那幾輪的訊息串流是分開的一條。**對照組**（一個 subagent 都沒註冊）吐零筆而且 iterator 正常收掉 —— 少了這一組，「`run.subagents` 其實是把 root 自己的內部節點也吐出來」也會過。
    → **動工前一驗（第九次）：那個投影不在線上，而且它連 namespace 都沒有。** 實測 `run.subagents` 吐的物件只有 `name` / `cause` / `output` / `messages` / `toolCalls` / `subagents` 六個鍵 —— **沒有 `path`**。`name` 與 `cause` 是投影層算出來的，協定 frame 上一個字都沒有：subagent 的訊息在線上長成 `namespace: ["tools:<uuid>", "model_request:<uuid>"]`，那個 `tools` 是節點名不是 subagent 名。所以**線上這一端必須自己 join**：巢狀 frame 的 `namespace[0]` ↔ 帶著同一個 namespace 的 `tools` frame ↔ 它的 `tool_call_id` 與 `input.subagent_type`。
    → **這個 join 是可靠的，而且平行 subagent 也分得開。** 一輪裡派兩個 `task` 出去，實測**每個呼叫拿到自己的 `tools:<uuid>`**（`tools:87e1…` 與 `tools:3dc7…`），兩條訊息串流逐字交錯但前綴不同，`run.subagents` 那側對應的 `cause.tool_call_id` 分別是 `call_1_0` 與 `call_1_1`。→ 折疊器（`packages/nexus-wire` 的 `conversation.ts`）做這個 join，**兩個口子明著定死而不是猜**：訂閱沒帶 `tools` channel 時，巢狀訊息標成「未歸屬」而不是掛到隨便一個 subagent 上；重連之後 `tools` frame 已經過去了（沒有重播、沒有歷史重抓，見決策 6），同樣標成未歸屬。**寧可說不知道，不要說錯。**
  - **`ScriptedChatModel` 在 v3 這條路上是瞎的，而且是靜默的。** 同一份腳本：`invoke` 與 v2 `streamEvents` 都跑到工具；**v3 只跑一輪模型就結束，工具從沒被呼叫，`run.toolCalls` 是空的，而且沒有任何東西拋錯**。原因是兩段接不上 —— v3 掛的 callback handler 讓 `_generateUncached` 走 `_streamChatModelEvents` 那一支（`@langchain/core@1.2.9`，`chat_models.js:231`），而它的預設實作是 `convertChunksToEvents(this._streamResponseChunks(...))`，那個轉換器**只讀 `msg.tool_call_chunks`、從不讀 `msg.tool_calls`**（`compat.js:174`），我們的假模型偏偏把工具呼叫掛在後者。第二個坑緊接著：`tool_call_chunk` 的 `index` 與文字 content block 共用同一個編號空間，`index: 0` 會撞上那段文字的 block 並把它寫壞（實測 `index: i` 不通、`index: i + 1` 通）。
    → **已修**（[#75](https://github.com/DemianLi/nexus-agent/pull/75)）：`_streamResponseChunks` 改吐 `tool_call_chunks`、`index` 從 1 起跳，配一組雙路徑對照測試（`stream-parity.test.ts`）。反向驗過兩次：退回 `tool_calls` 六條全紅；`index` 退成 0 四條紅，而且單一呼叫時工具**完全沒跑**（比原本記的「文字被寫壞」更嚴重），兩個呼叫時只有 `index: 1` 的那筆活下來。在它修好之前，任何走 v3 的 Phase 5 測試都是綠的而且什麼都沒驗到。這也是 [#32](https://github.com/DemianLi/nexus-agent/issues/32) 那份「假模型與基座真實行為悄悄分歧」清單上第一個真的被抓到的分歧 —— 而它是被 CI 抓不到的那種：分歧發生時測試不會紅，會靜靜地少驗一半。
  - **`apps/web` 與 agent 之間沒有線，而計劃從沒記過要選哪一條。** 現有骨架是純 Vite + React：沒有 server、沒有相依 `@nexus/harness`、沒有任何 HTTP / SSE / WebSocket。agent 跑在 Node（backend、MCP 的 stdio 子行程、QuickJS 的組裝都在 Node 這側），所以中間一定要有一段傳輸 —— 那是一個決策點，「現有骨架續用」把它藏起來了。**`deepagents` 確實有 `./browser` 進入點，但那不是「整包搬進瀏覽器」的許可**：機械比對兩份 `.d.ts` 的匯出，browser 少掉的正好是 16 個 Node 專屬的名字（`FilesystemBackend`、`LocalShellBackend`、`Settings` / `findProjectRoot` / `listSkills` / `parseSkillMetadata`、`createAgentMemoryMiddleware`、`createSubAgent` 等），而我們的 `ContainedFilesystemBackend` 正是繼承 `FilesystemBackend` 的那一個。
    → **已拍板並實作，見第 7 節決策 6**：上行 HTTP POST、下行單向事件串流（先做 SSE）。這一項因此是**兩張 PR** —— `feat/web-transport`（server 端的 pump ＋ 兩個方向的線，不含 UI）與 `feat/web-chat-stream`（UI）。**動工前一驗又推翻了依據的一半**：這條線不必自己發明，`@langchain/protocol`（`@langchain/langgraph` 的直接相依，早就在 `node_modules` 裡）已經把封包、channel 名、SSE 的 route 與 HITL 的兩個 method 都規格化了，而 v3 的 run 物件**本身就是 `AsyncIterable<ProtocolEvent>`**，吐出來的 frame 全部可 JSON 序列化。詳見決策 6。**已落地的與明著沒做的**：`packages/nexus-wire`（協定型別、SSE codec、route 與 channel 白名單、瀏覽器端 client）、`@nexus/harness` 的 `ThreadPump` ＋ 不綁 port 的 handler ＋ `node:http` 載體、`apps/web` 的連線接點；**沒有任何可執行的進入點**（沒有 `serve` script、CLI 也沒接），所以 `feat/web-chat-stream` 的第一件事就是補它——那需要決定跑哪份 plugin 清單、哪個模型、哪個 port，屬於 UI 那張的組裝決定。
- `feat/web-hitl`：核准 UI（對應 interrupt）。**混合批次要當成全有全無**：基座在一批裡只要有一筆被拒，被核准的那幾筆會靜靜地不執行、還會從歷史裡消失（見 Phase 4 那條），所以逐筆按的介面會生出一種「按了核准卻等同從沒問過」的狀態，而那件事在畫面上看不出來。**動工前一驗（第十次）**：原本記的三條，一條在 [#77](https://github.com/DemianLi/nexus-agent/pull/77) 之後**結構上到不了了**，兩條成立但不完整；另外量到三件原本沒問的事。
  - → **「混合批次當成全有全無」的理由在 2026-08-30 消失了**（[#111](https://github.com/DemianLi/nexus-agent/issues/111) ／ [#112](https://github.com/DemianLi/nexus-agent/pull/112)）：閘門改成逐次呼叫判之後，一批裡一個被拒不再抹掉其他筆（`apps/harness/src/interrupt.test.ts` 的「一個被拒不再拖累另一個」）。介面現在仍然一批送一個決定（`uniformDecisions`），但那從此是「還沒做」而不是「不能做」。留著上面那段是因為它記的是當時真的量到什麼。
  - **核准 UI 要顯示的東西，基座已經整理好了 —— 但 `reviewConfigs` 是逐筆的。** `run.interrupts` 吐 `{ interruptId, payload: { actionRequests: [{ name, args, description }], reviewConfigs: [{ actionName, allowedDecisions }] } }`，`allowedDecisions` 就是第 1 節那套封閉詞彙，讀 payload 就是。**補量到的是它的基數**：`reviewConfigs` 與 `actionRequests` 是平行陣列，**逐筆詞彙真的分得開**（實測同一顆中斷上 `alpha: ["approve","reject"]`、`beta: ["approve"]` 各自出現在自己那一筆）。全有全無的介面因此要取**逐筆交集**——不是 `[0]`、也不是聯集：`processDecision` 對不在那一筆清單裡的決定是 `throw`（`hitl.js:407`），多出來的那顆「拒絕」按鈕按下去是整場 run 死。經由**我們的** fold 這種分歧到不了（`packages/nexus-core/src/fold.ts` 對每個 gated tool 固定發 `["approve","reject"]`），所以在折疊器那一層它是**要斷言的不變量**，不是可以依賴的前提。
  - ~~**暫停時 `await run.output` 會炸，而且炸得沒有意義**~~ **→ 這個陷阱在 [#77](https://github.com/DemianLi/nexus-agent/pull/77) 之後結構上到不了了。** 原文把它記在「核准 UI 那一端」，但線接起來之後核准 UI 在線的**另一側**，一個 run 物件都看不到；pump 抽的是 raw iteration，中斷時乾淨結束，從頭到尾不碰 `run.output`。**不是當初量錯，是被 pump 的設計吸收掉了**——絆索留在 pump 那側（決策 6 第 4 條），這一端不必再防。
  - **接得回去，而且不必換路。** `streamEvents(new Command({ resume: { decisions: [{ type: "approve" }] } }), { version: "v3" })` 實測跑得通：工具真的執行、ToolMessage 的 `status` 是 `success`。所以一場對話從頭到尾只有一條呼叫路徑，不會變成「串流用 `streamEvents`、核准用 `invoke`」。**線上補量到的**：resume 那個 run 會發 `lifecycle running / root`，被核准的那筆真的跑出 `tools tool-started` / `tool-finished`。
  - **`decisions` 是位置對應的，長度不符會殺掉整場 run。** 基座逐 index 把 decision 配到被中斷的那幾筆工具呼叫上，`decisions.length !== interruptToolCalls.length` 當場拋。線上實測是 `lifecycle failed / root`，`error` 就是那句話 —— 瀏覽器看得到死因，但那一輪已經死了。→ 全有全無送出時要送 `actions.length` 筆同型決定；上行這一側順手擋下來，一個客戶端的 bug 不該換來一條死掉的 thread。
  - **只拒絕、或混合批次，下行一顆 frame 都沒有。** 中斷發生在 `afterModel`，tools node 從沒跑；那則人造的 error ToolMessage 走 `updates`（白名單外）。實測「全拒絕」與「一核准一拒絕」在下行上**一模一樣**：只有模型再講一輪話，`tools` frame 零顆，工具一次都沒跑。→ 兩件事：①混合批次那個「被核准的靜靜消失」在線上**連痕跡都查不到**，比 in-process 那條更強，全有全無因此不是偏好、是必要；②**人按了什麼只有本地記得** —— 下行不回聲決定，所以它要像 `appendHumanTurn` 那樣在送出的那一刻自己寫進 transcript，那不是裝飾，是唯一的紀錄。
  - **等核准時再送一句話，中斷被靜靜丟掉。** 實測對停在核准點的 thread 送 `run.start`：新的一輪照跑（`patchToolCallsMiddleware.before_agent` 補掉懸空的工具呼叫），那個工具**既沒執行也沒被拒絕**，而且**不會再發第二顆 `input.requested`** —— 核准請求就這樣蒸發了。而 [#78](https://github.com/DemianLi/nexus-agent/pull/78) 的 UI 正好到得了這個狀態（`busy` 只看 `running`）。→ UI 那側禁用送出，上行這側明著回錯而不是靜靜照做（同 `since` 那條的理由：靜靜忽略會生出看不見的斷檔）。
  - **驗收句有一個沒寫出來的交付項。** Phase 5 的驗收是「瀏覽器完成提問 → 看事件流 → **核准工具** → 收結果」，而預設 plugin 清單不觸發任何中斷 —— 沒有一份帶 `interruptOn` 的清單，那半句在瀏覽器裡跑不出來。所以這張 PR 要交一份進版控的 fixture 清單模組，README 把那道 `--plugins` 指令寫死。
- `feat/eval-suite`：LangSmith evaluators 跑基準任務 —— 補強項 3。模型供應商的品質與成本比較掛在這裡（[#31](https://github.com/DemianLi/nexus-agent/issues/31)）：同一組基準任務跑 Anthropic 與 DeepSeek，比工具呼叫成功率、參數正確性、token 成本。**「CI 沒憑證所以驗不了」第二次是錯的**（第一次是 [#72](https://github.com/DemianLi/nexus-agent/pull/72) 的 tracing），但這次的界線比較細：
  - `langsmith/vitest` 的 `ls.describe` / `ls.test` **完全不連外、也不要 key**（實測跑得過，評分函式的本體真的執行）。evaluator 的邏輯與資料集的形狀因此進得了 CI。**原文把不連外的原因記在 `LANGSMITH_TEST_TRACKING=false` 上，那是記錯了對象** —— 見下面第十一次。
  - `langsmith/evaluation` 的 `evaluate()` 則**一定連外**：對著 loopback 假端點實測，任何 evaluator 跑起來之前它就已經發了 `POST /sessions`、`GET /datasets/<id>`、`GET /sessions`。`data` 收得下記憶體裡的 `Example[]`（資料集不必是託管的），但那個 experiment 必須是。
  - → 照 Phase 0 的切法分兩段：**evaluator 與資料集形狀進 CI，零憑證**；**`evaluate()` 的編排與 #31 的供應商數字是一次性人工驗證**，記進 PR 內文的「驗證方式」。
  - **動工前一驗（第十一次）：CI 那半的護欄記錯了對象，live 那半的前提整個不存在。**
    → **不連外的原因不是 `LANGSMITH_TEST_TRACKING=false`，是 `LANGSMITH_TRACING` 沒設。** 對 loopback 假端點四組對照（`langsmith@0.9.0`、`vitest@3.2.7`）：不設 `LANGSMITH_TRACING` 時**零連外**，帶不帶那支旗標、帶不帶 `langsmith/vitest/reporter` 都一樣；`LANGSMITH_TRACING=true` 而**不**設旗標則發出 `POST /sessions` 與 `GET /datasets?limit=1&name=<suite>`，而且**整個測試檔失敗、測試被 skip**（`Must provide either datasetName or datasetId` —— 開了 tracking 的 `ls.test` 要一份託管資料集）；`LANGSMITH_TRACING=true` ＋ 旗標則零連外且通過。所以今天 CI 乾淨是因為 **CI 不設 `LANGSMITH_TRACING`**，那支旗標是 tracing 打開之後才開始承重的護欄 —— 而 [#72](https://github.com/DemianLi/nexus-agent/pull/72) 的披露正是在教開發者把 tracing 打開。→ 旗標由套件**自己在模組頂層設**（實測是延遲讀取的，不必搶在 import 之前），不靠環境。
    → **絆索要斷言「跑了幾條」，不是「沒連外」。** 上面那個壞掉的情境，症狀是 **skip** —— 被 skip 的測試同樣不發請求，所以一條只看 loopback 請求數的測試，在它要防的那個情境下照樣全綠。這與 [#79](https://github.com/DemianLi/nexus-agent/pull/79) 那個 `status === 'idle'` 停止條件是同一型的假綠。判準因此是**執行計數**，並在環境裡把 `LANGSMITH_TRACING=true` arm 起來跑最壞情況；零請求只當附帶斷言。
    → **供應商比較的前提沒有一條成立，這一半封鎖。** ①**沒有 Anthropic 這條路**：`@langchain/anthropic` 不在任何 `package.json` 裡，`.env.example` 只有 `NVIDIA_API_KEY`，`live-model.ts` 只有一個寫死的供應商 —— 「跑兩家」缺的那一家是一段從沒被記過的工作。②[#61](https://github.com/DemianLi/nexus-agent/issues/61) 開著且標 `ready-for-human`：DeepSeek 官方端點的帳號與 key 是人工步驟，agent 做不了，`@langchain/deepseek` 也還沒裝。③**更前面的那一條**：#31 定的是三段收斂，而 Phase 2 那道「不相容則 DeepSeek 當場出局」的二元閘門**從沒跑過** —— Phase 5 的比較預設它過了關，那個前提不是延後，是不存在。
    → **[#57](https://github.com/DemianLi/nexus-agent/issues/57) 今天複驗仍然重現，但它的選項表已經過期。** 2026-08-27 對同一個端點實測：`deepseek-ai/deepseek-v4-flash-0731` 60 秒零回應（同 #57）；#57 記的替代品 `meta/llama-3.1-8b-instruct` **已經從端點上消失**（`410 Gone`，0.2 秒，`/models` 清單也沒有它了，模型總數 95 → 84），所以選項 2 照原文寫的做不了；但清單上**多出一個同系列的 `deepseek-ai/deepseek-v4-pro-0813`**（#57 當時明寫「沒有可以原地替換的同系列選項」），實測 `200`、37 秒回得出東西。→ 當時判給 #57 決定。**2026-08-28 決定換**：`LIVE_MODEL_ID` 已改成 `deepseek-ai/deepseek-v4-pro-0813`，換之前補驗了帶 `tools` 的那一關（`finish_reason: tool_calls`、參數是合法 JSON —— 光看 200 不算，這條路整條的用途就是工具呼叫）。
    → **所以這張 PR 不寫 `evaluate()` 的編排。** 它一定連外、而且沒有可跑的供應商，寫了就是一段從沒被執行過的程式碼；而 `evaluate()` 連外那條實測來自 [#72](https://github.com/DemianLi/nexus-agent/pull/72) 那次，這張沒有複驗，省掉這段就不必複驗。CI 那半的載體因此是 `ls.test` 而不是 `evaluate()`：資料集、評分器、runner 都真的跑，只有模型是 `ScriptedChatModel`。**評分器寫成對「跑完的結果」的純函式**，不寫成 LangSmith 的 evaluator 簽章 —— 反過來寫的話 CI 這半要呼叫它就得先偽造 `Run` / `Example`，而那正是資料集形狀會靜靜漂走的地方。
    → **實作時又量到一件：連外的寄件人有兩個，開關也是兩個。** 把最壞情況 arm 起來
（loopback 端點 ＋ `LANGSMITH_TRACING=true`）跑這套 eval，`ls.test` 那個寄件人閉著嘴，
但 loopback 照樣收到 `GET /info` 與（批次過的）`POST /runs/multipart` —— 那是**真的 agent run**
自己的 `LangChainTracer`（[#72](https://github.com/DemianLi/nexus-agent/pull/72) 記的「tracing 被動生效」），
與 `LANGSMITH_TEST_TRACKING` 毫無關係。→ 這也是 **CI 不得設 `LANGSMITH_TRACING`** 的實質理由：
eval 跑的是真的 agent，基準任務的題目與工具參數會跟著 trace 一起出境。斷言因此分成兩條，
一條要求零、一條要求非零。
    → **token 成本這一項在 CI 原本沒有路。** `ScriptedChatModel` 完全不吐 `usage_metadata`（grep 零筆），所以成本評分器會是三個指標裡唯一沒有對照組的那個。→ 假模型補上逐輪的 `usage_metadata`，並把「基座把它原封帶到最終狀態」釘成絆索。
  - **決策（2026-08-28）：比較的形狀換掉了，這一半因此不再是封鎖，是還沒跑。** 不比兩家供應商，改成**同一個 NVIDIA 端點上的三個尺寸級距**：9B 以下、26–35B、100B 以上。三個都走同一個 `@langchain/openai`、同一把已經在用的 `NVIDIA_API_KEY` —— 不必開帳號、不必接第二家，上一條那三個「前提不成立」因此全部繞開，而不是被解決。剩下的是小工作：`createLiveModel()` 參數化成收得下三個 id（現在是一個常數）、`runBenchmarkCase` 跑三遍（model 在 [#80](https://github.com/DemianLi/nexus-agent/pull/80) 已經是參數）、數字記進 PR 內文的「驗證方式」。**「封鎖」與「還沒跑」在這份文件裡不能混** —— 前者是驗收判定不了，後者只是工還沒開，而 [#31](https://github.com/DemianLi/nexus-agent/issues/31) 的病灶正是這兩句被寫成同一句。
    → **級距的 id 已釘，但盤點推翻了「三個桶子都有候選」這個前提。** 2026-08-28 拿 `GET /models` 的**全部** id 逐一送一個帶 `tools` 的請求（配 90 秒逾時，併發 4）：清單列 **84** 個，這把 key 只叫得動 **29** 個（其餘一律 `404 "Not found for account"` —— **清單是型錄，不是權限**），其中真的回得出 `finish_reason: tool_calls` 的只有 **14** 個。**「9B 以下」那一格是空的**：叫得動又支援工具的最小模型是 `openai/gpt-oss-20b`（總量 20B），所有 8B 以下的候選（`mistral-7b-instruct-v0.3`、`granite-3.0-8b-instruct`、`gemma-3-4b-it`、`zamba2-7b-instruct`）全部 404。→ 三個桶子因此改成**同一個家族的三個橫階**：`nemotron-3-nano-30b-a3b` / `super-120b-a12b` / `ultra-550b-a55b`，它是這把 key 上唯一在三個尺寸都有且都支援工具的家族。**這比原本的寫法更嚴**：原本允許三格各來自不同廠商、不同訓練配方，量到的差異裡有多少是尺寸造成的沒人分得開。**這份清單綁在帳號上** —— 換一把 key，這道階梯可能整個不存在，所以盤點方法寫進了 [`eval/tiers.ts`](../apps/harness/src/eval/tiers.ts) 的檔頭而不是只留一個數字。
    → **三階都是稀疏的，所以參數量要報兩欄。** id 裡的 `-aNb` 是 NVIDIA 自己標的活化參數量（`30b-a3b` = 總量 30B、每 token 活化 3B；`GET /models` 的紀錄只有四個鍵，端點這側查不到規格，所以這是**命名慣例**不是查證過的規格）。一個 120B-a12b 的計算量離 253B 的密集模型很遠，反而更接近 12B —— 混成一欄的話，量到的崩塌點會是「哪一格剛好抽到稀疏模型」的產物。這道階梯的兩欄都單調（總量 30→120→550、活化 3→12→55，各約 4 倍一階），所以兩種讀法下都成立，這正是挑同一家族而不是湊三個廠商的理由。 → **這條規矩在新的階梯上長出一條例外，而例外的處理方式是留白。** `openai/gpt-oss-*` 的 id 沒有 `-aNb` 後綴，端點也給不出規格，所以活化那一欄是 `undefined` 而不是抄一個記來的數字；[`eval/tiers.test.ts`](../apps/harness/src/eval/tiers.test.ts) 把「後綴有就必須填且相符、沒有就必須留白」釘成斷言。直接後果有兩個：**新的那道階梯只在總量那一欄排得出順序**，而且 `nano` 的 3B 仍然是我們量過最小的活化量 —— 下面那句「底板是 30B」因此是**總量那一欄的話**。
    → **小模型叫不出工具是結果，不是失敗。** 這正是「比尺寸」要量的東西：工具呼叫成功率與參數正確性在多小的模型上開始崩，以及那個崩塌換來多少 token 成本上的節省。#80 的評分器刻意把「少叫一次」與「參數寫錯」分成兩個數字，那個區分在這裡才真的派上用場。 → **跑了，而它沒崩。** 27 次執行（3 階 × 3 題 × 3 次取樣）三個指標全部滿分，唯一的雜訊是 super 有一次多叫了一次工具。**分不出高下不是三個模型一樣好，是這道階梯的底板太高** —— 這一家最小的一階是 30B/a3B，而崩塌點在它底下（證據見下一條）。
    → **數字（2026-08-28，`pnpm --filter @nexus/harness eval:compare --samples 3`）**：工具呼叫成功率、參數正確性三階都是 `1.00`；多叫次數 nano `0.00`、super `0.11`（0–1）、ultra `0.00`；總 token 平均 nano `8439`（6026–9866）、super `8424`（5879–12363）、ultra `8002`（5887–9074）。**總參數量差 18 倍，成本差 5%，而且方向是反的** —— 最小的那個最貴。nano 是推理型模型，同一題吐的 output token 比 ultra 多，省下來的參數量沒有變成省下來的錢。
    → **基準任務在 11B 上分得出來 —— 這是它探不到差異的反證。** 同一句 `echo-once` 的提示，盤點時 `meta/llama-3.2-11b-vision-instruct` 叫對了工具但參數寫成 `"把 網線测译测译⁇古代不号言。"`（`argumentCorrectness` = 0），`meta/llama-3.2-90b-vision-instruct` 寫成 `接線渮試` —— **錯一個字**，而一個只判「有沒有叫工具」的粗判準會把這一次記成通過。這是 #80 把「少叫一次」與「參數寫錯」分成兩個數字之後，第一次真的抓到行為上的差異。兩個都是 vision 微調、不屬於這道階梯，但它們證明了判準本身不鈍。**這條旁證後來被扶正** —— 11B 那個已經真的跑過 `runBenchmarkCase` 與 `scoreCase`，見下面兩條。
    → **補了一階到 30B 以下，而它還是沒崩。** 2026-08-28 第二輪盤點（同一套做法，逐一送帶 `tools` 的請求）：30B 以下叫得動又支援工具的**只有兩個** —— `openai/gpt-oss-20b` 與 `meta/llama-3.2-11b-vision-instruct`；`google/gemma-3-12b-it`、`google/gemma-3-4b-it`、`nv-mistralai/mistral-nemo-12b-instruct`、`mistralai/codestral-22b-instruct-v0.1`、`nvidia/mistral-nemo-minitron-8b-8k-instruct`、`microsoft/phi-3.5-moe-instruct`、`bigcode/starcoder2-15b`、`nvidia/cosmos-reason2-8b` 全部 404。**補法不是往 Nemotron 那道階梯裡塞一個別家的 id** —— 那會當場毀掉「只有尺寸在變」，而 `tiers.test.ts` 的家族斷言正是為擋這件事寫的。補法是**再開一道同家族的階梯**：`openai/gpt-oss-20b` 與 `openai/gpt-oss-120b`，總量 20 → 120 把 30B 這條線夾在中間，20B 那階是重點、120B 那階是它的對照（走同一個配方，而且落在已知不會崩的尺寸區間）。**結果是又一次空手而回**：兩階的工具呼叫成功率與參數正確性都是 `1.00`。受控的底板因此從 30B 降到 20B（總量那一欄），而崩塌點仍在它底下。
    → **判準有鑑別力，而且這次是用同一組評分器量出來的。** 上一條那個 11B 的證據是盤點時用 curl 拿到的旁證，不是走 `runBenchmarkCase` 與 `scoreCase` 量的。這次把 `meta/llama-3.2-11b-vision-instruct` 當成**判準對照**真的跑完整份基準任務：參數正確性 `0.19`（0–0.67）、工具呼叫成功率 `0.67`（0–1.00，其中兩次一顆工具都沒叫）。**它不是一階** —— 同家族的 `meta/llama-3.2-90b-vision-instruct` 三次探測全部 90 秒逾時（就是 [#57](https://github.com/DemianLi/nexus-agent/issues/57) 那個永遠不回來），沒有對照就沒有東西能把它的分數歸因到尺寸，所以它只回答「判準量不量得出 1.00 以下」。**「基準任務太淺」這個假設到此為止**：同一份題目、同一組評分器，在 11B 上量得出 1.00 以下，在 20B 以上量不出來。
    → **數字（2026-08-28，`pnpm --filter @nexus/harness run eval:compare --samples 3`，54 次執行，循序，[#84](https://github.com/DemianLi/nexus-agent/pull/84)）**：

| 階梯 | 短名 | 總量／活化 | 評到分 | 工具成功率 | 參數正確性 | 多叫次數 | 總 token 平均（全距） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-oss | `oss-20b` | 20B ／ 不詳 | 9 | 1.00 | 1.00 | 0.33（0–2） | 5452（3492–9246） |
| gpt-oss | `oss-120b` | 120B ／ 不詳 | 9 | 1.00 | 1.00 | 0.11（0–1） | 5071（3557–7292） |
| nemotron-3 | `nano` | 30B ／ 3B | 9 | 1.00 | 1.00 | 0.11（0–1） | 8767（5984–13090） |
| nemotron-3 | `super` | 120B ／ 12B | 9 | 1.00 | 1.00 | 0.22（0–1） | 8738（5887–12313） |
| nemotron-3 | `ultra` | 550B ／ 55B | 9 | 1.00 | 1.00 | 0.00 | 7989（5891–9062） |
| 判準對照 | `llama-11b` | 11B ／ 不詳 | **6**（失敗 `rejected`×3） | 0.67（0–1.00） | **0.19**（0–0.67） | 7.17（0–36） | 33381（2927–151524） |

    → **第一個對 [#31](https://github.com/DemianLi/nexus-agent/issues/31) 真的有用的數字，而它不是尺寸效應。** 五階品質全部打平，但 gpt-oss 那一家平均 5071–5452 token、單題 1–7 秒，Nemotron 那一家 7989–8767 token、最慢 35.6 秒 —— **token 差約 1.6 倍，延遲差一個數量級**。這條線跨階梯，所以它**不能**讀成尺寸效應；但**選型本來就不是在問尺寸**，這個比較對選型是合法的。附帶推翻一句：**成本跟尺寸無關，跟配方有關** —— 最小的 `nano`（30B/a3B）比最大的 `ultra`（550B/a55B）還貴。
    → **同一輪還抓到四件事，四件都不是尺寸效應，不要混讀。** ①那三次失敗是 `400 "This model only supports single tool-calls at once!"` —— 端點拒收**平行工具呼叫**，是模型行為撞上供應商限制，不是分數，所以它們不進平均（`評到分 6 次`）。#83 那條「丟出例外不是零分」第一次在真實資料上派上用場。②**`classify()` 原本會把它記成 `transport`**：實測丟出來的是 `MiddlewareError`、`status` 是 `undefined`，帶 `status: 400` 的 `BadRequestError` 包在 `cause` 底下**第三層**。這張 PR 改成掃整條 `cause` 鏈，而且 `status` 先掃完一趟才輪到逾時 —— 否則外層訊息裡的 `aborted` 會壓過內層一顆明確的 400，也就是拿字串壓過協定。③**`LIVE_TIMEOUT_MS` 管的是單一請求，不是整輪**：llama-11b 有一次在 `echo-then-write` 上多叫了 36 次工具、燒掉 151,524 token、跑了 208.7 秒，而每一個請求都在 90 秒以內，那道上限一次都沒觸發。護欄與真正該擋的東西不是同一個；**這次不補**，先記著。④唯一沒有打平的指標是「多叫次數」，而它在 n=9 上是雜訊 —— 全距都壓在 0–2，而且 Nemotron 那三階不是單調的。附帶：llama-11b 兩輪之間差很多（前一輪參數正確性 0.31、多叫 1.25，這一輪 0.19、7.17），**這一階本身不穩**，n=6 的數字只證明判準分得出來，不證明別的。
    → **兩件事因此變成孤兒 —— 懸著等裁示，不是被解決。** ①[#61](https://github.com/DemianLi/nexus-agent/issues/61)（DeepSeek 官方帳號與 `@langchain/deepseek`）不再是任何東西的前置了，但它問的事沒有消失；②Phase 2 那道「不相容則 DeepSeek 出局」的二元閘門仍然沒跑過 —— 三個模型走同一個套件、同一個端點，「我們這套 stack 換一個供應商跑不跑得通」這個問題沒有被回答，只是沒人在問了。**順帶一條**：第 0 節決策表與第 4 節選型表都還寫著預設 **Anthropic**，而 eval 現在永遠不會跑到它 —— 那個決策**沒有證據路徑了**。這三張表這次刻意不動，先把落差記在這裡。**再收窄一層**：橫階定成同一個家族之後，每一道階梯回答的是「**在同一套訓練配方裡，工具呼叫隨尺寸怎麼衰減**」——比「三個尺寸級距」又窄一階，而且是疊在已經被孤立的供應商問題**之上**的第二次收窄。**開第二道階梯沒有把它放寬**：兩道階梯之間的那條線混著訓練配方，讀不成尺寸效應（報表因此按階梯分段印，不併成一張表）；能跨階梯讀的只有選型，而選型本來就不是在問尺寸。
    → **題目變難之後，飽和解除了一半 —— 而且動的是參數那一欄，不是工具那一欄。** #84 的落點是「判準在 20B 以上飽和」，所以下一步不是再找更小的模型，是**讓判準本身有東西可扣**。挑題目的依據來自 #84 自己的資料：工具名字那一欄五階全平，參數那一欄卻在 11B 掉到 `0.19` —— **有動態範圍的是參數**。所以四條新題目裡三條的難處放在參數（`edit_file` 的 `old_string` 要一字不差重現剛讀到的內容、正確參數是前一步輸出的**變換**而不是複製、該不該叫工具），只有一條是「多加幾步」。結果：**同一組評分器第一次在階梯上量得出 1.00 以下** —— 五階裡有四階做到了，而 #84 一階都沒有。**這一句才是不依賴 n 的那個發現。** 至於方向：`gpt-oss` 那道階梯 20B → 120B 的參數 `0.94` → `1.00`、多叫 `1.38` → `0.29`，`nemotron-3` 那道則是 `0.92` / `0.97` / `0.89` 不單調。**兩道的 n 都只有 6，而 `0.94` 是由單獨一次 `0.83` 與一次 `0.80` 拉下來的** —— 所以 `gpt-oss` 那條差異只是**有提示性**，不是被確立的尺寸效應；`nemotron-3` 那條同樣在雜訊裡。要下判決得先把取樣數撐起來。
    → **這句是動工前就寫死的，不是看到結果才補的**：五階若又全部打平，那也是**結論**而不是失敗的分支 —— 它會表示品質那一軸救不回來，選型只剩成本、延遲、失敗模式。實際上沒有全部打平，但**打開的程度要說準**：確立的是「判準在階梯上量得出 1.00 以下了」，**沒有**確立「尺寸造成了那個差異」——兩道階梯的 n 都只有 6，方向還一道順一道逆。所以 `nemotron-3` 不能讀成「大的比較差」，`gpt-oss` 也不能讀成「大的比較好」。
    → **數字（2026-08-28，`eval:compare --cases edit-after-read,reverse-round-trip,grep-across-files,no-tool-needed --samples 2`）**。這一輪**只跑新的四題**，舊三題沿用上表 —— 舊題目在 #84 已經量過而且全平，重跑不會多說什麼，而每多一題就是階數 × 取樣數的乘積。

| 階梯 | 短名 | 總量／活化 | 評到分 | 工具成功率 | 參數正確性 | 多叫次數 | 回覆提到 | 總 token 平均（全距） |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-oss | `oss-20b` | 20B ／ 不詳 | 8 | 1.00 | **0.94**（0.80–1.00） | **1.38**（0–8） | 1.00 | 9711（1772–27801） |
| gpt-oss | `oss-120b` | 120B ／ 不詳 | 7（失敗 `transport`×1） | 1.00 | **1.00** | **0.29**（0–1） | 0.86（0–1） | 6554（1772–9791） |
| nemotron-3 | `nano` | 30B ／ 3B | 8 | **0.94**（0.67–1.00） | **0.92**（0.50–1.00） | 0.38（0–1） | 1.00 | 12744（2970–19670） |
| nemotron-3 | `super` | 120B ／ 12B | 8 | 1.00 | 0.97（0.80–1.00） | 0.38（0–1） | 0.88（0–1） | 11799（2931–18296） |
| nemotron-3 | `ultra` | 550B ／ 55B | 8 | 1.00 | **0.89**（0.67–1.00） | 0.25（0–1） | 1.00 | 10070（2941–15688） |
| 判準對照 | `llama-11b` | 11B ／ 不詳 | **8 次裡只跑完 3 次，整輪被中止** —— 見下面第三條 | | | | | |

    → **「沒有可判的」現在真的不被平均了，而且報表看得到。** `no-tool-needed` 期望零筆工具呼叫，所以它在工具與參數兩欄是 `undefined` 而不是 `1` —— 上表每一階的那兩欄實際上都只判了 **6/8** 次（CLI 會印「判了 6/8 次」）。填成 `1` 的話，加了這條題目之後這兩欄的**鑑別力反而下降**，而它下降的方式看起來完全像是模型變好了。這與 `runner.ts` 區分 `usage` 的 `undefined` 與零、`compare.ts` 區分「失敗」與「零分」是同一條規矩，反向驗過：把它改回 `1`，四條測試當場紅。**順帶補回一整欄**：`mentions` 從 #80 就在算，但 `summarize()` 從來沒收，所以尺寸比較的報表上少了一欄品質指標；它問的是「有沒有把結果講出來」，跟前兩欄的「有沒有做」不同，而 `super` 與 `oss-120b` 各有一次工具全對卻答非所問（`0.00`）。
    → **`LIVE_TIMEOUT_MS` 管不到整輪，第二次證實 —— 而且這次發生在階梯上的一階，不是對照組。** `ultra` 跑 `edit-after-read` 兩次分別花了 **420.9 秒**與 **247.3 秒**，那道 90 秒的上限**一次都沒觸發**，因為每一個單一請求都在 90 秒以內。判準對照更誇張：`llama-11b` 在 `reverse-round-trip` 上一次跑了 **792.8 秒**、多叫 **25** 次工具、燒掉 **110,936 token**（#84 那次是 208.7 秒 / 151,524 token）。**判準對照那一列沒有彙總**：8 次執行只跑完 3 次。**這裡原本記著「中止的原因不是模型，是我自己的跑法（背景 process group 被收掉）」——那句話是錯的，2026-08-28 稍晚查證後更正。** 那個行程從來沒有被收掉：它在 `llama-11b` 的 `reverse-round-trip` 第二次取樣上**活了大約兩個小時、零輸出**，是準備跑下一輪時列進程才發現並手動殺掉的。**會判斷成「被收掉」是因為當時跑的 `ps aux | grep -c` 沒有走 `rtk proxy`**，過濾層回了 `0`；用 `rtk proxy ps -eo pid,etime,command` 重跑，四個 PID 全在、`etime` 是 `02:25:51`。→ 更正之後結論更硬不更軟：那不是跑法出問題，是**一次真正的失控** —— 單一次執行超過兩小時，而當時沒有任何上限攔得住它。→ **這一輪不補跑那個對照**，理由有兩層：一是它的職責（「判準量不量得出 1.00 以下」）這次由階梯自己回答了 —— 五階裡有四階量出了 1.00 以下，而 #84 一個都沒有；二是補跑它正好是那個沒有上限的行為最會重演的地方。**整輪的成本上限仍然沒補**，但它現在有兩次獨立的實測撐著，而且是 [#85](https://github.com/DemianLi/nexus-agent/issues/85)（十個模型的橫向評測）動工前必須先有的東西。
    → **順帶兩件小的。** ①`oss-120b` 有一次失敗被歸成 `transport`，訊息是 `Cannot read properties of undefined (reading 'message')` —— 那是個 `TypeError`，不是線路問題。我們這側所有讀 `.message` 的地方都有 `instanceof Error` 護著（grep 過），所以它來自基座或 SDK 內部；`classify()` 認不出來就歸 `transport` 而不猜，這次的行為是對的，但 `transport` 這一類現在裝著兩種很不一樣的東西。②`eval:compare` 多了 `--cases`，因為成本是題數 × 階數 × 取樣數的乘積，而題目從 3 條變成 7 條 —— 打錯的 id 一律當場拋，不默默略過（默默略過就會跑了個比預期小的子集而報表上看不出來）。
    → **[#61](https://github.com/DemianLi/nexus-agent/issues/61) 的裁示（2026-08-28，demian）：留著當紀錄，不關。** 它已經不是任何東西的前置，但它問的兩件事沒有消失（Phase 2 那道二元閘門從沒跑過；§0／§4 的預設 Anthropic 沒有證據路徑），所以留著當那兩件事的錨點。**下一個看到它的人不要重新問「要不要關」。**
    → **整輪的上限補了，而且槓桿早就在基座手上 —— 是它自己轉到底的。** 動工前先 grep 了基座，
發現 `createDeepAgent` 最後一步是 `createAgent(...).withConfig({ recursionLimit: 1e4 })`：
一萬個 super-step，換算約 **5,000 輪模型呼叫**。實測（`LoopingChatModel`，2026-08-28）裸基座
與我們的組裝點都跑到 `GraphRecursionError: Recursion limit of 10000 reached`，模型分別被叫了
5000 與 4999 次。**那不是沒有護欄，是一個被轉到底的護欄** —— 而它藏在 dist 的一行 `withConfig`
裡，型別、文件、README 全都看不到。這是「基座預設會被踩掉」的**第二型**：上一次
（[#54](https://github.com/DemianLi/nexus-agent/issues/54) 那條）是我們掛的 middleware 關掉了基座的預設，這次是基座自己。
    → **兩道上限，各管一半，都是基座本來就有的東西。** ①`recursionLimit`：組裝點蓋成 `100`
（約 49 輪），eval 再收緊到 `40`（約 19 輪）。實測 `withConfig` 疊得上去而且後者贏，
**推導出來的型別沒有塌**（`invoke()` 的 `messages` 仍然是 `BaseMessage[]` 不是 `any`
—— 這件事特地驗過，因為 `any` 是不會讓 typecheck 紅的那種壞掉，測試裡留了一條型別層的斷言）。
②`signal`：`invoke` 收得下 `AbortSignal`，eval 給 300 秒。這一條**差點被記成「行不通」**——
第一次探測時 `AbortSignal.timeout(1000)` 完全沒觸發、跑滿 35.6 秒到迴圈上限才停；原因是那個
假模型每一輪都不 await 真東西，純 microtask 的迴圈把 event loop 的計時器餓死了。加上 5ms 的
真等待之後它 1.0 秒準時中止（122 輪）。**那是探針的產物不是基座的行為**，而它差一點就變成
一條寫進文件的錯誤結論。
    → **`budget` 是第四類失敗，跟另外三類分開。** 另外三類講的是端點（`rejected` / `transport`）
或端點不回話（`timeout`），這一類是**模型的行為撞上我們設的上限**。它既不是分數（題目沒做完，
我們不知道它做不做得完），也不該混進端點的失敗裡 —— 讀到它要做的是調高上限重跑或換模型。
`classify()` 因此多一趟掃描，而且**放在逾時那一趟前面**：`GraphRecursionError` 的訊息裡沒有
任何逾時字眼，排後面會掉進 `transport`；而時間預算那一半**根本不靠讀錯誤**，`runOnce` 直接問
中止訊號有沒有觸發 —— 中止丟的是 `DOMException` 而 `name` 就是 `TimeoutError`，靠字串分不開
「我們切的」與「端點不回話」。
    → **token 預算刻意不做。** 實測跑掉的兩次（`llama-11b` 792.8 秒 / 25 次多叫、`ultra` 420.9 秒）
這兩道上限都攔得住，一個數 token 的 middleware 一次都用不上，而它會動到 plugin 契約那個面。
**等到有一次跑掉是這兩道都沒攔住的，再做。**
    → **上限第一次在真實比較裡承重，而且是迴圈那道先攔到。** 2026-08-28 的 n=12 那一輪，`llama-11b` 在 `reverse-round-trip` 上觸發了一次 `budget`：`Recursion limit of 40 reached`，**101.8 秒**。那正是兩小時那次的同一題同一個模型 —— 沒有上限時它跑了兩小時，有上限時它在第 102 秒被切掉。同一輪裡最慢的正常執行是 `ultra` 的 93.8 秒，**300 秒那道時鐘一次都沒觸發**：該攔的攔到了，不該攔的沒有誤傷。
    → **把取樣撐到 n=12 之後，[#86](https://github.com/DemianLi/nexus-agent/pull/86) 那個 `gpt-oss` 的尺寸效應消失了。** 這正是 #86 內文預先打過折的那一條（「那個差異踩在兩次觀測上」）。數字（2026-08-28，`eval:compare --cases edit-after-read,reverse-round-trip --samples 6`，72 次執行）：

| 階梯 | 短名 | 總量／活化 | 評到分 | 工具成功率 | 參數正確性 | 多叫次數 | 回覆提到 | 總 token 平均（全距） |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-oss | `oss-20b` | 20B ／ 不詳 | 12 | 0.94（0.33–1.00） | **0.91**（0.33–1.00） | 0.75（0–2） | 0.92 | 9488（7681–12526） |
| gpt-oss | `oss-120b` | 120B ／ 不詳 | 12 | 0.94（0.67–1.00） | **0.92**（0.50–1.00） | 0.33（0–1） | 0.92 | 8519（7657–10019） |
| nemotron-3 | `nano` | 30B ／ 3B | 12 | 0.94（0.67–1.00） | 0.92（0.50–1.00） | 0.67（0–1） | 1.00 | 17414（13428–21283） |
| nemotron-3 | `super` | 120B ／ 12B | 12 | 1.00 | **0.98**（0.80–1.00） | 0.75（0–1） | 0.83 | 15413（12949–16318） |
| nemotron-3 | `ultra` | 550B ／ 55B | 12 | 1.00 | **0.88**（0.67–1.00） | 0.50（0–1） | 0.83 | 14049（12333–15814） |
| 判準對照 | `llama-11b` | 11B ／ 不詳 | 4（失敗 `rejected`×7、`budget`×1） | 0.58（0–1.00） | 0.53（0–0.83） | 1.25（0–3） | **0.00** | 14734（3070–27072） |

    → **這是一個「沒有效應」的結論，而它是有效力的，因為判準沒有飽和。** 五階的參數正確性落在 `0.88`–`0.98`，全距下探到 `0.33`／`0.50` —— 判準在每一階上都還有量程，只是**尺寸沒有在那個量程上動**。`gpt-oss` 從 `0.94 → 1.00`（n=6）縮回 `0.91 → 0.92`（n=12）；`nemotron-3` 三階仍然不單調，而且 550B 那階在兩輪裡都是最低。所以 #83 → #84 → #86 這條「一直往下找崩塌點」的線到這裡收掉了：**崩塌點在 20B 底下，20B 以上這五階的品質分不出高下，而那不是題目太淺造成的**（題目已經加難過一輪，判準也證明沒飽和）。
    → **因此 [#31](https://github.com/DemianLi/nexus-agent/issues/31) 的選型有答案了，而答案來自成本那一欄。** 品質打平時能用的軸只剩成本、延遲、失敗模式，而這三個都指向同一個：**`openai/gpt-oss-120b`** —— 參數正確性 `0.92`（與 `nano` 並列第二，離最高的 `super` 差 0.06）、**token 最省**（8519，比 Nemotron 那一家的 14049–17414 少四到五成）、**多叫次數最低**（0.33）。跨階梯讀這條線對**選型**是合法的（選型本來就不是在問尺寸），對尺寸效應則不是。**這個結論要不要拿去改第 0 節與第 4 節那兩張還寫著「預設 Anthropic」的表，是 demian 的判斷**，這裡只把證據放好。
    → **第三輪：七題全跑、n=6（252 次執行），「沒有尺寸效應」第三次被確認 —— 而且這一輪的價值有一半在別的地方。** 2026-08-28 跑完整份資料集（七題 × 五階 + 判準對照 × 6 次）。**先講怎麼讀**：三條簡單題上五階**全部 `1.00` / `1.00`**，完全飽和，所以七題的平均（`0.96`–`0.98`）是被稀釋的數字，**不是一次新的測量** —— 有解析度的只有四條難題那一組：`oss-20b` `0.95`、`nano` `0.92`、`super` `0.96`、`ultra` `0.94`。三輪（`0.94`/`1.00`/`0.92`/`0.97`/`0.89` → `0.91`/`0.92`/`0.92`/`0.98`/`0.88` → `0.95`/—/`0.92`/`0.96`/`0.94`）全部落在同一個窄帶，方向一輪一個樣。**這條線到此為止真的可以收了。**
    → **同一輪有一階被端點限流掉一半，而我第一次把原因判錯了 —— 下一條是更正。** `oss-120b` 42 次執行裡 **21 次被端點回 `429 Too Many Requests`**：三條簡單題 18/18 全通過，`reverse-round-trip` 與 `grep-across-files` **6/6 全滅**，`edit-after-read` 從第 3 次開始斷。單獨重跑整份七題**逐格重現**（同樣的斷點、同樣那兩條全滅、簡單題 token 平均 5045 對 5049）。**它之後跑的 168 次執行零 429**、同家族的 `oss-20b` **42 次也零 429**，所以不是整把 key 的吞吐上限，也不是 `openai/*` 這個前綴的事。→ **當時的結論是「這個模型跑不完基準任務」，而那是錯的。**
    → **更正（2026-08-28 稍晚，量出來的）：那是我們打太快，不是模型跑不完。** 錯在兩個地方。①**「斷點跟題目綁定」不成立**：只跑那條「6/6 全滅」的題、前面什麼都不跑，是 **6/6 全過、全部滿分**，每次 5–7 秒。②**「逐格重現所以不是配額被前面的執行打滿」推論反了**：那次重跑走的是**同一串七題序列**，累計用量到同一個點才斷 —— **逐格重現正是累計效應的證據，不是它的反證**。真正的對照是換掉一個變數，不是把同一串重放一次。→ **實際機制**：每分鐘 token 配額。實測 49.5 秒內燒掉 **119,363 token** 觸發 429，**16 秒後完全恢復**（輕請求與一次真的 eval 執行都立刻通過）。→ **最反直覺的一點**：撞上它的是六個模型裡**最快**的那個 —— `nano`／`super`／`ultra` 每次 token 更多（11k–17k）但每次要 14–60 秒，`oss-120b` 每次只要 2–7 秒，單位時間的 token 率最高。**「跑得快」本身是撞限流的風險因子，而它長得跟「這個模型不行」一模一樣。**
    → **修法：把限流接回重試，並在分類上跟 `400` 分開。** ①**基座那道的作用面比看起來窄**：`AsyncCaller` 的 `maxRetries` 預設是 6，但 `@langchain/core` 把**沒有 `retry-after` header 的 429** 分類成 `headerless_429` → `action: 'capacity'` 然後**直接拋**，而 NVIDIA 回的正是那個形狀；底層那道也關著（`@langchain/openai` 建 `OpenAI` client 時寫死 `maxRetries: 0`）。這是 [#87](https://github.com/DemianLi/nexus-agent/pull/87) 那個 `recursionLimit: 1e4` 的同型第三例。②**`throttled` 從 `rejected` 分出來**，配額耗盡的 429 留在 `rejected` —— dsh 的 [`error.ts`](../references/deepseek-harness/packages/llm/llm/src/error.ts) 把 `RATE_LIMIT` 與 `QUOTA` 分成兩個碼，只有前者在預設可重試集（[`retry-policy.ts`](../references/deepseek-harness/packages/llm/llm/src/retry-policy.ts) 的 `DEFAULT_RETRYABLE_CODES`）裡，理由一樣是「前者等一下就過，後者重試無效」。**偏離標註**：dsh 的退避是有界的（`initialDelayMs: 500`／`maxDelayMs: 10_000`／`jitterRatio: 0.1`），而 `AsyncCaller` **沒有把退避參數暴露出來**，只收 `maxRetries` 與 `onFailedAttempt` —— 所以這裡只釘得住次數，釘不住每次等多久。③**自訂 `onFailedAttempt` 會整個取代基座的預設**，順手把 `500` 與連線問題的重試一起關掉是很容易犯的退化（我第一版就犯了），所以它寫成基座 `defaultFailedAttemptHandler` 的複本、只改限流那一支，並有一條測試專門擋那個退化。
    → **端到端驗過，而且它同時補回了缺的那一格。** 修完重跑 `oss-120b` 整份七題 × 6 = **42 次，零失敗**（修之前同一階兩輪都是 21 次 429）。七題與四條難題都是 `1.00` / `1.00`（36、18 個判分）—— **它是五階裡唯一在難題上不掉分的**。→ 直接後果：上面那條「選型的失敗模式那一軸指向反面」**撤回** —— 限流是我們的跑法，不是模型的性質，選型的三個軸都沒有變。→ **但那一格與同列另外四格之間多了一個變數**（限流重試），並排讀要記得。
    → **`budget` 第二次承重，而判準對照本身不穩。** `llama-11b` 這一輪觸發 2 次 `budget`（`Recursion limit of 40 reached`），沒有任何一次逼近 300 秒那道時鐘。同一階的 `400`（拒收平行工具呼叫）從上一輪的 7 次跳到 **19 次** —— **這一階本身不穩定，兩輪之間差 2.7 倍**，跟計劃書早先記的「這一階本身不穩」一致，所以它的分數只證明判準分得出 1.00 以下，不證明別的。
- 驗收：瀏覽器完成「提問 → 看事件流 → 核准工具 → 收結果」全迴圈（[#79](https://github.com/DemianLi/nexus-agent/pull/79) 已閉合）；eval 有可比較的通過率數據，且該數據足以讓模型定案 —— **前半有了，後半接近了但還沒到，而擋住的東西又換了一次**。[#83](https://github.com/DemianLi/nexus-agent/pull/83) 記的是「階梯的底板太高」，[#84](https://github.com/DemianLi/nexus-agent/pull/84) 把受控底板降到 20B（總量）卻五階全部滿分，落點因此變成「判準在 20B 以上飽和」。[#86](https://github.com/DemianLi/nexus-agent/pull/86) 把題目加難，判準在階梯上終於量得出 `1.00` 以下；[#87](https://github.com/DemianLi/nexus-agent/pull/87) 補上整輪的上限，n 才撐得起來。撐到 **n=12** 之後**答案是「沒有尺寸效應」**：五階的參數正確性 `0.88`–`0.98`、全距下探到 `0.33`，判準沒有飽和，但尺寸沒有在那個量程上動。**這是一個有效力的否定結論，不是「量不出來」** —— 而它讓選型落回成本那一欄，答案是 `openai/gpt-oss-120b`（品質並列第二、token 最省四到五成、多叫最低）。→ **驗收兩半都到齊，Phase 5 宣告完成（2026-08-28，demian 拍板）。** 第 0 節決策表第 4 列、第 4 節選型表的「模型」列、第 7 節決策點 2 同時改成 `openai/gpt-oss-120b`，決策點 2 關閉。**沒有一併關掉的**：Phase 2 那道「不相容則 DeepSeek 出局」的二元閘門仍然沒跑過，而 Anthropic 那條路從頭到尾沒有被建起來 —— 兩者都錨在 [#61](https://github.com/DemianLi/nexus-agent/issues/61)，那張留著當紀錄。**下一個發版依 README 的規則跳 minor**（發版是 `develop → main` 加 workflow_dispatch，人工步驟）。→ **宣告之後又跑了第三輪（七題全跑、n=6），結論不變。** 中間一度以為多了一條反面證據（選中的 `openai/gpt-oss-120b` 跑不完難題），**那個判斷已更正並撤回** —— 那是端點限流加上我們沒有重試，不是模型的性質；把限流接住之後重跑同一階 42 次零失敗、難題全部滿分。

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
2. **模型供應商決策**（[#31](https://github.com/DemianLi/nexus-agent/issues/31)）—— **已關閉（2026-08-28）：`openai/gpt-oss-120b`。**

   原文：Anthropic 功能最全但成本高；DeepSeek 便宜。原本要在 Phase 0「兩者都跑基本驗證再定」，但 Phase 0 的驗收判定不了品質，也碰不到 middleware —— 那時還沒有任何 middleware。所以拆成三段：**Phase 0 只定預設**（Anthropic）並驗真實接線；**Phase 2 驗 DeepSeek 相容性**，二元判定，不相容就出局；**Phase 5 才比品質與成本**。理由是相容性是二元的、早驗早止血；品質比較是統計性的，小樣本手工跑出來的數字噪音大過訊號。

   **三段裡只有第一段與第三段真的發生，而第三段換掉了問題本身。** Phase 5 沒有比「Anthropic 對 DeepSeek」——那兩條路一條沒建起來（`@langchain/anthropic` 從來不在任何 `package.json` 裡）、一條卡在人工開帳號（[#61](https://github.com/DemianLi/nexus-agent/issues/61)）。實際跑的是**同一個 NVIDIA 端點上五個模型的橫向比較**，前後三輪（四條難題 × 2 次、兩條難題 × 6 次、四條難題 × 6 次）。結果：**品質五階打平**（四條難題上 `0.92`–`0.96`，而判準沒有飽和 —— 全距下探到 `0.33`／`0.50`），所以選型落回成本、延遲、失敗模式，三個軸都指向 `openai/gpt-oss-120b`。**第三輪一度出現一條反面證據，已經更正並撤回**：當時量到選中的那個 id 跑不完四條難題中的三條（`429`），判成失敗模式那一軸指向反面。實際上那是端點的每分鐘 token 配額加上基座對 headerless 429 不重試，把限流接住之後重跑同一階 **42 次零失敗、難題全部滿分** —— 限流是我們的跑法，不是模型的性質。**選型的三個軸都沒有變。**

   **這個決定要看清楚它的邊界，否則會被讀得太寬：**

   - **它是「這把 key 叫得動的模型裡最划算的那個」，不是「這是最好的模型」。** 候選集合綁在帳號上（`GET /models` 列 84 個，這把 key 只叫得動 29 個、真的支援工具的 14 個），換一把 key 要重新盤點。
   - **Anthropic 不是被比下去的，是從來沒進過場。** 要重新排入評估，缺的是一段從沒被記過的接線工作，不是一次比較。
   - **Phase 2 那道「不相容則 DeepSeek 出局」的二元閘門到今天仍然沒跑過。** 「我們這套 stack 換一個供應商跑不跑得通」這個問題沒有被回答，只是沒有人在問了 —— 因為五個候選走的是同一個套件、同一個端點。它錨在 [#61](https://github.com/DemianLi/nexus-agent/issues/61) 上，那張刻意留著當紀錄。
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
   6. **失敗會先上線再拋。** 實測 run 失敗時最後一顆 frame 是 `lifecycle { event:'failed', graph_name:'root', error:'…' }`，**然後** iteration 才 throw。→ 瀏覽器從協定 frame 就知道為什麼死的，pump 的 try/catch 是用來收線的，不是用來補一顆錯誤 frame 的。（工具拋錯那一組另外還有一顆 `graph_name:'tools'` 的 failed，而且會多一個 `run.output.catch()` 攔不掉的 unhandled rejection —— 但那是第 5 節 Phase 4 那條「工具拋錯就整場死」的老問題。**[#159](https://github.com/DemianLi/nexus-agent/issues/159) 之後，我們的組裝踩不到它了**：圍堵由 `foldRegistry` 打底進 root 與每個 subagent，裸 `createDeepAgent` 才踩得到（絆索在 `apps/harness/src/baseline.test.ts`）。模型拋錯那一組沒有這個副作用。）

   **channel 白名單是安全邊界，不是效能調校。** 實測 `tasks` 的每一顆 frame 都夾著整份 input message list、`updates` 夾著完整序列化的 `{"lc":1,…}` 訊息、`values` 夾整個 state。全頻道往瀏覽器倒等於每個 task event 重送一次對話狀態，而且 state 裡有什麼就送什麼。protocol 的 `EventStreamRequest.channels` 存在正是為這件事。→ **白名單預設只放 `messages` / `tools` / `lifecycle` ＋ 中斷那條**，`tasks` / `checkpoints` / `values` 要放行得是一個明白的決定。

   **瀏覽器斷線不得中止 run。** `run.abort()` 與 `run.signal` 就在手邊，把 HTTP response 的 abort signal 接上去是最自然的寫法，而它是錯的 —— 下行是**長期的**、與單一 run 無關，斷線之後靠 reopen 接回來。接反了不會有任何錯誤訊息，只會變成「使用者關掉分頁 agent 就停了」。

   **這張 PR 的採納範圍，與明著不做的部分。** 收：封包（`Command` / `CommandResponse` / `ErrorResponse` / `Event`）、channel 名、SSE 的 route 形狀、HITL 的 `input.respond`。**不收，而且明著記著**：`subscription.*`（SSE 那條路上訂閱就是開線本身）、`state.get` / `state.fork` / `state.listCheckpoints`、`agent.getTree`、`input.inject`、`custom:*` 頻道、`namespaces` / `depth` 過濾。**`since` 收到就明確回 `not_supported`，不靜靜忽略** —— 靜靜忽略會生出看不見的斷檔。這麼切本身就是照 dsh：它自己也只有兩條長期下行、`since` 在 v1 沒實作。跨連線的 replay 要能做得先有 frame 的持久化，而狀態儲存目前只收斂了 backend 一軸（見決策 4）。

   **偏離標記**：無協定層偏離，而且比原本記的更強 —— 這條線用的是**基座自己的協定詞彙**，dsh 提供的是它沒指定的那一格（HTTP 上行的 route 形狀與錯誤分層）。兩處未完成，都不是表達力問題：載體層先出 SSE 不出 WS 覆寫；協定層只實作上面那份採納範圍。
