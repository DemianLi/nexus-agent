# 第 3 章主張驗證結果（T3 agent 觀測）

驗證對象：`.docs/chat-agent-research/chapters/03-agent-observation.md`。

共九條主張，每條一支程式，只用 Python 標準函式庫（本機是 Python 3.9.19）。第 1 到第 4 條是第一輪的候選主張；第 5 到第 9 條是修訂時依審查意見補的（OSWorld 基線與地板、GUI-R1 照抄、AI Control 的 Pareto、Turpin Table 9、否定性主張的全文搜尋）。第 1 到第 3 支與第 5 到第 8 支是數值驗算或逐格比對；第 4 支是原文錨點檢查；第 9 支是全文搜尋，附正對照。只有第 3 支的模擬用到隨機數，種子固定為 20260926，約 1.6 秒跑完；其餘八支都在 0.4 秒內跑完（第 5 到第 8 支實測都在 0.1 秒內；第 9 支在正對照改用 N1 的通用關鍵字之後約 0.13 秒）。

表格數字都由程式從 `.cache/text/<id>.txt` 解析，不手抄。解析時用表題當錨點，並對表頭字串與列數做 assert，解析錯了程式會當場失敗，不會默默比錯欄。每支程式的輸出都附行號，最後一行印出 `DONE <檔名>`，用來確認輸出沒有被截斷。

一條主張裡如果有幾個子主張的判讀不同，就分開下結論。

## 總表

| # | 子主張 | 結論 |
| --- | --- | --- |
| 1a | R-Judge 兩個子集是 200／214 與 100／55，用它重算 33 個 F1 全部吻合 | **證實**，而且 P_I=200 是唯一能讓全部格點與 F1 吻合的拆分 |
| 1b | 全判 unsafe 的 F1 是 69.04／65.15／78.43，Table 1 的 11 個模型只有 GPT-4o 高於 69.04 | **證實** |
| 1c | 子集隨機 F1 寫反（應為 Intended 49.14、Unintended 56.34）；ChatGPT 的 Unintended 55.63 其實低於隨機 | **證實**。附帶一點：全集的 51.32 照四捨五入應為 51.33，筆記說「只有全集是對的」差在末位 |
| 1d | 延伸數字：GPT-4o balanced accuracy≈68.3、Llama-Guard-2 71.84、Finance 47.27、IoT 77.55 | **證實** |
| 2a | OmniParser Table 3 的 MindAct (gen)、MindAct、GPT-3.5-Turbo、Qwen-VL 四列把 Cross-Domain 抄進 Cross-Task | **證實**。表內重複偵測剛好命中這四列 |
| 2b | 這四列的正確值 | **證實**。前三列有 SeeClick 與 Mind2Web 原文兩個來源且一致；Qwen-VL 只有 SeeClick 一個來源 |
| 2c | 更正後 MindAct 在 Cross-Task（52.0 對 39.4）與 Cross-Website（38.9 對 36.5）仍領先 | **證實**（算術）。但這是跨測試集的比較；而且即使照抄錯的表，MindAct 在這兩個 split 也仍領先，抄錯只是把 Cross-Task 的差距從 12.6 點縮成 0.2 點 |
| 3a | 5p(1−p) ≥ 1−(1−p)^6−p 在 [0,1] 上成立 | **證實**（等價於 Bernoulli 不等式） |
| 3b | 單次解題數的變異下界 ≈ 8.84，標準差約 3 題、約 1 個百分點 | **證實**（8.838；0.991 個百分點） |
| 3c | 無示範那一格的 1.7 點不到 2 個標準差 | **證實**，而且這個結論不需要任何關於消融設定變異的假設；2.3 點與 3.0 點則取決於假設 |
| 3d | 自報標準差 0.49（點估計）低於下界 0.99 | **證實**。0.49 是六次的母體標準差，只有下界的 0.495 倍 |
| 3e | 兩者對不上（自報變異與獨立解題的模型矛盾） | **無法判定**。只有 6 次執行，在模型下低到這個程度約有 7–8% 的機率出現，算中度張力，不是確定的矛盾 |
| 4a | Llama Guard 自家測試集是同分佈：同一個 prompt 來源、同一個 response checkpoint、同一個紅隊、隨機切分 | **證實**（§3.3 六句原文都找到） |
| 4b | 論文寫了 Azure 的閾值是在 1–6 之間挑 average precision 最高的那個 | **證實**（§4.3.2 原文） |
| 4c | Azure 實際用的閾值就是依 average precision 挑出來的，而且是在各資料集上挑 | **無法判定**。§4.3.3 說 Azure 算不了 AP，與 4b 直接矛盾；附錄 B 說閾值全設 0.5，可能與 4b 等價也可能不同。另外 Azure 只評在一個資料集上 |
| 4d | 未微調的 Llama2-7b 零樣本輸出格式錯誤，被記為 AUPRC 0 | **證實** |
| 5a | OSWorld 原論文 GPT-4o 的四個觀測設定是 5.03／4.59／11.36／11.21 | **證實**（Table 5，並由 Table 14 的分項以題數加權重算回來） |
| 5b | OS-ATLAS 表裡的「GPT-4o」「GPT-4o + SoM」兩列是照抄 OSWorld | **證實**。兩列十個分項都與 OSWorld Table 14 逐格相同，包括不在 k/n 格點上的值；Human 列也相同 |
| 5c | OS-ATLAS 沒交代版本與任務數，兩邊可能不是同一版任務集 | **收窄**。OS-ATLAS 自己跑的三列除 4B 的 Calc 一格外都在 369 題的格點上，題數加權平均能重算回 Avg：與同一套 369 題相容，但不是證明 |
| 5d | 每題回 FAIL 的 30/369 = 8.13% 地板可以套用到 OS-ATLAS 的表 | **證實**。只看截圖與加 SoM 在地板之下，三個 grounder 列在地板之上；VS Code 與 GIMP 兩類沒有任何一列高過各自的地板 |
| 6 | GUI-R1 Table 3 的 GPT-4o、OS-Atlas-4B、OS-Atlas-7B 三列 18 個數字與 OS-ATLAS 逐位相同 | **證實**。全部取自 OS-ATLAS 的零樣本組。GUI-R1 依訓練方式分組，把兩列 OS-Atlas 歸在「Supervised Fine-Tuning」組，引用的是 OS-ATLAS 未在 AndroidControl／GUI-Odyssey 上微調的零樣本數字 |
| 7 | AI Control Table 7：UM 0%、5%、10% 被列出的 TE 點支配，UM 20% 沒有；TE 最高 safety 96% | **證實**（只比列出的點） |
| 8 | Turpin Table 9：Answer is Always A 的 CoT 26 格中 4 格 biased 不低於 unbiased | **證實**。4 格都是嚴格上升；Suggested Answer 的 CoT 52 格一格都沒有 |
| 9 | UI-TARS 的歷史 N、解析度與影像 token 沒有報；OmniParser、UGround 沒量延遲與成本；UGround 沒有去重 | **全文找不到反例**（只查全文，沒查程式碼與專案頁）。N1 的正對照改用 N1 自己的通用關鍵字，兩篇都找得到；但這組關鍵字是看過兩篇的寫法後才擴充的，N1 的主要證據仍是 $N$ 的逐處分類 |

