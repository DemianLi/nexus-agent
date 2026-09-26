# T1 章節主張的程式驗證結果

對象：[`chapters/01-goal-intent.md`](../chapters/01-goal-intent.md)。八條主張分兩批：

- 第 1–4 條來自精讀筆記的 `limitations_observed`，也就是精讀 agent 自己算出來、沒有經過同儕審查的那一類。
- 第 5–8 條是 W4 評審指出、章節數字比對工具驗不到的主張：一條是本章推翻筆記結論的重算（MCT 增益），三條是全表計數或全表加總。

八條都能用論文表格裡的數字驗。

| # | 主張 | 程式 | 結論 |
| --- | --- | --- | --- |
| 1 | IN3 模糊判斷準確率低於多數類 [arXiv:2402.09205] | `01-in3-vagueness-majority.py` | **證實** |
| 2 | Future Turns 的 Ambig Acc 低於多數類 [arXiv:2410.13788] | `01-ambigqa-ambig-acc-majority.py` | **證實**（有條件，見下） |
| 3 | 2310.10176 Table 5 的 ChatGPT GID 欄是 3:1 的數字 [arXiv:2310.10176] | `01-gid-table5-ratio.py` | **證實**（數字部分）；「站不太住」屬判斷，數字顯示差距是一增一減，不是全面較弱 |
| 4 | 2010.05256 標籤數準確率與平凡基準打平 [arXiv:2010.05256] | `01-label-count-trivial-baseline.py` | **證實**（有條件：逐領域簡單平均） |
| 5 | 2010.05256 的 MCT 增益要看拿哪一個「不含 MCT」當對照，而且 Table 4 只有 Electra，筆記依據的 BERT 增益 2.10 到 6.20 不能和它比 [arXiv:2010.05256] | `01-mct-gain-embedder.py` | **證實**；筆記「真實增益遠小於 Table 4」只在 StanfordLU 成立 |
| 6 | 2311.09469 Table 4 的全表計數：b=10% 平均、兩種熵方法低於隨機的格數、AUROC 範圍與低於 0.5 的格數 [arXiv:2311.09469] | `01-intentsim-table4-counts.py` | **證實**；Semantic Entropy 也有 8 格低於、1 格等於隨機 |
| 7 | 2305.07157 Table 5：意圖過濾讓 in-scope accuracy 多半下降，OOS recall 只對 GPT-3 上升 [arXiv:2305.07157] | `01-intent-filter-table5.py` | **證實** |
| 8 | 2410.12361：Precision＋False-Alarm＝100，Recall 近於 1 的七列 F1 排名與 Precision 排名相同 [arXiv:2410.12361] | `01-proactive-precision-falsealarm.py` | **證實**；「Recall＝1」只是近似 |

共同做法：

- 只用 Python 標準函式庫，沒有隨機數，每支執行不到 0.1 秒（Python 3.9.19）。
- 每個輸入數字都以原文字串的形式寫在程式裡，**數字由那串字解析出來**，同一串字也拿去 `.cache/text/<id>.txt` 做錨點比對（把全文的空行去掉、空白壓成一格後做子字串比對）。找不到錨點時結論一律印「無法判定」。`.cache/` 不進版控，沒有快取時程式會略過錨點檢查，照樣算。
- 第 5、6 條的判定式：Intent-Sim 那支把章節寫的計數與範圍寫成常數，逐項和算出的值比，全部相符才判「證實」；MCT 那支除了增益的方向，也把 BERT 增益範圍與「Table 4 不是 BERT 版」納入判定。這兩支的結論字串由算出的值組成。
- 量具校準（突變測試）：2026-09-26 重做，逐條清單見文末〈突變校準〉。第 1–4 條依序 3＋3＋3＋2＝11 種，第 5–8 條依序 3＋4＋2＋3＝12 種（MCT 3 種、Clarify When Necessary 4 種、Table 5 2 種、Proactive Agent 3 種），合計 11＋12＝23 種。沒有快取時，23 種都讓結論翻成「推翻」；有快取時，23 種都先被錨點擋下，結論印「無法判定」。未突變的原檔在兩種設定下都印「證實」、exit 0。

重現（在 repo 根目錄）：

```bash
for f in .docs/chat-agent-research/verify/01-*.py; do python3 "$f"; done
```

---

## 1. IN3 的模糊判斷準確率低於多數類

**主張**：IN3 測試集 108 題中 95 題模糊，一律判模糊的準確率是 95/108＝87.96%，比 Mistral-Interact 的 85.19%（92/108）與 GPT-4 的 82.41%（89/108）都高，所以這張表無法說明模型學會「何時不該問」。出處是筆記 `2402.09205.json` 的 `limitations_observed` 第 1 條，以及章節〈陷阱一〉IN3 條。

