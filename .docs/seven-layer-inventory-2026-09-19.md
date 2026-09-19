# E·T·C·L／O·V·G 七層盤點（重做，2026-09-19）

- dsh 基準：`ddefc45`（上游 master，2026-09-17，ls-remote 確認沒有新 commit）
- 我們：develop `c1857a8`
- 判準：dsh **出廠**有（base 列 **或** 任一出廠 preset 列 **或** 模式 bundle 列）、我們沒有、也沒判過不做 → 缺口。
- 每格帶 `檔:行` 或 issue／決策編號；沒有的就是回想，不收。


> **後續處置（2026-09-19）**
>
> - **缺口 8 項**：已開卡 #430–#437（`needs-triage`）。
> - **沒判過的 9 題**，加上 #180 前提重核、`document`、「core 的能力要不要拆成 plugin」，共 12 題：demian 照建議拍板，逐題的理由與後續卡號見 [`decisions-2026-09-19.md`](decisions-2026-09-19.md)。
> - **#387 瀏覽器會話認證的重開條件已觸發**（部署主機是多人共用的）：由 #424 處理（PR #438）。
> - **單一職責盤點**另見 [`srp-audit-2026-09-19.md`](srp-audit-2026-09-19.md)。
>
> 這份報告對的是 develop `c1857a8`，行號以當時為準。調研筆記要改的 9 處已由 #423 處理。

## 工作筆記

### 出廠清單（dsh ddefc45）
- base：`packages/bundle/base/cordis.patch.yml` 89 列（disabled：tool-plugin-manager、skill-badge、tool-ralph；平台二選一：bash/pwsh 各兩列）
- web-app：`packages/bundle/web-app/cordis.patch.yml` 主機列＋client 列；**agent 平面整批 disabled**（:394–503），改由 preset 掛（:512-516 `agent-presets` default standard）
- 四個 preset：`packages/preset/agent-presets/presets/{standard,ptc,cordis,minimal}/agent.cordis.yml`
  - standard 新增 base 沒有的：`persona`、`tool-ask-user`（:245）、**`present`（:261，dsh-tool-present，deliverables）**
  - ptc：`tool-presentation`（:277）；workflow 兩列 disabled
  - cordis：`tool-cordis`（:260）、`tool-plugin-manager` 開著（:282）
  - minimal：持久 shell（pty `dsh-terminal`＋`tool-bash-persistent`）
- mcp-client 不在任何出廠列：`packages/mcp/README.zh.md`「只需配置 mcp-client 条目；随附 profile 已统一挂载 mcp-resources」→ 使用者設定
- **browser-use／computer-use／ssh**：`grep -rn` 掃 `packages/bundle`、`presets`、`apps/cli/src` 零命中 → 不出廠（E 欄「dsh 也沒有」成立，這次是數完 preset 後成立）
- 名字差集（筆記 §三 51 列 vs 54 目錄）：筆記有、dsh 沒了＝`code-runtime`（改名 ptc-runtime）、`e2b`、**`examples`（整個 repo 0 檔，上次沒抓到）**；dsh 新增＝browser-use、computer-use、deliverables、document、ptc-runtime、ssh

### 我們的產品路徑（c1857a8）
- `DEFAULT_PLUGINS`（`apps/harness/src/cli.ts:538`）：echo、agent-instructions、plan-mode、goal、todo、feedback ＋ 16 顆不變量 plugin
- 組裝點再加（`cli.ts:857-867`）：ask-user、submit-record、sandbox-policy（有 `--workspace` 才加）
- core fold（`packages/nexus-core/src/fold.ts:669-712`）：containment、turnCancel、approvalGate、observationPolicy（先讀後改）、summarizer、repeatReminder、modelCalls、modelUsage、outputSchema、fsToolErrors、invalidToolArgs、turnCancelModelSignal
- **`--plugins <module>` 是整份換掉**（`cli.ts:1332`、`serve.ts:211`），不是加上去 → **mcp、skills、quickjs、memory 四個功能，以及 telemetry-otel 的後端，都是選配**，零設定的 CLI／serve 上不存在（測試與 fixture 以外零掛載）。它們的不變量伴生倒是都在 DEFAULT_PLUGINS 裡。`@nexus/plugin-validation` 不在此列：它是相容殼，輸出校驗與圍堵已搬進 core、fold 預設開（README）。上次盤點把這些列成「已經有」沒標選配。

## E 執行環境

