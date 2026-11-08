# 核心底座改 Rust 的重評：組合層的終點放哪一種語言（2026-11-08）

依據：
- demian 2026-11-08 在 dev-rs session 交辦：拿他 2026-11-06 給的兩份 artifact，重評「核心底座改 Rust」。兩份都是 demian 帳號下的 claude.ai artifact，repo 讀不到。11-06 的 `.docs/leaf-runtime-eval-2026-11-06.md`（以下稱「葉子行程評估」，#2487）只評了縮小版，明寫不評整包採用 ADR（該檔 §一末段）。
  - ADR-001「Rust 底座加 TS plugin 的 harness 架構」（以下稱 ADR）。
  - 「Agent Harness 設計選項比較」（以下稱「比較文件」）。葉子行程評估沒有把它列進依據，只在 §七寫了讀過其中與 Cordis、Rust、行程切分有關的段落。
- #1827 的 D149、D166、D235（原文在 #1827 正文，D235 的題目與拍板在 issuecomment-6680044274、6680138624）。
- #1948 正文〈已拍板〉（Q14、Q17、Q21）與偏離表。
- `.docs/agent-loop-off-langchain-design-2026-11-03.md`（以下稱「#2336 設計」）§五、§八。
- #1947 issuecomment-6601117039（C0 的量測）。

讀的版本：

| 對象 | 版本 | 怎麼確認 |
| --- | --- | --- |
| nexus | `origin/develop` `7392e602` | 2026-11-08 `git fetch` 後開分支 |
| ADR | rev 13 | 用 docs 工具讀全文。11-06 讀到的也是 rev 13 |
| 比較文件 | rev 99 | 11-06 讀到的是 rev 95（dev-rs 本機證據檔 `opt-95.txt` 的首行）。兩版抽成純文字後逐行 diff：差異是照 ASD-STE100 重寫措辭，例如「100 輪硬停」改成「100 輪時強制停止」；兩版的數字逐一比對，除了版本號與「ASD-STE100」以外相同，42 個標題相同 |
| dsh | 本機 clone，引用一律 `git show 05b1cae8:` | clone 的工作目錄已在 `fcc0ad46`，本篇不用 |
| rutis | 本機 clone `921892d9`（2026-10-31），主 crate `crates/rutis/Cargo.toml` 是 0.19.2 | 葉子行程評估讀的是上游 `3f87e6b1`（用 `gh api`）；本篇只讀本機，沒有對新版重核 |

本篇沒有下載任何東西，沒有打模型端點，沒有量測。數字是 `git ls-files` 加 `wc -l` 算的，見附錄。

## 結論

| 問題 | 答案 |
| --- | --- |
| 「核心底座改 Rust」已經拍板了嗎 | **一半**。#1948 已拍「底座用 Rust 重寫」（Q14、Q17），範圍是主機級的樹：MCP、模型並行上限、沙箱、TS 插件的版本登記（Q21）。agent loop、會話日誌、政策、prompt 組裝與壓縮，不在這個範圍內（§一） |
| D235 有沒有定組合層用什麼語言 | **沒有**。R1 寫「組合層（loop、日誌、政策）在主機」，定的是放在主機級、不放對話行程；沒定放哪個行程、用哪一種語言（§一） |
| ADR 怎麼定 | 宿主是 Rust，裡面有內核、事件 log、agent loop、政策 hook、指令執行、LLM adapter 與閘道。TS 只放工具、第三方整合、常改的 plugin（§二） |
| dsh、rutis 怎麼定 | dsh：loop 是 TS 插件，沒有特權內核。rutis：loop 收斂前留 TS，收斂後由 Rust 那一份長成引擎；其餘按「鏽化判據」逐塊搬（§二） |
| 有沒有 nexus 自己量到的依據 | **有一條，加一條推論**。C0 量到前台只做轉送時，每輪 CPU 是 serve 的 13.2%；推算 60–110 條同時串流吃滿一顆核，低於容量約 155 條。組合層放進共用的 Node 行程會更早撞到這條線，這一步是推論，沒量過（§三） |
| 建議 | **Q1 是**：組合層的終點放在一個 Rust 宿主行程，而且不是監督行程。**Q2 是**：照 ADR 自己的「移動規則」逐塊搬，不一次重寫。**Q3 是**：第一塊搬事件 log 與政策 hook，loop 最後搬。**Q4 是**：維持 D235 R3，rutis 不當依賴。見 §六 |
| #2336 會不會白做 | **不會**（§五） |

