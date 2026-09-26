# T4 章節主張的程式驗證結果

章節：[`chapters/04-agent-trajectory.md`](../chapters/04-agent-trajectory.md)。共八條主張寫了程式：主張 1–4 出自精讀筆記的 `limitations_observed`；主張 5–8 大多是撰寫章節時的換算或比對（原本只標「本章」或「對照全文」），在 W4 修訂時補上程式，其中主張 7B（OmegaPRM 的差距，出自 `notes/2406.06592.json`）與主張 8 第 3 條（AgenTracer 的 12/58，出自 `notes/2509.03312.json`）原本出自精讀筆記。全部只用 Python 標準函式庫、沒有隨機數；主張 6 的窮舉約 0.9 秒，其餘每支都在 0.2 秒內跑完。輸入數字都由程式直接從 `.cache/text/<id>.txt` 解析，或取自 `notes/<id>.json`，沒有手抄，也沒有下載任何資料集或 repo。

| # | 主張 | 論文 | 結論 |
| --- | --- | --- | --- |
| 1 | Who&When 一律猜第 1 步的 step-level 贏過 Table 1 所有方法；一律猜 WebSurfer 與 all-at-once 相當 | [arXiv:2505.00212] | **無法判定**：算術與比較成立，但三個計數要資料集才能驗；另外，論文三種方法的 alg-gen 數字沒有一格能寫成 k/126，「同子集、同條件」這個前提無法由論文數字確認 |
| 2 | TRAIL 的 Location／Joint Accuracy 只量 recall，全部列出可得 1.0；本文沒有定義 | [arXiv:2505.08638] | **無法判定**（核心）：需要官方 `calculate_scores.py`。「本文沒有定義」這一半在快取全文中**證實** |
| 3 | AgentRewardBench 的副作用金標只有約 72 條（6.5%），judge 的 precision 貼近基率 | [arXiv:2504.08942] | **證實**，而且證據比主張寫的更強：加上 precision 約束後 72 是唯一解，Table 8 逐基準加總也對得上，表格之間的鏈也把它綁到 1106 條 test split 上 |
| 4 | Agent-FLAN Table 3 的 w/o NS 列 H_Score 應為 85.45，表中是 84.5 | [arXiv:2403.12881] | **證實**這是單列不一致。「實際效果約 3.65 分」要以「錯的是 H_Score」為前提，光靠表格無法判定 |
| 5 | AgentRewardBench Table 3 的排名翻轉：14 組有嚴格順序的配對中，judge 顛倒 2 組、規則式顛倒 4 組 | [arXiv:2504.08942] | **證實**；另找出兩組平手（judge 在 VWA 的 Claude／Qwen、規則式在 VWA 的 GPT-4o／Qwen），章節原文沒寫 |
| 6 | Setlur 的 PAV：依 App D，兄弟步驟用有效獎勵與只用 Q^π 排序完全相同，差別只來自跨父狀態 | [arXiv:2410.08146] | **在 App D 讀法下證實**；§4 另訓 PAV 的說法與此衝突，全文分不出實驗用的是哪一種 |
| 7 | 三個 PRM 表格的重算：Qwen Table 5 合併後排名對調、OmegaPRM 的差距、Lightman OOD 的 224／234 與 ORM 合計 | [arXiv:2501.07301][arXiv:2406.06592][arXiv:2305.20050] | **三項全部證實**；另發現 Qwen 有 5 組配對對調。Lightman 的 PRM 與多數決兩欄用精確分數 k/n 加權後，四捨五入與捨去都相容，分辨不出捨入方式（W4 第一輪拿表上的一位小數加權，誤判成只有捨去對得上，已更正） |
| 8 | AgenTracer Table 1：六格最高、兩格不是；Qwen3 兩格不是 k/58；3.45／3.44 並存；20.68 ≈ 12/58 | [arXiv:2509.03312] | **三條都證實**；另發現 handcraft 有 9 格、automated 有 11 格對不上 k/n |

---

## 主張 1：Who&When 的瑣碎常數基準

**主張**：algorithm-generated 子集（126 條）中有 34 條 mistake_step=1，一律猜第 1 步的 step-level 為 34/126 ≈ 26.98%，高於 Table 1 在該子集的最佳值（step-by-step 有 GT 的 25.51）。hand-crafted 58 條一律猜 WebSurfer 的 agent-level，現行標籤是 33/58、論文當時的標籤是 31/58，與 all-at-once 的 55.17／53.44 相當。

**出處**：[arXiv:2505.00212]，`notes/2505.00212.json` 的 `limitations_observed[0]`。章節第 210 行。