**方法**：輸入取自 `.cache/text/2402.09205.txt`，包括 Table 1 Test 欄（108／95／13）、Table 3 的 Vagueness Judgement Accuracy 列（四個模型），以及附錄 E.3 式 (1)（分母是全部測試題 |T|）。檢查項目如下：

- 組成相加是否等於 108。
- 各準確率 × 108 是否落在整數上。
- 95/108 是否高於每個模型。
- 答對 k 題時，「清楚題放行幾題」的可行範圍：TN ∈ [max(0, k−95), min(13, k)]。

**實際輸出（摘要）**：

- 95＋13＝108；多數類基準 87.96%，一律判清楚是 12.04%。
- 四個準確率都精確落在 k/108 上：Mistral-7B 53、LLaMA-2-7B 86、GPT-4 89、Mistral-Interact 92。這證實分母確實是 108。
- 多數類減各模型，依序是 +38.89、+8.33、+5.55、+2.77，四個模型全部低於基準。Mistral-Interact 比基準少答對約 3 題。
- 四個模型的清楚題放行數，可行範圍都是 **0 到 13 題（0%–100%）**。所以答對 92 題，與「清楚題全部放行」「一題都沒放行」兩個極端都相容。

**結論：證實。** 章節「答對 92 題與兩種極端都相容」的核算也一併成立。

**重現**：`python3 .docs/chat-agent-research/verify/01-in3-vagueness-majority.py`

---

## 2. Future Turns 的 Ambig Acc 低於多數類

**主張**：Ambig Acc 53.7／54.0／54.3（Llama2／Llama3／Gemma）低於「一律判模糊」的多數類基準 1,172 ÷ 1,960 ≈ 59.8%。這條的前提是分母為整個測試集。依同一前提，直接回答比例為 p 時，隨機決策的期望值是 p×788/1960＋(1−p)×1172/1960，與論文的 Random 相差不到 1 點。出處是筆記 `2410.13788.json` 的 `limitations_observed` 第 3 條，以及章節〈陷阱一〉Future Turns 條。

**方法**：輸入取自 `.cache/text/2410.13788.txt`：

- §4 的 n=1960，未模糊 788、模糊 1,172。
- §5.1 的 Ambig Acc 定義與 Random 基準做法：固定 DA%，隨機抽題直接回答。
- Table 4（Llama2）與 Table 6（Llama3、Gemma）的 DA% 與 Ambig Acc。

判定分兩步：

1. 第一步：三個 Ours 是否都低於 1172/1960。
2. 第二步：把各 DA% 代入期望公式，看與 Random 是否相差不到 1 點。

補充的檢查不影響判定，有三項：

- 用超幾何分布算出 Random 的標準差。
- 換成另外三種分母（只算模糊題、只算未模糊題、balanced accuracy），各算一次 Random 的期望與標準差，再把三列合併做卡方檢定（自由度 3）。卡方右尾函式已先校準：7.815 對應 0.0500，11.345 對應 0.0100。
- 由 Ours 的數字反推直接回答的題中有多少是未模糊題。

**實際輸出（摘要）**：

- 第一步：多數類 59.80%。Ours 53.7／54.0／54.3，分別低 6.10／5.80／5.50 點。表中其他方法也全部低於它，連最高的 Llama2 Ours w/ PPDPP 59.0 都低 0.80，Gemma PPDPP 56.7 低 3.10。
- 第二步：Random 期望 51.18／51.37／52.35，報告值 52.1／51.1／52.1，差 +0.92／−0.27／−0.25 點，三列都不到 1 點。單次抽樣的 SD 約 1.1 點，這三個差距只有 +0.84／−0.25／−0.23 SD。
- 補充的分母比較：

  | 分母 | 三列合併 χ²(3) | p | 這個分母下「一律提問」的基準 | Ours 是否低於它 |
  | --- | --- | --- | --- | --- |
  | 全集 | 0.81 | 0.846 | 59.80 | 是 |
  | 只算模糊題 | 180.36 | 7e-39 | 100.00 | 是 |
  | 只算未模糊題 | 181.39 | 4e-39 | 0.00 | 否 |
  | balanced accuracy | 7.83 | 0.0497 | 50.00 | **否** |

- 反推的結果：Ours 直接回答的題中，未模糊題約占 43.1%／43.3%／42.8%，隨機抽的期望是 40.2%，只比隨機高 2.6–3.1 個百分點。這佐證了筆記「提問決策與模糊標籤幾乎無關」的說法。

**結論：證實，但有條件。**

