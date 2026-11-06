# 對話行程的終點：要不要縮成只裝工具的葉子行程（2026-11-06）

依據：
- demian 2026-11-06 交辦：拿 ADR-001（「Rust 底座加 TS plugin 的 harness 架構」，demian 帳號下的 claude.ai artifact，2026-11-06 提議中）與 arcships/rutis 的做法，重新評估「每條對話行程裡那棵 TS Cordis 樹」。
- #1827 的 D149、D166、D168、D169。
- `.docs/nexus-cordis-full-rust-2026-11-02.md`（以下稱「全 Rust 研究」）。
- `.docs/supervisor-1947-design-2026-11-03.md`（形狀 B）。
- `.docs/agent-loop-off-langchain-design-2026-11-03.md` §八（以下稱「#2336 設計」）。

讀的版本：
- nexus：`origin/develop` `06db7738`。
- rutis：`3f87e6b1`。用 `gh api` 從上游讀了 repo 的描述與檔案清單，以及 `docs/` 下 6 份文件：`decision-multilang-2026-10-03.md`、`design-dual-core-2026-08-20.md`、`design-cordis-runtime-plugin-2026-10-03.md`、`design-function-refs-2026-11-03.md`、`design-dsh-bridge-2026-08-21.md`、`cordis-spec-parity-2026-08-18.md`。最後一份讀下來了，但沒有讀內容。沒有 clone，沒有編譯或執行。
- dsh：本機 clone `05b1cae8`。遠端 HEAD 是 `fcc0ad46`，本篇沒有對新版重核。

除了上面用 `gh api` 讀的 rutis 文件，本篇只讀本機的碼與文件，沒有量測。

## 結論

| 問題 | 答案 |
| --- | --- |
| dsh 有沒有「每條對話一棵插件樹」 | **沒有**。整個行程是一棵插件樹，一條對話是 agent-loop 底下的一個作用域 fiber（§二） |
| ADR-001 有沒有 | **也沒有**，而且連「每條對話一個行程」都沒有：TS 行程按信任等級分（ADR D5）。整包採用，推翻的是形狀 B（D166），不只是 Q21 |
| rutis 支不支持 ADR 的切法 | **在 agent loop 放哪裡這件事上，不支持**。rutis 自己定 agent loop 留在 TS，Rust 只做底座（§三）；ADR 把 loop 放進 Rust |
| 有沒有值得評的縮小版 | **有**：保留形狀 B 的行程邊界，對話行程只裝工具與第三方整合，組合層（loop、日誌、政策）在主機。下面稱為「葉子行程」 |
| 葉子行程現在能做嗎 | **不能**。前提是 #2336 做完；做完後服務值裡仍有六類 JS 函式（#2336 設計 §八），另有至少 8 個插件套件掛在攔截鏈上（§四） |
| 建議 | R1 是（當終點方向）、R2 是（排在 #2336 之後）、R3 否（rutis 不當依賴）。見 §六 |

## 一、三種形狀，一條對話各是什麼

| | dsh | nexus 現況（形狀 B） | ADR-001 | 葉子行程（候選） |
| --- | --- | --- | --- | --- |
| 行程 | 一個 | Rust 監督行程＋Node 前台＋每條對話一個 Node 行程 | 一個 Rust 宿主＋按信任等級分的 TS 行程 | 同形狀 B |
| 插件樹 | 一棵 TS 樹 | 主機一棵（Rust 自寫，#1948）＋每條對話一棵 TS Cordis（Q21） | 一棵，在 Rust 內核 | 一棵，在主機 |
| agent loop | TS 插件 | TS，在對話行程 | Rust | 主機 |
| 一條對話 | 共用樹上的一個作用域 | 一整棵獨立的樹 | ADR 沒有定義 | 主機樹上的一個作用域＋一個只裝工具的行程 |
| 一個行程崩潰，影響幾條對話 | 全部 | 一條 | 同一 runtime 裡的全部 | 一條 |

nexus 是多人共用主機（產品需求），形狀 B 用行程邊界做到「一條對話出事只影響它自己」，這是 D166 拍板的理由之一。ADR-001 的使用情境是單人的 coding agent，按信任等級分行程就夠；搬到 nexus 會把影響範圍從一條對話放大到同一 runtime 裡的所有對話。所以本篇不評「整包採用 ADR」，只評保留形狀 B 的縮小版。

## 二、dsh 怎麼做