**方法**（[`04-whowhen-trivial-baseline.py`](04-whowhen-trivial-baseline.py)）：

- 從 `.cache/text/2505.00212.txt` 第 217 行取總筆數 184，從第 325–391 行解析 Table 1 的 32 格。
- 34、33、31 這三個計數取自筆記，程式先確認筆記裡確實這樣寫。
- 由 hand-crafted 各格反推分母，得到 alg-gen = 184 − 58。
- 檢查 alg-gen 各格能不能寫成 k/126。
- 做算術與比較，並算穩健度門檻。

**實際輸出（摘要）**：

- **分母**：hand-crafted 的 agent-level 六格全部是 k/58，例如 55.17 = 32/58、53.44 = 31/58。all-at-once 與 step-by-step 的 hand-crafted step-level 則是 k/57。所以 hand-crafted 是 58，alg-gen 是 184 − 58 = 126，與筆記一致。
- **捨入方式不一致**：32.75、53.44 只能用截斷解釋；3.51、6.90、7.02、36.21 只能用四捨五入解釋。
- **算術**：34/126 = 26.98%，高於 alg-gen 所有 step-level 格。那些格由高到低是 25.51、23.98、19.06、16.59、15.31、13.53、12.50，random 也算在內。
- **穩健度**：只要 126 條中有 33 條以上是 mistake_step=1，就會超過 25.51。主張的 34 條比門檻多 1 條。
- **hand-crafted**：
  - 31/58 = 53.45%，與 all-at-once 無 GT 的命中數同為 31 條，比有 GT 的 32 條少 1 條。
  - 33/58 = 56.90%，比兩者各多 2 條、1 條。
- **三種方法的 alg-gen 12 格沒有一格能寫成 k/126**：
  - 例如 25.51 夾在 32/126 = 25.40 與 33/126 = 26.19 之間。
  - 這 12 格在 d ≤ 3000 內找不到共同分母。
  - 只看 step-by-step 四格，共同分母是 196（25.51 = 50/196）。
  - Random 列是解析出來的期望值，不是命中筆數，本來就不必是 k/126，所以不列入證據。

**結論：無法判定。**

- 算術與比較本身成立，也有 1 條的餘裕。
- 核心的三個計數要讀 Who&When 資料集才能驗；依規則不下載，所以無法判定。
- 程式另外發現一件事：Table 1 三種方法的 alg-gen 格不是「單次、在 126 條上算出的簡單比例」。hand-crafted 卻乾淨地落在 k/58。所以「與 Table 1 同子集、同條件」這個前提，無法由論文自己的數字確認。可能的原因包括多次執行的平均，或排除了部分筆數，但程式分辨不出是哪一種，這裡不推論成因。
- 建議章節第 210 行照現在的寫法保留「精讀時依公開標註重算」，並補一句：論文 alg-gen 的百分比不是 k/126，兩邊的分母未必相同。

**重現**：`python3 .docs/chat-agent-research/verify/04-whowhen-trivial-baseline.py`

---

## 主張 2：TRAIL 的定位指標只量 recall、本文沒有定義

**主張**：Location Accuracy 與 Joint Accuracy 的分母是金標集合，不罰誤報，所以把所有 span id 都列為預測，理論上可拿到 Location Accuracy 1.0；論文本文沒有定義這些指標。

**出處**：[arXiv:2505.08638]，`notes/2505.08638.json` 的 `limitations_observed[0]`。章節第 229 行。

**方法**（[`04-trail-metric-definition-scan.py`](04-trail-metric-definition-scan.py)）：

- **前一半**（只量 recall、全部列出可得 1.0）要讀官方 trail-benchmark repo 的 `calculate_scores.py`，並造合成預測去跑。本地沒有這支腳本，依規則不下載，所以程式不處理這一半。
- **後一半**（本文沒有定義）掃 `.cache/text/2505.08638.txt`：
  - 名稱樣式涵蓋 `Loc. Acc.`、`Location Acc`、`Location Accuracy`、`Joint`、`joint accuracy`、`Localization`、`Cat. F1`、`Categ. F1`、`Category F1`。
  - 對每個命中，檢查前後各 2 行有沒有定義句型：`defined as`、`we define`、`computed as`、`fraction`、`proportion`、`ratio`、`number of`、數學式中的等號、式子編號等。
  - 另外做一道補充掃描，找不提指標名稱、但描述「預測與金標比對」的句子。
- **正向對照**，確保「找不到」不是量具的問題：
  - 對照一：TRAIL 全文要保留行內數學式。
  - 對照二：同一支掃描器要能在 Agent-FLAN 全文裡抓到 H_Score 的定義。那篇確實有定義，文字與式 (1) 都有。