---

## 1. R-Judge：正類占多數時，F1 的參考線是「全判 unsafe」

**主張。** R-Judge 以 unsafe 為正類算 F1。兩個子集是 200 unsafe／214 safe 與 100 unsafe／55 safe，用這組整數從 Table 1 的 Recall 與 Specificity 重算，11 個模型 × 3 欄共 33 個 F1 全部吻合。在這個組成下，全判 unsafe 的全集 F1 是 2×300÷(300+569)≈69.04，Table 1 的 11 個模型只有 GPT-4o（74.45）高於它。子集的隨機 F1 也寫反了：照 Recall＝Specificity＝50% 重算，Intended 是 49.14、Unintended 是 56.34，論文寫的是 56.34 與 49.14。

**出處。** [arXiv:2401.10019]，`notes/2401.10019.json` 的 limitations_observed 第 1、2、9 條。章節第 302–307 行與第 405 行。

**輸入。** 都取自 `.cache/text/2401.10019.txt`：

| 行數 | 內容 |
| --- | --- |
| 第 229、231 行 | §3.4：Intended Attacks 414 筆，Unintended Risks 155 筆 |
| 第 262–407 行 | Table 1，表題在第 409 行 |
| 第 332–341 行 | Table 1 的 Random 列：51.32／56.34／49.14 |
| 第 625–648 行 | Table 3（Llama 與 Llama Guard 的全集 F1／Recall／Spec），表題在第 650 行 |
| 第 1340 行 | Table 5 表題：五個類別的 # Unsafe／#Safe，加總 300／269 |
| 第 1832 行 | Table 8 表題：GPT-4o 各類別 F1 |

**方法。**

1. 論文沒有直接給子集內的 unsafe／safe 拆分，所以把 Intended 的 unsafe 數 P_I 當成唯一的自由參數；其餘三個數由總數推出：N_I＝414−P_I、P_U＝300−P_I、N_U＝P_I−145。
2. 對每個可行的 P_I，檢查 11 個模型的 44 個 Recall／Spec 是否都落在各自分母的格點上（存在整數 k，使 k/分母×100 四捨五入到兩位等於表值）。再用還原出的 TP、TN 重算 Intended、Unintended 兩個子集與合併後 All 的 F1，逐一比對表值。
3. 對照組：Table 3 直接給了全集層級的 Recall／Spec，拿它對 300／269 的格點再驗一次。
4. 全判 unsafe：F1＝2P/(2P+N)。隨機：Recall＝Spec＝50% 時 F1＝P/(1.5P+0.5N)。計算一律用 `Fraction` 精確進行。

**實際輸出（摘要）。**

- 掃完 P_I 的可行範圍，44 個 Recall／Spec 全部落在格點上的只有 **P_I＝200**，33 個 F1 也全部吻合的也只有 200。
- 33 個 F1 用四捨五入時 33/33 吻合，改用無條件捨去只有 20/33，所以論文用的是四捨五入。
- Table 3 的四列都落在 300／269 的格點上，F1 重算全部吻合。例如 LlamaGuard-7b 是 TP＝1、TN＝269，F1＝0.66。

| 參考線 | 重算 | 論文 | 判讀 |
| --- | --- | --- | --- |
| 全判 unsafe，全集 | 69.0449 → 69.04 | 論文沒列 | |
| 全判 unsafe，Intended | 65.1466 → 65.15 | 論文沒列 | |
| 全判 unsafe，Unintended | 78.4314 → 78.43 | 論文沒列 | |
| 隨機，全集 | 51.3259 → **51.33** | 51.32 | 末位差 0.01；只有無條件捨去才得到 51.32 |
| 隨機，Intended | 49.1400 → 49.14 | **56.34** | 與 Unintended 對調 |
| 隨機，Unintended | 56.3380 → 56.34 | **49.14** | 與 Intended 對調 |

| 比較 | 結果 |
| --- | --- |
| Table 1 全集 F1 高於 69.04 | 只有 GPT-4o（1/11） |
| Intended 高於 65.15 | GPT-4o、Meta-Llama-3-8B-Instruct（65.68） |
| Unintended 高於 78.43 | 只有 GPT-4o（80.90，高 2.47） |
| ChatGPT Unintended 55.63 | 高於論文的 49.14，低於重算的 56.34 |
| 兩個子集都高於隨機 | 用重算值或論文值，都只有 GPT-4o |
| GPT-4o 全集 | Recall 255/300＝85.00，Spec 139/269＝51.67，balanced accuracy 68.34 |
| Meta-Llama-Guard-2-8B（Table 3） | 71.84，比 69.04 高 2.80 |
| Finance（39 unsafe／87 safe） | 全判 unsafe 47.27，GPT-4o 48.44（+1.17） |
| IoT（19 unsafe／11 safe） | 全判 unsafe 77.55，GPT-4o 68.75（−8.80） |

**結論。**