## 一、已拍板的 Rust 範圍，跟 ADR 的宿主清單對照

ADR 的宿主清單（ADR〈元件切分〉表）逐項對到 nexus 今天的拍板：

| ADR 放在 Rust 的元件 | nexus 的拍板 | 狀態 |
| --- | --- | --- |
| 內核：生命週期、服務、事件、可撤銷的 effect | #1948：主機級的樹用 Rust 自寫核心（Q14、Q17、偏離 #8） | 已拍，未做（#1948 OPEN） |
| sandbox、工具子行程的起動 | #1946 沙箱執行器已關；`native/sandbox-spawner` | 已做，只在 Linux（`native/sandbox-spawner/README.md:3`） |
| 憑證代理 | nexus 沒有：`git grep -nIlE '憑證代理\|credential[- ]proxy\|credentialProxy' 7392e602` 只命中本檔 | **沒有拍板** |
| 監督（崩潰重啟、資源） | #1947 監督行程，C2b #2340 已關 | 做到一半（#1947 OPEN） |
| 模型並行上限 | #1948（偏離 #6） | 已拍，未做 |
| session 事件 log | 會話日誌在 TS：`packages/nexus-core/src/session-log.ts`、`session-store.ts` | **沒有拍板** |
| agent loop、prompt 組裝、壓縮 | #2336 改成 nexus 自己的 TS loop（D167、D168） | **沒有拍板**用什麼語言當終點 |
| 政策 hook（approval、迴圈偵測、sandbox 政策） | 在 TS 插件與 `nexus-core` 的 `approval.ts`、`approval-policy.ts`、`tool-pipeline.ts` | **沒有拍板** |
| LLM adapter | TS；ADR 自己也列為開放問題 | **沒有拍板** |
| 閘道（跨邊界的代理、取消、逾時、trace） | 監督行程的控制通道（前台與對話行程的 stdin／stdout，`native/sandbox-spawner/src/supervisor_protocol.rs`）只管行程生死與統計；對話資料不經監督行程，前台直接連對話行程的 socket（`supervisor/mod.rs:3`） | **沒有拍板** |

ADR 清單上有六項，nexus 沒有拍過要用 Rust。D235 R1 把其中三項（loop、日誌、政策）定成「在主機」。

在 `--process-model per-thread` 下（只在 Linux 起得來，`apps/harness/src/process-launcher.ts:377`；預設是 `single`，同檔 `:6`），主機級有兩個行程：
- Rust 監督行程；
- Node 前台：程式碼已由 #2512 合進來，由它收 HTTP 再轉送到對話行程。C3 #2341 這張卡還沒關。

葉子行程評估 §一的表格，「agent loop」那一列只寫了「主機」。所以 R1 定的是「放主機級、不放對話行程」，沒定放哪個行程、用哪一種語言。

## 二、四方怎麼做

**dsh（`05b1cae8`）**
- 產品每一部分都是插件，包括模型適配器、工具註冊表、會話日誌與 agent loop（`docs/architecture.zh.md:9`）。
- 沒有特權內核，擴充靠把插件掛在旁邊（`docs/architecture.zh.md:11`）。
- 它在解決的問題：每一塊都能從設定替換。代價：所有東西在同一個 TS 行程裡，一個插件把行程弄掛，所有對話一起停（葉子行程評估 §二）。
- 0.2.2-alpha.3（根 `package.json:3`），不收外部 PR（`CONTRIBUTING.md:9`）。ADR 拿這兩點當作不採用「全 TS」的理由之一，本篇核過屬實。