- 兩步都成立，章節的算式也逐字對得上（51.2／51.4／52.4）。
- 「分母為全集」在四種讀法裡最吻合（p＝0.85），「只算模糊題」「只算未模糊題」都被排除。
- **balanced accuracy 在 1% 水準排除不掉**（p＝0.0497，剛好卡在 5% 邊界）。如果 Ambig Acc 其實是 balanced accuracy，「一律提問」只有 50%，Ours 就高於它，主張不成立。
- 論文用的詞是 "accuracy"，Random 的數字也明顯偏向全集，所以維持「證實」；但章節寫的「只說明相容，不算證明」是準確的，不能再往前推。
- 上面的標準差假設 Random 是單次抽樣。如果論文取了多次平均，SD 會更小，balanced accuracy 會被排除得更乾脆。

**重現**：`python3 .docs/chat-agent-research/verify/01-ambigqa-ambig-acc-majority.py`

---

## 3. 2310.10176 Table 5 的 ChatGPT GID 欄其實是 3:1

**主張**：Table 5 表頭說所有 LLM 都在 IND/OOD＝3:2 下比較，但 ChatGPT 的 GID 欄 68.44／75.33／70.17 其實是 3:1 的數字，與 Table 2 的 3:1 GID-DC 相同。照 3:2 比，「Claude 在 GID 較弱」站不太住。出處是筆記 `2310.10176.json` 的 `limitations_observed` 第 5 條，以及章節〈爭議、矛盾與反證〉。

**方法**：輸入取自 `.cache/text/2310.10176.txt`：

- Table 5 四列。
- Table 2 五個方法 × 三種比例的 IND／OOD／ALL ACC。
- Table 1 ChatGPT(DC) 三種比例的 ACC／NMI／ARI。
- §4.1 的類別數（IND 15；OOD 5／10／15），以及 GID 每類抽 10 句。

檢查分五步：

1. **先校準恆等式**：Table 2 每一格的 ALL ACC 是否等於 w·IND＋(1−w)·OOD。w 依比例取 0.75／0.6／0.5，容差 0.05。
2. Table 5 每列分別用 w＝0.6 與 0.75 預測 ALL ACC，看吻合哪一個。
3. ChatGPT 列與 Table 2、Table 1 逐欄比對。
4. 補充：三次執行合計下（IND 450 句，OOD 150 或 300 句），把 ACC 換回答對句數，看是否為整數。
5. 補充：比較 Claude 與 ChatGPT 的差距，算法有兩種，一種照論文實際的比法，一種照 3:2 比。

**實際輸出（摘要）**：

- 校準：Table 2 十五格全部吻合各自的權重，最大殘差 0.0075（ChatGPT(GID-DC) 3:1，屬兩位小數的捨入）。恆等式與權重在這篇的表上成立。
- Table 5 的判讀：

  | 模型 | ALL ACC | w＝0.6 預測 | w＝0.75 預測 | 吻合 |
  | --- | --- | --- | --- | --- |
  | text-davinci-002 | 30.40 | 30.404 | 30.837 | 3:2 |
  | text-davinci-003 | 61.07 | 61.068 | 60.502 | 3:2 |
  | Claude | 62.00 | 62.002 | 60.002 | 3:2 |
  | ChatGPT | 70.17 | 71.196 | 70.162 | **3:1** |

- 比對：ChatGPT 的 GID 三欄與 Table 2 GID-DC 的 3:1 逐欄相同，與 3:2（64.67／61.33／63.33）、1:1 都不同。它的 OOD discovery 三欄（78.00／78.20／55.32）則與 Table 1 的 3:2 DC 相同。表頭只在 GID 這一半錯。
- 整數句數：Claude、text-davinci-002、text-davinci-003 在 3:2 的樣本數下 IND＋OOD＝ALL 句數，吻合。ChatGPT 只在 3:1 下吻合（308＋113＝421）。換成 3:2 時，ALL 換算是 526.27 句，不是整數，而且 IND＋OOD 是 308＋226＝534 句，兩者也對不上。
- Claude 減 ChatGPT：

  | 比法 | IND ACC | OOD ACC | ALL ACC |
  | --- | --- | --- | --- |
  | 論文實際（ChatGPT 用 3:1） | −11.77 | −5.33 | −8.17 |
  | 照 3:2 | −8.00（−36 句，−2.46 SE） | **+8.67**（+26 句，+2.24 SE） | −1.33（−10 句，−0.53 SE） |

  SE 是兩比例差的粗估，假設兩個模型的樣本互相獨立；論文沒說兩個模型是否用同一批句子。

**結論：證實（數字部分）。**

- Table 5 的 ChatGPT GID 欄是 3:1 的數字。以上三項檢查各自獨立，結果都指向同一個答案。章節的算式（70.16、71.20、62.00、61.07、30.40、1.33）逐一對得上。
- 「站不太住」是判斷，數字給的是比較精確的版本。照 3:2 比，Claude 的 IND ACC 較低、OOD ACC 較高，兩邊都約 2 個 SE。ALL ACC 只差 10 句，約 0.5 SE。所以結論應該是兩邊各有取捨，不是 Claude 全面較弱。論文的「weaker on GID」建立在錯配的比例上。