- **1a：證實。** 200／214、100／55 不只是可行，而且是唯一解。筆記寫的是「由 Table 5 與 Table 1 的分母推得」，這裡把推得升級成唯一。
- **1b：證實。** 11 個模型只有 GPT-4o 高於 69.04。附帶一點：Intended 子集有兩個模型高於 65.15（多了 Llama-3-8B），章節沒有主張子集的情形，不衝突。
- **1c：證實。** 兩個子集的值剛好對調，ChatGPT 的 55.63 照正確值低於隨機。不過筆記第 2 條說「只有全集的 51.32 是對的」，照四捨五入應為 51.33。差在末位，不影響「寫反」的結論，但這句不宜原樣引用。
- **1d：證實。** 章節第 304、306、307、405 行的延伸數字全部吻合。
- 旁註：§3.4 第 229 行列出的 Unintended 來源是 ToolEmu 81、AgentMonitor 24、人工 55，加總 160，不等於同段的 155；414＋155＝569 才與 Table 5 吻合。章節表格照抄了 81／24／55，這是論文自己的不一致，和本主張無關。

**重現。**

```bash
python3 .docs/chat-agent-research/verify/03-rjudge-f1-base-rate.py
```

---

## 2. OmniParser 的 Mind2Web Table 3 有四列抄錯

**主張。** OmniParser Table 3 裡，MindAct (gen)、MindAct、GPT-3.5-Turbo、Qwen-VL 四列的 Cross-Task 欄重複抄了 Cross-Domain 的數字。正確值是 MindAct 55.1／75.7／52.0、MindAct (gen) 20.2／52.0／17.5、GPT-3.5-Turbo 20.3／56.6／17.4、Qwen-VL 15.9／86.7／13.3（Ele.Acc／Op.F1／Step SR）。更正後，以 HTML 為輸入、微調過的 MindAct 在 Cross-Task（Step SR 52.0 對 39.4）與 Cross-Website（38.9 對 36.5）仍領先 OmniParser，OmniParser 只在 Cross-Domain（42.0 對 39.6）勝出。

**出處。** [arXiv:2408.00203]，`notes/2408.00203.json` 的 limitations_observed 第 2 條；[arXiv:2401.10935] 當作對照來源。章節第 355 行。

**輸入。**

| 來源 | 行數 | 內容 |
| --- | --- | --- |
| `.cache/text/2408.00203.txt` | 第 347–507 行，表題第 509 行 | OmniParser Table 3，欄序 Cross-Website／Cross-Domain／Cross-Task，11 列 |
| `.cache/text/2401.10935.txt` | 第 546–632 行，表題第 634 行 | SeeClick Table 4，欄序 Cross-Task／Cross-Website／Cross-Domain，6 列 |
| `.cache/text/2306.06070.txt` | 表題第 421 行，表在其後 | Mind2Web 原文 Table 2，每個 split 多一欄 SR |
| `.cache/text/2408.00203.txt` | 第 324 行 | OmniParser 用的清理版題數 867／167／242 |
| `.cache/text/2306.06070.txt` | 第 400 行起 | Mind2Web 原始題數 912／177／252 |

**方法。**

1. 欄位一律依表頭名稱對應，不依位置，因為三張表的 split 順序都不同。
2. 只用 OmniParser 自己的表做重複偵測：逐列檢查 Cross-Task 三格是否與 Cross-Domain 三格完全相同。這一步不依賴第二來源。
3. 逐格三方比對：OmniParser、SeeClick Table 4、Mind2Web 原文 Table 2。列名對照為 Generation↔MindAct (gen)、w/ Flan-T5XL↔MindAct、w/ GPT-3.5↔GPT-3.5-Turbo、w/ GPT-4∗↔GPT-4。GPT-4 與 SeeClick 兩列當對照組。
4. 更正後的比較：MindAct 的 Step SR 對 OmniParser 兩列（LS＋GD、LS＋ID）在每個 split 的最大值。

**實際輸出（摘要）。**

| 列 | OmniParser 的 CT | OmniParser 的 CD | SeeClick 的 CT | Mind2Web 的 CT | 判讀 |
| --- | --- | --- | --- | --- | --- |
| MindAct (gen) | 14.2/44.7/11.9 | 14.2/44.7/11.9 | 20.2/52.0/17.5 | 20.2/52.0/17.5 | CT 抄成 CD |
| MindAct | 42.1/66.5/39.6 | 42.1/66.5/39.6 | 55.1/75.7/52.0 | 55.1/75.7/52.0 | CT 抄成 CD |
| GPT-3.5-Turbo | 21.6/52.8/18.6 | 21.6/52.8/18.6 | 20.3/56.6/17.4 | 20.3/56.6/17.4 | CT 抄成 CD |
| Qwen-VL | 14.1/84.3/12.0 | 14.1/84.3/12.0 | 15.9/86.7/13.3 | 無此列 | CT 抄成 CD |
| GPT-4（對照） | 41.6/60.6/36.2 | 37.1/46.5/26.4 | 41.6/60.6/36.2 | 41.6/60.6/36.2 | 一致 |
| SeeClick（對照） | 28.3/87.0/25.5 | 23.2/84.8/20.8 | 28.3/87.0/25.5 | 無此列 | 一致 |

- 重複偵測：OmniParser 表內 11 列中，CT 與 CD 完全相同的正好是這四列。CogAgent、GPT-4、GPT-4V 兩列、OmniParser 兩列都不重複。
- 三方比對：OmniParser 與 SeeClick 不一致的格子只有這四列的 Cross-Task；這 6 列的 Cross-Website 與 Cross-Domain（12 組、36 格）全部一致。凡是 Mind2Web 原文有的列，SeeClick 都與它一致。

| split | MindAct Step SR | OmniParser 最佳 | 領先者 |
| --- | --- | --- | --- |
| Cross-Task | 52.0 | 39.4（LS＋ID） | MindAct ＋12.6 |
| Cross-Website | 38.9 | 36.5（LS＋ID） | MindAct ＋2.4 |
| Cross-Domain | 39.6 | 42.0（LS＋ID） | OmniParser ＋2.4 |

**結論。**

