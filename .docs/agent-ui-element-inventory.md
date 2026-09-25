# nexus web 的 UI 元件清單與設計語言 —— 綜合 dsh、市面 agent UI 與 Libraries.dev

**調研日期**：2026-09-17。

**用途**：給 nexus web 介面重做用的**元件清單**（照 nexus 自己的 UI 概念排），加上從 [Libraries.dev](https://github.com/Jakubantalik/Libraries.dev) 抽出來的**設計語言與動效 token**，以及開 wayfinder 地圖用的素材。元件庫**選型**的結論在 [agent-ui-library-survey.md](agent-ui-library-survey.md)，這份不重複。

> **後續決議（2026-09-17，[地圖 #372](https://github.com/DemianLi/nexus-agent/issues/372)）**：這份是開圖前的調研快照，「市面」欄與 §3.3 的動效對應都是**提案**。後來拍板的：
>
> - **元件來源**：主用 shadcn 官方，AI Elements 只參考清單、不用程式碼（[#374](https://github.com/DemianLi/nexus-agent/issues/374#issuecomment-5707786108)）。「市面」欄的 AIE 只當清單參考。
> - **§2.4 的分歧已拍板**：核准與提問**都換掉輸入框**（照 dsh 的 composer takeover）；提問面板的 ❌ 是停止這一輪，這一條是寫明的例外（[#376](https://github.com/DemianLi/nexus-agent/issues/376#issuecomment-5709355235)）。
> - **效果套件**：demian 看過原型後的反應是**純 CSS 仿**、不裝 `thinking-orbs`／`border-beam`，由[動效策略](https://github.com/DemianLi/nexus-agent/issues/378)那張卡拍板（[原型結論](https://github.com/DemianLi/nexus-agent/issues/375#issuecomment-5708312161)）。§3.3 的「套件 → 狀態」提案表因此只剩參考價值。
> - **亮暗規則**：暗色和亮色的邊框效果、區塊鑑別度要一樣明顯，由[設計 token 定稿](https://github.com/DemianLi/nexus-agent/issues/377)那張卡落成數字。
> - **§4 的起圖素材已經用掉**，地圖與子卡以 GitHub 上的為準。
> - **地圖 #372 八張卡的結論已收攏進 [web-ui-spec.md](web-ui-spec.md)（2026-09-18），實作以那份為準。**

## 結論速查表

| 問題 | 結論 | 在 |
| --- | --- | --- |
| 清單怎麼排 | 照 nexus 的 UI 概念分 8 區、37 項（第 37 項是 2026-09-25 從第 9 項拆出來的）；每項標 wire 上有沒有資料（沒資料的元件先做只是空殼） | §2 |
| 現在就能做的 | 純前端：殼層、手機抽屜、主題、toast；wire 已有資料：會話列表、訊息流（human／ai／tool）、核准、提問、狀態、停止、回饋、slash 命令 | §2 的 P0 |
| wire 還沒有的 | reasoning、連線狀態、todo、goal、plan mode、context 用量、佇列、子代理對話檢視、交付檔案 | §2 的 P1 |
| ↑ 這一列 2026-09-22 已複查 | 交付檔案那一項已經做完；「子代理血緣」是這一列的筆誤（血緣＝第 15 列，本來就是 P0，P1 的是第 16 列的唯讀檢視）；其餘七項逐項的現況見 §2.0 | §2.0 |
| **最大的一個設計分歧** | dsh 的核准與提問都是 **composer takeover**（取代輸入框），不是插在對話裡的卡；nexus 現在是卡片列在畫面上（`App.tsx:319–333`） | §2.4 |
| Libraries.dev 能拿什麼 | **動效 token 整組可以拿**（時長、曲線、位移、縮放、模糊）；**效果套件** `thinking-orbs`、`border-beam` 是 MIT npm 套件、peer 只要 React、有 reduced-motion 與 light/dark 自動偵測，可以直接裝 | §3 |
| Libraries.dev 不能照搬的 | **只有暗色**（`html[data-theme="dark"]` 寫死）、色票是 hex 不是 shadcn 的 oklch token、標題字 **Saans** 沒附授權、疑為商用字型 | §3.4 |
| wayfinder | skill 設定成只能由使用者呼叫；起圖素材在 §4，請跑 `/mattpocock-skills:wayfinder` | §4 |

## 1. 來源

| 來源 | SHA（commit 日期） | 讀了什麼 |
| --- | --- | --- |
| dsh（本機 `references/deepseek-harness`） | `e459e32`（2026-09-15） | `packages/client/ui-*/package.json` 的 `description`（45 個）、`ui-primitives/src`、`ui-chat/src/client/chat`、`ui-conversation/src/client/*`、`ui-approval`、`ui-user-questions`、`ui-tool`、`ui-subagent`、`ui-goal`、`ui-plan`、`ui-sidebar`、`ui-theme` 的檔案清單 |
| [Jakubantalik/Libraries.dev](https://github.com/Jakubantalik/Libraries.dev) | `44fef85`（2026-09-16） | `sites/home/public/assets/site.css`、`packages/*/README.md`、`packages/*/package.json`；線上站 [libraries.dev](https://libraries.dev) 截圖 |
| [vercel/ai-elements](https://github.com/vercel/ai-elements) | `6a9d5b1`（2026-08-21） | `packages/elements/src` 檔名（詳見選型筆記） |
| [shadcn-ui/ui](https://github.com/shadcn-ui/ui) | `f5bb039`（2026-09-16） | `apps/v4/registry/new-york-v4/ui`、`bases/radix/ui`（詳見選型筆記） |
| nexus | develop `8262bc0` | `packages/nexus-wire/src/*.ts` 的匯出型別、`apps/web/src/App.tsx`、`apps/web/src/index.css` |

「dsh」欄的名字是 dsh 的**套件名／檔名**，只讀了檔名與 `description`，沒逐檔讀實作。

## 2. 元件清單

欄位：

- **wire**：nexus 下行現在有沒有這個資料（P0＝有，P1＝沒有，要先補 harness／wire；—＝純前端，不靠 wire）。依據是 `packages/nexus-wire/src` 的匯出型別。
- **dsh**：dsh 對應的套件或檔案。
- **市面**：AI Elements（AIE）與 shadcn 官方（sc）的對應元件；— 表示沒有。
- **動效**：建議掛的 Libraries.dev 動效，屬於**提案**，見 §3.3。

### 2.0 P1 的協定面複查（2026-09-22，develop `0fb893c`）

這份清單是 2026-09-17 寫的，欄位裡的 P1 只回答「`packages/nexus-wire/src` 的匯出型別有沒有這個資料」。
那一格會把兩種成本差一個量級的缺口壓成同一個字，所以這次複查把它拆成三層分開查：

1. **源頭**：會話日誌有沒有這種事件、有沒有人真的 `log.append`、出廠 `apps/harness/cordis.yml` 有沒有裝那顆 plugin。
2. **投影**：pump 與歷史路由有沒有把它合成線上的 wire 事件。`custom` 事件（`method:'custom'`、`data:{name,payload}`）
   是現成載體，交付（#441）與改動（#443）各走過一次，所以這一層是「有沒有人寫那段合成」，不是「協定表達不出來」。
3. **消費**：`apps/web` 畫不畫。

| 項 | 源頭（日誌） | 投影（wire） | 消費（web） |
| --- | --- | --- | --- |
| reasoning | 串流上有，不經日誌 | **到了折疊器但被丟掉**：`conversation.ts:679` 遇到非 `text-delta` 就 `return state`；`AiEntry` 無欄位 | 無 |
| 連線狀態 | — | 無（`client.ts`／`sse.ts` 沒有這個概念） | **已有簡版**：`use-conversation.ts:187` |
| todo | **有**：`todo/write`，`plugin-todo/index.ts:256`，出廠有裝 | 零 | 無（`App.tsx:41` 自己登記了這句） |
| goal | **有**：`goal/change`，`plugin-goal/service.ts:565`，出廠有裝 | 零 | 無（命令面走 slash 通） |
| plan mode | **有**：`plan/mode`，`plugin-plan-mode/index.ts:295`／`:405`，出廠有裝 | 零 | 無（`/plan` 走 slash 通） |
| context 用量 | **有**：`model/usage`，`core/model-usage.ts:161`，出廠有裝 | 零 | 無 |
| 佇列 | — | — | 無（`composer.tsx` 裡沒有） |
| 子代理對話檢視 | 有（血緣已是 P0） | 血緣已有 `Attribution` | 血緣已畫，唯讀檢視沒有 |
| 附件 | 下行交付**已做完**；上行（人傳檔給模型）源頭全無 | 下行有 | 下行有四張卡 |

**四項的資料今天已經躺在日誌裡**（todo、goal、plan mode、context 用量），缺的只有投影那一段與畫面。

**reasoning 比它那一列看起來便宜一個量級**：其餘各項都要「pump 合成新事件 ＋ 歷史路由那一份 ＋ web 新元件」，
它兩樣都不用 —— 要的是 `AiEntry` 一個欄位、放行那條分支、web 一個摺疊區塊。已開
[#527](https://github.com/DemianLi/nexus-agent/issues/527)。

**context 用量今天沒有分母**：`model/usage` 只有三個計數不帶上限（`session-log.ts:292`）；基座那側
`summarization.ts:54` 記著 `contextWindow` 三個欄位「三個都是 0」；唯一知道上限的時刻是撞牆那一刻
（`live-model.ts:152-174` 從供應商回的負 `max_tokens` 反解）。所以進度條畫不出來，只畫得出用掉多少。
已開 [#528](https://github.com/DemianLi/nexus-agent/issues/528)。

**沒有實跑過 serve**：上面「源頭有」是從出廠條目與 `log.append` 的呼叫點推的，當排期依據夠，當驗收證據不夠。

§4 的 research 一列（「wire 要補哪些 P1 資料」）問的就是這件事；那一列當時沒有被開成卡，這一節就是它的答案。

### 2.1 殼層與版面

| # | 元件 | wire | dsh | 市面 | 動效 | 備註 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | App 殼（三欄：會話列表／對話／右側欄） | —（純前端） | `ui-layout`（`AppFrame`、`SIDEBAR_AUTO_COLLAPSE = 1024`） | sc `sidebar`（手機 Sheet） | 卡片縮放 `--resize-dur 300ms` | RWD 主載體 |
| 2 | 手機抽屜與頂部列 | —（純前端） | `ui-layout` 的 `narrowExpanded` | sc `sheet`、`drawer` | 下拉 open 250ms／close 150ms、scale 0.97 | 1024 以下 |
| 3 | 主題切換（light／dark／system） | —（純前端） | `ui-theme`（`--dsw-*` token、`ThemeRuntime`） | shadcn `.dark` | — | 見 §3.4 分歧 |
| 4 | 連線狀態指示 | P1（`nexus-wire` 的 `client.ts`／`sse.ts` 沒有連線狀態；`WireChannel` 只是頻道名）**——2026-09-22 複查：這句仍然成立，但畫面上已有前端自推的簡版（`use-conversation.ts:187` 的 `connected`／`connectionError`，`StatusLine` 收）** | `ui-primitives/ConnectionIndicator` | — | `thinking-orbs` `connecting` | |
| 5 | 右側欄（檔案、預覽、終端） | P1 | `ui-sidebar-right`、`ui-sidebar-files`、`ui-sidebar-documentpreview`、`ui-sidebar-terminal` | AIE `file-tree`、`terminal` | 側欄滑入 | 目前 nexus 沒有這一面 |

### 2.2 會話

| # | 元件 | wire | dsh | 市面 | 動效 | 備註 |
| --- | --- | --- | --- | --- | --- | --- |
| 6 | 會話列表（分組、搜尋、狀態點） | P0（`ThreadSummary`、`ThreadListResult`） | `ui-sidebar`（multi-level tree、search、grouping、state dots）、`ui-primitives/StateDot` | — | 列表 stagger 40ms | `thread-list.tsx`；2026-09-25 #611 補分組（今天、昨天、過去 7 天、更早）、標題搜尋、執行中的點。資料仍是打開側欄那一刻的快照 |
| 7 | 新對話／空白狀態 hero | P0 | `ui-conversation/.../EmptyHero`、`HeroShell` | AIE `suggestion` | `thinking-orbs` `breathing` | |
| 8 | 會話標頭（標題、工作目錄、背景工作） | P1 | `ui-jobs`、`ui-open-in-app`、`ui-schedule` | — | — | |
| 9 | 歷史分頁載入（往回捲） | P0（`ThreadHistoryQuery`） | `ui-chat/ChatView`（`loadOlderAnchored`：一顆按鈕、自己記錨點） | sc `message-scroller` | —（**不做骨架**：跟真的內容不一樣高，換掉那一下又要補位置；規格 §7 也把載入歷史列在不動的那一類） | #306 做了讀取與按鈕；2026-09-25 補完（`earlier-pager.tsx`）：捲到頂端附近而且有往上的意圖才自動換一頁，按鈕留著；讀取中「讀取中…」；失敗畫在按鈕旁、改「再試一次」、不自動重試；讀完報讀接上幾則。輪次側軌拆成第 37 項 |
| 37 | 輪次導覽側軌（每輪一格，點到還沒載入的輪先翻到那裡） | P1（wire 沒有整條對話的輪次索引） | `ui-chat/TurnNavigator` | — | — | 2026-09-25 從第 9 項拆出來；要 harness 先補索引，有需要再開卡 |

### 2.3 訊息流

| # | 元件 | wire | dsh | 市面 | 動效 | 備註 |
| --- | --- | --- | --- | --- | --- | --- |
| 10 | 使用者訊息 | P0（`HumanEntry`） | `ui-chat/MessageItem`、`ui-primitives/user-text` | sc `message`、`bubble`；AIE `message` | 送出時 slide-up 8px＋fade | |
| 11 | 助理訊息（markdown、串流中、被停止） | P0（`AiEntry`，含 `stopped`） | `ui-chat/AssistantMarkdown`、`AssistantNodeView` | AIE `message`（streamdown） | 字元 shimmer（`Solving....` 那種） | |
| 12 | 推理區塊 | P1（`AiEntry` 沒有 reasoning 欄位，只有 `text`／`streaming`／`attribution`／`error`／`stopped`；`conversation.ts:679` 註解 reasoning 的 delta「這一版不呈現」（2026-09-22 複查：原記 `:496`，行號已漂）） | `ui-chat/ReasoningRow` | AIE `reasoning`、`chain-of-thought` | `thinking-orbs` `composing`（20px） | |
| 13 | 工具呼叫卡（四種狀態） | P0（`ToolEntry.status`） | `ui-tool/ToolCallTree`、`toolviews/` | AIE `tool` | 執行中 `thinking-orbs` `working` | 狀態映射見選型筆記 §3.1 |
| 14 | 工具專屬呈現（讀檔、搜尋、終端、網頁、diff、JSON） | P0（`ToolEntry.input`／`text`／`meta`） | `ui-primitives/ReadBlock`、`SearchBlock`、`TerminalBlock`、`WebBlock`、`DiffBlock`、`JsonTree` | AIE `code-block`、`terminal`、`schema-display`、`stack-trace` | 展開 `--resize-dur` | dsh 是「按工具名換呈現」的 slot。#601 做了 diff（執行中從參數算）與通用卡的結果文字；2026-09-25 #625 讀結果的 `meta`（harness #619）：讀檔卡（行號＋整段高亮）、搜尋卡（分檔的命中、路徑清單，截斷時「顯示 X／共 N」）、改檔完成後畫實際套用的 diff。終端（產品路徑上沒有 `execute`）、網頁、JSON 樹還沒有 |
| 15 | 子代理歸屬標示 | P0（`Attribution`）**——2026-09-22 已實作：`tool-card.tsx:52` 的 `AttributionBadge` ＋ transcript 縮排** | `ui-subagent/SubagentHeaderLineage` | AIE `agent` | — | nexus「未歸屬」要照樣顯示 |
| 16 | 子代理對話檢視（唯讀 composer） | P1 | `ui-subagent/SubagentReadOnlyComposer` | — | — | |
| 17 | 回合分隔與用量 | P1 | `ui-chat/TurnUsagePanel`、`StatsPills`、`TurnTailNodeView` | AIE `context` | 數字滾動 | |
| 18 | 壓縮／系統注入列 | P1 | `ui-chat/CompactionItem`、`ContextInjectionRow`、`SystemPromptRow` | AIE `checkpoint` | — | |
| 19 | 交付檔案列 | ~~P1~~ **P0（2026-09-22 已做完）** | `ui-deliverables`（`ProducedFiles`，有 `@container` 斷點） | AIE `artifact`、`attachments` | — | |
| 20 | 附件（輸入與訊息中的圖） | P1 | `ui-attachment` | sc `attachment`；AIE `attachments` | — | |

### 2.4 人在迴圈裡

| # | 元件 | wire | dsh | 市面 | 動效 | 備註 |
| --- | --- | --- | --- | --- | --- | --- |
| 21 | 核准（整批 `actions`、允許／拒絕＋理由） | P0（`PendingApproval`、`DecisionEntry`） | `ui-approval/ApprovalPanel`：**"Composer takeover for one pending approval waterfall"**（`ApprovalPanel.tsx:1`）；`ui-primitives/RiskConfirmation` | AIE `confirmation`（逐顆、卡內，不合 #317） | 輸入框換成核准面板時 `border-beam` `pulse-inner` | 現有 `approval-card.tsx` |
| 22 | 決定紀錄（人按了什麼） | P0（`DecisionEntry`） | `ui-chat/ApprovalCommand` | — | — | 與失敗工具卡並存 |
| 23 | 提問（單選／多選／自由文字／跳過／放棄整組） | P0（`PendingQuestion`、`QuestionItem`、`AnswerEntry`） | `ui-user-questions/QuestionComposer`：**"ask_user_question composer takeover"** | sc `questionnaire`；AIE `question` | 題目切換 slide＋blur 2px | 現有 `question-card.tsx` |
| 24 | 計劃審核 | P1 | `ui-user-questions/PlanReviewPanel` | AIE `plan` | — | nexus 有 plan-mode plugin，wire 沒送 |
| 25 | 權限模式切換 | P1 | `ui-permission-presets` | — | 滑動 tab pill | |

**分歧**：dsh 的 21、23 都是「輸入框被接管」，nexus 目前是 `App.tsx:319–333` 把 `pendings` 渲染成 `QuestionCard`／`ApprovalCard`。手機上 takeover 比較省空間，因為鍵盤起來時畫面上只剩輸入區那一塊。這要拍板，見 §4 的 fog。

### 2.5 輸入區

| # | 元件 | wire | dsh | 市面 | 動效 | 備註 |
| --- | --- | --- | --- | --- | --- | --- |
| 26 | 輸入框（多行、送出、停止） | P0（`RunCancelCommand`） | `ui-conversation/.../InputBar` | AIE `prompt-input` | 執行中 `border-beam`（`md`，或手機上 `line`） | Libraries.dev 首頁卡就是這個組合 |
| 27 | slash 命令選單 | P0（`SlashDescriptor`、`SlashListCommand`） | `ui-commands`、`ui-input-trigger`（`/`、`@` 偵測） | sc `command` | 選單 open 250ms／close 150ms | |
| 28 | `@` 引用（檔案、會話、子代理、skill） | P1 | `ui-reference`、`ui-subagent` 的 `@` source、`ui-skill` | AIE `inline-citation` | — | |
| 29 | 送出佇列 | P1 | `ui-conversation/.../QueueDock` | AIE `queue` | 項目 stagger 40ms | |
| 30 | 模型選擇 | P1 | `ui-model-selection` | AIE `model-selector` | — | |

### 2.6 agent 狀態面板

| # | 元件 | wire | dsh | 市面 | 動效 | 備註 |
| --- | --- | --- | --- | --- | --- | --- |
| 31 | 狀態列（`idle`／`running`／`awaiting-input`／`failed`／`stopped`） | P0（`ConversationStatus`，`conversation.ts:175`） | `ui-primitives/StateDot` | AIE `shimmer` | `thinking-orbs` 依狀態換 state | 現有 `status-line.tsx` |
| 32 | todo 清單 | P1 | `ui-conversation/.../TodoPanel` | AIE `task`、`queue` | 勾選 bounce（`--ease-bounce`） | nexus 有 todo plugin，wire 沒送 |
| 33 | 目標列 | P1 | `ui-goal/GoalBar`（"docked above the composer"） | — | — | nexus 有 goal plugin |
| 34 | context 用量表 | P1 | `ui-conversation/.../ContextMeter` | AIE `context` | 進度條 `--ease-smooth-out` | |

### 2.7 回饋與通知

| # | 元件 | wire | dsh | 市面 | 動效 | 備註 |
| --- | --- | --- | --- | --- | --- | --- |
| 35 | 逐則讚／踩＋回饋對話框 | P0（`FeedbackCommand` 系列） | `ui-message-feedback`、`ui-chat/MessageIconActions` | AIE `message` 的 actions | 按下 scale 0.97＋bounce | 現有 `feedback-dialog.tsx` |
| 36 | Toast | —（純前端） | `ui-primitives/Toast` | sc `sonner` | open 250ms／close 150ms | |

### 2.8 不列入

設定頁（`ui-settings-*`）、工作區挑選（`ui-workspace`、`ui-directory-picker-*`）、品牌（`ui-brand-official`）、軌跡時間軸（`ui-trajectory`）、workflow run（`ui-workflow-run`）、dock 分割（`ui-dockkit`）。nexus 現在沒有對應的產品面，要做時再開。

## 3. 設計語言：從 Libraries.dev 抽出來的

### 3.1 Libraries.dev 是什麼

不是 agent UI 元件庫，是 Jakub Antalik 的**動效／特效 React 套件**合集加上它們的展示站（`package.json` 的 `description`）。首頁標語是 "High-crafted UI libraries for AI agents"。每個套件都是 MIT：

| 套件 | 版本 | 做什麼（README） | peer | 對 nexus |
| --- | --- | --- | --- | --- |
| `thinking-orbs` | 0.3.1 | 點陣球 loading，九種狀態：`working`、`searching`、`solving`、`listening`、`connecting`、`weaving`、`composing`、`breathing`、`shaping`；2D canvas、不用 WebGL | `react >=18` | **可直接用**：agent 狀態指示 |
| `border-beam` | 1.3.0（npm 上最新；原本寫的 1.4.0 不存在，2026-09-17 原型實裝時發現） | 沿邊框跑的彩色光；`size: sm/md/line/pulse-outside/pulse-inner`、`colorVariant`、`theme: dark/light/auto`、`active` | `react`、`react-dom >=18` | **可直接用**：輸入框執行中、核准待決 |
| `voice-beam` | 0.1.0 | 跟著聲音起伏的底邊光 | 同上 | 沒有語音功能，不列 |
| `liquid-gooey` | 0.2.1 | 液態 morph／move | 同上 | 裝飾性，不列 |
| `img-fx` | 0.5.1 | WebGL 生圖 loading | `three` | 沒有生圖，不列 |
| `metal-fx` | 2.0.10 | WebGL 液態金屬環 | 同上 | 裝飾性，不列 |

**無障礙**：`thinking-orbs` README 第 80–81 行寫明 `role="img"` 附預設 `aria-label`，`prefers-reduced-motion: reduce` 時畫靜態代表幀。`border-beam`、`thinking-orbs`、`liquid-gooey`、`voice-beam` 的 `src` 都有檔案處理 reduced motion（各 2 個檔案；只數了檔案，沒讀實作）。

**主題偵測**：`thinking-orbs` 的 `theme="auto"` 會先看祖先的 `data-theme` 或 `dark`／`light` class（README 第 60 行明講「the Tailwind / shadcn convention」），再退回 `prefers-color-scheme`。所以它跟 nexus 的 `.dark` class 天生相容。

### 3.2 視覺 token（`sites/home/public/assets/site.css`）

檔頭註解：**"Libraries.dev — shared design system (dark-only)… Ported from transitions.dev. The site ships with `<html data-theme="dark">` hardcoded"**。light 的值也在 `:root`，只是站上不用。

| 類別 | 暗色值 | 亮色值（`:root`） |
| --- | --- | --- |
| 底色 | `--bg #121212` | `#fdfdfd` |
| 卡片 | `--card-bg #181818` | `#ffffff` |
| 展示區（卡片內層） | `--stage-bg #131313`，邊 `rgba(255,255,255,.02)` | `#f9f9f9` |
| chip | `rgba(255,255,255,.07)`／hover `.10`／pressed `.08` | `#f4f4f4`／`#f1f1f1`／`#eae9e9` |
| 次要文字 | `rgba(202,202,202,.7)` | `#6c6c6c` |
| 材質陰影 | 多層 inset：`inset 0 1px 0 rgba(255,255,255,.04)` ＋ 1px 內框 `rgba(196,196,196,.08)` | `0 4px 42px rgba(0,0,0,.06)` 三層 |
| accent | `#55cfff` | `#0073e5` |
| CTA／Pro | `#0071fc` 系列 | 同 |

**外觀特徵**（截圖觀察）：

- 卡片是**雙層框**：外框圓角約 24–26px（`site.css` 第 680、1013、1093 行），裡面再嵌一個展示區；
- 按鈕與 chip 是 **50px 全圓 pill**，高 36px（第 729、745 行）；
- 選單圓角 12px、選項 8–9px（第 764、778、913 行）；
- 大量留白，1px 半透明邊線，幾乎不用實色邊框。

**字型**：內文 `"Inter"`、等寬 `"Roboto Mono"`，都是免費字型；**標題 display 字 "Saans"**（`@font-face` 從 `assets/fonts/Saans-Medium.woff2` 載入）。repo 沒有附這個字型的授權檔，名稱與 Displaay 字型廠的商用字型相同（**未核實**），**不要拿**。

### 3.3 動效 token（整組可以拿）

同一個檔案的 `:root`，與主題無關：

```css
--duration-stagger: 40ms;   --duration-micro: 80ms;   --duration-quick: 150ms;
--duration-fast: 250ms;     --duration-medium: 350ms; --duration-slow: 400ms;
--duration-very-slow: 500ms;
--ease-smooth-out: cubic-bezier(0.22, 1, 0.36, 1);
--ease-bounce: cubic-bezier(0.34, 1.36, 0.64, 1);
--ease-bounce-strong: cubic-bezier(0.34, 3.85, 0.64, 1);
--distance-micro: 4px; --distance-small: 6px; --distance-base: 8px;
--distance-medium: 12px; --distance-large: 30px;
--scale-large: 0.96; --scale-medium: 0.97; --scale-small: 0.98; --scale-tiny: 0.99;
--blur-small: 2px; --blur-medium: 3px; --blur-large: 8px;
--resize-dur: 300ms; --resize-ease: cubic-bezier(0.22, 1, 0.36, 1);
```

具名互動模式：

- **下拉選單**：open 250ms、close 150ms，開前 scale 0.97、關時 0.99，曲線 `--ease-smooth-out`；
- **modal／command palette**：open `--duration-fast`、close `--duration-quick`、scale 0.96；
- **滑動 tab pill**：250ms `--ease-smooth-out`，底條退後、pill 浮起。

註解標明這些值來自 transitions.dev。

**「開快關更快、先縮一點再長出來」是這套動效的核心規則**：open 250ms 配 close 150ms、scale 0.96–0.99、`--ease-smooth-out`。要模仿的是這條規則，不是某一個特效。

**agent 狀態 → 動效（提案，未 prototype）**：

| nexus 狀態 | 建議 |
| --- | --- |
| 連線中 | `ThinkingOrb state="connecting"` |
| 模型在想（reasoning 串流） | `composing` |
| 工具執行中 | `working`；搜尋類工具 `searching` |
| 等人核准／回答 | 輸入區 `BorderBeam size="pulse-inner"` |
| 執行中（整體） | 輸入框 `BorderBeam size="md"`，完成時 `active=false` 讓它淡出 |
| idle／空白對話 | `breathing` |

### 3.4 與 nexus 現有設計系統的衝突（要拍板）

1. **暗色專用 vs light／dark**：Libraries.dev 寫死暗色；nexus 是 shadcn 的 `.dark` class（`apps/web/src/index.css` 第 3、27 行），dsh 的 `ui-theme` 也是 light／dark／system 三態。
2. **token 系統**：Libraries.dev 是 hex／rgba 的自家變數；nexus 是 shadcn 的 oklch 語意 token（`--background`、`--card`、`--muted`……）。可行做法是**把 Libraries.dev 的值映射進 shadcn 的語意 token**，並另加 `--stage`、`--chip`、`--material-shadow` 幾個 shadcn 沒有的名字，而不是換掉 token 系統。
3. **accent**：nexus 目前 neutral 無彩；Libraries.dev 暗色 accent `#55cfff`、CTA `#0071fc`。
4. **字型**：Inter＋Roboto Mono 可以用；Saans 授權不明，標題字要另選。
5. **效果套件要裝，還是只模仿觀感**：裝的話多兩個相依（無傳遞相依，peer 只有 React）；模仿的話要自己寫 canvas 與 CSS。

## 4. wayfinder 起圖素材

`/mattpocock-skills:wayfinder` 設定為 `disable-model-invocation`，只能由使用者呼叫，agent 不能代跑流程。以下是起圖時可以直接貼的素材，**destination 與 frontier 仍要在 grilling 裡定**。

**Destination（候選）**：

- A：一份可以交給實作的 **nexus web UI 規格**：元件清單拍板、設計 token 定稿（light＋dark）、動效規則、RWD 規則，外加一個可點的 prototype。
- B：A ＋ **P0 元件在 `apps/web` 裡實作完成**（在 Notes 裡明寫地圖要帶執行）。

**Notes**：

- 技術標準照 [AGENTS.md](../AGENTS.md)，UI **行為**照 dsh（`references/deepseek-harness` `e459e32`），元件庫選型見 [agent-ui-library-survey.md](agent-ui-library-survey.md)，清單與 token 見本檔。
- 已定的 RWD：1024px 收側欄、觸控目標 44px、核准卡獨立（#317）。
- 動效 token 來自 Libraries.dev `site.css`，**不拿 Saans 字型**。

**候選 ticket（問題已經夠精確）**：

| 標題（草稿） | 類型 | 被誰擋 |
| --- | --- | --- |
| 核准與提問要改成 dsh 的 composer takeover，還是保留卡片（不重開 #317：「等人」由核准卡表示、不是工具卡的一格，這條不變；這張只決定核准卡放在哪） | grilling | — |
| light／dark 策略：跟 Libraries.dev 暗色專用，還是映射成兩套 token | grilling | — |
| `thinking-orbs`、`border-beam` 直接裝，還是只模仿觀感 | grilling | — |
| 標題字型選哪個（Saans 的替代） | grilling | — |
| 做一個設計語言 prototype：殼層＋訊息流＋工具卡＋輸入框，套 Libraries.dev 動效，手機與桌面各一版 | prototype | 上面四張 |
| 驗證 AI Elements `tool` 與 shadcn chat 元件在 nexus 裡 `shadcn add` 能 build | task | — |
| wire 要補哪些 P1 資料（reasoning、連線狀態、todo、goal、plan、context 用量）才撐得起 §2.3／§2.6 | research | — |

**Not yet specified（fog）**：

- P1 元件的呈現細節，要等 wire 補資料的研究有結論；
- 右側欄（檔案、預覽、終端）要不要做；
- 動效在低階手機上的效能預算（canvas 與 blur 的成本）；
- 子代理對話檢視的導覽方式。

**Out of scope（候選）**：語音（`voice-beam`）、生圖 loading（`img-fx`）、裝飾性特效（`liquid-gooey`、`metal-fx`）、設定頁、dock 分割版面。