| 項目 | dsh 出廠 | 我們 | 結論 |
|---|---|---|---|
| 檔案效果邊界（工作區圍堵） | `fs-sandbox`（base :504）＋`sandbox-policy`（:215） | `ContainedFilesystemBackend`（`apps/harness/src/contained-backend.ts:303`），**要 `--workspace` 才在路徑上**（README:48） | 有（條件式） |
| 三種模式＋執行期切換 | `permission` 三個 preset（:236）、`/sandbox` | `SandboxMode`（`packages/nexus-core/src/sandbox.ts:30`）、`SandboxModeController`（`apps/harness/src/sandbox-mode.ts:121`） | 有 |
| 權限升級 | bash-sandbox 的升權事實 | `request_sandbox_escalation`（`apps/harness/src/sandbox-escalation.ts:66`），一次性、綁檔 | 有 |
| 模型看得到政策 | `sandbox-policy` 的模型上下文 | `createSandboxPolicyPlugin`（`apps/harness/src/sandbox-policy.ts:105`） | 有 |
| 先讀後改 | `fs-observation-policy`（:264） | `createObservationPolicy`（`packages/nexus-core/src/observation.ts:175`），fold 預設開 | 有 |
| 子代理繼承沙箱 | — | #326（ALS 包 `task`） | 有 |
| 行程隔離（bwrap／Seatbelt）＋shell／subprocess／terminal | `sandbox`、`subprocess`、`bash-sandbox`、`tool-bash`（base）；minimal 的 pty；web-app `terminal-controller` | 沒有。基座 `execute` 在非 sandbox backend 上執行期濾掉（deepagents dist `langsmith-*.js:2303`、:2372 註解） | **判過不做**：決策 3 延後到有容器方案（`development-plan.md` §7 第 3 列） |
| 程式碼執行 | `ptc-runtime`（全新 Node 行程＋會話 fs 沙箱） | `@nexus/plugin-quickjs`（WASM 直譯器、timeout／memory 上限），**選配** | 部分；偏離已登記（`development-plan.md:271`） |
| 瀏覽器／電腦操作／SSH | 套件在、**不出廠** | 沒有 | 框架要、dsh 也沒有（出廠意義上） |
| microVM／容器 | 沒有（e2b 已移除） | 沒有 | 框架要、dsh 也沒有 |
| MCP stdio 子行程 | mcp-client 在 fence 外跑（使用者設定） | 同樣在 fence 外；**選配** | 同形 |

症狀「沒有沙箱就執行了破壞性指令」的守衛：模型沒有 shell（基座 execute 被濾）；檔案變更由 fence 擋——`contained-backend.test.ts`、`sandbox-mode.test.ts`、`subagent-sandbox.test.ts`、`submit-record-sandbox.test.ts`。**無守衛的一格：沒給 `--workspace` 時根本沒有 fence**（檔案在 StateBackend 虛擬 fs，寫不到真碟，所以破壞面是零——不是缺口，但要講清楚）。

## T 工具介面

| 項目 | dsh 出廠 | 我們 | 結論 |
|---|---|---|---|
| 工具註冊表、撞名檢查、排序 | `tools`（base :485） | `registry.tools`、`assertNoBaseToolNameCollision`（`apps/harness/src/agent-factory.ts`）、`toolOrder`、`RESERVED_BASE_TOOL_NAMES`（`apps/harness/src/base-tools.ts:87`） | 有 |
| 參數與輸出校驗、失敗不中止輪次 | `tools` 流水線 | `invalid-tool-args.ts`、`output-schema.ts`、`containment.ts`（fold.ts:684-711） | 有 |
| 工具逾時 | `timeout-policy`（base :387） | `containment.ts:240` 發 `TOOL_TIMEOUT`；只武裝有宣告預算的工具（:151） | 有（§五第 2 條「收完」） |
| 逐 agent 工具 allow/deny | `ctx.tools.restrict()`（`packages/core/tools/README.zh.md:79-81`）；`tool-subagent` 的 `toolFilter` 設定（`tool-subagent/src/index.ts:126`），**出廠 preset 沒設** | 只有 root-only 樁（fold.ts:1036-1050） | 已登記：#328 第 3 項（needs-triage） |
| MCP 工具 | `mcp-client`（使用者設定，出廠無 server） | `@nexus/plugin-mcp`，**選配**（只在 `cli-mcp.fixture.ts` 掛過） | 有，同形 |
| MCP resources | `mcp-resources`（base :478，出廠掛） | 無；只有 `packages/nexus-plugin-mcp/README.md:87`「延後」 | **缺口**（筆記、issue 都沒登記） |
| MCP server instructions | `mcp-client` 連線時把指令放進系統提示詞（`mcp-client/README.zh.md:188-200`，上限 32,768 bytes） | 無（plugin src grep `instructions` 0 筆） | **缺口**（上次併在 resources 那條，這次拆開：README 連「延後」都沒寫） |
| MCP prompts | 不支援（`mcp-client/README.zh.md:12`） | 延後 | 同形 |
| web_search／web_fetch | `web`＋`web-search-deepseek`＋`web-fetch-http`＋`tool-web`（base :447-475）；standard／ptc／cordis preset 都掛 `tool-web` | 無 | **未判**：筆記 §三第 48 列歸「企業級」站不住。候選結論：內網部署，照 dsh 自己寫的「stricter network policy 的產品覆寫 tool-web」（base :447-449 註解）登記不掛——要 demian 拍板 |
| skills | `skill`＋`skill-filesystem`＋`tool-skill`（base :280-290），三個 preset 都掛 | `@nexus/plugin-skills` 有預設來源 `/skills/`（`packages/nexus-plugin-skills/src/index.ts:38`）卻**不在 DEFAULT_PLUGINS**；測試以外零掛載 | **未判**：筆記第 38 列寫「有（薄）」沒標選配——同 #388 的錯（能力不在產品路徑上） |
| 問使用者 | `tool-ask-user`（preset）＋`user-questions`（base :71） | `createAskUserPlugin`（`cli.ts:859`） | 有 |
| 交付檔案 `present` | standard／ptc／cordis preset（`tool-present`，deliverables） | 無 | **未判**（新，上次沒數 preset） |
| 協定：ACP／SDK | `acp-app`、`sdk-app` bundle | 無 | 判過：定位差異（筆記 §三小計） |
| 協定：HTTP＋事件串流 | web-app `connection`（fetch＋SSE） | `@nexus/wire`（POST＋SSE，決策 §7 第 6 列） | 有 |
| A2A | 無（只在 `.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.zh.md:18` 寫「後續」） | 無 | 框架要、dsh 也沒有 |
| tool search／漸進披露 | 無（只是 `docs/cookbook/extension-cookbook.zh.md:120` 的做法） | 無 | 框架要、dsh 也沒有 |
| 把 agent 當 MCP server | 無（ACP 那個是**吃** client 給的 MCP server） | 無 | 框架要、dsh 也沒有 |
| 會話續接／列表／租約 | `session-persistence-jsonl`、`session-controller` | `--resume`、serve 接回、`session-lease.ts`、`session-list.ts` | 有 |
| 會話標題 | `session-title`＋**`session-title-llm`**（base :55-69） | 只有內建回退（`session-list.ts:31-36`） | 部分；LLM 標題未判（小） |
| 會話全文搜尋 | `session-query-sqlite` **出廠 `openAt: never`＝關**（base :136-140） | 無 | 同形（dsh 出廠也關） |
| 斜線命令 | `commands` | `registry.commands` | 有 |
| 產品路徑上的示範工具 | 無 | `echo` 在 DEFAULT_PLUGINS，live 模型也看得到 | 判過：刻意（`cli.ts:451`） |
| 模型看得到的工具 schema 目錄＋新鮮度 gate | `scripts/gen-tool-catalog.ts` 開機收集每顆工具的 name／description／parameters 生成 `docs/tool-catalog.md`，`verify-tool-catalog`（`scripts/run-gates.ts:751`，doc-sync gate）驗新鮮度；另有 README「模型體驗」段 gate（:768） | 無（repo 裡零 snapshot、零目錄） | **未判**（上次寫「dsh 也沒有描述 lint」是錯的：它沒有品質 lint，但有「描述一改就在 diff 裡看得到」的 gate） |