- 產品每一部分都是插件，包括 agent loop（`docs/architecture.zh.md:9@05b1cae8`）。
- 執行中的 `dsh` 是一棵插件樹，啟動時由 profile 與組合包疊出來（`docs/architecture.zh.md:15`）。
- 每個 Agent 建立時呼叫 `createScope(loopCtx, this)`（`packages/core/agent-loop/src/agent.ts:147`）。`createScope` 做兩件事：`ctx.plugin(scope)` 開一個匿名子 fiber，再 `fiber.ctx.extend({ [kScope]: key })` 打上這個 agent 的標記（`packages/core/scope/src/index.ts:137-147`）。
- 插件在 `setup(agentCtx, agent)` 裡經 `agentCtx` 登記只屬於這個 agent 的東西；agent 卸載時 fiber dispose，登記全部撤回（`docs/subsystems/core.zh.md:51`）。
- scope 是函式庫原語，不是 Cordis 服務（`docs/subsystems/scope.zh.md` 開頭）。

dsh 解決的問題：同一棵樹上隔開多條對話的登記與生命週期。代價：所有對話共用一個行程，一個插件把行程弄掛，所有對話一起停；dsh 沒有整體的資源保險絲。

## 三、rutis 怎麼做（`3f87e6b1`）

- **雙核與「鏽化判據」**（`docs/design-dual-core-2026-08-20.md`）：Rust 做底座（內核、模型接入、單一執行檔），TS 跑完整的 dsh（agent loop、服務、插件、提示詞內容）。一段經驗只有在「語義已收斂、是機制而非措辭、對效能或分發敏感、不綁 npm、或在信任邊界上」時才搬進 Rust。2026-08-21 的修訂把 agent loop 從「已鏽化」移出：loop 尚未收斂，留 TS；第一塊真正鏽化的服務是 sandbox／fs。
- **Cordis 運行時本身是插件**（`docs/design-cordis-runtime-plugin-2026-10-03.md` §2）：
  - `CordisRuntime` 插件 apply 時啟動 Node 行程，effect 裡關閉；
  - 每個 JS 插件是 loader 的一行，`injects` 這個運行時；
  - Node 行程崩潰時，運行時撤銷服務，各行回到 Pending，診斷能指出缺的是運行時；要不要重啟由應用決定。
- **多語言只做葉子**（`docs/decision-multilang-2026-10-03.md` §四、§七）：Cordis 範式只在 rutis 裡實作一份，一種語言一個運行時插件，插件只做葉子。
- **函式可以跨行程**（`docs/design-function-refs-2026-11-03.md`）：交過邊界的函式變成代理，預設非同步，只在同步呼叫鏈裡同步；同步等待成環時以 `SyncWaitCycle` 失敗。2026-10-31 在 #1948（issuecomment-6533525395）已經比過「只傳資料」與「傳引用」兩條路，#1948 拍板的是只傳資料。

rutis 和 nexus 形狀 B 的主機層同形（Rust 主機＋Node 子行程裡跑 Cordis）。差別在 rutis 沒有「每條對話一個行程」：多個 JS 插件共用一個運行時行程，要隔離就用不同的服務鍵掛多個運行時（`design-cordis-runtime-plugin` §3）。

## 四、nexus 現況：葉子行程要先拿掉什麼

**服務值裡仍是 JS 的東西。** #2336 設計 §八 已經逐項列過：LangChain 物件在 #2336 做完後會全部消失，但仍有六類 JS 函式（工具 `execute`、四種事件監聽者 pre-execute／result／pre-step／projection、命令 handler、`join`／`onActivationChanged` 這類安裝者），另有 `SessionLog`、`FsService`、`AbortSignal`、`GoalService` 這些不可序列化的物件。dsh 也是這樣（`ToolDefinition.execute` 與所有監聽者都是函式），所以「照 dsh 走到底」只走到一半。

**掛在攔截鏈上的插件套件。** ADR 規定 waterfall 只在 Rust 裡跑，跨邊界只用 emit 與 parallel。nexus 至少有 8 個插件套件不是單純提供工具：

| 用法 | 插件套件與位置（`06db7738`） |
| --- | --- |
| `agentLoop.preStep`（waterfall，可改寫或拒絕整步） | agent-instructions `src/index.ts:375`、permission-presets `src/index.ts:244`、skills `src/invocation.ts:104`、time-context `src/index.ts:476` |
| `registry.middleware.use`（工具 middleware 鏈，順序有意義） | mcp `src/index.ts:358`、`:500`；plan-mode `src/index.ts:757`；sandbox-policy `src/index.ts:318`；workspace-changes `src/index.ts:347` |

