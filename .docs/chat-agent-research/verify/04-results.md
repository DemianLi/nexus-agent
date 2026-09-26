# T4 章節主張的程式驗證結果

章節：[`chapters/04-agent-trajectory.md`](../chapters/04-agent-trajectory.md)。四條候選主張都寫了程式，全部只用 Python 標準函式庫、沒有隨機數，每支都在 0.1 秒內跑完。輸入數字都由程式直接從 `.cache/text/<id>.txt` 解析，或取自 `notes/<id>.json`，沒有手抄，也沒有下載任何資料集或 repo。

| # | 主張 | 論文 | 結論 |
| --- | --- | --- | --- |
| 1 | Who&When 一律猜第 1 步的 step-level 贏過 Table 1 所有方法；一律猜 WebSurfer 與 all-at-once 相當 | [arXiv:2505.00212] | **無法判定**：算術與比較成立，但三個計數要資料集才能驗；另外，論文三種方法的 alg-gen 數字沒有一格能寫成 k/126，「同子集、同條件」這個前提無法由論文數字確認 |
| 2 | TRAIL 的 Location／Joint Accuracy 只量 recall，全部列出可得 1.0；本文沒有定義 | [arXiv:2505.08638] | **無法判定**（核心）：需要官方 `calculate_scores.py`。「本文沒有定義」這一半在快取全文中**證實** |
| 3 | AgentRewardBench 的副作用金標只有約 72 條（6.5%），judge 的 precision 貼近基率 | [arXiv:2504.08942] | **證實**，而且證據比主張寫的更強：加上 precision 約束後 72 是唯一解，Table 8 逐基準加總也對得上，表格之間的鏈也把它綁到 1106 條 test split 上 |
| 4 | Agent-FLAN Table 3 的 w/o NS 列 H_Score 應為 85.45，表中是 84.5 | [arXiv:2403.12881] | **證實**這是單列不一致。「實際效果約 3.65 分」要以「錯的是 H_Score」為前提，光靠表格無法判定 |

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

## 一次跑完

```bash
for f in .docs/chat-agent-research/verify/04-*.py; do echo "== $f"; python3 "$f"; done
```