**實際輸出（摘要）**：

- **對照一成立**：TRAIL 全文保留了 11 個行內數學式，例如第 266 行的 `$\rho$`、第 506 行的 `$r$`、第 1407 行的 `$\tau$`。
- **對照二成立**：掃描器在 Agent-FLAN 第 344–350 行抓到 `we define`、`number of`、數學式等號與式子編號。
- **主掃描**：TRAIL 全文共有 22 處名稱命中，**沒有一處附近出現定義句型**。22 處分成這幾類：
  - 標題與 Localization 的 5 處（第 1、4、19、69、352 行）
  - Table 1 表頭（第 263–269 行）
  - Table 3 表頭（第 502–504 行）
  - Table 4 表頭（第 1561–1563 行）
  - 結果敘述（第 94、530、536、541、564 行）
- **補充掃描**：命中 6 處，逐條人工判讀都不是指標定義：
  - 第 93 行：引言
  - 第 391 行：研究問題
  - 第 543、546 行：分類 F1 的結果討論
  - 第 1791 行：rubric 相關係數的 Table 6 caption
  - 第 1924 行：給模型的提示詞說明
- 評估設定只寫了選哪些模型、temperature 與 top_p，沒有指標公式。評估設定在 §4.4（第 372–375 行）與 §A.3（第 1545–1551 行）。

**結論：無法判定（核心）；「本文沒有定義」這一半證實（範圍：快取全文）。**

- 「只量 recall、全部列出可得 1.0」要讀並執行官方評分腳本，依規則不下載，所以無法判定。
- 「論文本文沒有定義 Location／Joint Accuracy」：在 `.cache/text/2505.08638.txt`（arxiv-html 轉出，含附錄）中找不到任何定義。量具已用兩個正向對照確認不是鈍的。
- 這個結論的範圍是「快取全文找不到」，不涵蓋 PDF 版可能多出的內容。
- 附帶一點：Table 1 中 Joint 恆 ≤ Loc，這分辨不出指標是 recall 型還是 precision 型，所以不拿它當證據。

**重現**：`python3 .docs/chat-agent-research/verify/04-trail-metric-definition-scan.py`

---

## 主張 3：AgentRewardBench 的副作用金標只有約 72 條

**主張**：Table 7 各 judge 的副作用 recall 都能寫成 k/72，推得測試集（1106 條）中只有約 72 條（約 6.5%）被標為有副作用。GPT-4o mini (A) 的副作用 precision 7.2 幾乎等於這個基率，最佳 precision 只有 14.1（Claude 3.7 (S)）。

**出處**：[arXiv:2504.08942]，`notes/2504.08942.json` 的 `limitations_observed[2]`。章節第 233 行。

**方法**（[`04-arb-side-effect-base-rate.py`](04-arb-side-effect-base-rate.py)）：

- 從 `.cache/text/2504.08942.txt` 解析以下輸入：
  - test split 大小：第 224、1247 行的「1106 in the test split」
  - Table 7：第 1413–1571 行
  - Table 8：第 1573–2309 行
- **步驟 1**：只看 recall，對 d = 1..1106 找出相容的分母。
- **步驟 2**：加上 precision 與 F1 約束。對每個 judge，要找得到整數 TP 與「預測為有副作用的筆數」pred，同時滿足以下條件：
  - TP ≤ pred ≤ 1106
  - round(100·TP/d, 1) = R
  - round(100·TP/pred, 1) = P
  - round(200·TP/(pred + d), 1) = F1
- **步驟 3**：用 Table 8 做獨立佐證，把逐基準的最小分母與逐 judge 的 TP 加總起來比。
- **步驟 4**：原文沒有明說 Table 7／8 是在哪個 split 上算的（全部 1302 條 = 開發 196 + 測試 1106），所以用表格之間的鏈來確認：
  - Table 6（第 1285–1411 行）是各 agent 的成功率。每個 agent 在各基準的測試筆數取自筆記 `limitations_observed[4]`：AssistantBench 27、VisualWebArena 92、WebArena 78、WorkArena 16、WorkArena++ 87。另外，Llama 3.3 不跑 VisualWebArena、WebArena 少兩題（第 1244–1246 行）。這些筆數當成假設，檢查兩件事：加總是否為 1106，Table 6 各格是否都是 k/n。
  - Table 8 各基準「成功」recall 的分母，應等於 Table 6 專家判為成功的條數加總。
  - 另外把 pred 的上限放寬到 1302（含開發集），再跑一次唯一性檢查。