**rutis（本機 `921892d9`）**
- 雙核永久：Rust 是脊柱，TS 跑完整的 dsh 棧，包括 agent loop（`docs/design-dual-core-2026-08-20.md:11-14`）。
- 2026-08-21 的修訂：loop 尚未收斂，按判據留 TS，不急著鏽化（同檔 `:6-7`、`:40-43`）。
- 但 Rust 那邊留著一份最小的 loop（rutis-agent），定位之一是「loop 收斂後長成引擎的種子」（同檔 `:19-21`）；下一步的第 ③ 步，就是讓它從基線長成引擎（同檔 `:34-36`）。
- 鏽化判據：語意已收斂、是機制而非措辭、對效能或分發敏感、不綁 npm、或在信任邊界上（同檔 `:28-30`）。
- 「不做」清單有一條：loop 還沒收斂時，不在 Rust 裡複刻它，因為雙份實作等於把追趕成本搬到自己身上（同檔 `:22-24`）。

**ADR**
- 宿主是 Rust，內含 loop、事件 log、政策 hook、LLM adapter（ADR〈名詞〉「宿主」、〈元件切分〉表）。
- 移動規則：TS plugin 成為熱路徑時移到 Rust；移動時不可改變服務名與方法形狀；用 trace 統計判斷，不憑經驗（ADR〈移動規則〉）。
- 跨邊界只用 emit 與 parallel，waterfall 只在 Rust 裡跑（ADR〈跨邊界契約〉「事件」列）。

**比較文件**
- 五款 harness 裡只有 Codex 是「Rust CLI + App Server」（〈並列比較表／架構與執行〉）。Codex 的 loop 在不在 Rust 裡，比較文件沒寫，本篇也沒查。
- 跟本題有關的建議：用 append-only 的 typed event log 當唯一的權威來源，context、UI、稽核都從 log 產生（〈決策表〉「狀態的權威來源」列）。
- 規則必須寫在程式裡，不能只寫在指令裡（〈三條跨維度原則〉）。

ADR 和 rutis 在「loop 最後放 Rust」這件事上方向相同，差在時機：
- ADR 一開始就把 loop 放進 Rust 宿主；
- rutis 等 loop 收斂之後才搬。rutis 的 loop 是 dsh 的，它不想去追別人的變動。

nexus 的情況介於兩者之間：
- #2336 做完以後，loop 是 nexus 自己寫的，沒有上游要追；
- 但 K12 #2362 把 native loop 改成預設之前，它還沒收斂。

## 三、nexus 自己的條件

**1. 多人共用主機，組合層是共用的。** 葉子行程把 loop 從每條對話的行程搬到主機級，那一份要同時服務所有對話。容量照 Q6b（#1827 D166），64 GiB 的主機約 155 條。

**2. Node 的單一事件迴圈。** C0（#1947 issuecomment-6601117039）量的是前台只做轉送的情況：
- 每輪 CPU 是 serve 的 13.2%；
- 推算 60–110 條同時串流吃滿一顆核。這是推論，不是實測滿載。

組合層要做的事比轉送多：推導訊息、組 prompt、壓縮、跑政策。所以組合層放進一個共用的 Node 行程，推論會比轉送更早撞到這條線，但沒量過。要繞開，就得開多個 Node worker 分攤對話，等於再加一層行程切分。

**3. 一份組合層出錯，影響所有對話。** 共用的組合層崩潰時，所有對話一起停。ADR 把它放 Rust 的理由是「每次呼叫都會執行、而且出錯代價高的元件，放在 Rust」（ADR〈元件切分〉切分原則）。這條理由在多人共用主機上比在單人桌機上更成立，這是本篇的判斷。

