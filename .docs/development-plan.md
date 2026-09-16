# nexus-agent 開發計劃：萬物皆可插件的 Deep Agents Harness（TypeScript）

狀態：方向已確認（2026-08-23）。
需求基準：《企業級 AI Agent 系統架構與 Harness 開發範圍說明 v1.0》（deepagents 1.13.1 / LangChain JS 1.5.x / LangGraph JS 1.4.x）。

<a id="verdicts"></a>

## 結論速查

**這張表只回答一件事：某個決定有沒有拍板、結果是什麼。** 理由住在指向的那一節，不重述。

**它的存在理由是上下文成本**：切檔前本檔 98,379 字元，而分布極不均——§5 一節就佔 62%，要知道一個決定拍板了沒，最少得讀數千字元。**[#364](https://github.com/DemianLi/nexus-agent/issues/364) 把最大的三塊切了出去，本檔降到約 40,000 字元（-59%）**；這張表是那次切檔的另一半——切檔讓每次讀取變小，這張表讓「要不要讀」零成本可答。

（2026-09-16 更正：切檔前的量測原本寫「~11,000 字元」，那是 bytes 誤標成字元——量的容器 locale 未設、`wc -m` 退回算 bytes，CJK 一字三 bytes。比例不受影響，絕對值原本誇大約 1.7 倍。）這張表把那個答案搬到零次額外讀取的位置。

**與「一個事實一個家」的關係**：結論在這裡出現第二次，理由仍然只有一個家。刻意的——結論放兩處的**不一致是看得見的**，而「要讀一萬字才知道有沒有答案」的失敗是**無聲的**。這張表與它指向的那一節不一致時，**以那一節為準並修正這裡**。

### §0 已確認的決策

| # | 決策 | 結論 |
| --- | --- | --- |
| 1 | 技術棧 | **全 TypeScript**：LangChain JS ＋ LangGraph JS ＋ deepagentsjs，零 Python 基座 |
| 2 | 插件化程度 | **迴圈固定，不 fork**。對 dsh 的偏離已登記（2026-09-16，[#356](https://github.com/DemianLi/nexus-agent/pull/356)）：dsh 連 agent loop 都是可換的 Cordis plugin，**deepagents 表達不出來**——`createDeepAgent` 建出來的圖建構後不可變 |
| 3 | 兩層薄覆蓋 | 反思與反饋層、意圖與理解層維持薄覆蓋，追蹤於 [#16](https://github.com/DemianLi/nexus-agent/issues/16)；該卡原列的自我批判／意圖分類兩方向**在 dsh 全樹不存在，而它做了別的**（計劃模式＋todo＋goal）——§2 明文限縮過：能主張的是「不存在、做了別的」，**不是「dsh 拒絕過」** |
| 4 | 模型選型 | **已收斂**：`nvidia/nemotron-3-super-120b-a12b`。2026-08-28 首次定案為 `openai/gpt-oss-120b`，該 id 2026-09-03 下架（410／EOL），2026-09-04 重盤重選（[#165](https://github.com/DemianLi/nexus-agent/issues/165)） |

### §7 風險與決策點

| # | 題 | 結論 |
| --- | --- | --- |
| 1 | deepagents 演進速度 | **風險，不是決策點**。手段三樣：`~1.13.1` 擋 minor、`strictPeerDependencies` 讓 peer 抬升當場爆、升版檢查清單（[#31](https://github.com/DemianLi/nexus-agent/issues/31) 那四項人工驗證）。**擋不住 patch**，而 v3 `streamEvents` 是 experimental |
| 2 | 模型供應商 | **已關閉**（2026-08-28，修訂 2026-09-04）。射程窄：是「這把 key 叫得動的裡最划算的」，不是「最好的模型」；**Anthropic 從來沒進過場**；Phase 2 那道「不相容則 DeepSeek 出局」的閘門**至今沒跑過**，錨在 [#61](https://github.com/DemianLi/nexus-agent/issues/61) |
| 3 | shell sandbox | **延後**到有明確隔離方案（容器）。QuickJS 走 custom tool 而非 sandbox backend——基座不讓 `permissions` 與 sandbox backend 共存 |
| 4 | 狀態儲存 | **三軸拆開，只做了不在三軸上的第四軸**。會話日誌落地（[#172](https://github.com/DemianLi/nexus-agent/issues/172)／[#174](https://github.com/DemianLi/nexus-agent/issues/174)，`--session-log <dir>`）；`backend` 由 `feat/memory-plugin` 收斂；**checkpointer 與 store 兩軸零消費者，判過不做**（[#155](https://github.com/DemianLi/nexus-agent/issues/155)） |
| 5 | 結果校驗範圍 | **已拍板：只收 schema**（Phase 4，2026-09-11 回填）。不變量與業務規則不在內 |
| 6 | `apps/web` 傳輸 | **已拍板**（Phase 5）：上行 HTTP POST，下行單向事件串流；載體先做 SSE，WebSocket 覆寫留到需要時。依據是 dsh 的實際做法 |

### 其他

| 主題 | 結論 | 住哪 |
| --- | --- | --- |
| Phase 0–5 | **全部宣告完成**（Phase 5 於 2026-08-28 由 demian 拍板） | §5 |
| 六大補強項的落點 | 見對照表；**狀態儲存選型**那一列的結局已被 §7 第 4 項改寫 | §6 |
| **切出去的三份** | Phase 3 → [`development-plan-phase-3.md`](development-plan-phase-3.md)；Phase 5 → [`development-plan-phase-5.md`](development-plan-phase-5.md)；§7 風險與決策點 → [`development-plan-risks.md`](development-plan-risks.md) | #364 |
| 今天還缺什麼（對照 dsh 51 套件） | 見 [`plugin-architecture-gap-survey.md`](plugin-architecture-gap-survey.md) 的**結論速查** | 另一份 |

**這張表最可能的錯法不是寫錯結論，是壓掉限縮。** 建這張表時就踩到一次：§2 對「#16 兩個方向被 dsh 否掉」明文限縮過「能主張的是不存在、做了別的，不是拒絕過」，而第一版的表格把它壓回「已被 dsh 否掉」。**一列讀起來比它指向的那一節更有把握時，那一列就是錯的。**

**這張表沒有絆索守著**——掃自己散文的結構 gate 會永遠綠（理由見 gap-survey §五第 7 條的慣例）。改動任一節的結論時，同一張 PR 改這裡。

## 0. 已確認的決策

| # | 決策 | 內容 |
|---|---|---|
| 1 | 技術棧全 TypeScript | LangChain JS + LangGraph JS + deepagentsjs（官方 TS 版），零 Python 基座 |
| 2 | 插件化程度 | agent 推理迴圈為固定基座（deepagentsjs），迴圈周圍的擴充點全部走 NexusPlugin 契約；不 fork、不做「連迴圈都可替換」的徹底插件化。**對 dsh 的偏離（標註，2026-09-16 補）**：dsh 的定位是「不存在需要打补丁的特权内核」，模型適配器、工具註冊表、會話日誌連同 agent loop 本身都是 Cordis plugin，都能從設定換掉（`docs/architecture.zh.md:11-13`）。**deepagents 表達不出來**：迴圈是 `createDeepAgent` 建出來的圖，建構後不可變，不 fork 就換不掉。退到最接近的：迴圈固定，迴圈外的擴充點收成單一契約。其餘各項對照見第 1 節「與 Cordis 的對照」 |
| 3 | 兩層薄覆蓋 | 反思與反饋層、意圖與理解層先採薄覆蓋，後續強化追蹤於 [issue #16](https://github.com/DemianLi/nexus-agent/issues/16)，Phase 0–5 全部完成後啟動 |
| 4 | 選型決策點 | 模型供應商**已收斂**（2026-08-28）：**`openai/gpt-oss-120b`**，走 NVIDIA 的 OpenAI 相容端點。**2026-09-04 修訂：那個 id 已於 2026-09-03 下架**（410，EOL 帶日期，型錄上也沒有了），重盤重選之後是 **`nvidia/nemotron-3-super-120b-a12b`** —— 這次品質沒有打平（難題 0.98 對 0.92–0.93），它同時拿下延遲與多叫次數，只輸 token。見 [#165](https://github.com/DemianLi/nexus-agent/issues/165)。**決策點 2 不因此重開**：換的是 id 不是供應商，端點與方法都沒變。原本的三段收斂（Phase 0 定預設 Anthropic、Phase 2 驗 DeepSeek 相容性、Phase 5 比品質與成本）只走完第一段與第三段，**中間那段從沒跑過**，而第三段的結果讓它失去了對象 —— 詳見第 7 節決策 2。狀態儲存**不是一個後端而是三個正交的軸**（checkpointer／store／backend），Phase 3 分別收斂（見第 7 節決策 4） |

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
- **九個註冊點之外有六條不折疊的通道，第一條是 `lifecycle`**（`registry.lifecycle.onDispose(fn)`，`feat/mcp-plugin`；其餘五條 `telemetry` / `invariants` / `commands` / `sessions` / `feedback` 是後來各自的 PR 加的，總表見 `packages/nexus-core/src/registry.ts` 檔頭）。它**不是第十個註冊點**：九個註冊點回答「這個 agent 由什麼組成」、會折進 `createDeepAgent` 的參數，這條回答「這些東西怎麼收掉」、什麼都不折。`loadPlugins()` 因此多回一個 `dispose()`，組裝點的 `createNexusAgent()` 跟著回 `{ agent, dispose }`。引進它的是 MCP：MCP server 是外部程序，stdio 子行程的 pipe 是活的 handle，沒人關的話 CLI 印完答案不會退出（實測：拿掉 `dispose()` 之後 `pnpm --filter @nexus/harness run cli --plugins src/cli-mcp.fixture.ts` 停在那裡不動）。**回滾與關機是兩條路**：`apply` 中途拋錯時的資源釋放由 plugin 自己的 `try` / `catch` 負責——dsh 的 `ctx.effect` 一個函式兼兩職，那靠的是 Cordis 的 context 樹，我們沒有。**載入失敗時仍然收**：靠前的 plugin 已經開好的東西由 `loadPlugins()` 在拋出之前收掉，因為失敗的呼叫端拿到的是 exception、不是 handle（註冊內容則刻意留著，診斷要有東西可看）。
- 共同軸線：**同層報錯、跨層遮蔽、fail-closed、載入期失敗**。「層」指全域（root agent）↔ 各 subagent。**`subagents` 註冊點自己沒有層**：deepagents 的 `SubAgentBase` 沒有巢狀 subagents 欄位（`name` / `description` / `systemPrompt` / `mode` / `tools` / `model` / `middleware` / `interruptOn` / `skills`），遮蔽在那裡表達不出來，所以 subagent 只有全域一層、同名一律報錯。
- **組裝點所有、plugin 不得提供**：default backend、工具呈現順序、model、checkpointer / store、核准政策的 session 開關。
- 換模型、換儲存、換工具組合 = 換 plugin 清單，core 不動。此契約同時滿足補強項 6「業務邏輯解耦」。

三點要特別記著：

- **`permissions` 不是授權邊界，是意外防護。** 它只覆蓋 `FILESYSTEM_TOOL_NAMES` 那八個內建工具裡「當前 backend 實際註冊的那些」，而且基座無規則命中即 allow。真正的檔案圍堵靠換 backend（Phase 2 `feat/fs-backends` 已落地 `ContainedFilesystemBackend`，[#34](https://github.com/DemianLi/nexus-agent/issues/34)）。而**外部 MCP server 的工具連 backend 都不經過** —— deepagents 明文「custom tools from the agent or other middleware are left untouched」，所以那些工具自己碰檔案系統不在任何管束範圍內。這是一條明文限制，不是待補的功能。
- **`interruptOn` 的核准詞彙是封閉的。** plugin 只能貢獻 `{ toolName, reason, when? }`；`allowedDecisions` 由 harness 固定為 `["approve", "reject"]`，`argsSchema` 不使用（dsh 明文「Input rewrite is deliberately not offered」）。宣告了需核准的工具卻沒有 checkpointer，registry 要在載入期報錯——缺席即拒絕，不是放行；**核准政策的 session 開關關著卻有人宣告要核准，同樣報錯**，因為沒人回答的中斷只會把 agent 掛在那裡，靜默丟掉那些標記則是把政策解除武裝。全域的核准標記也**主動併進每個 subagent**，理由與 deny 同一條：基座是 `agentParams.interruptOn ?? defaultInterruptOn`，自帶設定的 subagent 會把全域那些整組蓋掉。
- **工具呈現順序要自建。** deepagents 沒有對應機制，dsh 有專門的 Agent Note（註冊順序造成過真實 CI flake）。組裝點要有一份顯式清單＋`'<unlisted-tools>'` rest entry＋字典序預設，屬 Phase 1 `feat/nexus-plugin-contract` 的範圍。

**與 Cordis 的對照**（2026-09-16，dsh `0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`）。dsh 的定位與解耦都靠 Cordis（`docs/cordis-primer.zh.md`）；我們沒有 Cordis，下表逐項記哪些照學、哪些退了、退到什麼。每一項的理由住在出處那張卡上，這裡不重述。

| Cordis 的做法 | 我們 | 出處 |
| --- | --- | --- |
| plugin 是命令式的 `apply(ctx)` | 照學：`apply(registry)` | [#28](https://github.com/DemianLi/nexus-agent/issues/28) 決議 9 |
| 產品每一部分都是 plugin，包含 agent loop | 偏離：迴圈固定 | 第 0 節決策 2 |
| context 是服務容器：plugin 以 `ctx.<key>` 查別人的服務，不 import 實作 | 退到相依隔離：plugin 只相依 `@nexus/core`，由 pnpm 機械保證；**plugin 之間沒有服務查找** | [#30](https://github.com/DemianLi/nexus-agent/issues/30)；代價見下 |
| `inject` 宣告服務相依，載入順序由相依決定 | 退到存在性檢查：`requires` 只查能力在不在、不排序，順序由清單承擔 | [#28](https://github.com/DemianLi/nexus-agent/issues/28) 決議 10 |
| 型別化事件，五種分派模式（`emit`／`waterfall`／`parallel`／`serial`／`bail`） | 退到 LangChain middleware 鉤子 ＋ `approvals.gate` waterfall ＋ 會話日誌事件；事件匯流排判為範圍外 | [#190](https://github.com/DemianLi/nexus-agent/issues/190) |
| 註冊是可逆副作用，reload 與 teardown 時撤銷 | 部分：每次註冊回 undo，射程只到載入期回滾；關機另走 `lifecycle` | 本節上文 |
| profile、組合包、patch 按條目 id 疊層，`--dump-config` 印得出整棵樹 | 部分：條目有 `id`／`disabled`，設定收在閉包裡，從外部覆寫不做 | [#104](https://github.com/DemianLi/nexus-agent/issues/104)、[#46](https://github.com/DemianLi/nexus-agent/issues/46) |

**沒有服務查找的代價：服務的定義只能住在 core。** Cordis 裡任何 plugin 都能占一個新的 `ctx.<key>` 給別人用；我們這側 plugin 只能往 core 已經開好的格子裡放東西。所以兩個元件要協作只剩兩條路：一是**組裝點用閉包把同一顆物件交給兩邊**——`apps/harness/src/cli.ts` 把同一顆 `SandboxModeController` 同時交給 `ContainedFilesystemBackend` 與 sandbox-policy plugin，把 backend 交給 submit-record；二是**core 先開一格**——上文九個註冊點之外的六條通道都是 core 擁有介面、plugin 往裡放。上文「換 plugin 清單，core 不動」因此只對彼此不協作的 plugin 成立；需要協作的配對，不是組裝點知道，就是 core 多一格。

**`requires` 今天沒有人用。** `packages/` 底下 7 個 plugin `provide` 能力（含示範用的 `@nexus/plugin-echo`），產品程式碼裡沒有任何條目宣告 `requires`，只有 `apps/harness/src/agent-factory.test.ts` 用它測機制本身。

**事件那一列真正缺的不是匯流排。** #190 查過：dsh 的 `send()`／`steer()`／`inject()` 是同一個「帶邊界、選擇叫不叫醒」的 `UserMessage` 佇列的三個預設，我們缺的是那個佇列；今天沒有「把一步塞進正在跑的迴圈」的消費者，所以不補。

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
**（2026-09-12 補：這筆偏離收回了。**「拿不到 `SessionLog`」後來證明是錯的，而日誌耐久化、
有了讀方之後，留著它的代價是續接回來計劃模式會悄悄關掉——[#251](https://github.com/DemianLi/nexus-agent/issues/251)
的第二刀把模式搬回 `plan/mode`。原文保留，因為下面 #118 那段的論證是以它為前提寫的。）

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
packages/nexus-core      契約：NexusPlugin 型別、zod manifest、PluginRegistry 九個註冊點 ＋ 六條通道、fold
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
| 模型 | **2026-09-04 起是 `nvidia/nemotron-3-super-120b-a12b`**（[#165](https://github.com/DemianLi/nexus-agent/issues/165)：前一個下架了，重盤重選；這次品質沒打平，難題 0.98 對 0.92–0.93）。**以下是 2026-08-28 定案時的原文，照留** —— **`openai/gpt-oss-120b`**，經 `@langchain/openai` 指向 NVIDIA 的 OpenAI 相容端點（2026-08-28 定案）。**原本寫的是預設 Anthropic、唯一備選 DeepSeek，兩者都沒有留下來** | **三輪獨立測量**（四條難題 × 2 次 → 兩條難題 × 6 次 → 四條難題 × 6 次）都是同一個結果：品質五階打平（四條難題上 `0.92`–`0.96`，判準沒飽和），所以選型落回成本 —— 這一個 token 最省（少四到五成）、多叫最低、品質並列第二。（第三輪一度量到它「跑不完難題」，**那個判斷已更正撤回** —— 是端點限流加上基座不重試，接住之後重跑 42 次零失敗、難題全部滿分。詳見第 5 節 Phase 5。）**Anthropic 那條路從頭到尾沒有被建起來**（`@langchain/anthropic` 不在任何 `package.json` 裡），所以它不是被比下去的，是**從來沒有進過場**；要重新排入評估得先補那段接線。見第 5 節 Phase 5 與 [#31](https://github.com/DemianLi/nexus-agent/issues/31) |
| 狀態儲存 | **2026-09-05 修訂：這一格少了一軸，而少掉的那一軸已經先落地了** —— 見第 7 節決策 4 的補記（[#155](https://github.com/DemianLi/nexus-agent/issues/155)）：下面三軸問的都是「LangGraph 的狀態存在哪」，**會話事件日誌不在其中任何一軸上**，它已於 [#172](https://github.com/DemianLi/nexus-agent/issues/172)／[#174](https://github.com/DemianLi/nexus-agent/issues/174) 落盤（CLI 與 `serve` 的 `--session-log <dir>`）。**以下是原文，照留。** **決策點，而且是三個正交的軸，不是一個**：`checkpointer`（thread 內的對話狀態）／`store`（跨 thread 的 `BaseStore`，`StoreBackend` 用它）／`backend`（檔案落在哪——AGENTS.md、skills、`/conversation_history` 都住這裡）。Phase 0 的 `MemorySaver` 只覆蓋第一軸。`@langchain/langgraph-checkpoint-postgres@1.0.5` 同一個套件收前兩軸（`.` 出 checkpointer、`./store` 出 `PostgresStore`（實測 1.0.5 的 tarball，不是照子路徑名推的），peer 是 `@langchain/core ^1.1.44` ＋ `@langchain/langgraph-checkpoint ^1.1.4`，與我們現有範圍相容）；第三軸是 backend plugin 的事 | 補強項 5 |
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

**整節搬到 [`development-plan-phase-3.md`](development-plan-phase-3.md)**（#364）。

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
  - **排序缺口，記著不補。** `MiddlewareRegistrationPoint` 只有 `prepend` 一根槓桿，給的是「最外」；「最內」現在只是「沒 prepend 而且剛好註冊在最後」，沒有任何 plugin 有義務尊重它。這一版釘住現況，加槓桿留給真的有第二個 plugin 要搶位置的時候。**2026-09-13（[#252](https://github.com/DemianLi/nexus-agent/issues/252)）這個缺口跟著校驗器一起收掉**：它搬進 core、由 fold 打底，位置不再靠註冊順序。偏離①的載體從「plugin 的一張表」換成「註冊時選帶」，偏離本身照舊。
- 驗收：**破壞性操作必須人工核准才執行**（已有可執行證據，見上）；~~LangSmith 能看到完整 trace~~ **→ tracing 開沒開、送去哪、送出去的東西脫敏到什麼程度，這三件事說得出來**（已有可執行證據，見上——原句驗過之後發現它問錯方向了）；~~校驗失敗的工具結果會帶錯誤回饋給 agent 重試~~ **→ 工具失敗（拋錯或輸出不合宣告的 schema）都變成帶更正回饋的 error ToolMessage，而且那一輪不會因此中止**（已有可執行證據，見上——原句預設了「回饋」是要加的東西，實測它本來就在，被我們自己踩掉了）。

### Phase 5 — Web UI + 評測（約 3–4 個 PR）

**整節搬到 [`development-plan-phase-5.md`](development-plan-phase-5.md)**（#364）。

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

**整節搬到 [`development-plan-risks.md`](development-plan-risks.md)**（#364）。六個決策點的結論見本檔置頂的結論速查。