- **步驟 5**：算基率，以及每個 judge 的 P ÷ 基率。

**實際輸出（摘要）**：

- **只看 recall**：1..1106 中有 247 個 d 相容，最小的是 72，而且 72 的倍數全部相容。所以單憑 recall 只能說「72 是最小可能」，不能說「只有 72」。任務給的驗法停在這一步，並不足夠。
- **加上 precision／F1 後只剩 d = 72**：
  - d = 144 時，GPT-4o (A)、GPT-4o (S)、GPT-4o Mini (A)、Llama 3.3 (A) 都需要超過 1106 筆預測，被排除。
  - d = 216 時，被排除的 judge 更多。
- **d = 72 時每個 judge 的 TP 都唯一**：Claude (A) 25、Claude (S) 32、GPT-4o (A) 66、GPT-4o (S) 65、GPT-4o Mini (A) 51、GPT-4o Mini (S) 23、Llama 3.3 (A) 57、Qwen (A) 40、Qwen (S) 42。
- **幾乎全部標「有」**：GPT-4o (A) 的 pred 是 855–860，約有 77% 的測試軌跡被它標成有副作用；GPT-4o (S) 約 78%，Llama 3.3 (A) 約 75%。
- **Table 8 佐證**：
  - 五個基準的副作用 recall 最小分母分別是 AssistantBench 3、VisualWebArena 28、WebArena 21、WorkArena 2、WorkArena++ 18，**加總 72**。
  - 九個 judge 跨基準的 TP 加總，與 Table 7 在 d = 72 時的 k **全部一致**。
- **split 鏈**：
  - Table 6 各格筆數加總剛好是 **1106**。38 個 Expert／LLM Judge 值中有 37 個是 k/n；唯一的例外是 WorkArena++ 的 Llama 3.3 LLM Judge 5.8，它是 k/86，少一條。
  - Table 6 專家成功條數加總，逐基準是 AssistantBench 8、VisualWebArena 79、WebArena 119、WorkArena 37、WorkArena++ 52。Table 8 的成功 recall 在前四個基準 13/13 個 judge 都是 k/該數。WorkArena++ 是 12/13，例外的 Claude 3.7 S. (A) 62.7 是 k/51，也是少一條。
  - 所以 Table 7／8 與 Table 6 是同一批 1106 條 test split 軌跡。兩個例外都只差一條，推測是個別 judge 的輸出無法解析，未證實。
  - pred 上限放寬到 1302 時，相容的 d 仍然只有 72。
- **基率**：72/1106 = 6.51%。各 judge 的 P ÷ 基率：

  | judge | P ÷ 基率 |
  | --- | --- |
  | Claude 3.7 S. (S) | 2.17 |
  | Claude 3.7 S. (A) | 2.15 |
  | Qwen2.5-VL (A) | 1.38 |
  | Qwen2.5-VL (S) | 1.35 |
  | GPT-4o (A) | 1.18 |
  | GPT-4o (S) | 1.15 |
  | GPT-4o Mini (A) | 1.11 |
  | Llama 3.3 (A) | 1.06 |
  | GPT-4o Mini (S) | 1.01 |

  7.2 與 14.1 兩個值核對無誤，最佳者確實是 Claude 3.7 S. (S)。

**結論：證實。**

- 72 不只是最小相容分母，而是在「預測筆數不能超過測試集」的約束下**唯一**的解，而且 Table 8 的逐基準加總獨立地得到同一個數。
- GPT-4o mini (A) 的 precision 只有基率的 1.11 倍，GPT-4o Mini (S) 與 Llama 3.3 (A) 更接近基率（1.01、1.06 倍）。
- 「6.5%」以 test split 為分母。論文沒有明寫，但上面的 split 鏈把 Table 7／8 綁到了這 1106 條上；若改用全部 1302 條，72 仍是唯一解。
- 保留一點：1106 是 pred 的上限。split 鏈顯示少數 judge 有個別軌跡沒有計分，實際計分的筆數可能略少，這只會讓約束更嚴，不改變結論。
- 章節第 233 行沒有提「最佳 precision 只有 14.1」，這一點也已核對，要補進章節時可以直接引用。

**重現**：`python3 .docs/chat-agent-research/verify/04-arb-side-effect-base-rate.py`

---

## 主張 4：Agent-FLAN Table 3 的 w/o NS 列 H_Score

**主張**：依 H_ReAct 15.6、H_General 13.5 重算，w/o NS 的 H_Score 應為 85.45，表中卻是 84.5。同一公式能算回其他列，所以是單列不一致而不是公式讀錯。負樣本的實際效果可能只有 89.1 − 85.45 = 3.65 分，而非 4.6 分。

