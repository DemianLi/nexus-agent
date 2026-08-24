# nexus-agent 開發計劃：萬物皆可插件的 Deep Agents Harness（TypeScript）

狀態：方向已確認（2026-08-23）。
需求基準：《企業級 AI Agent 系統架構與 Harness 開發範圍說明 v1.0》（deepagents 1.13.1 / LangChain JS 1.5.x / LangGraph JS 1.4.x）。

## 0. 已確認的決策

| # | 決策 | 內容 |
|---|---|---|
| 1 | 技術棧全 TypeScript | LangChain JS + LangGraph JS + deepagentsjs（官方 TS 版），零 Python 基座 |
| 2 | 插件化程度 | agent 推理迴圈為固定基座（deepagentsjs），迴圈周圍的擴充點全部走 NexusPlugin 契約；不 fork、不做「連迴圈都可替換」的徹底插件化 |
| 3 | 兩層薄覆蓋 | 反思與反饋層、意圖與理解層先採薄覆蓋，後續強化追蹤於 [issue #16](https://github.com/DemianLi/nexus-agent/issues/16)，Phase 0–5 全部完成後啟動 |
| 4 | 選型決策點 | 模型供應商、狀態儲存後端保留為決策點，於 Phase 0 / Phase 3 收斂（見第 7 節） |

核心路線：**不從零重造**。deepagentsjs 已內建虛擬檔案系統（可插拔 backends）、宣告式檔案權限、MCP 工具接入、subagents、TodoListMiddleware（opt-in）、SummarizationMiddleware、skills（SKILL.md 標準）、memory（AGENTS.md）、human-in-the-loop（`interruptOn`）、typed streaming。需求約七成由基座覆蓋；自建部分為 plugin 統一註冊、結果校驗、可觀測性接線、web UI。

## 1. 萬物皆可插件的落地定義

deepagentsjs 的擴充入口原本分散（`tools`、`middleware`、`backend`、`subagents`、`permissions`、`interruptOn` 各傳各的）。nexus 的差異化價值是收斂成單一契約。

契約形狀是**命令式註冊**，不是靜態宣告（[#28](https://github.com/DemianLi/nexus-agent/issues/28) 決議 9，照 DeepSeek Harness 全命令式的做法）：

```ts
// 形狀示意，非最終簽章
interface NexusPlugin {
  name: string;
  version: string;
  requires?: string[]; // 能力名而非 plugin 名；只做存在性檢查，不排序
  apply(registry: PluginRegistry): void | Promise<void>;
}

// apply 內部
registry.tools.register(tool); // 同層同名報錯、跨層遮蔽
registry.subagents.register(sub); // 同層同名報錯、跨層遮蔽
registry.backend.mount('/memories/', backend); // 同 routePrefix 報錯
registry.middleware.use(mw, { prepend: false }); // 清單順序，prepend 為唯一例外閥
registry.permissions.deny(paths, { except }); // deny-only
registry.interrupts.require(toolName, { reason, when }); // 同工具多方標記不報錯，when 取 OR
registry.skills.addSource(path); // 同一來源路徑重複註冊報錯
registry.memory.addSource(path); // 純累加，基座自理
```

- 一個 plugin = 一個 npm package 或 workspace 模組。zod manifest 仍在，但只驗 `name` / `version` / `requires`，不驗擴充內容。
- `PluginRegistry` 是活的具名註冊表：插入順序、同名報錯、每次註冊回一個撤銷函式（**射程限定為載入期回滾**，不承諾執行期熱插拔——deepagents 建構後不可變）。最終仍折疊成一次 `createDeepAgent(...)` 呼叫。
- 共同軸線：**同層報錯、跨層遮蔽、fail-closed、載入期失敗**。「層」指全域（root agent）↔ 各 subagent。
- **組裝點所有、plugin 不得提供**：default backend、工具呈現順序、model、checkpointer / store、核准政策的 session 開關。
- 換模型、換儲存、換工具組合 = 換 plugin 清單，core 不動。此契約同時滿足補強項 6「業務邏輯解耦」。

三點要特別記著：

- **`permissions` 不是授權邊界，是意外防護。** 它只覆蓋 `FILESYSTEM_TOOL_NAMES` 那八個內建工具裡「當前 backend 實際註冊的那些」，而且基座無規則命中即 allow。真正的檔案圍堵靠換 backend（Phase 2）。
- **`interruptOn` 的核准詞彙是封閉的。** plugin 只能貢獻 `{ toolName, reason, when? }`；`allowedDecisions` 由 harness 固定為 `["approve", "reject"]`，`argsSchema` 不使用（dsh 明文「Input rewrite is deliberately not offered」）。宣告了需核准的工具卻沒有 checkpointer，registry 要在載入期報錯——缺席即拒絕，不是放行。
- **工具呈現順序要自建。** deepagents 沒有對應機制，dsh 有專門的 Agent Note（註冊順序造成過真實 CI flake）。組裝點要有一份顯式清單＋`'<unlisted-tools>'` rest entry＋字典序預設，屬 Phase 1 `feat/nexus-plugin-contract` 的範圍。

## 2. 七層架構 ↔ 實作映射

| 架構層 | nexus 實作 | 來源 | 覆蓋程度 |
|---|---|---|---|
| 感知輸入層 | 訊息標準化（LangChain messages）+ CLI / web 入口 | 自建（薄） | 足夠 |
| 意圖與理解層 | 可插拔 model provider + system prompt 組裝 | LangChain model layer | **薄覆蓋**，強化見 issue #16 |
| 規劃與編排層 | deepagents 迴圈 + TodoListMiddleware + subagents | deepagentsjs 內建 | 完整 |
| 記憶層 | memory（AGENTS.md）+ skills + summarization/offloading | deepagentsjs 內建 | 完整 |
| 執行與工具層 | tools + MCP + 虛擬 FS + 權限 + sandbox/QuickJS | deepagentsjs 內建 | 完整 |
| 反思與反饋層 | 結果校驗 middleware + LangSmith 回饋 | **自建** | **薄覆蓋**，強化見 issue #16 |
| 輸出層 | typed streaming → apps/web UI | deepagentsjs stream + 自建 UI | 完整 |

harness 五大範圍對應：解析標準化（PluginRegistry + zod）、編排迴圈（deepagents）、記憶層（內建）、工具層（內建）、結果校驗（自建 plugin——deepagents 無現成方案，為驗證插件架構價值的第一個實戰 plugin）。

## 3. 套件結構（pnpm workspace 演進）

```
apps/harness          核心組裝點：PluginRegistry、NexusPlugin 契約、agent 工廠、CLI
apps/web              輸出層：對話 + 事件流 + HITL 核准 UI（現有骨架續用）
packages/             （Phase 2 起拆出）nexus-core、nexus-plugin-* 系列
```

現有 `apps/harness/src/harness.ts` 的 step runner 與 deepagents 迴圈語義重疊，Phase 1 重塑為 agent 工廠時淘汰；`Step<TContext>` 概念若 CLI 需要批次任務管線可保留為薄殼，否則直接移除。

## 4. 技術選型（全 TypeScript）

| 項目 | 選擇 | 備註 |
|---|---|---|
| 基座 | `deepagents`（deepagentsjs，官方 TS） | **`~1.13.1`，只跟 patch。** minor 會動 peer 契約（見第 7.1 節），升 minor 走一張要人 review 的 PR |
| 核心 | `langchain`（`createAgent` middleware API）、`@langchain/core` | **`^1.5.10` / `^1.2.9`** — 照抄基座當版 `peerDependencies` |
| 執行 | `@langchain/langgraph`、`@langchain/langgraph-checkpoint`、`@langchain/langgraph-sdk` | **`^1.4.10` / `^1.1.5` / `^1.9.23`**；interrupts、checkpointer、store |
| 工具 | 內建 MCP 支援 + `@langchain/core` tools + `zod` | **`zod` 用 `^4.3.6`** — 與基座的直接相依同範圍，確保只解析出一份 |
| 觀測 | `langsmith`（tracing + evaluators） | **`>=0.7.1 <0.10.0`**。套件名是 `langsmith`，不是 `@langchain/langsmith`（後者不存在）。補強項 4 |
| 模型 | **決策點**：Anthropic（prompt caching 自動）/ OpenAI / DeepSeek（`@langchain/deepseek`） | Phase 0 驗證後定，預設 Anthropic |
| 狀態儲存 | **決策點**：Phase 0 用 `MemorySaver`，Phase 3 評估 `@langchain/langgraph-checkpoint-postgres` | 補強項 5 |
| Sandbox | deepagentsjs sandbox providers（`SandboxBackendProtocolV2`）+ QuickJS interpreter | Phase 2 之後，安全優先 |

**版本範圍規則**（[#33](https://github.com/DemianLi/nexus-agent/issues/33)）。基座 `deepagents` 用 `~` 只跟 patch；它的六個 peer 與 `zod` 全部顯式宣告在 `apps/harness/package.json` 的 `dependencies`，**範圍照抄基座當版 `peerDependencies` 的原文** — 範圍誰說了算，答案是基座說了算。升 `deepagents` 時把新的 peer 表重抄一次，那份 diff 就是這次升版真正動到的相依契約。

顯式宣告不是為了裝得起來（pnpm 8+ 預設 `auto-install-peers`，基座自己跑得動），是因為 harness 會直接 import 這幾個套件，而自動安裝的 peer 沒有連到 top-level；順帶讓版本在 `package.json` 上看得見，不是只躲在 lockfile 裡。

`pnpm-workspace.yaml` 設 `strictPeerDependencies: true`，讓範圍不符在 `pnpm install` 當場失敗而不是印 warning。實際跑什麼版本由已進版控的 `pnpm-lock.yaml` 決定，CI 用 `--frozen-lockfile`；範圍只決定 Dependabot 開出什麼 PR。

## 5. 開發階段

每個 PR 照 repo 流程：`<type>/<kebab-case>` 分支 → squash 進 develop，PR 標題 `<type>: <中文描述>`（見 [AGENTS.md](../AGENTS.md)）。以下 PR 切分為建議粒度。

### Phase 0 — 技術驗證（spike，1 個 PR）

- `feat/harness-deepagents-spike`：安裝 deepagentsjs，最小 agent（in-memory backend + 一個 custom tool）跑通；驗證模型供應商接線與 streaming；確認 Node 22 相容性。
- 驗收：CLI 下一個指令 → agent 呼叫工具 → 寫虛擬檔案 → 回覆；技術驗證記錄寫進 PR 內文「驗證方式」。

### Phase 1 — 核心迴圈 + Plugin 契約（約 3–4 個 PR）

- `feat/nexus-plugin-contract`：`NexusPlugin` 型別 + zod manifest 驗證 + `PluginRegistry`（載入、衝突偵測、折疊成 `createDeepAgent` 參數）。
- `feat/agent-factory`：agent 工廠 + 訊息標準化入口；淘汰舊 step runner，並一併移除 [`docs/standards.md`](../docs/standards.md) 的「harness 迴圈的狀態轉換」條文（[#32](https://github.com/DemianLi/nexus-agent/issues/32)：條文與它描述的程式碼同生共死，step runner 走了它才變成死條文）。
- `feat/harness-cli`：基本 REPL/CLI，作為後續 phase 的手動驗證工具。
- 驗收：兩個假 plugin（各提供一個 tool）能用一份 plugin 清單組出可跑的 agent；registry 邏輯有單測覆蓋。

### Phase 2 — 工具層 + 權限（約 3 個 PR）

- `feat/mcp-plugin`：第一個正式 plugin——MCP server 工具接入。
- `feat/fs-backends`：filesystem backends（State → Disk → composite routing）+ `permissions` 擴充點（deny-only glob 規則；registry 主動把全域 deny 併進每個 subagent——基座是整組替換而非合併）。
- `feat/sandbox-plugin`：sandbox `execute` 工具（或先只做 QuickJS interpreter，shell 沙箱隔離方案明朗前不開）。
- 驗收：agent 能經 MCP 讀外部資料並寫入受權限控管的虛擬 FS；deny 規則擋得住 `.env` 類路徑。

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
- `feat/eval-suite`：LangSmith evaluators 跑基準任務 —— 補強項 3。
- 驗收：瀏覽器完成「提問 → 看事件流 → 核准工具 → 收結果」全迴圈；eval 有可比較的通過率數據。

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
2. **模型供應商決策（Phase 0）**：Anthropic 功能最全但成本高；DeepSeek 便宜但需驗證工具呼叫品質與 middleware 相容性。Phase 0 兩者都跑基本驗證再定。
3. **shell sandbox 安全**：`execute` 工具本質是跑任意指令，且權限規則對 sandbox backend 不生效。先只用 QuickJS interpreter，shell sandbox 延後到有明確隔離方案（容器）再做。
4. **結果校驗範圍（Phase 4 前）**：需定義「校驗什麼」——schema、不變量、還是業務規則。屆時拍板。