**4. 不能放進監督行程。** 監督行程是嚴格單執行緒：子行程的 `PR_SET_PDEATHSIG` 看的是起它的那條執行緒，所以不能在監督行程裡起執行緒（`native/sandbox-spawner/src/supervisor/mod.rs:5`）。另外，監督行程一死，對話行程會靠 `PR_SET_PDEATHSIG` 一起被殺（`native/sandbox-spawner/README.md:41`）。

把組合層塞進監督行程，有兩個後果：
- 監督行程要做的事變多，它的爆炸半徑也跟著變大；
- 單執行緒也一樣會撞到 §三-2 那條線。

所以 Rust 宿主要是監督行程以外的另一個行程。

**5. 稽核。** 稽核是 nexus 的產品需求（AGENTS.md〈技術實現標準〉第 2 步）。下面三者說的是同一件事：
- ADR 的「可驗證性」限制：模型收到的每個輸入都必須能從事件 log 重建；
- 比較文件的「事件 log 是唯一權威來源」；
- nexus 的稽核需求。

事件 log 放在 Rust 宿主時，對話行程崩潰也不會帶走寫入者。前提是 §三-4：Rust 宿主不是對話行程，也不是監督行程。

**6. 要搬的量**（`7392e602`，算法見附錄）：

| 範圍 | 檔數 | 行數 |
| --- | --- | --- |
| `packages/nexus-core/src`，不含測試、夾具、vitest 設定 | — | 43,615 |
| 其中 `native-loop/`（只排除 `*.test.ts`） | 8 | 2,168 |
| 現有的 Rust：`native/*/src`，不含檔尾的 `#[cfg(test)]` 模組 | — | 約 3,972 |

`nexus-core` 不全是組合層：它也有 registry、fold、投影與工具結果處理。所以 4.4 萬行是上限。最大的幾個檔（`git ls-tree -l 7392e602`）：

| 檔 | 大小 |
| --- | --- |
| `session-log.ts` | 166.7 KiB |
| `summarization.ts` | 127.3 KiB |
| `fold.ts` | 121.8 KiB |
| `registry.ts` | 110.8 KiB |
| `session-store.ts` | 87.3 KiB |

一次重寫的話，上限是現有 Rust 量的約 11 倍，而且重寫期間 TS 那一份還在改。rutis 說的「雙份實作的追趕成本」就是這個。插件留在 TS，不算在裡面。

**7. 攔截鏈。** 在 `7392e602` 重數，掛在 waterfall 上、會改寫或擋下的插件套件共 10 個：

| 掛法 | 插件套件與位置 |
| --- | --- |
| `agentLoop.preStep` | agent-instructions `src/index.ts:375`、permission-presets `src/index.ts:244`、skills `src/invocation.ts:104`、time-context `src/index.ts:476` |
| `registry.middleware.use` | plan-mode `src/index.ts:763` |
| `registry.events.on('tools/execute'\|'tools/pre-execute')`，帶 `next` | sandbox-policy `src/index.ts:315`、workspace-changes `src/index.ts:391`、`:397` |
| `gate`（tools/pre-execute） | mcp `src/index.ts:329`、`:501`；submit-record `src/index.ts:330` |
| `onResult` | present `src/index.ts:469` |

數法：`git grep -nE "events\.on\(|middleware\.use\(|preStep\(|\.gate\(|\.onResult\(" 7392e602 -- 'packages/nexus-plugin-*/src/*.ts'`，排除測試檔與註解行，再逐行看過。只會發通知、不改寫的 `events.on`（例如 workspace-changes `:403` 的 `agent/turn-stopping`）不算。

ADR 規定 waterfall 只在 Rust 裡跑。所以 loop 搬到 Rust 時，這 10 個要麼搬進 Rust，要麼改寫成按名字呼叫的 RPC。只要組合層不在對話行程裡，不管選哪一種語言都躲不掉。

## 四、選項與比較