**出處**：[arXiv:2403.12881]，`notes/2403.12881.json` 的 `limitations_observed[1]`。章節第 159、402 行。

**方法**（[`04-agentflan-hscore.py`](04-agentflan-hscore.py)）：

- 從 `.cache/text/2403.12881.txt` 解析以下輸入：
  - 式 (1)：第 348 行
  - Table 3：第 363–396 行
  - Table 1：第 179–255 行
- 以 H_Score = 0.5 × ((100 − H_ReAct) + (100 − H_General)) 重算四列。
- **容忍度**：輸入與表值都四捨五入到 0.1，合計容忍 0.1。
- **列舉其他讀法**，看有沒有一種能同時對上四列：式 (1) 字面的 100 − H_ReAct、只用 H_General、取較大者、兩項相加。
- 附帶核對 Table 1 的 Overall 與 AgentTuning* 的 Agent-H。

**實際輸出（摘要）**：

- **兩項平均的讀法**：Llama2-7B 78.65（表值 78.7）、AgentTuning 83.95（表值 83.9）、Agent-FLAN 89.10（表值 89.1），三列都相容；**w/o NS 85.45 對表值 84.5，差 0.95**，不相容。
- **其他讀法沒有一種能對上四列**：
  - 式 (1) 字面的 100 − H_ReAct 只對上 w/o NS（84.4，剛好落在容忍邊界），其他三列都對不上（78.3、81.9、90.1）。
  - 其餘讀法最多對上 1 列。
- **反推**：若 84.5 是對的，H_ReAct + H_General 應為 31.0，表中是 15.6 + 13.5 = 29.1。
- **負樣本效果**：照表值是 89.1 − 84.5 = 4.60，照重算是 89.1 − 85.45 = 3.65。
- **Table 1**：七個模型的 Overall 都與五個 Held-Out 欄的平均相容。AgentTuning* 的 Agent-H 在 Table 1 是 84.5、在 Table 3 是 83.9，T-Eval 兩表都是 61.8。但兩個 Agent-H 值算出的 Overall 都與 38.2 相容：84.5 差 0.042，83.9 差 0.078，容忍 0.091。所以 Overall 分辨不出哪一個才是原值。

**結論：證實（單列不一致）；「實際效果約 3.65 分」無法判定。**

- 「兩項平均」對上其他三列，而沒有任何讀法能對上四列，所以這是 w/o NS 單列的不一致，不是公式理解錯誤。
- 主張寫「算回 Llama2-7B 的 78.65」：重算值是 78.65，表上印的是 78.7，兩者在捨入容忍內相容。
- 「負樣本效果只有約 3.65 分」要以「子指標正確、H_Score 印錯」為前提。表格本身分辨不出錯的是 H_Score 還是兩個子指標；主張用的是「可能」，措辭恰當。
- 有兩個巧合只列出、不推論成因：
  - 照式 (1) 的筆誤寫法算這一列會得到 84.4，貼近 84.5。
  - Table 1 的 AgentTuning* Agent-H 也是 84.5。

**重現**：`python3 .docs/chat-agent-research/verify/04-agentflan-hscore.py`

---

## 主張 5：AgentRewardBench Table 3 的排名翻轉

**主張**：把 Table 3 的所有 agent 配對都算進來，排除 Llama 3.3 沒跑的 VisualWebArena（VWA）與專家平手的一對後，剩 3 + 6 + 5 = 14 組有嚴格順序的配對；GPT-4o judge 顛倒 2 組、規則式顛倒 4 組。所以論文「規則式翻轉排名」站得住，精讀筆記「judge 也一樣翻轉」的批評只在 GPT-4o 對 Qwen2.5-VL 這一對上成立。

**出處**：[arXiv:2504.08942]。被重數的批評是 `notes/2504.08942.json` 的 `limitations_observed[0]`；「14 組、2 組、4 組」是撰寫章節時的換算。章節〈排名翻轉：規則式與 judge 都會〉。

**方法**（[`04-arb-ranking-flips.py`](04-arb-ranking-flips.py)）：

- 從 `.cache/text/2504.08942.txt` 的「## 5 Revisiting how we evaluate task success rate」到「Table 3:」caption 之間解析表格：4 個 agent × 專家、GPT-4o judge、規則式三組 × VWA、WA、Wk++ 三欄。
- 以全文第 214 行「Llama-3.3 is a text-only model, it was excluded from VisualWebArena」為依據，排除 Llama 3.3 × VWA。
- 每個基準取所有兩兩配對，專家成功率相同的配對排除；其餘配對，judge 或規則式順序與專家相反記為顛倒，相等記為平手。
- 另找出論文自己「ranks Qwen2.5-VL above GPT-4o on WebArena and WorkArena++ (and equally on VWA)」那句，與程式數出的結果對照。

