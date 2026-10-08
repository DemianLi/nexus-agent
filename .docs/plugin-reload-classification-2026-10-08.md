# 插件「可並存／需重啟」分類

回答 [#1136](https://github.com/DemianLi/nexus-agent/issues/1136)，也就是後台不停機更新的草稿（PR #1140）§八「即時／需重啟」宣告欄位的**初稿**。接在 [`plugin-coexist-measurement-2026-10-07.md`](plugin-coexist-measurement-2026-10-07.md)（機制成立）之後：機制成立不代表每一顆插件都能走這條路，這份逐顆回答。

**量測日期**：2026-10-08。nexus `develop`（PR #1151 之後）；Node 25.9.0；`tsx`。

## 結論

- 出貨的 **20 顆 `packages/nexus-plugin-*`**（卡上寫 22，今天只有 20；`packages/` 另有 `nexus-core`、`nexus-wire` 兩個不是插件）：
  - **可並存 16 顆**：agent-instructions、ask-user、echo、feedback、memory、mcp、plan-mode、present、quickjs、skills、submit-record、system-prompt、telemetry-otel、todo、token-meter、trajectory。其中 memory、mcp、quickjs、skills、telemetry-otel 不在出貨清單（選配或未掛），可並存是「若要掛」的結論。
  - **需重啟 4 顆**：goal、sandbox-policy、workspace-changes、commands。原因都是**宿主直接 import 它的值**或**宿主在組裝點自己建它**，不是插件內部有共用狀態。
- `cordis.yml` 另有 **8 列 `@nexus/core/*`**、**16 列 `#settings/*`**、**4 列 invariant 配套**。程式碼住在 core 或 harness 裡，**程式碼一律需重啟**；它們的**設定**分兩種：14 列起動期讀一次（需重啟），3 列 settings＋7 列 core 在組裝期讀（新 thread 生效）。
- **有一個前提今天不成立**：出貨清單（`loadDefaultPlugins`）在 server 起動時解**一次**、每個 thread 共用那一份已 import 好的模組物件。所以「新 thread 讀到新版／新設定」今天**做不到**，連「組裝期讀」的那幾列也是——要先把清單改成組 thread 時重讀（草稿 §五第 3 項）。下面的「新 thread 生效」都是這個前提補上之後的結論。

## 判準（每條都能機械查）

| 判準 | 怎麼查 | 判定 |
| --- | --- | --- |
| R1 模組層級可變狀態、行程級資源（`process.on`、`setInterval`、`listen`、子行程、`globalThis`） | 對每個套件非測試原始碼掃描；有命中的逐處讀 | 有 → 需重啟 |
| R2 宿主直接 import 套件的**值**（不是 `import type`） | `apps/harness/src` 非測試檔對 `@nexus/plugin-*` 的 import | 有 → 需重啟（宿主用的是起動時那一版，新 thread 的插件卻是新版） |
| R3 宿主在組裝點自己建，不經清單條目 | `cordis.yml` 沒有這一列、`apps/harness/src` 有 import | 是 → 需重啟（沒有條目可換） |
| R4 起動期讀（`startupSetting`／`startupEntryMounted`） | `apps/harness/src` 的呼叫者 | 是 → **設定**需重啟 |
| R5 輸出到共用通道（wire frame、日誌事件詞彙） | 看它註冊的投影與事件 | 輸出形狀不變才可並存；改形狀要連同 core 與 web |
| R6 狀態全在 `apply` 裡、只註冊工具／命令／中介層／服務 | 掃描 0 命中且探針通過 | 可並存 |

**探針**（`apps/harness/src/measure/plugin-coexist-real.ts`）：把真套件的 `src/`（去掉測試）複製成 `v1`、`v2` 放在**套件自己的目錄底下**，各 `import()` 後各開一個 thread 並行 `loadPlugins`，檢查 ①兩份是不同的實例 ②註冊出來的工具名與命令名相同 ③A 收掉後 B 的註冊還在 ④兩個都收掉後行程的活資源（`process.getActiveResourcesInfo()`）回到載入前。

兩個意外值得記下：

- **副本放在套件目錄外會載不起來**：`mcp`、`quickjs`、`telemetry-otel`、`workspace-changes` 的相依（MCP adapter、`quickjs-emscripten`、`@opentelemetry/*`、`diff`）住在**套件自己的 `node_modules`**，副本放到 `apps/harness/` 底下就是 `Cannot find package`。這是「新版要連同自己的 `node_modules` 一起裝」的第二份證據（第一份是上一份量測的自帶 `zod`）。
- **沒有任何一顆漏資源**：16 顆可並存的，收掉前後活資源數量完全相同。

## A. 20 顆 `nexus-plugin-*`

「出貨」：Y＝在 `cordis.yml` 有一列；code＝只在 `apps/harness/src` 組裝；—＝兩邊都沒掛。掃描欄是 R1：命中數與逐處讀的結論。

| 套件 | 出貨 | 掃描（R1） | 宿主耦合（R2／R3） | 探針 | 判定 | 理由 |
| --- | --- | --- | --- | --- | --- | --- |
| agent-instructions | Y | 無 | 無 | 過 | **可並存** | 只註冊一顆中介層 |
| ask-user | Y | 無 | 無 | 過 | **可並存** | 只註冊工具 |
| echo | Y | 無 | `assembly-root` 讀 `ECHO_TOOL_NAME`（常數） | 過 | **可並存**（改工具名要連同宿主） | 示範用；宿主只讀一個名字常數 |
| feedback | Y | 服務在 `apply` 內建 | 無 | 過 | **可並存** | 服務每次掛載一份，agent-factory 每 thread 讀；寫的是核心詞彙的 `feedback/record` |
| goal | Y | 模組層級只有兩張常數集 | **值**：`goal-driver`（`renderGoalRoundPrompt`）、`goal-wire`（`applyGoalEvent` 折疊）、`assembly-root`（常數） | 過 | **需重啟（R2）** | 插件本身乾淨，但宿主用起動時那一版的折疊與提示詞去解讀新版寫出的事件 |
| mcp | — | `listen` 在測試夾具；`apply` 內開 client，`onDispose` 收 | 無 | 過（連不上的最小設定） | **可並存** | 每次掛載各自一個 client／子行程；代價是兩版各開一份連線 |
| memory | — | 無 | 無 | 過 | **可並存** | 4 KB 薄層 |
| plan-mode | Y | 無 | serve 路徑只有 `import type`；`cli.ts` 讀 `recordedPlanMode` 值 | 過 | **可並存**（serve）；CLI 不走後台 | 命令＋中介層＋工具 |
| present | Y | `apply` 內的 `Map`，`onDispose` 清 | `import type` | 過 | **可並存** | 交付檔上限是起動期設定（`deliverable-files`），不是這顆的 |
| quickjs | — | 無 | 無 | 過 | **可並存** | 只註冊工具；相依在自己的 `node_modules` |
| sandbox-policy | code | 無 | **值**：`serve`、`cli`、`assembly-root` 都 import；要宿主提供 `sandboxPolicy` 服務 | **失敗**：沒有宿主服務就 `apply` 失敗 | **需重啟（R2／R3）** | 控制器由組裝點建、跨 thread 與背景子代理共用 |
| skills | — | 無 | 無 | 過 | **可並存** | 只提供一條慣例路徑 |
| submit-record | Y | 無 | 無 | 過 | **可並存** | 只註冊工具 |
| system-prompt | Y | 無 | `import type`；要宿主提供 `systemPromptVariables` | 過（補上宿主服務後） | **可並存**（前提：宿主服務形狀不變） | 中介層；變數由組裝點算 |
| telemetry-otel | — | `apply` 內建 `OpenTelemetrySessionService`（帶 OTel provider） | 無 | 過（`disabled` 模式） | **可並存**，**但**要想清兩版同時對外送資料的披露 | provider 每次掛載一份；用 `exporter` 實際送資料的情形沒測 |
| todo | Y | 無 | 全是 `import type` | 過 | **可並存** | 工具＋日誌事件；事件詞彙在 core |
| token-meter | Y | 無 | 無 | 過 | **可並存（R5）** | 註冊一個投影；改投影輸出形狀要連同 web |
| trajectory | Y | 兩個 `WeakMap`／常數集，不是行程級 | 無 | 過 | **可並存（R5）** | 同上；原始碼 43 KB |
| workspace-changes | code | `apply` 內每會話一個私有暫存目錄（`mkdtemp 0700`）、`git` 子行程 | **值**：`assembly-root` 建 `createWorkspaceChanges`；`wire-handler` 讀服務 | 過（給 `root`） | **需重啟（R3）** | 插件內部乾淨，但服務是宿主在組裝點建的 |
| commands | code | 無 | **值**：`cli`、`wire-handler` 建 `createCommandExecutor` | **不是插件**（沒有 default 匯出） | **需重啟（R2）** | 是宿主用的函式庫，不走條目 |

## B. `cordis.yml` 的 8 列 `@nexus/core/*`

程式碼在 `@nexus/core`，換它就是換核心，**一律需重啟**。下表只講設定：

| 列 | 設定何時讀 | 備註 |
| --- | --- | --- |
| repeat-reminder、tool-result-pruner、summarization、observation-policy、model-usage、session-checkpoint-policy | 組裝期（`foldRegistry` 從服務讀） | 新 thread 生效（前提見結論） |
| approval-gate | 組裝期，且**關不掉** | 載入期 `disabled: true` 就拋 |
| session-persistence | **起動期**（`startupSetting`＋`startupEntryMounted`） | 設定需重啟；代表落盤本身 |

## C. `cordis.yml` 的 16 列 `#settings/*`

程式碼住在 `apps/harness/src/settings/`，**程式碼需重啟**。設定：

| 設定何時讀 | 列 |
| --- | --- |
| **組裝期，服務**（新 thread 生效） | agent-loop、recursion-limit、tool-fs-search |
| **起動期，`startupSetting`**（需重啟） | thread-title、thread-title-llm、thread-search、browser-session、deliverable-files、tool-text、projection-flush、tool-result-stash、spill-policy、background-subagents、subagent-model-selection、live-model、default-model |
| 測試用，不在出貨清單 | scripted-model |

`serve.ts`、`cli.ts`、`assembly-root.ts`、`model-provider.ts` 是起動期讀的消費者；`agent-factory.ts` 是組裝期讀的消費者。

## D. invariant 配套（4 列）

`core-invariant`、`commands-invariant`、`goal-invariant`、`plan-mode-invariant`：是「裝在 session 上檢查日誌的守衛」，隨自己所屬的套件走。所屬套件需重啟的（core、commands、goal）它們也需重啟；plan-mode 的隨 plan-mode。

## 建議的宣告欄位形狀（供拍板）

草稿 §八要的是每顆插件一個「即時／需重啟」欄位。這份清單顯示**一個欄位不夠**，至少要分兩個問題：

1. **程式碼能不能換**（`code: 'coexist' | 'restart'`）：看 R1／R2／R3／R5。16 顆 `coexist`、4 顆 `restart`；core、harness 的條目全是 `restart`。
2. **設定改了何時生效**（`config: 'next-thread' | 'restart'`）：看 R4。

「後台顯示需重啟提示」該依哪個欄位，要看操作的是什麼：換版本看 `code`，改欄位值看 `config`。

欄位放在 `NexusPlugin` 上（跟 `name`、`requires` 並列）比寫在 `cordis.yml` 好：判定來自插件自己的程式碼（它有沒有模組層級狀態、宿主有沒有 import 它），不是來自某一次部署的設定。但 **R2／R3 是宿主端的事實**（宿主 import 誰），插件自己宣告不了——所以 `restart` 的原因有兩種來源，欄位宣告只能涵蓋插件自己知道的那一半。這一點需要你決定欄位由誰擁有。

## 沒驗證的、會讓上面失準的

- **R5 沒有機械檢查**：「輸出形狀不變」是人判的。token-meter、trajectory 的投影一旦改形狀，並存期間 web 會同時收到兩種形狀。
- **探針只驗載入與收掉，沒有跑工具**：兩版註冊出來的工具名一致，不代表兩版行為一致。
- **telemetry-otel 只測了 `disabled` 模式**；真的送資料時兩版同時對外送，披露策略（`telemetrySharing`）怎麼表達沒查。
- **R2 的「宿主用起動時那一版」是推論**：沒有實際把不同版本的事件餵給宿主的折疊去看會不會壞。
- **掃描是靜態文字比對**，漏的可能是用別名或間接方式碰行程級資源的情形；有命中的都逐處讀過，沒命中的靠探針兜底。
- **日誌格式相容**：舊 thread 續接時組裝的是**當時的**新版，它會重放舊版寫的日誌；折疊函式能不能吃舊版事件，歸 [#1138](https://github.com/DemianLi/nexus-agent/issues/1138) 的範圍，這份沒查。
- 沒有列 `apps/harness` 之外的「設定型插件」：卡上提的是 `apps/harness` 內掛的那幾顆，已涵蓋在 C。

## 重跑

```bash
cd apps/harness
# 真套件並存探針（輸出每顆一行 JSON）
npx tsx src/measure/plugin-coexist-cli.ts real agent-instructions ask-user echo feedback goal mcp memory plan-mode present quickjs sandbox-policy skills submit-record system-prompt telemetry-otel todo token-meter trajectory workspace-changes commands
```

副本建在 `packages/nexus-plugin-<name>/.coexist-real-*`，跑完自己刪；中途被砍可能留下，手動刪。
