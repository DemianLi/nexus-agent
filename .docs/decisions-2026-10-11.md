# 核心底座改為 vendor Cordis、agent loop 成為插件：決議（2026-10-11）

**來源**：2026-10-11 的一場 grilling。起點是「nexus 的核心底座是不是應該重寫，而不是受限於別人做好的底座，導致萬物皆可插件化的迭代靈活度下降」。對照材料是 artifact「Cordis 與 nexus 元件對照」，以及同日兩份子代理盤點（偏離帳本、Cordis 缺點清單；原始報告在 session 暫存區，不進 repo，結論收在本篇 §二、§四）。

**拍板**：demian 2026-10-11 逐題回答 Q1–Q30，最後明確回覆「確認」。

**這份決議取代**：[#356](https://github.com/DemianLi/nexus-agent/pull/356)「迴圈固定，不 fork」、[#358](https://github.com/DemianLi/nexus-agent/issues/358)「`@nexus/core` 維持三合一，不拆」（[`kernel-split-tradeoff.md`](kernel-split-tradeoff.md)），以及 [`development-plan.md`](development-plan.md) §0 決策 1、2 與 §7 決策 1。[`decisions-2026-10-08.md`](decisions-2026-10-08.md)「不以 Rust 重寫容器」不受影響：容器仍是 TypeScript。

## 一、「底座」指什麼

demian 的定義：**像 Cordis 那樣管理生命週期、插件、執行序的那一層**。執行序同時指兩件事：執行單位（thread、輪、子代理）的生命週期，以及插件與 middleware 的執行順序。

## 二、問題出在哪（事實）

**今天這一層是 nexus 自寫的，而且只管到「組裝」為止。** `packages/nexus-core` 的 `plugin.ts`／`load.ts`／`fold.ts` 跑一趟 `loadPlugins`、折成 middleware 疊，交給 `langchain` 的 `createAgent` 編成一張不可變的圖（`packages/nexus-core/src/agent-assembly.ts`，#1126 之後產品路徑已不走 `createDeepAgent`）。之後一輪怎麼跑、interrupt、中止、並行、子代理續行，全由 LangGraph 擁有。dsh 正好相反：Cordis 在最上層，agent loop 是它底下的一顆插件。

偏離帳本把 nexus 程式碼與文件裡所有「表達不出來／偏離／繞道」逐條歸類（約數，誤差 ±10%，子代理逐區塊讀過、主代理抽查 4 處）：

| 類別 | 約幾條 | 說明 |
| --- | --- | --- |
| 第三方，要重寫 loop／圖才根治 | 12–15 | 全落在 LangGraph／LangChain 的 hook 與狀態模型：只有一顆 `interrupt()`、superstep 與中止語意、`beforeModel` 是圖節點、hook 沒有優先序與 step 邊界、拿不到 agent 身分、`task` 閉包、graph state 是會話日誌之外的第二份真相 |
| 第三方，patch 或換單顆 middleware 可修 | 約 55 | 摘要器、backend 與檔案工具、`@langchain/openai` 細節 |
| nexus 自寫的容器 | 約 63 | 沒有逐 agent 的 middleware 工廠、沒有段落註冊、缺件就失敗不能等、沒有 context 樹、熱換做不到 |
| nexus 自己的設計取捨 | 約 115 | 程式碼自己表態「範圍，不是表達不出來」的 |

**一句話**：「插件怎麼載入、怎麼換、怎麼設定」卡在 nexus 自己的容器；「插件在一輪裡能做什麼」卡在 LangGraph 的執行期。兩者都要靠「容器擁有執行」才解得開。

熱換那一格的主詞要更正：不可變的圖只擋「正在跑的 thread 換插件」。「新 thread 用新版插件」今天做不到，原因在 nexus——`apps/harness/src/serve.ts` 的 `startServer` 只在啟動時呼叫一次 `loadDefaultPlugins`，另有 4 顆插件被宿主直接耦合（[`plugin-reload-classification-2026-10-08.md`](plugin-reload-classification-2026-10-08.md)）。

## 三、決議

### 3-1 底座

1. **vendor 上游 `cordiverse/cordis` 的 main**（不是 dsh 的 `@deepseek-ai/cordis` 快照，也不是直接相依 npm 的 RC 版），只補我們需要的 dsh 本地修改（主要是 `vendor/README.md` 第 6 條 fiber 重入卸載三處，以及 #127 的 PENDING 卸載）。照 dsh `vendor/README.md` 的格式維護一份分歧登記表。**不 vendor HMR。**
2. **改進的位置**：能疊在 Cordis core 上面的（框架層插件、lint、gate）一律疊在上面；必須動 core 的先提上游（卸載順序 cordiverse/cordis#26、取消 #43、`emit` 錯誤隔離），上游不收才進本地修改清單。
3. **容器擁有執行**：thread、輪、子代理都是容器底下的 fiber；插件與 middleware 的順序用顯式的 before／after 約束，不靠載入順序。
4. **agent loop 是容器底下的一顆插件，分兩段**：
   - 第一段：`createAgent` 原樣包成一顆 loop 插件，LangGraph 仍在裡面。
   - 第二段：併進 S2（[#1339](https://github.com/DemianLi/nexus-agent/issues/1339)）。狀態職責搬到會話日誌之後，照 dsh `packages/core/agent-loop` 自寫 loop，取代那顆插件。
5. **遷移採絞殺式**：Cordis 當根，現有 `PluginRegistry` 加上組裝流程包成一顆相容層插件，舊插件原樣跑在裡面，再逐顆遷出，最後拆掉相容層。每一步都過 gate、可發版。

### 3-2 更新

6. **插件更新只給新對話**（沿用 2026-10-07 拍板）。做法：每一版開新的 entry id 加一個 isolate realm；一顆**版本路由插件**持有版本表，把新對話導到最新版；用引用計數排水，舊版的最後一段對話結束才撤。舊模組不會被回收，排定期滾動重啟。
7. **核心更新**（Cordis、loop 插件、wire 協定）採排程重啟、事先公告維護窗口。行程級藍綠切換留作重開條件，前提是會話日誌成為唯一真相（S2）。

### 3-3 組織與信任

8. **核心在 monorepo，業務插件在外部**，各自發版。開發期走內網私有 npm registry；部署期沿用 2026-10-07 已同意的簽章包，由後台裝進版本目錄。
9. **開發者是內部團隊加協作企業團隊，一律算可信、同行程**。可信不等於不設規範：核心要定一套通用的插件規範（§3-4），讓插拔時好排錯、也規範插件開發者。協作方插件的子行程隔離留作重開條件。

### 3-4 插件規範

10. **manifest 必填**，缺一個就不載入：`id`、`version`、`owner`（負責團隊）、`provides`（服務 token 與契約版本）、`consumes`（依賴的 token、semver 範圍、必要或選配）、`config`（zod strictObject）、`reload`（拆兩軸：`code` 為 `coexist`／`restart`，`config` 為 `next-thread`／`restart`；插件只宣告自己知道的那一半，宿主那一半由宿主算出，取較嚴者；`coexist` 在兩版並存的案例落地之前拒收。#1136、#1416）、`capabilities`（子行程、網路、檔案系統等特權，不宣告就不給）。
11. **生命週期硬規則**：所有副作用走 `ctx.effect`／`ctx.on`，不用 `process.on`、`setInterval`、模組層級的可變狀態；`apply` 與 dispose 收 AbortSignal 與時限，逾時判 FAILED 並脫離；錯誤以結構化事件丟出（插件 id、階段、原因、相關服務）；選配服務用 `ctx.get(token)`，沒宣告就讀一律拋錯。
12. **強制分四層**：SDK 型別、lint（禁用 API、`internal/*`、`ctx.root`、`ctx.registry`）、載入期驗證（manifest、契約版本、capabilities）、**一致性測試套件**（每顆插件的 CI 都跑：載入→卸載後活資源歸零、兩版並存、逾時、缺件指名；改自 `apps/harness/src/measure/plugin-coexist-real.ts`）。
13. **插拔出錯的呈現**：fiber 狀態與結構化錯誤同時進後台插件頁（狀態、卡在哪個階段、缺什麼、找哪個團隊）、稽核紀錄、啟動結算（PENDING 一律列出，gate 上非零退出）。
14. **服務型別用帶型別的 token**：定義套件匯出 token 與介面，消費方 `inject: [Token]` 後經 `ctx.get(token)` 取得。字串鍵只留給框架內部。
15. **服務契約走 semver**：定義套件以 semver 管契約，載入時用 `provide` 的 `check` 參數做範圍檢查，major 不相容就拒絕並指名哪顆插件、哪個服務。這同時回答 [#1137](https://github.com/DemianLi/nexus-agent/issues/1137)。
16. **採用 dsh 的三角色紀律**：一個能力接縫由定義、提供者、消費者三個角色組成；消費者只依賴定義套件，永不 import 提供者。
17. **交付形式**：`docs/plugin-contract.md` 加一個 `@nexus/sdk` 套件（manifest 型別、token 輔助函式、lint 設定、一致性測試套件；套件名不落在 `@nexus/plugin-*`，R2 的 grep 與 `plugin-coexist-real.ts` 把那個前綴當插件看，#1416 PM 決定）。外部插件只相依 SDK 與服務定義套件，不相依整個 `@nexus/core`。

### 3-5 後台插拔

18. **真相來源是 append-only 的稽核變更紀錄**。後台每一次插拔與改設定先寫進這份紀錄，Loader 的樹由它導出；插件與 Loader 都不寫回 YAML。

### 3-6 規則

19. **[`AGENTS.md`](../AGENTS.md)「技術實現標準」增加第二種合法偏離理由**：產品需求超出 dsh 的射程。原本唯一的理由是「現有基礎建設表達不出來」；loop 第二段完成後點名的基建會全部退場，這條規則就沒有出口了。

## 四、Cordis 的缺點與處置

子代理逐條讀 dsh `vendor/cordis`、`vendor/loader` 原始碼、dsh 的本地修改登記與上游 issue，盤出 23 條，按目標分組。完整的檔案行號在原始報告，本篇只收處置。

| 目標 | 缺點（編號為盤點清單） | 處置 |
| --- | --- | --- |
| 無感更新 | 提供者一換消費者整顆重啟、沒有「舊對話留在舊版」（#1）；apply／disposer 沒有逾時與取消（#2）；Loader 變更不是交易（#6）；改活著的 entry 的 `name`／`inject` 不生效（#7）；ESM 卸不掉、HMR 要動 Node 內部（#18–20） | §3-2 的版本路由與排水；時限與 AbortSignal（§3-4 第 11 條，core 部分提上游）；不 vendor HMR |
| 幾百人並行 | 服務是全域字串命名空間、重名到執行期才拋（#12）；`ctx.<key>` 型別靠 declaration merging，型別說有、執行期不一定有；dsh 的型錄生成器嵌 `file:line`，是合併衝突熱點；缺件時安靜 PENDING（#5）；錯誤只寫 log、啟動失敗仍以 0 退出（#8）；服務與插件沒有版本欄位（#14） | 帶型別的 token；啟動結算當 gate；semver 契約檢查 |
| 解耦 | 沒宣告 inject 也讀得到祖先的服務（#13）；`emit` 一個監聽者拋錯後面的不跑（#15）；任何插件都能註冊 `internal/*`（#16）；disposer 並行、不按依賴順序、錯誤被吞（#3）；waterfall 順序藏在載入順序裡（#17） | 嚴格 inject；監聽者錯誤隔離；`internal/*` lint；依依賴拓撲卸載（提上游）；顯式 before／after |
| 信任邊界 | 所有插件同一個行程、沒有能力邊界（#22）；`!!js` 設定值會被 eval（#9） | capabilities 宣告加 lint；生產環境關 `!!js`；隔離留作重開條件 |
| 維護 | 上游仍是 RC、幾乎只靠一位作者；dsh 快照落後上游且另有五包來源 repo 外人拿不到（#23） | 以上游 main 為底、能提上游的先提 |

## 五、偏離登記

依修改後的 `AGENTS.md`「技術實現標準」逐條登記。

| 決議 | 偏離 dsh 的什麼 | 理由類別 | 理由 |
| --- | --- | --- | --- |
| §3-1 第 1 條 | 不用 dsh 的 `@deepseek-ai/cordis` 快照，改以上游 main 為底 | 產品需求超出 dsh | dsh 的快照少了上游已修的三個 fiber 競態（cordiverse/cordis#34 epoch ABA、#95 FAILED 重入、#56 監聽疊加），同一問題又與上游各修各的；我們的維護成本以「跟上游同步」最低 |
| §3-2 第 6 條 | dsh 出貨不做模組熱換，換已有的包要重啟（`packages/boot/plugin-manager/README.zh.md` 已知限制） | 產品需求超出 dsh | 企業客戶要求插件更新不停機；dsh 沒有這個需求 |
| §3-4 第 14 條 | dsh 用 declaration merging 加型錄生成器 | 產品需求超出 dsh | 幾百人並行開發下，全域命名空間只能靠人工登記表守、生成器每個 PR 都要重跑而衝突、型別保證在執行期不成立 |
| §3-5 第 18 條 | dsh 的後台改 `cordis.patch.yml`，由 HMR 監看重載 | 產品需求超出 dsh | 買方管理員要看得到誰、何時、改了什麼；dsh 沒有稽核需求。以稽核紀錄為真相來源，就不必維護兩份可能不一致的東西 |
| §3-4 第 10 條 | dsh 的身分只有 `package.json` 的 name／version 加 Loader 列 id，`dsh` 欄位沒有 id、owner、provides、consumes、capabilities、reload（`packages/util/package-manifest/src/types.ts:8-39`） | 產品需求超出 dsh | 後台插件頁、稽核與啟動結算要指得出找誰、缺什麼、什麼時候生效；dsh 沒有這些需求。#1416 |
| §3-4 第 12 條 | dsh 的卸載測試是每個套件各寫一份，插件層級沒有共用套件，只有後端層級的 contract suite（`packages/storage/storage/tests/contract.ts`） | 產品需求超出 dsh | 幾百人並行開發下，每顆插件各寫一份卸載測試等於沒有保證。#1416 |
| §3-4 第 15 條 | dsh 一處都沒用 `provide` 的 `check`；它的版本相容檢查在套件層，比整個 runtime 的版本（`packages/boot/app-boot/src/plugin-compatibility.ts:61-88`） | 產品需求超出 dsh | 服務層級的契約要能擋下 major 不相容的提供者並指名消費者與服務。探針 #1386 ⑤ 量過。#1416 |
| §3-1 第 4 條第一段 | dsh 的 loop 是自寫的，第一段仍是 `createAgent` | 基座表達不出來（暫時） | 自寫 loop 的前提是 interrupt、resume、背景子代理續行不再依賴 LangGraph 狀態，那是 S2 的內容；第二段完成後這條偏離消失 |

## 六、排程

| 順序 | 內容 |
| --- | --- |
| 1 | **探針卡** [#1386](https://github.com/DemianLi/nexus-agent/issues/1386)，只產出量測報告，驗收條件見 §七。整條遷移掛在地圖 [#1385](https://github.com/DemianLi/nexus-agent/issues/1385) |
| 2 | 探針通過後開遷移地圖：容器第一段（Cordis 根、相容層、每個 thread 重讀清單）→ 後台插拔建在 Cordis 的 Loader 上。管理員身分與稽核不依賴容器，10/12 之後照常並行 |
| 3 | 企業功能交付 → S2（2026-10-09 已排在企業功能之後）→ loop 第二段 |

## 七、探針的驗收條件

| # | 要證明的 | 不成立時 |
| --- | --- | --- |
| ① | 上游 main vendor 進本 monorepo 後，NodeNext 下型別可用（上游 cordiverse/cordis#124 還開著；dsh 靠本地修改加 gate 補） | 重開 §3-1 第 1 條 |
| ② | 相容層能讓現有 20 顆 `nexus-plugin-*` 原樣跑，工具、命令、middleware 名稱與順序與今天逐位元組相同 | 重開 §3-1 第 5 條 |
| ③ | 同一顆插件的兩個版本各在一個 isolate realm，各被不同 thread 使用；舊版的最後一個 thread 結束後撤得掉，活資源歸零 | 重開 §3-2 第 6 條 |
| ④ | Loader 的樹能由一份變更紀錄導出，不必 fork Include | 重開 §3-5 |
| ⑤ | `provide` 的 `check` 參數能做 semver 範圍檢查並指名違規者 | 重開 §3-4 第 15 條 |

①～③任一不成立，§3-1 第 1 條與 §3-2 第 6 條要重開。

## 八、這份決議沒有回答的

- 版本路由的細節：版本表放哪、引用計數怎麼跨重啟、「舊 thread 用到有洞的舊版」怎麼處置（[#1138](https://github.com/DemianLi/nexus-agent/issues/1138) 的殘留風險）。
- `@nexus/sdk` 的 API 形狀（最小切片已在 #1416 落地，見 [`docs/plugin-contract.md`](../docs/plugin-contract.md)）、lint 規則清單、一致性測試套件的完整案例。
- 遷移的逐顆順序與相容層的拆除條件。
- 私有 registry 的選型與部署位置。
- Cordis 執行期的效能代價（Proxy 加 `internal/get` waterfall、`notify` 走遍所有 fiber）：盤點沒量。

## 九、重開條件

- 探針 ①～⑤ 任一不成立（見 §七）。
- 上游 cordiverse/cordis 停止維護，或 4.x 正式版與我們的分歧登記表衝突到無法同步。
- 出現第一個由協作方獨立維護、不經我方審查合併的插件：協作方插件改走子行程隔離（§3-3 第 9 條）。
- 核心更新也要求無感：改做行程級藍綠，前提是 S2 完成（§3-2 第 7 條）。

## 十、驗證方式

承重事實由主代理在 2026-10-11 親自重跑，對讀版本：nexus `origin/develop` `4fe5f27f`；dsh `references/deepseek-harness` `d7432673886`（`git ls-remote origin master` 與 `rev-parse HEAD` 相同）。

```sh
# 清單只在 server 啟動時解一次：唯一呼叫點在 startServer 內
git show origin/develop:apps/harness/src/serve.ts | grep -n "loadDefaultPlugins"
# → 85（import）、449（startServer 內唯一呼叫）、613（註解）

# 產品路徑的圖由 langchain 的 createAgent 編出
git show origin/develop:packages/nexus-core/src/agent-assembly.ts | grep -n "createAgent"
# → 52 import { createAgent } from 'langchain'；249 return createAgent({

# 上游領先 dsh 釘的 commit 多少
gh api repos/cordiverse/cordis/compare/56b3d4f725681cf4556c1a8695a709cc3b6eed74...main \
  --jq '{ahead: .ahead_by, behind: .behind_by, last: .commits[-1].commit.committer.date}'
# → {"ahead":42,"behind":0,"last":"2026-10-10T07:43:31Z"}

# 三個 fiber 競態上游已關，dsh 快照沒有上游的 reload revision
for i in 34 95 56; do gh api repos/cordiverse/cordis/issues/$i --jq '"\(.number) \(.state)"'; done
# → 34 closed／95 closed／56 closed
grep -c "_revision" references/deepseek-harness/vendor/cordis/src/fiber.ts   # → 0

# 授權
gh api repos/cordiverse/cordis/license --jq .license.spdx_id   # → MIT

# dsh 出貨的 HMR 只監看設定、換包要重啟
sed -n 27p references/deepseek-harness/docs/architecture.zh.md
grep -n "重启" references/deepseek-harness/packages/boot/plugin-manager/README.zh.md
```

**沒有親自重核的**：偏離帳本的逐條歸類（只抽查 4 處）、Cordis 缺點清單除上列之外的行號、§七 全部（那正是探針要做的）。