**實際輸出（摘要）**：

- 有嚴格順序的配對 3 + 6 + 5 = 14 組；專家平手而排除的是 Wk++ 的 Claude 3.7 S. 對 GPT-4o（都是 18.4）。
- GPT-4o judge 顛倒 2 組，都在 GPT-4o 對 Qwen2.5-VL：WA 專家 42.3 對 33.3、judge 50.0 對 52.6；Wk++ 專家 18.4 對 13.8、judge 11.5 對 14.9。
- 規則式顛倒 4 組：VWA 的 Claude 對 GPT-4o（專家 28.3 對 35.9，規則式 23.9 對 17.4）、WA 的 GPT-4o 對 Qwen（25.6 對 29.5）、Wk++ 的 Claude 對 Qwen（8.1 對 11.5）、Wk++ 的 GPT-4o 對 Qwen（4.6 對 11.5）。
- 平手：judge 在 VWA 把 Claude 與 Qwen 都判成 34.8（專家 28.3 對 21.7）；規則式在 VWA 把 GPT-4o 與 Qwen 都判成 17.4（專家 35.9 對 21.7），這正是論文說的「equally on VWA」。
- GPT-4o 對 Qwen2.5-VL 這一對，judge 與規則式都在 WA、Wk++ 顛倒。

**結論：證實（章節需補上兩組平手）。** 章節〈排名翻轉〉已補上兩組平手與程式驗證的標記。

**重現**：`python3 .docs/chat-agent-research/verify/04-arb-ranking-flips.py`

---

## 主張 6：Setlur 的 PAV 兄弟排序

**主張**：依 App D 的讀法，BoK(π) 的 Q 值由同一個 Q^π 模型以 1 − (1 − Q^π)^K 換算；從同一個父狀態展開的兄弟步驟共用父項，而 q + α(1 − (1 − q)^K) 對 q 嚴格遞增，所以兄弟之間用有效獎勵排序和只用 Q^π 排序完全相同，「相對 Q^π beam search 省 8×」只能來自跨父狀態時 beam 名額的重新分配。

**出處**：[arXiv:2410.08146]。App D 的換算讀法出自 `notes/2410.08146.json`；「兄弟排序不變」是撰寫章節時的推論。章節〈Setlur 的 advantage 證據比篇幅薄〉。

**方法**（[`04-pav-sibling-order.py`](04-pav-sibling-order.py)）：

- 先在 `.cache/text/2410.08146.txt` 找出五句前提，找不到就停：App D 換算式（第 1057 行）、beam search 對所有新狀態打分後只留前 B 名（第 173 行）、Eq. 2 的差分形 advantage（第 212 行）、α 取 0.5（2B、9B）與 0.2（27B）（第 1019 行）、prover 用 K = 4（第 386 行）。另外找出衝突句：§4 說另外訓練一個 PAV 預測 A^μ（第 371 行）。
- 單調性：在 q ∈ {0, 1/1000, …, 1} 上以分數精確計算 f(q) = q + α(1 − (1 − q)^K)，α ∈ {0.2, 0.5}、K ∈ {1, 2, 4, 8, 16, 32}。
- 兄弟排序：q 取 0 到 1、間隔 0.05 的 21 個格點，窮舉三個互異的兄弟（21 × 20 × 19 = 7980 組有序三元組）、父項的 21 個格點與兩個 α，共 2 × 21 × 7980 = 335160 組，比較兩種打分的排序。這一步用浮點數以求在十秒內跑完。
- 跨父狀態：兩個父狀態各兩個子步驟、B = 2，要求父狀態的值落在它兩個子步驟的 Q 之間，找出兩種打分選出不同 beam 的例子。

**實際輸出（摘要）**：

- 五句前提與衝突句都找到。
- 單調性：兩個 α、六個 K 全部嚴格遞增（解析上導數 1 + αK(1 − q)^(K−1) 恆大於 0，格點檢查只是確認式子沒寫錯）。
- 兄弟排序：335160 組中 0 組不同。
- 跨父狀態的例子（α = 0.5、K = 4）：父狀態 s1 的 Q^π = 0.00，兩個子步驟 0.00 與 0.10；s2 的 Q^π = 0.20，兩個子步驟 0.20 與 0.30。只用 Q^π 選的是 s2 的兩個子步驟；用有效獎勵選的是 s1 的 0.10（有效獎勵 0.2720）與 s2 的 0.30（0.3848），s2 的 0.20 因為父項相同、advantage 為 0 而落選（有效獎勵 0.2000）。