症狀「工具描述模糊導致選錯工具」的守衛：撞名在載入期擋（`cli-collision.fixture.ts`、`assertNoBaseToolNameCollision`）；**描述本身無守衛**——描述改了沒有任何東西會紅，也沒有地方一次看到模型收到的整份工具目錄（dsh 用上面那道 gate 做到後者）。

## C 上下文與記憶

| 項目 | dsh 出廠 | 我們 | 結論 |
|---|---|---|---|
| 工作區指令 AGENTS.md | `agent-instructions`（base :275、每個 preset），每步重讀 | `@nexus/plugin-agent-instructions` 預設掛（`cli.ts:542`，#388）；摘要後補回（#397） | 有；每步刷新判過不做（#389 not planned，重開條件在 issuecomment-5729737608） |
| 自動摘要（token 壓力） | `compaction-basic`（base :327） | `createSummarizer`（`packages/nexus-core/src/summarization.ts:291`），fold 預設開 | 有（筆記 §五第 1 條「收完」） |
| 摘要 prompt 保留意圖與使用者糾正 | 結構化檢查點：Primary Request and Intent（逐字引）、Errors and Fixes、Pending Jobs、Next Step、Critical Context（偏好）、「使用者糾正要忠實保留」（`compaction-basic/src/summarizer.ts:31-68`） | **沒傳 `summaryPrompt`**（`summarization.ts:296-310`）→ 用 deepagents 預設三點通用 prompt（`langsmith-*.js:2645`：topics／decisions／context） | **缺口**（上次列「次要」且未核；這次兩側都核過） |
| 工具輸出修剪 | `tool-result-pruner`（base :404） | `pruneToolResults` 包在摘要器裡（`summarization.ts:342`） | 有 |
| 大輸出外溢 | `spill-local`＋`spill-policy`（base :390-396） | 基座 filesystem middleware 80,000 字元外溢到 `/large_tool_results/`（筆記 §三第 39 列，#151 實測） | 有 |
| 手動 `/compact` | `command-compact`（base :332） | 無 | 判過：登記為偏離（#142；筆記 :266、:275「手動 `/compact`、指定範圍、鎖」） |
| 圖片省略 | `image-offload` | 無（沒有圖片輸入） | 判過：attachment 屬定位差異 |
| 上下文壓力量表 | `token-meter`（base :324） | `model-usage.ts` 逐次 usage 進日誌（#153→#158）；沒有 replay-aware 的量表 | 部分（筆記 §三第 25 列） |
| 重複呼叫提醒 | `repeat-tool-reminder`（base :441） | `repeat-reminder.ts`，fold 預設開 | 有 |
| goal／計劃重新注入 | goal、plan-mode | goal plugin 的 wrapup、plan-mode（DEFAULT_PLUGINS） | 有 |
| 跨會話引用（`@label` 指別的會話，唯讀快照當不受信任背景） | **`session-reference`（web-app :75）** | 無 | **未判**：筆記 §五第 5／7 條判「context 五個非預設」只查 `base/package.json`（:384），web-app 出廠掛了這個；第 2、3 條理由只講 `time-context` |
| `@file` 引用補全 | **`file-reference-local`（web-app :78）** | 無 | **未判**，同上 |
| 模型可寫的長期記憶 | 無出廠；`docs/user/guide/mcp-memory.zh.md` 給三份**預設關**的第三方記憶 MCP 參考設定 | `@nexus/plugin-memory`（基座 memory middleware），**選配**；MCP plugin 也接得上同一批 server | 框架要、dsh 出廠也沒有 |