- **2a：證實。** 只看 OmniParser 自己的表就能抓出這四列，而且剛好是這四列。
- **2b：證實。** MindAct (gen)、MindAct、GPT-3.5-Turbo 三列的正確值有 SeeClick 與 Mind2Web 原文兩個來源，而且兩者一致。Qwen-VL 不在 Mind2Web 原文裡，正確值只有 SeeClick 一個來源；OmniParser 的附錄 7.4 說 Qwen-VL 的數字取自 SeeClick 論文，所以這個來源正是它引用的出處。
- **2c：算術證實，但要加兩個但書。**
  - 這是跨測試集的比較。OmniParser 用的清理版是 867／167／242 題，MindAct 的數字量在原始的 912／177／252 題上，題目集合不同。筆記第 3 條已指出這一點。
  - 章節說抄錯「掩蓋了 HTML 方法仍領先的事實」，這句說得略重。照抄錯的表，MindAct 在 Cross-Task 仍是 39.6 對 39.4、在 Cross-Website 仍是 38.9 對 36.5，排序並沒有反轉。抄錯實際造成的是 Cross-Task 的差距從 12.6 點縮成 0.2 點，看起來像平手。建議改寫成「把 Cross-Task 12.6 點的差距縮成 0.2 點」。

**重現。**

```bash
python3 .docs/chat-agent-research/verify/03-omniparser-mind2web-copy.py
```

---

## 3. SWE-agent：消融差距的顯著性，與自報標準差 0.49

**主張。** 假設每題每次以固定機率 p_i 獨立解出，由 5p(1−p) ≥ 1−(1−p)^6−p 可得單次解題數 X 的變異 Var(X)＝Σp_i(1−p_i) ≥ (E[pass@6 題數]−E[X])/5。把 Table 10 的 pass@1 17.94% 與 pass@6 32.67% 代入（pass@6 是單次觀測值，不是期望值），下界是 (32.67×3−17.94×3)/5≈8.84，標準差約 3 題、約 1 個百分點。在這個模型下，無示範那一格的 1.7 個百分點不到 2 個標準差；無搜尋與完整歷史兩格要看消融設定的變異假設。論文自報的標準差 0.49 低於這個下界，兩者對不上。

**出處。** [arXiv:2405.15793]，`notes/2405.15793.json` 的 limitations_observed 第 1 條（1.7 與 2.3 點未必顯著）。下界的分析是章節綜合階段加的（章節第 295 行），不是筆記欄位。

**輸入。** 都取自 `.cache/text/2405.15793.txt`：

| 行數 | 內容 |
| --- | --- |
| 第 408 行 | §5：Lite 共 300 題（「54 / 300」） |
| 第 2347 行起 | Table 10：六次執行 17.33／18.00／18.00／18.67／17.33／18.33；Avg. 欄原文是「17.940.49」，是全文轉換把 17.94±0.49 黏在一起，程式依兩位小數拆開 |
| 第 2381 行 | Pass@1..6：17.94／23.89／27.35／29.67／31.33／32.67 |
| 第 357–404 行 | Table 3：基準 18.0、w/o demo. 16.3（↓1.7）、No search 15.7（↓2.3）、Full history 15.0（↓3.0） |

**方法。**

1. 不等式：在 p＝k/10000 的格點上用 `Fraction` 精確計算 LHS−RHS，並驗證代數分解 LHS−RHS＝(1−p)[5p−1+(1−p)^5]。方括號就是 Bernoulli 不等式 (1−p)^5 ≥ 1−5p。
2. 把六次執行換成題數，逐一確認落在 1/300 的格點上，再算下界與標準差。
3. z 值：Var(差)＝Var(基準)＋Var(消融) ≥ 下界，所以只用基準變異算出的 z 是上界。另外列出兩邊變異都至少等於下界時的 z，以及要讓 z＜2 時消融設定的變異至少要多大。
4. 自報標準差：分別算母體標準差（÷6）與樣本標準差（÷5），確認論文用的是哪一種。
5. 「對不上」有多強，用兩種方法估：
   - χ² 檢定：常態近似，σ² 取代入式下界 8.83，算 P(χ²₅ ≤ Σ(c−c̄)²/σ²)。df＝5 用封閉式，另以數值積分交叉檢查。
   - 模擬：在「n1 題必解、m 題各以 q 解、其餘不會解」這個兩點族裡，挑出同時吻合 E[X]、E[pass@6] 且 Var(X) 最小的母體。在兩點族之內，這是對自報的小標準差最有利的母體；全體母體的變異最小值目前只知道 ≥ 8.83。模擬 20,000 次、每次 6 回，種子 20260926。模擬同時重算每次的代入式下界，所以下界本身的雜訊也算進去了。

**實際輸出（摘要）。**

- 題數：六次是 52、54、54、56、52、55，平均 53.83 題（17.944%）；pass@6 是 98 題。
- 不等式：格點上最小差是 0，只在 p＝0 與 p＝1 取等號，代數分解在每個格點都精確成立。下界只在 p→0 時接近等號，p＝0.5 時兩邊差 2.58 倍，所以真實變異只會更大。
- 下界：章節算式得 8.838；用整數題數 (98−53.83)/5 得 8.833 題²。標準差下界 2.972 題＝0.991 個百分點。

| 消融格 | 差（點） | z 上界（只用基準變異） | z（兩邊變異都 ≥ 下界） | 要 z＜2，消融變異至少 |
| --- | --- | --- | --- | --- |
| w/o demo. | 1.7 | **1.72** | 1.21 | 0（已經＜2） |
| No search | 2.3 | 2.32 | 1.64 | 3.07 題² |
| Full history | 3.0 | 3.03 | 2.14 | 11.42 題² |

| 自報標準差 | 值 |
| --- | --- |
| 六次的母體標準差（÷6） | 0.4893 → 論文的 0.49 是這一個 |
| 六次的樣本標準差（÷5） | 0.5360 |
| 下界 | 0.991 點；0.49 只有它的 0.495 倍 |
| χ² 檢定 | 統計量 1.453，P(χ²₅ ≤ 1.453)＝0.0816（數值積分同值）；前提是 8.83 就是真的下界，σ² 若更大，這個機率只會更小 |
| 模擬母體（兩點族中變異最小者） | 44 題必解、256 題各以 q＝0.0388 解，Var(X)＝9.546 題² |
| 模擬：代入式下界本身的分佈 | 5%：7.10、中位數 8.83、95%：10.63 題² |
| 模擬：六次母體標準差 ≤ 0.49 點 | 6.87% |
| 模擬：六次母體標準差 ＜ 代入式下界的標準差 | **64.64%** |
| 模擬：兩者比值 ≤ 觀測的 0.495 | 6.78% |