**結論：在 App D 讀法下證實。**

- 兄弟之間兩種打分的排序完全相同；兩種打分只在跨父狀態比較時選出不同的 beam。
- 保留：§4 同時說另外訓練一個 PAV 預測 A^μ。若實驗實際用的是那個獨立模型，兄弟排序就不必相同；全文分不出是哪一種，所以結論只在 App D 的讀法下成立。章節已照此改寫。

**重現**：`python3 .docs/chat-agent-research/verify/04-pav-sibling-order.py`

---

## 主張 7：三個 PRM 表格的重算

**主張**：
- A. Qwen Table 5（「答案對、過程錯」子集）的 Avg. 欄是四個子集的算術平均；按題數合併後，Skywork-PRM-7B 與 EurusPRM-Stage2 的排名對調。
- B. OmegaPRM 在四組 policy × 資料集上比多數決多 2.2／3.5／0.9／1.6 點，比 PRM800K 多 1.8／1.0／0.7／0.5 點。
- C. Lightman 的 OOD：正文說 224 題，Table 1 各科相加是 234；按題數重算 ORM 合計約 63.50，表中是 63.8。另問 PRM 與多數決兩欄分不分得出表格用哪種捨入。

**出處**：[arXiv:2501.07301][arXiv:2406.06592][arXiv:2305.20050]。A 與 C 是撰寫章節時的換算，B 出自 `notes/2406.06592.json` 並由章節逐格相減。章節〈彙總與正規化方式會改變頭條〉〈增益多半來自投票〉〈論文正文與自己的表格對不上〉。

**方法**（[`04-prm-table-recompute.py`](04-prm-table-recompute.py)）：

- A：從 `.cache/text/2501.07301.txt` 解析 Table 5 的題數列與 11 個 PRM 的四格加 Avg.；檢查 Avg. 是否等於算術平均、每格能否寫成 k/n，再按題數合併重算，比較 11 × 10 ÷ 2 = 55 組配對在兩種彙總下的順序。
- B：從 `.cache/text/2406.06592.txt` 解析 Table 1，逐格相減。
- C：從 `.cache/text/2305.20050.txt` 解析 OOD 表，檢查每格能否寫成 k/n。按題數加權重算三欄時，能寫成 k/n 的格子用精確分數，其餘格子用表上的一位小數並給 ±0.05 的捨入誤差，得到合計的區間；四捨五入相容的條件是區間與 [t − 0.05, t + 0.05) 有交集，捨去相容的條件是區間與 [t, t + 0.1) 有交集，結論字串由這兩個布林值產生，不寫死。另列直接拿表上一位小數加權的舊算法當對照，並在同樣的區間規則下列出「ORM 只錯一格」就能對上 63.8 的候選。

**實際輸出（摘要）**：

- A：題數 7／94／161／259，共 521 題；Avg. 在 11 列都等於算術平均；11 × 4 = 44 格都是 k/n。Skywork-PRM-7B 算術平均 27.8、合併 16.51，EurusPRM-Stage2 算術平均 27.4、合併 21.50。55 組配對中 5 組排名對調：Skywork-PRM-1.5B 對 Skywork-PRM-7B、Skywork-PRM-1.5B 對 EurusPRM-Stage1、RLHFlow-PRM-Mistral-8B 對 RLHFlow-PRM-Deepseek-8B（算術 11.4 對 9.7，合併 10.0 對 11.7）、Skywork-PRM-7B 對 EurusPRM-Stage1、Skywork-PRM-7B 對 EurusPRM-Stage2。
- B：OmegaPRM − 多數決 = [2.2, 3.5, 0.9, 1.6]，OmegaPRM − PRM800K = [1.8, 1.0, 0.7, 0.5]。
- C：各科 45 + 60 + 45 + 84 = 234，Aggregate 列也寫 234。Calculus、Physics 三欄與 Chemistry 的 PRM、多數決都是 k/n（例如 PRM 39/45、48/60、39/45，多數決 36/45、43/60、37/45）；Chemistry 的 ORM 68.9 不是任何 k/60，AMC10/12 三格都不是任何 k/84。
  - ORM：(31 + 0.689 × 60 + 35 + 0.491 × 84) / 234 = 63.497，區間 63.467–63.528，四捨五入與捨去都對不上 63.8。
  - PRM：(39 + 48 + 39 + 0.532 × 84) / 234 = 72.944，區間 72.926–72.962，四捨五入與捨去都相容於 72.9。
  - 多數決：(36 + 43 + 37 + 0.328 × 84) / 234 = 61.347，區間 61.329–61.365，四捨五入與捨去都相容於 61.3。
  - 對照：直接拿表上的一位小數加權時，PRM 72.956、多數決 61.351，四捨五入會變成 73.0 與 61.4，於是只剩捨去對得上；這是顯示值自帶的捨入誤差（例如 86.7 對 39/45 ≈ 86.667）把合計從 72.944 推過 72.95、從 61.347 推過 61.35 的結果，程式把這兩欄列為「與精確分數的結論不同」。
  - 若 ORM 只錯一格，能讓合計的區間對上 63.8 的有 4 個：Calculus 改成 32/45、Chemistry 改成 42/60、Physics 改成 36/45、AMC 改成 42/84。