症狀「任務越跑越久、品質隨窗口塞滿下降」的守衛：摘要觸發與去向（`summarization.test.ts`、`compaction-log.test.ts`）、溢出恢復（`context-overflow.test.ts`）、摘要後指令補回（`agent-instructions.test.ts`）。**無守衛的一格：摘要內容品質**——摘要丟了使用者原始要求或糾正，沒有任何測試會紅（摘要 prompt 用的是基座通用版，見上）。

## L 生命週期與編排

| 項目 | dsh 出廠 | 我們 | 結論 |
|---|---|---|---|
| 單一 agent 迴圈 | `agent-loop`（base :497），可換的 plugin | deepagents／LangGraph（決策 §0 第 2 列：迴圈固定、偏離已登記 #356） | 有 |
| 每輪步數上限 | **無**（`agent-loop` 沒有 maxSteps） | LangGraph `recursionLimit`（`agent-factory.ts:224` 預設 100），撞到回退出碼 2（`cli.ts:1528`，#362） | 有（比 dsh 多一條硬上限） |
| 模型請求重試 | `llm-retry`（base :91） | `live-model.ts` 分類＋`p-retry`，偏離登記一、二（:184、:192） | 有 |
| 取消／核准暫停／續接 | agent-loop、approval、session | `turn-cancel.ts:229`、approval 中斷、`--resume`、serve 接回 | 有 |
| 一輪的結束原因 | `TurnEndReason`：completed／aborted／blocked／**error（LlmFailure）**／**max-tokens**／**interrupted**（`packages/core/session/src/types.ts:200-224`） | 只有 `aborted`（`packages/nexus-core/src/session-log.ts:161-164`）；產品碼零處讀 `finish_reason`（grep 只在 eval 註解） | **缺口：max-tokens**——輸出被截斷時一輪照「正常結束」記，goal 續行不會因此停（dsh `goal-round-driver/src/index.ts:329` 會停）。上次 #3，兩側重核成立 |
| 崩潰孤兒輪補結 | `interrupted` closer：resume 時補上沒結束的那一輪（types.ts:214-220） | 沒有標記；行為那半靠 resume 撤回懸空工具呼叫（`thread-pump.ts:878-911`）＋`session-stats.ts:43` 配對規則 | 部分，未判（小） |
| 耐久檢查點 | `session-checkpoint-policy`（base :399）：每次模型請求前、頂層工具可能產生外部副作用前、下一步前各 flush 一次 | 背景批次窗口＋顯式 flush 只在 goal 輪之前（`goal-driver.ts:282`）；落盤本身是選配（`--session-log`） | **未判**：筆記 §三第 35 列只記「checkpoint-policy 沒有」，沒有結論 |
| 長期目標＋自動續行 | `goal`＋`goal-round-driver`＋`tool-goal`＋`command-goal`（base :299-305、:423），**driver 出廠就掛**（:302）（續行仍要逐 goal 授權，`goal-round-driver/README.zh.md:57`） | `@nexus/plugin-goal` 預設掛；driver 是 `--goal-driver` 旗標、**預設關** | 判過：#180 §五（demian 2026-09-05）。**前提待重核**：#180 寫「dsh 的 driver 是需要刻意掛載的可選消費方」，而 dsh base 出廠就掛；CLI 那條理由（`HEADLESS_APPROVALS` 確定性拒絕→空轉燒到 256 輪）仍成立，serve 那側的理由變弱 |
| 失敗迴圈停損 | `repeat-tool-reminder`（建議性）；goal 輪數上限＋`blockedAfterConsecutiveRounds` | `repeat-reminder.ts`；遞迴上限；`--max-goal-rounds`；`blockedAfterConsecutiveRounds` 預設 3 | 有 |
| 子代理：全新派生 | `subagent-spawn-in-process`＋`tool-subagent` | 基座 `task`＋`foldSubAgents` | 有 |
| 子代理：fork | `subagent-fork-in-process`＋`tool-subagent-fork` | 無 | 判過：認帳不做（筆記 §五第 6 條） |
| 子代理：續行／`send_message`／`interrupt_agent`／`list_agents` | `tool-subagent-control`＋`list-agents`（base :350-353），standard preset `backgroundMode: continuable` | 無 | 已登記：#324「要做時再開卡」 |
| 子代理：逐個選模型 | web-app `subagent-model-selection-settings`、standard `modelSelectionSettings: true` | 無 | 已登記：#328 第 3 項 |
| 深度上限 | 有 | 有（#328「兩邊都有」） | 有 |
| 工作流編排（腳本扇出子代理） | `workflow-ptc`＋`tool-workflow`（base :379-384、standard／cordis preset） | 無 | 判過：需求未出現（筆記結論速查） |
| 背景工作 | `jobs`＋`tool-jobs` | 無 | 判過：需求未出現 |
| 一次性任務模式 | `headless` bundle | `cli "<prompt>"` 跑完就退出 | 有 |
| issue→PR 流水線 | 無出廠；`docs/user/guide/github-review.zh.md` 是選配 overlay（PR ready 時開唯讀評審會話），靠 webhook | 無 | 框架要、dsh 出廠也沒有 |
| 獨立的完成認證 | 無：goal 完成是模型自報；`tool-ralph` 註解明寫「completion is a worker self-report, not an independent evaluation」（base :426-430） | 無 | 框架要、dsh 也沒有 |