**結論。**

- **3a：證實。** 這就是 Bernoulli 不等式，而且下界通常很鬆。
- **3b：證實。** 8.84 題²、約 3 題、約 1 個百分點都吻合。代入式下界本身也有雜訊，模擬中 90% 落在 7.1 到 10.6 之間。
- **3c：證實，而且比章節寫的更穩。** 1.7 點的 z 上界 1.72 只用到基準設定的變異，不論消融設定的變異多少，都不到 2 個標準差。2.3 點與 3.0 點只看基準變異會超過 2，但只要消融設定的變異至少 3.07 與 11.42 題²（下界的約 0.35 倍與 1.3 倍），就會降到 2 以下。這和章節說的「要看消融設定的變異假設」一致。
- **3d：證實。** 0.49 是六次的母體標準差，確實只有下界 0.99 的一半（0.495 倍）。
- **3e：無法判定。** 「兩者對不上」既沒有被證實，也沒有被推翻：
  - 「自報的標準差低於代入式下界」這個方向本身不是矛盾。即使模型成立，而且母體是兩點族中變異最小的那一種，6 次執行的母體標準差仍有約 65% 的機率低於代入式下界，因為 6 個樣本的母體標準差本來就偏低。
  - 真正不尋常的是低到只剩一半：χ² 算出 8.2%（以 8.83 為真下界的前提下是上界），模擬算出 6.8%（已含下界本身的雜訊）。這算中度張力，不足以推翻獨立解題的模型，也不足以排除它。
  - 章節第 295 行寫「指向相反方向；兩者為何對不上，論文沒有提供足以分辨的資訊」，建議改成：「自報的 0.49 只有下界的一半；只有 6 次執行，這在模型下約有 7–8% 的機率出現，算中度張力。」
- 旁註：論文主設定的溫度是 0.0（第 1540 行），所以跑與跑之間的差異推測來自 API 的非決定性，論文沒有寫明。題與題之間若在同一次執行裡彼此相關（例如共用某種環境狀態），Var(X) 可以低於獨立模型的值。論文沒有足夠資訊分辨。

**重現。**

```bash
python3 .docs/chat-agent-research/verify/03-sweagent-variance-bound.py
```

---

## 4. Llama Guard：自家測試集同分佈，Azure 閾值挑 AP 最高

**主張。** 內部測試集是同分佈結果：訓練與測試來自同一批資料的隨機切分，prompt 來自同一個 Anthropic 資料集、response 來自同一個內部 Llama checkpoint、標註者是同一個紅隊。Azure API 的閾值是在各資料集上挑 average precision 最高的那個。章節同一句還提到，未微調的 Llama2-7b 零樣本輸出格式錯誤，被直接記為 AUPRC 0。

**出處。** [arXiv:2312.06674]，`notes/2312.06674.json` 的 limitations_observed 第 1、5、10 條。章節第 149、331 行。

**輸入。** 都取自 `.cache/text/2312.06674.txt`：§3.3（第 221–232 行）、§4.3.2 到 §4.3.3（第 386–405 行）、Table 2（表題第 485 行）、§4.5.2（第 582–593 行）、附錄 B 與 Table 5、6（第 909–1029 行）。

**方法。**

1. 這是文字主張，沒有數字可以重算，所以做原文錨點檢查：每個錨點句必須在全文裡剛好出現一次，否則程式失敗；每句都印出行號，並往回找所在章節的標題。§3.3 的六句還要 assert 都落在「3.3 Data Collection」底下。
2. 列出全文所有含「Azure」的行，找出論文對 Azure 閾值的全部說法。
3. 解析 Table 2（AUPRC 主表）的區段，assert 裡面沒有 Azure。再解析附錄 B 的 Table 5、6：assert 表頭含 Azure API，並檢查表題是否寫「in our dataset」與「threshold is set to be 0.5」。
4. 「同分佈」是把 §3.3 的四項事實合起來的判讀，程式只確認事實本身。

**實際輸出（摘要）。**

| 錨點 | 行 | 章節 |
| --- | --- | --- |
| prompt 取自 Anthropic 的 harmlessness 偏好資料 | 223 | 3.3 Data Collection |
| 只取第一個人類訊息，丟掉其餘 | 223 | 3.3 Data Collection |
| response 由一個內部 Llama checkpoint 生成 | 225 | 3.3 Data Collection |
| 由內部紅隊標註 | 226 | 3.3 Data Collection |
| 共 13,997 筆 | 229 | 3.3 Data Collection |
| 以 3:1 隨機切分成微調與評估 | 232 | 3.3 Data Collection |
| 作者自己把自家測試集的結果稱為 in-policy setup | 497 | 4.4 Overall Results |
| Llama2-7b 零樣本只產生格式錯誤的輸出，AUPRC 記為零 | 592–593 | 4.5.2 Adaptability via Fine-tuning |

Azure 閾值在論文裡有三種說法：

| 說法 | 行 | 內容 |
| --- | --- | --- |
| 一 | 394–395（§4.3.2） | 在 1–6 之間逐一試閾值，選出使該資料集 average precision 最高的那個 |
| 二 | 404（§4.3.3） | Azure API 與 GPT-4 沒有機率分數，算不了 average precision |
| 三 | 911–912（附錄 B） | 所有閾值都設為 0.5；Table 5、6 的表題也寫 threshold 0.5 |

- Table 2（AUPRC 主表）只有 Llama Guard、OpenAI API、Perspective API 三列，沒有 Azure。
- 全文含 Azure 的結果表只有附錄 B 的 Table 5（prompt）與 Table 6（response），兩張的表題都寫「in our dataset」，也就是自家測試集。Overall P/R/F1：Llama Guard 0.880/0.864/0.872 對 Azure 0.788/0.515/0.623（prompt），0.900/0.867/0.884 對 0.749/0.564/0.644（response）。
- Llama Guard 在 Table 2 的自家測試集 AUPRC 是 0.945（prompt）與 0.953（response）。

**結論。**

