# r5：T7／T8 評估卡對 nexus 的適用度，與「成本與用量」現況盤點

唯讀研究，2026-10-04。對的樹：`develop` 的 `501e153`；dsh 參考原始碼 `references/deepseek-harness` 的 `5badb15`（2026-10-03）。
行號都是對這兩個樹讀的。「待驗」表示我沒有直接查證。

---

## 零、先講結論

1. **24 張卡裡，#994 用程式落地的只有 6 張，而且多半只落了一部分。** 這 6 張是 T7-01、T7-06、T8-01、T8-02、T8-04、T8-06，T8-09 也落了一小部分。另外：
   - 寫成準入規則的有 2 張：T7-02、T7-03。
   - 寫成暫緩、附重開條件的有 3 張：T7-08、T7-01 的後半、T8-03。
   - 其餘全部不在 #994 的範圍。#994 只收七條規則加九張 A 卡，主幹 M1–M5 與待決題明寫排除。這些不是 #994 漏掉的。
   - #994 落地的每一件都在**離線評測那一層**（`apps/harness/src/eval/`）。產品路徑與 web 一件都沒碰。
2. **對 web 側欄有意義的線上卡只有幾張：** T8-09（成本）、T8-10（把基礎設施失敗分出來）、T8-07（部分分數不能當完成率）、T7-10（紀錄格式）、T7-11（真人閉環）、T8-11（多個軸要不要合成一個分數，使用者訊號），以及 E5、E6、M4。其餘是離線評測那一層的事，不進 web。
3. **token 帳今天有兩本，互不相干。**
   - 產品路徑：每次模型呼叫寫一顆 `model/usage` 進會話日誌。web 只看得到 root 的會話總帳（輸入、輸出）、輪數與步數、模型時間、工具時間。
   - 評測路徑：自己從 `usage_metadata` 加總。這條路不寫會話日誌，是登記過的決定。
4. **沒有「錢」的概念。** 程式碼搜尋零筆。#85 的留言說端點不回報計價；#724 說型錄的價格全填 0。
5. **任務成本今天大半算得出來，但要自己從日誌折。** 沒有任何東西做「每輪」或「每個 goal」的折疊；dsh 有每輪的折疊，見乙 §4。算得出的：步數、工具數、成功呼叫的 token、模型與工具時間、重試等待。算不出的有五項：
   - 失敗或中止那次呼叫的 token
   - 生摘要那一次的 token
   - 生標題那一次的 token
   - 子代理接回它所屬那一輪（今天沒有連結鍵，待驗）
   - 錢
6. **#522 的前提已過期。** 它在 2026-09-22 說「會話日誌是 opt-in、沒有時間戳」。2026-09-25 的 #607 改成預設落盤（關 #444），每顆事件都帶 `time`。現在用現有日誌就答得出「相鄰模型呼叫的間距」。我沒有拿實際日誌去算，所以是推論。

---

## 甲、T7／T8 共 24 張卡，加 E5、E6、M4、M5

### 四種涵蓋狀態

- **落地**：#1000–#1002 有程式，`docs/operations.md:776-803` 寫了。
- **準入**：寫成「對象出現才要先過關」，見 `apps/harness/docs/eval-measurement.md:21-38`。
- **暫緩**：寫成暫緩項加重開條件，見 `eval-measurement.md:68-99`。
- **範圍外**：#994 只收規則 1–7 與九張 A 卡（T7-01、02、03、06、08，T8-02、03、04、06），見 #994 內文〈Notes〉。B 卡、C 卡、待決卡與 M1–M5 都不在範圍，這不是漏做。

### 「層」欄

- **線上**：從真實會話算，對 web 側欄有意義。
- **離線**：屬於評測工具層，不進 web。
- **兩層**：兩邊都要。

### 卡片表