症狀「卡在失敗迴圈，或過早停止」的守衛：遞迴上限＋退出碼 2（`cli.test.ts`）、goal 輪數上限（`goal-driver-cli.test.ts`、`goal-driver.test.ts`）、重複提醒（`repeat-reminder.test.ts`）、工具拋錯不殺行程（`tool-throw-orphan.test.ts`）。**無守衛的一格：輸出被截斷**——max-tokens 沒有判別，截斷的回覆記成正常完成，也不會讓 goal 續行停下來。

## O 可觀測與維運

| 項目 | dsh 出廠 | 我們 | 結論 |
|---|---|---|---|
| 事件溯源會話日誌 | `session`（base :40） | `session-log.ts`，一個子代理一份（`SessionRegistry`） | 有 |
| 日誌預設落盤 | `session-persistence-jsonl` 出廠開，寫 `$DSH_HOME/sessions`（base :117-120） | `--session-log <dir>` 才寫，**預設不落盤**（README「會話日誌預設不落盤」段） | **待拍板**：筆記 §三第 35 列只記事實「選擇性、無預設路徑」；README 的理由是政策（日誌含秘密、寫家目錄該由人決定），**不是 AGENTS.md 偏離規則要的「基礎建設表達不出來」** |
| OTel 遙測 | `session-telemetry-otel` 出廠開、`FEEDBACK_ONLY`（base :191-204） | `@nexus/plugin-telemetry-otel` 選配、預設 `disabled` | 判過：#279，偏離一（`packages/nexus-plugin-telemetry-otel/src/index.ts:22`） |
| 模型失敗分類碼進日誌 | `turn/end` 的 `error: LlmFailure{message, code, status, providerRetryAfterMs, requestId}`（`packages/llm/llm/src/types.ts:40`、`packages/core/session/src/types.ts:211`） | `'turn/failed': { message }`（`packages/nexus-core/src/session-log.ts:212`）；分類只在行程內給重試用（`live-model.ts`） | **缺口**（上次 #4，兩側重核成立） |
| 遙測 ops：`agent-error` | `session-telemetry/src/coordinator.ts:217-226` 把 `agent/error` 轉成 ops 記錄 | 只發 `shutdown`（`session-telemetry-coordinator.ts:191-198`） | **缺口**（上次 #4 後半，這次找到 dsh 實際出處） |
| token 用量 | `token-meter`；usage 帶 `cacheReadTokens`／`cacheWriteTokens`（`llm/src/types.ts:155-174`） | `model/usage` 只有 input／output／total（`session-log.ts`） | 部分；快取欄位未判（小） |
| 步數／模型耗時統計 | `session-stats`（web-app :83） | `session-stats.ts`（steps、llmMs） | 有 |
| 首字延遲 | `session-stats` 的 ttft | 無 | **判過**：`session-stats.ts:21-23`「整組不做，沒有載體就沒有欄位」（上次誤列成缺口，更正） |
| 執行期不變量 | `dsh-invariants`＋session／agent／scope／agent-loop 四顆 `*/invariant`，**只在 `sdk-minimal` 出廠**（`packages/bundle/sdk-minimal/cordis.patch.yml:106-119`） | 16 顆不變量 plugin（DEFAULT_PLUGINS）；CLI 印出、serve 進伺服器日誌（`cli.ts:766-768`，#107） | 有 |
| 離線掃描 | — | `eval/session-scan.ts`、`sessions-cli.ts` | 有 |
| LangSmith tracing | — | `tracing.ts`：四個環境變數都要 `=== 'true'` 才開（:32-41），banner 會講 | 有（選配，內網不會預設外送） |
| 會話匯出 | `session-log-export`（web-app :56） | 無 | 判過：需求未出現（筆記 §三第 34 列 `session-query` 含日誌匯出） |
| 舊格式日誌 | 凍結解碼器鏈 `session-format-v0-to-v1`…`v2-to-v3`（persistence-jsonl 的相依） | 讀側逐版表態（`session-store.ts:110-124` 版本表），太新拒讀（`session-list.ts:156`） | 部分；形狀不同、未登記成偏離（小） |
| 軌跡檢視、輪次大綱、plugin 清單 | web-app `ui-trajectory`、`session-turn-outline`、`plugin-inventory` | web 側 | web UI 不以 dsh 為準（AGENTS.md），列給 dev-ui 參考 |
| 成本換算與預算、metrics、告警、health 端點 | **無**（grep `usd|pricing|/health` 只中 token 估算與 UI 字樣） | 無 | 框架要、dsh 也沒有（這次核過） |

症狀「問題要等客戶回報才發現」的守衛：執行期不變量（違規當場報）、工具錯誤碼進日誌（`tool-events.test.ts`、`fs-tool-errors.test.ts`）。**無守衛的一格：零設定的 serve 不落盤、不送遙測**——出事只剩行程 stdout；而就算開了落盤，模型失敗只留一句 message，分不出限流、下架、溢出。

## V 驗證與評估