**重現**：`python3 .docs/chat-agent-research/verify/01-gid-table5-ratio.py`

---

## 4. 2010.05256 的標籤數準確率與平凡基準打平

**主張**：「永遠只猜一個意圖」的平凡基準，TourSG 是 81.87%，StanfordLU 是 83.43%。完整模型與基準的差距只有 −2.51 到 +1.27 點，StanfordLU 1-shot 甚至低於基準。出處是筆記 `2010.05256.json` 的 `limitations_observed` 第 1 條，以及章節〈陷阱一〉多意圖標籤數條。

**方法**：輸入取自 `.cache/text/2010.05256.txt`：

- Table 1 各領域的 P. ML（TourSG 六個、StanfordLU 三個）。
- Table 6 的 ALR、ALR+MT、ALR+MT+KR 三列。
- Table 2 圖說「Ave. shows the averaged scores」：主表是逐領域再平均，所以基準也用簡單平均。

計算與檢查：

- 基準＝100 − 各領域 P.ML 的簡單平均。前提是每句至少一個意圖。
- 完整模型逐格減去基準。判準是四格差距的絕對值都 ≤ 2.6，且 StanfordLU 1-shot 為負。

補充的檢查有三項：

- P.ML 的捨入誤差（±0.05）。
- 改成按 query 數加權時，基準可能落的範圍。
- 消融各列與基準比較。

**實際輸出（摘要）**：

- 基準：TourSG 81.8667，StanfordLU 83.4333。
- 完整模型減基準：TourSG 1-shot +0.39、5-shot +0.18；StanfordLU 1-shot **−2.51**、5-shot +1.27。四格都 ≤ 2.6，StanfordLU 1-shot 為負。算上捨入誤差，結論不變。
- 加權敏感度：Table 1 沒給各領域的 query 數，所以只能給範圍。TourSG 的各領域基準在 77.3–84.0 之間，差距落在 −1.95 到 +4.96。StanfordLU 的 Weather 領域只有 3.8% 多標籤，單領域基準高達 96.2，所以差距範圍寬到 −15.28 到 +9.30。
- 消融：ALR 與 ALR+MT 兩列在四格**全部低於**平凡基準，StanfordLU 最多低 67.76 點。論文說 Table 6 呈現「持續上升」，但升到的是平凡基準附近。
- 嵌入器：Table 6 沒標 +E／+B。平凡基準只用 Table 1 的資料統計，跟嵌入器無關，所以不會有「嵌入器與統計基準不一致」的問題，只是無從得知 Table 6 用的是哪個嵌入器。

**結論：證實，但有條件。** 條件有三個：

- 每句至少一個意圖。
- Table 6 是逐領域簡單平均，與主表 Ave. 的做法一致，但 Table 6 本身沒寫明。
- query 分布近似領域整體。

TourSG 對平均方式不敏感。StanfordLU 則會因為 Weather 領域大幅擺動：如果 Table 6 其實按 query 數加權、而 Weather 的 query 占比又高，「低於基準」可能變成明顯低於，也可能反過來高於。

**重現**：`python3 .docs/chat-agent-research/verify/01-label-count-trivial-baseline.py`

---

## 5. 2010.05256 的 MCT 增益取決於對照組，而且 Table 4 只有 Electra

**主張**：筆記說消融表與主表的「不含 MCT」對不上，MCT 的真實增益遠小於 Table 4 報的數字，依據是 BERT 主表的差值 +2.10～+6.20 與 Electra 在 StanfordLU 5-shot 的 +3.71。本章認為：Table 4 只有 Electra，拿 BERT 的差值去比，嵌入器不一致；只用 Electra 重算，以主表 MPN+ALR 為對照，MCT 增益在 TourSG 是 17.61、19.65，大於 Table 4 的 12.52、16.70；在 StanfordLU 是 6.58、3.71，小於 Table 4 的 10.12、17.45。所以筆記的說法只在 StanfordLU 成立。出處是筆記 `2010.05256.json` 的 `limitations_observed` 第 2 條，以及章節〈爭議〉十一「多意圖偵測的 MCT 增益」。

**方法**：輸入取自 `.cache/text/2010.05256.txt`：

- Table 2（1-shot）與 Table 3（5-shot）的 +E、+B 兩段裡 MPN+ALR 與 Ours 兩列，欄位依序是 TourSG 六個領域、TourSG Ave.、StanfordLU 三個領域、StanfordLU Ave.。表格列在附錄會重複出現，所以只在「+E | TransferM」到「+B | TransferM」這段位置裡找，不只做子字串比對。
- Table 4 的 Ours 列與「- MCT」列。
- 三句原文當錨點：消融用在來源領域調的 vanilla 門檻、基線 MPN 用在開發集調的固定門檻，以及「本模型可視為 MPN+ALR+MCT」。

