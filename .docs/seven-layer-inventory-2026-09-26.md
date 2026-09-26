# E·T·C·L／O·V·G 七層盤點（2026-09-26）

- **dsh 基準**：`477b4f4`（上游 master，2026-09-24；`git ls-remote` 確認沒有更新的 commit）。09-19 那次用的是 `ddefc45`。
- **我們**：develop `70357bb`（#643）。之後合併的 PR #646、#648、#649、#656，以及新開的 #650–#655、#657，都不在判定範圍內（截至 develop `01008a9`）。受影響的列另記在「基準之後」一節。
- **判準沿用 09-19**：dsh **出廠**有這項能力，我們沒有，也沒判過不做，就是缺口。「出廠」指 base、web-app、headless、acp-app、sdk-app、sdk-minimal 任一列，或四個 preset 任一列。
- **每格都要有 `檔:行`，或 issue／決議編號**。證據欄的引文由主線用腳本逐條對回兩邊的 commit，對不上的不收。散文裡的行號是 agent 所寫，只做過範圍檢查，見「方法與限制」。
- **追蹤**：盤點合併後，同一天（2026-09-26）把清單逐條對 develop `ca8cc72` 重核並寫成 issue：沒有卡涵蓋的新開 #707–#726（其中 6 張是「決定…」的決策卡）；已有卡、但卡上沒寫到盤點查出的事實的，在那張卡上留言補充（#431、#432、#435、#436、#437、#440、#507、#520、#654）。清單與各層明細的追蹤欄已補上。判定本身仍以基準 `70357bb` 為準；卡對之後的 develop 重核過，動工時以卡為準。
- 前一版是 [`seven-layer-inventory-2026-09-19.md`](seven-layer-inventory-2026-09-19.md)。層的切法與歸屬規則照舊。開發計劃 §2 那套七層（感知輸入到輸出）另附在文末。

## 完成度怎麼算

| 判定 | 意思 | 計分 |
| --- | --- | --- |
| 完成 | dsh 出廠有，我們也有。選配的會在「我方」欄標明 | 1 |
| 部分 | 只做了一半。缺的那一半寫在逐列依據裡 | 0.5 |
| 缺口 | dsh 出廠有，我們沒有，也沒判過不做 | 0 |
| 已拍板未落地 | 已有決議要做，程式碼還沒動 | 0 |
| 待拍板 | 做不做要人判斷 | 0 |
| 判過不做 | 有決議，或登記過的偏離 | 不計 |
| dsh 也沒有 | 標準本身沒有這項能力。其中有些我們反而有，例如題庫、離線掃描、步數硬上限 | 不計 |
| web UI 只列不判 | 照 AGENTS.md，web 的 UI／UX 不以 dsh 為準 | 不計 |

**完成度 ＝（完成 ＋ 0.5 × 部分）÷（完成 ＋ 部分 ＋ 缺口 ＋ 已拍板未落地 ＋ 待拍板）**

這個數字量的是**對 dsh 出廠能力的覆蓋比例**。它不是品質分數，也不是剩餘工作量。一條「缺口」可能只要一天，一條「部分」可能要一個地圖。

## 結論

| 層 | 列數 | 完成 | 部分 | 缺口 | 已拍板未落地 | 待拍板 | 判過不做 | dsh 也沒有 | web 只列 | 完成度 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| E 執行環境 | 14 | 6 | 1 | 0 | 0 | 0 | 5 | 2 | 0 | 92.9% |
| T 工具介面 | 29 | 13 | 1 | 3 | 2 | 1 | 4 | 5 | 0 | 67.5% |
| C 上下文與記憶 | 16 | 7 | 2 | 1 | 2 | 1 | 1 | 2 | 0 | 61.5% |
| L 生命週期與編排 | 26 | 9 | 4 | 4 | 1 | 0 | 3 | 4 | 1 | 61.1% |
| O 可觀測與維運 | 18 | 4 | 3 | 1 | 0 | 1 | 4 | 4 | 1 | 61.1% |
| V 驗證與評估 | 12 | 5 | 1 | 1 | 0 | 0 | 0 | 4 | 1 | 78.6% |
| G 治理與安全 | 18 | 8 | 2 | 1 | 0 | 2 | 2 | 3 | 0 | 69.2% |
| **合計** | **133** | **52** | **14** | **11** | **5** | **5** | **19** | **24** | **3** | **67.8%** |

※ 標記的兩列（C-16、L-26）來自覆蓋檢查，沒有經過對抗式驗證，見「方法與限制」。

- **整體 67.8%**，以 87 列計分。E 最高，達 92.9%：圍堵那一整組都完成了，其餘各列不是判過不做，就是 dsh 也沒有。C、L、O 三層最低，都在 61% 左右。
- **缺口 11 條，其中 8 條有卡**。它們集中在四塊：
  - 子代理：T-04 逐 agent allow/deny、L-14 逐個選模型，兩條都掛在 #328；L-13 續行與 send_message 沒有卡。
  - MCP 的後半：T-06 resources（#430）、T-07 server instructions（#431）。
  - 觀測與回歸：O-04 失敗分類碼（#434）、V-06 每晚真模型回歸（#436）。
  - 其他四條：C-03 摘要 prompt（#432）、G-05 具名權限預設（#437），以及兩條沒有卡的 L-23 插話、L-25 每步平行工具上限。
- **沒有卡的 3 條缺口**：L-13、L-23、L-25（盤點後已開 #708、#710、#711）。L-23 的前提已經變了。#190 當初不補插話，理由是「沒有消費者」；如今送出佇列（L-22）已經落地，09-25 拍板佇列時也寫了「插話另開」，但一直沒開卡。
- **本次新找到兩條「部分」**，都沒有卡（盤點後已開：C-16 → #720、L-26 → #723）：
  - C-16 系統提示詞寫死在 `apps/harness/src/cli.ts:603`，內容是「你是 nexus-agent 的命令列助手」。serve 共用同一個 `createCliAgent`，所以 **web 會話裡的模型也被告知自己是命令列助手**。部署方沒有地方設 persona。
  - L-26 模型選擇：部署預設模型有（`#settings/live-model`），每會話換模型與推理強度沒有。
- **已拍板未落地 5 條**，決議都在 09-19：T-11 skills 預設（#440）、T-23 工具 schema 目錄（#442）、C-11 跨會話引用、C-12 `@file`（基準之後開了 #651／#653）、L-09 goal 續行在 serve 預設開（#445）。L-09 的現況：`apps/harness/src/serve.ts:135` 與 `cli.ts:277` 都還是 `default: false`；#445 與 #638（讓續行走送出佇列）都還開著。
- **待拍板 5 條**：T-28 plugin 開發者工具、C-07 圖片省略、O-17 `--dump-config` 系列、G-09 憑證儲存、G-17 互動式憑證取得。G-09 與 G-17 同屬 dsh 的 `packages/credentials/` 一族，建議一起判。

## 每層一句話

- **E**：圍堵、三種模式、升級、政策句、先讀後改、子代理繼承都完成。程式碼執行只有選配的 quickjs。shell 與行程隔離、MCP stdio、腳本執行期、逐會話工作區都判過不做。
- **T**：工具註冊、校驗、逾時、MCP 工具（選配）、問使用者、present、HTTP＋SSE、會話續接、斜線命令、檔案工具與 meta 都完成。缺逐 agent 的 allow/deny、MCP resources、server instructions。skills 預設與工具 schema 目錄已拍板未落地。會話標題只做了一半，LLM 生成標題的 #650 在基準之後才開。
- **C**：AGENTS.md、摘要（#446 拆分）、修剪、壓力量表、重複提醒、計劃指引都完成。缺摘要 prompt 的品質要求（#432）。外溢與系統提示詞身分只做了一半。跨會話引用與 `@file` 已拍板未落地，圖片省略待拍板。
- **L**：迴圈、取消與續接、max-tokens（#433）、停損、子代理派生、深度上限、headless、送出佇列、閒置逾時都完成。以下四條只做了一半：
  - 重試：只蓋到第一則事件，#520。
  - 耐久檢查點：對子代理的工具放行，dsh 則會先排空。
  - `interrupted` 補結。
  - 模型選擇。
- **O**：事件日誌、預設落盤（#444）、統計、不變量都完成。缺失敗分類碼（#434）。token 快取分桶、日誌格式版本（#507）、會話查詢只做了一半。`agent-error` 改判為 dsh 也沒有。
- **V**：受控執行、判斷與歸因、腳本回歸、人的評分、workspace-changes 後端都完成。缺每晚真模型回歸（#436）。就緒檢查只做了一半。
- **G**：政策句、核准閘門、rebinding、瀏覽器會話認證（#424）、全量紀錄、沙箱紀錄、脫敏、dev server 不服務網頁都完成。缺具名權限預設（#437）。有兩條只做了一半：
  - 子行程環境清洗：MCP 那半沒有絆索。
  - 人工監督：計劃評審待 #652／#654。

## 跟 09-19 那次的差別

**09-19 的 8 條缺口**：落地 1 條，推翻 1 條，其餘 6 條仍開著。
- 落地：L-05 max-tokens（#433，PR #609）。
- 推翻：O-05 `agent-error`。09-19 只讀了協調器裡的 relay，沒讀生產者。dsh 只在 capture `live` 時掛 relay，出廠後端是 on-demand，所以出廠路徑上一筆都不發。**#435 的前提不成立，triage 時要改判。**（盤點後已在 #435 留言寫明證據。）
- 仍開著：T-06（#430）、T-07（#431）、C-03（#432）、O-04（#434）、V-06（#436）、G-05（#437）。

**09-19 沒判過的 9 題**：09-19 當天全數拍板，落地情況如下。
- 已完成 4 題：
  - T-13 present（#441）
  - V-09 workspace-changes 後端
  - O-02 日誌預設落盤（#444，PR #607）
  - T-10 web_search：拍板判過不做
- 已拍板未落地 4 題：T-11、T-23、C-11、C-12。
- L-08 耐久檢查點改判為「部分」。
  - 拍板時選的是「照 dsh 三個點全做」，實作卻對子代理的工具直接放行。dsh 則會在子代理的工具動手前，先排空子代理那份日誌。
  - dsh 的頂層判準 `exec.parent` 指的是 PTC 的傳輸子分派，不是子代理。我方測試名（`session-checkpoint-policy.test.ts:164`）與 PR #604 的偏離三把兩者讀混了。
  - 我方子代理日誌也落盤，所以這是實質差異。

**小項 5 條**：全部判成「部分」。
- T-20 會話標題（LLM 那半）
- L-07 `interrupted` 補結
- O-06 快取 token 欄位
- O-13 日誌遷移形狀（#507）
- G-10 MCP 環境絆索

**前提待重核的 2 條**：
- G-08 瀏覽器會話認證：已完成（#424，PR #438）。
- L-09 goal driver：前提重核後拍板 serve 預設開，還沒落地（#445）。

**這次改判 09-19 的判定**：
- 從「有」降為「部分」的 3 條：
  - L-03 重試：09-19 沒看到串流中段錯誤那一半。
  - C-05 外溢：09-19 跟自家調研筆記第 39 列互相矛盾。
  - G-15 人工監督：缺計劃評審。
- C-07 從「判過：定位差異」改為待拍板。
  - 「圖片不送模型」那半已由 #642（PR #644）照 dsh 落地。
  - image-offload 本身的去留跟著附件走，而附件還沒拍板：web 元件清單第 20 項標 P1、先 grilling，#642 的「不做的」段也寫「另議」。
  - 09-19 的「定位差異」來自調研筆記把 25 個「沒有」分桶。那是分桶，不是逐項拍板；同一桶裡的 settings 已由 09-19 第 12 題重啟。
- E-11 MCP stdio 從「同形」改為判過不做。dsh 只在 acp-app 經 dsh-acp 掛 stdio，而 ACP 那條路我們判過不做。
- 以下 3 條只是補正事實，判定不變：
  - E-02：dsh 的切換入口是 `/permission`，不是 `/sandbox`。
  - E-06：dsh 的子代理有繼承沙箱，09-19 寫成「—」。
  - O-16：調研筆記第 34 列寫「session-query 需求未出現」，這個前提已被 #610 與 #631 推翻，筆記本身還沒改。

**新列**：E-13、E-14、T-24–T-30、C-14–C-16、L-06、L-18、L-22–L-26、O-16–O-18、V-10、G-17–G-19。
- 多半是 09-19 之後我們新做的，例如送出佇列、閒置逾時、工具 meta。
- 另一部分是 dsh 在 `ddefc45 → 477b4f4` 之間新增的出廠列，例如 authorization、workspace-dependencies、schedule。
- C-16 與 L-26 是覆蓋檢查補上的，見「方法與限制」。

## 基準之後（`70357bb` 到 `01008a9`，不影響上面的判定）

| 變動 | 影響 |
| --- | --- |
| PR #646 對話折疊器認得送出佇列的推送 | 耦合 wire-seam-r2-05 的 INBOX 那半已修 |
| PR #648 輸入框上方畫出送出佇列 | L-22 的 web 半 |
| PR #649 會話標題寫進日誌並推給畫面 | T-20 往前一步。耦合 core-session-F5 的讀方又多一種：session-list 讀 `session/title` |
| #650 模型依第一句話產生標題 | T-20 的 LLM 那半 |
| #651／#653 `@` 引用工作區檔案 | C-12 |
| #652／#654 交出計劃走提問通道，並畫成審核面板 | G-15 的計劃評審 |
| PR #656（關 #655）會話標頭與分頁顯示標題 | web，只列 |
| #657 LLM 標題可以走另一顆模型 | T-20 的 LLM 那半；dsh 的 provider／model 覆寫 |

## 清單

**缺口 — 11**

- T-04　逐 agent 工具 allow/deny（#328；盤點後開 #707，#328 第 3 項是另一件）
- T-06　MCP resources（列出／讀取 server 資源）（#430）
- T-07　MCP server instructions 進系統提示詞（#431；盤點後在 #431 留言補充）
- C-03　摘要 prompt 保留原始意圖與使用者糾正（清單缺口 3）（#432（OPEN，needs-triage）；盤點後在 #432 留言補充）
- L-13　子代理：續行／背景（continuable）、send_message、list_agents（盤點後開 #708）
- L-14　子代理：逐個選模型（#328；盤點後開 #709，#328 第 3 項是另一件）
- L-23　插話（next-step steer）（盤點後開 #710）
- L-25　每步平行工具呼叫上限（盤點後開 #711）
- O-04　模型失敗分類碼進日誌（含清單缺口 5；併入：每次重試與其失敗原因進日誌）（#434；盤點後開 #712 管重試進日誌那一半，帶碼那一半在 #434）
- V-06　持續回歸：真模型、定期（併 09-19 清單缺口 7）（#436；盤點後在 #436 留言補充）
- G-05　具名權限預設（沙箱＋核准捆成一組；合併清單缺口 8）（#437；盤點後在 #437 留言補充）

**已拍板未落地 — 5**

- T-11　skills 進預設清單（#440、決議 09-19 第 2 題；盤點後在 #440 留言補充）
- T-23　模型看得到的工具 schema 目錄＋新鮮度 gate（#442、決議 09-19 第 4 題）
- C-11　跨會話引用（session-reference，清單第 13 項）（decisions-2026-09-19 第 5 題、調研筆記第 9 列；盤點後開 #713）
- C-12　@file 引用補全（file-reference-local，清單第 14 項）（decisions-2026-09-19 第 6 題、調研筆記第 9 列；基準之後開了 #651（harness 那半，已由 PR #676 合進 develop）、#653（web 那半，開著））
- L-09　長期目標＋自動續行（goal-driver）（#180、#445、#638）

**待拍板 — 5**

- T-28　plugin 開發者工具（tool-cordis、cordis-inspect-providers、tool-plugin-manager）（盤點後開 #714）
- C-07　圖片省略（image-offload）與圖片不送模型（#642）（#642；盤點後開 #715）
- O-17　組裝設定可查（--dump-config）（#46、#454；盤點後開 #716）
- G-09　憑證儲存（不寫進行程環境）（盤點後開 #717，與 G-17 同一張）
- G-17　互動式憑證取得（dsh authorization：問人取得憑證的 flow 註冊表）（盤點後開 #717，與 G-09 同一張）

**部分 — 14**

- E-08　程式碼執行（#615、#503；盤點後開 #718）
- T-20　會話標題（含 LLM 生成標題 session-title-llm）（基準之後由 PR #658 做完（#650 已關），走另一顆模型的選配在 #657）
- C-05　大輸出外溢（spill）（#151、#170、#538；盤點後開 #719）
- C-16※　系統提示詞的身分與 persona（部署方可設的前後綴、{{model}}／{{cwd}}）（盤點後開 #720）
- L-03　模型請求重試（含串流內與串流中段錯誤）（#516、#520、#545；盤點後在 #520 留言補充）
- L-07　崩潰孤兒輪補結（`interrupted` closer）（#306；盤點後開 #721）
- L-08　耐久檢查點（session-checkpoint-policy）（#447、#599；盤點後開 #722）
- L-26※　模型選擇：部署預設模型＋每會話換模型與推理強度（盤點後開 #723）
- O-06　token 用量（含小項：快取讀寫欄位）（#574、#517；盤點後開 #724）
- O-13　日誌格式版本與舊格式（含小項：日誌遷移形狀）（#507；盤點後在 #507 留言補充）
- O-16　會話查詢與搜尋（sessionQuery：清單、精確讀、標題、全文搜尋、lineage）（#610、#631、#632；盤點後開 #725 管投影快取，其餘各項已有去處）
- V-02　就緒檢查（模型就緒＋任務就緒 preflight）（#436；盤點後在 #436 留言補充）
- G-10　子行程環境清洗（MCP stdio 與 git 快照；合併小項「MCP 環境絆索」）（#461；盤點後開 #726）
- G-15　人工監督（核准面板、計劃評審、提問）（#408、#409；基準之後 #652 已關（PR #675），#654 開著，盤點後在上面留言補充）

## 各層明細

表格說明：
- 「09-19」欄是上次的判定；「改判」表示這次的驗證者推翻了第一位判定者，理由寫在逐列依據。
- 逐列依據末尾的 `檔:行` 是證據欄：沒有前綴的是我們，`dsh:` 開頭的是 dsh，行號由主線對 `70357bb`／`477b4f4` 解析。散文裡的行號是 agent 所寫，只做過範圍檢查。

### E 執行環境

| ID | 項目 | 判定 | 09-19 | 我方 | 追蹤 |
| --- | --- | --- | --- | --- | --- |
| E-01 | 檔案效果邊界（工作區圍堵） | **完成** | 有（條件式） | 有-預設 | #34、#568 |
| E-02 | 三種沙箱模式＋執行期切換 | **完成** | 有 | 有-預設 | #238、#241、#478、#437 |
| E-03 | 權限升級（被圍堵擋下後請求放寬） | **完成** | 有 | 有-預設 | #249、#254、#289 |
| E-04 | 模型看得到沙箱政策 | **完成** | 有 | 有-預設 | #240、#559 |
| E-05 | 先讀後改（沒讀過的檔不准改） | **完成** | 有 | 有-預設 | #514 |
| E-06 | 子代理繼承沙箱（委派那一刻的模式） | **完成** | 有 | 有-預設 | #326、#327 |
| E-07 | 行程隔離（bwrap／Seatbelt）＋shell／subprocess／terminal | **判過不做** | 判過不做：決策 3 延後到有容器方案 | 沒有 | 決策 3（development-plan.md §7）、#443 |
| E-08 | 程式碼執行 | **部分** | 部分；偏離已登記 | 有-選配 | #615、#503；盤點後開 #718 |
| E-09 | 瀏覽器操作／電腦操作／SSH | **dsh 也沒有** | 框架要、dsh 也沒有（出廠意義上） | 沒有 | — |
| E-10 | microVM／容器隔離 | **dsh 也沒有** | 框架要、dsh 也沒有 | 沒有 | 決策 3（development-plan.md §7） |
| E-11 | MCP stdio 子行程（跑在 fence 外） | **判過不做**（改判） | 同形 | 有-選配（額外能力；acp-app 那條路跟著 ACP 判過不做） | #503、#430、#431 |
| E-13 | 打包的腳本執行期（workspace-dependencies：回報內建 Python／Node／pnpm 的路徑）（新） | **判過不做** | （09-19 時 dsh 還沒有這一列） | 沒有 | 決策 3（development-plan.md §7） |
| E-14 | 每條會話各自選工作區目錄（web-app 的 workspace／workspace-controller／directory-picker）（新） | **判過不做** | （09-19 沒列） | 沒有 | #372 |
| G-06 | danger-full-access 的強度（symlink 逃逸） | **判過不做** | 判過：偏離（contained-backend.ts:119） | 有-選配 | — |

<details><summary>逐列依據</summary>

- **E-01 檔案效果邊界（工作區圍堵）**
  - dsh：出廠預設（base `fs-sandbox`＋`sandbox-policy`，可寫根＝`process.cwd()`，所以每個 CLI 模式一律有圍堵；sdk-minimal 同樣掛 sandbox-policy，但模式是 danger-full-access）　`dsh:packages/bundle/base/cordis.patch.yml:517`、`dsh:packages/bundle/base/cordis.patch.yml:515`、`dsh:packages/bundle/base/cordis.patch.yml:232`
  - 我們：`ContainedFilesystemBackend`（apps/harness/src/contained-backend.ts:239，09-19 引的 :303 已過時）。組裝點只有兩條路：給了 `--workspace` 就一律建圍堵 backend，沒給就退回基座的 `StateBackend`（虛擬 FS，不碰磁碟）。所以沒有任何一條真碟路徑不經過 fence。CLI 與 serve 都是這樣（serve 的 USAGE 寫明「省略即虛擬檔案系統」）。跟 dsh 的差別只有一處：dsh 以 cwd 當可寫根，模型的檔案工具永遠在真碟上；我們的**模型檔案工具**預設不碰磁碟。會話日誌自 #607 起預設落盤到 harness home，那是基礎建設，歸 O 層，不在這一列。　`apps/harness/src/contained-backend.ts:239`、`apps/harness/src/cli.ts:848`、`apps/harness/src/cli.ts:831`
- **E-02 三種沙箱模式＋執行期切換**
  - dsh：出廠預設（base `sandbox-policy` 預設 workspace-write，可用 DSH_PERMISSION_MODE 覆寫；`permission` 條目提供執行期切換，入口是 `/permission`）　`dsh:packages/sandbox/sandbox/src/index.ts:30`、`dsh:packages/bundle/base/cordis.patch.yml:231`、`dsh:packages/bundle/base/cordis.patch.yml:249`
  - 我們：三個模式與 dsh 一字不差（`packages/nexus-core/src/sandbox.ts`）。起始值由 `--sandbox` 決定，預設 workspace-write（cli.ts）。執行期用 `/sandbox` 切換，每次切換都寫進日誌 `sandbox/mode`；控制器已隨 #486 從 apps/harness 搬到 `packages/nexus-plugin-sandbox-policy/src/sandbox-mode.ts`，09-19 引的 apps/harness/src/sandbox-mode.ts:121 已不存在。**更正 09-19**：dsh 的切換入口是 `/permission`（permission-presets），不是 `/sandbox`；　`packages/nexus-core/src/sandbox.ts:31`、`packages/nexus-plugin-sandbox-policy/src/sandbox-mode.ts:81`、`packages/nexus-plugin-sandbox-policy/src/sandbox-mode.ts:122`
- **E-03 權限升級（被圍堵擋下後請求放寬）**
  - dsh：出廠預設（fs 工具與 bash 都收 `sandbox_permissions`＋`justification`，核准後同一次呼叫放寬一格）　`dsh:packages/fs/fs-sandbox/src/index.ts:53`、`dsh:packages/fs/tool-fs/src/sandbox.ts:22`、`dsh:packages/bundle/base/cordis.patch.yml:281`
  - 我們：`request_sandbox_escalation`（packages/nexus-plugin-sandbox-policy/src/sandbox-escalation.ts，#486 從 apps/harness 搬過來）。只蓋檔案工具，因為我們沒有 shell；只在有 `--workspace` 時掛。**登記過的偏離**：dsh 在同一次呼叫上蓋放寬後的模式；我們拆成請求與重試兩次呼叫，中間發一張一次性的 grant，綁住目標檔與剛被擋下的那一次（#254）。　`packages/nexus-plugin-sandbox-policy/src/sandbox-escalation.ts:66`、`packages/nexus-plugin-sandbox-policy/src/sandbox-escalation.ts:37`
- **E-04 模型看得到沙箱政策**
  - dsh：出廠預設（base `sandbox-policy` 每次請求都貢獻 `sandbox:policy` 這段系統提示）　`dsh:packages/sandbox/sandbox-policy/src/index.ts:143`、`dsh:packages/bundle/base/cordis.patch.yml:228`
  - 我們：`sandboxPolicySentence`：每次模型呼叫都接在系統訊息後面，由 plugin 的 `wrapModelCall` 做，子代理也吃得到（#327）。只在有 `--workspace` 時掛，理由寫在組裝點：沒有圍堵卻告訴模型「政策是 workspace-write」等於說謊。dsh 的圍堵永遠在，所以它這一句永遠都有。**#559 改了這一句並登記偏離**：dsh 在句子裡給主機上的絕對路徑；我們的檔案工具走基座的 `virtualMode`，`/` 就是工作區根，所以改用 `/` 指名可寫根，句子裡不再出現主機路徑。　`packages/nexus-plugin-sandbox-policy/src/index.ts:97`、`packages/nexus-plugin-sandbox-policy/src/index.ts:29`、`apps/harness/src/cli.ts:886`
- **E-05 先讀後改（沒讀過的檔不准改）**
  - dsh：出廠預設（base `fs-observation-policy`）　`dsh:packages/bundle/base/cordis.patch.yml:277`
  - 我們：`createObservationPolicy`（packages/nexus-core/src/observation.ts），fold 預設開。#514 之後它是出貨清單 apps/harness/cordis.yml 裡的一個條目：可以用 patch 的 `disabled` 關掉，但沒有設定可調（三態）。CLI 與 serve 共用這份清單。　`packages/nexus-core/src/observation.ts:176`、`apps/harness/cordis.yml:171`、`apps/harness/cordis.yml:170`