| 項目（論文五段） | dsh | 我們 | 結論 |
|---|---|---|---|
| 任務落地（題庫） | 無內建題庫；`BENCHMARK.md` 只一句「用 Python SDK 跑外部 benchmark」 | `eval/dataset.ts` 的 `BENCHMARK` | 有（比 dsh 多） |
| 就緒檢查 | e2e preflight：缺 secret 就硬失敗（`e2e.yml` 註解） | `eval/survey.ts`、`tiers.ts`：逐一打 id 看回不回得出 `tool_calls` | 有（模型就緒）；自動化的任務就緒檢查沒有 |
| 受控執行＋軌跡擷取 | 213 個 `.e2e.ts` 真 API 測試 | `eval/runner.ts`；eval 路徑沒有會話日誌是登記過的決定（`runner.ts` 檔頭，README） | 有 |
| 判斷＋失敗歸因 | e2e 斷言 | `eval/scorers.ts`；`compare.ts` 的 `FailureReason`（拒絕／限流／…分開計、不算零分）；`session-scan.ts` | 有（比 dsh 多） |
| 持續回歸：腳本模型 | `ci.yml` | `ci.yml:143` `pnpm -r run test`（含 `eval.test.ts`） | 有 |
| 持續回歸：真模型、定期 | `e2e.yml`：PR、push master、**每晚 cron `17 0 * * *`**（:30-37） | 無（workflows 只有 `ci.yml`、`release.yml`，零個 `schedule:`；`compare-cli` 手動跑） | **缺口**（上次 #6 的前半）；前提是 key 要進 CI，要 demian 決定 |
| 基線分數存檔、跨次比對 | **無**（e2e 是 pass/fail） | 無（`compare-cli.ts` 零 `writeFile`，只印） | **框架要、dsh 也沒有**——上次把它算成缺口是錯的（dsh 沒有就不算落差），更正 |
| 人的判斷（評分、評語） | `message-feedback`（web-app :50）＋`command-feedback`（base :296） | `@nexus/plugin-feedback` 預設掛（#278、#382） | 有 |
| 交付物審查：每輪改了哪些檔 | `workspace-changes`（web-app :300）＋`ui-deliverables` | 無 | **未判**（上次 #7）；後端記錄＋web 卡片兩半，web 那半要經 demian 轉 dev-ui |
| 交付檔案宣告 `present` | standard preset :261 | 無 | **未判**（同 T 層那列） |
| LLM 當評審 | 無（grep `judge|grader|rubric` 只中 `UpgradeRoute`） | 無 | 框架要、dsh 也沒有 |
| 自我演化量測 | — | Proteus 地圖 #334（#342 等 #379 的遠端機器，SSH 2026-10-01） | 進行中 |

症狀「看似成功卻是錯的，而且沒人發現」的守衛：eval 評分器只在 eval 路徑上；產品路徑上只有人的評分。**無守衛的一格：產品路徑上沒有自動的結果檢查**——一輪看起來正常結束就記成正常結束（再疊上 L 層的 max-tokens 缺口：被截斷的回覆也記成正常）。

## G 治理與安全

| 子層 | 項目 | dsh 出廠 | 我們 | 結論 |
|---|---|---|---|---|
| 模型層 | 政策寫進提示詞（計劃模式規則、沙箱政策） | `plan-mode` section（base :308）、`sandbox-policy` | plan-mode plugin、`sandbox-policy.ts:105` | 有 |
| 模型層 | 外部內容標成「資料不是指令」 | `tool-web/src/trust.ts:7`、`fetch.ts:455`；`session-reference` 快照帶固定警告 | 我們沒有 web 工具也沒有跨會話引用，所以今天沒有這個輸入面 | 跟著 T 層 web 那列、C 層跨會話引用那列一起判 |
| 模型層 | 內容過濾、通用 prompt injection 防護 | **無**（grep `moderation|content filter` 零筆） | 無 | 框架要、dsh 也沒有 |
| 系統層 | 核准閘門 | `approval`（base :231，`ask`／`never`） | fold `approvalGate`，三個提問者（計劃退出、`submit_record`、升級）；CLI 用 `HEADLESS_APPROVALS` 確定性拒絕；子代理照 dsh 一律拒（#324） | 有 |
| 系統層 | 具名權限預設（沙箱＋核准捆成一組） | `permission`（base :236-248）：`danger-full-access` → 核准 `never` | 只有沙箱那顆旋鈕 | **已知缺口**：`sandbox-mode.ts:21-27` 登記「還沒做，不是做不到」（核准那顆還不是逐次解析），沒有卡 |
| 系統層 | `danger-full-access` 的強度 | 同名 mode | 放行 symlink 逃逸那半比 dsh 弱 | 判過：偏離（`contained-backend.ts:119`） |
| 系統層 | 檔案圍堵 | `fs-sandbox` | 見 E 層 | 有 |
| 系統層 | DNS rebinding／跨站圍欄 | `connection` 的 `api-request-trust.ts` | `request-trust.ts`（#387，v0.4.29） | 有 |
| 系統層 | 瀏覽器會話認證（行程 token 換簽章 cookie，每個 RPC 都要） | `connection/src/browser-auth.ts`、`rpc-host.ts:99`；README :37「不存在按方法区分的 loopback 层」 | 無 | 判過：#387 登記偏離（`request-trust.ts:29`）。**重開條件**：serve 加 `--host`，或要在多人共用的機器上跑——內網部署如果是共用主機，這條已經觸發 |
| 系統層 | 憑證儲存（不寫進行程環境） | `credentials-local`（base :104） | `.env`＋環境變數 | 判過：定位差異（筆記 §三小計的 `credentials`） |
| 系統層 | MCP 子行程環境清洗 | `scrubbedParentEnv()`：黑名單刪 `/KEY|PASSWORD|SECRET|TOKEN/i` 與 `DSH_*`，其餘繼承（`mcp-client/README.zh.md:136-138`） | 沒有自己的定義；上游 SDK 是**白名單**，只放 `HOME/LOGNAME/PATH/SHELL/TERM/USER`（`@modelcontextprotocol/sdk` `client/stdio.js:15-34、74-76`）＋adapter 補 `PATH`（`mcp-adapters` `connection.js:236-237`） | 部分：結果比 dsh 嚴，但全靠上游、零絆索（grep 零筆），升版改了不會紅。未判（小） |
| 組織層 | 工具呼叫全量紀錄 | session 日誌 | `tool/call`＋`tool/result`（#264） | 有 |
| 組織層 | 沙箱切換紀錄 | — | `sandbox/mode` 事件（README） | 有 |
| 組織層 | 核准審計事件 | — | 無 | 判過不做：射程選擇、零消費者（筆記 §五第 7 條，#220） |
| 組織層 | 遙測脫敏 | — | `registry.telemetry.rules()`（`agent-factory.ts` `attachTelemetry`） | 有 |
| 組織層 | 人工監督 | web 核准面板、計劃評審 | web 核准卡、計劃核准；#408 面板改版進行中（dev-ui） | 有 |
| 組織層 | 合規 | 無 | 無 | 框架要、dsh 也沒有 |