| 卡 | 類型 | 等級 | 一句話 | #994 涵蓋 | nexus 適不適合做、掛點 | 層 |
|---|---|---|---|---|---|---|
| T7-07 | 避免 | B | 不同 scaffold、預算、步數上限、提示、版本的分數不能放在一起排名，要並報成本 | 範圍外，但 #1000 實質涵蓋一半：結果檔標頭記了 commit、題庫版本、評分程式版本、溫度與 topP、迴圈與時鐘上限（`operations.md:776-781`，`result-file.ts:89-100`）。scaffold（`assembly.ts` 的 plugin 組與系統提示）有沒有進版本雜湊：**待驗**（評分程式版本只雜湊 `scorers.ts` 與 `runner.ts`，`result-file.ts` 檔頭） | 離線已大致到位。**對 web 的意義**：不同會話的模型與 plugin 組不同，側欄不應做「跨會話排名」；每個成本數字旁要能標出模型 id。今天模型 id 只在 `assistant/message` 的 `response_metadata.model_name` 裡（實測一份 CLI v16 日誌） | 兩層 |
| T7-01 | 量測 | A | 判定器上線前跑三個平凡 agent 當地板，並從判成功、判失敗兩批各抽樣交人工重判 | **部分落地加暫緩**。`floor.ts` 跑「什麼都不做、固定亂吐、隨機合法動作」，CI 雙向擋（`operations.md:783-803`）。但這三個對的是 T8-01 的那一組；T7-01 要的「第一步就放棄」**沒做**。地板沒逐類別報，只有「全部」與「難題」兩組（`survey-cli.ts:108-139`）。人工重判那一半暫緩，掛在 #343 的檢查表（`eval-measurement.md:93-99`） | 離線。補「第一步就放棄」很便宜（`floor.ts` 再加一個 agent）；逐類別要先替題目定類別 | 離線 |
| T7-02 | 量測 | A | 評審對人的一致率要並報多數類基準、κ、區間、人類參照與人彼此的一致率 | **準入**（`eval-measurement.md:34`） | nexus 今天沒有 LLM 評審。哪天要用 LLM 評審去判真實會話，這條就變成線上的事 | 離線；接上評審後變兩層 |
| T7-03 | 量測 | A | 成對比較的評審逐題交換位置各判一次 | **準入**（`eval-measurement.md:35`） | 沒有對象 | 離線 |
| T7-04 | 量測 | B | 評審上線前量它對冗長與重複的敏感度 | 範圍外 | 沒有對象（沒有 LLM 評審）。**建議**在 `eval-measurement.md` 的準入表補一行，跟 T7-02、T7-03 並列（推論，不擋） | 離線 |
| T7-05 | 量測 | B | 評審或資料生成器與受測模型同家族時，換一個不同家族的評審重判 | 範圍外 | 今天沒有對象。但只要有人用同一個 NVIDIA 端點的模型去判真實會話，就立刻成立。**建議**也補進準入表（推論） | 兩層 |
| T7-06 | 量測 | A | 每個設定重跑數次，報一題等於幾個百分點、標準差，以及以題目為單位重抽的區間 | **落地（部分）**。#1002 做了以題目重抽的 bootstrap 與「一題等於 X 個百分點」（`stats.ts` 檔頭，`operations.md:793-798`）。重跑標準差沒有單獨報，同題重跑的變異在「每題先取平均」那一步被收掉了（`stats.ts` 檔頭） | 離線 | 離線 |
| T7-08 | 量測 | A | 判成功的樣本另做回歸檢查與禁止事件檢查，報「終態通過、但違反」的比例 | **暫緩**，併進 #436（`eval-measurement.md:73-79`）。評分器讀的是工具呼叫序列與最終回覆，不讀終態 | **線上也有對應的原料**：產品日誌有 `tool/result` 的 `isError` 與錯誤碼（`session-log.ts:799`），另有 invariant 違規記錄（`operations.md:73-102`）。「使用者沒點踩、但過程有錯誤或打轉」的比例，可以從日誌導出（`session-scan.ts` 已掃錯誤碼與打轉） | 兩層 |
| T7-09 | 量測 | B | 評估流程有沒有把答案洩漏給受測者：每次評估做一次稽核 | 範圍外 | 離線。期望答案只給評分器，受測 agent 只拿到題目那句話（基準表規則 3 那一列，`.docs/nexus-measurement-baseline-2026-10-04.md:38`）。沒有模擬使用者，洩漏面很小 | 離線 |
| T7-10 | 量測 | C | 紀錄格式用一個驗收來定：只拿紀錄、不重跑 agent，要做得到五件事（重算分數、重建每輪環境、指出判定出自誰、重跑洩漏與地板、讀到設定欄位） | 範圍外（C 卡，而且 M4 被 #994 排除） | **最貼需求 (1)「追溯整條鏈」**。下面另列一份對照表 | 兩層 |
| T7-11 | 待決 | — | 多輪評估用金上下文重播還是閉環；開放式任務的 gold 從哪來 | 範圍外 | **線上**：真實會話就是「真人閉環」。離線的七題是單輪，兩者之間沒有橋。要用真實會話評估，得先回答開放式任務的 gold 從哪來。今天 `eval:sessions draft` 的答案是「人補 `expected`」（`session-draft.ts:5-12`） | 線上 |
| T7-12 | 待決 | — | 判定器的兩種誤判率怎麼傳進任務層的誤差棒 | 範圍外 | 離線 | 離線 |
| T8-02 | 避免 | A | 成功判準不能只用寬鬆的四種（單一終態、子字串、只算召回、只跑部分測試） | **落地（部分）**。#1001 的「這題成功」要有可判的三欄全為 1.00，而且多叫次數不超過容許值（`operations.md:783-787`）；亂吐 agent 在寬鬆兩欄拿滿分，被這條擋下（`floor.ts` 檔頭）。仍未做：「回覆提到」還是子字串、工具成功率還是只算召回；沒有檢查「不該被動到的狀態」；收緊之後偽陰性沒量 | 離線 | 離線 |
| T8-01 | 量測 | B | 判準採用前與每次改版，跑三種平凡 agent，逐類報分數 | 名義上範圍外（B 卡），實際上 #1001 經由規則 1 落地，三種 agent 與這張卡完全一致（`floor.ts`） | 缺「逐類報告」，只有全部與難題兩組 | 離線 |
| T8-03 | 量測 | A | 判準誤判分方向、分難度量，兩邊都要人工複核 | **暫緩**，掛 #343 的檢查表（`eval-measurement.md:93-99`） | 要人手標，agent 補不上 | 離線 |
| T8-04 | 量測 | A | 不拿別人自報的同名指標比；每個分數附評分程式、題庫版本、步數上限、模擬器等設定 | **落地**（#1000，`result-file.ts` 檔頭；讀檔重算在同一檔） | 離線已到位。線上同 T7-07：成本數字要附模型 id | 兩層 |
| T8-05 | 量測 | B | 每題跑 n 次，報 pass^1、pass^k、pass@k，不取最好的一次 | 範圍外 | 離線可做：`--samples` 與逐次結果檔都在，n 與 c 算得出；pass^k 沒做（搜尋見後設） | 離線 |
| T8-06 | 量測 | A | 以題目為單位算標準誤、配對檢定（McNemar）、檢定力分析 | **落地（部分）**。只有以題目為單位的區間，配對檢定、群集標準誤、檢定力都沒做 | 離線 | 離線 |
| T8-07 | 量測 | B | 部分分數只能和二元成功率並列，不能單獨當完成率 | 範圍外。離線報表本來就是並列的：「這題成功」旁邊列工具成功率與參數正確性 | **對 web 很重要（推論）**：側欄若畫「待辦清單完成幾成」或「goal 跑了幾輪」，那是部分分數或過程量，不能標成「任務完成度」。今天也沒有任何二元的「這任務成功」可以並列（見乙 §5） | 兩層 |
| T8-08 | 量測 | B | 跨類別彙總時，權重要明寫，並看名次會不會變 | 範圍外 | 離線。survey 分全部與難題兩組，彙總是題均 | 離線 |
| T8-09 | 量測 | B | 成功率一律與成本並報；成本要算進失敗的 run、評審或驗證器、模擬器，以及輸入輸出 token；單價另存 | **落地一小部分**。#1002 把失敗那幾次的 token 計入（是下限，`operations.md:799-800`；`runner.ts` 的 `UsageTally`）。仍未做：沒有美元；沒有同預算的簡單基線（重試、多數決） | **「評估任務成本」的核心卡**。線上的缺口見乙：失敗或中止呼叫、生摘要、生標題的 token 都不進產品帳；root 總帳不含子代理 | 兩層 |
| T8-10 | 量測 | B | 每次 run 記失敗原因與環境指紋，基礎設施失敗另報 | 範圍外，但離線已有五類失敗：`rejected`、`throttled`、`timeout`、`budget`、`transport`（`compare.ts:37-71`），不平均成零分 | **線上**：`llm/retry` 帶 `failure.code` 與 `status`（`session-log.ts:219-223`、`:496-502`），`llm/retry-started` 帶實際等待毫秒（`:508-512`）；但 `turn/failed` 只留訊息字串，沒有碼（`:392`）。側欄可以把「限流重試等了幾秒」與「agent 自己花的時間」分開 | 兩層 |
| T8-11 | 待決 | — | 成功率、成本、滿意度、失敗嚴重度要不要合成一個分數 | 範圍外 | **線上**：真實使用者訊號已有點讚點踩（`feedback/message-put`，`nexus-plugin-feedback/src/index.ts:151`）與 `/feedback` 評語（`:172`）。建議側欄並列各軸、**不合成**，因為文獻沒有答案（推論） | 線上 |
| T8-12 | 待決 | — | pass^k 的區間，以及重跑變異怎麼拆成各個來源 | 範圍外 | 離線 | 離線 |