檢查分五步：

1. 校準：每列各領域分數的簡單平均要等於同列的 Ave.（容差 0.01），確認欄位切得對。
2. Table 4 的 Ours 列要與主表 +E 的 Ours Ave. 四格相同，確認 Table 4 是 Electra。
3. 主表對照的 MCT 增益＝Ours − MPN+ALR（+E），逐格與 Table 4 的去 MCT 差值比。
4. Table 4 隱含的「不含 MCT」＝Ours − 去 MCT 差值，與主表 MPN+ALR **依位置**逐欄比，不做集合比對。
5. 同法算 +B（BERT）的增益，範圍要等於章節與筆記寫的 2.10 到 6.20；而且 Table 4 的 Ours 列要與主表 +B 的 Ours Ave. 不同，確認 Table 4 沒有 BERT 版。

五項全部成立才判「證實」，結論字串由算出的值組成。

**實際輸出（摘要）**：

- 校準：16 組平均全部等於 Ave.。
- Table 4 的 Ours 列 51.07／52.63／42.51／50.82 與主表 +E 的 Ours Ave. 相同，與 +B 不同。
- MCT 增益（主表對照對 Table 4）：TourSG 1-shot 17.61 對 12.52、5-shot 19.65 對 16.70；StanfordLU 1-shot 6.58 對 10.12、5-shot 3.71 對 17.45。TourSG 兩格主表對照較大，StanfordLU 兩格較小。
- 兩個「不含 MCT」：由 Table 4 換算是 38.55／35.93／32.39／33.37，主表 MPN+ALR 是 33.46／32.98／35.93／47.11，差 +5.09／+2.95／−3.54／−13.74，四格逐欄都不同。TourSG 5-shot 換算出的 35.93 恰好等於主表 StanfordLU 1-shot 的 MPN+ALR，只做集合比對會誤判成一致。
- BERT 主表的增益是 4.89／2.10／6.20／4.33，範圍 2.10 到 6.20，與章節和筆記相同；Table 4 的 Ours 列與主表 +B 不同，所以 Table 4 沒有 BERT 版，這組數字不能和它比。

**結論：證實。** 本章的重算成立，筆記的結論因嵌入器錯配而收窄成只在 StanfordLU 成立。論文沒說主表的 MPN+ALR 用哪一種門檻，所以「哪一個才是真的不含 MCT」這個問題，程式回答不了。

**重現**：`python3 .docs/chat-agent-research/verify/01-mct-gain-embedder.py`

---

## 6. 2311.09469 Table 4 的全表計數

**主張**：章節有三處用到這張表。

- 〈爭議〉十一：Intent-Sim 在 b=10% 的增益占比是 13%、24%、14%、17%、6%、11%，六格平均約 14.2%，只有一個組合達到隨機（10%）的兩倍；v1 摘要卻說 10% 預算下增益是隨機的兩倍。
- 〈爭議〉十一：v1 §6.3 說兩種熵方法在所有預算下都贏隨機，但 Intent-Sim 18 格中有 6 格低於隨機，Semantic Entropy 有 8 格低於、1 格等於。
- 〈方法比較〉〈陷阱一〉與未解問題 3：Intent-Sim 的 AUROC 是 0.501–0.628，在六個組合中四個最高；各組合最佳方法落在 0.531–0.628；四種方法全部算進來有 5 格低於隨機的 0.5，下限 0.371。

出處是筆記 `2311.09469.json` 的 `limitations_observed` 第 1、2 條。

**方法**：輸入取自 `.cache/text/2311.09469.txt` 的 Table 4，六個「任務 × 模型」組合依全文順序錨定，每格解析 AUROC 與 b=10%、20%、30% 三個預算下的增益占比。表中把本文方法標成 "User Sim"；§6.2 Baselines 只列 Likelihood、Self-Ask 與 Semantic Entropy，所以第四個方法就是 §6.1 的 Intent-Sim。隨機基準依 §6.3：隨機挑 b% 發問時，增益占比等於 b。另以摘要的「兩倍」句、§6.3 的「所有預算下都贏隨機」句與表頭當錨點。

判定逐項比對章節寫的值，十項全部相符才判「證實」，結論字串由算出的值組成：

- b=10% 的六格、平均 14.2%、達兩倍的組合數 1。
- Intent-Sim 低於隨機 6 格；Semantic Entropy 低於 8 格、等於 1 格。
- Intent-Sim 的 AUROC 範圍 0.501–0.628、各組合最佳方法的範圍 0.531–0.628、Intent-Sim 在 4 個組合最高。
- 全表下限 0.371（Self-Ask，MT GPT-3）、全表低於 0.5 的格數 5。