症狀「做了根本不該被允許的事」的守衛：`approval-gate-order.test.ts`、`permissions.test.ts`、`delegated-subagent.test.ts`（子代理一律拒）、`root-only-tool.test.ts`、`tool-refusals.test.ts`、`request-trust.test.ts`、`sandbox-escalation.test.ts`。**無守衛的一格：MCP 子行程的環境**——今天安全是上游白名單給的，沒有任何測試釘住。

## 跟 09-17 那次的差別

**已經修掉**：#1 DNS rebinding（#387，v0.4.29）；#2 AGENTS.md 上產品路徑（#388 v0.4.30、#397 v0.4.31；每步刷新 #389 not planned）。

**仍然成立、這次兩側都親手核過**：#3 max-tokens、#4 失敗分類碼（dsh 出處補到 `LlmFailure` 與 `session-telemetry/src/coordinator.ts:217-226`）、#7 workspace-changes（我們這側 grep 零筆）。

**這次更正的**：
- #5 拆成兩條：MCP resources（README 寫了延後，沒進筆記或 issue）、server instructions（連延後都沒寫）。
- #6 拆成兩半：定期跑真模型是缺口；**存檔的基線分數 dsh 也沒有**（它的 e2e 是 pass/fail），改歸「框架要、dsh 也沒有」。
- 摘要 prompt：從「次要、沒核」升為兩側核過的缺口。
- 逐 agent 工具 allow/deny：不是未登記，已在 #328 第 3 項。
- 首字延遲：不是缺口，`session-stats.ts:21-23` 判過「整組不做」。
- MCP 環境變數：核過了，上游白名單比 dsh 的黑名單還嚴；缺的只是絆索。
- 「已經有」那欄沒分預設與選配：mcp、skills、quickjs、memory、telemetry、validation 在零設定的 CLI／serve 上都不存在。
- 我自己在 T 層一度寫「dsh 也沒有描述檢查」，核下去是錯的（它有 `verify-tool-catalog` gate）。

**這次新找到、上次沒有的**（多半因為上次只數 base、沒數 preset 和 web-app）：skills 不在預設、`present`、`session-reference`、`file-reference-local`、`session-checkpoint-policy`、日誌預設不落盤的理由格式、工具 schema 目錄 gate、具名權限預設、goal driver 的前提、`session-title-llm`、`interrupted` 補結、快取 token、日誌遷移形狀。

**09-17 之後的合併逐條回驗**：#390、#394、#398、#411（feedback.list，V 層「人的判斷」那列）、#410／#417／#419（web）、#415／#416／#418（相依）。上面每條「還開著」都是直接在 `c1857a8` 上讀碼判的，不是沿用上次結論。

## 調研筆記要改的地方（`.docs/plugin-architecture-gap-survey.md`）

事實過期（6）：
1. §三第 12 列 `e2b`：dsh 已移除。
2. §三第 7 列 `code-runtime`：改名 `ptc-runtime`，而且 `ptc-runtime-node` 在 base（:376）。
3. §三第 13 列 `examples`：dsh 整個 repo 已經 0 檔（**上次沒抓到**）。
4. 「51 個頂層套件」：現在 54；新增 browser-use、computer-use、deliverables、document、ptc-runtime、ssh。
5. §三第 48 列 `web`：在 dsh base（:447-475）＋三個 preset，歸「企業級」站不住。
6. `packages/nexus-core/src/containment.ts:50` 說 `TOOL_TIMEOUT`「刻意不發」，同檔 :240 在發。