### E5、E6、M4、M5

這四列全部在 #994 的範圍外（M1–M5 明寫排除）。

| 項 | 一句話 | nexus 對應 | 層 |
|---|---|---|---|
| E5 修正紀錄 | 每一次修正嘗試的原始紀錄：前後輸出、觸發判定、回饋、token。迴圈內驗證器自己的「修好了」不能當評估標籤 | nexus 沒有獨立的自我修正模組。最接近的「修正」有三種：重複呼叫提醒器注入的話，寫成 `user/message`，來源是 `plugin`（`session-log.ts:546-552`）；壞參數改寫（`invalid-tool-args.ts`）；`llm/retry`。三者都有事件，但**觸發判定的分數與沒觸發的那些都沒記**。另外 goal 的 `complete` 是 agent 自己宣告的，**屬於「迴圈內自己判的成敗」**，不能當任務成功的標籤（推論，對應 E5 與 E6 的「不能傳」） | 線上 |
| E6 互動紀錄 | 每集一筆：真人或模擬器的標記、發話原文、誰結束、為什麼結束 | 真人發話：`turn/start{kind:'message'}` 與輪中插話 `user/message{source:'user'}`。來源有標記：`turn/start` 的 kind 分 message、resume、goal、agent-message（`session-log.ts:330-336`）。誰結束、為什麼：`turn/end.reason` 分 aborted（user 或 parent）、max-tokens、interrupted，另有 `turn/failed`（`:206-209`、`:390-392`）。沒有模擬器 | 線上 |
| M4 軌跡 | 完整軌跡、每步 token 與呼叫數、判定器身分、設定欄位，加上五個連結鍵 `episode_id`、`turn_idx`、`step_idx`、`attempt_id`、`source` | 會話日誌本身就是軌跡。五個鍵的現況：**`episode_id`** 有，是會話 id；**`turn_idx` 與 `step_idx` 沒有**，事件只有 `seq` 與 `time`（`session-log.ts:950-952`），輪靠位置推（`session-stats.ts` 檔頭〈輪怎麼數〉）；**`attempt_id`** 只有重試的 `retryId`；**`source`** 有，見 E6。子代理日誌的 id 是 LangGraph 的 task id，**不是** root 那顆 `task` 工具呼叫的 `callId`（`session-address.ts` 檔頭那張表）。所以子代理接不回它所屬那一輪，只能靠 `parentSession` 加時間窗去對（**待驗**）。背景子代理（#823）用自己的穩定編號，可能落在輪的時間窗之外 | 兩層 |
| M5 判定交給計分 | 逐題逐次的原始結果、分類別的地板、判定器的兩種誤判率、終態以外的檢查、洩漏、失敗原因、成本、設定 | 離線那邊的結果檔已有：逐次結果、成本（含失敗的下限）、失敗原因、設定。缺：判定器誤判率、逐類別地板、過程檢查、洩漏標記。線上沒有任何判定，所以沒有 M5 可談 | 離線 |

