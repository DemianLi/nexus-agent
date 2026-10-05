# OpenBitFun 是不是「萬物皆可插件」—— 對照 dsh／Cordis 的調研

這份筆記回答一個問題：[OpenBitFun](https://github.com/GCWing/OpenBitFun) 的架構是不是也屬於「萬物皆可插件」，有沒有 dsh 那種 Cordis 式的靈活核心。同一主題的我方現況見 [`plugin-architecture-gap-survey.md`](plugin-architecture-gap-survey.md)，容器／領域／打底的取捨見 [`kernel-split-tradeoff.md`](kernel-split-tradeoff.md)；本篇只管 OpenBitFun 這一側，不重述那兩份。

**調研日期**：2026-10-06。對讀版本：OpenBitFun `18aa5441d89f5e24cfb4d8ff54d4b53d92c68896`（`--depth 1` clone，HEAD 是 2026-10-04 合併 PR #3277 的 merge commit）；dsh `5badb15009ae1756c3afe0ae0cef1faafc290ccc`（`references/deepseek-harness`，HEAD 日期 2026-10-03，這次**沒有**重新 fetch）。兩份 clone 都在 `references/`，不進版控。OpenBitFun 的文件以簡體中文為主，本文引用處已轉成繁體。

## 結論

**不是。** OpenBitFun 走的是「先組裝、後擴展」：核心是固定的具體型別，外面開了一批受控的擴展點，擴展只能「提交貢獻」。dsh 的準則相反——產品的每一部分都是插件，**連 agent loop 本身也是**，因此每個都能從設定替換（`deepseek-harness/docs/architecture.zh.md:11-13`）。

**它沒有 Cordis 這種東西。** 它有建構期的型別化依賴注入，沒有執行期的插件樹。細項見 §三。

**但「沒有」要說得精確**：補查之後，有三處是執行期或設定切換的**封閉集合**（WebSearch 供應者、本機／SSH 工作區、模型 API 格式），另有一個建構期換掉整個核心的出口（Rust Runtime SDK preview）。四者都不開放給第三方在執行期註冊一個元件去換掉內建行為。見 §二。

## 這份筆記的來源與可信度

| 區塊 | 誰做的 | 核對狀況 |
| --- | --- | --- |
| §一 判準與 §三 Cordis 對照 | 主代理讀 | 第一手；每個宣稱附 `檔案:行號`（路徑相對 `references/OpenBitFun/`，除非另寫） |
| §二 三種「可換」與 §五 port 分類 | 主代理讀 | 第一手；實作點用 `grep -rnE "impl.* <Trait> for "` 取得，逐個核過是不是測試替身。**只核對了 §五表裡列出的 port**，其餘 port 見 §七；2026-10-06 追查補了 `DialogRoundInjectionSource`、同名工具路由、同 id Agent 三項（§七 A） |
| §四 看起來像插件的東西 | 主代理讀 | 第一手；文件說法與程式碼分開標，兩者不一致處收在 §七 |
| §六 對 nexus 的意義 | 主代理 | 判斷，不是事實 |

**這份筆記沒有子代理的產出。** 先前口頭回答時說過「沒有可在執行期替換的內建模組」，那句話當時只在工具註冊表與核心迴圈兩處驗證過；本次補查把它改成 §二的精確版本。

## 一、判準

**核心行為（迴圈、調度、會話、權限、取消）能不能靠在執行期註冊一個元件來替換。** 能就是萬物皆可插件，不能就是「核心固定、外面有擴展點」。

- dsh：能。profile 是一棵插件樹，一條 patch 按 id 定位條目並替換整個 config（`architecture.zh.md:19-27`）。
- OpenBitFun：不能。對話迴圈由 `assembly/core` 裡寫死的具體型別持有：`ConversationCoordinator`（`src/crates/assembly/core/src/agentic/coordination/coordinator.rs:1239`）→ `DialogScheduler`（`coordination/scheduler.rs:367`）→ `ExecutionEngine`（`execution/execution_engine.rs:604`）→ `RoundExecutor`（`execution/round_executor.rs:54`）→ `ToolPipeline`（`tools/pipeline/tool_pipeline.rs:657`）。

文件自己也這樣說：
- 「先裝配後擴展」是八條架構目標之一（`docs/architecture/product-architecture.md:23`）。
- 現行迴圈仍由 `assembly/core` 持有，`agent-runtime` 還沒有獨立擁有完整迴圈（`product-architecture.md:247`）。
- 能力整合文件把「開放第三方代碼替換權限歸屬模塊、狀態機、審計、取消樹、資源硬上限或產品身份」列為明文非目標（`docs/architecture/extensions/capability-runtime-integration-design.md:40`）。
- 它也不建立插件運行對象、註冊表或狀態機（`product-architecture.md:688`），連 `MemoryProviderRegistry` 這類登記表都「不會先創建」（`capability-runtime-integration-design.md:100`）。

## 二、補查：四種「可換」

| 類型 | 換的是什麼 | 誰能換、何時換 | 證據 |
| --- | --- | --- | --- |
| **A 建構期換整個核心** | 實作 `AgentSubmissionPort` 等一組 port，在 `agent-runtime` 上組一個新產品 | 組裝者，編譯期 | 範例 `src/crates/execution/agent-runtime/examples/sdk_minimal.rs:18`。文件稱它是 **Rust Runtime SDK（preview）**，不是公開 SDK（`product-architecture.md:505-509`） |
| **B WebSearch 供應者** | `Arc<dyn WebSearchProvider>` 放在 `RwLock` 裡，依設定在執行期換 | 使用者改設定；候選只有 Exa、Tavily、Unavailable | `assembly/core/src/service/web_search.rs:37`（`replace`）、`:60`（全域 `OnceLock`）、`:116`（`resolve_provider`）；實作 `services/services-integrations/src/web_tools.rs:104`、`web_tools/tavily.rs:58` |
| **C 本機／SSH 工作區** | `WorkspaceFileSystem` 與 `WorkspaceShell` 的兩組實作 | 由工作區種類決定；候選是本機與 SSH | 本機 `services/services-core/src/workspace.rs:21`、`:256`；SSH `services/services-integrations/src/remote_ssh/workspace_services.rs:103`、`:397` |
| **D 模型 API 格式** | 五種：`OpenAIChat`、`OpenAIResponses`、`Anthropic`、`Gemini`、`GeminiCodeAssist` | 使用者設定字串，解析成封閉列舉 | `adapters/ai-adapters/src/client/format.rs:4-29`（`parse` 對未知值回錯） |

B、C、D 都是「設定在一個編譯期固定的集合裡選」，第三方不能加入新的候選。A 是換整個核心，不是掛一個插件。

## 三、Cordis 的五項能力，OpenBitFun 對應什麼

| Cordis／dsh 的能力 | OpenBitFun |
| --- | --- |
| 服務用名字掛進共享上下文，誰都能提供或替換 | **明令禁止**：「不要引入無型別 map、全域可變註冊表或隱式服務查找」（`execution/runtime-services/AGENTS.md`，Guardrails）。取而代之的是型別化的 `RuntimeServices` 欄位組（`execution/runtime-services/src/lib.rs:75`）與 `RuntimeServicesBuilder`（`:190`）。`RuntimeServicesRegistry` 只是建構期的供應者鏈（`:390-421`），生產唯一的呼叫點是第一方的 `assembly/core/src/product_runtime/runtime_services.rs:179` |
| 設定檔就是插件樹，可用 patch 替換任一節點 | **沒有**。產品形態由 Cargo feature 與 `DeliveryProfile` 決定；全域工具註冊表以 `OnceLock` 鎖定，換形態直接回錯（`assembly/core/src/agentic/tools/registry.rs:296-314`） |
| 副作用隨插件卸載自動撤銷 | **只有插件貢獻那條有**：以「代際」撤下該插件自己的貢獻（`docs/architecture/extensions/plugin-runtime-design.md` §4.3、§4.4）。內建能力不能卸載 |
| 型別化事件，任何插件可宣告新事件 | **封閉**。生命週期事件是固定 11 個（`src/crates/execution/agent-runtime/src/native_hooks/settings.rs:42-57`）；`RuntimeHookKind` 只有 `Lifecycle`、`SuccessfulToolPostCall`、`PluginHook(String)` 三種（`native_hooks/kind.rs:9-13`），最後一種的字串是外部生態（OpenCode）自帶的鉤子名 |
| 熱重載（HMR） | **沒有通用機制**。插件更新要先停舊 Plugin Host、確認進程樹退出、再載入新的（`plugin-runtime-design.md` §4.3）。唯一接近的是自訂 Agent 的檔案監看（`assembly/core/src/agentic/agents/registry/custom_watch.rs`，feature `file-watch`），它重載的是資料檔，不是程式碼 |
| agent loop 本身是插件 | **否**，見 §一 |

**它最接近「統一插件面」的地方是鉤子**：內建、使用者、專案、匯入、技能、插件六種來源註冊進同一個 `RuntimeHookRegistry`，有固定的來源優先序（`RuntimeHookSource`，`native_hooks/kind.rs:19-31`）。但事件集合是封閉的，來源之間仍有權限與信任的差別，不是對等的插件。

## 四、看起來像插件的東西，逐項

README 說「從 Mini App 到原始碼都能客製」，所以逐項講清楚為什麼不改變結論。

| 項目 | 實際上是什麼 |
| --- | --- |
| 內建工具 | 封閉集合：`ToolPackFeatureGroup` 列舉（`src/crates/execution/tool-provider-groups/src/lib.rs:9`）加一個寫死的 `match` 把工具名對到群組（`:92`），再由 Cargo feature 決定編不編進去。AGENTS 規定：要加內建工具得有「一個確切的 feature group 擁有者」（`tool-provider-groups/AGENTS.md`） |
| 執行期註冊工具 | 只有 MCP 與動態工具走 `register_mcp_tools`／`register_tool`（`registry.rs:102`、`:214`），型別是 `Arc<dyn Tool>`，與內建工具進同一個註冊表。MCP 工具名固定加 `mcp__<server>__` 前綴「避免命名衝突」（`assembly/core/src/service/mcp/adapter/tool.rs:141-145`），所以 MCP 與內建同名的情形很少；同名衝突怎麼處理見 §七 A 第 1 點 |
| 內建 Agent | `build_builtin_agents` 從固定的 `builtin_agent_specs()` 建出；重複 id 會被跳過並記錯誤（`assembly/core/src/agentic/agents/registry/builtin.rs:16`、`:38`）。來源只有 `Builtin`／`Project`／`User`／`External` 四種（`registry/types.rs:36-41`）。自訂 Agent 與既有 id 同名時**被跳過**，只記警告：使用者層不能蓋內建（`registry/custom.rs:178-181`），專案層不能蓋全域（`:191-196`），所以優先序是內建 > 使用者 > 專案 |
| OpenCode 插件、Hooks、Skills、自訂 Agent、MCP | 只能提交貢獻，由原本的歸屬模組校驗後才生效；插件不直接寫核心狀態、工具結果、權限或審計（`product-architecture.md:656`） |
| 外觀包（皮膚） | 只收強型別資料，不收 CSS、DOM 選擇器、HTML 或 JavaScript（`docs/architecture/appearance-package-system.md`「目標」） |
| `extensions/dsh-openbitfun`、`adapters/dsh-adapter` | 兩邊之間的橋：前者是一個 dsh 插件，讓 dsh agent 呼叫 OpenBitFun（`extensions/dsh-openbitfun/README.md`）；後者把 dsh 的設定當外部來源讀進來。**不代表 OpenBitFun 採用了 dsh 的結構** |
| 擴展維度整體的成熟度 | 文件自己標 Partial（`product-architecture.md:127`） |

## 五、補查：`runtime-ports` 的 60 個 trait

`src/crates/contracts/runtime-ports/src` 共 60 個 `pub trait`。它們不是「給插件實作的擴展介面」，而是把可移植的 `agent-runtime` 與具體實作隔開的邊界。按生產側的實作情況分三類（只列核對過的）：

| 類型 | 例子 | 生產側實作 |
| --- | --- | --- |
| **標記型**（空 body，只表達「這個能力有沒有裝」） | `FileSystemPort`、`WorkspacePort`、`NetworkPort`、`GitPort`、`McpCatalogPort` | 空實作：`services/services-core/src/local_runtime_ports.rs:27`、`:40`；`execution/runtime-services/src/lib.rs:70-72`。AGENTS 明說標記 port 只能表達可選能力的可用性，不能做 IO、持有生命週期（`runtime-services/AGENTS.md`） |
| **單一生產實作** | `SessionStorePort`、`TerminalPort`、`RuntimeEventSink`、`AgentTurnCancellationPort` | 各一個：`CoreSessionStorePort`（`assembly/core/src/agentic/session/session_store_port.rs:200`）、`TerminalRuntimePort`（`services/terminal/src/runtime_port.rs:58`）、`LocalRuntimeEventSink`（`services/services-core/src/local_runtime_ports.rs:73`）、`DialogScheduler`（`coordination/scheduler.rs:3421`）。其餘實作者全是測試替身 |
| **只有測試與範例的多實作** | `AgentSubmissionPort` | 13 處 `impl`：生產 1 處（`assembly/core/src/service_agent_runtime.rs:214`），其餘是測試替身、`examples/sdk_minimal.rs:18` 與 SDK 組裝測試 |
| **迴圈內的設定一次縫** | `DialogRoundInjectionSource` | 輪邊界「有沒有待注入的訊息」的查詢介面（`contracts/runtime-ports/src/agent_api.rs:1035`）。生產實作只有調度器自己的 `SchedulerRoundInjectionSource`（`assembly/core/src/agentic/coordination/scheduler.rs:310`），包著 `SessionRoundInjectionBuffer`；`NoopDialogRoundInjectionSource`（`agent-runtime/src/scheduler.rs:499`）是獨立 runtime 的預設。接到協調器的口是 `OnceLock`，只能設一次（`coordinator.rs:1260`、`:2505`）。它是執行層向調度器要資料的縫，不是擴展點 |
| **真的有多個生產實作** | `WorkspaceFileSystem`、`WorkspaceShell`、`WebSearchProvider` | 本機與 SSH 兩組；Exa 與 Tavily，見 §二 B、C |

**結論**：這 60 個 port 的作用是跨 crate 解耦與測試縫，不是第三方擴展點。生產側真正「選一個」的只有 §二 B、C 兩處。

## 六、對 nexus 的意義（判斷，不是決議）

**與我們 AGENTS.md 的關係**：技術實現以 dsh 為標準，這一點 OpenBitFun 與 dsh 相反，所以拿它當架構依據不成立。本篇不建議任何偏離。

**可以當細節參考的幾處**（都是它做了、我們尚未逐項比對的；要採用得另開卡，並照 AGENTS 的偏離規則標註）：
- 插件工具不能因為與內建工具同名而解鎖內建工具：`assembly/core/src/agentic/tools/product_runtime/catalog.rs:573-575` 的測試 `selected_plugin_tools_extend_manifest_inputs_without_unlocking_colliding_builtins`。
- 鉤子來源有固定優先序，並與「誰有權限」分開（`kind.rs:19-31`）。
- 把「標記型 port」限定成只表達可用性、不得做 IO（`runtime-services/AGENTS.md`）。

**要留意的反面教材**：它的「可替換」清單（記憶檢索器、上下文貢獻器、壓縮器、排程策略，`capability-runtime-integration-design.md:30`、`:67-80`）是**設計目標**，同一份文件又說不會先建登記表（`:100`），我沒有在程式碼裡找到對應的 provider trait 與生產建構點。引用時不能當成已交付。

## 七、查清楚了什麼、還沒查清楚什麼

### A. 2026-10-06 追查，已有結論

1. **同名工具不是單純覆蓋，而是先過一層路由。** `register_mcp_tools` 遇到同名只記警告（`registry.rs:118-124`），但接著的 `route_external_tool_registration`（`registry.rs:19`）會交給 `intercept_registration`（`assembly/core/src/external_tools.rs:1062`）：
   - 若該名字已有一個 `ExternalToolMux`（外部來源的候選曾經頂替過原工具），新註冊的工具不覆蓋，只存進 mux 的 `original`，各工作區的路由依「使用者選過哪個候選」決定（`WorkspaceRoute` 的 `Original`／`External`／`Live`／`Unavailable` 四態，`external_tools.rs:330-346`）。
   - 原本被使用者選過的路由（帶 `conflict`）會變 `Unavailable`，也就是**擋下而不是悄悄換**；沒選過的 `Live` 路由退回 `Original`（`external_tools.rs:1076-1093`）。
   - 若該名字沒有 mux，才是真的覆蓋，但因為 MCP 名稱有前綴，實務上很少撞到內建工具。
   
   所以文件的「同名並存、不靜默覆蓋」在外部來源這條路上**有對應實作**；「覆蓋只記警告」只發生在沒有外部候選介入的那一格。遠端工作區一律走原工具，不走本機路由（`external_tools.rs:513-517`）。
2. **自訂 Agent 與內建同 id：內建贏，自訂被跳過**，見 §四第二列。
3. **`DialogRoundInjectionSource` 不是擴展點**，見 §五。我上一版猜它「很可能是迴圈內的一個真縫」，只對一半：它確實是迴圈與調度器之間的縫，但生產上只有一個實作、接口只能設一次。

### B. 仍然沒查清楚

1. **60 個 port 只核對了 §五表裡列出的**。其餘（如 `PermissionGrantStorePort`、`PermissionAuditStorePort`、`PermissionReplyStorePort`、`AgentModeCatalogPort`、`PluginRuntimeClient`、各 `Remote*` port）只看了實作點的個數，沒逐個確認哪些是測試替身。
2. **`ExternalToolMux` 只讀到選路與註冊那段**，沒有追「候選怎麼產生、使用者怎麼選」的 UI 與持久化。
3. **這是 `--depth 1` clone**，看不到演進歷史，也就看不到「為什麼不做成 Cordis 式」有沒有被討論過。文件裡只有結論，沒有取捨紀錄。
4. **dsh 沒有重新 fetch**；§一引的 `architecture.zh.md:11-13` 是 2026-10-03 那版。