**實際輸出（摘要）**：

- b=10%：(13+24+14+17+6+11)÷6＝14.17%；達到 20% 的只有 NLI 的 LLaMA-2 7B Chat（24%）。
- 低於隨機：Intent-Sim 18 格中 6 格低於、0 格等於，其中 3 格在 QA 的 LLaMA-2 7B Chat。Semantic Entropy 18 格中 8 格低於、1 格等於（MT GPT-3 b=30%）。所以 v1 §6.3 那句話對兩種熵方法都不成立。
- AUROC：Intent-Sim 0.501–0.628；各組合最佳方法 0.531–0.628，Intent-Sim 在 4 個組合最高（另兩個是 Likelihood 0.547、Semantic Entropy 0.532）。全表有 5 格低於 0.5，最低 0.371 是 Self-Ask 在 MT GPT-3。

**結論：證實。** 章節據此把〈陷阱一〉拒識與「何時問」的 AUROC 比較改成同一尺度、各取最佳方法（0.984 對 0.531–0.628），不再拿全表下限去比。

**重現**：`python3 .docs/chat-agent-research/verify/01-intentsim-table4-counts.py`

---

## 7. 2305.07157 Table 5：意圖過濾的方向

**主張**：意圖過濾（只把檢索出的 top-5 意圖放進提示）在 in-scope accuracy 上八格中六格下降，例外是 B02 的 Flan-T5-XXL 從 69 升到 69.7、B01 的 Flan-T5-XXL 持平在 86.5；作者說過濾能提升 OOS recall，這只對 GPT-3 成立，Flan-T5-XXL 反而下降。出處是筆記 `2305.07157.json` 的 `limitations_observed`（「多半降分」），以及章節〈爭議〉十一「描述式 zero-shot」條。

**方法**：輸入取自 `.cache/text/2305.07157.txt` 的 Table 5 四個資料集。每個資料集有兩組列：「LLM Intents」欄為 5 的是過濾後的提示，為該資料集意圖總數的是全意圖提示；程式也檢查全意圖列的意圖數與資料集標題相符。另以兩句正文當錨點：過濾的結果是 3 個隨機種子的平均，以及作者舉 Benchmark02 說明過濾能提升 OOS recall。

**實際輸出（摘要）**：

- in-scope accuracy：下降 6 格（MASSIVE 兩格、OOTB 兩格、B01 GPT-3、B02 GPT-3），持平 1 格（B01 Flan-T5-XXL），上升 1 格（B02 Flan-T5-XXL 69.0→69.7）。
- OOS recall（只有 B01、B02 有 OOS 測試樣本）：GPT-3 0.67→0.97、0.67→0.87 上升；Flan-T5-XXL 0.48→0.43、0.7→0.65 下降。
- 提示裡的意圖數：MASSIVE 60、OOTB 27、B01 9、B02 13，都縮到 5。

**結論：證實。**

**重現**：`python3 .docs/chat-agent-research/verify/01-intent-filter-table5.py`

---

## 8. 2410.12361：False-Alarm 等於 1−Precision，F1 排名跟著 Precision 走

**主張**：Table 3 八列的 Precision＋False-Alarm 都等於 100%（捨入內）；Table 4 的 12 列中 11 列也成立，唯一例外是 LLaMA-3.1-8B w/ RM：42.52＋57.41＝99.93。Table 3 八列中有七列的 Recall 介於 97.89% 到 100%，這七列的 F1 排名與 Precision 排名完全相同。出處是筆記 `2410.12361.json` 的 `limitations_observed`（實作是 FP/(TP+FP)、Recall 範圍），以及章節〈陷阱一〉Proactive Agent 條。

**方法**：輸入取自 `.cache/text/2410.12361.txt` 的 Table 3（八個模型）與 Table 4（三個模型 × 四種設定），欄位依序是 Recall、Precision、Accuracy、False-Alarm、F1。檢查分五步：

1. 每列 Precision＋False-Alarm 與 100 的差（容差 0.02）。
2. 校準：每列報的 F1 與 2PR/(P+R) 的差（容差 0.02），確認欄位解析正確。
3. Table 3 裡 Recall ≥ 97.89 的列，用論文報的 F1 排名，與用 Precision 排名比。
4. 補充：這些列的報出 F1 與近似式 2P/(1+P) 的差。
5. 補充：Table 4 的例外列若改用 100−False-Alarm 當 Precision，F1 會變多少。

**實際輸出（摘要）**：