### T7-10 五項驗收，套在「產品會話日誌」上

| 項 | 今天做得到嗎 | 依據 |
|---|---|---|
| 一、重算報告裡的每個分數 | 不適用：線上沒有分數。成本數字倒是重算得出來（折 `model/usage` 與 `model/start`、`model/end`） | `token-usage.ts:48-60`，`session-stats.ts` |
| 二、重建每一輪的環境狀態 | 部分：檔案改動有 `workspace/changes` 事件，指令輸出在 `tool/result` 裡。能不能逐輪重建工作區：**待驗** | `session-log.ts` 的事件聯集 |
| 三、指出每個判定出自誰 | 部分：產品路徑的閘門有身分，提醒器在 `user/message.source.plugin`；goal 擋人有 `blockedReason.code`（`goal.ts`） | `session-log.ts:546-552` |
| 四、重跑洩漏稽核與平凡基準 | 不適用（線上沒有判定器） | — |
| 五、讀到設定欄位 | **不及格**。標頭只有 `version`、`id`、`createdAt`、`cwd`、`parentSession`（實測 `~/.nexus-agent/sessions/2026-09-25…/cli.header.json`）。模型 id 只散在 `response_metadata.model_name`；裝了哪些 plugin 在另一份 `invariant-log.jsonl` 的 `installed` 行（`operations.md:80-81`）；迴圈上限、摘要門檻要從 `context/measure.thresholds` 拼。完整的請求輸入（M3 說的「模型這一步實際收到什麼」）沒有記；只能由 `conversation-replay` 重推，那是推出來的，不是記下來的 | 實測檔案；`session-log.ts:642-652` |

另外，**離線評測那條路刻意不寫會話日誌**（`runner.ts` 檔頭；`session-absence.test.ts` 是它的絆索）。所以離線那邊的「軌跡」只有結果檔裡存的 `BenchmarkRun`：工具呼叫序列、最終回覆、用量。不是完整軌跡。

---

## 乙、成本與用量的現況

### 1. 產品路徑記了什麼（會話日誌事件）

| 事件 | 欄位 | 什麼時候寫 | 出處 |
|---|---|---|---|
| `model/usage` | `inputTokens`（**含快取讀**，LangChain 的語義）、`outputTokens`、`totalTokens` | 每次模型呼叫**成功回來**才寫，由 `wrapModelCall` 寫。沒報、或報得自相矛盾，整筆不寫 | `session-log.ts:464-468`；`model-usage.ts:74-81`、`:119-131`、`:150-167` |
| `assistant/message` | 整則回覆，連同 LangChain 的 `usage_metadata`（含 `input_token_details`、`output_token_details`）與 `response_metadata`（含供應商原樣的 `usage` 與 `model_name`） | 每次模型呼叫收尾 | `session-log.ts:513-543`；實測見下 |
| `model/start`、`model/end` | 沒有欄位，只有事件外層的 `time` | 每次模型呼叫的起訖；失敗與中止也寫 `end` | `session-log.ts:469-484` |
| `llm/retry`、`llm/retry-started` | `retryId`、第幾次、`failure{message, code, status?}`；`waitedMs` | 排定重試時寫；真的重打時寫 | `session-log.ts:485-512`；`llm-retry.ts:109`、`:124` |
| `tool/call`、`tool/result` | `callId`、`name`、`arguments`；`isError`、`error`（碼） | 每次工具呼叫 | `session-log.ts:748-803` |
| `context/measure` | `approxTokens`（錨在供應商實數上的估算）、`messageCount`、`thresholds` | 摘要器量到的每次 root 呼叫；摘要關掉時沒有 | `session-log.ts:626-652` |
| `compaction/summary` | 切點、摘要；**沒有用量** | 壓縮真的發生時 | `session-log.ts:616-625` |
| `turn/start`、`turn/end`、`turn/failed` | kind、reason、訊息 | 一輪的起訖 | `session-log.ts:330`、`:390-392` |
| `goal/change` | 目標、相位（active、paused、blocked、complete）、`roundsStarted`、`maxGoalRounds`、建立與更新時間 | goal 每一次變更 | `goal.ts`（`GoalSnapshotChangeMeta`） |
| `feedback/message-put`、`feedback/record` | 點讚點踩、評語 | 使用者評分時 | `nexus-plugin-feedback/src/index.ts:151`、`:172` |
| 事件外層 | `seq`、`time`（epoch 毫秒） | 每一顆 | `session-log.ts:950-952` |