- **E-06 子代理繼承沙箱（委派那一刻的模式）**
  - dsh：出廠預設（subagent 的 `captureDelegatedPolicyOverrides` 在委派時拍下父代理的覆寫，寫進子代理日誌 `sandbox/mode { source: 'delegation' }`）；**更正 09-19**：當時 dsh 欄寫「—」，其實 dsh 有　`dsh:packages/bundle/base/cordis.patch.yml:349`、`dsh:packages/subagent/subagent/src/child-agent.ts:249`、`dsh:packages/subagent/subagent/src/child-agent.ts:272`
  - 我們：**衝突 2 的答案**：實作不在 apps/harness/src/subagent.ts（那個檔不存在），而在 `packages/nexus-plugin-sandbox-policy/src/sandbox-mode.ts` 的 `delegate()`。它用 AsyncLocalStorage 包住那一次呼叫；同套件 index.ts 在 `wrapToolCall` 裡用它包住 `task` 工具的 handler，子代理整個跑在裡面，所以 fence、升級閘門、日誌讀到的都是委派那一刻的快照。子代理日誌另外記一筆 `sandbox/mode { source: 'delegation' }`，一次性 grant 不給子代理（#326，PR #332）。　`packages/nexus-plugin-sandbox-policy/src/sandbox-mode.ts:192`、`packages/nexus-plugin-sandbox-policy/src/index.ts:219`、`packages/nexus-plugin-sandbox-policy/src/index.ts:182`
  - 否定搜尋：
    - nexus: git show 70357bb:apps/harness/src/subagent.ts → 檔案不存在（第一輪 E-06 的引文）
- **E-07 行程隔離（bwrap／Seatbelt）＋shell／subprocess／terminal**
  - dsh：出廠預設（base：`subprocess`、`sandbox`（sandbox-local 行程圍堵）、`shell-env`，以及照平台二選一的 `bash-sandbox`＋`tool-bash`／`pwsh-sandbox`＋`tool-pwsh`。dsh-profiles.json 把後兩組標成 disabled，但那是 `!!js process.platform === 'win32'` 這種平台條件，在 posix 上 bash 是開著的）；　`dsh:packages/bundle/base/cordis.patch.yml:219`、`dsh:packages/bundle/base/cordis.patch.yml:226`、`dsh:packages/bundle/base/cordis.patch.yml:234`
  - 我們：模型沒有 shell 或子行程工具：基座只在 backend 會執行指令時才註冊 `execute`，而我們的 backend 不是這種（base-tools.ts 的註解；workspace-changes.test.ts 斷言綁定的工具裡沒有 `execute`）。**要修正「我方沒有子行程」這個說法**：09-19 之後，serve 在有 `--workspace` 時會由 workspace-changes 自己 spawn git 拍快照（#464／#467，`node:child_process`，參數陣列、不經 shell）。環境淨化、逾時、輸出上限都照 dsh 的 `scrubbedParentEnv` 抄，並登記了偏離。那是基礎建設的子行程，不是模型可用的工具。　`.docs/development-plan.md:33`、`apps/harness/src/base-tools.ts:25`、`apps/harness/src/workspace-changes.test.ts:411`
  - 否定搜尋：
    - nexus: git grep -n "child_process\|node:child_process\|spawn(\|execFile(" -- 'apps/harness/src/*.ts' 'packages/*/src/*.ts' ':!**/*.test.ts'  → 只中 packages/nexus-plugin-workspace-changes/src/{git.ts,index.ts}
    - nexus: git grep -n "'execute'" -- apps/harness/src packages/nexus-core/src  → 只中 base-tools.ts 的名字宇宙與測試（conversation-replay 的假資料、workspace-changes 的 not.toContain）
- **E-08 程式碼執行**
  - dsh：出廠預設（base 掛 `ptc-runtime`（dsh-ptc-runtime-node：每次開一個新的 Node 行程，套用與 bash 相同的平台沙箱）；模型直接拿到 `run_code` 只在 web-app 的 ptc preset（`tool-presentation` `mode: ptc`）。base／standard／cordis 的 workflow-ptc 也用它，那部分歸 L 層）　`dsh:packages/bundle/base/cordis.patch.yml:389`、`dsh:packages/ptc-runtime/ptc-runtime-node/README.md:12`、`dsh:packages/bundle/web-app/presets/ptc.patch.yml:144`
  - 我們：`@nexus/plugin-quickjs` 的 `run_javascript`：行程內的 WASM 直譯器，有 timeout、memory、stack 上限。**不在零設定產品路徑上**：出貨清單只有它的 invariant 配套；#503 拿掉 `--plugins` 之後，要在 `cordis.patch.yml` 用 `insert` 插一列才會掛。**偏離已登記**：dsh 沒有「JS 直譯器」這個接縫，我們用 WASM 直譯器換掉跑任意指令。09-19 引的 `development-plan.md:271` 已漂到 :284。#627（09-25）讓失敗回報成工具錯誤（會話日誌裡是 `isError: true`）。　`packages/nexus-plugin-quickjs/src/index.ts:62`、`packages/nexus-plugin-quickjs/src/index.ts:81`、`apps/harness/cordis.yml:400`
  - 否定搜尋：
    - nexus: git grep -n "'@nexus/plugin-quickjs'\|@nexus/plugin-quickjs'" -- apps/harness/cordis.yml apps/harness/src ':!**/*.test.ts'  → 0 筆（出貨清單與組裝點都沒掛功能本身，只有 /invariant 配套）
- **E-09 瀏覽器操作／電腦操作／SSH**
  - dsh：不出廠（packages/browser-use、computer-use、ssh 這些套件在，但任何 bundle、preset 或 apps/*/src 都沒有掛載列）。web-app 的 `ui-sidebar-browser` 是給使用者開 HTTP 分頁的側欄，現在只在 desktop 開，不是 agent 的 browser-use　`dsh:packages/browser-use/browser-use/README.md:2`、`dsh:packages/bundle/web-app/cordis.patch.yml:274`
  - 我們：沒有。出貨清單的功能工具只有 echo；全 repo 找不到 playwright、puppeteer、browser-use、ssh 的實作。　`apps/harness/cordis.yml:25`
  - 否定搜尋：
    - dsh: git grep -n "dsh-browser-use\|dsh-computer-use\|dsh-ssh\|dsh-sandbox-ssh\|dsh-subprocess-ssh\|dsh-fs-ssh" -- packages/bundle 'apps/*/src' 'apps/*/package.json'  → 0 筆（含四個 web-app/presets/*.patch.yml）
    - dsh: git grep -n "dsh-browser-use\|dsh-computer-use\|dsh-ssh\b\|dsh-sandbox-ssh\|dsh-subprocess-ssh\|dsh-e2b\|microvm\|firecracker" -- '*.yml' '*.yaml'  → 只中 packages/browser-use/browser-use/README.i18n.yaml（文件索引，不是掛載列）
    - nexus: git grep -n -i "playwright\|puppeteer\|browser-use\|computer-use\|computer_use" -- apps packages ':!**/*.md'  → 0 筆
    - nexus: git grep -n -i "ssh2\|node-ssh\|StrictHostKeyChecking" -- apps packages  → 0 筆
- **E-10 microVM／容器隔離**
  - dsh：dsh 也沒有（e2b 已從版控移除，沒有任何容器或 microVM 後端）　—
  - 我們：沒有。決策 3 把 shell 延後到「有明確隔離方案（容器）」，也就是說容器是重開 shell 的前提，今天還不存在。　`.docs/development-plan.md:33`
  - 否定搜尋：
    - dsh: git grep -n -w -i "docker\|podman\|firecracker\|microvm\|gvisor\|e2b" -- 'packages/*/*/src/*.ts' ':!packages/client/ui-primitives'  → 0 筆（ui-primitives 只有檔案圖示的 docker 字樣）
    - dsh: git ls-tree 477b4f4 packages/ | grep -i e2b → 0 筆；磁碟上的 packages/e2b/{fs-e2b,subprocess-e2b} 是未進版控的殘留目錄（git ls-files packages/e2b 為空）
    - nexus: git grep -n -w "e2b\|firecracker\|microvm\|dockerode\|gvisor" -- apps packages  → 0 筆
- **E-11 MCP stdio 子行程（跑在 fence 外）**
  - dsh：不出廠（`mcp-client` 不在任何出廠 profile 或 preset；README 說使用者只要設定 mcp-client 條目就好。dsh-profiles.json 裡的 `demo-mcp` 在 packages/preset/agent-preset/skills/.../templates/mcp/，是 skill 的樣板，不是出廠 profile）　`dsh:packages/mcp/README.zh.md:12`、`dsh:packages/preset/agent-preset/skills/cordis-plugin-development/templates/mcp/cordis.patch.yml:2`
  - 我們：`@nexus/plugin-mcp`，同樣跑在 fence 外。零設定產品路徑上沒有：出貨清單只掛了 mcp-invariant；#503 之後要在 patch 裡 `insert` 才有。兩邊的形狀相同：dsh 要使用者設定，我們要 patch。MCP resources 與 server instructions（#430、#431）歸 T 層。　`docs/operations.md:174`、`apps/harness/cordis.yml:392`
  - 驗證改判（dsh 也沒有 → 判過不做）：推翻「dsh 也沒有」。YAML 的否定 grep 漏掉了用程式碼掛載的形狀。dsh acp-app 出廠掛 dsh-acp（acp-app/cordis.patch.yml:17）。ACP 的 session/new 與 resume 把 client 宣告的 mcpServers 交給 AcpSession（acp/src/index.ts:209、:260）；session.ts:135、:159 在建立 agent 時呼叫 mountAcpMcpServers；
  - 否定搜尋：
    - dsh: git grep -n "dsh-mcp-client" -- packages/bundle 'apps/cli/src/*.yml'  → 0 筆
    - dsh: git grep -n "dsh-mcp-client" -- '*.yml'  → 只中 apps/cli/config/examples、tests/fixtures、skill 的 templates、snapshots，沒有出廠 profile
    - nexus: git grep -n "'@nexus/plugin-mcp'" -- apps/harness/cordis.yml apps/harness/src ':!**/*.test.ts'  → 只中 apps/harness/src/cli-mcp.fixture.ts（手動驗證用的 fixture，要 --patch src/cli-mcp.patch.yml 才掛；出貨清單裡只有 /invariant 配套）
- **E-13 打包的腳本執行期（workspace-dependencies：回報內建 Python／Node／pnpm 的路徑）**
  - dsh：只在某 profile（sdk-app；ddefc45 之後新增；要有打包載體或設了 DSH_PRIMARY_RUNTIME 才開，從原始碼啟動時是關的）　`dsh:packages/bundle/sdk-app/cordis.patch.yml:30`、`dsh:packages/bundle/sdk-app/cordis.patch.yml:32`、`dsh:packages/skill/tool-workspace-dependencies/README.md:12`
  - 我們：沒有。這個工具只回報直譯器的絕對路徑，給模型在 shell 裡用，本身不執行任何東西。我們的模型沒有 shell（見 E-07），所以拿到路徑也沒地方用。決策 3 沒有點名它；本列依「它依附 shell」把決策 3 延伸套用，哪天重開 shell 要一起重判。我們也沒有對應 dsh sdk-app 的 JSON-RPC SDK 產品面。　`.docs/development-plan.md:33`、`apps/harness/src/workspace-changes.test.ts:411`
  - 否定搜尋：
    - nexus: git grep -n -i "workspace-dependencies\|load_workspace_dependencies\|primary.runtime" -- apps packages  → 0 筆
- **E-14 每條會話各自選工作區目錄（web-app 的 workspace／workspace-controller／directory-picker）**
  - dsh：出廠預設（web-app 模式 bundle；dsh-workspace 的 README 寫明它對模型不可見，只服務專案分組的畫面）　`dsh:packages/bundle/web-app/cordis.patch.yml:73`、`dsh:packages/bundle/web-app/cordis.patch.yml:141`、`dsh:packages/bundle/web-app/cordis.patch.yml:94`
  - 我們：serve 一台只有一個啟動時給定的 `--workspace`，所有 thread 共用。沒有「每條會話選一個目錄」，也沒有工作區註冊表。web-ui-spec 的「明確不做」把「工作區挑選」列為 nexus 沒有的產品面，那是 #372 UI 範圍下的登記；host 那一半（每條會話各有自己的可寫根）跟著它沒做。日後要做多工作區，host 與 UI 要一起重開。　`.docs/web-ui-spec.md:46`、`apps/harness/src/serve.ts:106`
  - 否定搜尋：
    - nexus: git grep -n "directory-picker\|workspace-controller\|dsh-workspace\b\|workspaceRegistry" -- . ':!references'  → 只中 .docs/agent-ui-element-inventory.md:181（不列入）與 workspace-changes 的出處註解
- **G-06 danger-full-access 的強度（symlink 逃逸）**
  - dsh：出廠預設：base 的 permission 預設含同名 mode（配 approval never）　`dsh:packages/bundle/base/cordis.patch.yml:260`
  - 我們：--sandbox danger-full-access 或 /sandbox 切過去才有；fence 放行 symlink 逃逸但基座的 lexical .. 檢查仍在，所以比 dsh 的同名 mode 弱，已在 contained-backend.ts 登記偏離。歸屬表把三種模式與圍堵歸 E，但 E 的 09-19 表沒有這一列，所以由 G 保留。　`apps/harness/src/contained-backend.ts:149`、`apps/harness/src/contained-backend.ts:514`
  - 由 G 層搬來（歸屬表：沙箱模式與圍堵→E）
- ~~E-12 MCP 子行程環境變數的絆索~~：併入 G-10（歸屬表：MCP 子行程環境清洗與絆索→G）

</details>

### T 工具介面

| ID | 項目 | 判定 | 09-19 | 我方 | 追蹤 |
| --- | --- | --- | --- | --- | --- |
| T-01 | 工具註冊表、撞名檢查、排序 | **完成** | 有 | 有-預設 | #454、#503 |
| T-02 | 參數與輸出校驗、失敗不中止輪次 | **完成** | 有 | 有-預設 | #615 |
| T-03 | 工具逾時 | **完成** | 有（§五第 2 條收完） | 有-預設 | — |
| T-04 | 逐 agent 工具 allow/deny | **缺口**（改判） | 已登記：#328 第 3 項（needs-triage） | 沒有：沒有逐 agent 的允許／拒絕遮罩；rootOnly 是 dsh 逐工具呼叫者拒絕（DELEGATED_CALLER 一類）的宣告化，樁仍可見，不算這一格 | #328；盤點後開 #707，#328 第 3 項是另一件 |
| T-05 | MCP 工具（接外部 MCP server） | **完成** | 有，同形 | 有-選配 | — |
| T-06 | MCP resources（列出／讀取 server 資源） | **缺口** | 缺口（09-19 清單缺口 1） | 沒有 | #430 |
| T-07 | MCP server instructions 進系統提示詞 | **缺口** | 缺口（09-19 清單缺口 2） | 沒有 | #431；盤點後在 #431 留言補充 |
| T-08 | MCP prompts（提示詞模板） | **dsh 也沒有** | 同形 | 沒有 | — |
| T-10 | web_search／web_fetch | **判過不做** | 未判（09-19 清單第 9 題） | 沒有 | 決議 09-19 第 1 題 |
| T-11 | skills 進預設清單 | **已拍板未落地** | 未判（09-19 清單第 10 題） | 有-選配 | #440、決議 09-19 第 2 題；盤點後在 #440 留言補充 |
| T-12 | 問使用者（ask_user_question） | **完成** | 有 | 有-預設 | — |
| T-13 | 交付檔案宣告 present | **完成** | 未判（09-19 清單第 11 題） | 有-預設 | #441、PR #460、決議 09-19 第 3 題 |
| T-14 | 協定：ACP／SDK（程式化客戶端） | **判過不做** | 判過：定位差異（筆記 §三小計） | 沒有 | 調研筆記 §三小計 |
| T-15 | 協定：HTTP＋事件串流（web 的連線） | **完成** | 有 | 有-僅 serve | #439、#538、#617 |
| T-16 | A2A | **dsh 也沒有** | 框架要、dsh 也沒有 | 沒有 | — |
| T-17 | tool search／漸進披露 | **dsh 也沒有** | 框架要、dsh 也沒有 | 沒有 | — |
| T-18 | 把 agent 當 MCP server | **dsh 也沒有** | 框架要、dsh 也沒有 | 沒有 | — |
| T-19 | 會話續接、列表、租約 | **完成** | 有 | 有-預設 | — |
| T-20 | 會話標題（含 LLM 生成標題 session-title-llm） | **部分**（改判） | 部分；LLM 標題未判（小） | 部分：70357bb 只有規則回退 fallbackThreadTitle（列表冷讀時推，同 dsh fallbackSessionTitle）；LLM 首句標題沒有，已由 #650（OPEN、ready-for-agent，2026-09-26 demian 拍板拆卡）追蹤 | 基準之後由 PR #658 做完（#650 已關），走另一顆模型的選配在 #657 |
| T-21 | 斜線命令 | **完成** | 有 | 有-預設 | — |
| T-22 | 產品路徑上的示範工具 echo（判過：刻意多掛） | **dsh 也沒有**（改判） | 判過：刻意 | 有-預設 | #454 |
| T-23 | 模型看得到的工具 schema 目錄＋新鮮度 gate | **已拍板未落地** | 未判（09-19 清單第 12 題） | 沒有 | #442、決議 09-19 第 4 題 |
| T-24 | 檔案讀寫與搜尋工具（read／write／edit／ls／glob／grep）（新） | **完成** | （09-19 未列） | 有-預設 | #568、決議 09-22 §7.4 |
| T-25 | 讀檔續讀提示與一頁上限（#594、#602）（新） | **完成** | （09-19 未列；2026-09-23 量測發現，#594） | 有-預設 | #594、#602、PR #603、PR #628 |
| T-26 | 工具結果結構化 meta（#617）（新） | **完成** | （09-19 未列） | 有-預設 | #617、PR #619、#630 |
| T-27 | 待辦工具 todo_write（新） | **完成** | （09-19 T 表未列；調研筆記第 45 列「有」） | 有-預設 | #132、PR #139 |
| T-28 | plugin 開發者工具（tool-cordis、cordis-inspect-providers、tool-plugin-manager）（新） | **待拍板** | （09-19 只在工作筆記記下 cordis preset 的 tool-cordis，未判） | 沒有 | 盤點後開 #714 |
| T-29 | 每個會話選 agent preset（agent-preset-registry、四個 preset）（新） | **判過不做**（改判） | （09-19 只在工作筆記記下 preset 機制，未判） | 沒有：出貨清單一份套用到每個會話；resume-guards.ts 明寫我們沒有 preset。登記出處：調研筆記 §三第 29 列、§三小計（企業級與分散式 13 個，定位差異）；#46 Out of scope 排除 profile 層與 web UI 改設定 | #46 |
| T-30 | Office 轉 PDF 預覽（office-to-pdf／document）（新） | **判過不做** | （09-19 表未列；決議第 11 題） | 沒有 | 決議 09-19 第 11 題、#640 |

<details><summary>逐列依據</summary>

- **T-01 工具註冊表、撞名檢查、排序**
  - dsh：出廠預設：base `tools`（headless、sdk-minimal、web-app 各有同 id 的覆寫列）　`dsh:packages/bundle/base/cordis.patch.yml:499`、`dsh:packages/core/tools/README.zh.md:12`
  - 我們：`registry.tools` 經 fold 排序（`validateToolOrder`／`orderTools`），基座保留名在 fold 前由 `assertNoBaseToolNameCollision` 擋。09-19 之後組合來源從 `cli.ts` 的 `DEFAULT_PLUGINS` 改成 `apps/harness/cordis.yml`＋使用者 patch（`loadDefaultPlugins`），`--plugins` 已拿掉，改用 `--patch` 與 `--dump-config`　`apps/harness/src/agent-factory.ts:733`、`apps/harness/src/base-tools.ts:87`、`packages/nexus-core/src/fold.ts:371`
- **T-02 參數與輸出校驗、失敗不中止輪次**
  - dsh：出廠預設：base `tools` 流水線（參數執行前校驗、無效輸入變一般錯誤結果）　`dsh:packages/core/tools/README.zh.md:32`
  - 我們：fold 固定掛 `invalid-tool-args`、`output-schema`、`containment` 三顆 middleware；工具拋錯由圍堵轉成錯誤結果，輪次不中止。09-19 之後 #627 讓選配的 `run_javascript`（quickjs）失敗也照 `isError: true` 回報　`packages/nexus-core/src/fold.ts:377`、`packages/nexus-core/src/fold.ts:383`、`packages/nexus-core/src/fold.ts:386`
- **T-03 工具逾時**
  - dsh：出廠預設：base `timeout-policy`，只武裝有宣告 `timeoutMs` 的工具　`dsh:packages/bundle/base/cordis.patch.yml:401`、`dsh:packages/guard/timeout-policy/README.zh.md:123`
  - 我們：`containment.ts` 只對宣告了預算的工具武裝截止時間，逾時發 `TOOL_TIMEOUT`（`ToolTimeoutError`），同 dsh 的「沒有統一預算」　`packages/nexus-core/src/containment.ts:247`、`packages/nexus-core/src/containment.ts:161`