- Table 3 八列全部成立；Table 4 十一列成立，例外只有 LLaMA-3.1-8B w/ RM。
- 校準：二十列報的 F1 與 2PR/(P+R) 最大差 0.009。
- Recall 97.89–100 的七列，依 F1 與依 Precision 的排名完全相同。
- 近似式與報出 F1 最多差 0.42 個百分點（Claude-3.5-Sonnet），而相鄰兩列 Precision 的最小差距只有 0.02（兩個 Proactive 版本 49.78 對 49.76）。所以排名一致是逐列比出來的，不是近似保證的。
- 例外列：報出 F1 54.81 與報出的 Precision 42.52 自洽；改用 100−57.41＝42.59 算是 54.86。False-Alarm 那一格比較可能是誤植，這只是推論。

**結論：證實。** 章節把「Recall＝1」改寫成近似，並附上 Claude-3.5-Sonnet 那一列的算式。

**重現**：`python3 .docs/chat-agent-research/verify/01-proactive-precision-falsealarm.py`

---

## 沒有驗的

候選清單上的八條都驗了。章節裡還有別的主張需要逐次原始輸出、公開 repo 或公開資料集才能驗，這次都沒有處理：

- 2310.10176 的 p < 0.01 撐不撐得住、GID-FSD 在 3:1 崩到 17.33 是不是單次極端值：要逐次執行的原始輸出。
- Proactive Agent 與 repo 公開結果的差異、RM 測試集與訓練集的事件重疊、EVPI 公開程式碼的行為：要下載公開 repo 或補充材料。
- CLINC150 的 OOS 樣本偏向領域外：本章只有精讀時看 45 筆樣本的定性觀察，要量化得拿整份 OOS 集與 in-scope 集算主題距離，這次沒做。
- 2010.05256 主表的 MPN+ALR 到底用哪一種門檻：論文沒寫，程式回答不了。

單條算式的換算（例如 CollabLLM 的 Macro Accuracy、Future Turns 在同一直接回答比例下對 Random 的 F1 差）已寫在章節句子裡，寫成等式的部分由章節數字比對工具逐式驗算，沒有另外寫程式。

---

## 突變校準

2026-09-26 重做。每種突變都在暫存目錄的副本裡改輸入字串，原檔不動，分兩種設定各跑一次：

- **無快取**：副本上一層沒有 `.cache/`，程式略過錨點，判定式真的會被問到。計數只算這一欄有沒有翻成「推翻」。
- **有快取**：副本上一層的 `.cache/` 連到研究目錄的快取，突變後的字串對不上原文，應被錨點擋下，印「無法判定」。這一欄只驗到錨點，驗不到判定式。

對照組：八支未突變的原檔在兩種設定下都印「證實」、exit 0。