**快取與推理 token 的實況（只有一份樣本）。** 我讀了 `~/.nexus-agent/sessions/2026-09-25T12-15-38-007Z-eef8c1ff/cli.jsonl`（CLI、格式 v16、nemotron-3-super）。`assistant/message` 裡的 `usage_metadata` 帶著 `"input_token_details":{}` 與 `"output_token_details":{}`。所以能說的只有：

- **載體在**：哪天供應商填了快取讀、快取寫或推理 token，原樣落在 `assistant/message` 裡。
- **這次沒填**。
- `model/usage` 只讀三個總數，細項丟掉（#724 內文的「我們現在」一節）。
- #724 記的命中率：9/24 那兩場共 24 次呼叫，只有 2 次帶快取數字。那是單次量測，沒重跑。
- **推理 token 任何事件都沒有獨立記錄**，#724 也明寫不在它的範圍。

### 2. 粒度

| 粒度 | 有沒有 | 怎麼來 |
|---|---|---|
| 每次模型呼叫 | 有 | `model/usage` 一次一顆；時間從 `model/start`、`model/end` 算 |
| 每輪 | **沒有現成的折疊** | 日誌沒寫彙總（`session-log.ts:453-455`）。要自己從位置切輪（`isLogicalTurnStart`）。dsh 有：`deriveTurnTokenUsage`（`packages/llm/token-meter/src/turn-usage.ts:178`），由 `ui-chat/.../turn-tail.ts:91` 畫在每一輪的尾巴，含未快取輸入、快取讀、快取寫、推理 token、路由（provider 加 model）。**已對 dsh `5badb15` 讀過原檔** |
| 每會話 | 有 | `tokenUsageUnit`（`token-usage.ts:48-60`）只有輸入、輸出兩桶；`deriveSessionStats`（`session-stats.ts`）算輪數、步數、`llmMs`、`toolMs` |
| 每子代理 | 各自一份日誌 | 子代理的呼叫寫進它自己那份；**root 的總帳不含子代理**（`token-usage.ts` 檔頭〈數字是逐份日誌的〉） |
| 每個 goal | **沒有** | 要用 `goal/change` 的起訖去切 |

### 3. 持久化

- **會話日誌**：預設落盤在 `$NEXUS_AGENT_HOME/sessions`，JSONL 格式，一份 `.jsonl` 配一份 `.header.json`（`operations.md:24-58`）。關掉 `session-persistence` 那一列就只在記憶體裡。
- **wire 的累計值**：不另外存。pump 即時逐顆折（`thread-pump.ts:2360-2379`），歷史路由每一頁從日誌開頭重折（`conversation-history.ts:567` 的 `SessionTotals`）。
- **離線評測**：`apps/harness/eval-results/*.jsonl`，不進版控。每次執行一行，帶 `seconds`、`run.usage` 或失敗的 token 下限（`compare.ts:122-150`；`result-file.ts`）。

### 4. wire 與 web 今天顯示什麼

**wire 送的 custom frame，全部只收 root：**

| 名字 | 內容 | 出處 |
|---|---|---|
| `tokenUsage` | `{inputTokens, outputTokens}` | `nexus-wire/src/session-totals.ts` |
| `sessionStats` | `{turns, steps, llmMs, toolMs}` | 同上 |
| `model/usage` | 最新一次的 `inputTokens` | `nexus-wire/src/context-pressure.ts` |
| `context/measure` | 最新一筆的量測 | 同上 |

**web 畫在三個地方：**

- **頂列的用量那顆**（`components/session-usage.tsx`，掛在 `App.tsx:393`）：
  - 收著時顯示總 token。
  - 點開分兩段。一段是「這條對話累計」：輸入、輸出，附一句「不含子代理與自動摘要那幾次」（`:67`）。另一段是「時間」：輪／模型呼叫、模型時間、工具時間。
  - **不分快取，沒有首字延遲**（`lib/session-usage-view.ts:11-16`）。
- **輸入框旁的用量環**（`components/context-meter.tsx`，`App.tsx:614`）：
  - 環顯示離自動摘要還有幾成，算法是 `approxTokens` 除以最近的那道門檻。
  - 點開看「目前大小」，也就是最新一次的 `inputTokens`。
  - 80% 以上變警示色。
- **狀態列**（`status-line.tsx`）：只講這一輪跑到哪、連線狀態，**不顯示成本**。

**右側欄**（`right-sidebar.tsx`，`App.tsx:624`）只有三種分頁：改動比對、交付預覽、計劃（`lib/right-sidebar.ts:23-35`）。**沒有成本或評估分頁。** 要加，就是在 `SidebarTab` 多一種。

**沒有的東西：**

- 每輪的成本：dsh 有。
- 子代理的成本：子代理狀態那顆 frame 不帶 token，搜尋見後設。
- 錢、快取命中率、重試等待時間。

### 5. 另一本帳：離線評測

- `runner.ts:53-57` 的 `TokenUsage` 有輸入、輸出、總量；它從 `result.messages` 的 `usage_metadata` 加總（`:214-225`）。失敗那幾次靠 `UsageTally` 回呼記，是下限（`:80-114`）。
- **這本帳跟 `model/usage` 無關**（`model-usage.ts:203-206`）。
- 報表：每個模型一行「總 token」，加一行「token 合計：評到分的＋失敗的＝全部」（`compare-report.ts:99-111`）；每次執行另有 `seconds`。