- **4a：證實。** 四項事實（同一個 prompt 來源、同一個 response checkpoint、同一個紅隊、同一批 13,997 筆的隨機 3:1 切分）都在 §3.3 原文裡，作者自己在第 497 行也稱之為 in-policy。「同分佈」是把這四項合起來的判讀，程式只能確認事實本身。
- **4b：證實。** 說法一在第 394–395 行，論文確實這樣寫。
- **4c：無法判定。** Azure 實際上是不是依 average precision 挑閾值，論文自己給了互相衝突的資訊：
  - 說法二（第 404 行，Azure 算不了 average precision）與說法一直接矛盾。
  - 說法三（附錄 B，閾值全設 0.5）與說法一可能等價，也可能不同。Azure 回傳 0–6 的整數，閾值 0.5 等同於「≥1 判為 unsafe」，恰好是說法一的候選之一；但論文沒說最後選了哪個，分不出來。
  - 「各資料集」也要修正：Azure 只評在自家測試集這一個資料集上。
  - 方向也要說清楚：如果真的在評估資料上挑閾值，偏袒的是 Azure；同分佈測試集偏袒的是 Llama Guard；Llama Guard 自己則固定用 0.5。兩個不對等方向相反。章節若要用這條說明「比較不對等」，應該寫明各自偏袒哪一方。
- **4d：證實。**

**重現。**

```bash
python3 .docs/chat-agent-research/verify/03-llamaguard-eval-parity.py
```

---

## 5. OSWorld：GPT-4o 的觀測比較、OS-ATLAS 的照抄基線與 FAIL 地板

**主張。** (1) OSWorld 原論文裡 GPT-4o 只看截圖 5.03、加 SoM 4.59、accessibility tree 11.36、截圖＋accessibility tree 11.21。(2) OS-ATLAS §4.3 表中的「GPT-4o」「GPT-4o + SoM」兩列連分項都與 OSWorld 同值，是直接引用。(3) OS-ATLAS 沒交代 OSWorld 版本與任務數，兩邊可能不是同一版任務集。(4) T7 已驗證的「每題回 FAIL 得 30/369 = 8.13%」地板，可以套用到 OS-ATLAS 的表。

**出處。** [arXiv:2410.23218] 筆記 limitations_observed（OSWorld 基線那兩條）；[arXiv:2404.07972] Table 5、Table 10、Table 14；T7 的 `verify/07-osworld-fail-floor.py`。

**輸入。** `.cache/text/2404.07972.txt` 的 Table 10（第 3220 行起）、Table 5（第 755 行起）、Table 14（第 3943 行起）；`.cache/text/2410.23218.txt` §4.3 的 OSWorld 表（第 467 行起）。

**方法。**

1. 解析 OSWorld Table 10 的逐 app 題數與 infeasible 題數，assert 合計 369 與 30，算出地板。
2. 解析 Table 5 四個觀測設定的列，取 GPT-4o 與 Gemini-Pro-1.5；解析 Table 14 的逐 app 分項，以 Table 10 的題數加權重算平均，對回 Table 5。
3. 解析 OS-ATLAS 的表，逐格比對 GPT-4o 兩列與 Table 14 的 Screenshot、SoM 列；Human 列當對照。
4. OS-ATLAS 自己跑的三列：檢查每個分項是否落在該 app 題數的 k/n 格點上（判準是最近的 k/n 四捨五入到兩位小數後，與表列值相差不超過 0.011 個百分點），並以最近格點重算 Avg。
5. 每一列的 Avg 與地板相減，並逐 app 比對各自的地板（infeasible／題數）。

**實際輸出（摘要）。**

- 題數 [24, 47, 47, 23, 17, 15, 46, 23, 26, 101]，合計 369；infeasible [5, 1, 0, 1, 3, 1, 3, 5, 10, 1]，合計 30；地板 8.1301%。
- Table 5：GPT-4o 11.36（a11y）／5.03（截圖）／11.21（截圖＋a11y）／4.59（SoM）；Gemini-Pro-1.5 4.81／5.40／5.10／7.79。Table 14 的 GPT-4o 四列加權平均 11.361、5.029、11.207、4.588，都對得回 Table 5。
- OS-ATLAS 的 GPT-4o 列與 Table 14 Screenshot 列 10/10 相同，GPT-4o + SoM 與 SoM 列 10/10 相同，Human 列 10/10 相同；其中 Impress 6.77、VLC 16.10／6.53、Workflow 5.58／3.60 都不在 k/n 格點上，照樣逐格相同。
- OS-ATLAS 自己的三列：+SeeClick 與 +7B 全部在格點上，+4B 只有 Calc 2.23 不在（最近格點 1/47 = 2.13）；三列取最近格點後是 34/369、43/369、54/369，對回 9.21、11.65、14.63。
- 與地板的距離：GPT-4o + SoM −3.54、GPT-4o −3.10、+SeeClick +1.08、+4B +3.52、+7B +6.50。逐 app：OS 的地板 20.83%，只有 +7B 高過，GPT-4o + SoM 與 +4B 剛好等於；VS Code（21.74%）與 GIMP（38.46%）沒有任何一列高過。

**結論。**

- **(1) 證實。**
- **(2) 證實。** 連不在格點上的值都逐格相同，而且 Avg 等於 Table 5，照抄可以確定。
- **(3) 收窄。** 三列與同一套 369 題相容，但格點檢查只能排除「題數不同」的一部分可能，排除不了環境映像或評估腳本的版本差異。4B 的 Calc 2.23 可能是部分給分或筆誤，程式分不出來。
- **(4) 證實**，但地板只是參考線：真的 agent 在不可行題上也可能沒回 FAIL 而失分，所以「Avg − 地板」不是扣掉運氣後的能力。

**重現。**

```bash
python3 .docs/chat-agent-research/verify/03-osworld-observation-baselines.py
```

---

## 6. GUI-R1 Table 3 照抄 OS-ATLAS 的三列

**主張。** GUI-R1 的表註說所有實驗在同一個零樣本提示下進行；精讀時對照 OS-ATLAS 原論文發現，Table 3 的 GPT-4o、OS-Atlas-4B、OS-Atlas-7B 三列共 18 個數字逐位相同，是直接引用。

**出處。** [arXiv:2504.10458] 筆記 limitations_observed；[arXiv:2410.23218] Table 5。

