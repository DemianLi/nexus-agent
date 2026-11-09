# nexus 的底座「完全 Rust、完全不引用 Cordis」？—— 範圍、三條路的比較與要拍板的題

demian 2026-11-02 在 PM session 問：「屬於 nexus agent 的 cordis 底座是不是完全轉譯為 Rust 語言且完全不引用 cordis 函式庫？」答案是**不是**，見 §一。本篇研究「如果要做到」這條路要換什麼、跟已拍板的兩層樹衝突在哪，並照 AGENTS.md〈技術實現標準〉比較三條路。

**這份是研究，不是決議。** 結論只寫「建議」；凡是要推翻已拍板決策的，列在 §七 的是／否題，由 PM 寫進 [#1827](https://github.com/DemianLi/nexus-agent/issues/1827) 請 demian 決定。卡稿在附錄 B，PM 審過才開。

**對讀版本**：

| 對象 | 版本 | 怎麼確認 |
| --- | --- | --- |
| nexus | `origin/develop` `c06ae4c7` | 2026-11-02 `git fetch` 後 `git rev-parse origin/develop` |
| Cordis 上游 | vendor 基準 `v4.0.0-rc.12^{}` = `01b39624` | `git ls-remote https://github.com/cordiverse/cordis 'refs/tags/v4.0.0-rc.12*'`；上游 HEAD 已到 `2bca2278`，本篇不用 |
| dsh | `master` `ce7073d5` | `references/deepseek-harness` 的 `git rev-parse HEAD` 對 `git ls-remote … refs/heads/master`，一致 |
| cordis-rs | `cd540033`（2026-10-28） | `git ls-remote https://github.com/dshbox/cordis-rs HEAD`；**用 `gh api` 逐檔讀，沒有 clone、沒有建 crate**（PM 2026-11-02 定 A=(a)）。`cd540033` 比 tag `v0.11.1`（`0f720427`）多 27 個 commit、改 8 個檔，**沒有一個在 `crates/*/src`**（`gh api repos/dshbox/cordis-rs/compare/0f720427…cd540033`），所以本篇的原始碼引用統一標 `@cd540033`，內容等同 v0.11.1 |

10-18 的 parity 實跑（83 情境、39 一致、44 不同，`~/.nexus-agent-evidence/2026-10-18/cordis-parity/`）對的是上游 rc.8／rc.11 與當時的 cordis-rs，**不是 rc.12 對 `cd540033`**；本篇引用時一律帶這個版本落差，研究期間不重跑（PM 2026-11-02 定 B）。

## 結論

| 問題 | 答案 |
| --- | --- |
| 今天的底座是 Rust 嗎 | **不是**。底座是上游 Cordis 的 TS 原始碼整份 vendor（§一）。repo 唯一的 Rust 是沙箱子行程啟動器 `native/sandbox-spawner` |
| 照已拍板的計畫走完，會是「全 Rust、零 Cordis」嗎 | **不會**。#1947–#1949 走完後，主機級的樹是 Rust 自寫核心（#1948 偏離 #8），但**每條對話行程裡的樹照舊是 TS Cordis**（Q21）。所以 demian 的問題實際上只剩一件事：**要不要把每條對話的那棵 TS 樹也換掉**（§二） |
| 換得掉嗎 | **有一條沒驗證過的路，加上兩個前置**。研究 §四 記的兩處 Rust 表達不出的地方，都出在這棵樹上：一處（Proxy 自動歸屬）nexus 的 SDK 已經大半繞開；另一處（LangChain 物件與 closure 當服務值）只有兩條路——在同一個 isolate 裡用 N-API 持有不透明的句柄（沒量過），或先讓 agent loop 脫離 LangChain（Q29 拍的是「要換，但不是現在」）（§四） |
| 建議 | **維持已拍板的兩層樹（路 1），#1947–#1949 沿用，不改寫、不取代。** 全 Rust 的對話樹解決的問題，形狀 B 已經用行程隔離解決；它要付的代價（重寫 vendor 的 22 個 TS 檔與 11 條本地修改（第 1 條空號）的語意、重新引入 nexus 剛在 #2253 拿掉的原生模組、改 54 個檔裡 134 行 `ctx.*` 呼叫點）換不到可量的提升（§五、§六） |

## 一、現況：底座是 TS，不是 Rust

每條都附指令與輸出，原始輸出在 `~/.nexus-agent-evidence/2026-11-02/full-rust/counts/`（判準一律 `rtk proxy … > $OUT; echo EXIT=$?`，見附錄 A）。

| 事實 | 證據 |
| --- | --- |
| 底座是 vendor 的上游 TS 原始碼，四個套件 | `git ls-tree -d --name-only origin/develop vendor/` → `cordis`、`include`、`loader`、`logger-console`（另有 `patches`）。`vendor/README.md` 清單四列的 commit 都是 `01b396240ce4…`，等於 rc.12 tag 的 peeled SHA |
| 全是 TS | `vendor/*/src/` 22 個檔，副檔名全是 `.ts` |
| 不從 npm 裝，名字改 `@nexus` scope | `vendor/README.md`〈本地修改〉第 4 條；與上游的差異逐條登在同一節（第 2–12 條，第 1 條空號） |
| repo 唯一的 Rust 是沙箱子行程啟動器 | 全樹 `git ls-tree -r --name-only origin/develop \| grep -Ei '(\.rs$\|Cargo\.(toml\|lock)$\|\.wasm$\|\.node$\|napi\|rust-toolchain)'` 11 行，全在 `native/sandbox-spawner/`；沒有 `.wasm`、`.node`、napi |
| 沒有原生 Node 模組 | `package.json` 裡找 `node-addon`／`napi`／`node-gyp`／`prebuild`：0 筆（EXIT=1）。唯一的那個（flock）已在 #2253 換成由 spawner 拿鎖（PR #2277，`97024216`） |
| Rust 底座的四段卡 | #1946 沙箱執行器 CLOSED（2026-10-30）；#1947、#1948、#1949 OPEN、未派工。所以**今天除了 spawner，Rust 底座是零** |
| agent loop | 仍是 deepagents／LangChain JS／LangGraph JS，往 Cordis 插件遷移中（#1385） |

## 二、範圍：問題只剩每條對話的那棵樹

已拍板（`.docs/nexus-cordis-rust-feasibility-2026-10-22.md` §五、§八；#1948 正文）：

```
Rust 監督行程（主機級的樹）              ← #1948：Rust 自寫核心，不 vendor TS Cordis（偏離 #8，Q14、Q17）
├─ MCP、模型並行上限、沙箱執行器、TS 插件版本登記
        │  橋：資料＋RPC（Q28）
        ▼
每條對話一個 Node 行程（對話級的樹）     ← Q21：照舊是 TS Cordis，插件寫法不變
└─ vendor/cordis + loader + include + logger-console
```

主機級的樹已經決定不用 Cordis，本篇不重談。**「完全不引用 Cordis」等於把下半部那棵樹換掉**，這就推翻 Q21，而研究 §四 的兩處「Rust 表達不出」正好都在這棵樹上。

demian 的問題其實是兩個可以分開的性質：

| 路 | 「全 Rust」 | 「不引用 Cordis 函式庫」 |
| --- | --- | --- |
| 1 現行兩層樹（#1947–#1949） | 主機級是、對話級不是 | 主機級是、對話級不是 |
| 2 對話級也用 Rust 自寫核心 | 是 | 是 |
| 3 對話級改用 cordis-rs | 是 | 不引用 TS Cordis，但引用 cordis-rs（它自稱 Cordis 的 Rust port，`crates/cordis-core/src/lib.rs:1-6@cd540033`） |
| （參考）自寫一份 TS 核心取代 vendor | 否 | 是 |

最後一列不展開成第四條路，只用來標出：若 demian 在意的是「不依賴上游 Cordis」而不是「語言」，Rust 不是唯一的答案。

## 三、要換掉什麼（量到的面，不是估計）

指令與原始輸出見附錄 A。範圍是 `apps/` 與 `packages/`，`origin/develop` `c06ae4c7`。

| 面 | 數字 |
| --- | --- |
| 在 `package.json` 相依 `@nexus/cordis*` 的 workspace 套件 | **24 個**（apps/harness＋23 個 packages/*）；另有 vendor 自己 4 個 |
| import `@nexus/cordis*` 的檔（靜態 `import`／`export … from`） | **84 個**：測試與量具 48、非測試 36 |
| 動態 `import('@nexus/cordis…')`、`require(`、`import.meta.resolve(` | **0**（POSIX regex `(import\(\|require\(\|resolve\()[[:space:]]*['"\`]@nexus/cordis`，EXIT=1） |
| 非測試檔的 import 行 | 49 行：`import type` 39、帶值 10。帶值的 10 行全在宿主與 SDK：`apps/harness/src/plugin-tree.ts:80-83`、`server-log.ts:23-25`、`packages/nexus-sdk/src/{conformance,contract,fixtures/boot}.ts` |
| 執行期經 Proxy 呼叫的 `ctx.*` | 非測試檔 **134 行、54 個檔**；行內逐一數 pattern 裡的方法名共 143 次：`effect` 38、`fiber` 37、`logger` 23、`get` 18、`plugin` 12、`on` 9、`provide` 4、`inject` 2。這是 grep 命中數，沒有逐行排除同名的非 Cordis 變數 |
| 經 SDK 讀服務 `service(ctx, …)`／`optionalService(ctx, …)` | 非測試 32 處 |
| 服務契約 | `defineToken<…>` 13 個（非測試、非 fixture），`extends ContractService` 15 處 |
| 不相依 `@nexus/cordis`、走相容層的插件套件 | `packages/nexus-plugin-*` 共 22 個，其中 8 個不相依：commands、mcp、memory、plan-mode、quickjs、sandbox-policy、telemetry-otel、workspace-changes。全 Rust 的樹一樣要接住它們 |
| 出貨插件樹 | `apps/harness/cordis.yml` 63 列 |
| vendor 本身 | 22 個 TS 檔，加 `vendor/README.md`〈本地修改〉11 條（第 1 條空號）的語意（寫回關閉、`only`、宿主解析、自我停用事件、`__jsExpr` 拒絕、fiber 卸載順序修補 0001／0002…） |

**`import type` 多不代表執行期相依少。** 插件只 import 型別，但執行期透過 Proxy 呼叫 `ctx.effect`、`ctx.fiber`、`ctx.on`、`ctx.provide`；換掉底座，這 134 行呼叫的語意都要由新核心給出。

## 四、研究 §四 的兩處「Rust 表達不出」，在對話樹上怎麼處理

### 4-1 Proxy 自動歸屬

- **TS Cordis**：每個 ctx 都是 `Proxy`（`vendor/cordis/src/context.ts:39@c06ae4c7`），effect 歸給呼叫它的 fiber，讀沒宣告的服務在 get trap 拋錯。
- **cordis-rs**：Context 改成「cheap-clone 的 Runtime view」，擁有者顯式（`lib.rs` 模組表 `context.ts → Context`）。它的 parity 帳本把 Proxy 相關的上游能力記成 `absence / upstream-only`：`internal/get`／`internal/set` 攔截（V20）、`accessor()`／`mixin()` 的 Proxy 屬性（S14）（`docs/v3-upstream-parity-ledger.md@cd540033`）。
- **nexus 的現況**：讀服務已經大半走顯式的 `service(ctx, token)`（`packages/nexus-sdk/src/token.ts:63@c06ae4c7`，非測試 32 處），ctx 本身就是插件自己的那一個，擁有者從 ctx 身分就知道。剩下要改的是直接 `ctx.get` 的 18 次（grep 命中，未逐行核是不是 Cordis 的 ctx）與嚴格 inject 的拋錯點。
- **判斷**：這一處**表達得出來**，代價是 SDK 改顯式、54 個檔的呼叫點重核。嚴格 inject（#1948 偏離 #11）在 cordis-rs v3 的現況**未核**：本篇讀到的 `docs/upstream-facts.md` 寫的是 v1 的狀態，不能當 v3 引用。

### 4-2 任意 JS 值當服務值

- **nexus 的現況**：服務值裡有 LangChain 物件與 closure。`ToolRegistry.register(tool: StructuredToolInterface)`（`packages/nexus-tools/src/index.ts:152@c06ae4c7`），`AgentLoop.preStep(name, listener)`（`packages/nexus-agent-loop/src/index.ts:133`）。非測試檔 import `@langchain/core/tools`（或用 `StructuredToolInterface`／`DynamicStructuredTool`）的插件套件 10 個：ask-user、echo、goal、mcp、plan-mode、present、quickjs、sandbox-policy、submit-record、todo。
- **cordis-rs**：服務值是 `Arc<dyn Any + Send + Sync>`，以 `TypeId` 當契約（`crates/cordis-core/src/service.rs:270-271@cd540033`）。**要求 `Send + Sync`。**
- **原型 P1（10-23）**：Rust 跨 isolate 持有 JS 函式 → V8 FATAL（研究 §四 第 2 點）。

能走的路只有兩條：

| 做法 | 怎麼做 | 狀態 |
| --- | --- | --- |
| (i) 同一個 isolate 內用 N-API 持有不透明句柄 | Rust 核心編成 N-API 模組，跑在對話行程的 JS 執行緒上；服務值存成 `napi_ref` 或「JS 側值表的 id」，Rust 只管生命週期與登記，值留在 JS | **沒量過。** P1 量的是**跨** isolate；同一個 isolate 的 `napi_ref` 是 N-API 的正常用法，但 (a) cordis-rs 要求 `pub trait Service: Send + Sync + 'static`（`crates/cordis-core/src/service.rs:134@cd540033`）；N-API 的值與參照只能在建立它的執行緒上用，這一半是推論，**未核**（沒讀 Node-API 文件或 napi-rs 原始碼）。若成立，路 3 得包一層執行緒親和的句柄或改用 id；(b) 每次 `emit`、`effect`、讀服務都跨一次 N-API 邊界，熱路徑成本沒量；(c) 重新引入原生 Node 模組，nexus 剛在 #2253 把唯一的那個拿掉（PR #2277），離線包、x64／arm64 兩個架構、SBOM 都要重談 |
| (ii) 先讓 agent loop 脫離 LangChain | 服務值收斂成資料＋RPC，像主機級的樹一樣 | 牽動 **Q29**（「要換，但不是現在」）。範圍是整個 agent loop 與 10 個插件套件的工具定義 |

找不到第三種機制。(i) 沒有探針之前，**這一處列為「未解」**。

### 4-3 每條對話那棵樹跨 JS／Rust 邊界的形狀與代價

- **形狀**：只能是 (i) 的「同行程 N-API」或 (ii) 的「資料＋RPC」。同行程跨 isolate 已被 P1 否決；跨行程（每條對話再拆一個 Rust 行程）就變成每次 `ctx.*` 都走 IPC，與研究 §三-6 量到的邊界延遲（監督行程 stats 往返長跑 p99 最高 210 ms，未調校原型）方向相同，本篇沒有另外量。
- **代價**：3 節的 134 行 `ctx.*`、32 處 `service()`、63 列樹、11 條本地修改（第 1 條空號）的語意全要由新核心給；Loader 的 YAML／patch／`only`／宿主解析要重寫（cordis-rs 的 Loader 讀 serde JSON、`deny_unknown_fields`，插件經 `PluginResolver` 解析：`crates/cordis-loader/src/plan.rs:82-90@cd540033`，沒有 Include 對應：tree 只有 `cordis`、`cordis-core`、`cordis-loader`、`cordis-timer` 四個 crate，沒有 include。帳本另記 group config 不插值（D12）與 entry 的 update／import／reload 接 Loader 事件（D14）為 `absence / upstream-only`）。
- **沒量的**：N-API 邊界的每次成本、對話行程的記憶體變化、冷啟動。都要 (i) 的探針才有數字。

## 五、三條路的比較（AGENTS.md〈技術實現標準〉）

### 5-1 dsh 怎麼做、為什麼

- **怎麼做**：dsh `ce7073d5` 的底座是 vendor 的 TS Cordis，`vendor/README.md:19@ce7073d5` 記 `@deepseek-ai/cordis` 4.0.0-rc.11（`0b96d9fd`），另 vendor loader、include、hmr、timer、group、logger-console、cosmokit、schemastery。**沒有任何 Rust**：`git ls-files` 找 `.rs`／`Cargo.toml` 為 0；原生只有 C（`native/system/packages/entry/src/{main,flock}.c`、`apps/desktop/cli/link-entry.c`）。全樹沒有提到 cordis-rs。相依深度：`from '@deepseek-ai/cordis` 的檔 1908 個（pattern `from ['"]@deepseek-ai/cordis`，含測試；排除 `.test|.spec|.e2e` 與 `test(s)/` 後 782 個）。
- **為什麼**：
  - 「產品的每一部分都是插件，包括模型適配器、工具註冊表、會話日誌，以及 agent loop 本身，因此每個都可以從配置替換」（`docs/architecture.zh.md:9@ce7073d5`）——插件要能是任意 JS 值，這正是 4-2 那一處。
  - vendor 原始碼「so that the harness fully owns its framework layer (auditable, patchable, pinned)」（`vendor/README.md:3@ce7073d5`）——要的是擁有與可稽核，不是換語言。
  - 升 rc.11 的計畫寫「Keep source vendoring」（`vendor/cordis-rc11-upgrade-plan.md:13@ce7073d5`，狀態 proposed）。
- **代價**：Proxy 與任意 JS 值帶來的是 JS 層的失控風險（一個插件拖垮行程），dsh 是單人桌機，沒處理；nexus 已經用形狀 B 的行程隔離處理（研究 §六 #1）。

### 5-2 比較

| 標準 | 路 1：現行兩層樹 | 路 2：對話樹也 Rust 自寫 | 路 3：對話樹改 cordis-rs |
| --- | --- | --- | --- |
| **正確性** | 對話樹語意 = 上游 rc.12＋11 條登記修改，有上游測試整包與 `nexus-tests/` 釘住 | 要自己重給 22 個檔的語意與 11 條修改；4-2 未解 | 帳本對上游 **`8cc9e33f`（`v4.0.0-rc.8-2`，2026-08-13）**，比 rc.12 落後 61 個 commit，core＋loader 的 src 差 17 檔（+795／−287，`git -C references/cordis diff --stat 8cc9e33f 01b39624 -- packages/core/src packages/loader/src`）。帳本 116 列：parity 7、representation rework 40、behavioral divergence 43、absence 26。10-18 實跑（舊版本）44／83 不同。4-2 未解，且 `Send + Sync` 可能擋 `napi_ref`（未核） |
| **失敗與恢復** | 失控由形狀 B 的行程隔離擋（S3、S3b、S3c，研究 §三-3）；核心出錯是 JS 例外 | 同路 1 的隔離；另多一類失敗：N-API 模組崩潰帶走整個對話行程，且不是 JS 例外、接不住 | 同路 2 |
| **效能** | 已量：p2 對有隔離的對照組 c0w 只省 9%，沒過 Q4.3 的 30%（研究 §三-4）。效能不是偏離理由 | 沒量。每次 `ctx.*` 多一次 N-API 邊界 | 沒量。同路 2 |
| **維護成本** | 跟上游同步靠 `vendor/sync.mjs --check`，11 條修改機械重做 | 自己扛整個核心＋Loader＋Include，上游修正要人讀人移植；加一個原生模組的建置與兩架構離線包 | 跟兩個上游：cordis-rs 與 TS Cordis（帳本 pin 自己會動）；它沒有 Include、`__jsExpr` 拒絕、宿主解析這些 nexus 的修改；加原生模組 |
| **nexus 產品需求**（內網、多人共用、稽核、幾百人開發） | 形狀 B 已滿足隔離與失控保護；插件作者寫法不變 | 隔離沒有多得到什麼；稽核面多一個原生二進位；插件作者寫法要改（顯式 ctx、服務值限制） | 同路 2，另多一個外部 crate 要跟版、要審 |
| **現有基座做不做得到** | 做得到，就是今天 | deepagents／LangChain 的工具物件是 JS 值，基座**做不到**純資料服務值，除非 Q29 提前；(i) 沒驗證 | 同路 2；cordis-rs 沒有 JS binding（crate 只有 `cordis`、`cordis-core`、`cordis-loader`、`cordis-timer`；10 個已讀檔 grep `napi\|wasm\|ffi\|javascript` 0 筆，tree 也沒有相關檔） |

**建議：路 1。** 理由：路 2、3 要解決的「失控保護」與「隔離」已由形狀 B 用行程邊界解決，對話樹換語言不再多擋一種失控；效能已量過不是理由；而它們要先解 4-2（沒驗證或要提前 Q29），還會把 #2253 剛拿掉的原生模組帶回來。比不出更好的地方，就照 dsh：對話樹用 vendor 的 TS Cordis。

**和 #1947–#1949 的關係：沿用。** 三張卡的正文不用改。若 demian 對 §七 Y1 答「是」，#1949 的範圍（收相容層）不變，另外在 #1385 底下加附錄 B 的卡，排在 #1949 之後。

## 六、還沒量、還沒讀的

- **4-2 (i)**：同 isolate 的 N-API 句柄沒有探針。要做得下載 napi-rs 等 crate、建原生模組，**屬下載，要先經 demian 核可**。
- **N-API 值只能在建立它的執行緒上用**：推論，未核（4-2 (a)）。
- **cordis-rs 的嚴格 inject 在 v3 的狀態**：未核（`upstream-facts.md` 寫的是 v1）。
- **parity 重跑**：若路 3 進入候選，要在 rc.12 對 `cd540033` 重跑 10-18 的情境才能定案。下載量：10-18 的 `rs-pull.log` 只有 56 B，沒記大小；要重跑時先 `cargo fetch --locked` 乾跑估大小再報。本篇沒有估計數。
- **cordis-rs 已讀的檔**：10 個（`README.md`、`ROADMAP.md`、`docs/v3-upstream-parity-ledger.md`、`docs/upstream-facts.md`、`docs/v3-architecture.md`、`crates/cordis-core/src/{lib,service,context}.rs`、`crates/cordis-loader/src/{lib,plan}.rs`），沒超過 PM 定的 20 個。

## 七、要 demian 決定的事（PM 寫進 #1827）

| 題 | 問 | 推薦 | 理由 |
| --- | --- | --- | --- |
| Y1 | 推翻 Q21：每條對話行程裡的樹也換成 Rust，不再 vendor TS Cordis？ | **否** | 失控與隔離已由形狀 B 解決，換語言不多擋一種失控；效能不是理由（§三-4 只省 9%）；4-2 未解；會重新引入原生模組（#2253）。比不出高下照 dsh |
| Y2 | （只在 Y1=是 時問）先做 4-2 (i) 的探針：同一個 isolate 裡用 N-API 讓 Rust 核心持有 JS 服務值的句柄，量邊界成本？探針要下載 napi-rs 等 crate | **是**（若 Y1=是） | 不量就無法在 (i) 與 (ii) 之間選；(i) 不成立就只剩 Q29 提前 |
| Y3 | （只在 Y1=是 且 Y2 探針不成立時問）推翻 Q29 的時程：agent loop 先脫離 LangChain，讓服務值收斂成資料？ | **否**（現階段） | 牽動整個 agent loop 與 10 個插件套件；跟本卡的目標（語言）不成比例 |
| Y4 | （只在 Y1=是 時問）對話樹用 cordis-rs（路 3）而不是自寫（路 2）？要先在 rc.12 對 `cd540033` 重跑 parity | **否** | 帳本對 rc.8＋2，落後 rc.12 61 個 commit；只有 7／116 列是 parity；沒有 Include 與 nexus 的 11 條修改；`Send + Sync` 可能擋 JS 句柄（未核，見 4-2）。重跑要下載，結論已可預期 |

**Y1=是 時連帶要重核的已拍板題**：C1（PENDING／FAILED 的 fiber 卸載經 UNLOADING，靠修補 0001／0002）與 C2（intercept 照上游 #206）拍的是對話樹 TS fiber 的語意，對話樹換 Rust 要在 Rust 核心重給一次並重新確認。D18 的 #11–#13（嚴格 inject、時限與 AbortSignal、listener 各自 try/catch）目前只登在主機級的樹（#1948），不受 Y1 影響。

## 附錄 A：指令與原始輸出

原始輸出在 `~/.nexus-agent-evidence/2026-11-02/full-rust/counts/`。所有計數在 `origin/develop` `c06ae4c7` 上，判準 `rtk proxy … > $OUT; echo EXIT=$?`（經 rtk 改寫的 `wc -l` 會印錯，計數改用 `grep -c .` 與 python3.12）。

```bash
R="(from|import\(|require\(|resolve\()[[:space:]]*['\"\`]@nexus/cordis"
rtk proxy git grep -lE "$R" origin/develop -- apps packages > all-files.txt          # EXIT=0，84 檔
rtk proxy git grep -nE "(import\(|require\(|resolve\()[[:space:]]*['\"\`]@nexus/cordis" \
  origin/develop -- apps packages > dyn.txt                                          # EXIT=1，0 行
rtk proxy git grep -nE "from[[:space:]]*['\"]@nexus/cordis" origin/develop -- apps packages > static-lines.txt
rtk proxy git grep -l '"@nexus/cordis' origin/develop -- '*package.json' > pkgjson.txt  # 28，非 vendor 24
# 測試切分：路徑符合 \.(test|spec|e2e)\.[a-z]+$ 或 /measure/ 算測試 → 48／36
# 非測試 import 行 49：`import type` 39、帶值 10
rtk proxy git grep -nE "ctx\.(on|once|effect|provide|inject|plugin|emit|parallel|serial|bail|fiber|set|get|intercept|isolate|extend|logger|scope)[^A-Za-z_]" \
  origin/develop -- apps packages ':!*.test.ts' ':!*.spec.ts' ':!*/measure/*' > ctx-calls.txt   # 134 行、54 檔
rtk proxy git grep -nE "(service|optionalService)\(ctx" origin/develop -- apps packages ':!*.test.ts' ':!*/measure/*' > service-reads.txt  # 32
git show origin/develop:apps/harness/cordis.yml | grep -c -- '- id:'                  # 63
git ls-tree -r --name-only origin/develop | grep -Ei '(\.rs$|Cargo\.(toml|lock)$|\.wasm$|\.node$|napi|rust-toolchain)'  # 11 行，全在 native/sandbox-spawner/
git -C references/cordis describe --tags 8cc9e33f                                      # v4.0.0-rc.8-2-g8cc9e33
git -C references/cordis rev-list --count 8cc9e33f..01b39624                           # 61
git -C references/cordis diff --stat 8cc9e33f 01b39624 -- packages/core/src packages/loader/src  # 17 files, +795 −287
# cordis-rs 帳本計數：grep -E '^\| [A-Z]' docs/v3-upstream-parity-ledger.md | grep -oE '\| (parity|representation rework|behavioral divergence|absence) \|' | sort | uniq -c
rtk proxy git -C references/deepseek-harness grep -lE "from ['\"]@deepseek-ai/cordis"  # 1908；排除測試 782
```

一個量具教訓：第一次用 `\s` 寫 union regex 得到 0 檔，是 `git grep -E` 不認 `\s`，不是真的 0；改 `[[:space:]]` 後與靜態計數一致（84）。

## 附錄 B：卡稿（條件卡）

**Y1=否（推薦）就不開新卡**，#1947–#1949 照舊。下面兩張只在 Y1=是 時開，B2 還要 B1 成立。

### 卡 B1：探針——同一個 isolate 裡用 N-API 讓 Rust 核心持有 JS 服務值的句柄

> Part of #1385
>
> 依據：`.docs/nexus-cordis-full-rust-2026-11-02.md` §四-2 (i)；#1827 Y1、Y2（demian 拍板日期待填）。
>
> **現況**：每條對話行程的樹是 vendor 的 TS Cordis（Q21）。服務值裡有 LangChain 的 `StructuredToolInterface` 與 closure（`packages/nexus-tools/src/index.ts:152`）。原型 P1 量過跨 isolate 持有 JS 函式會 V8 FATAL；同一個 isolate 用 `napi_ref` 沒量過。
>
> **做法**：在 `~/.nexus-agent-evidence/<日期>/napi-probe/` 建一支最小 N-API 模組（不進 repo），Rust 側只存句柄與擁有者，值留在 JS；量 `effect`／`emit`／讀服務三種呼叫的每次成本（p50、p99），與 TS Cordis 同一支驅動對照；量 fiber 卸載時句柄釋放有沒有漏。計時經 `with-lock.sh`。
>
> **驗收**：三種呼叫各有 p50／p99 與 TS 對照；卸載後句柄計數歸零；x64、arm64 各建一次。結論寫回研究文件。
>
> **邊界**：下載 napi-rs 等 crate 前先報 PM、經 demian 核可。不改產品碼。

### 卡 B2：對話級的樹換成 Rust 核心（只在 B1 成立時開）

> Part of #1385
>
> 依據：同上 §四、§五；#1827 Y1、Y2。前置：#1949、B1。
>
> **現況**：對話樹由 `vendor/{cordis,loader,include,logger-console}` 給，24 個套件相依、非測試 36 個檔 import、134 行 `ctx.*`。
>
> **做法**：分段，每段單獨量、單獨回退（Q30、Q32）：(1) SDK 改顯式 ctx 與服務句柄，TS Cordis 仍在底下；(2) Rust 核心經 N-API 接上，TS Cordis 與 Rust 並行跑同一套 conformance；(3) Loader、Include 與 `vendor/README.md` 11 條修改的語意在 Rust 重給；(4) 拿掉 `vendor/`。
>
> **驗收**：每段事先宣告要提升的指標與允許的退步；`packages/nexus-sdk` 的 conformance 與 `vendor/*/nexus-tests` 的語意在 Rust 側全綠；離線包、SBOM、x64／arm64 兩架構。沒宣告的退步擋合併。