### 6. #724、#522、#85

**#724（開著，2026-09-26 拍板晚點做）：讓 token 總帳照 dsh 分出快取讀與快取寫兩桶。**
- 重開條件任一成立就排：web 要畫快取命中率；換上穩定回報快取數字的供應商；需要算錢。
- 資料層不分桶，登記成「還沒排的缺口」，**不是偏離**：基座的 `ChatOpenAI` 已經把 `cached_tokens` 映成 `cache_read`。
- 要做的有八步，第 3 步非升日誌格式版本不可。範圍分工：harness 先做，web 後做。
- 明寫不在它範圍的：失敗與中止的呼叫不進帳、`reasoningTokens`、web 畫快取。
- 代價：這段期間的日誌沒有快取數字，以後補不回來。

**#522（開著，備查）：評估拉開模型呼叫間距能不能少觸發限流。**
- 0.5 秒一發時，限流以「串流內 503 先軟擋、再升成 HTTP 429」的形式出現；4 秒一發時 429 歸零。
- 失敗後立刻重試，8/8 全部救回，最晚 2 秒。所以這張卡的邊際價值低。
- 「沒驗成的那一半」寫的是：會話日誌是 opt-in、沒有呼叫時間戳。**這個前提已經過期。** #522 建於 2026-09-22；#607「讓會話日誌照 dsh 預設落盤到 harness home」在 2026-09-25 合併（`git log -S resolveSessionLogDir` 第一筆 `487bffaf`），並關掉 #444。每顆 `model/start` 都有 `time`。
- 所以現在只要讀一份 live 日誌，就能量相鄰呼叫的間距。我沒有拿日誌實算，屬於推論，**待驗**。
- 卡上沒有留言。

**#85（已關）的留言：** 「這份調查沒有比成本（端點沒回報計價，只有 token 數）」。

### 7. 有沒有「錢」

**沒有。** 搜尋見後設，程式碼零筆。另外三個出處：
- #724：#729 照 dsh 做的型錄不帶價格。dsh 的型錄價格全填 0，並註明 harness 從不讀。
- dsh 的 `token-meter/src/route-pricing.ts` 名字裡有 pricing，但讀過原檔，它算的是圖片與檔案換成**幾個 token**，跟錢無關。
- 「NVIDIA 端點按額度不按單價」：出處是記憶檔 `no-public-price-means-no-price.md`，記的是 2026-09-16 為 #335 做的查證（官方頁面沒有每 token 單價，只說會扣試用額度）。**這次沒有重查，待驗。**

### 8. 「任務成本」今天能不能從日誌算出來

「任務」有兩種切法：

- **邏輯輪**：從開輪的 `turn/start`（kind 為 message 或 goal）到 `turn/end` 或 `turn/failed`，resume 併回前一輪。
- **goal**：從 `goal/change` 的 create 到 complete、block 或 clear。

下表以 root 日誌為準。

| 欄位 | 算得出嗎 | 怎麼算，或為什麼不行 |
|---|---|---|
| 模型呼叫次數（步數） | 算得出 | 數區間內的 `model/start` 與 `model/end` 對（同 `session-stats.ts` 的規則）。脈絡溢出那一輪會多算一步 |
| 工具呼叫次數，依工具名分 | 算得出 | `tool/call`，同一個 `callId` 只算一次（`session-scan.ts` 檔頭） |
| 工具錯誤數，依碼分 | 算得出 | `tool/result.isError` 與 `error`。#273、#293 之前的舊檔偏低（`session-scan.ts` 檔頭） |
| 輸入、輸出 token（成功回來的呼叫） | 算得出 | 把區間內的 `model/usage` 加起來 |
| 失敗或中止那次呼叫的 token | **算不出** | 記帳器在回應拋錯時根本沒走到記帳那行（`token-usage.ts:17-19`）。dsh 會算進去（`turn-usage.ts` 逐次加總） |
| 生摘要那一次的 token | **算不出** | 基座直接 `invoke`，不經過記帳（`token-usage.ts:24-27`） |
| 生標題那一次的 token | **算不出** | `session-title-llm.ts:40`：「不寫 `model/usage`、`model/start`」 |
| 快取讀、快取寫 | 幾乎有 | 載體在 `assistant/message.usage_metadata.input_token_details`，但供應商常常不填；`model/usage` 不讀（#724） |
| 推理 token | 幾乎有 | 同上，`output_token_details`，但沒人讀；供應商這次也沒填 |
| 模型時間 `llmMs`、工具時間 `toolMs` | 算得出 | 同 `sessionStats` 的折法，只是改切在輪上 |
| 重試退避等了多久 | 算得出 | 加總 `llm/retry-started.waitedMs`。**它包在 `model/start` 與 `model/end` 之內**，所以 `llmMs` 裡混著它，要減掉才是模型真正花的時間 |
| 核准等待 | 算得出（推論） | 從 `interrupt/raised.time` 到 resume 那顆 `turn/start.time`。`toolMs` 本來就不含它（`session-stats.ts` 檔頭）。沒拿實際日誌驗：**待驗** |
| 牆鐘總時間 | 算得出，但**不能直接當成本** | 第一顆 `turn/start` 到最後一顆 `turn/end`，裡面混了核准等待與重試退避。建議分開列三段：模型、工具、人或限流 |
| 收尾方式 | 算得出 | `turn/end.reason`（中止、撞輸出上限、被打斷）、`turn/failed`。失敗沒有碼，只有字串 |
| 限流與基礎設施失敗次數 | 部分 | `llm/retry` 有碼；最後失敗的那次只有 `turn/failed` 的字串 |
| goal 跑了幾輪、上限多少 | 算得出 | `goal/change.roundsStarted` 與 `maxGoalRounds` |
| 壓縮幾次 | 算得出 | `compaction/summary` 的顆數 |
| 使用者評分 | 算得出 | `feedback/message-put`，以每一輪最後的狀態為準（`session-scan.ts` 的 `ratingsByTurn`） |
| 子代理的 token、步數、工具 | **要拼接，待驗** | 子代理有自己的日誌，`parentSession` 指回 root；但它的 id 是 LangGraph 的 task id，對不上 root 的 `task` 工具呼叫。只能用時間窗去對。背景子代理可能落在窗外 |
| 用的是哪個模型 | 部分 | `assistant/message.response_metadata.model_name`。實測一份 CLI 日誌有；serve 串流路徑有沒有：**待驗** |
| 錢 | **算不出** | 沒有單價，端點也不回報 |
| 首字延遲 | **算不出** | 沒記串流的第一個 token（`session-stats.ts` 檔頭） |
| 「這個任務成功了沒有」 | **算不出** | 沒有任何判準。goal 的 complete 是 agent 自己宣告的，不能當標籤（E5 的不能傳）。點踩是弱訊號，而且大多數輪沒有評分 |

