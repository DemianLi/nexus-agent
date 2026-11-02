# nexus 對研究藍圖量測紀律的現況對照（2026-10-04）

研究票 [#995](https://github.com/DemianLi/nexus-agent/issues/995)，母地圖 [#994](https://github.com/DemianLi/nexus-agent/issues/994)。

**問題**：藍圖（`.docs/chat-agent-research/blueprint.md`）第 3 節的七條量測規則，加上 T7、T8 稽核後仍是 A 級的九張卡（T7-01、T7-02、T7-03、T7-06、T7-08、T8-02、T8-03、T8-04、T8-06），nexus 現在各做到哪裡？

**對照版本**：develop `5949288`（2026-10-04）。藍圖的規則在 `blueprint.md:107-155`，九張卡在 `blueprint.md:831-895`（T7）與 `blueprint.md:934-989`（T8）。等級以該檔標題為準。

**這份只記現況，不判斷該不該做**；那是 #994 後面那張對談票的事。缺口欄寫的是「沒做到什麼」，不是「應該做什麼」。藍圖自己寫明，套用到 nexus 時 AGENTS.md 的 dsh 做法優先（`blueprint.md:5`）。這份也不對照 dsh，三方對照是 #994 的下一步。

## 怎麼讀

每一列的「現況」先標一個狀態，再寫細節：

- **【程式】**：程式碼、測試或 CI 本身就在做，每次跑都會發生。
- **【做過一次】**：有人手動跑過、數字記在 issue、PR 或 `.docs`，程式碼裡沒有對應的機制。重跑要靠人。
- **【決定不做／暫緩】**：有拍板過的決定，寫明不接或延後。
- **【做過但被取代／收掉】**：曾經做過或建過，後來被另一個機制頂替，或因問題結案而拆掉。跟「沒人做」分開記；表後有一節集中列出。
- **【掃過沒找到】**：照「掃描方法」那一節列的形狀找過，沒有找到。這不等於「沒有」，可能漏的地方寫在盲區。
- **【沒有對象】**：這條規則要量的東西（例如 LLM 評審、使用者模擬器）在 nexus 裡本身就不存在，所以談不上做沒做。

證據欄的 `檔案:行號` 都對 `5949288`。`#數字` 是 GitHub 的 issue 或 PR。

## 名詞

- **基準任務**：`apps/harness/src/eval/dataset.ts:68-168` 那七題（`BENCHMARK`），三題易、四題難（`dataset.ts:177-183`）。
- **評分器**：`apps/harness/src/eval/scorers.ts`，四個指標：工具呼叫成功率、參數正確性、多叫次數、回覆提到；token 另列，不算分數（`scorers.ts:124-134`）。
- **CI 那半**：`eval.test.ts` 用腳本假模型（`ScriptedChatModel`）跑同一份題目，零憑證（`eval.test.ts:1-6`）。
- **連外那半**：`eval:compare` 與 `eval:survey`，要 `NVIDIA_API_KEY`、手動跑，不進 CI（`compare-cli.ts:4-5`、`survey-cli.ts:11-13`）。
- **Jev 量測**：2026-09-22 與 09-25 兩批，對一顆外部的判斷模型做的有標註量測。plugin 在 repo 外，原始資料與腳本不進版控，數字只留在 `.docs/decisions-2026-09-22.md`（`:5-8`）。

## 對照表

| 規則或卡號 | nexus 現況 | 證據（檔案:行號） | 沒做到的缺口 |
| --- | --- | --- | --- |
| **規則 1**：每個分數旁並列不需要模型的平凡基準 | **【做過一次】** Jev 量測的每個數字都配一條「多數類猜到底」的基線（looping 82%、completion 80%、progress 73%、waiting 100%）。<br>**基準任務【掃過沒找到】**：沒有任何不需要模型的平凡 agent 跑過七題。手邊有三樣形狀相近、但用途不同的東西：<br>① 判準對照 `SCORER_CONTROL`：一顆真模型（11B），用來證明評分器量得出 1.00 以下，不是地板。<br>② CI 的兩份壞腳本 `SABOTEUR`、`RESTLESS`：各只用在一題，證明評分器會扣分。<br>③ 「只講話不動手是零分」：單題測試。 | `.docs/decisions-2026-09-22.md:15-17`、`:61-66`<br>`apps/harness/src/eval/tiers.ts:105-122`<br>`apps/harness/src/eval/eval.test.ts:162-191`、`:334-372`<br>`apps/harness/src/eval/compare.test.ts:75` | 什麼都不做、亂吐、隨機這三種平凡 agent 都沒跑過基準任務，也沒有逐類並列在 `eval:compare`／`eval:survey` 的報表上。<br>本調查實算（見「本調查實算」一節）：一個與題目無關的固定亂吐 agent，工具成功率與回覆提到這兩欄，各自在有可判的六題上都拿 1.00。兩欄的六題不是同一組：工具成功率少的是 `no-tool-needed`，回覆提到少的是 `echo-then-write`。<br>Jev 那次的基線數字留在文件裡，資料不在 repo。 |
| **規則 2**：介入閘門兩個方向的錯分開量；準確度之外要量接上後的淨效益 | **【做過一次】** 只在 Jev 量測：<br>• looping 依門檻 N 報準確率，並寫明「每一個 N 的漏報都是 0，錯全在誤報那一側」。<br>• completion 報 0.9 門檻的精確率 1/1、召回 1/1，同時註明 n=1。<br>• 2026-09-23～25 的加速實驗：開跑前寫死閘門（首可見中位至少省 500ms，且品質零退步），27 題 × 3 次對照組，三個接線位置量完淨效益，全部 no-go。<br>**【做過一次】** 模型可用性探測：量到一次探測會誤判（兩個瞬時失敗重探 3/3 全過），之後改成重探三次。<br>**產品路徑上的閘門【掃過沒找到】誤報或漏報的量測**：<br>• 重複呼叫提醒器的門檻 `[3, 5, 8]` 逐格照抄 dsh。<br>• 離線掃描的「疑似打轉」沿用提醒器那份「同工具同參數連續」判法。<br>**【做過但被取代／收掉】（只在量測裡）** Jev 量測 §3.1 的舊標籤 maxRun 是「連續同鍵最長串」，漏掉一次真打轉（31 次呼叫，maxRun 只有 2），量測裡改用「失敗的變更呼叫次數 ≥ N」。`session-scan.ts` 仍用同鍵連續判法。**待驗**：maxRun 的「鍵」是不是同一份 `repeatCallKey`，標籤抽取器在 repo 外，查不到。 | `.docs/decisions-2026-09-22.md:71-77`、`:81-87`、`:212-248`<br>`.docs/model-inventory.md:298-310`<br>`packages/nexus-core/src/repeat-reminder.ts:112-114`<br>`apps/harness/src/eval/session-scan.ts:15-18`、`:44-48`、`:299-311`、`:339` | 提醒器門檻、`session-scan` 的打轉旗標、goal 太早報 blocked 時的阻擋（錯誤碼 `GOAL_TOOL_BLOCK_THRESHOLD`，`packages/nexus-plugin-goal/src/tools.ts:387`；門檻值本身沒讀）、限流分類 `isRetryableRateLimit`：都沒有在含成功與失敗兩類樣本的集合上分方向量過。<br>Jev 量測的標籤與資料不在 repo，重跑不了。 |
| **規則 3**：判分用的資訊不能進迴圈；產生行為的一方不能同時判分 | **【程式】** 期望答案只給評分器；受測 agent 只拿到題目那句話。評分器是規則式程式碼，不是會跟受測者一起更新的模型。<br>**【做過一次】** Jev 量測自己抓到一處洩漏：窄投影把正解逐字寫進送給判斷模型的狀態，那格 100% 註明不算數。<br>**在同一份題庫上挑設定**（藍圖 F2 的定義也算這個），記事實不判斷：<br>• 預設模型是在同一份七題上決選出來的，測試還要求預設 id 必須出自量過的清單。<br>• `EVAL_RECURSION_LIMIT = 40` 與 300 秒時鐘，是照同一份題庫的實測分佈挑的。<br>• 四條難題是看了 #84 的結果才加的。<br>題庫沒有另外切出「挑設定用」與「報成績用」兩份。<br>#343 計劃把這份基準包成 Proteus `accept_reject` 唯一的挑選依據，還沒動工（被 #342 擋）。 | `apps/harness/src/eval/runner.ts:145-148`<br>`.docs/decisions-2026-09-22.md:68-69`<br>`.docs/model-inventory.md:351-375`<br>`apps/harness/src/live-model.test.ts:84-93`<br>`apps/harness/src/eval/tiers.ts:130-134`<br>`apps/harness/src/eval/compare.ts:72-93`<br>`apps/harness/src/eval/dataset.ts:46-56`<br>#343 內文 | 挑設定與報成績共用同一份七題；用到的結果沒有另外標成「上限」。<br>#343 內文的挑選用評估器，與今天 `eval:compare` 用的是同一份七題；#343 沒寫成績要怎麼報。 |
| **規則 4**：固定並記錄設定，自己重算 | **【程式】** 部分：<br>• `eval:compare`／`eval:survey` 開跑時在終端印出模型 id、題數、取樣數、迴圈上限、時鐘上限。<br>• `eval:survey` 另印盤點日期；每個量過的模型帶 `measuredOn` 日期。<br>• 連外那半只換模型 id，其餘連線設定用 schema 預設。<br>• 所有比較都經同一份 `compareTiers`＋`summarize`，沒有拿別人自報的數字比。<br>• 會話日誌帶格式版本，`session-scan` 依版本把沒記的欄位印成「—」而不是 0。 | `apps/harness/src/eval/compare-cli.ts:164-172`、`:136-140`<br>`apps/harness/src/eval/survey-cli.ts:151-163`<br>`apps/harness/src/eval/tiers.ts:92-102`<br>`apps/harness/src/eval/session-scan.ts:51-61` | 結果旁沒有 commit SHA、題庫版本、評分程式版本或取樣溫度。溫度只出現在說明與註解裡：`compare-cli.ts:40`，以及 `live-model.ts:922-923` 的 `temperature: 1`／`topP: 0.95`。<br>結果只印在終端，不落檔（本次重掃 0 筆），事後重算不了。<br>印出來的設定自相矛盾：`compare-cli.ts:170` 印「約 (40−2)/2 = 19 輪」，`compare.ts:75-80` 寫明每輪三格，所以是 13 輪。 |
| **規則 5**：只讀終態或最終答案的判準，要另外量漏掉多少 | **【程式】** 評分器讀的是兩樣東西：工具呼叫序列（名字的子序列＋資料集列出的參數鍵）與最終回覆的子字串。它**不讀**虛擬檔案系統的終態，所以算是「過程＋最終答案」的判準。<br>它也不看工具結果成敗：runner 只收 AI 訊息裡的 `tool_calls`。<br>**【決定不做／暫緩】** eval 路徑刻意不接會話日誌，有絆索測試守著。<br>**產品日誌那側【程式】**：`eval:sessions scan` 報工具錯誤（依碼）、疑似打轉、中止、點踩；`draft` 撈出負向輪交人補答案。這些是過程訊號，但沒有跟哪一次「判成功」配對。 | `apps/harness/src/eval/runner.ts:106-109`、`:156-182`、`:12-35`<br>`apps/harness/src/eval/scorers.ts:33-45`、`:117-122`<br>`apps/harness/src/eval/session-absence.test.ts:24`<br>`apps/harness/src/eval/session-scan.ts:165-195`<br>`apps/harness/src/eval/session-draft.ts:5-12` | 沒有量「判成功、但過程違反」的比例。<br>沒有回歸檢查，也沒有事先寫好的禁止事件清單。<br>dsh 那條「從外面重讀檔案或重跑指令來斷言」的做法記在 #436（2026-09-26 留言），#436 已拍板暫緩。 |
| **規則 6**：模擬使用者是共用量具 | **【沒有對象】** 掃過沒找到使用者模擬器。<br>`ScriptedChatModel` 假的是**模型**，不是使用者。基準任務每題只有一句話、單輪。goal driver 的續行輪是 agent 自己的迴圈，不是模擬使用者。<br>Jev 那 44 輪是跑 live 自主迴圈產生的真日誌，題組由一個人寫，文件自己註明了這件事。 | `apps/harness/src/eval/eval.test.ts:4-6`<br>`apps/harness/src/eval/dataset.ts:26-38`<br>`.docs/decisions-2026-09-22.md:44`、`:139-141` | 沒有多輪、以使用者回應推進的評估形狀，這條規則在 nexus 目前沒有可套的對象。 |
| **規則 7**：重跑與不確定度；成本一起報 | **【程式】**<br>• `--samples` 收得下重複次數（預設 1）；n=1 時報表印「指示性，不是定論」。<br>• `eval:survey` 每一欄都帶 n。<br>• 彙總是平均＋全距（最小到最大）。<br>• token 與秒數跟分數並列。<br>• 失敗分五類，不平均成零分。<br>**【做過一次】**<br>• #86：n=6 的表，作者寫明差異「踩在兩次觀測上」，不下判決。<br>• #85：294 次執行，3 次取樣。<br>• ds-pro 拉開間隔重跑：11/21 → 21/21。<br>• 2026-09-04 決選：4 個模型 × 7 題 × 3 次 = 84 次。難題參數 0.98（n=9）對 0.92–0.93，據此換掉預設模型。 | `apps/harness/src/eval/compare.ts:120-133`、`:352-358`、`:389-420`、`:37-70`<br>`apps/harness/src/eval/compare-cli.ts:176-178`、`:79-82`<br>`apps/harness/src/eval/survey-cli.ts:55-70`<br>PR #86 內文「讀法要說準」那段<br>`.docs/model-inventory.md:204-229`、`:351-375` | 全距是把「不同題目」與「同題重跑」混在一起算的（`compare.ts:400-417` 對所有評到分的執行取最小與最大），不是重跑變異。<br>沒有標準差、沒有以題目為單位重抽的區間；決選那個差距沒有附任何區間。<br>成本只算評到分的執行（`compare.ts:338-349`、`:400`），失敗那幾次的 token 不進帳；也沒有美元（#85 留言：端點不回報計價）。<br>沒有同預算的簡單基線（重試、多數決）。 |
| **T7-01**（A）：判定器上線前，跑三個平凡 agent 並雙向人工重判 | 平凡 agent 那半同規則 1：**【掃過沒找到】**。<br>人工重判那半**【掃過沒找到】**。最接近的是 PR #86 的四條突變測試：證明評分器邏輯在合成輸入上會扣分。那是程式正確性，不是誤判率。<br>`eval:sessions draft` 是交人「造題」（補 `expected`），不是「重判」評分器的判定。 | `apps/harness/src/eval/tiers.ts:105-122`<br>PR #86「四條新絆索反向驗過」表<br>`apps/harness/src/eval/session-draft.ts:5-12` | 什麼都不做、第一步就放棄、把資料全吐出來，三個平凡 agent 都沒跑。<br>沒有從「判成功」與「判失敗」兩批各抽樣交人工重判。<br>次要項「標準解必過、不作為必敗」：只有單題的負對照，沒有逐題的標準解必過檢查。 |
| **T7-02**（A）：評審對人的一致率怎麼量 | **【沒有對象】** nexus 的產品與 eval 裡沒有 LLM 評審。七層盤點 V-11 已判「dsh 也沒有」；本次重掃 `judge`、`grader`、`rubric`、`評審` 等，在 `apps`、`packages` 只中無關的變數名。<br>**【做過一次】** 最接近的是 Jev（repo 外的判斷模型）對代理標籤的量測：報正解分佈、多數類基準與兩種投影的準確率，標籤是「從日誌導出＋手檢驗尺規」。 | `.docs/seven-layer-inventory-2026-09-26.md:845`、`:902-909`<br>`apps/harness/src/eval/compare-cli.ts:97`、`apps/harness/src/eval/scorers.test.ts:208`（重掃命中的無關變數名）<br>`.docs/decisions-2026-09-22.md:44-51`、`:61-66` | 沒有評審可量。<br>Jev 那次有多數類基準，但沒有機會校正後的值（κ）、沒有區間，也沒有人對人一致率；人類參照是代理標籤，不是獨立的人工判定。 |
| **T7-03**（A）：成對比較的評審要逐題交換位置 | **【沒有對象】** 掃過沒找到成對比較的評審（`pairwise`、`成對`、`position bias`、`對調` 等）。命中的「對調」都是測試裡對調程式順序的突變，與評審無關。 | 見「掃描方法」 | 無（沒有成對比較的評審）。 |
| **T7-06**（A）：跑幾次、區間怎麼算 | 同規則 7：**【程式】** 有重複取樣，報平均＋全距；**【做過一次】** 每題 3 次是 #85 與決選實際用的取樣數。 | `apps/harness/src/eval/compare.ts:120-124`、`:352-358`<br>`apps/harness/src/eval/cli-args.ts:37-47`<br>`.docs/model-inventory.md:351-355` | 沒有報「一題換算成幾個百分點」。本調查算：難題參數那欄 n=9 次執行，單一執行從 1.00 掉到 0，平均只動 1/9 ≈ 0.11。<br>沒有重跑標準差，也沒有以題目重抽的區間。<br>「差距小於雜訊就不下結論」只在 #86 由人寫進讀法，程式不做。 |
| **T7-08**（A）：只看終態的判定器另外量漏掉多少 | 同規則 5。**【程式】** 評分器本身讀過程（呼叫序列），不是只讀終態。<br>**【決定不做／暫緩】** eval 路徑不接會話日誌，所以軌跡只有 `result.messages`。真模型冒煙回歸（#436）拍板暫緩。 | `apps/harness/src/eval/runner.ts:12-35`、`:156-182`<br>#436 決定（2026-09-26） | 沒有對「判成功」的樣本另跑回歸檢查或禁止事件檢查，「終態通過但違反」的比例沒有量過。 |
| **T8-02**（A）：不要只用四種寬鬆判準 | **【程式】** 逐項對照：<br>① 只比一個終態：不適用，評分器不讀終態。<br>② 子字串比對：**是**。「回覆提到」用 `includes`，`no-tool-needed` 的期望是回覆裡出現 `'7'`。<br>③ 只算該做的有沒有做（召回）：**是**。工具成功率＝對上幾筆 ÷ 期望幾筆，名字子序列比對，多叫不扣（多叫另成一欄）。參數只比資料集列出的鍵。<br>④ 只跑部分測試：不適用。<br>不該被動到的狀態：沒有檢查。<br>報表把四欄並列，所以亂吐在「參數正確性」（0）與「多叫次數」兩欄看得出來。 | `apps/harness/src/eval/scorers.ts:117-122`、`:33-45`、`:58-76`、`:87-109`<br>`apps/harness/src/eval/dataset.ts:17-22`、`:162-166`<br>`apps/harness/src/eval/compare-cli.ts:68-76` | 子字串比對與只算召回這兩種仍在。<br>沒有一個把四欄合起來的「這題成功」判準。<br>沒有量過收緊判準後偽陰性會怎麼變；也沒跑亂吐 agent 對照（本調查實算見下一節）。 |
| **T8-03**（A）：判準誤判要分方向、分難度量 | 基準任務的評分器**【掃過沒找到】**與人工標註的對照。<br>**【做過一次】** Jev 量測分方向報（漏報 0、錯在誤報側；completion 精確率與召回各 1/1，註明 n=1）。<br>**【做過一次】** 可用性探測的誤判：重探三次分出瞬時與持續。 | `.docs/decisions-2026-09-22.md:76-77`、`:81-87`<br>`.docs/model-inventory.md:298-310` | 評分器兩個方向的誤判率、依難度分層、只驗一個方向時的上界，都沒有。 |
| **T8-04**（A）：同名指標不能直接拿別人自報的比 | **【程式】** 沒有跨系統比較；所有數字出自自己同一份評分程式。決選明寫「跟 `eval:survey` 同一套」。<br>每個量過的模型帶日期與一行摘要，報表與文件一再註明「數字綁在帳號與日期上」。 | `.docs/model-inventory.md:353-355`<br>`apps/harness/src/eval/tiers.ts:92-102`<br>`apps/harness/src/eval/survey-cli.ts:157-159` | 分數旁沒有評分程式版本與題庫版本。題庫在 #86 從三題變七題，同名的「參數正確性」跨這次改動指的是不同的題組，只能靠人記。<br>步數上限與溫度沒有跟著結果存下來（見規則 4）。 |
| **T8-06**（A）：誤差棒、配對檢定與題數 | **【掃過沒找到】** 標準誤、群集標準誤、McNemar 檢定、檢定力分析（掃過的形狀見下）。<br>**【程式】** 彙總用的是全距，也就是這張卡明寫不要拿來當誤差棒的 min–max。 | `apps/harness/src/eval/compare.ts:352-358`、`:427-438`<br>`apps/harness/src/eval/compare.test.ts:388` | 兩個模型跑同一組題時，沒有逐題配對比較。<br>沒有事先算這組題能偵測多小的差距。<br>誤差棒沒寫明是對題目算還是對重跑算（目前兩者混在一起）。 |

## 本調查實算：基準任務的平凡地板

**這一節是本調查自己算的，不是 nexus 的現況。** 做法：直接拿 nexus 的評分器（`scoreCase`，純函式），餵兩個不需要模型的合成執行；不經過 agent，也不改 nexus 任何檔。腳本留在 session 暫存目錄，不進版控。

- **什麼都不做**：不叫工具、不說話。有可判的格子全是 0（工具成功率與參數正確性在克制題沒有可判的，回覆提到在 `echo-then-write` 沒有要求），多叫次數全是 0。
- **亂吐**：每題送出同一串與題目無關的工具呼叫（`echo, write_file, write_file, read_file, edit_file, write_file, grep`，參數全空），回覆固定是把七題要求的字串串起來：`接線測試 第二次 第二版：接線測試 tnega-suxen /b.md 7`。結果：
  - 工具成功率：六題都是 **1.00**（克制題沒有可判的）。
  - 回覆提到：有要求的六題都是 **1.00**。
  - 參數正確性：六題都是 **0**。
  - 多叫次數：每題 4–7 次。

換句話說，這份評分器在「工具成功率」與「回覆提到」兩欄對亂吐沒有地板保護；擋住亂吐的是另外兩欄。這與 T8-02 的「只算召回」「子字串比對」兩項對得上。真的 agent 送出空參數的呼叫時工具會失敗，但評分器不看工具結果（`runner.ts:159-164`），所以分數不變。

## 做過但被取代／收掉的

這一節跟「沒人做」分開記。下面幾樣都曾經存在或做過，後來被另一個機制頂替，或因問題結案而拆掉：

- **尺寸階梯（規則 7、T7-06 的重跑對照）**：`tiers.ts` 原本是兩道同家族尺寸階梯，2026-09-05 在 #167 收掉。理由是問題已有否定結論，加上端點下架拆掉了裝置。檔頭把原本的斷言翻成重建驗收條件。（`apps/harness/src/eval/tiers.ts:5-15`、`:30-48`）
- **判準對照的補跑（規則 1、T7-01）**：#86 的 `SCORER_CONTROL` 對照只跑完 3/8 次。作者決定不補跑，理由是「判準量不量得出 1.00 以下」這件事已由階梯回答，五階裡四階量到 1.00 以下。這是由階梯頂替的；階梯後來也收掉了（上一條）。（PR #86「備註」）
- **打轉標籤（規則 2）**：Jev 量測裡，「連續同鍵最長串」(maxRun) 被「失敗的變更呼叫次數」取代。取代只發生在量測那側；`session-scan.ts` 仍用同鍵連續判法。兩者是不是同一把鍵，見規則 2 那列的「待驗」。（`.docs/decisions-2026-09-22.md:51`、`:73-74`；`apps/harness/src/eval/session-scan.ts:15-18`）
- **真模型回歸（規則 5、規則 7、T7-08）**：每晚冒煙回歸（#436）2026-09-26 拍板暫緩。卡片自己記下的代價是：端點改了、模型下架了，要等有人手動跑 `eval:compare` 或 live 實測才會發現。也就是由人工手動跑頂替。（#436 決定段）
- **其餘各列**：規則 3、4、6，以及 T7-02、T7-03、T8-02、T8-03、T8-04、T8-06，掃過沒有「做過但被取代」的情形。

## 相關地圖與票留下的東西

- **#263（觀測與評估，已關）**：落地的是產品日誌那側的觀測。工具事件（`tool/call`、`tool/result`）、輪數與步數統計、中止、點踩與 `/feedback`，加上離線的 `eval:sessions scan` 與 `draft`。它明文把「會停下來的迴圈偵測」與「負向軌跡自動寫進題庫」排除在外。對應到上表：規則 5 的過程訊號、規則 2 的打轉旗標，以及 T7-01 那句「造題不是重判」。
- **#334（Proteus 地圖）與 #343**：#343「用我們的 eval 當 evaluator」還沒動工，被 #342 擋，#342 又被 #379 擋。內文寫的形狀是把基準任務包成唯一進入挑選的評估器，其餘量測隱藏。對應到規則 3。Proteus 的 adapter 與映像都在 repo 外（`references/Proteus-fork/`），本次沒有讀。
- **#436（每晚真模型冒煙回歸）**：2026-09-26 拍板暫緩。所以今天所有自動測試只用假模型；`.github/workflows/` 只有 `ci.yml` 與 `release.yml`，本次重掃 `schedule`／`cron` 只中 `.github/dependabot.yml:21-23`。對應到規則 5、7 與 T7-08。
- **七層盤點 V 層（`.docs/seven-layer-inventory-2026-09-26.md:831-916`）**：V-07「基線分數存檔、跨次比對」與 V-11「LLM 當評審」判「dsh 也沒有」，V-06 判缺口。本表引用它當前人做過的盤點；它的否定搜尋是對 `70357bb` 跑的，本次在 `5949288` 重跑了 V-06、V-07、V-11 三組。

## 掃描方法與盲區

### 怎麼掃的

- **讀過的原始碼**：`apps/harness/src/eval/` 的 `dataset.ts`、`scorers.ts`、`runner.ts`、`compare.ts`、`compare-cli.ts`、`survey.ts`、`survey-cli.ts`、`tiers.ts`、`assembly.ts`、`cli-args.ts`、`session-scan.ts` 全文，`eval.test.ts` 全文，`session-draft.ts` 的檔頭（`:1-90`），以及 `scorers.test.ts` 與 `compare.test.ts` 的測試標題。`sessions-cli.ts`、`model-under-test.ts` 與其餘測試檔沒有細讀。另讀了 `live-model.ts`、`live-model.test.ts`、`repeat-reminder.ts` 的相關段落與 `.github/workflows/ci.yml`。
- **讀過的文件與票**：
  - `.docs/decisions-2026-09-22.md`
  - `.docs/model-inventory.md`
  - `.docs/seven-layer-inventory-2026-09-26.md` 的 V 層
  - issue #994、#995、#334、#343、#436、#263、#85、#165
  - PR #86、#87
  - 有抓下來但沒細讀：#31、#83、#84、#167
- **圖查詢**：codebase-memory-mcp（專案 `nexus-agent`）。
  - `trace_path` 確認 `scoreCase` 與 `runBenchmarkCase` 的呼叫者只有 `compare.ts` 與 `eval.test.ts`，沒有第三個消費者。
  - `check_index_coverage` 共跑 28 次路徑檢查（27 個不同的檔，`session-draft.ts` 查了兩次），涵蓋引用到的程式、測試、設定與 `.docs` 檔，全部回 `no_recorded_issue`。其中 26 個回 `metadata_match`；`.docs/chat-agent-research/blueprint.md` 回 `metadata_changed`，代表索引建好之後這個檔又改過。`.docs` 檔不在程式圖裡，那些行號一律是直接讀原檔得來的；藍圖也逐檔比對過，主 checkout 與 worktree 相同。
  - 索引根是主 checkout、建於 2026-10-03T10:58，不是本 worktree。所以另外逐檔比對主 checkout 與 worktree：`eval/` 全部 23 個檔、`live-model.ts`、`live-model.test.ts`、`repeat-reminder.ts`、`packages/nexus-plugin-goal/src/tools.ts`、`ci.yml` 與三份引用的 `.docs`，全部相同。
- **字串掃描**：自寫的唯讀 Python 掃描器，掃 `apps`、`packages`、`.github`、`docs`、`.docs`、`scripts`。略過 `node_modules`、`references`、`.cache`、`.claude`、`dist`，研究樹 `.docs/chat-agent-research/` 也排除（它本身就在談這些詞）。先用 `SCORER_CONTROL|EVAL_RECURSION_LIMIT` 做正向對照，確認掃得到再用。各列的否定宣稱掃過這些形狀，大小寫不分：
  - **規則 1／T7-01**：`do-?nothing`、`no-?op agent`、`noop`、`spamm`、`random[- ]valid`、`majority`、`trivial`、`floor`、`地板`、`平凡`、`一律判`、`什麼都不做`、`放棄`。命中的都是無關用法：`Math.floor`、「什麼都不做」的程式註解、`noopener`、web 的效能地板。
  - **規則 6**：`simulat`、`模擬使用者`、`使用者模擬`、`user ?sim`、`usersim`、`persona`、`假使用者`、`fake ?user`、`scripted ?user`。`persona` 只中系統提示詞的部署方前後綴。
  - **T7-02／T7-03**：`judge`、`grader`、`rubric`、`llm-as`、`評審`、`評分者`、`pairwise`、`成對比較`、`position bias`、`位置偏`、`對調`、`kappa`、`κ`、`cohen`、`一致率`、`inter-?rater`、`agreement`。程式裡只中無關的變數名與測試突變；`.docs` 裡只中 Jev 文件與調研文件。
  - **T7-06／T8-06**：`mcnemar`、`bootstrap`、`stderr`、`標準誤`、`標準差`、`std ?dev`、`variance`、`變異數`、`confidence interval`、`信賴區間`、`p-?value`、`顯著`、`檢定力`、`statistical power`、`wilson`、`binomial`、`二項`。命中幾乎全是 `stderr`；`.docs/decisions-2026-09-22.md:230` 有一句「迴歸係數不顯著」，談的是 Jev 實驗的延遲，不在 eval 程式裡。這組排除了 `apps/web/src`。
  - **規則 4／T8-04**：在 `eval/` 掃 `rev-parse`、`GITHUB_SHA`、`commit`、`version`、`temperature`、`topP`、`top_p`、`seed`、`SHA`。`version` 只中會話日誌的格式版本，溫度只在說明與註解。
  - **規則 5／T7-08**：在 `eval/` 掃 `forbidden`、`minefield`、`禁止事件`、`不該被動`、`副作用`、`regression`、`回歸`、`P2P`、`終態`、`final state`、`最終狀態`。只中無關的 `FORBIDDEN` import 絆索與註解。
  - **V-07 重掃**：`writeFile|appendFile|createWriteStream|node:fs|baseline|基線` 在 `compare-cli.ts`、`survey-cli.ts`、`compare.ts`、`runner.ts`、`scorers.ts`、`dataset.ts` 0 筆。正向對照：`node:fs` 對整個 `eval/` 目錄命中 4 個檔。
  - **規則 2**：先列出產品路徑上的閘門（重複呼叫提醒器、goal 的阻擋門檻、限流分類），再掃 `誤報`、`漏報`、`誤判`、`偽陽性`、`偽陰性`、`false positive`、`false negative`、`precision`、`recall`。只在 `.docs` 的 Jev 文件、模型盤點與調研文件命中。

### 盲區

- **repo 外的東西沒看**：
  - Proteus fork（`references/Proteus-fork/`）裡的 adapter 與量測。
  - Jev plugin 與它的原始資料和腳本。
  - 決選與 #85 那幾輪的原始輸出，只看得到 issue 與 `.docs` 裡的彙總表。
  - Proteus 那一側若有本表沒列到的量測紀律，這裡看不到。
- **issue 留言沒有全讀**：只讀了上面列的票。其他票（例如 #586 的 token 估算選型、#238 補跑、#342 內文）若做過帶基線或重跑的量測，本表會漏。
- **只看了 agent 評估相關的量測**：`apps/harness/src/measure/`（中止送達、會話列表 CPU）與 web 的效能量測帶有對照窗口與重複次數，但量的是效能，不是 agent 行為，本表沒有列。
- **掃描器是字串比對**：同一個概念若用沒列到的詞寫（例如英文縮寫、拼字變體），會漏。中英文各列了一組，但不保證窮盡。
- **索引的時間差**：索引建於 2026-10-03，本 worktree 在 `5949288`。引用的檔案已逐一比對相同，沒引用的檔案沒有逐一比對。
- **shell 量具**：這個環境的 shell 會把 `eval` 這個路徑字樣誤認成 shell 內建指令而拒絕執行，`rtk` 也會改寫 grep 的輸出。所以字串掃描都改用自寫的 Python 掃描器，沒有用 `git grep`。行號以 Read 工具讀到的原檔為準。