數法：在 `packages/nexus-plugin-*/src` 的非測試檔 grep `preStep|middleware|intercept`，再逐行看過。沒走圖譜，也沒有 `check_index_coverage`，所以是「至少 8 個」，不是全部。K7（#2357，middleware 遷成事件與服務，未合）做完後，第二列會改成事件監聽者，仍是 #2336 設計 §八 的 F 類。

葉子行程要成立，這 8 個不是把攔截邏輯搬進主機，就是改寫成「按名字呼叫的 RPC」。後者就是 D168 Q9 定為不在 #2336 這一串的那件事。

## 五、比較

| 標準 | 現況（每條對話一棵 TS 樹） | 葉子行程 |
| --- | --- | --- |
| 正確性 | 組合語意在每個對話行程各跑一份 vendor Cordis，靠 C1、C2 等修補對齊 | 組合語意只有主機一份；攔截鏈不跨邊界，政策順序在主機可測 |
| 失敗與恢復 | 對話行程掛掉，整棵樹跟著重來，日誌在對話行程寫 | 對話行程掛掉只丟工具；日誌與 loop 在主機，主機可寫「中斷」事件後恢復 |
| 效能 | 工具呼叫在行程內 | 每次工具呼叫多兩次跨行程（ADR 的流程圖步驟 5、6）。C0 量到每跳 p99 1.5 ms 以內；ADR 引的「30µs」是 rutis 在 Node 端的同步呼叫數字，本篇沒核 |
| 維護成本 | 兩套組合實作（主機 Rust、對話 TS） | 一套組合實作；但多一份跨邊界契約，8 個攔截插件要搬或改寫 |
| 產品需求（多人共用、稽核、內網） | 隔離到對話；稽核要從每個對話行程收 | 隔離到對話（同形狀 B）；政策與日誌集中在主機，稽核較直接 |
| 現有基座做不做得到 | 做得到，就是今天 | **今天做不到**：要先完成 #2336，再處理六類 JS 函式與攔截鏈 |

比得出高下的地方：葉子行程在正確性、恢復、稽核三項較好，也正好是 D169「零 Cordis」的方向（對話行程不再需要 Cordis）。比不贏的地方：今天做不到，而且要付一份跨邊界契約與 8 個插件的搬遷。所以它適合當終點方向，不適合現在動工。

## 六、要 demian 決定的三題

| # | 問題 | 推薦 | 理由 |
| --- | --- | --- | --- |
| R1 | 對話行程的終點，改成「只裝工具與第三方整合的葉子行程，組合層（loop、日誌、政策）在主機」？ | **是**（當終點方向，不是現在動工） | 符合 D169；正確性、恢復、稽核較好；避開在 Rust 裡持有 JS 值（全 Rust 研究 §4-2 的 N-API 路） |
| R2 | R1 的設計排在 #2336 整串做完之後才開始？ | **是** | loop 沒脫離 LangChain，就搬不到主機；8 個攔截插件要等 K7 定下事件介面才知道怎麼改。#1827 已有「#2336 做完後 dev-rs 重評」的條件句，R1 就在那次重評裡接著做 |
| R3 | 照 ADR D7，拿 rutis 當 nexus 主機內核的依賴？ | **否**（維持只當參考） | rutis 是 0.x，仍在頻繁提交；公務機關客戶有來源審查；#1948 已定自寫核心 |

R1 答「是」時，D149 的說法改成「過渡做法，終點是葉子行程」，形狀 B 不動，#1947–#1949 不用改。R1 答「否」時，維持 D149 與 D169 現在的寫法，等 #2336 做完再重評。

## 七、沒讀、沒量、沒核的

- ADR-001 的 4 張嵌入圖沒讀（整體架構、9 步流程、6 個狀態、4 個階段）。
- 「Agent Harness 設計選項比較」只讀了與 Cordis、Rust、行程切分有關的段落。
- rutis 的 `design-function-refs` 與 `design-dsh-bridge` 只讀了前段。
- Cordis 論文 §6.1、§6.4 沒讀（ADR 自己也註明沒讀）。
- 本機 rutis clone 停在 `921892d9`，dsh clone 停在 `05b1cae8`，都沒更新。
- 8 個攔截插件是 grep 的結果，沒走圖譜。
- 跨行程的工具呼叫成本只有 C0 的數字，葉子行程的形狀沒有量過。