---

## 丙、建議：「評估任務成本」在 web 側欄最小可行的內容

### 先要拍板的一題（不替 demian 選邊）

**能不能進產品路徑與側欄，判準是「dsh 有沒有這個投影」。**

- AGENTS.md 只讓 web 的視覺與互動不受 dsh 約束，資料層仍要照 dsh。
- #263 與 #997 都拍板過：dsh 沒有的評估，只做在產品路徑外（`eval-measurement.md:18-19`；`session-scan.ts:7-11`）。

所以內容分成兩類：

| 類 | 有哪些 | 能不能進 pump、frame 與側欄 |
|---|---|---|
| **甲類：dsh 有的投影** | `tokenUsage`、`sessionStats`、`contextPressure`、每輪的 `deriveTurnTokenUsage`，以及 dsh 的 `contextBreakdown`（系統、工具、訊息各佔多少；`token-meter/src/breakdown-projection.ts`） | 可以照 dsh 進 |
| **乙類：dsh 沒有的** | 工具錯誤依碼分、打轉旗標、平凡地板、失敗分類，也就是 `session-scan` 那一類 | 搬進側欄等於改掉「只做在產品路徑外」這條現行決定，要 demian 拍板 |

需求 (3)「評估任務成本」跟這條決定有張力，**請 demian 決定**：乙類要留在 CLI 的 `eval:sessions`，還是開例外進側欄。

### 事實與推論

| 事實（今天的樹上就有） | 推論（我的建議） |
|---|---|
| root 的每次成功模型呼叫都有 `model/usage`；每顆事件都有 `time`；輪的邊界推得出來（`isLogicalTurnStart`） | **最小可行的側欄分頁：「這一輪」與「這條對話」兩欄，每欄六格。** 六格是：步數、工具呼叫數（附依工具名的分佈）、輸入與輸出 token、模型時間、工具時間、收尾方式。全部只用甲類資料加上 `turn/end.reason`，零新記錄 |
| dsh 有 `deriveTurnTokenUsage`，而且畫在每一輪的尾巴（`turn-tail.ts:91`，`5badb15`）；nexus 沒有每輪的折疊 | 「這一輪」那一欄照 dsh 的每輪折疊做：純折疊、從日誌重算、不回寫日誌。屬於甲類，不必拍板 |
| 頂列那顆用量已經寫明「不含子代理與自動摘要」 | 側欄沿用這個做法：**每一個缺口都在格子旁明寫**。例如「不含：失敗或中止的呼叫、自動摘要、生標題、子代理」。不寫的話，讀的人會把下限當成總數 |
| `llm/retry-started.waitedMs` 包在模型時間裡 | 時間分三段：模型（扣掉重試等待）、工具、等待（重試退避加核准）。牆鐘只當參考，不當成本 |
| 沒有單價，端點不回報，型錄價格全填 0 | **不畫錢。** 只畫 token。哪天要算錢，照 T8-09「單價另存、可替換」：token 是主資料，錢是一層可以拿掉的換算 |
| 沒有任何「任務成功」判準；goal 的 complete 是 agent 自報 | 側欄**不畫完成率**，也不把待辦完成幾成或 goal 輪數標成「完成度」（T8-07）。可以並列使用者訊號（點讚點踩）與 agent 自報的 goal 相位，但標明「自報」，不合成一個分數（T8-11 是待決題） |
| 不同會話的模型與 plugin 組不同；標頭不記設定 | 每個成本數字附模型 id，從 `response_metadata.model_name` 讀。不做跨會話排名（T7-07、T8-04） |

### 要先補記錄的（依「補了之後側欄才誠實」排序）