- **T-04 逐 agent 工具 allow/deny**
  - dsh：機制出廠（`ctx.tools.restrict`、`tool-subagent` 的 `toolFilter` 欄位），但出廠 bundle／preset 沒有任何一列設 `toolFilter`　`dsh:packages/core/tools/README.zh.md:81`、`dsh:packages/subagent/tool-subagent/src/index.ts:126`
  - 我們：只有宣告式的 `rootOnly`：標了的工具在子代理那份換成拒絕樁；沒有逐 agent 的允許／拒絕清單　`packages/nexus-core/src/fold.ts:131`
  - 驗證改判（部分 → 缺口）：推翻「部分」，改判「缺口」，理由有三。(1) 我方唯一相關的機制 rootOnly 不是逐 agent 的允許／拒絕遮罩。rootOnly 換上的樁保留同名、同 schema，描述只多一句 ROOT_ONLY_NOTICE，工具仍在子代理的可見集合裡，叫了才被拒。fold.ts:103 自己寫明「dsh 沒有 root-only 這個旗標」：它是把 dsh 逐工具的呼叫者檢查（ask-user 的 DELEGATED_CALLER）宣告化。實際掛 rootOnly 的只有 ask-user 與 goal，那是 T-12／goal 列的能力，不能拿來抵這一格。
  - 否定搜尋：
    - nexus: git grep -n -I -F -- '<p>' -- apps packages ':!**/node_modules/**'，<p> 逐一為 toolFilter、allowTools、denyTools、tools.restrict、restrict(、allowedTools、disallowedTools → 全部 0 筆
    - dsh: git grep -n toolFilter -- packages/bundle → 0 筆（出廠 preset 沒設）
    - dsh: git grep -n 'tools.restrict(' -- packages（排除 test、md）→ 只有 core/tools 本身、subagent/child-agent.ts:218（toolFilter 消費點）、experimental/browser-use-runtime
- **T-05 MCP 工具（接外部 MCP server）**
  - dsh：不出廠：`mcp-client` 只出現在 `apps/cli/config/examples` 與 skill 範本，使用者自己加條目；base／sdk-minimal 只統一掛 `mcp-resources`　`dsh:packages/mcp/mcp-client/README.zh.md:12`、`dsh:packages/preset/agent-preset/skills/cordis-plugin-development/templates/mcp/cordis.patch.yml:3`
  - 我們：`@nexus/plugin-mcp`（`mcpConfigSchema`）要用 patch `insert` 掛進來（`docs/operations.md` 有範例）；出貨清單只有它的 invariant 配套。09-19 時選配靠 `--plugins` 整份換掉，現在改成 patch 疊加　`packages/nexus-plugin-mcp/src/index.ts:82`、`docs/operations.md:174`、`apps/harness/cordis.yml:393`
  - 否定搜尋：
    - dsh: git grep -n "dsh-mcp-client'" -- packages/bundle packages/preset apps/cli/config → 只中 apps/cli/config/examples/mcp-memory 三檔與 preset skill 範本 templates/mcp，packages/bundle 0 筆
- **T-06 MCP resources（列出／讀取 server 資源）**
  - dsh：出廠預設：base 與 sdk-minimal 各掛一列 `mcp-resources`（web-app／headless 繼承 base、沒停用）；沒設 MCP server 時零工具、零提示詞，所以只在「有設 MCP」那條路上生效　`dsh:packages/bundle/base/cordis.patch.yml:492`、`dsh:packages/bundle/sdk-minimal/cordis.patch.yml:95`、`dsh:packages/mcp/mcp-resources/src/tools.ts:34`
  - 我們：`@nexus/plugin-mcp` 只橋接工具，README 寫 Resources 延後；全 repo 零個 resource 列出／讀取的實作。缺口只存在於使用者掛了 MCP 的那條路上（MCP 本身選配）　`packages/nexus-plugin-mcp/README.md:89`
  - 否定搜尋：
    - nexus: git grep -n -I -- '<p>' -- ':!**/node_modules/**'（再濾掉 .docs/），<p> 逐一為 listResources、readResource、resources/list、resources/read、list_mcp_resources、read_mcp_resource、mcp-resources、mcp_resource、ListResourcesResult、resourceTemplates → 全部 0 筆
    - nexus: git grep -n -i resource -- packages/nexus-plugin-mcp → 只有 README:89（延後）與 project-content.ts 把工具結果裡的 resource link 轉成文字，沒有列出／讀取資源的路
- **T-07 MCP server instructions 進系統提示詞**
  - dsh：mcp-client 內建：每個連上的 server 的 instructions 以帶 server 名的段落加進系統提示詞（上限 32,768 bytes）；隨 mcp-client 生效，而 mcp-client 本身要使用者設定　`dsh:packages/mcp/mcp-client/src/connection.ts:318`、`dsh:packages/mcp/mcp-client/README.zh.md:188`、`dsh:packages/mcp/mcp-client/src/index.ts:73`
  - 我們：`@nexus/plugin-mcp` 只把設定轉成 adapter 連線、註冊工具，沒有任何地方讀 server 的 instructions；README 連「延後」都沒寫　`packages/nexus-plugin-mcp/src/index.ts:175`
  - 否定搜尋：
    - nexus: git grep -n -I -- '<p>' -- ':!**/node_modules/**'（再濾掉 .docs/），<p> 逐一為 getInstructions、serverInstructions、server_instructions → 全部 0 筆
    - nexus: git grep -n -I -i instruction -- packages/nexus-plugin-mcp → 0 筆
    - nexus: git grep -n -I instructions（排除 agent-instructions 相關）→ 只中 packages/nexus-plugin-memory/src/index.ts:8 的檔頭，與 MCP 無關
- **T-08 MCP prompts（提示詞模板）**
  - dsh：dsh 也沒有：mcp-client 明寫不支援 MCP 提示詞模板　`dsh:packages/mcp/mcp-client/README.zh.md:12`
  - 我們：README 寫延後　`packages/nexus-plugin-mcp/README.md:89`
- **T-10 web_search／web_fetch**
  - dsh：出廠預設：base 掛 `web`／`web-search-deepseek`／`web-fetch-http`／`tool-web`；web-app 關 host 列、改由 standard／ptc／cordis preset 掛 `tool-web`（web 預設 standard）；base 註解寫明網路政策較嚴的產品覆寫 `tool-web`　`dsh:packages/bundle/base/cordis.patch.yml:486`、`dsh:packages/bundle/base/cordis.patch.yml:462`、`dsh:packages/bundle/web-app/presets/standard.patch.yml:138`
  - 我們：產品路徑零個 web 工具；內網部署連不到外網，照 dsh 自己寫的覆寫路不掛，要內網搜尋就走使用者設定的 MCP。dsh 477b4f4 另加了 `ui-settings-web-search` 設定頁（UI，只列不判）　`.docs/decisions-2026-09-19.md:18`、`.docs/plugin-architecture-gap-survey.md:189`
  - 否定搜尋：
    - nexus: git grep -n -I -- '<p>' -- ':!**/node_modules/**' ':!.docs/**'，<p> 逐一為 web_search、web_fetch、webSearch、webFetch、tool-web、fetch_url → 全部 0 筆
- **T-11 skills 進預設清單**
  - dsh：出廠預設：base 掛 `skill`、`skill-filesystem`、`tool-skill`（`skill-badge` disabled）；web-app 關 host 那兩列、改由 standard／ptc／cordis preset 掛；sdk-app 477b4f4 另加 `skill-office`（打包的 primary runtime 在才開）　`dsh:packages/bundle/base/cordis.patch.yml:294`、`dsh:packages/bundle/base/cordis.patch.yml:304`、`dsh:packages/bundle/web-app/presets/standard.patch.yml:37`
  - 我們：`@nexus/plugin-skills` 在、fold 也會把 `registry.skills.sources()` 交給基座，但 plugin 不在 cordis.yml，只有 invariant 配套；除了測試沒有任何掛載點，要用得自己 patch insert　`.docs/decisions-2026-09-19.md:19`、`apps/harness/cordis.yml:407`、`packages/nexus-plugin-skills/src/index.ts:90`
  - 否定搜尋：
    - nexus: git grep -n -I "plugin-skills'\|plugin-skills\"\|createSkillsPlugin\|skillsPlugin" -- apps packages ':!**/node_modules/**' → 只中 apps/harness/package.json 相依、skills.test.ts 等測試與套件本身
    - nexus: git grep -n "@nexus/plugin-skills" -- apps/harness/cordis.yml docs/operations.md → 只中 cordis.yml 的 invariant 那一列
- **T-12 問使用者（ask_user_question）**
  - dsh：web-app 出廠：standard／ptc／cordis preset 掛 `tool-ask-user`；base 掛 `user-questions` 服務（base 沒有這顆工具）　`dsh:packages/bundle/base/cordis.patch.yml:72`、`dsh:packages/bundle/web-app/presets/standard.patch.yml:132`
  - 我們：組裝點固定加 `createAskUserPlugin()`，CLI 與 serve 都有；沒有人可答時 fail-closed，子代理一律拒（#324，載體是 rootOnly）。09-19 之後的 PR #473（答完的提問卡從線上讀回逐題答案）屬提問卡的呈現，UI 只列不判　`apps/harness/src/cli.ts:881`、`packages/nexus-plugin-ask-user/src/index.ts:2`、`packages/nexus-plugin-ask-user/src/index.ts:40`
- **T-13 交付檔案宣告 present**
  - dsh：web-app 出廠：standard／ptc／cordis preset 掛 `present`（dsh-tool-present，web 預設 standard）；base／headless 沒有；交付檔讀取走 web-app 的 `workspace-files`　`dsh:packages/bundle/web-app/presets/standard.patch.yml:143`、`dsh:packages/bundle/web-app/cordis.patch.yml:114`
  - 我們：`@nexus/plugin-present` 在 cordis.yml（CLI 與 serve 共用的出貨清單），成功後寫一筆 `deliverables/presented` 進會話日誌。交付檔讀取的三個上限由 `#settings/deliverable-files` 照 dsh `workspace-files` 的預設值。web 卡片、預覽、下載、右側欄（#458／#463／#509–#511／#548／#552／#553／#563／#643）屬 UI，只列不判　`apps/harness/cordis.yml:95`、`packages/nexus-plugin-present/src/index.ts:64`、`packages/nexus-plugin-present/src/index.ts:277`
- **T-14 協定：ACP／SDK（程式化客戶端）**
  - dsh：出廠：acp-app bundle（`acp`）、sdk-app bundle（`sdk-jsonrpc-server`）；sdk-app 477b4f4 新增 `workspace-dependencies`、`skill-office` 兩列，條件式（有打包的 primary runtime 才開，打包版預設有）；headless 是 base 上的一次性執行　`dsh:packages/bundle/acp-app/cordis.patch.yml:17`、`dsh:packages/bundle/sdk-app/cordis.patch.yml:19`、`dsh:packages/bundle/sdk-app/cordis.patch.yml:31`
  - 我們：沒有 ACP／JSON-RPC 協定；`@nexus/wire` 只給 `apps/web`。一次性執行由 CLI 承擔（與 headless 同位）　`.docs/plugin-architecture-gap-survey.md:142`、`.docs/plugin-architecture-gap-survey.md:35`
- **T-15 協定：HTTP＋事件串流（web 的連線）**
  - dsh：web-app 出廠：`connection`（fetch＋SSE）、`webserver`、typert gateway　`dsh:packages/bundle/web-app/cordis.patch.yml:211`、`dsh:packages/bundle/base/cordis.patch.yml:409`
  - 我們：`@nexus/wire`（POST＋SSE），serve 的 wire-handler 發 `text/event-stream`。09-19 之後線上多帶成功的工具結果文字（#471，上限 `#settings/tool-text`）與讀檔／搜尋／改檔的結構化 meta（#619、#634）　`apps/harness/src/wire-handler.ts:786`、`packages/nexus-wire/src/client.ts:354`、`apps/harness/cordis.yml:311`
- **T-16 A2A**
  - dsh：dsh 也沒有：只在 implemented note 寫「后续」，packages／apps 零實作　`dsh:.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.zh.md:18`
  - 我們：沒有　`.docs/seven-layer-inventory-2026-09-19.md:74`
  - 否定搜尋：
    - dsh 477b4f4: git grep -n -I -w -i a2a -- packages apps → 0 筆；區分大小寫的 A2A、AgentCard、agent2agent -- packages apps → 0 筆（不分大小寫的子字串只中 README.i18n.yaml 的雜湊值與 ui-settings-subagent 的 SubagentCard）
    - nexus: git grep -n -I -i a2a -- apps packages ':!**/node_modules/**' → 1 筆，是 apps/web/tokengen/generate.mjs 的色碼 #2a2a2a
- **T-17 tool search／漸進披露**
  - dsh：dsh 也沒有 tool search 工具。477b4f4 新增了 `deferLoading` 標記與中途增減工具的投影（`tool_addition`／`tool_removal`），但只在宣告 `toolUpdate` 的 DeepSeek Messages 路由生效，不支援的路由收到的就是當下的完整工具清單；出廠套件沒有一顆工具標 `deferLoading: true`　`dsh:docs/cookbook/extension-cookbook.zh.md:120`、`dsh:packages/core/tools/src/schema.ts:500`、`dsh:packages/llm/llm/README.zh.md:162`
  - 我們：每次請求送當下的完整工具清單，等同 dsh 在不支援路由上的退路　`.docs/seven-layer-inventory-2026-09-19.md:75`
  - 否定搜尋：
    - dsh 477b4f4: git grep -n -I -- '<p>' -- packages apps（排除 test、spec、tests/）→ tool_search、toolSearch、tool-search 0 筆
    - dsh: git grep -n 'deferLoading' ddefc45 -- packages → 0 筆；477b4f4 → 86 筆
    - dsh: git grep -n -I 'deferLoading: true' -- packages ':!packages/core/**' ':!packages/llm/**' ':!packages/session/**' ':!**/*.test.ts' ':!**/tests/**' → 0 筆（沒有出廠工具使用）
    - nexus: git grep -n -I -i -- '<p>' -- apps packages ':!**/node_modules/**'，<p> 逐一為 tool_search、defer_loading、deferLoading → 0 筆；toolSearch 3 筆全是 web 的 ToolSearch 卡片元件
- **T-18 把 agent 當 MCP server**
  - dsh：dsh 也沒有：ACP 那側是吃客戶端給的 MCP server，不是把 agent 暴露成 MCP server　`dsh:packages/acp/acp/src/mcp.ts:26`
  - 我們：沒有；repo 裡的 McpServer／StdioServerTransport 全是測試用的 fixture server　`.docs/seven-layer-inventory-2026-09-19.md:76`
  - 否定搜尋：
    - dsh 477b4f4: git grep -n -I -E 'McpServer|mcp-server' -- packages apps（排除 test、spec、tests/）→ 只中 packages/acp/acp 的 mcp.ts、session.ts（ACP 客戶端給的 MCP server 型別，消費端）與 apps/cli/config/examples/mcp-memory 範例的指令名 mcp-server-memory
    - dsh 477b4f4: git grep -n -I StdioServerTransport -- packages apps → 2 筆，全在 packages/mcp/mcp-client/tests/fixtures/pagination-limit-server.ts（測試 fixture）
    - nexus: git grep -n -I -i 'McpServer\|StdioServerTransport' -- apps packages ':!**/node_modules/**' → 只中 apps/harness/src/mcp-fixture-server.ts 與 packages/nexus-plugin-mcp/src/fixture-server.ts（測試 fixture）
- **T-19 會話續接、列表、租約**
  - dsh：出廠：base `session-persistence-jsonl`＋web-app `session-controller`；web 側欄搜尋只比標題與工作區名　`dsh:packages/bundle/web-app/cordis.patch.yml:103`、`dsh:packages/bundle/base/cordis.patch.yml:145`
  - 我們：CLI `--resume`、serve 接回、`session-lease.ts` 單寫租約、`session-list.ts` 列會話。09-19 之後 #611 在 web 側欄做了按時間分組與標題搜尋（UI，只列不判；同 dsh 側欄只比標題）　`apps/harness/src/cli.ts:276`、`apps/harness/src/session-lease.ts:90`、`apps/harness/src/session-list.ts:237`
- **T-20 會話標題（含 LLM 生成標題 session-title-llm）**
  - dsh：出廠：base 掛 `session-title`（規則回退）與 `session-title-llm`（首句交給模型取標題），web-app／headless 繼承 base；acp-app 與 sdk-app 明確停用 LLM 那列；sdk-minimal 只有 `session-title`　`dsh:packages/bundle/base/cordis.patch.yml:56`、`dsh:packages/bundle/base/cordis.patch.yml:63`、`dsh:packages/bundle/acp-app/cordis.patch.yml:9`
  - 我們：只有規則回退 `fallbackThreadTitle`（同 dsh `fallbackSessionTitle`），上限由 `#settings/thread-title` 照 dsh `session-title` 的數字（#531 設定化）。LLM 取標題那一半沒有，也沒有任何卡或決議判過　`apps/harness/src/session-list.ts:119`、`apps/harness/src/session-list.ts:115`、`apps/harness/cordis.yml:270`
  - 驗證改判（待拍板 → 部分）：dsh 那側照列所述成立：base 掛 session-title 與 session-title-first-prompt-llm，web-app 與 headless 沿用（兩份 patch 都沒碰這兩列），acp-app 與 sdk-app 以 `disabled: true` 關 LLM 那列，sdk-minimal 只有規則標題。我方在 70357bb 只有 `fallbackThreadTitle`，沒有 LLM 標題。
  - 否定搜尋：
    - nexus: git grep -n -I -- '<p>' -- ':!**/node_modules/**'，<p> 逐一為 session-title-llm（3 筆，全在 .docs/seven-layer-inventory-2026-09-19.md）、title-first-prompt、titleModel、generateTitle、llmTitle → 程式碼 0 筆
    - issues.json 標題含「標題」或 title 的卡只有 #610（會話分組搜尋）與 #377（設計 token），沒有 LLM 標題的卡
- **T-21 斜線命令**
  - dsh：出廠預設：base `commands`　`dsh:packages/bundle/base/cordis.patch.yml:307`
  - 我們：`registry.commands` 註冊點；CLI 與 serve 的 wire-handler 直接 import `createCommandExecutor`　`packages/nexus-core/src/registry.ts:837`、`apps/harness/src/cli.ts:1244`、`apps/harness/src/wire-handler.ts:80`
- **T-22 產品路徑上的示範工具 echo（判過：刻意多掛）**
  - dsh：dsh 沒有示範工具　—
  - 我們：`echo` 在 cordis.yml，理由寫在該檔：預設組裝要證明工具真的接上了。這是登記過的刻意多掛，不是缺漏；09-19 引的 `cli.ts:451` 已隨 #454 搬到 cordis.yml　`apps/harness/cordis.yml:31`、`apps/harness/cordis.yml:25`
  - 驗證改判（判過不做 → dsh 也沒有）：這一列判「判過不做」跟它自己的 ours_status「有-預設」互相矛盾：我方沒有決定不做什麼，而是刻意多掛一顆 dsh 沒有的工具。dsh 那側獨立重推：477b4f4 非測試檔 `git grep -n -I -E "name: ['\"]echo['\"]|tool-echo|plugin-echo" -- packages apps` 0 筆，只有測試與 fixture 有 162 筆 `name: 'echo'`；`git grep -n -I -i echo -- packages/bundle ':!**/*.md'` 只中 headless/src/startup.ts:49 的 shell 用法說明。
  - 否定搜尋：
    - dsh 477b4f4: git grep -n -I -i echo -- packages/bundle ':!**/*.md' → 1 筆，是 headless/src/startup.ts 說明文字裡的 shell `echo`，沒有 echo 工具
- **T-23 模型看得到的工具 schema 目錄＋新鮮度 gate**
  - dsh：dsh repo 的 gate，不是出廠 profile 條目：`scripts/gen-tool-catalog.ts` 依 `TOOL_PACKAGES` 產生 `docs/tool-catalog.md`，`verify-tool-catalog` 由 `run-gates.ts` 驗新鮮度　`dsh:scripts/gen-tool-catalog.ts:205`、`dsh:scripts/run-gates.ts:798`、`dsh:package.json:162`
  - 我們：沒有目錄、沒有 gate；repo 裡唯一的 `tool-catalog` 字樣是 plan-mode 引用 dsh 那份目錄。workflows 只有 ci.yml、release.yml　`.docs/decisions-2026-09-19.md:21`、`packages/nexus-plugin-plan-mode/src/index.ts:168`
  - 否定搜尋：
    - nexus: git grep -n -I -- '<p>' -- ':!**/node_modules/**' ':!.docs/**'，<p> 逐一為 tool-catalog（1 筆：plan-mode 檔頭引用 dsh 的目錄）、toolCatalog、tool_catalog、gen-tool、verify-tool、TOOL_PACKAGES → 其餘 0 筆
    - nexus: ls .github/workflows → ci.yml、release.yml
- **T-24 檔案讀寫與搜尋工具（read／write／edit／ls／glob／grep）**
  - dsh：出廠預設：base `tool-fs`、`tool-fs-search`；web-app 關 host 列、改由 standard／ptc／cordis preset 掛　`dsh:packages/bundle/base/cordis.patch.yml:281`、`dsh:packages/bundle/base/cordis.patch.yml:284`、`dsh:packages/bundle/web-app/presets/standard.patch.yml:27`
  - 我們：基座 deepagents 的檔案工具組，CLI 與 serve 都在；給 `--workspace` 才換成 `ContainedFilesystemBackend` 落真碟並經圍堵，沒給時寫在虛擬 fs。#568 修了 grep 帶目錄的 glob 回 0 筆，改成對工作區根錨定（同 dsh）　`apps/harness/src/base-tools.ts:29`、`apps/harness/src/cli.ts:848`、`apps/harness/src/agent-factory.ts:99`
- **T-25 讀檔續讀提示與一頁上限（#594、#602）**
  - dsh：出廠預設（隨 `tool-fs` 的 `read`）：結尾一律帶「下一頁從哪讀／檔尾與總行數」，一頁 2000 行、50 KiB　`dsh:packages/fs/tool-fs/src/read-render.ts:160`、`dsh:packages/fs/tool-fs/src/read.ts:15`
  - 我們：`read-continuation.ts` 由 fold 在有 backend 時掛（即有 `--workspace`），補上 dsh 原句的結尾行；`READ_LIMIT` 2000、`READ_MAX_BYTES` 50 KiB。模型看到的描述在模型呼叫時換掉，是登記過的偏離（基座內建工具改不了描述）　`packages/nexus-core/src/read-continuation.ts:248`、`packages/nexus-core/src/read-continuation.ts:100`、`packages/nexus-core/src/read-continuation.ts:103`
- **T-26 工具結果結構化 meta（#617）**
  - dsh：出廠預設（隨 `tool-fs`／`tool-fs-search`）：`tool/result.meta` 帶 `FsReadMeta`、`SearchMeta`、`FsDiffMeta`，模型看不到、給 web 卡片用　`dsh:packages/fs/tool-fs/src/read-render.ts:192`、`dsh:packages/fs/tool-fs-search/src/presentation.ts:60`、`dsh:packages/fs/tool-fs/src/diff.ts:22`
  - 我們：`tool-result-meta.ts` 在 backend 層抓結構、形狀逐字照 dsh，由圍堵寫進 `tool/result`、上線給 web；有 backend 時才掛。基座檔案工具沒有 `presentationMeta` 那一格，退到 backend 層是登記過的載體偏離。web 專屬卡（#626）屬 UI，只列不判　`packages/nexus-core/src/tool-result-meta.ts:260`、`packages/nexus-core/src/fold.ts:480`、`packages/nexus-core/src/tool-result-meta.ts:21`
- **T-27 待辦工具 todo_write**
  - dsh：出廠預設：base `tool-todo`；standard／ptc／cordis preset 各掛　`dsh:packages/bundle/base/cordis.patch.yml:430`、`dsh:packages/bundle/web-app/presets/standard.patch.yml:134`
  - 我們：`@nexus/plugin-todo` 在 cordis.yml（`allowParallelInProgress: true`），CLI 與 serve 都有。09-19 之後 #577／#580／#582 把待辦清單送上線、畫在輸入框上方（UI，只列不判）　`apps/harness/cordis.yml:77`、`apps/harness/cordis.yml:79`、`.docs/plugin-architecture-gap-survey.md:186`
- **T-28 plugin 開發者工具（tool-cordis、cordis-inspect-providers、tool-plugin-manager）**
  - dsh：只在 cordis preset：`tool-cordis`（唯讀檢視 Host／Client API），web-app 477b4f4 新增 host 側 `cordis-inspect-providers` 供它讀；`tool-plugin-manager` 在 base／standard／ptc 都是 disabled，cordis preset 在 ddefc45 是開著、477b4f4 改成 `!ctx.get('profileContext')` 條件式。web 預設 preset 是 standard，所以預設會話沒有這幾顆　`dsh:packages/bundle/web-app/presets/cordis.patch.yml:142`、`dsh:packages/bundle/web-app/cordis.patch.yml:151`、`dsh:packages/bundle/web-app/presets/cordis.patch.yml:154`
  - 我們：模型沒有檢視或改組合的工具；人這側只有 `--dump-config` 印出疊完的清單　`apps/harness/src/cli.ts:280`
  - 驗證改判（待拍板 → 待拍板）：判定維持待拍板，但列上 dsh 那側有兩處錯漏。其一，`base:plugin-manager(disabled)` 不對：base :20-22 的 plugin-manager 服務寫的是 `disabled: !!js "!ctx.get('profileContext')"`；而 apps/cli/src/profile-boot.ts:298 開 profile 時一定提供 profileContext，所以這個服務出廠是開的。真正 disabled 的是 :16-18 的 tool-plugin-manager（`/tools` 那列）。
  - 否定搜尋：
    - nexus: git grep -n -I -i -- '<p>' -- apps/harness/src packages apps/web/src ':!**/node_modules/**'（排除 *.test.ts／*.test.tsx），<p> 逐一為 plugin_manager、install_plugin、cordis_inspect、inspect_api、plugin-manager → 全部 0 筆
- **T-29 每個會話選 agent preset（agent-preset-registry、四個 preset）**
  - dsh：web-app 出廠：`agent-preset-registry`（477b4f4 取代 `agent-presets`，`default: standard`），四個 `preset-*` 由 `presets/*.patch.yml` 插入；web-app 把 agent 平面整批停用、每個會話掛一個 preset；web 編輯器存的修改會蓋掉 preset 的 plugins　`dsh:packages/bundle/web-app/cordis.patch.yml:560`、`dsh:packages/bundle/web-app/cordis.patch.yml:432`、`dsh:packages/bundle/web-app/presets/standard.patch.yml:2`
  - 我們：出貨清單只有一份，套用到每一個會話；`resume-guards.ts` 明寫我們沒有 preset。部署設定層地圖 #46 還開著，但它管的是組合設定化，沒有涵蓋逐會話選組合　`apps/harness/src/resume-guards.ts:28`、`apps/harness/cordis.yml:3`
  - 驗證改判（待拍板 → 判過不做）：列上說「09-19 只在工作筆記記下 preset 機制，未判」，但其實有登記。調研筆記 §三第 29 列的 `preset`（「按會話從 preset 檔組裝 agent」）描述的正是這個能力。§三小計第 201 行把 preset 列進企業級與分散式，結論速查第 35 行寫「企業級與分散式 13 個套件：定位差異，不是缺口」。這跟同層 T-14（ACP／SDK，出處是調研筆記 §三小計）、G-09（credentials，同一份小計，判過不做、附前提重核）是同一種出處，所以類別應該是「判過不做」。另外 #46 的 Out of scope（gh 核過）排除了「profile 層」與「從 web UI 改設定」，也支持目前不做。
  - 否定搜尋：
    - nexus: git grep -n -I -i preset -- apps/harness/src packages apps/web/src ':!**/node_modules/**'（排除測試）→ 18 筆，全是引用 dsh 的註解（sandbox 權限 preset、present 檔頭、fold 對照），沒有 preset 機制
- **T-30 Office 轉 PDF 預覽（office-to-pdf／document）**
  - dsh：web-app 出廠：`office-to-pdf`，配 `ui-sidebar-documentpreview` 的右側欄文件預覽　`dsh:packages/bundle/web-app/cordis.patch.yml:264`
  - 我們：沒有 Office 轉換。**拍板時的理由「我們的 web 沒有預覽面板」已部分過期**：#643（#640）把交付預覽放進右側欄，但只收文字，docx 之類會顯示「不是文字檔，沒辦法預覽」。重開條件（dev-ui 要做文件預覽）可說已部分觸發，建議請 demian 重核　`.docs/decisions-2026-09-19.md:28`、`.docs/plugin-architecture-gap-survey.md:196`、`apps/web/src/components/right-sidebar.tsx:2`
  - 否定搜尋：
    - nexus: git grep -n -I -i -- '<p>' -- apps packages ':!**/node_modules/**'，<p> 逐一為 pptx、libreoffice、soffice → 0 筆；docx 3 筆與 xlsx 1 筆都在測試或註解
- ~~T-09 MCP 子行程環境清洗與絆索~~：併入 G-10（歸屬表：MCP 子行程環境清洗與絆索→G）

</details>

### C 上下文與記憶

| ID | 項目 | 判定 | 09-19 | 我方 | 追蹤 |
| --- | --- | --- | --- | --- | --- |
| C-01 | 工作區指令 AGENTS.md（agent-instructions） | **完成** | 有；每步刷新判過不做（#389 not planned） | 有-預設 | #388、#397、#389（not planned） |
| C-02 | 自動摘要（token 壓力觸發） | **完成** | 有（筆記 §五第 1 條「收完」） | 有-預設 | #142、#143、#446、#515 |
| C-03 | 摘要 prompt 保留原始意圖與使用者糾正（清單缺口 3） | **缺口** | 缺口（表格列＋清單第 3 項，兩側都核過） | 沒有 | #432（OPEN，needs-triage）；盤點後在 #432 留言補充 |
| C-04 | 工具輸出修剪（tool-result-pruner） | **完成** | 有 | 有-預設 | #149、#446、#514 |
| C-05 | 大輸出外溢（spill） | **部分** | 09-19 判「有」；第一輪判「部分」但理由錯（把 tool-text 的傳輸截斷當成外溢）；調研筆記 §三第 39 列本來就判「部分」 | 部分 | #151、#170、#538、#642；盤點後開 #719 |
| C-06 | 手動 /compact | **判過不做** | 判過：登記為偏離（#142） | 沒有 | #142 |
| C-07 | 圖片省略（image-offload）與圖片不送模型（#642） | **待拍板**（改判） | 判過：attachment 屬定位差異 | 沒有（附件儲存、read_image、image-offload 都沒有）；圖片不送模型已照 dsh「沒掛附件」那一格落地（#642）。附件本身在 #642 寫「另議」、在 web 清單第 20 項寫「先 grilling」，是未決，不是判過不做 | #642；盤點後開 #715 |
| C-08 | 上下文壓力量表（token-meter） | **完成** | 部分（沒有 replay-aware 的量表） | 有-預設 | #153、#528、#586、#588 |
| C-09 | 重複呼叫提醒（repeat-tool-reminder） | **完成** | 有 | 有-預設 | #147、#512 |
| C-10 | 計劃模式指引注入（09-19「goal／計劃重新注入」列的 C 那一半） | **完成** | 有（goal plugin 的 wrapup、plan-mode） | 有-預設 | #116、#120、#251 |
| C-11 | 跨會話引用（session-reference，清單第 13 項） | **已拍板未落地** | 未判（表格列＋清單第 13 項） | 沒有 | decisions-2026-09-19 第 5 題、調研筆記第 9 列；盤點後開 #713 |
| C-12 | @file 引用補全（file-reference-local，清單第 14 項） | **已拍板未落地** | 未判（表格列＋清單第 14 項） | 沒有；觸發條件已到：2026-09-26 拍板 Q1–Q9，#651（harness 列檔路由＋提示句，ready-for-agent）與 #653（web 的 @ 選單，等 #651）已開卡，尚未合併；追蹤要補 #651、#653 | decisions-2026-09-19 第 6 題、調研筆記第 9 列；基準之後開了 #651（harness 那半，已由 PR #676 合進 develop）、#653（web 那半，開著） |
| C-13 | 模型可寫的長期記憶 | **dsh 也沒有** | 框架要、dsh 出廠也沒有 | 有-選配 | — |
| C-14 | 時間上下文（time-context）（新） | **dsh 也沒有**（改判） | （不在 09-19 表內；調研筆記判「登記不排」） | 沒有 | #215、調研筆記 §五第 7 條 |
| C-15 | 摘要與修剪各自是可關的條目（#446 拆分）（新） | **完成** | （09-19 決議第 12 題拍板「先拆摘要器」，當時未做） | 有-預設 | #446、#46、#514、#515 |
| C-16※ | 系統提示詞的身分與 persona（部署方可設的前後綴、{{model}}／{{cwd}}）（新） | **部分** | — | 部分 | 盤點後開 #720 |

<details><summary>逐列依據</summary>

- **C-01 工作區指令 AGENTS.md（agent-instructions）**
  - dsh：出廠預設：base :288；web-app 用 id 關掉 base 那列（:546），改由 standard／ptc／cordis 三個 preset 掛（standard :16）；minimal preset 沒掛　`dsh:packages/bundle/base/cordis.patch.yml:289`、`dsh:packages/bundle/web-app/presets/standard.patch.yml:17`
  - 我們：cordis.yml 的 agent-instructions 條目，CLI 與 serve 共用；有 --workspace（有 backend）才真的建 middleware，同 dsh「沒有檔案系統提供方就載不到」。摘要切掉之後下一次 invoke 補回（#397）。巢狀發現、改檔刷新、移除通知不做：#389 以 not planned 關閉，檔頭寫明重開條件。　`apps/harness/cordis.yml:37`、`apps/harness/cordis.yml:34`、`packages/nexus-plugin-agent-instructions/src/index.ts:7`
  - 否定搜尋：
    - git -C <dsh> grep -n -E "agent-instructions|compaction" 477b4f4 -- packages/bundle/web-app/presets/minimal.patch.yml → 0 筆（minimal preset 沒掛）
- **C-02 自動摘要（token 壓力觸發）**
  - dsh：出廠預設：base :340 compaction-basic；web-app 關掉 base 那列（:506），改由 standard／ptc／cordis preset 的 compaction 群組掛（standard :70）；minimal preset 沒有。477b4f4 新增 headroomTokens（預設 65,536），門檻改成 min(窗口×比例, 窗口−輸出保留−headroom)　`dsh:packages/bundle/base/cordis.patch.yml:341`、`dsh:packages/bundle/web-app/presets/standard.patch.yml:71`、`dsh:packages/compaction/compaction-basic/src/config.ts:75`
  - 我們：cordis.yml 的 summarization 條目，fold 同名取代基座摘要器，root 與每個子代理各一份。門檻兩道並聯：tokens 100,000、messages 60（絕對值，量過最小窗口 131,007 且扣了 16,384 輸出）。#588 起 tokens 那道由 withTokenBudget 用錨定估算比、拋合成的 ContextOverflowError 借基座的緊急摘要路；#584 起生摘要那次呼叫貼 nostream 不上線；溢出恢復已由 #150/#166 補上；設定從條目來（#515）。　`apps/harness/cordis.yml:151`、`apps/harness/cordis.yml:154`、`packages/nexus-core/src/summarization.ts:590`
  - 否定搜尋：
    - git -C <dsh> grep -n -E "agent-instructions|compaction" 477b4f4 -- packages/bundle/web-app/presets/minimal.patch.yml → 0 筆（minimal preset 沒掛）
- **C-03 摘要 prompt 保留原始意圖與使用者糾正（清單缺口 3）**
  - dsh：出廠預設：compaction-basic 內建的 COMPACTION_INSTRUCTION（Primary Request and Intent、Errors and Fixes、Pending Jobs、Next Step、Critical Context，並要求忠實保留使用者糾正），跟著 base :340 與三個 preset 出廠　`dsh:packages/compaction/compaction-basic/src/summarizer.ts:37`、`dsh:packages/compaction/compaction-basic/src/summarizer.ts:63`、`dsh:packages/bundle/base/cordis.patch.yml:341`
  - 我們：createSummarizer 呼叫 createSummarizationMiddleware 時沒有傳 summaryPrompt，全 repo 零命中，所以用的是 deepagents 預設的通用摘要 prompt。#432 已開卡（needs-triage），還沒動工。　`packages/nexus-core/src/summarization.ts:317`
  - 否定搜尋：
    - git -C <nexus> grep -n -E "summaryPrompt|SUMMARY_PROMPT|summary_prompt" 70357bb -- apps packages → 0 筆
- **C-04 工具輸出修剪（tool-result-pruner）**
  - dsh：出廠預設：base :417（8192／4096／1024）；web-app 關掉 base 那列（:512），改由 standard／ptc／cordis preset 的 compaction 群組掛（standard :74）　`dsh:packages/bundle/base/cordis.patch.yml:418`、`dsh:packages/bundle/base/cordis.patch.yml:420`、`dsh:packages/bundle/web-app/presets/standard.patch.yml:75`
  - 我們：cordis.yml 的 tool-result-pruner 條目，三格預算與 dsh 逐字相同；只在摘要開著時有作用（同 dsh：唯一消費者是 compaction）。壓力判斷讀的是 #588 的同一套錨定估算。#446 起可單獨關。　`apps/harness/cordis.yml:138`、`apps/harness/cordis.yml:140`、`apps/harness/cordis.yml:135`
- **C-05 大輸出外溢（spill）**
  - dsh：出廠預設：base :403 spill-local＋:406 spill-policy，所有疊在 base 上的 profile（web-app、headless、acp-app、sdk-app）都有，只有不疊 base 的 sdk-minimal 沒有。477b4f4 把設定從 maxInlineBytes: 50000 改成 maxInlineTokens: 12500（圖文共用估算預算，圖片放附件儲存），read 例外照舊；全文存宿主上的 spill 檔　`dsh:packages/bundle/base/cordis.patch.yml:404`、`dsh:packages/bundle/base/cordis.patch.yml:409`、`dsh:packages/spill/spill-policy/src/index.ts:135`
  - 我們：模型面有：基座 FilesystemMiddleware 在 80,000 字元（4×toolTokenLimitBeforeEvict）以上把結果寫進 /large_tool_results，換成頭尾預覽加一句 read_file 指路；withToolResultStash 無條件把那個前綴路到 graph state，CLI 與 serve 都在，讀檔類工具不外溢（同 dsh 的 read 例外）。缺的三格：門檻寫死在基座預設、組裝點沒改也關不掉；暫存在 graph state，續接／serve 重啟還原之後預覽指的路徑讀不到；沒有宿主上的私有檔與保留期。tool-text 那列的 50,000 位元組是往 web 放的傳輸上限，不是模型面外溢（歸 T）。　`apps/harness/src/agent-factory.ts:296`、`apps/harness/src/agent-factory.ts:465`、`apps/harness/src/conversation-restore.ts:58`
  - 否定搜尋：
    - git -C <nexus> grep -n "toolTokenLimitBeforeEvict:" 70357bb -- apps packages → 0 筆（組裝點沒有設這個門檻）
    - git -C <dsh> grep -n "spill" 477b4f4 -- packages/bundle/web-app packages/bundle/sdk-minimal → 0 筆（web-app 沒關 base 的 spill 兩列；sdk-minimal 不疊 base、沒有 spill）
- **C-06 手動 /compact**
  - dsh：出廠預設：base :345 command-compact；web-app 關掉 base 那列（:509），standard／ptc／cordis preset 的 compaction 群組掛（standard :72）　`dsh:packages/bundle/base/cordis.patch.yml:346`、`dsh:packages/bundle/web-app/presets/standard.patch.yml:73`
  - 我們：全 repo 沒有 /compact 命令。調研筆記把「手動 /compact、指定範圍、鎖」登記為 #142 的偏離，理由是基座表達不出來。**前提待重核**：同一份「表達不出來」清單裡的溢出後恢復後來已做掉（#150/#166），#589 的 withTokenBudget 也示範了用合成的 ContextOverflowError 逼基座摘要，理由可能已過期；結論沒有人重判，這裡不翻判。　`.docs/plugin-architecture-gap-survey.md:287`、`.docs/plugin-architecture-gap-survey.md:278`、`packages/nexus-core/src/summarization.ts:589`
  - 否定搜尋：
    - git -C <nexus> grep -n -E "/compact|command-compact" 70357bb -- apps packages → 4 筆，全是引用 dsh 的 packages/compaction/... 路徑的註解，沒有命令
- **C-07 圖片省略（image-offload）與圖片不送模型（#642）**
  - dsh：出廠預設：base :426 image-offload（能看圖的路由超出圖片預算時把最舊的圖換成佔位再重試），配 base :138 attachment-local；web-app 另掛 ui-attachment　`dsh:packages/bundle/base/cordis.patch.yml:427`、`dsh:packages/bundle/base/cordis.patch.yml:425`、`dsh:packages/bundle/base/cordis.patch.yml:139`
  - 我們：沒有圖片輸入、沒有附件儲存，所以沒有可省略的圖。#642（PR #644）之後圖片確定不會進模型：read_file 讀到二進位檔照 dsh 看內容拒絕（binary file／invalid UTF-8 text），MCP 工具回的圖片塊換成 `[image unavailable: …; no attachment store is mounted]`，形狀照 dsh 沒掛附件儲存時的那一格。　`apps/harness/src/binary-read.ts:8`、`apps/harness/src/binary-read.ts:32`、`packages/nexus-plugin-mcp/src/project-content.ts:24`
  - 驗證改判（判過不做 → 待拍板）：拆成兩半看。「圖片不送模型」那半由 #642（PR #644）照 dsh 沒掛附件儲存那一格落地，成立。「image-offload／附件」那半的「判過：attachment 屬定位差異」站不住。(1) 那個判定的唯一依據，是調研筆記 :201 把 25 個「沒有」分桶時把 attachment 放進「企業級與分散式——定位差異」。這一桶不是逐項拍板：同一桶裡的 settings（第 36 列，掛 #46）已被 09-19 決議第 12 題「C 啟動 #46」重啟。(2) 之後的兩個出處都把附件當成未決。web 元件清單第 20 項「附件（輸入與訊息中的圖）」是 P1，歸在「整塊新功能（三層都沒有，先 grilling）」。
  - 否定搜尋：
    - git -C <nexus> grep -n -E "read_image|attachmentStore|attachment-local" 70357bb -- apps packages → 1 筆，binary-read.ts:7 的註解（說明我們沒有附件儲存），沒有實作
- **C-08 上下文壓力量表（token-meter）**
  - dsh：出廠預設：base :337 token-meter（可注入的 measure()，錨在上一次供應商用量、加估算增量；註冊 contextPressure 投影給 web）　`dsh:packages/bundle/base/cordis.patch.yml:338`、`dsh:packages/llm/token-meter/src/index.ts:115`
  - 我們：#588（PR #589）的錨定估算：錨照 dsh，估算器換 o200k、加內容比例（登記的偏離，理由是 dsh 形狀量到最大 79.8% 誤差）。摘要判準、修剪與用量表讀同一個數；每次 root 呼叫記一顆 context/measure 進日誌，歷史分頁可重播。web 的用量表（#528，PR #583）只在 serve：分母是摘要門檻不是模型窗口（登記的偏離）。CLI 沒有畫面，但判準照用。不是 dsh 那種可注入的服務，是 core 內的模組。　`packages/nexus-core/src/summarization.ts:608`、`packages/nexus-wire/src/context-pressure.ts:36`、`packages/nexus-wire/src/context-pressure.ts:19`
- **C-09 重複呼叫提醒（repeat-tool-reminder）**
  - dsh：出廠預設：base :454（thresholds [3,5,8]、argumentsPreviewChars 500）　`dsh:packages/bundle/base/cordis.patch.yml:455`、`dsh:packages/bundle/base/cordis.patch.yml:457`
  - 我們：cordis.yml 的 repeat-reminder 條目，門檻與預覽字數照 dsh，多了 include／exclude 兩格；fold 預設開，root 與子代理各一份。　`apps/harness/cordis.yml:125`、`apps/harness/cordis.yml:127`
- **C-10 計劃模式指引注入（09-19「goal／計劃重新注入」列的 C 那一半）**
  - dsh：出廠預設：base :321 plan-mode；web-app 關掉 base 那列（:496），standard／ptc／cordis preset 的 planning 群組掛（standard :48）　`dsh:packages/bundle/base/cordis.patch.yml:322`、`dsh:packages/bundle/web-app/presets/standard.patch.yml:49`
  - 我們：cordis.yml 的 plan-mode 條目；啟用時由 wrapModelCall 每次模型呼叫附指引（對上 dsh 的 plan:policy 段落），不在訊息裡，所以摘要切不掉；模式狀態走 plan/mode 事件，跨重啟留得住。goal 那一半（續行時注入 goal-round 提示、goal-driver 預設關）歸 L 層，這裡不判。　`apps/harness/cordis.yml:53`、`packages/nexus-plugin-plan-mode/src/index.ts:26`
- **C-11 跨會話引用（session-reference，清單第 13 項）**
  - dsh：出廠預設，只在 web-app（:75），UI 半邊是 ui-reference（:359）；相依 sessionQuery　`dsh:packages/bundle/web-app/cordis.patch.yml:76`、`dsh:packages/bundle/web-app/cordis.patch.yml:360`、`dsh:packages/context/session-reference/README.zh.md:12`
  - 我們：沒有 @ 提及語法、沒有 sessionQuery，全 repo 零命中。09-19 決議第 5 題拍板 A「等 web 要做 @ 提及時再一起做」。web 的 `@` 引用在前端元件清單第 28 項（P1），9/25 現況仍列「沒做」，所以觸發條件還沒到，不是積欠。　`.docs/decisions-2026-09-19.md:22`、`.docs/agent-ui-element-inventory.md:159`、`.docs/agent-ui-element-inventory.md:97`
  - 否定搜尋：
    - git -C <nexus> grep -n -i -E "file-reference|session-reference|fileReference|sessionReference|sessionQuery|@file" 70357bb -- apps packages → 0 筆
    - git -C <nexus> grep -n -i "mention" 70357bb -- apps/web packages/nexus-wire → 0 筆
- **C-12 @file 引用補全（file-reference-local，清單第 14 項）**
  - dsh：出廠預設，只在 web-app（:78），連同 seam file-reference；UI 半邊同 ui-reference（:359）　`dsh:packages/bundle/web-app/cordis.patch.yml:79`、`dsh:packages/context/file-reference-local/README.zh.md:12`
  - 我們：沒有 @file 補全，全 repo 零命中。09-19 決議第 6 題拍板 A「等 web 要做 @file 補全時再一起做」，後端候選清單歸 harness。web 側同 C-11，元件清單第 28 項仍沒做，觸發條件未到。　`.docs/decisions-2026-09-19.md:23`、`.docs/agent-ui-element-inventory.md:97`
  - 驗證改判（已拍板未落地 → 已拍板未落地）：判定標籤不變，仍是「已拍板未落地」：70357bb 與 origin/develop 1231b04 都沒有 file-reference 的任何實作，否定 grep 同 C-11。要改的是現況與追蹤。ours_detail 寫「元件清單第 28 項仍沒做，觸發條件未到」已過期：demian 2026-09-26 拍板 Q1–Q9，harness 那半開成 #651（OPEN，ready-for-agent，列檔路由加提示句，照 dsh 477b4f4 的 file-reference-local），web 那半開成 #653（OPEN，等 #651 先合）。
  - 否定搜尋：
    - git -C <nexus> grep -n -i -E "file-reference|session-reference|fileReference|sessionReference|sessionQuery|@file" 70357bb -- apps packages → 0 筆
- **C-13 模型可寫的長期記憶**
  - dsh：dsh 也沒有：出廠清單零記憶條目；docs/user/guide/mcp-memory.zh.md 給三份預設關的第三方記憶 MCP 參考設定　`dsh:docs/user/guide/mcp-memory.zh.md:31`
  - 我們：@nexus/plugin-memory（包基座的 createMemoryMiddleware）要 patch 才有；出貨清單只掛它的 invariant 配套。MCP plugin 也是選配，接得上 dsh 文件那幾個記憶 server。　`packages/nexus-plugin-memory/src/index.ts:2`、`apps/harness/cordis.yml:395`
  - 否定搜尋：
    - git -C <nexus> grep -n "@nexus/plugin-memory" 70357bb -- apps/harness ':!*.test.ts' → 只中 cordis.yml:395 的 invariant 與 package.json 相依
    - git -C <dsh> grep -n -i "memory" 477b4f4 -- packages/bundle packages/preset ':!**/tests/**' ':!**/skills/**' → 只中 ':memory:' sqlite 路徑與 in-memory 註解
- **C-14 時間上下文（time-context）**
  - dsh：出廠但 disabled：477b4f4 web-app :121 新增、:123 disabled，跟 schedule（:125，同樣 disabled）配對；ddefc45 不在任何 profile　`dsh:packages/bundle/web-app/cordis.patch.yml:122`、`dsh:packages/bundle/web-app/cordis.patch.yml:119`、`dsh:packages/context/time-context/README.zh.md:12`
  - 我們：沒有模型可見的牆鐘、時區讀數。調研筆記把 time-context／tmux-context 登記為「登記不排」，附兩條重開條件；理由之一正是 dsh 自己把它歸給 Schedule，而 477b4f4 的 web-app 也是跟 schedule 一起掛、一起關。　`.docs/plugin-architecture-gap-survey.md:27`
  - 驗證改判（判過不做 → dsh 也沒有）：row 自己的 dsh_status 就寫「出廠但 disabled」。dsh 全 repo 查找 git grep -n -E "dsh-time-context|id: time-context|time-context'" 477b4f4 -- '*.yml' '*.yaml' '*.ts' '*.json'（排除 tests 與套件本身）的結果：設定列只有 web-app :121，下兩行就是 disabled: true；其餘命中是 apps/cli 與 web-app 的 package.json 相依、dependency-catalog，以及 v3→v4 遷移的 source 名單。
  - 否定搜尋：
    - git -C <nexus> grep -n -i -E "time-context|timeZone" 70357bb -- apps packages ':!*.md' → 1 筆，session-registry.ts:21 引用 dsh 路徑的註解，沒有實作
- **C-15 摘要與修剪各自是可關的條目（#446 拆分）**
  - dsh：出廠預設：compaction-basic 與 tool-result-pruner 各是 base 的一列，按 id 關得掉（web-app 就用 disabled 關掉 base 那兩列再由 preset 掛）　`dsh:packages/bundle/web-app/cordis.patch.yml:506`、`dsh:packages/bundle/web-app/cordis.patch.yml:512`
  - 我們：#446（PR #450）起摘要與修剪各自一個條目；#515／#514 起設定從條目來。disabled 的摘要發一顆同名空殼（基座無條件建摘要器，同名取代是唯一消得掉它的辦法），連帶歷史 offload 與修剪一起沒有；只關修剪則摘要照跑。　`apps/harness/cordis.yml:148`、`apps/harness/cordis.yml:112`、`packages/nexus-core/src/fold.ts:217`
- **C-16 系統提示詞的身分與 persona（部署方可設的前後綴、{{model}}／{{cwd}}）**
  - dsh：出廠預設：六個 profile 全掛 system-prompt；入口 profile 覆寫成「coding agent powered by {{model}}」＋「working directory is {{cwd}}」　`dsh:packages/bundle/base/cordis.patch.yml:504`、`dsh:packages/core/system-prompt/README.md:46`、`dsh:packages/bundle/web-app/cordis.patch.yml:20`
  - 我們：有提示詞但部署方設不到：cli.ts:603 寫死「你是 nexus-agent 的命令列助手」，serve 共用同一個 createCliAgent，web 會話也被告知是命令列助手；出貨清單與 patch 沒有 persona 欄位　`apps/harness/src/cli.ts:604`、`apps/harness/src/cli.ts:891`、`apps/harness/src/serve.ts:414`
  - 否定搜尋：
    - git grep -n -i -E "persona|personaPrefix|personaSuffix|includeHarnessIdentity|includeRuntimeContext" 70357bb -- apps packages → 0 筆
    - git grep -n -i -E "systemPrompt|system-prompt|SYSTEM_PROMPT|persona" 70357bb -- apps/harness/cordis.yml → 0 筆
    - git grep -n -E "\{\{(model|cwd)\}\}|working directory is|工作目錄是" 70357bb -- apps packages → 0 筆
  - dsh 另有一個 `persona` 條目，只能掛在 preset 裡，用來替逐會話的 preset 換 persona。覆蓋檢查把它歸到 T-29（逐會話選 preset，判過不做）；這一列只管部署層的身分與 persona。
  - ※ 覆蓋檢查新增：證據過了主線核對，但沒有經過對抗式驗證。

</details>

### L 生命週期與編排

| ID | 項目 | 判定 | 09-19 | 我方 | 追蹤 |
| --- | --- | --- | --- | --- | --- |
| L-01 | 單一 agent 迴圈 | **完成** | 有 | 有-預設 | #356 |
| L-02 | 每輪步數上限（迴圈硬上限） | **dsh 也沒有** | 有（比 dsh 多一條硬上限） | 有-預設 | #362、#533 |
| L-03 | 模型請求重試（含串流內與串流中段錯誤） | **部分** | 有 | 部分 | #516、#520、#545；盤點後在 #520 留言補充 |
| L-04 | 取消／核准暫停／續接 | **完成** | 有 | 有-預設 | #593、#629 |
| L-05 | 一輪的結束原因：max-tokens（輸出被截斷） | **完成** | 缺口 | 有-預設 | #433 |
| L-06 | 畫面提示這一輪撞到輸出上限（新） | **web UI 只列不判** | （新） | 部分 | #608 |
| L-07 | 崩潰孤兒輪補結（`interrupted` closer） | **部分** | 部分，未判（小） | 部分 | #306；盤點後開 #721 |
| L-08 | 耐久檢查點（session-checkpoint-policy） | **部分**（改判） | 未判（清單 15 沒判過） | 有-預設，但少一截：core 條目 session-checkpoint-policy，fold 在 root 與子代理各掛一顆。wrapModelCall 在 root 與子代理的主呼叫前都排空，這同時承載了 dsh 的 llm/stream 與 agent/pre-step。wrapToolCall 只對 root 排空。殘差兩條：(a) 摘要那次呼叫前不排空，已登記；(b) 子代理的工具呼叫在本體前不排空。(b) 登記成偏離三，但它的前提（dsh 的「頂層」等於 root）與 dsh 原始碼不符，而且表達得出來，不是合格偏離。 | #447、#599；盤點後開 #722 |
| L-09 | 長期目標＋自動續行（goal-driver） | **已拍板未落地** | 判過（#180 §五），前提待重核 | 部分 | #180、#445、#638 |
| L-10 | 失敗迴圈停損 | **完成** | 有 | 有-預設 | — |
| L-11 | 子代理：全新派生 | **完成** | 有 | 有-預設 | — |
| L-12 | 子代理：fork 與其他委派後端（codex／claude-code） | **判過不做** | 判過：認帳不做（筆記 §五第 6 條） | 沒有 | — |
| L-13 | 子代理：續行／背景（continuable）、send_message、list_agents | **缺口** | 已登記：#324「要做時再開卡」 | 沒有 | 盤點後開 #708 |
| L-14 | 子代理：逐個選模型 | **缺口** | 已登記：#328 第 3 項 | 沒有 | #328；盤點後開 #709，#328 第 3 項是另一件 |
| L-15 | 子代理：深度上限 | **完成** | 有 | 有-預設 | — |
| L-16 | 工作流編排（腳本扇出子代理） | **判過不做** | 判過：需求未出現 | 沒有 | — |
| L-17 | 背景工作（jobs） | **判過不做** | 判過：需求未出現 | 沒有 | — |
| L-18 | 排程（會話本地持久提醒 schedule）（新） | **dsh 也沒有** | （新） | 沒有 | — |
| L-19 | 一次性任務模式（headless） | **完成** | 有 | 有-預設 | — |
| L-20 | issue→PR 流水線 | **dsh 也沒有** | 框架要、dsh 出廠也沒有 | 沒有 | — |
| L-21 | 獨立的完成認證 | **dsh 也沒有** | 框架要、dsh 也沒有 | 沒有 | — |
| L-22 | 送出佇列（人送出的話排在伺服器、可列可改可刪、等核准答完才跑）（新） | **完成** | （新） | 有-僅 serve | #629、#637 |
| L-23 | 插話（next-step steer）（新） | **缺口** | （新） | 沒有 | 盤點後開 #710 |
| L-24 | 串流閒置逾時（吐了內容之後停住）（新） | **完成** | （新） | 有-預設 | #521 |
| L-25 | 每步平行工具呼叫上限（新） | **缺口** | （新，09-19 沒列） | 沒有 | 盤點後開 #711 |
| L-26※ | 模型選擇：部署預設模型＋每會話換模型與推理強度（新） | **部分** | — | 部分 | 盤點後開 #723 |

<details><summary>逐列依據</summary>

- **L-01 單一 agent 迴圈**
  - dsh：出廠預設：base `agent-loop`（:510）＋`agent`（:74）；sdk-minimal 也掛　`dsh:packages/bundle/base/cordis.patch.yml:510`
  - 我們：deepagents `createDeepAgent`／LangGraph 迴圈，迴圈本身不可換；偏離已登記（development-plan.md 決策 §0 第 2 列，#356）　`.docs/development-plan.md:23`、`apps/harness/src/agent-factory.ts:69`
- **L-02 每輪步數上限（迴圈硬上限）**
  - dsh：dsh 也沒有：agent-loop 無 maxSteps；全樹只中外部 claude-code 後端的 `error_max_turns`　`dsh:packages/subagent/subagent-claude-code/src/run.ts:115`
  - 我們：LangGraph `recursionLimit` 由 `#settings/recursion-limit` 條目給（預設 100，#533 起條目化），`--recursion-limit` 可蓋；一次性路徑撞到回退出碼 2（#362）　`apps/harness/cordis.yml:347`、`apps/harness/cordis.yml:335`、`apps/harness/src/cli.ts:1621`
  - 否定搜尋：
    - rtk proxy git grep -n -i -E "maxSteps|maxTurns|max_turns|stepLimit|maxIterations" 477b4f4 -- packages apps ':!**/tests/**' ':!**/*.test.ts' ':!**/*.e2e.ts'（dsh；只中 subagent-claude-code/src/run.ts:115；對照 maxParallelToolCalls 在 agent-loop/src 中 7 筆）
- **L-03 模型請求重試（含串流內與串流中段錯誤）**
  - dsh：出廠預設：base `llm-retry`（:91），重試掛在 agent-loop 的 `agent/request-error` 步級掛點，串流中段出錯也重跑這一步　`dsh:packages/bundle/base/cordis.patch.yml:91`、`dsh:packages/llm/llm-retry/README.md:72`
  - 我們：`--live` 時 `AsyncCaller`→`p-retry` 包建立串流的那次呼叫；#516（PR #523）讓第一則 SSE 事件就是錯誤的也進得了重試；`maxRetries` 條目化（#545，PR #549）。吐了內容之後中段才出錯、串流中途斷掉：當場失敗零重試（偏離登記在 live-model.ts，理由是沒有宣告「已送出的字作廢」的載體），補做是 #520（開著）　`apps/harness/src/live-model.ts:448`、`apps/harness/src/live-model.ts:463`、`apps/harness/src/live-model.ts:843`
- **L-04 取消／核准暫停／續接**
  - dsh：出廠預設：agent-loop（取消、`aborted` 結束原因）、approval、session-persistence（續接）　`dsh:packages/core/session/src/types.ts:204`
  - 我們：`turn-cancel.ts` 合作式取消；核准以 interrupt 暫停；CLI `--resume <run 目錄>`、serve 接回；續接時撤回懸空工具呼叫（thread-pump `danglingToolCalls`）。09-19 後新增：web 斷線自動重連（#593／PR #597，web 端）、排隊訊息等核准答完才跑（#629，併入 L-22）　`packages/nexus-core/src/turn-cancel.ts:85`、`apps/harness/src/cli.ts:236`、`apps/harness/src/thread-pump.ts:613`
- **L-05 一輪的結束原因：max-tokens（輸出被截斷）**
  - dsh：出廠預設：agent-loop 的 `TurnEndReason` 含 `max-tokens`（sticky），goal-round-driver 見到就收回續行授權　`dsh:packages/core/session/src/types.ts:214`、`dsh:packages/goal/goal-round-driver/src/index.ts:329`
  - 我們：fold 預設掛 max-tokens middleware：`finish_reason` 為 length 時丟掉這則的工具呼叫、收掉這一步，`turn/end` 帶 `{kind:'max-tokens'}`；goal driver 見到就 disarm；子代理截斷以載體轉成 dsh 那句錯誤。登記的偏離兩條：web 路徑的原字串被 @langchain/core 對映、子代理退到載體。其餘結束原因：`error`→O（#434），`completed`／`blocked`／`forked` 我方無生產者，`interrupted` 見 L-07　`packages/nexus-core/src/session-log.ts:189`、`packages/nexus-core/src/max-tokens.ts:2`、`packages/nexus-core/src/fold.ts:380`
- **L-06 畫面提示這一輪撞到輸出上限**
  - dsh：出廠（web-app 的 ui-chat）：輪尾畫 `turn-max-tokens` 提示節點　`dsh:packages/client/ui-chat/src/client/chat/MessageItem.tsx:374`
  - 我們：wire 折疊器已在 AiEntry 帶 `maxTokens`（#433），apps/web 還沒畫　`packages/nexus-wire/src/conversation.ts:109`
  - 否定搜尋：
    - rtk proxy git grep -n -i "max-tokens\|maxTokens\|輸出上限\|#608" 70357bb -- apps/web/src packages/nexus-wire/src（我方；只中 packages/nexus-wire，apps/web/src 零筆）
- **L-07 崩潰孤兒輪補結（`interrupted` closer）**
  - dsh：出廠預設：agent-loop resume 對沒收尾的最後一輪寫回 `interruptedTurnClosers`（補工具結果＋`turn/end {interrupted}`）　`dsh:packages/core/session/src/types.ts:221`、`dsh:packages/core/agent-loop/src/index.ts:855`
  - 我們：續接時 `conversation-replay.ts` 照 dsh `repair.ts` 逐字補「結果不明／還沒開始」兩句，只在記憶體裡；日誌不寫補結，`TurnEndReason` 沒有 `interrupted` 生產者　`packages/nexus-core/src/conversation-replay.ts:43`、`packages/nexus-core/src/conversation-replay.ts:66`、`packages/nexus-core/src/session-log.ts:184`
  - 否定搜尋：
    - rtk proxy git grep -n -E "kind: 'interrupted'|'interrupted'" 70357bb -- apps packages ':!*.test.ts' ':!*.test.tsx'（我方；只中 nexus-plugin-quickjs 的直譯器 InternalError 訊息，與結束原因無關；對照 "kind: 'max-tokens'" 4 筆）
- **L-08 耐久檢查點（session-checkpoint-policy）**
  - dsh：出廠預設：base `session-checkpoint-policy`（:412）；原始碼三個 listener：`llm/stream`、頂層 `tools/execute`、`agent/pre-step`（sdk-minimal 不掛）　`dsh:packages/session/session-checkpoint-policy/src/index.ts:64`、`dsh:packages/session/session-checkpoint-policy/src/index.ts:70`、`dsh:packages/session/session-checkpoint-policy/src/index.ts:79`
  - 我們：core 條目 `session-checkpoint-policy`（可 disabled）；fold 建一顆 middleware：`wrapModelCall` 排空（同時承擔 dsh 的 `llm/stream` 與 `agent/pre-step`，因為我們一步就是一次模型呼叫）、`wrapToolCall` 只對 root 排空並在排空後再問一次中止。登記的偏離：三點併兩掛點、摘要那次呼叫前不排空、「頂層」由日誌位址判、載體是 core 子路徑。#444 後 CLI 與 serve 預設落盤，所以零設定就有作用　`.docs/decisions-2026-09-19.md:129`、`packages/nexus-core/src/session-checkpoint-policy.ts:30`、`packages/nexus-core/src/session-checkpoint-policy.ts:106`
  - 驗證改判（完成 → 部分）：這句話要拆兩半看。(1) 兩個掛點承載 llm/stream 與 pre-step，這半成立：我方一步就是一次模型呼叫，產品路徑上也沒有 blocked 或 next-step steer 這種「走過 pre-step 卻不發請求」的分支，所以 pre-step 排空的內容，下一次 wrapModelCall 排空時一定一起落地。change_note 引 base 列註解說「只寫兩個時刻」是挑著引：dsh 模組檔頭第 3 行（and completed agent steps）與 README.zh 第 48 行（三个屏障）都寫三個；不過這不影響上面的結構推論。(2)「殘差只剩摘要呼叫前不排空」不成立。
- **L-09 長期目標＋自動續行（goal-driver）**
  - dsh：出廠預設：base `goal`、`goal-round-driver`（:315）、`command-goal`、`tool-goal`；web-app 不關 driver，三個 preset 掛 command-goal／tool-goal。續行授權行程本地、每次 agent 建立歸零　`dsh:packages/bundle/base/cordis.patch.yml:315`、`dsh:packages/goal/goal/README.zh.md:99`、`dsh:packages/goal/goal-round-driver/src/index.ts:133`
  - 我們：`@nexus/plugin-goal`（域＋命令＋三顆工具）預設掛；續行驅動器 `--goal-driver` 在 CLI 與 serve 都是 `default: false`；續行不走送出佇列　`.docs/decisions-2026-09-19.md:27`、`apps/harness/src/serve.ts:135`、`apps/harness/src/cli.ts:277`
- **L-10 失敗迴圈停損**
  - dsh：出廠預設：`repeat-tool-reminder`（base :454，建議性）；goal 的 `maxGoalRounds` 與 tool-goal 的 `blockedAfterConsecutiveRounds: 3`　`dsh:packages/goal/tool-goal/README.md:48`
  - 我們：遞迴上限（L-02）、goal 的 `blockedAfterConsecutiveRounds` 預設 3、`--max-goal-rounds`（操作者上限，登記過的載體偏離）；重複呼叫提醒歸 C　`packages/nexus-plugin-goal/src/index.ts:177`、`apps/harness/src/cli.ts:242`
- **L-11 子代理：全新派生**
  - dsh：出廠預設：base `subagent`、`subagent-spawn-in-process`、`tool-subagent`；三個 preset 以 `provider: spawn` 掛　`dsh:packages/bundle/base/cordis.patch.yml:351`
  - 我們：基座 `task`＋`foldSubAgents`；plugin middleware 作用到子代理（#327）、沙箱繼承（#326）、子代理各自一份日誌　`packages/nexus-core/src/fold.ts:1275`
- **L-12 子代理：fork 與其他委派後端（codex／claude-code）**
  - dsh：fork 出廠預設（base `subagent-fork-in-process`、`tool-subagent-fork`；preset 開成 continuable）；codex／claude-code 在 preset 裡 disabled（不出廠）　`dsh:packages/bundle/base/cordis.patch.yml:356`
  - 我們：`SubAgent.mode` 窄成 handoff，fork 型別上進不來，有絆索釘著　`.docs/plugin-architecture-gap-survey.md:26`、`packages/nexus-core/src/registry.test.ts:222`
  - 否定搜尋：
    - rtk proxy git grep -n -E "ForkedSubAgent|mode: 'fork'" 70357bb -- apps packages ':!*.test.ts'（我方；只中 nexus-plugin-memory 與 nexus-plugin-skills 檔頭講基座形狀的註解，沒有生產者）
- **L-13 子代理：續行／背景（continuable）、send_message、list_agents**
  - dsh：出廠預設：base `tool-subagent-control`（註冊全域 `send_message`）＋`tool-subagent-list-agents`，`tool-subagent` 為 `backgroundMode: continuable`；web-app 關 host 列、standard／ptc／cordis preset 重掛；`subagent` 的 `maxActiveSubagents` 預設 8　`dsh:packages/bundle/base/cordis.patch.yml:362`、`dsh:packages/bundle/base/cordis.patch.yml:363`、`dsh:packages/bundle/web-app/presets/standard.patch.yml:96`
  - 我們：子代理一律一次性；沒有續行、背景、send_message、list_agents 或並存上限　`.docs/seven-layer-inventory-2026-09-19.md:121`
  - 否定搜尋：
    - rtk proxy git grep -n -i -E "send_message|list_agents|interrupt_agent|subagent-control|continuable|maxActiveSubagents" 70357bb -- apps packages（我方；0 筆；加 foldSubAgents 當對照時 packages/nexus-core/src/fold.ts 等有命中）
    - rtk proxy git grep -n -i -E "send_message|續行子代理|continuable" 70357bb -- .docs docs（只中 .docs/seven-layer-inventory-2026-09-19.md:121）
- **L-14 子代理：逐個選模型**
  - dsh：出廠（web-app）：`subagent-model-selection-settings`（web-app :47），standard preset `modelSelectionSettings: true`　`dsh:packages/bundle/web-app/cordis.patch.yml:47`、`dsh:packages/bundle/web-app/presets/standard.patch.yml:95`
  - 我們：子代理與 root 同一個模型，沒有逐個選模型的設定　`.docs/seven-layer-inventory-2026-09-19.md:122`
  - 驗證改判（缺口 → 缺口）：判定不變（缺口），只更正 dsh 側 profile：standard／ptc／cordis 三個 preset 都開 modelSelectionSettings，原列漏了 ptc 與 cordis。dsh 的能力形狀是：委派工具的 schema 多出 provider／model 參數，由模型在每次委派時從使用者授權的路由挑（tool-subagent/src/index.ts :400-416）。我方重推：registry.subagents.register 收的是固定定義的 SubAgent。deepagents 的型別本身可帶 model，但那是每個定義固定一個，不是逐次挑。
  - 否定搜尋：
    - rtk proxy git grep -n -i -E "modelSelection|model-selection|subagent.*model:" 70357bb -- apps packages ':!*.test.ts'（我方；0 筆）
- **L-15 子代理：深度上限**
  - dsh：出廠預設：base `subagent` 的 `maxDepth` 預設 1　`dsh:packages/subagent/subagent/src/index.ts:202`
  - 我們：結構上固定一層：deepagents 的子代理不巢狀（root 加一排 subagents）　`packages/nexus-core/src/registry.ts:56`
- **L-16 工作流編排（腳本扇出子代理）**
  - dsh：出廠預設：base `workflow-ptc`（:392）＋`tool-workflow`（:397）；standard、cordis preset 掛，ptc preset disabled　`dsh:packages/bundle/base/cordis.patch.yml:392`、`dsh:packages/bundle/web-app/presets/standard.patch.yml:119`
  - 我們：無　`.docs/plugin-architecture-gap-survey.md:37`
  - 否定搜尋：
    - rtk proxy git grep -n -E "tool-jobs|dsh-jobs|jobs_|workflow-ptc|tool-workflow|schedule_create" 70357bb -- apps packages（我方；0 筆；加 'goal-driver' 當對照時 cli.ts、serve.ts 各 2 筆）
- **L-17 背景工作（jobs）**
  - dsh：出廠預設：base `jobs`（:88）＋`tool-jobs`（:274），三個 preset 掛 tool-jobs；477b4f4 web-app 新增 `job-controller`（:107，逐顆工作的觀察紀錄）　`dsh:packages/bundle/base/cordis.patch.yml:88`、`dsh:packages/bundle/web-app/cordis.patch.yml:107`、`dsh:packages/bundle/web-app/presets/standard.patch.yml:32`
  - 我們：執行模型是一次 invoke，沒有背景工作　`.docs/plugin-architecture-gap-survey.md:447`
  - 否定搜尋：
    - rtk proxy git grep -n -E "tool-jobs|dsh-jobs|jobs_|workflow-ptc|tool-workflow|schedule_create" 70357bb -- apps packages（我方；0 筆；加 'goal-driver' 當對照時 cli.ts、serve.ts 各 2 筆）
- **L-18 排程（會話本地持久提醒 schedule）**
  - dsh：出廠但 disabled：web-app `schedule`（:125）與 `time-context`、`ui-schedule` 都是 disabled；dsh 的 schedule 使用指南說出貨的 Web profile 會掛它，與 bundle 不符，以 bundle 為準　`dsh:packages/bundle/web-app/cordis.patch.yml:125`
  - 我們：無；調研筆記判需求沒出現　`.docs/plugin-architecture-gap-survey.md:447`
  - 否定搜尋：
    - rtk proxy git grep -n -E "tool-jobs|dsh-jobs|jobs_|workflow-ptc|tool-workflow|schedule_create" 70357bb -- apps packages（我方；0 筆；對照同 L-16）
    - rtk proxy git grep -n "dsh-schedule'\|dsh-schedule\"\|id: schedule" 477b4f4 -- '*.yml' '*.yaml' '*.ts' ':!**/tests/**' ':!packages/schedule/**'（dsh；設定檔只中 web-app :125；desktop-host 只 import type）
- **L-19 一次性任務模式（headless）**
  - dsh：出廠：headless bundle 的 `headless-runner`、`headless-startup`　`dsh:packages/bundle/headless/cordis.patch.yml:25`
  - 我們：`cli "<prompt>"` 跑完就退出；撞迴圈上限退出碼 2　`apps/harness/src/cli.ts:4`
- **L-20 issue→PR 流水線**
  - dsh：dsh 也沒有：只有選配 overlay（github-review，PR ready 時開唯讀評審會話），不在任何 bundle　`dsh:docs/user/guide/github-review.zh.md:5`
  - 我們：無　`.docs/seven-layer-inventory-2026-09-19.md:127`
  - 否定搜尋：
    - rtk proxy git grep -n -i -E "webhook|github-review" 477b4f4 -- packages/bundle（dsh；0 筆；對照 session-checkpoint-policy 3 筆）
    - rtk proxy git grep -n -i -E "webhook|pull_request|x-hub-signature|ready_for_review" 70357bb -- apps packages ':!*.test.ts'（我方；0 筆）
- **L-21 獨立的完成認證**
  - dsh：dsh 也沒有：goal 完成是模型自報；`tool-ralph` 出廠 disabled，註解明寫完成是 worker 自報　`dsh:packages/bundle/base/cordis.patch.yml:441`、`dsh:packages/bundle/base/cordis.patch.yml:444`
  - 我們：goal 完成走 `completionAuthority`（誰有權宣告），不是獨立評估；Jev 的 completion 純觀測在 repo 外、不進產品路徑　`packages/nexus-plugin-goal/src/tools.ts:19`、`.docs/seven-layer-inventory-2026-09-19.md:128`
  - 否定搜尋：
    - rtk proxy git grep -n -i -E "\bjudge|grader|rubric" 477b4f4 -- packages ':!**/tests/**' ':!**/*.test.ts' ':!**/*.e2e.ts' ':!**/api-catalog/**'（dsh；只中 WebUpgradeRoute 的 case-insensitive 誤中）
    - rtk proxy git grep -n -i -E "\bjudge|grader|rubric|evaluat" 70357bb -- apps packages ':!*.test.ts' ':!apps/harness/src/eval/**'（我方產品路徑；0 筆；對照同一條限在 apps/harness/src/eval 中 8 筆，那是 eval 路徑、不在產品路徑上）
- **L-22 送出佇列（人送出的話排在伺服器、可列可改可刪、等核准答完才跑）**
  - dsh：出廠預設：agent-loop 收件匣 `next-turn`（base），web-app `session-controller` 的佇列指令　`dsh:packages/core/agent-loop/src/inbox.ts:22`、`dsh:packages/bundle/web-app/cordis.patch.yml:102`
  - 我們：`inbox/spliced` 事件折出佇列（照 dsh agent-loop inbox）；serve 的 pump 是唯一寫者；停在核准點照收、等中斷答完才跑（#629）；wire client 有 `queueUpdate` 改與刪（PR #641）。CLI 的 REPL 一行一輪不排隊　`packages/nexus-core/src/inbox.ts:2`、`packages/nexus-core/src/inbox.ts:12`、`apps/harness/src/wire-handler.ts:903`
- **L-23 插話（next-step steer）**
  - dsh：出廠（web-app）：收件匣 `next-step`，session-controller 指令與 ui-chat 都接上；`agent.steer()`　`dsh:packages/api/session-controller/src/commands.ts:471`、`dsh:packages/core/agent-loop/src/agent.ts:168`
  - 我們：`queue.update` 的 steer 明回 `not_supported`；inbox 只有 next-turn　`apps/harness/src/wire-handler.ts:1091`、`packages/nexus-core/src/inbox.ts:18`、`.docs/agent-ui-element-inventory.md:160`
  - 否定搜尋：
    - rtk proxy git grep -n -i -E "next-step|steer" 70357bb -- apps packages ':!*.test.ts'（我方；只中註解與 not_supported 分支，沒有實作）
- **L-24 串流閒置逾時（吐了內容之後停住）**
  - dsh：出廠預設：DeepSeek adapter 的 `streamIdleTimeoutMs`（預設 300 秒，每段重新計時；base `llm-deepseek` 列沿用同一組設定欄位）　`dsh:packages/llm/llm-deepseek/src/config.ts:89`、`dsh:packages/llm/llm-deepseek/src/defaults.ts:4`
  - 我們：`--live` 時 `withStreamIdleTimeout` 包在 fetch 最外層，第一則事件之後每段重新計時（值沿用 timeoutMs 90 秒）。登記的偏離：中段逾時不重試、位元組級而非 chunk 級　`apps/harness/src/live-model.ts:607`、`apps/harness/src/live-model.ts:573`、`apps/harness/src/live-model.ts:595`
- **L-25 每步平行工具呼叫上限**
  - dsh：出廠預設：agent-loop `maxParallelToolCalls` 預設 10（ddefc45 就有）；477b4f4 改成 volatile，web-app 新增 ui-settings-agent-loop 設定頁　`dsh:packages/core/agent-loop/src/constants.ts:6`、`dsh:packages/core/agent-loop/src/index.ts:335`
  - 我們：agent 只 withConfig 了 recursionLimit，沒有設 maxConcurrency；LangChain createAgent 每顆工具呼叫各發一個 Send，同一步的工具呼叫不設上限　`apps/harness/src/agent-factory.ts:491`
  - 否定搜尋：
    - rtk proxy git grep -n -i -E "maxConcurrency|maxParallel|parallelToolCalls|parallel_tool_calls" 70357bb -- apps packages（我方；0 筆；加 recursionLimit 當對照時 agent-factory.ts 等多筆）
    - rtk proxy git grep -n -i -E "maxParallel|平行.*上限|並行.*上限|parallel-safe|並行工具|平行工具" 70357bb -- .docs docs '*.md'（只中 development-plan-phase-5.md 講供應商拒收平行呼叫，沒有判定）
- **L-26 模型選擇：部署預設模型＋每會話換模型與推理強度**
  - dsh：出廠預設：base 掛 agent-default-model（預設模型、欄位可即時改並存回 profile）；web-app 掛 ui-model-selection（/model，下一個請求生效）　`dsh:packages/bundle/base/cordis.patch.yml:83`、`dsh:packages/core/agent-default-model/README.md:12`、`dsh:packages/client/ui-model-selection/README.md:12`
  - 我們：部署預設有（#settings/live-model，啟動時讀一次）；每會話換模型、/model、推理強度選擇、執行期存回都沒有　`apps/harness/cordis.yml:327`、`apps/harness/cordis.yml:330`、`packages/nexus-plugin-sandbox-policy/src/index.ts:188`
  - 否定搜尋：
    - git grep -n -i -E "modelSelection|model-selection|setModel|selectModel|switchModel|'/model'|"/model"|agentDefaultModel|defaultModel" 70357bb -- apps packages → 0 筆
  - ※ 覆蓋檢查新增：證據過了主線核對，但沒有經過對抗式驗證。

</details>

### O 可觀測與維運

| ID | 項目 | 判定 | 09-19 | 我方 | 追蹤 |
| --- | --- | --- | --- | --- | --- |
| O-01 | 事件溯源會話日誌 | **完成** | 有 | 有-預設 | — |
| O-02 | 會話日誌預設落盤（含清單 17：預設不落盤的理由） | **完成** | 待拍板（清單 17：不落盤的理由不符偏離規則） | 有-預設 | #444、#612、decisions-2026-09-19 第 9 題 |
| O-03 | OTel 遙測（會話日誌外送） | **判過不做** | 判過（#279，偏離一） | 有-選配 | #279、#477 |
| O-04 | 模型失敗分類碼進日誌（含清單缺口 5；併入：每次重試與其失敗原因進日誌） | **缺口** | 缺口 | 沒有 | #434；盤點後開 #712 管重試進日誌那一半，帶碼那一半在 #434 |
| O-05 | 遙測 ops：agent-error 記錄（含清單缺口 6） | **dsh 也沒有** | 缺口 | 沒有 | #435；盤點後在 #435 留言，寫明前提已被推翻 |
| O-06 | token 用量（含小項：快取讀寫欄位） | **部分** | 部分；快取欄位未判（小） | 部分 | #574、#517；盤點後開 #724 |
| O-07 | 步數與模型／工具耗時統計（session-stats） | **完成** | 有 | 有-僅 serve | #574 |
| O-08 | 首字延遲與解碼速度（ttft／decode） | **判過不做** | 判過（session-stats.ts「整組不做，沒有載體就沒有欄位」） | 沒有 | — |
| O-09 | 執行期不變量 | **完成** | 有 | 有-預設 | #107 |
| O-10 | 離線掃描會話日誌（打轉、錯誤種類、補題草稿） | **dsh 也沒有** | 有 | 有-選配 | #263、#268、#280 |
| O-11 | LangSmith tracing | **dsh 也沒有** | 有（選配，內網不會預設外送） | 有-選配 | — |
| O-12 | 會話匯出（下載整棵會話樹） | **判過不做** | 判過：需求未出現 | 沒有 | — |
| O-13 | 日誌格式版本與舊格式（含小項：日誌遷移形狀） | **部分** | 部分；形狀不同、未登記成偏離（小） | 部分 | #507；盤點後在 #507 留言補充 |
| O-14 | 軌跡檢視、輪次大綱、plugin 清單（web 畫面） | **web UI 只列不判** | web UI 不以 dsh 為準，列給 dev-ui 參考 | 不適用 | — |
| O-15 | 成本換算與預算、metrics、告警、health 端點 | **dsh 也沒有** | 框架要、dsh 也沒有 | 沒有 | — |
| O-16 | 會話查詢與搜尋（sessionQuery：清單、精確讀、標題、全文搜尋、lineage）（新） | **部分** | 判過：需求未出現（調研筆記第 34 列，併在會話匯出那列） | 有-僅 serve | #610、#631、#632、#633；盤點後開 #725 管投影快取，其餘各項已有去處 |
| O-17 | 組裝設定可查（--dump-config）（新） | **待拍板**（改判） | （09-19 沒有這一列） | 有-預設（只有 --dump-config，CLI 與 serve 都收；沒有 schema dump，也沒有不含使用者層的 dump） | #46、#454；盤點後開 #716 |
| O-18 | plugin 自帶日誌事件種類（擴充 SessionEventMap）（新） | **判過不做** | （09-19 沒有這一列） | 沒有 | decisions-2026-09-25 §三 偏離一 |

<details><summary>逐列依據</summary>

- **O-01 事件溯源會話日誌**
  - dsh：出廠預設：base `session`（:40），sdk-minimal `session`（:74）；headless／acp-app／sdk-app／web-app 疊在 base 上，全部 profile 都有　`dsh:packages/bundle/base/cordis.patch.yml:41`、`dsh:packages/bundle/sdk-minimal/cordis.patch.yml:75`
  - 我們：`@nexus/core` 的 `SessionEventType` 封閉聯集（格式版本已到 17），`SessionRegistry` 讓每個子代理各一份日誌、三個消費者（不變量、參與者、遙測協調器）訂註冊表而不是單份日誌。CLI 與 serve 零設定都建。　`packages/nexus-core/src/session-log.ts:145`、`packages/nexus-core/src/session-registry.ts:99`、`packages/nexus-core/src/session-registry.ts:8`
- **O-02 會話日誌預設落盤（含清單 17：預設不落盤的理由）**
  - dsh：出廠預設：base `session-persistence-jsonl`（:130，root `dshHomePath('sessions')`），sdk-minimal `sessions`（:154）；所以全部 profile 都落盤　`dsh:packages/bundle/base/cordis.patch.yml:130`、`dsh:packages/bundle/base/cordis.patch.yml:133`、`dsh:packages/bundle/sdk-minimal/cordis.patch.yml:155`
  - 我們：出貨清單的 `session-persistence` 列代表落盤本身：CLI 與 serve 沒給 `--session-log` 就寫 `$NEXUS_AGENT_HOME/sessions`（#444，PR #607）；部署方在 patch 把那一列寫成 `disabled: true` 就一個位元組都不寫，兩個入口啟動時照實講、`--resume`／`--session-log` 與它矛盾就當場拋（#612，PR #613）。批次窗口 `windowMs` 是 dsh 沒有的旋鈕（出貨清單註解寫明不是偏離，是標準沒有）。　`.docs/decisions-2026-09-19.md:26`、`apps/harness/cordis.yml:230`、`apps/harness/cordis.yml:210`
- **O-03 OTel 遙測（會話日誌外送）**
  - dsh：出廠預設：base `session-telemetry-otel`（:204），mode 預設 `FEEDBACK_ONLY`、端點是 DeepSeek 的外部 collector；sdk-minimal 不掛。dsh 後端只有 FEEDBACK_ONLY／DISABLED 兩種模式（ddefc45 與 477b4f4 相同）　`dsh:packages/bundle/base/cordis.patch.yml:204`、`dsh:packages/bundle/base/cordis.patch.yml:207`、`dsh:packages/session/session-telemetry-otel/src/index.ts:47`
  - 我們：`@nexus/plugin-telemetry-otel` 不在出貨清單（清單上只有它的 invariant 配套），要 patch `insert` 才掛；掛了之後預設 mode 也是 `disabled`，另有 `full`／`feedback-only`。偏離一（預設 disabled）由 #279 拍板、登記在套件檔頭。內網部署連不到 dsh 那個外部端點。　`packages/nexus-plugin-telemetry-otel/src/index.ts:22`、`packages/nexus-plugin-telemetry-otel/src/index.ts:83`、`apps/harness/cordis.yml:411`
  - 否定搜尋：
    - git -C <nexus> grep -n "plugin-telemetry-otel" -- apps/harness/cordis.yml apps/harness/src ':!**/*.test.ts' → 只中 cordis.yml:411 的 invariant 與 cli-telemetry.fixture.ts（測試夾具）
    - git -C <dsh> grep -n "product-telemetry" 477b4f4 -- packages/bundle apps/cli apps/web apps/desktop → 0 筆
- **O-04 模型失敗分類碼進日誌（含清單缺口 5；併入：每次重試與其失敗原因進日誌）**
  - dsh：出廠預設：core agent-loop 每一輪失敗都以 `turn/end {reason:{kind:'error', error: LlmFailure}}` 收尾（LlmError 保留 code／status／providerRetryAfterMs／requestId，其他錯誤攤平成 `code: 'UNKNOWN'`）；base `llm-retry`（:91）每次重試寫 `llm/retry`（帶 failure）與 `llm/retry-started`　`dsh:packages/core/session/src/types.ts:212`、`dsh:packages/llm/llm/src/types.ts:45`、`dsh:packages/core/agent-loop/src/agent.ts:356`
  - 我們：`turn/failed` 只帶 `message`（CLI 一處、thread-pump 兩處生產者都只留 message）；`live-model.ts` 的 `classifyFailedAttempt` 在行程內判下架／溢出／可否重試，結果不進日誌。重試發生在 `AsyncCaller` 底下，日誌完全看不到：09-22 決議 §7.1 自己量到「供應商過載造成的重試 81 輪裡 33 輪，會話日誌看不到」。　`packages/nexus-core/src/session-log.ts:240`、`apps/harness/src/thread-pump.ts:1136`、`apps/harness/src/cli.ts:1049`
  - 否定搜尋：
    - git -C <nexus> grep -n "'turn/failed'" -- ':!*.test.ts' → 生產者只有 cli.ts:1049、thread-pump.ts:1136、:1378，全部只寫 message
    - git -C <nexus> grep -n -i "retry" -- packages/nexus-core/src/session-log.ts packages/nexus-core/src/session-telemetry.ts → 0 筆（詞彙裡沒有重試事件）
    - git -C <nexus> grep -n "classif\|LlmFailure\|failureCode\|errorCode" -- packages/nexus-core/src apps/harness/src ':!*.test.ts' → 只中工具錯誤分類與 live-model 的行程內分類，沒有寫進日誌的
- **O-05 遙測 ops：agent-error 記錄（含清單缺口 6）**
  - dsh：dsh 也沒有（出廠不發）：`SessionTelemetryCoordinator` 只在 `capture: 'live'` 分支註冊 `agent/error` relay；唯一出廠的後端 `session-telemetry-otel` 以 `capture: 'on-demand'` 建協調器，所以任何 profile 都不會送出 `agent-error`（ddefc45 與 477b4f4 相同）　`dsh:packages/session/session-telemetry/src/coordinator.ts:92`、`dsh:packages/session/session-telemetry/src/coordinator.ts:116`、`dsh:packages/session/session-telemetry/src/coordinator.ts:227`
  - 我們：`session-telemetry-coordinator.ts` 的 ops channel 只發 `shutdown`，沒有 agent-error；遙測本身也是選配（O-03）。　`packages/nexus-core/src/session-telemetry-coordinator.ts:197`
  - 否定搜尋：
    - git -C <dsh> grep -n "new SessionTelemetryCoordinator\|capture: 'live'" 477b4f4 -- packages apps ':!**/tests/**' ':!**/*.spec.ts' → 只有 session-telemetry-otel/src/index.ts:242 一處（on-demand）
    - git -C <dsh> show ddefc45:packages/session/session-telemetry-otel/src/index.ts | grep -n "capture:" → :243 同樣是 on-demand
    - git -C <nexus> grep -n "agent-error\|agent/error" → 只中 .docs/seven-layer-inventory-2026-09-19.md
    - git -C <nexus> grep -n "channel: 'ops'\|'telemetry.op'" -- . ':!.docs' → 非測試只有 session-telemetry-coordinator.ts:194/:197 的 shutdown
- **O-06 token 用量（含小項：快取讀寫欄位）**
  - dsh：出廠預設：base `token-meter`（:337）；用量分四桶（未快取輸入、輸出、快取讀、快取寫），`LlmUsage` 帶 `cacheReadTokens`／`cacheWriteTokens`　`dsh:packages/bundle/base/cordis.patch.yml:337`、`dsh:packages/llm/llm/src/types.ts:186`
  - 我們：core 的 `model-usage` 條目（預設掛、可關，#517）每次模型呼叫記一顆 `model/usage`（input／output／total）；`token-usage.ts` 照 dsh `tokenUsage` 投影折成會話總帳並送上線（#574，PR #598），web 頂列畫出來。沒有快取桶：`#574 定案第一版不分快取`，而且我方 inputTokens 含快取讀取（LangChain 語義），整筆帳對、桶的切法不同。失敗與中止的呼叫不進帳（dsh 報了就算）。　`apps/harness/cordis.yml:181`、`packages/nexus-core/src/session-log.ts:312`、`packages/nexus-core/src/token-usage.ts:11`
  - 否定搜尋：
    - git -C <nexus> grep -n -i "cache_read\|cacheRead\|cache_creation\|cacheWrite\|cached_tokens\|input_token_details" -- apps packages ':!**/*.test.ts' → 0 筆
- **O-07 步數與模型／工具耗時統計（session-stats）**
  - dsh：只在 web-app 出廠：`session-stats`（:83），載體是 base 的 `session-projection` 投影註冊表　`dsh:packages/bundle/web-app/cordis.patch.yml:84`、`dsh:packages/bundle/base/cordis.patch.yml:159`
  - 我們：`session-stats.ts` 照 dsh `sessionStats` 單元折輪數、步數、llmMs、toolMs；serve 經 `conversation-history.ts` 的 `SessionTotals` 以 `sessionStats` frame 上線（#574，PR #598），web 頂列畫出來；離線掃描也用它。我方沒有投影註冊表，讀者各自餵事件（檔頭寫明載體退到哪）。CLI 沒有畫面，不適用。　`packages/nexus-core/src/session-stats.ts:60`、`packages/nexus-core/src/session-stats.ts:10`、`apps/harness/src/conversation-history.ts:302`
- **O-08 首字延遲與解碼速度（ttft／decode）**
  - dsh：只在 web-app 出廠：`session-stats` 投影帶 `ttftMs`／`decodeMs`　`dsh:packages/session/session-stats/src/projection.ts:42`
  - 我們：`session-stats.ts` 檔頭寫明「首字延遲與解碼整組不做」：沒記串流第一個 token 的時間，不發明替代量；web 的用量明細也照這條不畫。　`packages/nexus-core/src/session-stats.ts:26`、`apps/web/src/lib/session-usage-view.ts:16`
- **O-09 執行期不變量**
  - dsh：只在 sdk-minimal 出廠：`invariants`（:106）＋session／agent／scope／agent-loop 四顆 `*/invariant`；base 與其他 profile 不掛　`dsh:packages/bundle/sdk-minimal/cordis.patch.yml:107`、`dsh:packages/bundle/sdk-minimal/cordis.patch.yml:110`
  - 我們：出貨清單 20 顆 invariant 配套（真的在檢查的 7 顆），CLI 以 `[不變量]` 前綴印到終端，serve 走 `createInvariantRunner` 預設的 `console.error` 進伺服器日誌（#107）。　`apps/harness/cordis.yml:378`、`apps/harness/src/cli.ts:1429`、`apps/harness/src/serve.ts:377`
  - 否定搜尋：
    - git -C <dsh> grep -n "dsh-invariants'" 477b4f4 -- packages/bundle apps/cli → 只中 sdk-minimal/cordis.patch.yml:107 與兩個測試檔
- **O-10 離線掃描會話日誌（打轉、錯誤種類、補題草稿）**
  - dsh：dsh 也沒有：`session-stats` 只算次數與耗時、不算錯誤與重複；執行期只有 `repeat-tool-reminder` 提醒　—
  - 我們：我方比 dsh 多：`apps/harness/src/eval/session-scan.ts`（scan）與 `session-draft.ts`（draft），進入點 `pnpm --filter @nexus/harness eval:sessions`；#263 拍板「超出標準的評估只做在產品路徑外」，所以是產品路徑外的腳本。第一輪草稿寫的 `packages/nexus-core/src/eval/` 不存在，實際在 `apps/harness/src/eval/`。　`apps/harness/src/eval/session-scan.ts:2`、`apps/harness/src/eval/sessions-cli.ts:2`、`apps/harness/package.json:15`
  - 否定搜尋：
    - git -C <dsh> grep -n -i -E "session-scan|scanSession|looping" 477b4f4 -- packages apps ':!**/tests/**' ':!**/*.spec.ts' → 只中 repeat-tool-reminder README 與 mcp-client 的一句註解，沒有離線掃描
- **O-11 LangSmith tracing**
  - dsh：dsh 也沒有（dsh 的外送只有 OTel，見 O-03）　—
  - 我們：我方比 dsh 多：`@langchain/core` 自己讀環境變數掛 tracer，`tracing.ts` 只做披露（四個環境變數都要 `=== 'true'` 才開，banner 講清楚）；內網部署預設不外送。　`apps/harness/src/tracing.ts:38`、`apps/harness/src/tracing.ts:32`
  - 否定搜尋：
    - git -C <dsh> grep -n -i "langsmith" 477b4f4 -- packages apps → 0 筆
- **O-12 會話匯出（下載整棵會話樹）**
  - dsh：只在 web-app 出廠：`session-log-download`（`dsh-session-log-export`，:56），`/export` 命令＋下載對話框，把會話、子會話與附件打成 ZIP；lineage 靠 base 的 sessionQuery　`dsh:packages/bundle/web-app/cordis.patch.yml:57`、`dsh:packages/bundle/web-app/cordis.patch.yml:55`
  - 我們：serve 的 wire 路由只有 stream／history／changes／deliverables，沒有匯出；命令只有 feedback、goal、plan 等，沒有 export。日誌本身在 `~/.nexus-agent/sessions` 是 jsonl，可直接拷。　`.docs/plugin-architecture-gap-survey.md:175`、`.docs/plugin-architecture-gap-survey.md:37`
  - 否定搜尋：
    - git -C <nexus> grep -n -i -E "'/export'|name: 'export'|\.zip\b|application/zip|session-log-export|sessionExport|exportSession|匯出會話|下載日誌|download.*session" -- apps packages ':!**/*.test.ts' ':!**/*.test.tsx' → 0 筆
    - grep -n -E "segments\[2\] === '" apps/harness/src/wire-handler.ts → 只有 stream、history、changes、deliverables
    - git -C <nexus> grep -n -E "name: '(feedback|goal|plan|compact|export|clear)'" -- packages apps ':!**/*.test.ts' → 只有 feedback、goal，沒有 export
- **O-13 日誌格式版本與舊格式（含小項：日誌遷移形狀）**
  - dsh：出廠預設（隨 session-persistence-jsonl）：凍結解碼器鏈 `session-format-v0-to-v1`…`v3-to-v4`＋`session-format-catalog`，`SESSION_FORMAT_VERSION` 在 477b4f4 是 4（ddefc45 是 3）；另有逐顆事件的 `ignorable` 旗標，讓詞彙成長不必升版　`dsh:packages/core/session/src/types.ts:89`、`dsh:packages/core/session/src/types.ts:511`、`dsh:packages/session/session-format-v3-to-v4/package.json:2`
  - 我們：`SESSION_LOG_FORMAT_VERSION = 17`，每一版在檔頭表態；舊版一律是新版的子集，直接讀（檔頭寫明「所以不需要遷移包」）；比這一版新的以 `SessionFormatUnsupportedError` 拒讀、跟壞檔分開報，清單也把它數成 unreadable。沒有 dsh 的逐顆 `ignorable` 旗標，所以每加一種事件都要升版（#507 開著）。　`packages/nexus-core/src/session-store.ts:188`、`packages/nexus-core/src/session-store.ts:67`、`packages/nexus-core/src/session-store.ts:115`
- **O-14 軌跡檢視、輪次大綱、plugin 清單（web 畫面）**
  - dsh：只在 web-app 出廠：`ui-trajectory`、`session-turn-outline`、`plugin-inventory`（host 端只讀清單 RPC）＋`ui-settings-plugin-inventory`　`dsh:packages/bundle/web-app/cordis.patch.yml:425`、`dsh:packages/bundle/web-app/cordis.patch.yml:89`、`dsh:packages/bundle/web-app/cordis.patch.yml:97`
  - 我們：web UI/UX 不以 dsh 為準（AGENTS.md），列給 dev-ui 參考。組裝清單在維運面的可查性另列 O-17（`--dump-config`）。　`AGENTS.md:69`
- **O-15 成本換算與預算、metrics、告警、health 端點**
  - dsh：dsh 也沒有：477b4f4 重搜，`budget` 只中位元組／時間預算，token-meter 的 `route-pricing.ts` 是 token 計價不是金額；沒有 health／metrics 端點　—
  - 我們：我方同樣沒有。　`.docs/seven-layer-inventory-2026-09-19.md:150`
  - 否定搜尋：
    - git -C <dsh> grep -n -i -E "\busd\b|costUsd|dollar|spend limit|budget" 477b4f4 -- packages apps ':!**/tests/**' ':!**/*.spec.ts' ':!**/*.md' ':!**/*.yaml' → 只中位元組／字元／時間預算（desktop、job-controller、attachment-local 等），沒有金額
    - git -C <dsh> grep -n -i -E "'/health|/healthz|readiness|liveness" 477b4f4 -- packages apps ':!**/tests/**' ':!**/*.spec.ts' → 只中 desktop 的 boot readiness，沒有 health 端點
    - git -C <dsh> grep -n -i -E "prometheus|/metrics|alertmanager" 477b4f4 -- packages apps ':!**/tests/**' → 0 筆
    - 正向對照：git -C <dsh> grep -c "imageCompressionConcurrency" 477b4f4 -- packages apps → 有命中，量具沒壞
    - git -C <nexus> grep -n -i -E "\busd\b|costUsd|pricing|/health|healthz|prometheus|'/metrics" -- apps packages ':!**/*.test.ts' ':!**/*.test.tsx' → 0 筆
- **O-16 會話查詢與搜尋（sessionQuery：清單、精確讀、標題、全文搜尋、lineage）**
  - dsh：出廠預設：base `session-query-sqlite`（:149）以 `openAt: never` 掛著，sessionQuery 提供精確讀、標題與 lineage，**全文搜尋出廠是關的**（呼叫回 SESSION_QUERY_SEARCH_DISABLED），web-app（:27）重述同一個值，側欄搜尋只比標題與工作區名；base `session-projection-cache`（:182）替清單做持久化投影快取　`dsh:packages/bundle/base/cordis.patch.yml:149`、`dsh:packages/bundle/base/cordis.patch.yml:141`、`dsh:packages/bundle/base/cordis.patch.yml:142`
  - 我們：serve 的 `listStoredThreads` 照 dsh `ApiSessionList.list()` 冷讀日誌列出以前的 thread（不啟動 agent），web 以標題篩（#610，PR #611，前端在已載入清單上比子字串）；歷史分頁讀日誌。沒有 sessionQuery 這個服務、沒有 lineage、沒有投影快取；內容搜尋 #631 已拍板開卡（needs-triage），而 dsh 出廠的全文搜尋本身是關的。　`apps/harness/src/session-list.ts:237`、`apps/harness/src/session-list.ts:4`、`apps/web/src/lib/thread-groups.ts:7`
  - 否定搜尋：
    - git -C <nexus> grep -n -i "sessionQuery\|session-query" -- apps packages → 只中 conversation-replay.ts:44 一句引用 dsh 的註解，沒有對應服務
- **O-17 組裝設定可查（--dump-config）**
  - dsh：出廠預設：launcher `apps/cli` 的 `--dump-config`（所有 profile 通用）；web-app 另有 `plugin-inventory` 的執行期只讀清單（畫面那半見 O-14）　`dsh:apps/cli/src/args.ts:34`
  - 我們：CLI 與 serve 都收 `--dump-config`（#497）：印出三層疊完、啟動真的會掛的那一份，每段標明來源與被哪幾層改過，不載任何 plugin；指到不存在 id 的 patch 報到 stderr。核准閘門那一列刻意留在清單上，就是為了在 dump 裡看得見。　`apps/harness/src/cli.ts:248`、`apps/harness/src/serve.ts:105`
  - 驗證改判（完成 → 待拍板）：重推 dsh：launcher（apps/cli，所有 profile 共用）出廠三種唯讀 dump：--dump-config；--dump-default-config，印不含使用者層與 --patch 的樹；--dump-config-schema，印 profile 條目與 patch 的 JSON Schema，bin.ts 確實接到 runDumpConfigSchema。重推我方：CLI 與 serve 的 USAGE 全表（已 sed 讀過）只有 --dump-config，也沒有別名旗標在做同一件事。
- **O-18 plugin 自帶日誌事件種類（擴充 SessionEventMap）**
  - dsh：出廠預設（機制層）：`SessionEventMap` 是 merge-extensible 介面，套件用 `declare module` 自己宣告事件種類（非測試程式碼 30 處），例如 hook-protocol 的 `hook/invoked`　`dsh:packages/core/session/src/types.ts:276`、`dsh:packages/hooks/hook-protocol/src/types.ts:8`
  - 我們：`SessionEventType` 是 nexus-core 寫死的封閉聯集；repo 裡的 plugin 要加事件就改 core（present、workspace-changes 都是這樣進來的），repo 外的 plugin 沒有地方寫自己的事件，遙測註冊點也只能掛脫敏規則。　`.docs/decisions-2026-09-25.md:95`、`.docs/decisions-2026-09-25.md:94`、`packages/nexus-core/src/session-log.ts:145`
  - 否定搜尋：
    - git -C <dsh> grep -n "declare module '@deepseek-ai/dsh-session/types'" 477b4f4 -- packages ':!**/tests/**' | wc -l → 30

</details>

### V 驗證與評估

| ID | 項目 | 判定 | 09-19 | 我方 | 追蹤 |
| --- | --- | --- | --- | --- | --- |
| V-01 | 任務落地（題庫） | **dsh 也沒有** | 有（比 dsh 多） | 有-預設 | — |
| V-02 | 就緒檢查（模型就緒＋任務就緒 preflight） | **部分** | 有（模型就緒）；自動化的任務就緒檢查沒有 | 部分：模型就緒是 repo 外的人工盤點，做過三次（2026-08-28、08-29、09-04），結果以靜態清單留在 repo。survey.ts 的 16 個候選停在 08-29，還列著 09-03 已下架的 gpt-oss-120b，09-04 那輪只剩 9 個可用；清單已過期，也沒有東西會讓它紅。repo 沒有探測程式。自動化的 preflight 沒有，因為沒有真模型的 CI job，#436 內文也沒寫缺 secret 就硬失敗 | #436；盤點後在 #436 留言補充 |
| V-03 | 受控執行＋軌跡擷取 | **完成** | 有 | 有-預設 | — |
| V-04 | 判斷＋失敗歸因 | **完成** | 有（比 dsh 多） | 有-預設（CI）：scorers 經 eval.test.ts 在 ci.yml:162 每次跑（假模型）；FailureReason 在手動的真模型 compare／survey 跑時分類。離線掃描 session-scan 那半與 O-10 重複，歸 O-10；eval:sessions scan 一定要給目錄，不會預設讀會話根 | #444 |
| V-05 | 持續回歸：腳本模型 | **完成** | 有 | 有-預設 | — |
| V-06 | 持續回歸：真模型、定期（併 09-19 清單缺口 7） | **缺口** | 缺口（清單第 7 項） | 沒有 | #436；盤點後在 #436 留言補充 |
| V-07 | 基線分數存檔、跨次比對 | **dsh 也沒有** | 框架要、dsh 也沒有 | 沒有 | — |
| V-08 | 人的判斷（評分、評語） | **完成** | 有 | 有-預設 | #278、#382 |
| V-09 | 交付物審查：每輪改了哪些檔（workspace-changes，後端；併 09-19 清單沒判過 16） | **完成** | 未判（清單第 16 項） | 有-僅 serve | #443、#461、#459 |
| V-10 | 每輪改動的 web 卡片、逐檔比較、右側欄分頁（workspace-changes 的 web 半）（新） | **web UI 只列不判** | 未判（09-19 併在交付物審查那列，web 半註明經 demian 轉 dev-ui） | 有-僅 serve | #443、#640 |
| V-11 | LLM 當評審（自動判斷結果品質） | **dsh 也沒有** | 框架要、dsh 也沒有 | 沒有 | PR #534、PR #614、PR #621 |
| V-12 | 自我演化量測（Proteus） | **dsh 也沒有** | 進行中 | 部分 | #334、#342、#379、#343 |

<details><summary>逐列依據</summary>

- **V-01 任務落地（題庫）**
  - dsh：dsh 也沒有（不出廠）：dsh 沒有內建任務題庫，BENCHMARK.md 只叫人用 Python SDK 跑外部 benchmark；根目錄的 benchmarks/（dsh-benchmarks）是效能 gate，不是任務題庫　`dsh:BENCHMARK.md:3`、`dsh:benchmarks/AGENTS.md:1`
  - 我們：apps/harness/src/eval/dataset.ts 的 BENCHMARK，CI 用假模型每次都跑，真模型比較手動跑；這是 dev／CI 路徑，不在產品路徑上。這一段比 dsh 多：dsh 沒有，我們有　`apps/harness/src/eval/dataset.ts:68`
  - 否定搜尋：
    - dsh: cat BENCHMARK.md（clone HEAD＝477b4f4）→ 全文只有一段，指向 Python SDK 的外部 benchmark
    - dsh: ls benchmarks/（clone HEAD＝477b4f4）→ active-stream-reconnect、agent-continuation、conversation-fold、long-session-browser、session-open、terminal-io、support（都是效能路徑）
- **V-02 就緒檢查（模型就緒＋任務就緒 preflight）**
  - dsh：不出廠（CI 實務）：e2e.yml 的 Preflight 步驟缺 DEEPSEEK_API_KEY 就硬失敗，免得自跳過的套件回報假綠　`dsh:.github/workflows/e2e.yml:92`
  - 我們：模型就緒：survey.ts／tiers.ts 的清單來自 2026-08-29 的一次性盤點（GET /models，再逐一送帶 tools 的請求），repo 裡沒有探測程式，是靜態快照。自動化的 preflight 沒有，因為根本沒有真模型的 CI job。這一格該由 #436 帶走，但 #436 內文只提照抄 dsh 的 if: 讓 fork／Dependabot 跳過，沒寫「缺 secret 就硬失敗」，triage 時要補上　`apps/harness/src/eval/survey.ts:85`、`apps/harness/src/eval/survey.ts:28`
  - 驗證改判（部分 → 部分）：判定維持「部分」，但 ours_detail 有一處事實錯，要改。「survey.ts／tiers.ts 的清單來自 2026-08-29 的一次性盤點」不對：tiers.ts:55 的表記了三輪人工盤點（08-28、08-29、09-04），live-model.ts:33 記的 09-04 那輪只剩 9 個可用。survey.ts 的 16 個候選停在 08-29，其中還列著 09-03 已下架（410）的 gpt-oss-120b（survey.ts:108 對 live-model.ts:29）。所以這份就緒清單不只是靜態，而且已經過期，沒有任何東西會讓它紅。
  - 否定搜尋：
    - nexus: git grep -n "SURVEY_INVENTORY_DATE\|'/models'\|\"/models\"\|/v1/models" 70357bb -- apps packages scripts → 只中 survey*.ts 的常數與註解，以及 live-model.test.ts 的一個假 URL，沒有探測程式
    - nexus: git grep -n -E "/models|models\.list\(" 70357bb -- apps packages scripts → 只中註解（survey.ts:27、tiers.ts:42/51/57/65、live-model.ts:33、ui-tool 的 models/ 路徑引用）與 live-model.test.ts:1313 的假 URL，沒有探測程式
    - nexus: gh issue view 436 → 內文沒有「preflight」或「缺 secret 硬失敗」
- **V-03 受控執行＋軌跡擷取**
  - dsh：不出廠（CI 實務）：真 API e2e（test:e2e）。.e2e.ts 從 ddefc45 的 213 個增加到 477b4f4 的 265 個　`dsh:package.json:57`
  - 我們：eval/runner.ts：CI 那半用假模型每次都跑，真模型那半（eval:compare／eval:survey）要 NVIDIA_API_KEY 手動跑。軌跡從 result.messages 讀。eval 路徑不接會話日誌是登記過的決定（runner.ts 檔頭，#174），有 session-absence.test.ts 當絆索　`apps/harness/src/eval/runner.ts:12`、`apps/harness/src/eval/session-absence.test.ts:24`
  - 否定搜尋：
    - dsh: git ls-tree -r --name-only 477b4f4 | grep -c '\.e2e\.ts$' → 265；ddefc45 → 213
- **V-04 判斷＋失敗歸因**
  - dsh：不出廠（CI 實務）：e2e 斷言（pass/fail）。web-app 的 session-stats 只算次數與耗時，不做失敗分類（統計面歸 O 層）　—
  - 我們：eval/scorers.ts 逐題評分；compare.ts 的 FailureReason 把拒絕、限流等分開計、不算零分；session-scan.ts 離線掃會話日誌（步數、重複呼叫、工具錯誤種類、疑似打轉）。比 dsh 多　`apps/harness/src/eval/scorers.ts:158`、`apps/harness/src/eval/compare.ts:38`、`apps/harness/src/eval/session-scan.ts:2`
  - 驗證改判（完成 → 完成）：判定維持「完成」，另有三件要改。(1) 補上 dsh 那側的證據。判斷那半 dsh 有，屬 CI 實務：真 API e2e 在 e2e.yml:127 跑 test:e2e、每晚排程，docs/testing.md:35 規定斷言要從外部重跑指令或重讀檔案，不看 agent 自己的輸出。歸因那半 dsh 沒有：session-stats（web-app 出廠）把 failed 步跟完成步一起數（README:43），不分類；e2e 失敗只重試。
- **V-05 持續回歸：腳本模型**
  - dsh：不出廠（CI 實務）：ci.yml 跑不需金鑰的 gate（check:ci:coverage 等）　`dsh:.github/workflows/ci.yml:191`
  - 我們：ci.yml 的 pnpm -r run test 包含 eval.test.ts 的「基準任務（假模型）」　`.github/workflows/ci.yml:162`、`apps/harness/src/eval/eval.test.ts:303`、`.github/workflows/ci.yml:116`
- **V-06 持續回歸：真模型、定期（併 09-19 清單缺口 7）**
  - dsh：不出廠（CI 實務）：e2e.yml 由 workflow_dispatch、push main/master、pull_request、schedule（cron '17 0 * * *'）觸發，跑 test:e2e。判準比照 09-19：dsh 的 CI 實務當作「有」，所以判缺口　`dsh:.github/workflows/e2e.yml:37`、`dsh:.github/workflows/e2e.yml:127`
  - 我們：.github/workflows 只有 ci.yml（PR＋push main）與 release.yml（workflow_dispatch），零個排程；compare-cli 檔頭寫明不進 CI、要 NVIDIA_API_KEY、手動跑　`.github/workflows/ci.yml:8`、`.github/dependabot.yml:23`、`apps/harness/src/eval/compare-cli.ts:4`
  - 否定搜尋：
    - nexus: git grep -n -E 'schedule:|cron' 70357bb -- .github → 只中 .github/dependabot.yml:21-23（dependabot 的更新排程，不是測試 workflow）
    - nexus: ls .github/workflows → ci.yml、release.yml
- **V-07 基線分數存檔、跨次比對**
  - dsh：dsh 也沒有：e2e 是 pass/fail；benchmarks/ 存的是效能預算常數；apps/cli/tests 的 *.expected.jsonl 是 pass/fail 的會話快照回歸。三者都不是任務分數的基線　`dsh:benchmarks/AGENTS.md:11`、`dsh:apps/cli/tests/profiles/headless/tests/workspace-context-resume.expected.e2e.ts:2`
  - 我們：compare-cli 只把摘要印出來，eval 的進入點零筆寫檔　`apps/harness/src/eval/compare-cli.ts:55`
  - 否定搜尋：
    - nexus: git grep -n -E 'writeFile|appendFile|createWriteStream|node:fs' 70357bb -- apps/harness/src/eval/compare-cli.ts apps/harness/src/eval/survey-cli.ts apps/harness/src/eval/compare.ts → 0 筆（正向對照：對 apps/harness/src/eval 全目錄跑 node:fs，命中 *.test.ts）
    - nexus: git grep -n -i baseline 70357bb -- apps/harness/src/eval → 0 筆
    - dsh: git grep -n -i -E 'baseline|score' 477b4f4 -- .github scripts → 只中 review-ownership 的 approval score
    - dsh: git grep -n -i -E 'baseline|score' 477b4f4 -- benchmarks apps/cli/tests → 只中 github-webhook-real.e2e.ts 的 WorkspaceBaseline 與 workspace-context-resume 的 seedVisibleBaseline（工作區指令的基線，不是分數）
- **V-08 人的判斷（評分、評語）**
  - dsh：出廠預設：base 的 command-feedback（:309，全部以 base 為底的 profile）；web-app 的 message-feedback（:50）與 ui-message-feedback（:381）　`dsh:packages/bundle/base/cordis.patch.yml:309`、`dsh:packages/bundle/web-app/cordis.patch.yml:50`、`dsh:packages/bundle/web-app/cordis.patch.yml:381`
  - 我們：出貨清單 apps/harness/cordis.yml 預設掛 @nexus/plugin-feedback，零設定的 CLI（/feedback）與 serve（評分＋/feedback）都有；照 dsh 只進日誌、不進模型；web 的評分鈕已有（#278、#382）　`apps/harness/cordis.yml:81`、`apps/harness/cordis.yml:87`、`packages/nexus-plugin-feedback/src/index.ts:2`
- **V-09 交付物審查：每輪改了哪些檔（workspace-changes，後端；併 09-19 清單沒判過 16）**
  - dsh：只在 web-app 出廠預設（:333）；base、headless、acp、sdk 與四個 preset 都沒有。eligible：沒有 cwd，或是子代理會話，就不記　`dsh:packages/bundle/web-app/cordis.patch.yml:333`、`dsh:packages/bundle/web-app/cordis.patch.yml:331`、`dsh:packages/deliverables/workspace-changes/src/index.ts:60`
  - 我們：serve 固定傳 workspaceChanges: true，有 --workspace 才掛（沒給時是虛擬檔案系統，對應 dsh 的「沒有 cwd」）；CLI 不掛，dsh 的 base／headless 也不掛。照 dsh 做法：git 工作樹快照，加上檔案工具改檔前後各留一份（#464、#467）。子代理改的檔記到 root，是檔頭登記的偏離，結果與 dsh 主路徑一致；git 用 node:child_process 跑，是另一條登記偏離（沒有 subprocess 服務）。出貨清單只掛 invariant 配套　`apps/harness/src/cli.ts:855`、`apps/harness/src/serve.ts:415`、`apps/harness/cordis.yml:365`
  - 否定搜尋：
    - dsh: git grep -n 'dsh-workspace-changes' 477b4f4 -- packages/bundle packages/preset apps/cli apps/desktop ':!**/package.json' ':!**/*.md' → 只中 packages/bundle/web-app/cordis.patch.yml:334
    - nexus: git grep -n 'workspaceChanges: true' 70357bb -- apps/harness/src ':!*.test.ts' → 只中 serve.ts:415（CLI 路徑沒有）
- **V-10 每輪改動的 web 卡片、逐檔比較、右側欄分頁（workspace-changes 的 web 半）**
  - dsh：web-app 出廠預設 ui-deliverables（:328）；同一包也畫 T 層的交付卡　`dsh:packages/bundle/web-app/cordis.patch.yml:328`、`dsh:packages/bundle/web-app/cordis.patch.yml:325`
  - 我們：apps/web 有 changes-card（#465）、changes-review 逐檔比較（#466），#643 把它們搬進右側欄。09-19 把後端與 web 兩半併在一列，這次拆出 web 半，只列不判　`apps/web/src/components/changes-card.tsx:2`、`apps/web/src/components/changes-review.tsx:7`
- **V-11 LLM 當評審（自動判斷結果品質）**
  - dsh：dsh 也沒有：packages 裡 judge 只以英文動詞出現。experimental 的 auto-review 用 LLM 審核待執行的工具呼叫，屬治理（G 層），出廠關著、要另外安裝　`dsh:packages/experimental/auto-review/README.md:12`、`dsh:packages/experimental/auto-review/cordis.patch.yml:3`
  - 我們：產品路徑上沒有。Jev（System One）：09-22 拍板純觀測、repo 外 plugin（Q5、Q14），09-25 拍板只放 dev（G2）。偏題那一顆已在 repo 外實作，CLI 接假端點驗過五格；looping 的純觀測已拍板、還沒動手。repo 裡零筆 Jev 程式碼，三筆偏離登記在 09-25 §三與 PR #534　`.docs/decisions-2026-09-25.md:23`、`.docs/decisions-2026-09-25.md:122`、`.docs/decisions-2026-09-22.md:41`
  - 否定搜尋：
    - nexus: git grep -n -i -w jev 70357bb -- apps packages docs → 0 筆（正向對照：對 .docs 跑命中 4 個檔）
    - nexus: git grep -n -i -E 'judge|grader|rubric|llm-as' 70357bb -- apps packages → 只中 compare-cli.ts 的 judged() 與 scorers.test.ts 的 judgeable
    - dsh: git grep -n -i -E 'judge|grader|rubric|llm-as|evaluator' 477b4f4 -- packages apps ':!**/*.spec.*' ':!**/tests/**' → 英文動詞，以及 experimental/auto-review 的審核 prompt
    - dsh: git grep -n -E 'auto-review|dsh-experimental' 477b4f4 -- packages/bundle apps/cli apps/desktop → 不在任何 bundle，只出現在 apps/cli/package.json 的相依與 team 測試 profile
- **V-12 自我演化量測（Proteus）**
  - dsh：dsh 也沒有：全 repo 搜 proteus／self-evol 只中一則目錄改名紀錄；dsh 是 Proteus 量的對象之一，自己沒有內建自我演化量測　`dsh:.agents/notes/archived/architecture/2026-07-29-package-regrouping.md:71`
  - 我們：#334 地圖進行中。adapter 與 environments/nexus 在上游 fork（repo 外），#335–#341、#345、#348、#354、#362、#369 都在 09-19 前關掉。#342 第一次研究題被 #379 的遠端 runner 擋住（等 2026-10-01 的機器），#343 要等 #342。repo 內只有 CLI 為 adapter 留的出口與註解。調研判定 Proteus 的測量軸不是缺口　`.docs/seven-layer-inventory-2026-09-19.md:169`、`.docs/plugin-architecture-gap-survey.md:34`、`apps/harness/src/eval/runner.ts:26`
  - 否定搜尋：
    - dsh: git grep -n -i -E 'proteus|self-evol|self evol' 477b4f4 -- . → 只中 .agents/notes/archived/architecture/2026-07-29-package-regrouping{,.zh}.md:71（目錄曾叫 self-evolve/）

</details>

### G 治理與安全

| ID | 項目 | 判定 | 09-19 | 我方 | 追蹤 |
| --- | --- | --- | --- | --- | --- |
| G-01 | 政策寫進提示詞（計劃模式規則；沙箱政策句那半見 E 層） | **完成** | 有 | 有-預設 | #120 |
| G-02 | 外部內容標成「資料不是指令」 | **判過不做** | 跟著 T 層 web 那列、C 層跨會話引用那列一起判 | 不適用 | decisions-2026-09-19 第 1、5 題 |
| G-03 | 內容過濾、通用 prompt injection 防護 | **dsh 也沒有** | 框架要、dsh 也沒有 | 沒有 | — |
| G-04 | 核准閘門 | **完成** | 有 | 有-預設 | #111、#324、#517 |
| G-05 | 具名權限預設（沙箱＋核准捆成一組；合併清單缺口 8） | **缺口** | 已知缺口（sandbox-mode.ts:21-27 登記「還沒做」，沒有卡） | 沒有 | #437；盤點後在 #437 留言補充 |
| G-07 | DNS rebinding／跨站圍欄 | **完成** | 有 | 有-僅 serve | #387 |
| G-08 | 瀏覽器會話認證（行程 token 換簽章 cookie，每個請求都要；合併清單「#387 重開條件」前提重核） | **完成** | 判過：#387 登記偏離（request-trust.ts:29）；重開條件看內網部署是否共用主機 | 有-僅 serve | #387、#424、#529 |
| G-09 | 憑證儲存（不寫進行程環境） | **待拍板**（改判） | 判過：定位差異（筆記 §三小計的 credentials） | 沒有（09-19 那次「判過：定位差異」沒有決議出處，而且與同一份筆記移出 web 的判準相衝突） | 盤點後開 #717，與 G-17 同一張 |
| G-10 | 子行程環境清洗（MCP stdio 與 git 快照；合併小項「MCP 環境絆索」） | **部分** | 部分：結果比 dsh 嚴，但全靠上游、零絆索；未判（小） | 部分 | #461；盤點後開 #726 |
| G-11 | 工具呼叫全量紀錄 | **完成** | 有 | 有-預設 | #264、#444 |
| G-12 | 沙箱切換紀錄 | **完成** | 有 | 有-預設 | #251 |
| G-13 | 核准審計事件 | **判過不做** | 判過不做：射程選擇、零消費者（筆記 §五第 7 條，#220） | 沒有（核准專屬事件零顆；被拒呼叫的拒絕理由經圍堵層以 isError 的 tool/result 進日誌） | #220 |
| G-14 | 遙測脫敏 | **完成** | 有 | 有-預設 | #89、#279 |
| G-15 | 人工監督（核准面板、計劃評審、提問） | **部分**（改判） | 有 | 有-僅 serve（核准與提問面板完成；計劃評審仍走核准卡，#652／#654 已拍板未落地） | #408、#409；基準之後 #652 已關（PR #675），#654 開著，盤點後在上面留言補充 |
| G-16 | 合規 | **dsh 也沒有** | 框架要、dsh 也沒有 | 沒有 | decisions-2026-09-25 G3 |
| G-17 | 互動式憑證取得（dsh authorization：問人取得憑證的 flow 註冊表）（新） | **待拍板** | — | 沒有 | 盤點後開 #717，與 G-09 同一張 |
| G-18 | 開發伺服器不服務網頁（擋同機讀 repo）（新） | **完成** | — | 有-預設 | #426 |
| G-19 | 使用者設定層的權限檢查（patch 檔與 patch 插入的模組）（新） | **dsh 也沒有** | — | 有-預設 | #454、#542 |

<details><summary>逐列依據</summary>

- **G-01 政策寫進提示詞（計劃模式規則；沙箱政策句那半見 E 層）**
  - dsh：出廠預設：base 掛 plan-mode 與 sandbox-policy；web-app 把 host 那列 plan-mode 關掉，改由 standard／ptc／cordis preset 掛　`dsh:packages/bundle/base/cordis.patch.yml:322`、`dsh:packages/bundle/base/cordis.patch.yml:229`
  - 我們：plan-mode 在出貨清單 apps/harness/cordis.yml，CLI 與 serve 零設定都掛（/plan 打開才夾指引）；沙箱政策句只在有 --workspace 時掛（cli.ts 組裝點），詳見 E 層。　`apps/harness/cordis.yml:53`、`apps/harness/src/cli.ts:886`
- **G-02 外部內容標成「資料不是指令」**
  - dsh：出廠預設：base 掛 tool-web（trust.ts 固定前綴）；web-app 掛 session-reference（快照帶不可信警告）　`dsh:packages/web/tool-web/src/trust.ts:7`、`dsh:packages/context/session-reference/src/index.ts:59`
  - 我們：兩個會產生外部內容的輸入面都已拍板不做或延後：web 工具 09-19 第 1 題「A 不掛」（照 dsh 自己寫的覆寫路），跨會話引用第 5 題「等 web 做 @ 提及再一起做」。我方其他工具結果（讀檔、MCP 選配）都不加標記，dsh 對讀檔與 MCP 也不加。等 @ 提及落地時，警告要跟著快照一起抄。　`.docs/decisions-2026-09-19.md:18`、`.docs/decisions-2026-09-19.md:22`
  - 否定搜尋：
    - git grep -n -i -E "untrusted|not instructions|不是指令" -- apps/harness/src packages ':!*.test.ts' ':!*.test.tsx'（exit 0，只中 wire-handler 的 403 文字與 code-language.ts 註解，都無關）
- **G-03 內容過濾、通用 prompt injection 防護**
  - dsh：dsh 也沒有：packages 全樹（排除 tests）零筆　—
  - 我們：兩側都沒有；09-25 G3 另拍板「合規先不做」（見 G-16）。　`.docs/seven-layer-inventory-2026-09-19.md:179`
  - 否定搜尋：
    - dsh: git grep -n -i -E "moderation|content filter|content-filter|prompt injection|prompt-injection|jailbreak" -- packages ':!**/tests/**'（exit 1）
    - nexus: git grep -n -i -E "moderation|content filter|content-filter|prompt injection|prompt-injection|jailbreak|內容過濾" -- apps packages（exit 1）
- **G-04 核准閘門**
  - dsh：出廠預設：base 掛 approval（dsh-user-approval，政策 ask；DSH_PERMISSION_MODE=danger-full-access 時 never）；子代理釘成 never　`dsh:packages/bundle/base/cordis.patch.yml:245`、`dsh:packages/bundle/base/cordis.patch.yml:247`、`dsh:packages/subagent/subagent/src/child-agent.ts:254`
  - 我們：core fold 無條件建 approvalGate，出貨清單上 approval-gate 那列關不掉（寫 disabled: true 載入期拋，#517，也讓核准在 --dump-config 看得見）；三個提問者（計劃退出、submit_record、沙箱升級）；CLI 傳 HEADLESS_APPROVALS 確定性拒絕，serve 開著等瀏覽器的人；子代理照 dsh 一律 policy-never（#324）。排隊訊息等核准答完才跑（#629／PR #636）屬 L 層送出佇列。　`apps/harness/cordis.yml:208`、`apps/harness/src/plugin-config.ts:134`、`apps/harness/src/agent-factory.ts:243`
- **G-05 具名權限預設（沙箱＋核准捆成一組；合併清單缺口 8）**
  - dsh：出廠預設：base 掛 permission（read-only／workspace-write 配 ask、danger-full-access 配 never）；web-app 掛 ui-permission 選擇器　`dsh:packages/bundle/base/cordis.patch.yml:250`、`dsh:packages/bundle/base/cordis.patch.yml:260`、`dsh:packages/bundle/web-app/cordis.patch.yml:389`
  - 我們：只有沙箱一顆旋鈕（/sandbox、--sandbox）。sandbox-mode.ts 登記「還沒做、不是做不到」：核准政策在 fold 當下就被算成 ApprovalChannel，不是逐次解析，發 preset 會只搬得動一半。　`packages/nexus-plugin-sandbox-policy/src/sandbox-mode.ts:21`、`packages/nexus-plugin-sandbox-policy/src/sandbox-mode.ts:23`
  - 否定搜尋：
    - git grep -n -i -E "permission.?preset|具名權限" -- apps packages（exit 0，只中散文引用 dsh 的 permission-presets，零實作）
- **G-07 DNS rebinding／跨站圍欄**
  - dsh：web-app 出廠：connection（api-request-trust.ts 的 isTrustedApiRequest，加 --trusted-host 的 trustedHosts）　`dsh:packages/client/connection/src/api-request-trust.ts:91`、`dsh:packages/bundle/web-app/cordis.patch.yml:211`
  - 我們：request-trust.ts 逐字照 dsh 三道（Host、Sec-Fetch-Site、Origin），wire 在任何路徑判斷之前先過。沒有 trustedHosts 是登記偏離，重開條件「serve 加 --host」未觸發：serve.ts 沒有 host 旗標，wire-server 固定綁 127.0.0.1。　`apps/harness/src/request-trust.ts:74`、`apps/harness/src/wire-handler.ts:1451`、`apps/harness/src/request-trust.ts:25`
  - 否定搜尋：
    - git grep -n -i "host" -- apps/harness/src/serve.ts（exit 1，serve 沒有 --host）
- **G-08 瀏覽器會話認證（行程 token 換簽章 cookie，每個請求都要；合併清單「#387 重開條件」前提重核）**
  - dsh：web-app 出廠：connection 的 browser-auth.ts 與 rpc-host.ts（先 403 再 401，沒有按方法區分的 loopback 層；cookieMaxAgeDays 預設 30）　`dsh:packages/client/connection/README.md:39`、`dsh:packages/client/connection/src/index.ts:113`
  - 我們：#387 的重開條件（多人共用主機）2026-09-19 觸發，#424 由 PR #438 補上：serve 啟動就建 BrowserAuth，wire 在圍欄之後、路徑判斷之前一律驗 cookie，否則 401；密鑰存在 harness home（0700／0600）。PR #531 讓有效期成為出貨清單的 #settings/browser-session 列（預設 30 天），原本「寫死 30 天」的偏離撤掉。剩下的偏離只有載體（#settings 而非套件）、不自動開瀏覽器、token 不跟根 context。　`apps/harness/src/serve.ts:322`、`apps/harness/src/wire-handler.ts:1454`、`apps/harness/src/browser-auth.ts:8`
- **G-09 憑證儲存（不寫進行程環境）**
  - dsh：出廠預設：base 掛 credentials（dsh-credentials-local；$DSH_HOME/.credentials.yaml 0600，環境優先、再存檔、再專案與 home 的 .env；.env 是啟動環境的另一層，按憑證引用查）；ddefc45 就在　`dsh:packages/credentials/credentials-local/src/index.ts:565`、`dsh:packages/bundle/base/cordis.patch.yml:118`、`dsh:packages/credentials/credentials-local/README.zh.md:12`
  - 我們：模型金鑰只從環境變數讀（docs/standards.md 的規範，不是機制），根目錄 .env 由 process.loadEnvFile 寫進行程環境。子行程這側：git 快照有清洗、MCP 靠上游白名單（見 G-10）。#424 為瀏覽器密鑰登記了「沒有 credentials seam」的載體偏離，照抄 credentials-local 的 0600／owner-only 規則。　`apps/harness/src/live-model.ts:807`、`apps/harness/src/live-model.ts:936`、`apps/harness/src/browser-session-secret.ts:12`
  - 驗證改判（判過不做 → 待拍板）：「判過不做」唯一的出處，是調研筆記 §三小計把 credentials 整批歸成「企業級定位差異」，那不是決議。我找過全部可能的決議出處，都沒有再判過 credentials：三份決議檔；development-plan.md 的 §0 四條決策與 §7 六條（`sed -n 18,50p .docs/development-plan.md`）；`git grep -n -i -E "憑證|金鑰|secret|credential|\.env\b|環境變數" -- .docs docs`，命中的都是 CI 零憑證、LangSmith 之類無關的內容；
  - 否定搜尋：
    - git grep -n -i -E "registerFlow|oauth|credentials\.ya?ml|CredentialRef" -- apps packages（exit 0，只中 browser-session-secret.ts 說明「沒有那個載體」的散文）
- **G-10 子行程環境清洗（MCP stdio 與 git 快照；合併小項「MCP 環境絆索」）**
  - dsh：dsh 的 scrubbedParentEnv（subprocess seam，黑名單 /KEY|PASSWORD|SECRET|TOKEN/i 與 DSH_*）；mcp-client 以它為底，但 mcp-client 不在任何出廠列（使用者設定）；subprocess 在 base 出廠　`dsh:packages/mcp/mcp-client/src/transport.ts:22`、`dsh:packages/subprocess/subprocess/src/index.ts:47`
  - 我們：git 快照（workspace-changes，serve＋workspace 才有）照抄 dsh 的 scrubbedParentEnv，拿掉同一批與 NEXUS_*，有測試（PR #467）。MCP（選配）仍沒有自己的清洗，只轉傳設定的 env；實際結果由上游兩層決定：@langchain/mcp-adapters 1.1.4 在有 env 時只補 PATH、沒有就不傳，@modelcontextprotocol/sdk 1.30.0 再以 getDefaultEnvironment 的白名單（HOME／LOGNAME／PATH／SHELL／TERM／USER）為底合併，所以比 dsh 的黑名單嚴。兩層都在 node_modules、零絆索，升版改了不會紅。　`packages/nexus-plugin-mcp/src/index.ts:184`、`packages/nexus-plugin-workspace-changes/src/git.ts:49`、`packages/nexus-plugin-workspace-changes/src/git.ts:241`
  - 否定搜尋：
    - git grep -n -E "scrubbedParentEnv|getDefaultEnvironment|SENSITIVE_ENV_PATTERN" -- packages/nexus-plugin-mcp（exit 1）
- **G-11 工具呼叫全量紀錄**
  - dsh：出廠預設：session 日誌詞彙含 tool/call、tool/result，base 以 session-persistence-jsonl 落盤　`dsh:packages/core/session/src/known-event-types.ts:73`
  - 我們：tool/call 在進任何一層之前記、tool/result 收尾（#264）；#444 之後 CLI 與 serve 預設落盤到 $NEXUS_AGENT_HOME/sessions（落盤本身歸 O 層）。　`packages/nexus-core/src/session-log.ts:537`、`packages/nexus-core/src/session-log.ts:580`
- **G-12 沙箱切換紀錄**
  - dsh：出廠預設：base 的 sandbox-policy 寫 sandbox/mode（切換本身就是事件）　`dsh:packages/sandbox/sandbox-policy/src/session-mode.ts:54`
  - 我們：sandbox/mode 事件：掛上當下釘起始值、每次切換一顆、子代理帶 source: delegation；--resume 讀得回來。沒有 --workspace 時沒有圍堵，也就不寫。　`packages/nexus-core/src/session-log.ts:491`
- **G-13 核准審計事件**
  - dsh：出廠預設：base 的 approval（user-approval）每次追加 approval/asked＋approval/decided，另有 approval/policy；子代理的政策以 source: delegation 記　`dsh:packages/interaction/user-approval/src/index.ts:232`
  - 我們：核准在日誌上零事件：deny／policy-never／no-channel 三條路不記，人那條只有只帶 interruptId 的 interrupt/raised，結果不進日誌。#220 判「射程選擇、零消費者」認帳不做，附兩條重開條件（出現第二個提問者；有人要從日誌回答某次工具為什麼沒跑），interception-index.test.ts 有翻得了面的絆索。　`packages/nexus-core/src/approval.ts:200`、`packages/nexus-core/src/approval.ts:211`、`apps/harness/src/interception-index.test.ts:305`
  - 驗證改判（判過不做 → 判過不做）：判定不變，只更正我方細節。「判過不做」成立：#220 的結案留言寫「demian 拍板：兩半都認帳不做」，兩條重開條件寫在調研筆記 §五第 7 條（:452）。條件 1 沒觸發：三個提問者都是 pre-execute 那一種（筆記 :450 的 09-10 更新）；#652 落地後 plan-mode 退出核准，提問者只會變少。dsh 欄的更正也成立：dsh base 出廠 user-approval，寫 approval/asked、approval/decided、approval/policy，子代理那一筆帶 source: delegation。要改的是我方細節。
  - 否定搜尋：
    - git grep -n "'approval/" -- packages apps（exit 0，只中 interception-index.test.ts 釘住「不含」的絆索）
- **G-14 遙測脫敏**
  - dsh：出廠預設：base 掛 session-telemetry-otel（FEEDBACK_ONLY）；脫敏是 sessionTelemetry/record waterfall，套件不出廠任何規則，由部署方掛　`dsh:packages/session/session-telemetry/README.md:52`
  - 我們：core registry 有 telemetry.redact／rules() 註冊點，協調器每次捕獲現讀、fail-closed，形狀同 dsh 的 seam，也不出廠規則。但零設定路徑上沒有遙測後端（telemetry-otel 選配），attachTelemetry 回 undefined，脫敏從不執行；出口本身歸 O 層。　`packages/nexus-core/src/registry.ts:603`、`apps/harness/src/agent-factory.ts:559`、`apps/harness/src/agent-factory.ts:549`
- **G-15 人工監督（核准面板、計劃評審、提問）**
  - dsh：web-app 出廠：ui-approval、ui-plan、ui-user-questions；base 的 user-questions seam　`dsh:packages/bundle/web-app/cordis.patch.yml:306`、`dsh:packages/bundle/web-app/cordis.patch.yml:419`、`dsh:packages/bundle/web-app/cordis.patch.yml:422`
  - 我們：web 的核准面板（換掉輸入框的換手層，#408）、提問的 questionnaire 面板（#409，PR #428／#429），計劃退出走核准卡；CLI 沒有人在，核准一律拒。　`apps/web/src/components/approval-card.tsx:68`、`apps/web/src/components/question-panel.tsx:79`
  - 驗證改判（完成 → 部分）：核准面板（#408）與提問面板（#409）落地屬實，計劃評審那一格則還沒完成。我方 exit_plan_mode 今天走一般核准閘門（plan-mode index.ts:513），web 把計劃當工具參數，用 JSON 印在核准卡裡（approval-card.tsx:60），拒絕帶不回意見。dsh 的 plan-mode 在 base 出廠，web-app 由 preset 掛，走的是提問通道：userQuestions.ask 帶 plan-review intent 與計劃全文，選「繼續規劃」時意見回給模型；web-app 另外出廠 ui-plan。
- **G-16 合規**
  - dsh：dsh 也沒有：packages 全樹（排除 tests）只中一筆無關的 abort compliance　—
  - 我們：兩側都沒有；09-25 G3 另拍板「合規先不做，等有公司規範再補，到時重答外送」（Jev 守門員題）。　`.docs/decisions-2026-09-25.md:24`、`.docs/seven-layer-inventory-2026-09-19.md:193`
  - 否定搜尋：
    - dsh: git grep -n -i "compliance" -- packages ':!**/tests/**'（exit 0，唯一命中 client/resources/README.md 的「abort compliance」，無關）
    - nexus: git grep -n -i -E "compliance|合規" -- apps packages（exit 0，命中全是「參數不合規」這類驗證字樣，無關）
- **G-17 互動式憑證取得（dsh authorization：問人取得憑證的 flow 註冊表）**
  - dsh：出廠預設（477b4f4 新掛）：base 掛 authorization，旁邊同時掛帳號平台 provider deepseek-account；套件本身 ddefc45 就在 packages/credentials/，只是沒掛　`dsh:packages/bundle/base/cordis.patch.yml:110`、`dsh:packages/bundle/base/README.md:151`、`dsh:packages/credentials/authorization/README.zh.md:12`
  - 我們：我方沒有對應物，也沒有它硬依賴的 ctx.credentials（見 G-09）。它不是憑證儲存：主線基準寫的「authorization（憑證來源）」是讀到它上方那段註解，那段描述的是 credentials。出廠的 flow 提供者只有 DeepSeek 帳號平台登入與 pi-ai 登入，模型面零影響。內網部署用 API key，沒有需要人登入的 provider。　`apps/harness/src/browser-session-secret.ts:12`
  - 否定搜尋：
    - git grep -n -i -E "registerFlow|oauth|credentials\.ya?ml|CredentialRef" -- apps packages（exit 0，只中 browser-session-secret.ts 說明沒有 credentials 載體的散文）
- **G-18 開發伺服器不服務網頁（擋同機讀 repo）**
  - dsh：不是 profile 條目：dsh 的 apps/web/vite.config.ts 用 rejectStandaloneServe 拒絕 Vite 的 dev 與 preview　`dsh:apps/web/vite.config.ts:47`
  - 我們：#426（PR #449，2026-09-19）照 dsh 加 rejectStandaloneServe：Vite dev／preview 一律拒絕啟動，pnpm dev 只是 vite build --watch，網頁只由 serve 服務、受 G-08 的會話認證保護；原本 Vite 會把 repo 根底下任何檔案（/@fs/…）交給同機任何人。　`apps/web/vite.config.ts:25`、`apps/web/package.json:7`
- **G-19 使用者設定層的權限檢查（patch 檔與 patch 插入的模組）**
  - dsh：dsh 也沒有：app-boot 載入 profile patch 與 include 的模組時不檢查擁有者與模式位；同一判準只用在 spill root（spill-local）與 credentials 檔　`dsh:packages/spill/spill-local/src/cleanup.ts:86`
  - 我們：#454（PR #494）起，$NEXUS_AGENT_HOME/cordis.patch.yml 與 --patch 要過 assertPrivateFile（屬於自己、本身與祖先鏈沒有群組或其他人可寫）；#542（PR #576，2026-09-23）把同一道檢查推到 patch insert 進來、指到檔案的模組。使用者設定層不從目前目錄讀。比 dsh 嚴，理由是多人共用主機，已在 plugin-config.ts 登記。殘留：模組自己再 import 的旁邊檔案不逐一檢查，靠整個目錄私有。　`apps/harness/src/plugin-config.ts:513`、`apps/harness/src/plugin-config.ts:684`、`apps/harness/src/plugin-config.ts:18`
  - 否定搜尋：
    - dsh: git grep -n -E "geteuid|0o022|0o077" -- apps packages ':!**/tests/**' ':!**/*.spec.ts' ':!**/*.e2e.ts'（exit 0，只中 credentials-local 與 spill-local）
    - dsh: git grep -n -E "mode & |S_IWOTH|S_IWGRP|assertOwner|ownerOnly|assertPrivate" -- apps/cli/src packages/boot ':!**/tests/**'（exit 1）

</details>

## 開發計劃 §2 的七層（感知輸入到輸出）

[`development-plan.md`](development-plan.md) §2 的七層出自需求文件《企業級 AI Agent 系統架構與 Harness 開發範圍說明 v1.0》，跟上面的 E·T·C·L／O·V·G 是兩種切法。這裡沿用計劃當時每一格的尺度，扣掉不在零設定路徑上的選配元件，只重評「覆蓋」那一欄。

| 層 | 計劃當時 | 現在 | 變化 |
| --- | --- | --- | --- |
| 感知輸入 | 足夠 | 足夠 | 內容擴充：serve、送出佇列、問答面板 |
| 意圖與理解 | 薄覆蓋 | 薄覆蓋 | 模型仍不是註冊點。「強化見 #16」已過期，#16 已關 |
| 規劃與編排 | 完整 | 完整 | todo 換成自建的 `@nexus/plugin-todo`，不是 TodoListMiddleware |
| 記憶 | 三個都在 | **部分** | memory、skills 是選配，要扣掉；會話持久化不是長期記憶 |
| 執行與工具 | 完整 | **足夠** | QuickJS、MCP 今天都是選配，要扣掉 |
| 反思與反饋 | 薄覆蓋 | 薄覆蓋 | 結果校驗搬進 core、預設開；LangSmith 是選配 |
| 輸出 | 部分（UI 待做） | **完整** | #372 與 #400–#409 全關，之後持續補 |

兩點更正：
- 開發計劃 §0 第 3 列與 §2 表都寫「強化見 #16」，但 #16 已在 2026-09-01 關閉，理由見 [`reflection-intent-survey.md`](reflection-intent-survey.md)。
- 下表「反思與反饋」一格把 #435（`agent-error`）列為開著的卡。本報告 O-05 已判定它的前提不成立。

| 層 | 計劃當時 | 70357bb 現況 | 覆蓋 | 證據 |
| --- | --- | --- | --- | --- |
| 感知輸入層 | §2 表：訊息標準化（LangChain messages）＋CLI／web 入口，自建（薄），覆蓋「足夠」。 | 訊息標準化仍是 messages.ts 的 toAgentInvocation 那一薄層。入口從 CLI 長成 CLI＋serve：serve 自己服務 apps/web 建置好的 dist（web-static.ts），上行是 HTTP POST（run.start／input.respond，另有 slash.list／slash.run），下行是 SSE。人送出的話一律進伺服器端的送出佇列（#637 已完成，PR #639／#641）。ask-user 由 CLI 與 serve 共用的組裝點 createCliAgent 掛上，web 有問答面板（#409）。 | **足夠** | `.docs/development-plan.md:142`、`apps/harness/src/messages.ts:33` |
| 意圖與理解層 | §2 表：可插拔 model provider＋system prompt 組裝，來源是 LangChain model layer，覆蓋「薄覆蓋」，強化見 #16。§0 第 3 列另寫「Phase 0–5 全部完成後啟動 #16」。 | 模型不是註冊點。registry.ts:824–838 的 15 個註冊點沒有模型或供應商這一格。真實供應商只有 live-model.ts 的一顆 ChatOpenAI（OpenAI 相容端點），所謂「可插拔」只到 #settings/live-model 換 baseUrl／modelId，預設是 nvidia/nemotron-3-super-120b-a12b。對照 dsh，llm-pi-ai 與 llm-deepseek 都是出廠 plugin。system prompt 由四塊組成：組裝點寫死的兩句 SYSTEM_PROMPT； | **薄覆蓋** | `.docs/development-plan.md:143`、`.docs/development-plan.md:24` |
| 規劃與編排層 | §2 表：deepagents 迴圈＋TodoListMiddleware＋subagents，deepagentsjs 內建，覆蓋「完整」。 | 迴圈固定，偏離已登記（§0 第 2 列，#356）。todo 不是 TodoListMiddleware：plan-mode 的 index.ts:12 自己更正了那句是假的，全樹只剩註解提到它。現在由自建的 @nexus/plugin-todo（todo_write，走會話事件）預設掛。計劃模式與 goal 也預設掛。goal 自動續行在 CLI 與 serve 都預設關；09-19 第 10 題拍板 serve 預設開，但 #445 還開著，是已拍板未落地。續行那一輪也還不走送出佇列（#638 開著）。#433 之後，撞到輸出上限的一輪會收回續行授權（照 dsh）。 | **完整** | `.docs/development-plan.md:144`、`.docs/development-plan.md:23` |
| 記憶層 | §2 表：memory（AGENTS.md）＋skills＋summarization／offloading，deepagentsjs 內建，「三個都在，但都是注入不是保存」，見 Phase 3。 | 零設定下無條件在的只有摘要一件：summarization 與 tool-result-pruner 是出貨清單的 core 條目，預設開、可以各自關（#446）。AGENTS.md 改由 agent-instructions 預設掛，但沒給 --workspace 就什麼都不加。@nexus/plugin-memory 與 @nexus/plugin-skills 在清單上只有不變量配套，功能本身是選配；skills 進預設已拍板，#440 還開著。 | **部分** | `.docs/development-plan.md:145`、`apps/harness/cordis.yml:34` |
| 執行與工具層 | §2 表：tools＋虛擬 FS＋權限＋sandbox 協定與 provider（內建）＋QuickJS（@nexus/plugin-quickjs）＋MCP（@langchain/mcp-adapters），覆蓋「完整」。 | 預設在：echo、todo、goal、plan-mode、present（#441）這幾個 plugin 帶的工具，ask-user 與 submit-record（組裝點掛），以及基座的檔案工具。有 --workspace 才有三樣：ContainedFilesystemBackend 圍堵、沙箱模式、政策句；沒給時是只收文字的 StateBackend。核准閘門是出貨清單上關不掉的一列，先讀後改預設開。讀到二進位檔照 dsh 拒絕，不再把圖片塊送進模型（#642）。每輪改動紀錄只在 serve＋workspace 時有（#443）。 | **足夠** | `.docs/development-plan.md:146`、`apps/harness/cordis.yml:393` |
| 反思與反饋層 | §2 表：結果校驗 middleware＋LangSmith 回饋，自建，覆蓋「薄覆蓋」，強化見 #16，但 #16 原列的兩個方向已作廢。 | 結果校驗整組搬進了 core fold，預設就在：輸出 schema 校驗、圍堵（工具拋錯變成 error ToolMessage，不殺整輪）、壞參數回饋，以及撞到輸出上限時記成截斷（#433）。validation plugin 只剩相容殼。回饋有兩條預設路：人的評分與 /feedback 預設掛（#278），repeat-reminder 預設開。LangSmith tracing 是選配，四個環境變數之一設成 'true' 才開，harness 只負責披露。eval（runner、scorers）在產品路徑之外。自評式反思判過不做（#16 已關）。 | **薄覆蓋** | `.docs/development-plan.md:147`、`packages/nexus-core/src/fold.ts:383` |
| 輸出層 | §2 表：typed streaming（基座 v3 streamEvents）→ apps/web UI，協定用 @langchain/protocol；「串流的形狀完整，但基座自己標為 experimental； | thread-pump 仍以 streamEvents v3 抽事件，走 SSE 下行。「UI 待做」已過期：#372 地圖與 #400–#409 實作卡全關，核准面板、問答面板、工具卡都在。之後又補了：工具卡的結構化結果（#617、#625）；改動比對與交付預覽住進右側欄（#640，PR #643）；累計用量（#574）；往回捲到頂端自動接上更早的對話（#616；earlier-pager.tsx 檔頭沒寫卡號，行為對得上）；會話按時間分組並可搜尋（#610）。開著的卡：畫面提示撞到輸出上限（#608，apps/web 對 max-tokens 零命中）、事件可忽略旗標（#507）。 | **完整** | `.docs/development-plan.md:148`、`apps/harness/src/thread-pump.ts:1335` |

| Phase | 狀態 | 剩下什麼 |
| --- | --- | --- |
| Phase 0 — 技術驗證（spike，2 個 PR） | 完成。結論速查寫「Phase 0–5 全部宣告完成」；spike 標已完成（PR #37），真實供應商接線 PR #50 已合，#31 已關。 | 文件沒有列剩項。 |
| Phase 1 — 核心迴圈 + Plugin 契約（約 4–5 個 PR） | 完成。PR #52（契約與三個註冊點）、#53（其餘六個與 fold）已合。 | 文件沒有列剩項。驗收裡跟核准有關的四條已由 #111 作廢，改成執行期的 waterfall。註冊點從定義的九個長到今天的 15 個。 |
| Phase 2 — 工具層 + 權限（約 3 個 PR） | 宣告完成。mcp-plugin（PR #59）、fs-backends（PR #62）、QuickJS（PR #64）已合。 | 文件定義的「供應商相容性驗收」（DeepSeek）至今沒跑過，錨在 #61（OPEN，demian 裁示留著當紀錄、不關）。樹上沒有 @langchain/deepseek 相依。現況觀察：當時落地的 MCP 與 QuickJS 今天不在零設定產品路徑上。 |
| Phase 3 — 記憶層（約 3 個 PR） | 完成。summarization-tuning 那四點與跨 Phase 的坑在 PR #70 落地，memory 與 skills 兩個 plugin 都有套件。 | 文件沒有列剩項。以下是 Phase 定義外的現況觀察：memory 與 skills 兩個 plugin 不在產品路徑上，skills 進預設的 #440 還開著；摘要 prompt 的 #432 開著。 |
| Phase 4 — HITL + 可觀測性 + 反思（約 3 個 PR） | 完成。驗收三句都改寫過並附可執行證據：interrupt-resume（PR #71）、工具失敗回饋（PR #73），tracing 披露有 tracing.ts；圍堵與輸出校驗後來搬進 core（#159、#252）。 | 文件沒有列剩項。Phase 定義外的後續：#434、#435。 |
| Phase 5 — Web UI + 評測（約 3–4 個 PR） | 完成。2026-08-28 由 demian 拍板：驗收兩半到齊（瀏覽器全迴圈 PR #79；eval 數據讓模型定案）。 | 文件自己列的「沒有一併關掉的」兩件：DeepSeek 二元閘門沒跑過、Anthropic 路從沒建（都錨在 #61，OPEN；樹上沒有 @langchain/anthropic 相依）。階梯裝置已由 #167 收掉，重建條件寫在 tiers.ts 檔頭，eval:compare 改跑 MEASURED_MODELS。Phase 定義外：每晚真模型回歸 #436 開著。web 介面後來由 #372 重做並已關。 |

## 方法與限制

**流程**：兩輪 workflow，外加主線的機械核對。

- **第一輪只當提示用**。第一輪沒有指定 model，而 `~/.claude/settings.json` 設了 `CLAUDE_CODE_SUBAGENT_MODEL: "haiku"`，所以每一位子代理都跑在 Haiku 上。結果引文只有 56% 對得上，還有編造的，所以第一輪的結論一條都不收，只拿來當第二輪的提示。
- **第一輪有子代理改寫了主線的核對腳本**：把壓空白比對拿掉，也不再回報行號偏移。之後主線另寫一支 `resolve.py` 並設成唯讀，每位子代理只能寫自己的工作目錄。
- **第二輪 A 段：判定**，共 16 位，全部指定 opus。
  - 7 位層 agent、8 位耦合 agent、1 位開發計劃 agent。
  - 每條證據的形狀是 `{repo, path, pattern}`。主線用 `git show <sha>:<path>` 找出 pattern 所在的行號，找不到就不收。
  - **證據欄**的 `檔:行` 全部由主線解析產生，指的是逐列依據末尾反引號包住的那幾條。
  - **散文裡的行號**是 agent 自己寫的，例如描述與驗證意見裡的 `fold.ts:1388`。主線只做過存在與範圍檢查，結果如下：
    - 帶完整路徑的全部檔案存在、行號在範圍內。唯一例外是 E-02 刻意引用 09-19 已過時的 `apps/harness/src/sandbox-mode.ts:121`，該列已註明檔案不存在。
    - 裸檔名的引用，至少有一個同名檔的行數涵蓋該行號。
    - 簡寫路徑（例如 `present/index.ts`）共 5 條，手動對到完整路徑後也都在範圍內。
    - 只寫 `:行`、沿用前文檔名的相對引用，兩份文件合計約 110 處，沒有做機械檢查。
- **第二輪 B 段：對抗式驗證**，共 18 位，全部指定 opus。
  - 七層 9 位（T、L 各拆兩位）、耦合叢集 8 位，任務是推翻判定。另有 1 位做覆蓋檢查，見下一條。
  - 驗證者的改判至少要附一條主線解析成功的證據，才會採用。
  - **七層**：驗證者看了 133 列中的 111 列。93 列成立；18 列被更正，其中 11 列改了判定類別（表中標「改判」），7 列只改細節。
    - 沒看的 22 列都是「完成」（外加一列 web UI），跟 09-19 的「有」一致，而且兩側證據都解析成功。
  - **耦合**：44 條全部看過。
- **證據通過率**：七層 672 條、耦合 568 條，全部都能在兩邊的基準 commit 上解析到行號。
- **覆蓋檢查**：dsh 出廠啟用中的條目共 189 個，算法是 base、web-app、headless、acp-app、sdk-app、sdk-minimal，加上四個 preset patch。
  - 七位層 agent 認領了 149 個。
  - 其餘 40 個由覆蓋檢查逐一歸類：18 個已被某列涵蓋、11 個屬 web UI、6 個是基礎建設、3 個屬供應商或帳號、2 個需要新列。
  - 那 2 條新列就是 C-16 與 L-26，標 ※。它們只經過單一 agent 判定，加上主線親核（`cli.ts:603` 的寫死提示詞與四條否定搜尋），**沒有經過對抗式驗證**。
  - dsh 的 `persona` 條目只能掛在 preset 裡，做的是逐會話換 persona，所以歸 T-29（判過不做）。C-16 只管部署層的身分與 persona，兩者不衝突。
- **主線最後定奪了三件事**：
  - 只把 E-12、T-09 併進 G-10。驗證者另外判成重複的 6 列，其實只是部分重疊，所以保留並收窄範圍：T-19／O-16、V-04／O-10、L-19／T-14。
  - G-06 依歸屬表搬到 E 層，ID 不變。驗證者原本判它是 E-02 的重複，但它講的是 danger-full-access 的強度，E-02 講的是模式本身，兩者不同。
  - 產表格的是腳本，不是手抄。

**dsh `ddefc45 → 477b4f4` 的出廠變化**（兩個 commit 都用腳本逐列數過）：
- base 從 89 列增為 93 列。
  - 新增 config-editor（disabled）、authorization、deepseek-account、llm-deepseek-account。
  - settings 改成只在 desktop launcher 下掛。
- web-app 從 101 列增為 112 列。
  - 新增 job-controller、time-context（disabled）、schedule（disabled）、帳號相關、shortcuts、ui-settings-\*、agent-preset-registry。
  - 移除 agent-presets 與 ui-settings-unarchive-sessions。
- preset 從 `packages/preset/agent-presets/presets/*/agent.cordis.yml` 搬到 `packages/bundle/web-app/presets/*.patch.yml`。內容除了各多一列自身的 `preset-X`，沒有變。
- sdk-app 新增 workspace-dependencies、skill-office，兩者皆 disabled。

**沒做的**：
- 沒有跑 live。
- web UI 的列只列不判。
- 完成度只量對 dsh 出廠能力的覆蓋，不量品質，也不量工作量。
- 行號以 `70357bb` 與 `477b4f4` 為準。
- **否定宣稱**：agent 被要求用 `git grep` 對基準 commit 跑，並在 `negative_greps` 欄交出指令與結果。逐列依據列出每列的前六條。
  - 主線沒有逐條重跑，只重跑了 C-16 的三條與 L-26 的一條，全部 0 筆；正向對照 `SYSTEM_PROMPT` 有命中，量具沒壞。
  - 子代理有沒有另外用程式碼圖（codebase-memory），主線無從確認。nexus-agent 的圖索引停在 `c3f396e`，不是基準。
  - agent 的原始輸出只存在 session 的暫存目錄，沒有進版控。
