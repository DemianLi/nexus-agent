# nexus-agent 開發計劃：萬物皆可插件的 Deep Agents Harness（TypeScript）

狀態：方向已確認（2026-08-23）。
需求基準：《企業級 AI Agent 系統架構與 Harness 開發範圍說明 v1.0》（deepagents v0.7.x / LangChain 1.x / LangGraph 1.x）。

## 0. 已確認的決策

| # | 決策 | 內容 |
|---|---|---|
| 1 | 技術棧全 TypeScript | LangChain JS + LangGraph JS + deepagentsjs（官方 TS 版），零 Python 基座 |
| 2 | 插件化程度 | agent 推理迴圈為固定基座（deepagentsjs），迴圈周圍的擴充點全部走 NexusPlugin 契約；不 fork、不做「連迴圈都可替換」的徹底插件化 |
| 3 | 兩層薄覆蓋 | 反思與反饋層、意圖與理解層先採薄覆蓋，後續強化追蹤於 [issue #16](https://github.com/DemianLi/nexus-agent/issues/16)，Phase 0–5 全部完成後啟動 |
| 4 | 選型決策點 | 模型供應商、狀態儲存後端保留為決策點，於 Phase 0 / Phase 3 收斂（見第 7 節） |

核心路線：**不從零重造**。deepagentsjs 已內建虛擬檔案系統（可插拔 backends）、宣告式檔案權限、MCP 工具接入、subagents、TodoListMiddleware（opt-in）、SummarizationMiddleware、skills（SKILL.md 標準）、memory（AGENTS.md）、human-in-the-loop（`interrupt_on`）、typed streaming。需求約七成由基座覆蓋；自建部分為 plugin 統一註冊、結果校驗、可觀測性接線、web UI。

## 1. 萬物皆可插件的落地定義

deepagentsjs 的擴充入口原本分散（`tools=`、`middleware=`、`backends=`、`subagents=`、`permissions=`、`interrupt_on=` 各傳各的）。nexus 的差異化價值是收斂成單一契約：

```
NexusPlugin = {
  name, version,
  provides: {
    tools?,        // 自訂函式 / LangChain tools / MCP servers
    middleware?,   // 前處理、結果校驗、summarization、自訂行為
    backends?,     // filesystem backend（in-memory / disk / store / composite）
    subagents?,    // 專職 subagent 定義
    skills?,       // SKILL.md 目錄
    memory?,       // AGENTS.md 來源
    permissions?,  // 讀寫 glob 規則（allow/deny，first-match-wins）
    interrupts?,   // 哪些工具要人工核准
  }
}
```

- 一個 plugin = 一個 npm package 或 workspace 模組，manifest 以 zod 驗證。
- `PluginRegistry` 統一載入、偵測衝突、折疊成 `createDeepAgent(...)` 參數。
- 換模型、換儲存、換工具組合 = 換 plugin 清單，core 不動。此契約同時滿足補強項 6「業務邏輯解耦」。

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
| 基座 | `deepagents`（deepagentsjs，官方 TS） | v0.7.x，鎖 minor 版本追蹤 |
| 核心 | `@langchain/core`、`langchain`（createAgent middleware API） | LangChain JS 1.x |
| 執行 | `@langchain/langgraph` | interrupts、checkpointer、store |
| 工具 | 內建 MCP 支援 + `@langchain/core` tools + zod | |
| 觀測 | `@langchain/langsmith`（tracing + evaluators） | 補強項 4 |
| 模型 | **決策點**：Anthropic（prompt caching 自動）/ OpenAI / DeepSeek（`@langchain/deepseek`） | Phase 0 驗證後定，預設 Anthropic |
| 狀態儲存 | **決策點**：Phase 0 用 `MemorySaver`，Phase 3 評估 `@langchain/langgraph-checkpoint-postgres` | 補強項 5 |
| Sandbox | deepagentsjs sandbox providers（`SandboxBackendProtocolV2`）+ QuickJS interpreter | Phase 2 之後，安全優先 |

## 5. 開發階段

每個 PR 照 repo 流程：`<type>/<kebab-case>` 分支 → squash 進 develop，PR 標題 `<type>: <中文描述>`（見 [AGENTS.md](../AGENTS.md)）。以下 PR 切分為建議粒度。

### Phase 0 — 技術驗證（spike，1 個 PR）

- `feat/harness-deepagents-spike`：安裝 deepagentsjs，最小 agent（in-memory backend + 一個 custom tool）跑通；驗證模型供應商接線與 streaming；確認 Node 22 相容性。
- 驗收：CLI 下一個指令 → agent 呼叫工具 → 寫虛擬檔案 → 回覆；技術驗證記錄寫進 PR 內文「驗證方式」。

### Phase 1 — 核心迴圈 + Plugin 契約（約 3–4 個 PR）

- `feat/nexus-plugin-contract`：`NexusPlugin` 型別 + zod manifest 驗證 + `PluginRegistry`（載入、衝突偵測、折疊成 `createDeepAgent` 參數）。
- `feat/agent-factory`：agent 工廠 + 訊息標準化入口；淘汰舊 step runner。
- `feat/harness-cli`：基本 REPL/CLI，作為後續 phase 的手動驗證工具。
- 驗收：兩個假 plugin（各提供一個 tool）能用一份 plugin 清單組出可跑的 agent；registry 邏輯有單測覆蓋。

### Phase 2 — 工具層 + 權限（約 3 個 PR）

- `feat/mcp-plugin`：第一個正式 plugin——MCP server 工具接入。
- `feat/fs-backends`：filesystem backends（State → Disk → composite routing）+ `permissions` 擴充點（glob 規則、subagent 繼承）。
- `feat/sandbox-plugin`：sandbox `execute` 工具（或先只做 QuickJS interpreter，shell 沙箱隔離方案明朗前不開）。
- 驗收：agent 能經 MCP 讀外部資料並寫入受權限控管的虛擬 FS；deny 規則擋得住 `.env` 類路徑。

### Phase 3 — 記憶層（約 3 個 PR）

- `feat/memory-plugin`：AGENTS.md memory + backend 選型落地（狀態儲存決策在此收斂）。
- `feat/skills-plugin`：SKILL.md 載入與 progressive disclosure。
- `feat/summarization-tuning`：SummarizationMiddleware 參數化（長任務 token 控制）。
- 驗收：跨 thread 記憶保留；長對話在 token 上限內完成多步任務。

### Phase 4 — HITL + 可觀測性 + 反思（約 3 個 PR）

- `feat/interrupt-rules`：`interrupts` 擴充點（哪些工具暫停核准）—— 補強項 1。
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
| Human-in-the-loop | Phase 4 `interrupts` 擴充點 + Phase 5 web 核准 UI |
| 權限控制 | Phase 2 filesystem permissions +（延後）sandbox 隔離 |
| 可靠性 | Phase 4 validation middleware + Phase 5 eval suite |
| 可觀測性 | Phase 4 LangSmith + streaming |
| 狀態儲存選型 | Phase 0 暫定 MemorySaver → Phase 3 收斂 |
| 業務邏輯解耦 | NexusPlugin 契約本身（全程貫徹） |

## 7. 風險與決策點

1. **deepagentsjs 演進速度快**：v0.7 才把 task planning 改為 opt-in，API 可能持續變動。對策：鎖 minor 版本、Phase 0 spike 先驗、接觸面集中在 agent 工廠一處。
2. **模型供應商決策（Phase 0）**：Anthropic 功能最全但成本高；DeepSeek 便宜但需驗證工具呼叫品質與 middleware 相容性。Phase 0 兩者都跑基本驗證再定。
3. **shell sandbox 安全**：`execute` 工具本質是跑任意指令，且權限規則對 sandbox backend 不生效。先只用 QuickJS interpreter，shell sandbox 延後到有明確隔離方案（容器）再做。
4. **結果校驗範圍（Phase 4 前）**：需定義「校驗什麼」——schema、不變量、還是業務規則。屆時拍板。