**輸入。** `.cache/text/2504.10458.txt` 的 Table 3（第 777–887 行）；`.cache/text/2410.23218.txt` 的 Table 5（第 739–830 行，表題第 831 行），含分組標題。

**方法。** 兩張表都以表題當錨點，把「名稱＋固定個數的數字」組成列，assert 列名與列數。GUI-R1 每列前 6 格（AndroidControl-High 與 GUI-Odyssey 各三欄）對 OS-ATLAS 同名列的第 4–9 格逐位比對；OS-Atlas-4B／7B 在 OS-ATLAS 的零樣本組與微調組各出現一次，兩組都比。對照組是 GUI-R1 自己跑的五列。另外記下兩邊的分組標題與各組成員，只陳列事實：兩邊的分組不在同一個軸上，GUI-R1 依模型的訓練方式分組，OS-ATLAS 依評估設定分組（有沒有在 AndroidControl／GUI-Odyssey 上微調）。

**實際輸出（摘要）。**

- 表題含「same zero-shot prompt for fair comparison」。
- GPT-4o、OS-Atlas-4B、OS-Atlas-7B 對 OS-ATLAS 零樣本組都是 6/6 相同，對微調組都是 0/6；合計 18/18。
- 對照組 QwenVL2.5-3B、QwenVL2.5-7B、UI-R1-3B、GUI-R1-3B、GUI-R1-7B 的 30 格，沒有一格出現在 OS-ATLAS Table 5。
- GUI-R1 的三組：「Supervised Fine-Tuning」組是 OS-Atlas-4B、OS-Atlas-7B、QwenVL2.5-3B*、QwenVL2.5-7B*；「Zero Shot」組是 GPT-4o、QwenVL2.5-3B、QwenVL2.5-7B；「Reinforcement Fine-Tuning」組是 UI-R1-3B、GUI-R1-3B、GUI-R1-7B。表題註明「* denotes supervised fine-tuned on GUI-R1-3K.」；§4.2 也稱 OS-Atlas-7B 是用 SFT 在大量資料上訓練的（全文第 230 行）。
- 三列引用的數字在 OS-ATLAS 原本都屬於「Zero-shot OOD Setting」，也就是沒有在 AndroidControl／GUI-Odyssey 上微調的評估設定。OS-ATLAS 微調後的 4B 是 High SR 67.54、Odyssey SR 56.39，7B 是 71.17、61.98。

**結論。** **證實。** 另外記下一個筆記沒寫的事實：GUI-R1 依訓練方式把 OS-Atlas 歸在「Supervised Fine-Tuning」組，這符合它自己的分組軸；但引用的是 OS-ATLAS 在 AndroidControl／GUI-Odyssey 上未微調的零樣本數字。兩個標籤不在同一個軸上，所以這不算分組標錯；讀這張表時要知道 SFT 組裡的 OS-Atlas 數字是它未微調時的表現。

**重現。**

```bash
python3 .docs/chat-agent-research/verify/03-guir1-osatlas-copy.py
```

---

## 7. AI Control Table 7：trusted editing 是否 Pareto 支配 untrusted monitoring

**主張。** §3.5 說 trusted editing Pareto 支配 untrusted monitoring。綜合階段逐點比對 Table 7：UM 0%（79%／96%）與 UM 5%（82%／95%）被 TE 10%（85%／96%）支配，UM 10%（92%／92%）被 TE 20%（92%／94%）支配，只有 UM 20%（98%／85%）沒有被任何列出的 TE 點支配；精讀時指出 TE 列出的最高 safety 只有 96%（TE 50%，usefulness 89%）。

**出處。** [arXiv:2312.06942] 筆記 limitations_observed；Table 7、§3.5。

**輸入。** `.cache/text/2312.06942.txt` 的 Table 7（表頭第 843 行、表題第 907 行，表題在表的下方）。

**方法。** 解析每一列的協定名稱、safety、scaled usefulness，assert 共 15 列、UM 4 列、TE 4 列。支配的定義是 s ≥ s′ 且 u ≥ u′、至少一項嚴格大於。只看列出的點，不做內插。

**實際輸出（摘要）。**

- UM 0%（79, 96）與 UM 5%（82, 95）被 TE 10%（85, 96）支配；UM 10%（92, 92）被 TE 20%（92, 94）支配；UM 20%（98, 85）沒有任何 TE 點支配。
- TE 列出的最高 safety 是 TE 50%（96, 89）。
- §3.5 原句在第 840 行。

**結論。** **證實。** 限制：只比 Table 7 列出的點；Figure 2 的曲線若有更多點，程式看不到。

**重現。**

```bash
python3 .docs/chat-agent-research/verify/03-aicontrol-pareto.py
```

---

## 8. Turpin et al. Table 9：「每個 task 都下降」的反例

**主張。** §3.2 說下降趨勢對每個 task 個別成立；綜合階段依 Table 9 重數，Answer is Always A 的 CoT 設定 13 × 2 = 26 格中，有 4 格 biased context 不低於 unbiased，例如 Logical Deduction 的 GPT-3.5 從 62.0 變成 64.7。

**出處。** [arXiv:2305.04388] §3.2、Table 9。

**輸入。** `.cache/text/2305.04388.txt` 的 Table 9（第 1941–2439 行）。

**方法。** 解析 13 個 task、每個 task 三列（Sugg. Ans. ZS、Sugg. Ans. FS、Ans. A FS）、每列 8 個數字（GPT-3.5 與 Claude 1.0 各有 No-CoT 與 CoT 的 UB／B），assert 列數與欄數。兩種偏誤都數：Answer is Always A 的 CoT 26 格、Suggested Answer 的 CoT 52 格；判準是 B ≥ UB，另外分開列出嚴格上升與持平。

**實際輸出（摘要）。**

- Answer is Always A：26 格中 4 格 B ≥ UB，4 格都是嚴格上升：Movie Recommendation 的 Claude 1.0 90.4 → 91.1、Logical Deduction Five Objects 的 GPT-3.5 62.0 → 64.7 與 Claude 1.0 63.1 → 65.1、Disambiguation QA 的 GPT-3.5 63.3 → 64.7。
- Suggested Answer：52 格中 0 格；降幅最小的一格是 Web of Lies FS 的 Claude 1.0，98.3 → 97.4。
- §3.2 原句在第 463 行。