- **P1 一次重寫**：組合層（事件 log、loop、政策、LLM adapter、閘道）一次搬進 Rust 宿主。照 ADR 的終態，不照它的移動規則。
- **P2 組合層留 TS**：組合層放在主機級的 Node 行程（前台，或另一個共用行程），Rust 只做底座。照 rutis 的現階段。
- **P3 終點 Rust、逐塊搬**：終點同 P1；搬法照 ADR〈移動規則〉加上 rutis 的鏽化判據，一次一塊，服務名與方法形狀不變。#2336 先做完，產出 TS 版的服務形狀。

| 標準 | P1 一次重寫 | P2 組合層留 TS | P3 終點 Rust、逐塊搬 |
| --- | --- | --- | --- |
| 正確性 | 組合語意只有一份，在 Rust；但重寫期間 TS 那份還在動，兩份要對齊 | 一份，在 TS；靠測試與規範維持 | 每搬一塊，那一塊的語意只剩 Rust 一份；沒搬的照舊 |
| 失敗與恢復 | 共用的組合層在 Rust 行程，崩潰機率較低（推論） | 共用的 Node 行程崩潰，所有對話一起停 | 事件 log 先搬，紀錄先交給 Rust 行程寫；loop 最後搬 |
| 效能 | 前提是 Rust 宿主多執行緒，才沒有單一事件迴圈的上限（推論；監督行程本身是單執行緒） | 撞 §三-2 那條線（推論）| 同 P1 的前提；loop 搬之前，loop 仍在對話行程，不撞那條線 |
| 維護成本 | 最高：組合層上限約 4.4 萬行，加 10 個攔截插件同時重寫，兩份並存到切換為止 | 最低：一種語言 | 中：每次只有一塊有兩份，搬完就刪 |
| 產品需求（多人共用、稽核、內網、公務機關） | 最合 | 稽核可做；共用行程的爆炸半徑大 | 合；稽核那一塊（事件 log）最先到位 |
| 現有基座做不做得到 | 做不到：loop 還沒脫離 LangChain（#2336 OPEN） | 做得到 | 第一塊要等 §五說的落盤格式升版落地 |

**選 P3。**
- 比 P1 好在兩點：不用同時維護兩份完整的組合層；而且每一步都能退回，這是 rutis〈決策〉第 1 條的做法（`docs/design-dual-core-2026-08-20.md:14`）。
- 比 P2 好在三點：效能上的單一事件迴圈上限；共用行程的爆炸半徑；稽核。
- P3 輸 P2 的地方是語言邊界：多一份跨邊界契約，除錯更難，ADR〈後果〉也列了。在多人共用主機上，這個代價換得到的東西比較多。
- rutis 的路線（loop 收斂後才長成 Rust 引擎）也是 P3 的形狀，只是它的 loop 不是自己的。

## 五、#2336 會不會白做

不會，理由有三：
1. ADR 的移動規則要求搬的時候「不可改變服務名與方法形狀」。#2336 定的就是這些形狀：
   - nexus 自己的訊息型別：K2 #2350，已關；
   - `@nexus/tools` 2.0：K3a #2351，已關；
   - middleware 遷成事件與服務：K7 #2357，未關。

   沒有這一步，Rust 那邊沒有東西可以對齊。
2. rutis 不在 Rust 裡複刻還沒收斂的 loop。nexus 的 loop 也還沒收斂：K12 #2362（未關）才會把 native loop 改成預設。
3. #2336 設計 §八的清單（六類 JS 函式、四種不可序列化的物件），就是 P3 每一塊要處理的邊界清單。

會連動的只有一件事：事件 log 要寫成換一個寫入者也能讀。D168 Q4 定的那次落盤格式升版（#2336 設計 §五的 F2–F4，排在 K7 #2357），HEAD 還沒落地：`SESSION_LOG_FORMAT_VERSION` 是 54（`packages/nexus-core/src/session-store.ts:673`）。落地之後，它就是 one-way 的落盤格式。本篇沒有找到要改它的理由。