| 條 | 程式 | 突變 | 無快取 | 有快取 |
| --- | --- | --- | --- | --- |
| 1 | `01-in3-vagueness-majority.py` | Mistral-Interact 準確率 85.19→88.89（96/108，高於多數類） | 推翻（exit 1） | 無法判定（exit 1） |
| 1 | `01-in3-vagueness-majority.py` | Test 欄 Clear 13→12（組成不等於 108） | 推翻（exit 1） | 無法判定（exit 1） |
| 1 | `01-in3-vagueness-majority.py` | Mistral-7B 準確率 49.07→49.50（不落在 k/108） | 推翻（exit 1） | 無法判定（exit 1） |
| 2 | `01-ambigqa-ambig-acc-majority.py` | Llama2 Ours 的 Ambig Acc 53.7→60.7（高於多數類） | 推翻（exit 1） | 無法判定（exit 1） |
| 2 | `01-ambigqa-ambig-acc-majority.py` | Llama3 Random 的 Ambig Acc 51.1→53.1（與全集期望差超過 1 點） | 推翻（exit 1） | 無法判定（exit 1） |
| 2 | `01-ambigqa-ambig-acc-majority.py` | 未模糊題 788→778（組成不等於 1960） | 推翻（exit 1） | 無法判定（exit 1） |
| 3 | `01-gid-table5-ratio.py` | Table 5 ChatGPT ALL ACC 70.17→71.20（改吻合 3:2） | 推翻（exit 1） | 無法判定（exit 1） |
| 3 | `01-gid-table5-ratio.py` | Table 5 Claude ALL ACC 62.00→60.00（改吻合 3:1） | 推翻（exit 1） | 無法判定（exit 1） |
| 3 | `01-gid-table5-ratio.py` | Table 1 ChatGPT(DC) 3:2 ARI 55.32→55.30（OOD discovery 欄不再與 3:2 相同） | 推翻（exit 1） | 無法判定（exit 1） |
| 4 | `01-label-count-trivial-baseline.py` | Table 6 完整模型 StanfordLU 1-shot 80.92→84.92（不再低於基準） | 推翻（exit 1） | 無法判定（exit 1） |
| 4 | `01-label-count-trivial-baseline.py` | Table 1 Weather 的 P. ML 3.8%→13.8%（差距超過 2.6） | 推翻（exit 1） | 無法判定（exit 1） |
| 5 | `01-mct-gain-embedder.py` | Table 4 去 MCT 的 StanfordLU 5-shot −17.45→−2.45（主表對照不再較小） | 推翻（exit 1） | 無法判定（exit 1） |
| 5 | `01-mct-gain-embedder.py` | +B 5-shot Ours 的 It 46.80→52.80、Ave. 56.56→57.56（BERT 增益下限 2.10→3.10，只動新納入的檢查） | 推翻（exit 1） | 無法判定（exit 1） |
| 5 | `01-mct-gain-embedder.py` | +B 兩列 Ours 換成 +E 的 Ours（Table 4 變成也等於 BERT 版） | 推翻（exit 1） | 無法判定（exit 1） |
| 6 | `01-intentsim-table4-counts.py` | 稽核反例一：MT GPT-3 Likelihood AUROC 0.547→0.747（各組合最佳上限變 0.747） | 推翻（exit 1） | 無法判定（exit 1） |
| 6 | `01-intentsim-table4-counts.py` | 稽核反例二：QA 13B Sem. Ent 增益占比 6/14/28→16/24/38（SE 低於隨機 8→5 格） | 推翻（exit 1） | 無法判定（exit 1） |
| 6 | `01-intentsim-table4-counts.py` | NLI 7B Intent-Sim b=10% 24%→14%（沒有組合達兩倍） | 推翻（exit 1） | 無法判定（exit 1） |
| 6 | `01-intentsim-table4-counts.py` | NLI 7B Likelihood AUROC 0.416→0.516（低於 0.5 的格數 5→4，只動新納入的檢查） | 推翻（exit 1） | 無法判定（exit 1） |
| 7 | `01-intent-filter-table5.py` | B01 GPT-3 過濾後 OOS recall 0.97→0.57（GPT-3 也下降） | 推翻（exit 1） | 無法判定（exit 1） |
| 7 | `01-intent-filter-table5.py` | MASSIVE Flan-T5-XXL 過濾後 68.6→74.6（多一格上升） | 推翻（exit 1） | 無法判定（exit 1） |
| 8 | `01-proactive-precision-falsealarm.py` | Table 4 LLaMA w/ RM 的 False-Alarm 57.41→57.48（例外列消失） | 推翻（exit 1） | 無法判定（exit 1） |
| 8 | `01-proactive-precision-falsealarm.py` | Table 3 GPT-4o F1 64.60→66.60（F1 校準不吻合） | 推翻（exit 1） | 無法判定（exit 1） |
| 8 | `01-proactive-precision-falsealarm.py` | Table 3 Claude-3.5-Sonnet Recall 97.89→96.89（高 Recall 列數與下限改變） | 推翻（exit 1） | 無法判定（exit 1） |

第 1–4 條依序 3＋3＋3＋2＝11 種，第 5–8 條依序 3＋4＋2＋3＝12 種，合計 23 種；無快取時全部翻成「推翻」，有快取時全部印「無法判定」。

標著「只動新納入的檢查」的兩種，無快取時的結論只列出那一項不成立（MCT 那支是「BERT 增益範圍」，Intent-Sim 那支是 `below_half`）；稽核反例一、二分別只列出 `best_range` 與 `se_below_equal`。

**修正前的判定式量不到這些項。** 第 5、6 條的判定式在 2026-09-26 補過。修正前的兩支程式由稽核員留下的副本還原，在無快取設定下的結果如下，都仍印「證實」、exit 0：

- `01-intentsim-table4-counts.py`｜修正前、未突變：證實（exit 0）
- `01-intentsim-table4-counts.py`｜稽核反例一：MT GPT-3 Likelihood AUROC 0.547→0.747（各組合最佳上限變 0.747）：證實（exit 0）
- `01-intentsim-table4-counts.py`｜稽核反例二：QA 13B Sem. Ent 增益占比 6/14/28→16/24/38（SE 低於隨機 8→5 格）：證實（exit 0）
- `01-mct-gain-embedder.py`｜修正前、未突變：證實（exit 0）
- `01-mct-gain-embedder.py`｜+B 5-shot Ours 的 It 46.80→52.80、Ave. 56.56→57.56（BERT 增益下限 2.10→3.10，只動新納入的檢查）：證實（exit 0）

修正前，這兩支只把「各組合最佳 0.531–0.628」「5 格低於 0.5」「Semantic Entropy 8 格低於、1 格等於」與 BERT 增益範圍印出來，沒有放進判定，結論字串還把數字寫死。現在這些項都進了判定。