1. **失敗與中止的呼叫要進帳**（T8-09 的核心）。
   - dsh 有 `assistant/attempt`，逐次都算；nexus 的記帳器只記成功回來的那一次（`token-usage.ts:17-19`）。
   - #724 明寫這件事不在它的範圍，**目前沒有卡**。屬於甲類：照 dsh 補，是補缺口，不是新發明。
2. **生摘要與生標題那兩次的 token。**
   - dsh 把摘要的用量記在 `compaction/summary.usage`：`packages/compaction/compaction/src/types.ts:52-53`，對 `5badb15` 讀過原檔，是選填欄位，「當有發出時」才帶。nexus 的 `compaction/summary` 沒有這一格。這屬於甲類，照 dsh 補。
   - 生標題那一次在兩邊都要確認：**待驗**。
3. **子代理接回它所屬那一輪的連結鍵**（M4 第 6 項）。
   - 子代理的標頭可以加上「派它的那顆 `task` 的 `callId`」，或 root 的 `tool/result` 記下子代理日誌的 id。
   - 加之前先查 dsh 的子代理日誌怎麼指回父會話：**待驗**。
4. **#724 照 dsh 分四桶。** 只有要畫快取命中率或算錢時才需要，它自己的重開條件已經寫好。推理 token 要另外開卡，dsh 的每輪折疊有 `reasoningTokens`。
5. **標頭記設定欄位**（T7-10 第五項）：模型路由、plugin 組、迴圈上限。今天這些散在三處。
6. **（乙類，要拍板）`turn/failed` 帶失敗碼**，讓基礎設施失敗跟 agent 失敗分得開（T8-10）。`llm/retry` 已有碼，最後那次失敗卻只剩字串。這條可以順手對照記憶裡〈只剩字串要先查是誰弄丟的〉那條規矩。

### 推論：線上與離線的分工

- 側欄放甲類的每輪與每會話成本，加上明寫的缺口。這解決需求 (3) 的一半。
- 「從真實會話評估」（`session-scan` 的錯誤、打轉、點踩，`draft` 造題）照現行決定留在 CLI。要不要進側欄，是上面那一題。
- 離線評測照 #994 的現況繼續；它的數字（七題當上限）**不應**出現在 web 側欄，免得被讀成「這個 agent 的實力」（`eval-measurement.md:40-66`）。

---

## 後設：否定宣稱的搜尋紀錄

範圍一律是 `apps`、`packages`，排除 `node_modules`；有沒有排除測試檔逐條註明。

| 宣稱 | 搜尋字串 | 範圍 | 結果 |
|---|---|---|---|
| 沒有錢的概念 | `rg -i 'price\|pricing\|costUsd\|usd\|美元\|單價\|計價'` | 排除 `*.test.*` | 3 筆，都無關：`tool-result-pruner.ts:66` 談 dsh 的 `tokenMeter` 計價節點；`http-proxy/install.ts` 的 `previousDispatcher` 是子字串誤中 |
| 快取與推理細項沒人讀 | 沿用 #724 的否定搜尋：`git grep -i -E "cache_read\|…\|prompt_tokens_details"`（對 `ca8cc72`，含測試檔，零筆）。這次另跑 `rg 'usage_metadata\|input_token_details\|cache_read\|cache_creation\|reasoning_tokens\|output_token_details'` | `packages/nexus-core/src`，排除測試 | 只命中讀三個總數的地方（`model-usage.ts`）、搬移 `usage_metadata` 的兩處（`max-tokens.ts:154`、`invalid-tool-args.ts:224`），以及估算錨（`token-estimate.ts:236`） |
| 沒有每輪 token 折疊 | `rg -i 'TurnTokenUsage\|turnUsage\|perTurn\|每輪.*token'` | 含測試 | 只命中 `session-log.ts:455` 的註解，以及 `repeat-reminder.test.ts` 無關的區域變數 |
| 子代理狀態不帶成本 | `rg -i 'token\|ms\b\|elapsed\|duration'` | `nexus-wire/src/subagent-status.ts` | 零筆相關命中 |
| 離線評測沒有 pass^k、McNemar | `rg -i 'pass\^\|passk\|pass@\|mcnemar\|cluster\|category\|類別\|difficulty\|hard'` | `apps/harness/src/eval`，排除測試 | 只命中 `result-file.ts:236` 遮蔽 URL 帳密的註解（`pass@` 子字串誤中），以及 survey 的「難題」分組 |
| web 側欄沒有成本分頁 | 讀了 `lib/right-sidebar.ts:23-35` 的 `SidebarTab` 聯集 | — | 只有 `changes`、`deliverable`、`plan` 三種 |
| 會用到 `tokenUsage` 等的 web 檔案 | `rg -l 'tokenUsage\|sessionStats\|contextPressure\|llmMs\|inputTokens'` | `apps/web/src`，排除測試 | 只有 `context-meter-view.ts`、`session-usage-view.ts`、`App.tsx`、`context-meter.tsx`、`session-usage.tsx` 這 5 個檔 |
| 生標題的呼叫不記帳 | 直接讀 `session-title-llm.ts:40` 的註解 | — | 註解明寫不寫 `model/usage`、`model/start`；沒有另外跑行為驗證 |

### 這份報告沒做的

- 沒有拿真實日誌實算任何一個「任務成本」數字。
- 沒有驗 serve 路徑的 `response_metadata`。
- 沒有讀 dsh 子代理怎麼連回父會話。

以上都標了「待驗」。