## 六、要 demian 決定的四題

| # | 問題 | 推薦 | 理由 |
| --- | --- | --- | --- |
| Q1 | D235 R1 的「組合層在主機」，補寫成「在一個 Rust 宿主行程，不是監督行程，也不是 Node 前台」？ | **是** | §三的 2–5：單一事件迴圈的上限（推論）；共用組合層的爆炸半徑；監督行程是單執行緒，死了會帶走對話行程；稽核要一個不跟著對話行程崩潰的寫入者 |
| Q2 | 搬法照 P3：終點 Rust，逐塊搬，服務名與方法形狀不變，不一次重寫？ | **是** | §四：P1 要同時維護兩份組合層，上限約 4.4 萬行；rutis 的追趕成本 |
| Q3 | 第一塊搬事件 log 與政策 hook，loop 最後搬？ | **是** | 政策 hook 就是信任邊界，rutis 判據裡最硬的一條，它舉的例子是 sandbox。事件 log 是稽核的唯一來源，本篇把它歸成同一類，這個歸類是本篇自己的。loop 要等 #2336 與 K12 收斂 |
| Q4 | D235 R3（rutis 不當依賴）維持？ | **是** | 本機 clone 的主 crate 是 0.19.2，ADR 寫 0.21.0，都還在 0.x；公務機關客戶有來源審查；#1948 已定自寫核心 |

Q1 答「是」時：
- D149「對話樹維持 TS」照舊是過渡做法；
- 形狀 B 與 #1947–#1949 不用改，D235 R2「排在 #2336 之後」也不變；
- 改的只有 D235 R1 那一句的寫法。之後另開卡，把主機級 Rust 的範圍擴到事件 log；#1948 正文不改。

Q1 答「否」時：組合層的語言留到 #2336 做完、dev-rs 重評時再定（#1827 正文已有的條件句），本篇當作那次重評的輸入。

不論 Q1 怎麼答，現在都不動產品碼：Q3 的第一塊要等 §五說的落盤格式升版落地。

## 七、沒讀、沒量、沒核的

- ADR 的 4 張嵌入圖，這次也沒讀。
- 比較文件只讀了重點摘要、各家版本、架構表、決策表、跨維度原則與結論；權限、子代理、eval 的細表沒讀。
- Codex 的 loop 在不在 Rust 裡，沒查。
- C0 的「60–110 條吃滿一核」是推算；組合層放進共用 Node 行程的 CPU 沒量過；多執行緒 Rust 宿主的成本沒量過。
- 本機 rutis clone 停在 `921892d9`，沒更新；ADR 寫的 0.21.0 沒核。
- Rust 的行數用「檔尾第一個 `#[cfg(test)]` 之後都算測試」粗算，沒逐檔確認測試模組都在檔尾。

## 附錄：規模的算法

```
# origin/develop 7392e602
git ls-files 'packages/nexus-core/src*' | grep -E '\.ts$' \
  | grep -vE '\.(test|spec)\.ts$|/measure/|/__tests__/|fixture|vitest\.config|\.test\.helper' \
  | xargs cat | wc -l                                   # 43615
git ls-files 'packages/nexus-core/src/native-loop*' | grep -E '\.ts$' \
  | grep -vE '\.(test|spec)\.ts$' | xargs cat | wc -l    # 2168
for f in $(git ls-files 'native/*/src/*.rs' 'native/*/src/**/*.rs' | sort -u); do
  awk '/^#\[cfg\(test\)\]/{exit} {n++} END{print n+0}' "$f"
done | paste -sd+ - | bc                                 # 3972
git ls-tree -l 7392e602 packages/nexus-core/src/        # 檔案大小
```

輸出存在 dev-rs 本機的 `~/.nexus-agent-evidence/2026-11-08/core-base-rust-reeval/`。