**結論：三項全部證實。**

- A 另發現對調的不只章節點名的那一對，55 組中有 5 組。
- C 的 ORM 一半證實；PRM 與多數決那一半在 W4 第一輪寫成「只在捨去時對得上」，是拿顯示值加權的錯，改用精確分數後兩種捨入都相容，分辨不出表格用哪一種。章節〈論文正文與自己的表格對不上〉與〈程式驗證〉已同步改寫。
- C 的「只錯一格」候選只是與數字相容的可能：AMC 三格都不是 k/84，可見各格未必是單純的「答對題數 ÷ 題數」，所以不能當成 63.8 的來源。章節只寫「無法由表格反推」。

**重現**：`python3 .docs/chat-agent-research/verify/04-prm-table-recompute.py`

---

## 主張 8：AgenTracer Table 1 的逐格比較與分母

**主張**：
1. 八格（兩子集 × agent／step 層級 × 有／無 GT）中有六格是 AgenTracer 最高；automated 無 GT 的兩格不是：agent-level 63.73 低於 DeepSeek-R1 的 65.08，step-level 37.30 低於 Claude-Sonnet-4 的 38.83。
2. handcraft 欄中 Qwen3-8B 42.10、Qwen3-32B 44.80 不是任何 k/58；表中 3.45 與 3.44 並存、都對應 2/58。
3. AgenTracer 的 handcraft step-level 20.68 約是 12/58。

**出處**：[arXiv:2509.03312]。第 1、2 條原本只寫「本章對照全文」，第 3 條出自 `notes/2509.03312.json` 的 `limitations_observed`。子集大小取自 [arXiv:2505.00212] 的筆記。

**方法**（[`04-agentracer-table1.py`](04-agentracer-table1.py)）：

- 從 `.cache/text/2509.03312.txt` 的「Table 1: Performance comparison on the Who&When benchmark」caption 到「## 5 Experiments」解析 9 個模型 × 4 欄 × 有／無 GT。
- hand-crafted 58 條、algorithm-generated 126 條取自 `notes/2505.00212.json`；Who&When 全文只寫總數，程式另找出「culminating in 184 distinct failure annotation tasks」，確認 58 + 126 = 184。
- 逐格找最高；每格檢查能否寫成 k/n（四捨五入或捨去到兩位小數）；列出所有對應 2/58 的格。

**實際輸出（摘要）**：

- AgenTracer 在 6/8 格最高；不是最高的兩格正如主張。
- handcraft 欄 9 × 4 = 36 格中 9 格不是任何 k/58：Qwen3-8B 的 42.1 與 39.5、Qwen3-32B 的 44.8 與 44.8、Qwen3-Coder 的 60.35、DeepSeek-R1 step 的 13.29、Gemini-2.5-pro step 的 9.72，以及 AgenTracer 自己 agent-level 的 69.1 與 63.82。
- automated 欄 9 × 4 = 36 格中 11 格不是任何 k/126，包括 AgenTracer 自己 agent-level 的 69.62 與 63.73。
- 對應 2/58 的格：Qwen3-8B 與 Llama-3.2-3B 的 3.45（四捨五入）、GPT-4.1 的兩格 3.44（捨去）。
- 20.68 只能寫成 12/58（捨去；12/58 = 20.6897）。

**結論：三條主張都證實，另發現 handcraft 欄還有其他格不是 k/58。** 章節已把「本章對照全文」改成程式驗證，並補上 9 格與 11 格的發現：以條數換算的讀法（例如「只差 1–2 條軌跡」）只對能寫成 k/58 的格子成立。

**重現**：`python3 .docs/chat-agent-research/verify/04-agentracer-table1.py`

---

## 一次跑完

```bash
for f in .docs/chat-agent-research/verify/04-*.py; do echo "== $f"; python3 "$f"; done
```