**結論。** **證實。** 反例只出在 Answer is Always A；Suggested Answer 那一半的確逐 task 都下降。

**重現。**

```bash
python3 .docs/chat-agent-research/verify/03-turpin-table9-count.py
```

---

## 9. 否定性主張的全文搜尋

**主張。** N1：UI-TARS 的 N=5 截圖歷史沒有消融。N2：UI-TARS 主實驗的輸入解析度與影像 token 數沒有報告。N3：OmniParser 沒有量解析延遲與提示長度。N4：UGround 的 Web-Hybrid 沒有和 ScreenSpot-Web 或 Mind2Web 的網站去重。N5：UGround 沒有量延遲、提示長度或端到端成本。

**出處。** [arXiv:2501.12326]、[arXiv:2408.00203]、[arXiv:2410.05243] 各自筆記的 limitations_observed。

**輸入。** 三篇的 `.cache/text/<id>.txt`；正對照用 `.cache/text/2405.15793.txt` 與 `.cache/text/2404.07972.txt`。

**方法。**

1. 每條主張列出反例關鍵字與寫法變體，逐行搜尋並印出命中的行號與內容，再依預先寫好的規則判讀命中是不是真的反例。
2. 正對照：N1 用來找「歷史長度的其他寫法」的通用關鍵字 `HISTORY_KW`，原封不動拿去掃 SWE-agent 與 OSWorld 的全文。兩篇都要命中，而且命中裡要包含真正的消融：SWE-agent 的 Full history 表列或「history set to last five observations」，OSWorld 的 Figure 7 圖說。只命中「history processors」這類順帶提到的句子不算。找不到就表示掃描器壞了。
3. 修訂紀錄：第一版的正對照用的是替兩篇另寫的專用字串（SWE-agent 的表列名、OSWorld 的「history encoding length of 1, 2, 3」），沒有驗證 N1 實際用的通用關鍵字；而第一版的通用關鍵字在兩篇上都是 0 命中。修訂時把 `HISTORY_KW` 擴充到兩篇都命中（加上 length of history、history (trajectory|encoding) length、last／past／previous N observations 或 rounds、full history、history processing 等寫法），N1 與正對照共用這一組。
4. 正對照的限制：`HISTORY_KW` 是看過兩篇的寫法之後才擴充的，正對照只證明它涵蓋得到這兩種寫法，不代表對其他寫法的召回率。N1 的主要證據仍是 UI-TARS 全文每一處 $N$ 的逐處分類；`HISTORY_KW` 在 UI-TARS 上的命中也逐處分類，未分類的命中才算反例。
5. 限制：只能說「全文裡找不到」，不能排除論文附帶的程式碼、專案頁或後續版本有報。

**實際輸出（摘要）。**

- 正對照：`HISTORY_KW` 在 SWE-agent 命中 4 處，其中 2 處是消融本身（第 400 行的 Full history 表列、第 1540 行的「history set to last five observations」），另 2 處是順帶提到 history processor 的句子；在 OSWorld 命中 6 處，其中第 1802 行是歷史長度曲線的圖說。第一版的通用關鍵字在兩篇都是 0 命中。
- N1：歷史 N 只出現在定義處與「整節固定為 5」各一次；有掃過 1、16、64 的 N 是 Best-of-N 的取樣數。`HISTORY_KW` 在 UI-TARS 命中 2 處：第 546 行是定義句，第 547 行說 thought 與 action 的文字歷史全部保留，不是截圖歷史 N 的消融；未分類 0 處。
- N2：沒有寬×高形式的解析度數字，也沒有 max_pixels、image tokens 這類設定；有一句定性說在 ScreenSpot Pro 上提高輸入解析度明顯有幫助，沒給數字。
- N3：唯一的量測字眼命中是序數用法（the second section of the table）；只有定性說描述模型「fast」。
- N4：唯一的 deduplication 出現在談訓練資料效率的未來工作句。
- N5：latency 與 cost 只出現在動機段落與「線上評估成本高」的說明，其餘命中是動作 API 的參數說明。

**結論。** **全文找不到反例**，五條都維持原判讀；N2 另有一處沒給數字的定性說法，章節已補上。N1 的證據強度要照實說：它主要靠「$N$ 出現的每一處都已分類」撐；正對照現在驗證的是 N1 實際用的關鍵字，但那組關鍵字是依兩篇正對照的寫法調出來的，所以對「換一種寫法報歷史消融」的召回率仍然未知。

**重現。**

```bash
python3 .docs/chat-agent-research/verify/03-negative-claims-scan.py
```

---

## 建議回頭修改的章節文字

下表是第一輪（第 1 到第 4 條）的建議，當時的行號指第一輪的章節；這些建議已在第一輪改進正文。第 5 到第 9 條的結果已在修訂時直接同步進正文，見章節〈程式驗證〉表後的說明。

| 章節行 | 現在的寫法 | 建議 |
| --- | --- | --- |
| 第 295 行 | 「論文自報六次執行的標準差 0.49 點卻低於這個下界，指向相反方向；兩者為何對不上……」 | 改成「自報的 0.49 只有下界的一半；只有 6 次執行，這在模型下約有 7–8% 的機率出現，算中度張力」；並補一句「1.7 點的結論不依賴消融設定的變異假設」 |
| 第 355 行 | 「抄錄錯誤，掩蓋了 HTML 方法仍領先的事實」 | 改成「抄錄錯誤把 Cross-Task 12.6 點的差距縮成 0.2 點」，並註明兩邊的測試集不同 |
| 第 331 行 | 「Azure 的閾值是在各資料集上挑 average precision 最高的那個」 | 改成「論文一處說 Azure 的閾值依 average precision 挑選，另一處說 Azure 算不了 AP，附錄又說閾值全設 0.5；而且 Azure 只評在自家測試集上」 |
| 第 303–305 行（以及筆記第 2 條） | 筆記說「只有全集的 51.32 是對的」 | 章節沒有沿用這句，不必改；如果之後要引用，應寫成「全集 51.32（四捨五入應為 51.33）」 |