判斷前提有誤（3，這次新找到）：
7. §三第 38 列 `skill`「有（薄）」：`@nexus/plugin-skills` 不在 DEFAULT_PLUGINS，產品路徑上不存在——跟 #388 對 memory 那次同一型。
8. §五第 5 條第 1 點與第 7 條：「context 五個非預設」只查了 `base/package.json`；web-app 出廠掛 `session-reference`（:75）與 `file-reference-local`（:78），而第 2、3 點理由只講 `time-context`。——**第四次同型錯**（前三次：#215、#360、web 那列）：判「出廠沒有」之前沒把 `packages/bundle/` **和 `packages/preset/agent-presets/presets/`** 都查完。
9. #180 §五與 `apps/harness/src/goal-driver.ts:61-63`：「dsh 的 driver 是需要刻意掛載的可選消費方」——套件本身是可選的，但 dsh base 出廠就掛（:302）。

## 每層一句話

- **E**：檔案圍堵、三種模式、升級、先讀後改、子代理繼承都有；shell 與行程隔離判過延後（決策 3）。沒給 `--workspace` 就沒有圍堵，但那時檔案寫在虛擬 fs 裡。
- **T**：工具註冊、校驗、逾時、MCP 工具、wire 協定、會話管理都有；缺 MCP resources、server instructions；web 工具、skills 預設、`present`、工具目錄 gate 四項沒判過。
- **C**：AGENTS.md、自動摘要、修剪、外溢、重複提醒都有；缺摘要 prompt 的品質要求；web 的跨會話引用、`@file` 沒判過。
- **L**：迴圈、遞迴上限、重試、取消與續接、goal 續行（選配）、子代理都有；缺 max-tokens 這種結束原因；耐久檢查點沒判過。
- **O**：事件日誌、執行期不變量、離線掃描、統計、選配的遙測與 tracing 都有；缺失敗分類碼與 `agent-error`；日誌預設不落盤的理由要重新拍板。
- **V**：題庫、受控執行、評分、失敗歸因、CI 腳本回歸、人的評分都有（題庫到歸因這段比 dsh 多）；缺定期真模型回歸；每輪改動檔案與 `present` 沒判過。
- **G**：核准閘門、圍堵、rebinding 圍欄、全量紀錄、遙測脫敏、人工監督都有；具名權限預設是已知缺口（有登記、沒卡）；瀏覽器會話認證判過，重開條件要看內網部署是不是共用主機。

## 清單

**缺口（dsh 出廠有、我們沒有、沒判過，兩側都核過）— 8**
1. T：MCP resources
2. T：MCP server instructions
3. C：摘要 prompt 沒要求保留原始意圖與使用者糾正
4. L：max-tokens 不是一種結束原因
5. O：模型失敗沒有分類碼進日誌
6. O：遙測沒有 `agent-error` ops 記錄
7. V：沒有定期跑真模型的回歸（需要 key 進 CI）
8. G：具名權限預設（`sandbox-mode.ts:21-27` 登記「還沒做」、沒有卡）

**沒判過、要拍板（可能判成不做）— 9**
9. T：web_search／web_fetch（候選：內網，照 dsh 自己寫的覆寫方式登記不掛）
10. T：skills 不在預設清單
11. T／V：`present` 交付檔案工具
12. T：工具 schema 目錄＋新鮮度 gate
13. C：跨會話引用 `session-reference`（web 那半歸 dev-ui）
14. C：`@file` 引用 `file-reference-local`（同上）
15. L：耐久檢查點 `session-checkpoint-policy`
16. V：每輪改動檔案 `workspace-changes`（同上）
17. O：日誌預設不落盤的理由不符偏離規則

**小項（未判）— 5**：`session-title-llm`、`interrupted` 補結、快取 token 欄位、日誌遷移形狀、MCP 環境絆索。

**判過但前提要重核 — 2**：goal driver 預設關（#180）、瀏覽器會話認證的重開條件（#387）。

## 方法與限制

- **出廠清單數完的範圍**：base（89 列）、web-app、headless、acp-app、sdk-app、**sdk-minimal**（唯一不以 base 為底，逐列數過：多出來的是 SDK 伺服器、pty 持久 shell、`dsh-invariants`＋四顆不變量，沒有新缺口，只更正 O 表不變量那列）、四個 preset。`apps/cli/composition.md` 自稱涵蓋每個 profile，實際只有 base 一節，不能拿來交叉對照。
- **否定宣稱一律用 `git grep` 對原始碼**（我們 `c1857a8`、dsh `ddefc45`），不用程式碼圖——圖的索引停在 2026-09-13。
- **三條「dsh 也沒有」全 repo 重搜過**（`packages`＋`apps`，扣 spec／tests／生成的 api-catalog）：每輪步數上限只中外部 Claude Code 後端的 `error_max_turns`；成本／health 0 筆（同一條 regex 加 `imageCompressionConcurrency` 當正向對照中 8 筆，量具沒壞）；`judge` 只以英文動詞出現。
- **引文**：dsh base 的行號逐列對過 `grep -n "- id:"`；我方引文用腳本抽出後逐條印出實際內容對過。
- **沒做的**：沒有 live 跑；web UI 那些列（軌跡、輪次大綱、plugin 清單）照 AGENTS.md 不以 dsh 為準，只列出不判。
