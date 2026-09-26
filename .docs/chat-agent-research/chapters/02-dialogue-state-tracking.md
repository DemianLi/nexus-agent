# 02｜Multi-Turn State Tracking / DST（多輪狀態追蹤）

## 這一章回答什麼

本章處理多輪對話中的狀態怎麼表示、怎麼逐輪更新、在長互動裡怎麼維持，範圍從任務型對話的 DST 與資料集、LLM 時代的 zero/few-shot DST，到 LLM agent 的外部記憶與多輪退化 [arXiv:1810.00278][arXiv:2203.08568][arXiv:2310.08560][arXiv:2505.06120]。本節點精讀 24 篇、計入 23 篇，另有 7 篇候補未讀；計入的分佈是傳統任務型對話 DST 與資料集 9 篇（配額 9）、LLM 時代的 zero/few-shot DST 7 篇（配額 7）、LLM agent 的多輪狀態維護與多輪退化 7 篇（配額 8，少的那一篇 Drift No More 精讀後判為低價值，只當反例）（篇數由 reading-status.json 計算）[arXiv:2510.07777]。全章的主軸是「狀態怎麼跨輪更新」：三個子領域發展出插值、覆寫、每輪重算、差分累加、只增不刪、agent 自己改寫、ADD／UPDATE／DELETE、讀取時裁決等做法，但依各篇筆記，沒有一篇把「更新這一步對不對」單獨拿出來量（撰寫本章時的歸納）[arXiv:1606.03777][arXiv:2005.02877][arXiv:2203.08568][arXiv:2504.19413][arXiv:2512.12818]。第二個子領域雖名為「LLM 時代」，七篇裡真正以提示驅動大型 LM 的只有 IC-DST 與 FnCTOD，其餘五篇是微調的前身 [arXiv:2203.08568][arXiv:2402.10466]。範圍列出的「指令在多輪中的保持」，計入的 23 篇裡沒有一篇直接量；最接近的 Lost in Conversation 量的是一條完整指令被拆成多輪逐片給出時的表現，不是早先給的指令在後面是否仍被遵守（撰寫本章時依筆記判斷）[arXiv:2505.06120]。

## 問題的演進

三個子領域的時間大致前後相接：傳統 DST 集中在 2016 到 2020 年，zero/few-shot DST 在 2020 到 2024 年，LLM agent 的記憶與多輪退化在 2023 到 2025 年（年份取自 arXiv 編號的前兩碼）。前兩者共用 MultiWOZ 與 SGD 這兩個考場，狀態都是 slot-value；第三者的狀態改成自然語言事實、摘要或圖，評估也從 JGA 換成下游問答與任務分數 [arXiv:1810.00278][arXiv:1909.05855][arXiv:2504.19413][arXiv:2505.06120]。

### 傳統任務型對話 DST 與資料集（2016–2020）

這九篇依序處理了幾件事：先讓模型不靠人工字典也能從語句認出 slot-value，再讓稀有值借用其他 slot 的資料，接著把問題放大到多領域並建立共同考場，然後把「值要事先列舉」與「slot 要事先列舉」兩層封閉假設逐層拆掉，最後回頭修改考場的標註與計分規則 [arXiv:1606.03777][arXiv:1805.09655][arXiv:1810.00278][arXiv:1905.08743][arXiv:1909.05855][arXiv:2007.12720]。貫穿全線、卻沒有一篇正面處理的，是跨輪的狀態到底怎麼維護（撰寫本章時的歸納，見本小節最後一段）。

**2016：用詞向量取代人工字典，跨輪維護交給一條規則（NBT）。** 當時在 DSTC2 表現最好的 delexicalisation 路線要靠人工語意字典，才能把 affordable 這類改寫對到 price=cheap，而字典在大領域或形態變化豐富的語言上建不起來 [arXiv:1606.03777]。NBT 把「這句話加上系統上一句話，有沒有表達某個 slot-value」變成二元分類。語句與候選 slot-value 都用固定不動、以 PPDB 做過語意特化的 Paragram-SL999 詞向量組成表示；系統上一輪的 request 與 confirm 以點積當閘門 [arXiv:1606.03777]。結果如下 [arXiv:1606.03777]：

- DSTC2 的 joint goal 從無字典基線的 69.1 升到 73.4（NBT-CNN）[arXiv:1606.03777]。
- 本文擴充釋出的 WOZ 2.0（1,200 通）上，從 70.8 升到 84.4（NBT-DNN）[arXiv:1606.03777]。
- 相對加了字典的基線（72.9、83.7），只是沒有顯著差異 [arXiv:1606.03777]。

跨輪的信念狀態完全不學，只用「累積信念＝0.55×本輪機率＋0.45×前一輪累積信念、門檻 0.5」這條插值規則 [arXiv:1606.03777]。精讀時發現，照字面實作這條規則會有兩個後果 [arXiv:1606.03777]：

- 一個已確定（機率 1.0）的目標只要下一輪沒被重提，就會掉到 0.45×1.0 = 0.45 而被移出 [arXiv:1606.03777]。
- 從零開始時，本輪機率要達 0.5 / 0.55 ≈ 0.91 才立得起來 [arXiv:1606.03777]。

**2018 上半：跨 slot 共享參數，處理長尾值（GLAD）。** GLAD 指出，DST 資料相對於狀態空間太小：WoZ 中 38.6% 的輪次，其 joint goal 含有訓練樣本少於 20 筆的稀有值；NBT 這類做法對每個 slot 各自估計，slot 之間無法共享 [arXiv:1805.09655]。它讓所有 slot 共用一組 global biLSTM 加自注意力，每個 slot 另有一組 local 版本，以可學的純量 β_s 混合 [arXiv:1805.09655]。WoZ 測試集 joint goal 是 88.1±0.4，DSTC2 是 74.5±0.2，都是 10 個種子的平均與標準差 [arXiv:1805.09655]。它是本子領域最早報多種子平均與標準差的方法論文：更早的 NBT 每個設定只報單次結果（精讀時指出），之後的 SUMBT（20 個種子）與 TripPy（3 個種子）也報了變異 [arXiv:1606.03777][arXiv:1805.09655][arXiv:1907.07421][arXiv:2005.02877]。joint goal 仍由「同 slot 覆寫」規則累加；精讀時指出，這條規則沒有刪除或撤銷限制的機制 [arXiv:1805.09655]。

**2018 下半：多領域資料與共同考場（MultiWOZ）。** 既有的結構化標註語料只有數百到兩千多則對話，多半單一領域 [arXiv:1810.00278]。MultiWOZ 把 Wizard-of-Oz 改成完全群眾外包，蒐集到 10,438 則、7 個領域的人對人打字對話 [arXiv:1810.00278]。belief state 不另外標註，而是 wizard 為了查資料庫而填、跨輪保留的網頁表單快照 [arXiv:1810.00278]。這份資料把多輪狀態定義成「每領域 slot→value 的累積表」，之後本章兩個 DST 子領域幾乎每一篇都拿它的某個版本當考場 [arXiv:1810.00278][arXiv:1905.08743][arXiv:2005.02877][arXiv:2203.08568]。它自己的 DST 實驗很薄，只在 restaurant 子集上跑同組的 MDBT，得到 Joint goals 80.9 [arXiv:1810.00278]。精讀時發現，兩次 Fleiss' κ（0.704、0.884）量的都是 system act，belief state 的標註一致性從未被量測 [arXiv:1810.00278]。

**2019 年 5 月：值不必事先列舉（TRADE）。** TRADE 指出，ontology 分類路線在多領域下撐不住：MultiWOZ 有 30 個 (domain, slot) pair、4,500 多個值，資料庫常只透過 API 暴露而列舉不出值 [arXiv:1905.08743]。它改成對每個 (domain, slot) 從最近 l 回合的歷史「生成」值，用跨領域共用的 GRU 解碼器加 soft-gated 複製，再以 ptr／none／dontcare 三分類的 slot gate 決定是否採用 [arXiv:1905.08743]。MultiWOZ 2.0 五領域 joint goal 是 48.62，高於 GCE 36.27、GLAD 35.57、MDBT 15.57 [arXiv:1905.08743]。它也揭露了前一代方法搬到多領域的落差：GLAD 在 WoZ 是 88.1，在 TRADE 重跑的 MultiWOZ 五領域只剩 35.57 [arXiv:1805.09655][arXiv:1905.08743]。它留下兩件事 [arXiv:1905.08743]：

- (domain, slot) 清單仍要事先定義 [arXiv:1905.08743]。未見過的 slot 只有一個未訓練的名稱嵌入，所以留一領域零樣本只有 taxi 做到 60.58，其他四個領域只有 11.52–22.37 [arXiv:1905.08743]。
- 每輪從歷史視窗重新生成全部 30 個 pair，不把上一輪狀態當輸入延續（精讀時的分析）[arXiv:1905.08743]。

這個留一領域零樣本的設定，後來成了第二個子領域 T5DST、TransferQA、D3ST 的共同考場 [arXiv:2105.04222][arXiv:2109.04655][arXiv:2201.08904]。

**2019 年 7 月：一個模型追所有 slot，但值只能從本體挑（SUMBT）。** 當時的神經 DST 有兩種擴充性問題：每個 domain 或 slot 各自建模，以及輸出層綁定候選值清單、本體一改就得重訓 [arXiv:1907.07421]。SUMBT 把 domain-slot 名稱的文字當成「問題」，用凍結的 BERT 編碼 slot 與候選值，以 slot 向量為 query 對當回合語句做 multi-head attention [arXiv:1907.07421]。每個 slot 沿回合跑一條共享參數的 RNN，最後在 BERT 空間以距離挑最近的候選值 [arXiv:1907.07421]。WOZ 2.0 的 JGA 是 0.910（±0.010，20 個種子），MultiWOZ 上是 0.4240 [arXiv:1907.07421]。精讀時發現兩件事 [arXiv:1907.07421]：

- WOZ 2.0 上三個 BERT 基線（0.891–0.893）已經超過所有先前模型，提升主要來自 BERT [arXiv:1907.07421]。
- 跨回合資訊只靠 RNN 隱藏狀態攜帶，狀態既不能檢查，也不能從外部修正後再往下接 [arXiv:1907.07421]。

SUMBT 與 TRADE 是 ACL 2019 的同期論文，SUMBT 沒有提到 TRADE，兩者的 slot 集合也不同（35 對 30）（精讀時發現）[arXiv:1907.07421]。

**2019 年 9 月：slot 與 intent 也不必事先列舉（SGD）。** SGD 從虛擬助理要接的服務越來越多、長尾服務沒有訓練資料這個情境出發，主張不定大一統 schema，改由每個服務在執行期提供自己的 schema：服務、intent、slot 的自然語言描述，以及 categorical slot 的可能值 [arXiv:1909.05855]。狀態逐服務定義為一個 frame，含 active intent、requested slots，以及到目前為止的 slot 指派 [arXiv:1909.05855]。附帶的 BERT 原型只看前一句系統語句與當前使用者語句，對 user goal 只預測相對上一輪的差分，推論時逐輪累加 [arXiv:1909.05855]。資料 train 有 16,142 段對話、26 個服務，評估集另含未見的服務與領域 [arXiv:1909.05855]。原型的 JGA 很低（SGD-S 0.356、SGD-All 0.254），也沒有 baseline 與消融；精讀時指出，「零樣本來自以描述為條件」這個核心主張沒有被因果驗證 [arXiv:1909.05855]。

SGD 留下的兩個構想，後來都在第二個子領域被接手 [arXiv:1909.05855][arXiv:2105.04222][arXiv:2201.08904][arXiv:2203.08568]：

- 以自然語言描述為條件：T5DST 把描述的寫法當成實驗變數，D3ST 直接在 SGD 與改寫版 SGD-X 上評估 [arXiv:2105.04222][arXiv:2201.08904]。
- 只預測差分再累加：IC-DST 以本輪狀態變化為標籤 [arXiv:2203.08568]。

**2020 年 5 月：值從對話本身複製（TripPy）。** 純 span 抽取只在值以原字串出現在使用者話語時有效，遇到共指、跨領域值共享、隱含接受系統推薦時就會失效；結果形成「越不依賴值清單、分數越差」的取捨 [arXiv:2005.02877]。TripPy 用 BERT 編碼本回合加由新到舊排列的完整歷史，每個 slot 配一個五類 gate，值由三條複製路徑之一取得 [arXiv:2005.02877]：

- span：從使用者話語抽出 [arXiv:2005.02877]。
- inform：從系統本回合告知的值複製 [arXiv:2005.02877]。
- refer：從對話狀態裡另一個 slot 複製 [arXiv:2005.02877]。

MultiWOZ 2.1 的 JGA 是 55.29 ± 0.28（三個種子），同樣不用候選清單的 DST-span 只有 40.39，用完整本體的 DST-picklist 是 53.30 [arXiv:2005.02877]。狀態更新沿用規則：預測不是 none 就覆寫，是 none 就沿用舊值 [arXiv:2005.02877]。精讀時發現這條規則沒有刪除路徑，寫錯的值除非之後被覆寫，否則會一路帶到對話結束 [arXiv:2005.02877]。

**2020 年 5 月：狀態變成模型寫出來的一段文字（SimpleTOD）。** SimpleTOD 與 TripPy 同月上 arXiv，走的是另一條路 [arXiv:2005.00796]。它把 context、belief state、DB 彙總、系統動作、去詞彙化回應串成一條序列，用單一因果 LM（GPT-2 系列）以標準 LM loss 學 [arXiv:2005.00796]。belief state 寫成「domain slot_name value」三元組文字；每回合從完整歷史重新生成整份狀態，不讀入上一回合的狀態，序列超過 1,024 token 就截斷 [arXiv:2005.00796]。MultiWOZ 2.1 的 JGA 是 55.76（用 TRADE 的標籤清理腳本）[arXiv:2005.00796]。精讀時發現，附錄範例從第 2 回合起，context 裡的系統話語都是資料集的參考回覆，也就是模型從來沒有在自己犯過的錯誤之上繼續對話 [arXiv:2005.00796]。後來 T5DST 把 SimpleTOD（GPT-2）的輸入加上 slot 名稱，以 SimpleTOD++ 之名放進零樣本比較表當基線 [arXiv:2105.04222]。

**2020 年 7 月：回頭修尺（MultiWOZ 2.2）。** MultiWOZ 2.2 指出 2.1 的標註有三類毛病 [arXiv:2007.12720]：

- 幻覺值：狀態裡出現對話沒講過的值，合計出現在 948 段對話的 3128 輪 [arXiv:2007.12720]。
- 說法不一：同一個值有多種說法，評估卻只給一個正解 [arXiv:2007.12720]。
- ontology 問題：約 21.0% 的 ontology 值無法用精確字串比對對回資料庫 [arXiv:2007.12720]。

它的修法是事後套用 SGD 式 schema [arXiv:2007.12720]：

- categorical slot 只能從候選清單挑 [arXiv:2007.12720]。
- non-categorical slot 的值必須出現在對話歷史並標出 span，狀態可以是一份等價值清單 [arXiv:2007.12720]。
- 從其他 slot 沿用的值記錄來源 slot [arXiv:2007.12720]。

它在 §2.2 列出一個值進入狀態的四種來源：使用者說的、系統提議的、從另一個領域的 slot 沿用的、來自 ontology 的 [arXiv:2007.12720]。前三種正好對上 TripPy 的 span、inform、refer，第四種正是 TripPy 刻意不依賴的候選清單（撰寫時對照兩份筆記）[arXiv:2007.12720][arXiv:2005.02877]。精讀時發現，「值必須出現在對話歷史」這條規則把需要推理的更新（例如 after lunch、依預約時間回推）排除在基準之外 [arXiv:2007.12720]。

**本子領域的跨輪維護：每篇一種做法，各有失敗型態。** 把九篇放在一起看，跨輪維護的方式各不相同（下列失敗型態多為精讀時的分析）：

- NBT：固定係數的機率插值，沒被重提的目標會衰減掉 [arXiv:1606.03777]。
- GLAD：規則覆寫，錯的值會一直留到同一 slot 被再次指定 [arXiv:1805.09655]。
- TRADE：每輪從最近 l 回合的歷史重新生成，視窗外提過的值只能靠當輪重新找到 [arXiv:1905.08743]。
- SUMBT：狀態藏在 RNN 隱藏狀態裡，不能檢查也不能外部修正 [arXiv:1907.07421]。
- SGD 原型：累加差分，判錯的值會一路帶下去，也無法從更早的 turn 或別的服務 frame 複製值 [arXiv:1909.05855]。
- TripPy：只覆寫、不刪除 [arXiv:2005.02877]。
- SimpleTOD：每回合從完整歷史重寫整份狀態，超過 1,024 token 時較早的約束會無聲消失，而這個風險沒有被量 [arXiv:2005.00796]。
- MultiWOZ 2.2 不提供模型，而是規定狀態值要能回溯到出處 [arXiv:2007.12720]。

沒有一篇把「跨輪維護」這一步單獨拿出來評估 [arXiv:1606.03777][arXiv:1805.09655][arXiv:1905.08743][arXiv:1907.07421][arXiv:1909.05855][arXiv:2005.02877][arXiv:2005.00796]。資料面也一樣：MultiWOZ 的目標變更只有「初始約束查無資料、改用替代值」一種觸發方式（精讀時的分析）[arXiv:1810.00278]。

### LLM 時代的 zero/few-shot DST（2020–2024）

本子領域七篇都被歸在「LLM 時代的 zero/few-shot DST」，但以提示或 in-context learning 驅動大型 LM 的只有 IC-DST 與 FnCTOD [arXiv:2203.08568][arXiv:2402.10466]。其餘五篇都是微調：TOD-BERT 從 BERT-base 繼續預訓練，T5DST 用 T5-small，TransferQA 用 T5-large，DaP 用 T5-small／base，D3ST 最大到 11B 的 T5 XXL [arXiv:2004.06871][arXiv:2105.04222][arXiv:2109.04655][arXiv:2109.07506][arXiv:2201.08904]。DaP 甚至沒有任何 zero-shot 或 few-shot 實驗 [arXiv:2109.07506]。所以這一段比較準確的讀法是：上一個子領域的考場與狀態定義，怎麼被搬到「少標註或不標註」的設定上。主軸有三條：狀態怎麼表示、怎麼向模型提問、上一輪的狀態有沒有被沿用。

**2020 年 4 月：用任務型對話語料繼續預訓練（TOD-BERT）。** TOD-BERT 與 TripPy、SimpleTOD 同一時期，出發點是 BERT 的預訓練語料與任務型對話的語言型態有落差 [arXiv:2004.06871]。作者把九個人對人任務型對話資料集合併成 100,707 通對話，以 [USR]／[SYS] 標記做 MLM，並用批次內負樣本的 response contrastive loss 取代 NSP [arXiv:2004.06871]。它的 DST 頭仍是 SUMBT 那一類的封閉 ontology 分類：每回合從截斷後的完整歷史重新分類整個狀態 [arXiv:2004.06871]。MultiWOZ 2.1 全量資料的 JGA 是 48.0（BERT 45.6），只用 5% 資料時是 28.6 對 19.6 [arXiv:2004.06871]。精讀時指出，MultiWOZ 的對話文字已經在預訓練語料裡 [arXiv:2004.06871]。

**2021 年 5 月：逐 slot 生成式問答，並把描述的寫法當成實驗變數（T5DST）。** T5DST 讓 T5-small 讀「完整對話歷史＋slot 名稱或描述」，逐 slot 生成值 [arXiv:2105.04222]。它接手了 SGD 以描述為條件的構想，並補上 SGD 沒做的對照：比較有描述與沒描述，以及描述該怎麼寫 [arXiv:2105.04222][arXiv:1909.05855]。在 TRADE 的 MultiWOZ 2.0 留一領域 zero-shot 設定下，五領域平均 JGA 如下 [arXiv:2105.04222]：

| 設定 | 平均 JGA | 出處 |
| --- | --- | --- |
| Slot Type 描述（描述前加型別前綴，作者提出） | 35.20 | [arXiv:2105.04222] |
| 只用 slot 名稱 | 33.56 | [arXiv:2105.04222] |
| 人寫描述 | 33.14 | [arXiv:2105.04222] |
| SimpleTOD++ | 29.65 | [arXiv:2105.04222] |
| TRADE | 25.76 | [arXiv:2105.04222] |

也就是說，只用 slot 名稱就已經比 TRADE 高 33.56 − 25.76 = 7.8 個百分點；描述本身的增益小得多 [arXiv:2105.04222]。它每輪要對每個 slot 各跑一次完整歷史的前向 [arXiv:2105.04222]。

**2021 年 9 月：借 QA 資料做跨任務轉移，把 none 當成無答案題（TransferQA）。** TransferQA 讓 T5-large 在 6 個抽取式與 2 個多選 QA 資料集上學一個統一的生成式 QA 模型，再人造無法回答的題目，教模型回答 none [arXiv:2109.04655]。這針對的是 none 的普遍性：MultiWOZ 有 55.25% 的 slot 值是 none，taxi 高達 71.85% [arXiv:2109.04655]。完全不用 DST 資料，它在 MultiWOZ 2.1 的逐領域平均 JGA 是 35.77 [arXiv:2109.04655]。它自己的分析點出瓶頸：79.79% 的錯誤來自「該不該回答」的 slot gate，給定正確的 gate 後，平均 JGA 可以從 35.77 升到 56.06 [arXiv:2109.04655]。

**2021 年 9 月：同一種介面的全量微調版本（DaP）。** DaP 把對話歷史與 [domain]／[slot] 提示（名稱、描述、類別槽的可能值）串成一條輸入送進 T5，對每個 domain-slot 各自解碼 [arXiv:2109.07506]。它評估在上一個子領域剛釋出的 MultiWOZ 2.2 上：T5-base 逐槽解碼 56.7，加描述 57.6，同一骨幹一次生成全部三元組只有 51.2 [arXiv:2109.07506]。精讀時指出，它的核心形式和早四個月上 arXiv 的 T5DST 高度重疊，卻沒有引用 T5DST [arXiv:2109.07506]。撰寫第 3 組草稿時比對全文發現，IC-DST 表中標為 SGPDST 的就是 DaP；DaP 僅有的 few-shot 數字是 IC-DST 量的，不是 DaP 自己的結果 [arXiv:2203.08568][arXiv:2109.07506]。

**2022 年 1 月：一次解碼所有 active slot，索引逐例重排（D3ST）。** D3ST 批評逐 slot 解碼：slot 一多推論成本就線性上升，而且大多數 slot 在任一時刻都是 inactive [arXiv:2201.08904]。它把每個 slot 與 intent 只留一句自然語言描述，前面掛一個每個訓練樣本都重新洗牌的數字索引，模型一次輸出所有 active slot 的「索引:值」與 active intent [arXiv:2201.08904]。SGD 上 XXL 的 JGA 達 86.4（unseen 服務 83.3），MultiWOZ 2.1 留一領域的平均 JGA 是 46.7，同表的 TransferQA 是 35.8、T5DST 是 35.2 [arXiv:2201.08904]。SGD 的 86.4／83.3 來自 11B 的 XXL；留一領域的 46.7，論文表中沒寫 D3ST 用的模型尺寸 [arXiv:2201.08904]。SGD unseen 服務上，和 DaP 同為 T5 Base 的 D3ST Base 是 66.4，低於 DaP(ind) 的 68.0 [arXiv:2201.08904]。精讀時另外指出，作為核心機制的索引隨機化沒有消融，一再強調的效率也沒有延遲量測 [arXiv:2201.08904]。

**2022 年 3 月：凍結 LLM 的 in-context learning，歷史換成上一輪狀態（IC-DST）。** IC-DST 認為，先前把 ICL 用在 DST 之所以遠遜於微調，是因為對話歷史太長、輸出又必須對齊結構化的 ontology [arXiv:2203.08568]。它用三個設計回應 [arXiv:2203.08568]：

- 狀態寫成 SQL [arXiv:2203.08568]。
- 脈絡只送「前一輪狀態＋本輪系統語句＋本輪使用者語句」[arXiv:2203.08568]。
- 標籤改成本輪的狀態變化，再由程式把變化套到前一輪狀態上 [arXiv:2203.08568]。

範例由一個以「狀態變化相似度」微調過的 SBERT 檢索器挑選 [arXiv:2203.08568]。以 Codex 為推論模型，MultiWOZ 2.1 在 1%／5%／10% 資料下的 JGA 是 43.13／47.08／48.67，先前的 DS2-T5 是 33.76／44.20／45.38 [arXiv:2203.08568]。

測試時 IC-DST 沿用的是模型自己累積的預測狀態，不是 gold [arXiv:2203.08568]。這不是本章第一篇這樣做的：NBT、GLAD、SGD 原型與 TripPy 測試時都在自己的預測上累積 [arXiv:1606.03777][arXiv:1805.09655][arXiv:1909.05855][arXiv:2005.02877]。IC-DST 的不同之處，在於把上一輪預測狀態的完整內容當成顯式文字輸入交給模型；TripPy 只以二元特徵標記哪些 slot 已填過，不帶值（撰寫本章時比對筆記）[arXiv:2203.08568][arXiv:2005.02877]。它的「只預測變化」也和 SGD 原型的差分式 user goal 同形，差別在 SGD 原型不看上一輪狀態 [arXiv:2203.08568][arXiv:1909.05855]。精讀時指出，錯誤會沿著累積狀態往後傳，但論文沒量這個效應 [arXiv:2203.08568]。主模型 code-davinci-002 已於 2023-03-23 下架，原設定無法重現 [arXiv:2203.08568]。

**2024 年 2 月：狀態就是函式呼叫的參數（FnCTOD）。** FnCTOD 認為，先前的 LLM 提示法只有 Codex、ChatGPT 這類強模型做得起來，而且輸出領域特定的格式，和 chat 模型原本擅長的事脫節 [arXiv:2402.10466]。它把每個領域寫成一個函式、slot 寫成參數；每輪先只看各函式的簡述選出領域，再只放入被選函式的完整規格生成參數；先前輪次的函式呼叫留在對話歷史裡 [arXiv:2402.10466]。MultiWOZ 2.1 上 GPT-4 的 Average JGA 是 62.59，只用 7,200 段非 MultiWOZ 對話 LoRA 微調的 FnCTOD-LLaMA2-13B 是 59.54 [arXiv:2402.10466]。精讀時依公開程式碼指出，它的合併規則只增不刪、每輪只更新一個領域，和 TripPy 的「只覆寫、不刪除」是同一類限制 [arXiv:2402.10466][arXiv:2005.02877]。

**本子領域的共同線索（撰寫者歸納）。** 狀態的表示依序是：封閉 ontology 上的分類、逐 slot 的生成式提問、一次輸出帶索引的 active slot、SQL 形式的狀態變化、函式呼叫的參數 [arXiv:2004.06871][arXiv:2105.04222][arXiv:2201.08904][arXiv:2203.08568][arXiv:2402.10466]。狀態的維護分成兩派：

- 每輪重算：TOD-BERT、T5DST、TransferQA、DaP、D3ST 每一輪都從完整歷史重算整份狀態，不讀上一輪的狀態 [arXiv:2004.06871][arXiv:2105.04222][arXiv:2109.04655][arXiv:2109.07506][arXiv:2201.08904]。
- 累積：IC-DST 把上一輪的預測狀態當成歷史摘要、只預測增量；FnCTOD 把先前的函式呼叫留在歷史裡，由程式合併 [arXiv:2203.08568][arXiv:2402.10466]。

兩派都沒量到自己的弱點：累積派沒量錯誤傳遞，重算派沒按對話長度分析 JGA [arXiv:2203.08568][arXiv:2201.08904][arXiv:2105.04222]。

### LLM agent 的多輪狀態維護、對話記憶與多輪退化（2023–2025）

到了這個子領域，狀態不再是預先定義的 slot-value，而是自然語言事實、摘要或圖；問題變成 LLM agent 怎麼把跨輪、跨 session 的資訊存下來、讀回來、隨時間更新 [arXiv:2304.03442][arXiv:2310.08560][arXiv:2504.19413][arXiv:2512.12818]。八篇（七篇計入、一篇 📖）分成兩條線：

- **外部記憶**：六篇各自提出一種放在模型之外的狀態結構與讀寫規則 [arXiv:2304.03442][arXiv:2305.10250][arXiv:2310.08560][arXiv:2503.08026][arXiv:2504.19413][arXiv:2512.12818]。其中 MemoryBank 與 RMM 本意是長期個人化記憶，本章只從「狀態怎麼更新」這個角度讀它們。
- **多輪退化的量測**：Lost in Conversation 量同一個 session 內資訊逐輪補齊時，模型本身掉多少 [arXiv:2505.06120]。Drift No More（📖）提出「漂移有界」的相反說法，只當反例 [arXiv:2510.07777]。

兩條線幾乎沒有交會：記憶系統量的是跨 session 的事實回想、文件問答或可信度，量多輪退化的論文則沒有測任何記憶系統 [arXiv:2304.03442][arXiv:2310.08560][arXiv:2504.19413][arXiv:2505.06120][arXiv:2512.12818]。沿時間往下讀，最清楚的一條軸仍是「狀態怎麼更新」。

**2023 年 4 月：記憶流，只增不刪（Generative Agents）。** 先前的 LLM 模擬只依當下情境生成行為，會出現同一個中午吃三次午餐、不記得昨天對話這類退化 [arXiv:2304.03442]。Generative Agents 把 agent 的全部狀態寫成自然語言，放進一條只增不刪的記憶流 [arXiv:2304.03442]。檢索時把 recency、LLM 打的重要度、embedding 相似度三項正規化後加總；近期記憶的重要度總和超過 150 時觸發反思，LLM 歸納出洞見，再寫回記憶流 [arXiv:2304.03442]。25 個 agent 在沙盒跑兩個遊戲日，完整架構的可信度 TrueSkill μ 是 29.89，不能讀記憶的條件是 21.21 [arXiv:2304.03442]。精讀時發現，除了環境樹的覆寫與計畫重生成，沒有任何機制讓過時或被推翻的事實失效；反思未經驗證就寫回，錯誤會沿反思樹放大 [arXiv:2304.03442]。

**2023 年 5 月：分層摘要加遺忘曲線（MemoryBank）。** 記憶分三層：帶時間戳記的逐輪原文、LLM 產生的每日與全域事件摘要、每日與全域使用者畫像 [arXiv:2305.10250]。記憶保留率借用艾賓浩斯遺忘曲線 R = e^(−t/S)，召回一次 S 加 1、t 歸零 [arXiv:2305.10250]。量化實驗只比三個掛了記憶的變體，沒有「不掛記憶」的對照組，也沒有消融 [arXiv:2305.10250]。精讀時發現，公開程式碼把遺忘公式寫成 exp(−t/5*S)，依運算順序等於召回越多次反而忘得越快，與論文宣稱的方向相反 [arXiv:2305.10250]。

**2023 年 10 月：把 context 當主記憶體，由 agent 自己搬（MemGPT）。** MemGPT 以每則約 50 token 估算，4k 的 context 只容得下約 60 則訊息 [arXiv:2310.08560]。它把 prompt 分成唯讀的 system instructions、可讀寫的 working context、滾動的 FIFO 訊息佇列；完整紀錄存在外部，要用函式搬回 prompt 才看得到 [arXiv:2310.08560]。寫入與搜尋由 LLM 以函式呼叫決定；佇列溢位時的清出由系統依 token 門檻觸發並做遞迴摘要，LLM 只在收到記憶壓力警告後自行把重要內容存起來 [arXiv:2310.08560]。三篇都把原始紀錄全部記下：Generative Agents 記下每則觀察，MemoryBank 記下每輪原文，MemGPT 也把每則輸入與輸出自動寫進 recall storage [arXiv:2304.03442][arXiv:2305.10250][arXiv:2310.08560]。差別在誰決定怎麼整理與讀回：前兩篇由固定計分決定讀取排序與反思時機（Generative Agents），或由摘要與遺忘規則決定壓縮與丟棄（MemoryBank）；MemGPT 則讓 agent 自己決定哪些內容寫進 working context 與 archival storage、哪些內容搬回 prompt [arXiv:2304.03442][arXiv:2305.10250][arXiv:2310.08560]。跨 session 事實回想（DMR）的 accuracy，GPT-4 從 32.1% 升到 92.5% [arXiv:2310.08560]。精讀時指出兩點 [arXiv:2310.08560]：

- baseline 只拿到有損摘要，而完整歷史估計只有數千 token、放得進 context，所以這張表比的不是分層記憶對長 context [arXiv:2310.08560]。
- 事實改變時覆寫 working context 的正確性沒有量，只有一則質性範例 [arXiv:2310.08560]。

**2025 年 3 月：寫入時就為檢索整理，讀取後用引用回饋（RMM）。** RMM 每個 session 結束時由 LLM 抽出「主題摘要＋對應原始 turn」，每條新記憶與最相近的舊記憶比對，只能選 Add 或 Merge [arXiv:2503.08026]。讀取端在凍結的 dense retriever 後面接一個 reranker，以生成器自己標的引用（有引用 +1、沒引用 −1）為獎勵做 REINFORCE [arXiv:2503.08026]。LongMemEval 準確率 RMM-GTE 70.4，同檢索器的 RAG-GTE 63.6，Long Context 57.4 [arXiv:2503.08026]。以 Contriever 消融時，兩種反思與兩者合用對 RAG 的增益只有 +0.8、+1.4、+2.4 點，而且沒有標準差 [arXiv:2503.08026]。

**2025 年 4 月：逐輪抽取加四種操作（Mem0）。** Mem0 每收到一組新訊息就觸發一次抽取；每個候選事實與最相似的前 10 筆舊記憶並列，由 LLM 以 function call 選 ADD、UPDATE、DELETE、NOOP [arXiv:2504.19413]。基本版的 DELETE 是實體刪除；圖版 Mem0g 衝突時把舊關係標為失效而不刪除 [arXiv:2504.19413]。和 RMM 相比，寫入時機從 session 結束改成逐組訊息，動作集合多了明確的刪除 [arXiv:2503.08026][arXiv:2504.19413]。這組動作和 IC-DST 狀態變化裡的「新增、刪除、改值」是同一種語法，只是作用對象從 slot 換成自然語言事實（撰寫本章時的對照）[arXiv:2203.08568][arXiv:2504.19413]。LOCOMO 上 Overall J 是 Mem0 66.88、Mem0g 68.44，全文脈絡 72.90 仍然最高；Mem0 的賣點在成本，p95 總延遲是 1.440 s 對 17.117 s [arXiv:2504.19413]。精讀時發現，抽取的精確率與召回率、UPDATE／DELETE 判斷的正確率都沒有量，也沒有任何消融 [arXiv:2504.19413]。

**2025 年 5 月：不看記憶系統，直接量同一個 session 內掉多少（Lost in Conversation）。** 它把六個單輪基準的完整指令切成 shard，由 GPT-4o-mini 扮演的使用者模擬器每輪至多揭露一片 [arXiv:2505.06120]。同一份內容同時跑三種設定，每個組合跑 10 次 [arXiv:2505.06120]：

- Full：完整指令一次給齊 [arXiv:2505.06120]。
- Concat：shard 條列成一則單輪指令 [arXiv:2505.06120]。
- Sharded：逐輪揭露 [arXiv:2505.06120]。

15 個模型在 Sharded 下平均掉 39%，Concat 平均是 Full 的 95.1%，所以退化不是切片改寫造成的 [arXiv:2505.06120]。日誌分析找到四種失敗模式：過早作答、答案越改越長而不撤回舊假設、中間輪次的資訊被忽略、回應冗長 [arXiv:2505.06120]。其中「不撤回舊假設」和前兩個子領域「只覆寫、不刪除」的規則是同一種病，只是這裡沒有顯式狀態可指認（撰寫本章時的對照）[arXiv:2505.06120][arXiv:2005.02877][arXiv:2402.10466]。精讀時發現，assistant 只拿到最小的系統訊息，沒有任何顯式狀態或記憶模組，結果是「原始對話歷史＋預設行為」的下界 [arXiv:2505.06120]。

**2025 年 10 月（📖，只當反例）：漂移有界？** Drift No More 以測試模型相對參考模型的逐輪 KL 散度定義漂移，宣稱 τ-bench 使用者模擬器的 KL 沒有隨輪次無界成長 [arXiv:2510.07777]。精讀判為低價值，理由是它用來證明「有恢復力」的迴歸診斷，在完全沒有動態的 i.i.d. 雜訊下也會得到同樣的結果（見〈爭議〉）[arXiv:2510.07777]。

**2025 年 12 月：帶時間區間的敘事事實，衝突多半留到讀取時裁決（Hindsight）。** Hindsight 指出既有記憶系統不區分觀察到的證據與 agent 推論出的信念 [arXiv:2512.12818]。它以 session 為單位，每段對話萃取 2–5 個帶發生區間與提及時間的敘事事實，分進四個網路，再以語意、BM25、圖擴散、時間四路檢索 [arXiv:2512.12818]。world／experience 事實在寫入時不作廢，衝突主要交給時間中繼資料與答題 LLM 在讀取時裁決；但 observation 重新產生時，提示詞規定衝突事實取最新或證據最多的那個，opinion 與 bank 背景也各有寫入時的更新規則 [arXiv:2512.12818]。在約 115k token 的 LongMemEval S 上，同一個 GPT-OSS-20B 從 full-context 的 39.0% 升到 83.6%，差 83.6 − 39.0 = 44.6 個百分點 [arXiv:2512.12818]。精讀時發現，它沒有消融，也沒有同 backbone、同評審的 top-k RAG 基線 [arXiv:2512.12818]。

**本子領域的更新語意（撰寫者歸納）。** 六篇記憶系統各用一種做法：

- 只增不刪（Generative Agents）[arXiv:2304.03442]。
- 追加加遺忘（MemoryBank）[arXiv:2305.10250]。
- agent 自己改寫（MemGPT）[arXiv:2310.08560]。
- Add／Merge（RMM）[arXiv:2503.08026]。
- ADD／UPDATE／DELETE／NOOP 加圖版的軟失效（Mem0）[arXiv:2504.19413]。
- 事實寫入時不作廢、衝突多半留到讀取時裁決，observation、opinion 與背景另有寫入時的更新規則（Hindsight）[arXiv:2512.12818]。

沒有一篇在同一個基準上比較過這些做法，也沒有一篇量過自己更新操作的正確率 [arXiv:2310.08560][arXiv:2503.08026][arXiv:2504.19413][arXiv:2512.12818]。這和前兩個子領域的處境一樣：〈方法比較〉一節的跨子領域表，三個子領域合計列了十三種維護方式（不含沒有顯式狀態的那一列），量的一直是下游結果（撰寫本章時的歸納）。

## 方法比較

### 跨子領域：狀態怎麼跨輪維護

這張表把三個子領域的維護方式放在同一條軸上。「已知的失敗型態」多半是精讀時依論文或公開程式碼推得的，不是論文自己量到的；最後一欄記錄有沒有實驗真的量到這個失敗（撰寫本章時彙整）。

| 維護方式 | 代表 | 已知的失敗型態 | 有沒有量到 | 出處 |
| --- | --- | --- | --- | --- |
| 固定係數插值 | NBT | 照字面實作時，沒被重提的目標會衰減到門檻以下（精讀時推算） | 沒有 | [arXiv:1606.03777] |
| 規則覆寫（非 none 即覆寫，none 沿用舊值） | GLAD、TripPy | 沒有刪除路徑，寫錯的值留到同一 slot 被再次指定 | 沒有；TripPy 沒量化錯誤傳播占 JGA 損失多少 | [arXiv:1805.09655][arXiv:2005.02877] |
| 隱式遞迴（RNN 隱藏狀態） | SUMBT | 狀態不能檢查，也不能從外部修正後再接下去 | 沒有；沒有按回合數分析錯誤 | [arXiv:1907.07421] |
| 歷史視窗內每輪重新生成 | TRADE | 視窗外提過的值只能靠當輪重新找到 | 沒有 | [arXiv:1905.08743] |
| 完整歷史每輪重算 | SimpleTOD、TOD-BERT、T5DST、TransferQA、DaP、D3ST | 歷史超過輸入上限時會被截斷；SimpleTOD 在 1,024 token 截斷，DaP 的公開程式碼右側截斷會截掉 slot 提示（精讀時依程式碼推得） | 沒有；沒有一篇按對話長度分析 JGA | [arXiv:2005.00796][arXiv:2004.06871][arXiv:2105.04222][arXiv:2109.04655][arXiv:2109.07506][arXiv:2201.08904] |
| 差分累加 | SGD 原型、IC-DST | 判錯的差分會沿累積狀態一路帶下去 | 沒有；IC-DST 沒做 gold 與預測上一輪狀態的對照 | [arXiv:1909.05855][arXiv:2203.08568] |
| 程式合併、只增不刪 | FnCTOD | 無法撤回先前的條件，每輪只更新一個領域（精讀時依公開程式碼） | 沒有 | [arXiv:2402.10466] |
| 只增不刪的記憶流＋反思寫回 | Generative Agents | 過時事實不會失效，未驗證的反思寫回後會被再引用 | 沒有 | [arXiv:2304.03442] |
| 追加＋遺忘衰減 | MemoryBank | 使用者改口時新舊事實同時被取回；程式碼的遺忘公式方向與論文相反 | 沒有；遺忘沒有任何量化結果 | [arXiv:2305.10250] |
| agent 以函式呼叫自己改寫 | MemGPT | 覆寫是否正確無從得知 | 只有一則質性範例 | [arXiv:2310.08560] |
| Add／Merge | RMM | 沒有刪除或覆寫，新舊矛盾只能靠合併句的改寫表達 | 沒有；LongMemEval 只報總準確率 | [arXiv:2503.08026] |
| ADD／UPDATE／DELETE／NOOP | Mem0（圖版 Mem0g 改為軟失效） | 硬刪讓「以前是什麼」答不了；錯刪的長期影響不明 | 沒有；四種操作都沒被單獨量過 | [arXiv:2504.19413] |
| 事實寫入時不作廢、多半讀取時裁決 | Hindsight | world／experience 事實沒有寫入時的作廢機制，衝突主要留給時間中繼資料與答題 LLM；observation 重新產生時取最新或證據最多，opinion 與背景另有寫入時的更新規則（精讀時推測 knowledge-update 的增益來自讀取端） | 有 knowledge-update 分項，但評審接受新舊資訊並列 | [arXiv:2512.12818] |
| 沒有顯式狀態（原始對話歷史） | Lost in Conversation 的被測 assistant | 過早作答、不撤回舊假設、中間輪次被忽略 | 有：Sharded 平均掉 39% | [arXiv:2505.06120] |

### 傳統任務型對話 DST 與資料集

| 方法 | 核心機制 | 需要的資料或監督 | 評估在哪 | 關鍵數字 | 出處 |
| --- | --- | --- | --- | --- | --- |
| NBT（NBT-DNN／NBT-CNN） | 固定的語意特化詞向量組出語句與候選 slot-value 表示，逐 slot-value 二元判斷；系統上一輪 request／confirm 以點積當閘門；跨輪以 λ=0.55 插值、門檻 0.5 的規則累積 | 封閉 ontology；逐句的回合層級語意標註；預訓練 Paragram-SL999；每個 slot 分開訓練 | DSTC2、WOZ 2.0（本文擴充為 1,200 通） | Goals：DSTC2 73.4（無字典基線 69.1、字典版 72.9）；WOZ 2.0 84.4（70.8、83.7）；DSTC2 改用測試轉錄時 0.96 | [arXiv:1606.03777] |
| GLAD | 全 slot 共用的 global biLSTM＋自注意力與每 slot 的 local 版本以 β_s 混合；語句評分加系統動作評分（含 sentinel）；joint goal 以同 slot 覆寫規則累加 | 固定本體；逐輪 turn goal／request 標註；結構化的前一輪系統動作 | WoZ 2.0、DSTC2 | WoZ joint 88.1±0.4、request 97.1±0.2；DSTC2 74.5±0.2（10 種子）；dev 消融拿掉 global 時 joint 88.8→73.4 | [arXiv:1805.09655] |
| MultiWOZ（2.0，資料集） | 群眾外包 Wizard-of-Oz；belief state＝wizard 查資料庫用的跨輪表單快照；system act 事後由群眾標註 | 群眾工作者 1,249 名；每輪狀態是 wizard 工作的副產品，未另做一致性量測 | 本文 DST 基準只做 restaurant 子集（沿用 MDBT） | 10,438 則對話、7 領域；MDBT Joint goals 80.9（WOZ 2.0 85.5）；act 標註 κ 0.704→0.884 | [arXiv:1810.00278] |
| TRADE | 每個 (domain, slot) 從最近 l 回合歷史生成值：共用 GRU 解碼器＋soft-gated 複製＋ptr／none／dontcare slot gate；每輪整份重新生成 | 逐輪完整狀態；預先定義的 (domain, slot) 清單，但不需值清單 | MultiWOZ 2.0 五領域、restaurant 單領域、留一領域零樣本、1% 少樣本擴充 | 五領域 joint 48.62（GCE 36.27、GLAD 35.57）；零樣本 taxi 60.58、其他 11.52–22.37 | [arXiv:1905.08743] |
| SUMBT | slot 名稱文字當 query 對當回合語句做 multi-head attention；每個 slot 一條共享參數的 RNN 沿回合累積；在凍結 BERT 空間以距離從本體候選值挑值 | 逐回合 informable slot 標註＋每個 slot 的完整候選值清單 | WOZ 2.0；MultiWOZ 2.0（7 領域 35 slot，作者自行拼字清理） | WOZ 2.0 JGA 0.910 ± 0.010（20 種子）；MultiWOZ 0.4240 ± 0.0187；官方 README 另報 0.48806／0.49064（精讀時查到） | [arXiv:1907.07421] |
| SGD（資料集＋schema-guided BERT 原型） | 每個服務在執行期提供 schema 的自然語言描述；BERT 編碼 schema 元素與「前一句系統＋當前使用者」語句；差分式 user goal 逐輪累加 | 每個服務的 schema 描述；模擬器自動產生的標註（改寫時強制逐字保留 slot 值） | SGD（SGD-S／SGD-All）、WOZ2.0、MultiWOZ 2.1 | train 16,142 段、26 服務；JGA：SGD-S 0.356、SGD-All 0.254；MultiWOZ 2.1 0.434（複製變體 0.489） | [arXiv:1909.05855] |
| TripPy | BERT 編碼本回合＋完整歷史；每個 slot 一個五類 gate，選 span／inform／refer 三種複製來源；none 即沿用舊值 | 逐回合狀態標註＋span 標籤（MultiWOZ 2.1 由作者用字串比對自產）；slot 集合預先定義，不需候選值清單 | MultiWOZ 2.1、WOZ 2.0、sim-M、sim-R、作者自建的 OOV 測試集 | MultiWOZ 2.1 JGA 55.29 ± 0.28（3 種子）；WOZ 2.0 92.7 ± 0.2；sim-M 83.5 ± 1.2；sim-R 90.0 ± 0.2 | [arXiv:2005.02877] |
| SimpleTOD | 單一因果 LM 把 context→belief→DB→action→去詞彙化回應當成一條序列生成；belief 是三元組文字；每回合從完整歷史重寫整份狀態 | MultiWOZ 全量逐回合的 belief、dialogue act 與去詞彙化回應；預訓練權重是前提（隨機初始化時 JGA 只有 16.45–20.17） | MultiWOZ 2.1（DST）；MultiWOZ 2.0（端對端主比較） | JGA：55.76（TRADE 清理腳本）、55.72（不清理）、57.47（自行額外清理）；2.0 端對端不用 DB：Inform 84.4、Success 70.1、Combined 92.26 | [arXiv:2005.00796] |
| MultiWOZ 2.2 | 事後套 SGD 式 schema：categorical 從候選清單挑，non-categorical 的值要出現在歷史並標 span；等價值清單；copy from 記錄沿用來源 | 在 2.1 上重做標註：客製字串比對＋人工標註；本身不訓練新模型 | TRADE、SGD-baseline、DS-DST 在 2.0／2.1／2.2 上的 JGA | 幻覺值出現在 948 段對話的 3128 輪；修改 17.3% user 輪、28.2% 對話；JGA 2.1→2.2：TRADE 0.460→0.454、SGD-baseline 0.434→0.420、DS-DST 0.512→0.517 | [arXiv:2007.12720] |

### LLM 時代的 zero/few-shot DST

| 方法 | 核心機制 | 需要的資料或監督 | 評估在哪 | 關鍵數字 | 出處 |
| --- | --- | --- | --- | --- | --- |
| TOD-BERT | 以九個任務型對話資料集繼續預訓練 BERT-base（[USR]／[SYS] 的 MLM＋response contrastive loss）；DST 為封閉 ontology 上逐 (domain, slot) 的 cosine＋softmax 分類，每回合重算 | 約 10 萬通未標註對話做預訓練；下游用 MultiWOZ 1%／5%／10%／25%／全量的狀態標註；作者重建的完整 ontology | MultiWOZ 2.1（DST），另有其他理解任務 | JGA 全量 48.0，BERT 45.6、GPT-2 46.2；5% 資料 28.6 對 BERT 19.6 | [arXiv:2004.06871] |
| T5DST | T5-small 逐 slot 生成值，輸入為完整歷史＋slot 名稱或描述；比較五種描述寫法 | 其他四個 MultiWOZ 領域的狀態標註；目標領域要人工指定每個 slot 的型別與模板 | MultiWOZ 2.0 留一領域 zero-shot、目標領域 1%／5%／10% few-shot；2.0／2.1 全量 | zero-shot 平均 JGA：Slot Type 35.20±0.59、slot name 33.56±0.54、Human 33.14、TRADE 25.76；全量描述增益只有 0.56（2.0）與 0.30（2.1） | [arXiv:2105.04222] |
| TransferQA | T5-large 在 6 個抽取式＋2 個多選 QA 資料集上學統一的生成式 QA；以人造無答案題學 none；逐 slot 先抽取、類別 slot 再做多選 | 約 65 萬筆 QA；零 DST 標註；每個 slot 人寫問句、類別 slot 的候選值、MultiWOZ 2.2 的類別切分 | MultiWOZ 2.1 zero-shot（逐領域）、MultiWOZ 2.0 few-shot、SGD | MultiWOZ 2.1 平均 JGA 35.77，SUMBT 28.18；拿掉兩種無答案題後 23.70；oracle gate 56.06；SGD All Domain 20.7，SGD-baseline 25.4 | [arXiv:2109.04655] |
| DaP（schema-driven prompting） | 對話歷史＋[domain]／[slot] 提示（名稱＋描述＋類別槽可能值）進 T5 encoder，每個 domain-slot 獨立解碼 | 100% 訓練資料全量微調；schema 的自然語言描述 | MultiWOZ 2.2、2.1、M2M | MultiWOZ 2.2：T5-base 56.7，加描述 57.6，一次生成 51.2；MultiWOZ 2.1：T5-base 56.39→56.66；Sim-M 加描述後 83.3→81.0 | [arXiv:2109.07506] |
| D3ST | 每個 slot／intent 一句描述，前面掛逐例重新洗牌的索引；一次解碼所有 active slot 的「索引:值」與 active intent | 在其他領域或服務上全量監督微調 T5 1.1（Base 到 XXL 11B） | MultiWOZ 2.1–2.4、SGD（seen／unseen）、SGD-X、MultiWOZ 2.1 留一領域、跨資料集互轉 | SGD XXL 86.4（unseen 83.3）；留一領域平均 46.7；SGD-X 的 XXL 平均 77.8、SS(JGA) 0.27；MultiWOZ→SGD 只有 23.1 | [arXiv:2201.08904] |
| IC-DST | 凍結的 Codex 做 ICL；狀態寫成 SQL；脈絡為前一輪狀態＋本輪；預測狀態變化再由程式套用；以狀態變化相似度微調 SBERT 檢索範例 | few-shot 需要 1%／5%／10% 的標註池；zero-shot 只用 schema＋一個手寫格式示範 | MultiWOZ 2.1、2.4 | MultiWOZ 2.1 的 1%／5%／10%：43.13／47.08／48.67（DS2-T5 為 33.76／44.20／45.38）；100% 時 50.65，低於 SGPDST（即 DaP）的 56.66；MultiWOZ 2.4 zero-shot 多領域 JGA 35.3 | [arXiv:2203.08568] |
| FnCTOD | 每個領域一個函式、slot 為參數；先選函式、再只帶其完整規格生成參數；歷史保留先前的函式呼叫；程式端只增不刪地合併 | GPT-3.5／4 不放示範；開源模型用 5 筆取自 MultiWOZ 訓練集的示範；微調版用 7,200 段非 MultiWOZ 對話做 LoRA | MultiWOZ 2.1（DST）、MultiWOZ 2.2（端到端） | Average JGA：GPT-4 62.59（Overall 38.71）、GPT-3.5 61.31、FnCTOD-LLaMA2-13B 59.54；表中 IC-DST 為 56.96 | [arXiv:2402.10466] |

### LLM agent 的多輪狀態維護、對話記憶與多輪退化

| 方法 | 核心機制 | 需要的資料或監督 | 評估在哪 | 關鍵數字 | 出處 |
| --- | --- | --- | --- | --- | --- |
| Generative Agents | 只增不刪的自然語言記憶流（observation／reflection／plan）；recency＋importance＋relevance 三項正規化加總檢索；重要度累計超過 150 觸發反思並寫回 | 不訓練；gpt-3.5-turbo 提示詞＋embedding；每個 agent 一段人工角色描述 | 自建沙盒，25 個 agent、兩個遊戲日；100 位人評排可信度 | TrueSkill μ：完整 29.89、無反思 26.88、無記憶 21.21；知道派對 1→13 人（4%→52%） | [arXiv:2304.03442] |
| MemoryBank／SiliconFriend | 逐輪原文＋每日／全域事件摘要＋使用者畫像；論文寫以目前對話脈絡做 dense 檢索（依公開程式碼，開源版的 query 只有使用者當句話，ChatGPT 版改用 LlamaIndex）；遺忘依 R = e^(−t/S) | 記憶本身不訓練；開源 backbone 另以 38k 則心理對話做 LoRA | ChatGPT 模擬 15 位使用者 × 10 天；論文稱 194 題探針；只比三個變體 | 英文 Retrieval Acc.／Correctness：ChatGPT 0.763／0.716、ChatGLM 0.809／0.438、BELLE 0.814／0.479 | [arXiv:2305.10250] |
| MemGPT | main context（system、working context、FIFO＋遞迴摘要）＋外部 recall／archival 儲存；寫入與搜尋由 LLM 以函式呼叫決定，佇列溢位時由系統依 token 門檻清出並遞迴摘要；清出前插入記憶壓力警告 | 不訓練；依賴底層模型的函式呼叫能力 | DMR（以 MSC 延伸出 session 6）；conversation opener；NQ-Open 抽 50 題；Nested KV | DMR accuracy：GPT-4 32.1%→92.5%、GPT-4 Turbo 35.3%→93.4%、GPT-3.5 Turbo 38.7%→66.9% | [arXiv:2310.08560] |
| RMM | session 結束時抽「主題摘要＋原始 turn」，與相近舊記憶以 Add／Merge 整併；凍結檢索器後接 reranker，以生成器引用為獎勵做 REINFORCE | 不需人工標註；Gemini-1.5-Flash 生成 | MSC；LongMemEval（Recall@5、Accuracy） | LongMemEval Acc：RMM-GTE 70.4、RAG-GTE 63.6、Long Context 57.4；Contriever 消融 +0.8／+1.4／+2.4 點 | [arXiv:2503.08026] |
| Mem0／Mem0g | 每組新訊息以「全域摘要＋最近 10 則」為背景抽候選事實；每個事實對前 10 筆相似舊記憶由 LLM 選 ADD／UPDATE／DELETE／NOOP；Mem0g 存實體關係圖、衝突時標失效 | 不訓練；所有 LLM 操作用 GPT-4o-mini；Mem0g 需要 Neo4j | LOCOMO 10 段對話（排除 adversarial）；F1、BLEU-1、LLM judge J；延遲與 token | Overall J：Mem0 66.88、Mem0g 68.44、全文脈絡 72.90、Zep 65.99；p95 總延遲 1.440 s 對 17.117 s | [arXiv:2504.19413] |
| Lost in Conversation（sharded 模擬） | 把單輪指令切成 shard，LLM 使用者模擬器每輪至多揭露一片；Full／Concat／Sharded 受控對照；每組合跑 10 次，拆成 P̄、A⁹⁰、U⁹⁰₁₀ | 半自動分片（GPT-4o 分段與改寫，作者人工檢視）；不訓練 | 6 任務 600 條指令；15 個模型 | Sharded 平均 −39%；Concat 為 Full 的 95.1%；A −16%、U +112% | [arXiv:2505.06120] |
| 📖 Context equilibria（Drift No More） | 逐輪 KL(測試模型 ‖ 參考模型) 當漂移；擬合 ΔD_t = a + b·D_t 取均衡；固定輪次插入目標提醒 | 需要參考模型的 token 分佈；不訓練 | 自建 8 輪受限改寫任務；τ-bench 的使用者模擬器 | 提醒後 KL −7.47%／−6.45%／−11.81%；Table 6 的 b 為 −0.957、−1.049、−1.007 | [arXiv:2510.07777] |
| Hindsight（TEMPR＋CARA） | 每段對話萃取 2–5 個帶時間區間的敘事事實，分四個網路並建四種邊；四路檢索、RRF 融合、cross-encoder 重排，依 token 預算打包 | 不訓練；GPT-OSS-20B／120B 做萃取與檢索 | LongMemEval S（500 題，約 115k token）；LoCoMo；GPT-OSS-120B 評審 | LongMemEval：full-context OSS-20B 39.0% → 83.6%；OSS-120B 89.0%、Gemini-3 91.4%；LoCoMo 83.18／85.67／89.61% | [arXiv:2512.12818] |

## 評估方式與關鍵數字

**用到的基準。** 三個子領域分成兩批考場：

- 兩個 DST 子領域用的是 DSTC2（口語，測試用 ASR 假設）、WOZ 2.0、MultiWOZ 的 2.0 到 2.4 各版、SGD 與它的改寫版 SGD-X，以及 M2M [arXiv:1606.03777][arXiv:1805.09655][arXiv:1905.08743][arXiv:1909.05855][arXiv:2201.08904][arXiv:2109.07506]。
- 第三個子領域換成 DMR、LongMemEval、LoCoMo 這類跨 session 問答，加上 Lost in Conversation 的 sharded 模擬與自建沙盒 [arXiv:2310.08560][arXiv:2503.08026][arXiv:2504.19413][arXiv:2505.06120][arXiv:2304.03442]。

**主指標。** 兩個 DST 子領域的主指標都是 joint goal accuracy（JGA）：某一輪的整份狀態全對才算對，沒有值的 slot 要預測 none [arXiv:1905.08743][arXiv:2005.02877][arXiv:2007.12720]。第三個子領域沒有任何直接量狀態的指標，改用下游問答的 accuracy、LLM judge 分數、可信度排名與任務分數 [arXiv:2304.03442][arXiv:2310.08560][arXiv:2504.19413][arXiv:2505.06120]。

### 同一個名字，不同的尺

下表把本章論文在「MultiWOZ 2.1 的 JGA」這個名字下報的數字排在一起 [arXiv:2005.02877][arXiv:2005.00796][arXiv:2203.08568]。它們不能直接比，最後一欄就是原因（依各篇筆記整理）。

| 系統 | 報的數字 | 這把尺的特殊之處 | 出處 |
| --- | --- | --- | --- |
| TRADE | 0.460（MultiWOZ 2.2 論文表中的 2.1） | 2.0、2.1 的數字是重跑還是引用，2.2 論文沒交代 | [arXiv:2007.12720] |
| SGD 原型 | 0.434 | 只看兩句語句；exact match | [arXiv:1909.05855] |
| TOD-BERT | 48.0 | 封閉 ontology 以所有標註過的值重建；精讀時指出預訓練語料含 MultiWOZ 對話 | [arXiv:2004.06871] |
| TripPy | 55.29 ± 0.28 | 預測符合任一標註變體就算對，變體表從訓練集半自動整理；3 個種子 | [arXiv:2005.02877] |
| SimpleTOD | 55.72／55.76／57.47 | 同一模型分別為不清理、套 TRADE 清理腳本、自行額外清理；精讀時判定只跑一次 | [arXiv:2005.00796] |
| DaP（T5-base） | 56.39，加描述 56.66 | 用 DSTC8 的 SGD 腳本、不做標籤正規化；全量微調 | [arXiv:2109.07506] |
| D3ST | Base 54.2、XXL 57.8 | 最大到 11B | [arXiv:2201.08904] |
| IC-DST | 100% 資料時 50.65（1% 時 43.13） | 凍結的 Codex 做 ICL，測試時用自己累積的預測狀態 | [arXiv:2203.08568] |
| FnCTOD（GPT-4） | Average JGA 62.59；Overall JGA 38.71 | 頭條數字是逐領域平均，多領域的 Overall 低 62.59 − 38.71 = 23.88 | [arXiv:2402.10466] |

**slot 集合與前處理：最極端的例子是同一個 MDBT。** MultiWOZ 在 restaurant 子集上報 MDBT 的 Joint goals 80.9；TRADE 改寫後重跑同一份公開程式碼，restaurant 單領域的 joint 只有 17.98，差 80.9 − 17.98 = 62.92 個百分點 [arXiv:1810.00278][arXiv:1905.08743]。TRADE 說明它對原實作做了三項改寫：補回被丟掉或以佔位符取代的 name、destination、departure，移除追蹤訂位 slot 的手寫規則，並自建完整本體 [arXiv:1905.08743]。兩篇都沒有交叉比對；撰寫本章時判斷，這個差距主要反映 slot 集合與前處理不同，而不是模型變了 [arXiv:1810.00278][arXiv:1905.08743]。slot 數在其他地方也一樣會混進比較：

- NBT 與 GLAD 的 joint goal 只在 3 個 informable slot 上計算，TRADE 用 30 個 pair，SUMBT 在 MultiWOZ 上追 35 個 slot [arXiv:1606.03777][arXiv:1805.09655][arXiv:1905.08743][arXiv:1907.07421]。
- MultiWOZ 2.2 拆出 cat／noncat 兩種 joint，TRADE 分別是 0.628 與 0.666 [arXiv:2007.12720]。依 Table 2 的 schema，categorical 有 20 個 slot，non-categorical 有 16 個（官方追蹤清單是 15 個）[arXiv:2007.12720]。精讀時指出，這個比較混雜了 slot 的數量與性質 [arXiv:2007.12720]。

**版本與標籤正規化。** 同一模型只換標註，分數就會移動：

- 精讀時依後續修正版查到，TRADE 在 2.0 的 test JGA 是 48.62%，換到只修正 dev 與 test 的 MultiWOZ 2.4 是 55.05%，差 55.05 − 48.62 = 6.43 個百分點 [arXiv:1810.00278]。
- 2.2 的規則比 2.1 寬（non-categorical 命中任一等價值就算對），三個模型卻只有 DS-DST 升，TRADE 與 SGD-baseline 都降，差距都在 1.4 點以內 [arXiv:2007.12720]。精讀時指出，標籤與評估規則同時改變、又沒有多次執行，讀不出修正對模型的因果影響 [arXiv:2007.12720]。
- 撰寫第 3 組草稿時比對全文發現版本混用：T5DST 標成 MultiWOZ 2.0 的那組 zero-shot 數字，被 IC-DST 原樣列在「MultiWOZ 2.1」底下 [arXiv:2105.04222][arXiv:2203.08568]。
- 更直接的矛盾是 SUMBT 的 zero-shot 平均 28.18，在 T5DST 被標成 2.0、在 TransferQA 被標成 2.1，兩篇出自同一作者群，都註明引自同一篇前作；至少有一篇標錯了 [arXiv:2105.04222][arXiv:2109.04655]。TRADE 在兩個版本上本來就會得到不同的數字（2.0 平均 25.76、2.1 平均 25.69），所以這不是無害的筆誤 [arXiv:2105.04222][arXiv:2109.04655]。

**「zero-shot」至少有五種意思。** 第二個子領域的 zero-shot 都帶著某種目標端曝光（下列多為精讀時發現）：

- T5DST 沿用 TRADE 的切分。依公開程式碼，含留出領域的多領域對話仍留在訓練集，只是不計該領域 slot 的損失 [arXiv:2105.04222]。
- D3ST 公開 repo 的 issue #9 指出，被留出領域的 slot 描述仍出現在訓練提示中；截至精讀查閱時未見維護者回覆 [arXiv:2201.08904]。
- TransferQA 不用 DST 標註，但每個 slot 的問句是人寫的，類別 slot 的候選值來自本體 [arXiv:2109.04655]。
- IC-DST 的 zero-shot 把部分欄位人工改名，還放了取自資料庫的範例列 [arXiv:2203.08568]。
- FnCTOD 在註腳說 IC-DST 要用 in-domain 資料訓練檢索器、不算嚴格零樣本；精讀時指出，同一把尺套到 FnCTOD 自己的開源模型也不成立，因為它們的 5 筆示範取自 MultiWOZ 訓練集 [arXiv:2402.10466]。

**逐領域平均與多領域 JGA 是兩把尺。** 沿用 TRADE 慣例的 zero-shot 評估，是逐領域只看目標領域的 slot，再對五個領域取平均；T5DST 與 TransferQA 都明說這個數字不能和多領域 JGA 相比 [arXiv:2105.04222][arXiv:2109.04655]。兩把尺的差距很大：IC-DST 在 MultiWOZ 2.4 的 zero-shot 逐領域 JGA 介於 51.42 到 71.87，多領域 JGA 只有 35.3 [arXiv:2203.08568]。

### JGA 量的到底是什麼

**它會放大逐輪錯誤。** GLAD 的 WoZ dev 消融把放大效果量了出來：拿掉 global 模組時，turn goal 掉 93.7 − 88.8 = 4.9 點，joint goal 掉 88.8 − 73.4 = 15.4 點，約 (88.8 − 73.4) / (93.7 − 88.8) ≈ 3.1 倍 [arXiv:1805.09655]。撰寫本章時據此判斷，joint goal 上幾個點的差距，可能只是逐輪層級較小的差距經過累積的結果 [arXiv:1805.09655]。

**none 判斷在 JGA 裡占很大比重。** MultiWOZ 中值為 none 的 slot 比例是 55.25% [arXiv:2109.04655]。TransferQA 的錯誤裡 79.79% 來自 slot gate，其中 false positive 37.54%、false negative 42.25%；這組 gate 錯誤比例只來自 TransferQA 一個模型 [arXiv:2109.04655]。但即使給了 oracle gate，JGA 也只到 56.06；精讀時指出，這代表仍有大量回合錯在值本身，而且論文沒說錯誤比例是以 slot 還是回合為單位 [arXiv:2109.04655]。FnCTOD 的領域選擇也是一種 gate：改用 oracle 領域後，GPT-4 的 Overall JGA 從 38.71 升到 44.44 [arXiv:2402.10466]。D3ST 只輸出 active 的元素，把 none 變成「不生成」，也就沒有指標單獨量 slot 是否 active [arXiv:2201.08904]。

**空狀態的輪次會灌高分數。** SGD 的 Average Goal Accuracy 只計真值中有非空指派的 slot，JGA 則以整輪計分 [arXiv:1909.05855]。Table 5 裡 Alarm 的 Joint GA 0.577 高於 Avg GA 0.018，是全表 18 個領域中唯一 Joint 高於 Avg 的一列，論文沒有解釋 [arXiv:1909.05855]。精讀時的推論是：狀態為空的輪次只要預測成空，就在 Joint GA 算全對 [arXiv:1909.05855]。撰寫第 1 組草稿時進一步推算（未經同儕審查，待驗證）：在每個服務最多 6 + 12 = 18 個 slot 的上限下，空狀態輪次至少要占 (0.577 − 0.018×18) / (1 − 0.018×18) ≈ 0.374 [arXiv:1909.05855]。這個推算另外假設 fuzzy matching 下整輪分數不超過任一 active slot 的分數，論文沒寫部分分數怎麼合併 [arXiv:1909.05855]。同一個機制也可能出現在 TRADE 的零樣本表：精讀時發現，論文沒說明評估是否排除目標領域還沒出現的輪次，而 taxi 在多領域對話中常在後段才出現 [arXiv:1905.08743]。

**slot accuracy 幾乎沒有鑑別力，而且 TRADE Table 2 的數字和「每輪比全部 pair」的讀法矛盾：一格無條件矛盾，兩格在假設下矛盾（撰寫時推算，程式驗證證實）。** 精讀時把 GCE 五領域的 slot accuracy 98.42 配 joint 36.27，解讀為大量 none 把 slot accuracy 墊高 [arXiv:1905.08743]。撰寫第 1 組草稿時依 Table 2 推算，結果和這個解讀矛盾；推算未經同儕審查，但已由程式驗證證實（見〈程式驗證〉）[arXiv:1905.08743]。推算的步驟如下：

1. 論文把 slot accuracy 定義為逐個 (domain, slot, value) 三元組和真值比對 [arXiv:1905.08743]。
2. 若照「墊高」的前提，每一輪都比全部 J 個 pair（含 none），每輪平均錯的 pair 數是 J×(1−SA)；錯至少一個 pair 的輪次比例不會超過這個平均，所以 JGA ≥ 1 − J×(1−SA) [arXiv:1905.08743]。
3. 代入 GCE 五領域：1 − 30×(1 − 0.9842) = 52.6%，高於它報的 joint 36.27% [arXiv:1905.08743]。要讓這一格不違反，每輪比對的 pair 數得超過 (1 − 0.3627) ÷ (1 − 0.9842) ≈ 40.34，而 Table 1 的 pair 總數只有 30，所以這一格不論每輪比幾個 pair 都違反 [arXiv:1905.08743]。
4. restaurant 單領域：論文沒寫 restaurant-only 評估比幾個 slot，這裡假設是 Table 1 列出的 7 個（food、price、area、name、time、day、people）。在這個假設下，GLAD 的下界是 1 − 7×(1 − 0.9654) = 75.8%（報 53.23），GCE 是 1 − 7×(1 − 0.9585) = 71.0%（報 60.93）[arXiv:1905.08743]。這兩格對 slot 數很敏感：臨界值分別是 (1 − 0.5323) ÷ (1 − 0.9654) ≈ 13.52 與 (1 − 0.6093) ÷ (1 − 0.9585) ≈ 9.41，實際比的 slot 數若大於臨界值（例如仍比 30 個 pair），這兩格就不違反 [arXiv:1905.08743]。
5. Table 2 其餘七格（含 TRADE 自己的 48.62／96.92 與 65.35／93.28）都沒有違反 [arXiv:1905.08743]。

所以至少有兩種可能，論文沒有說明是哪一種，程式驗證也分不出來 [arXiv:1905.08743]：

- slot accuracy 的比對集合比 JGA 要求全對的集合小，只比非 none 的三元組是其中一例。
- 兩欄不是在同一組輪次上、用同一套程式算的，或 Table 2 各列不是用同一套程式算的。

不論哪一種，精讀筆記拿 GCE「98.42 配 36.27」當「被 none 墊高」的例證都站不住：若兩欄真的在同一組輪次上比全部 30 個 pair，JGA 至少會是步驟 3 算出的下界；否則這兩欄根本不能拿來互相解讀 [arXiv:1905.08743]。也都不該拿這一欄比較模型 [arXiv:1905.08743]。TRADE 正文說自己的 slot accuracy 也最高，這在 Table 2 上同樣站不住：GCE 98.42 高於 TRADE 96.92（精讀時發現）[arXiv:1905.08743]。

**評估程式本身會改變指標（SUMBT，精讀時發現）。** 精讀時讀官方程式碼發現，joint accuracy 那一行依賴舊版 PyTorch 對整數張量做地板除法 [arXiv:1907.07421]：

- 地板除法下，一回合只有 S 個 slot 全對時 ⌊k/S⌋ 才等於 1，所以算出來是 JGA [arXiv:1907.07421]。
- PyTorch 1.7 起改成真除法，同一行就變成每回合 slot 準確率 k/S 的平均。後者恆大於等於 JGA，換了 torch 版本分數會靜默虛高 [arXiv:1907.07421]。

精讀筆記特別說明，這不代表論文當時的數字有誤 [arXiv:1907.07421]。程式驗證只證實了算術那一半：真除法的結果恆大於等於 JGA，只有每回合都全對或全錯時兩者才相等 [arXiv:1907.07421]。另一半無法驗證：程式碼那一行、張量是整數型別、PyTorch 1.7 起改成真除法，這三件事都只來自精讀筆記的轉述，快取裡沒有程式碼，本機也沒有 torch（見〈程式驗證〉）[arXiv:1907.07421]。

### 模型有沒有在自己的錯誤之上繼續走

JGA 是逐回合對標籤計分的指標；要量錯誤累積，歷史必須由模型自己產生（撰寫本章時的判斷）。本章在這一點上分成三種情況：

- **歷史用參考答案。** SimpleTOD 的端對端評估從第 2 回合起用資料集的參考回覆當 context，所以錯誤累積與狀態漂移都沒被量到（精讀時發現）[arXiv:2005.00796]。
- **狀態用自己的預測，但沒量傳遞效應。** TripPy、SGD 原型、IC-DST 測試時都在自己的預測上累積，但沒有一篇做「餵 gold 的上一輪狀態」與「餵預測的上一輪狀態」的對照 [arXiv:2005.02877][arXiv:1909.05855][arXiv:2203.08568]。
- **整段對話都由被測模型自己接下去。** 只有 Lost in Conversation 這樣量，而它量到的是沒有顯式狀態時的退化：Sharded 平均掉 39% [arXiv:2505.06120]。

**它的 A／U 拆解在二元任務上有機械性（精讀時發現，程式驗證證實）。** Lost in Conversation 把平均分數的下降拆成 aptitude（A⁹⁰，N 次分數的第 90 百分位）與 unreliability（U⁹⁰₁₀，第 90 減第 10 百分位），報告 A 平均 −16%、U 平均 +112% [arXiv:2505.06120]。repo 沒有附 A／U 的計算程式；精讀 agent 假設用 numpy 預設的線性內插百分位，推得在 0／100 的二元任務、N=10 下，有這些後果 [arXiv:2505.06120]：

- 10 次中答對 2 次以上，A⁹⁰ 就是 100 [arXiv:2505.06120]。
- 答對 2–8 次，U 一律是 100 [arXiv:2505.06120]。
- 所以觀察到的答對比例 k/10 從 1.0 掉到 0.2–0.8 之間的任何程度，都只算進 U [arXiv:2505.06120]。

程式驗證證實了這三點。答對 2–8 次時的結果，在六種百分位插值法下都一樣，只有答對 1 次與 9 次兩端隨插值法改變，所以「假設線性內插」這個但書影響不大（見〈程式驗證〉）[arXiv:2505.06120]。範圍要收窄兩處：

- 上面說的是觀察到的答對比例。換成真實成功率 p，p 在 0.4 以上時 A⁹⁰ 的期望值才幾乎不動；p 降到 0.3、0.2 時，A⁹⁰ 的期望值已明顯下降，A 會反映能力下降（程式驗證以二項分布精確計算）[arXiv:2505.06120]。
- 這個機制只作用在 Code、Database、Actions、Math 四個二元任務；Data-to-text 與 Summary 是 0–100 的連續分數 [arXiv:2505.06120]。論文報 A −16%、U +112% 時沒寫明平均涵蓋哪些任務；若含這兩個連續分數的任務，這個機制只解釋其中一部分（程式驗證的判斷）[arXiv:2505.06120]。

所以「退化主要是 unreliability」有一部分是指標定義推出來的；而且精讀時發現，U 還混進了使用者模擬器的變異：在 assistant 溫度 1.0 下，把使用者溫度從 1.0 降到 0.0，GPT-4o-mini 的 U 從 49.8 降到 38.5 [arXiv:2505.06120]。

### 端對端分數與 JGA 走勢不一致

- **SimpleTOD：頭條增益大半來自設定差異（精讀時發現）。** combined = BLEU + 0.5 ×（Inform + Success）[arXiv:2005.00796]。摘要的 Combined +7.2，比的是 SimpleTOD 不用 DB、DAMD 用 oracle DB；兩邊都用 oracle DB 時只領先 +2.66 [arXiv:2005.00796]。依 Table 2 重算，不用 DB 時 15.01 + 0.5 ×（84.4 + 70.1）= 92.26，而 2.0 上 combined 的順序是 oracle DB 87.66 < dynamic 91.66 < 不用 DB 92.26 [arXiv:2005.00796]。精讀時的推論是，Inform 與 Success 看的是去詞彙化回應裡的佔位符，模型不看 DB 也能拿分 [arXiv:2005.00796]。
- **ConvLab-2 上 JGA 與任務成功率名次相反（精讀時查到）。** SUMBT 的 JGA 是 0.30、TRADE 是 0.40，但接上規則式政策與使用者模擬器後，SUMBT 的 success rate 29.4 反而高於 TRADE 的 20.1 [arXiv:1907.07421]。
- **FnCTOD：Success 可以用不自然的回覆刷分，作者自己承認。** 它的 Table 3 裡，Zephyr 的 JGA 是 32.3、Success 是 57.5；Vicuna-13B 的 JGA 是 33.8、Success 只有 23.1 [arXiv:2402.10466]。

### 記憶系統的評估

**沒有一篇量「狀態更新對不對」。** 第三個子領域的外部記憶論文，都只從下游表現間接看狀態 [arXiv:2304.03442][arXiv:2310.08560][arXiv:2503.08026][arXiv:2504.19413][arXiv:2512.12818]：

- MemGPT 的 DMR 只測單一舊事實找不找得回來（精讀時指出）[arXiv:2310.08560]。
- Mem0 沒量抽取的精確率與召回率，也沒量 UPDATE／DELETE 判斷的正確率（精讀時發現）[arXiv:2504.19413]。
- RMM 在 LongMemEval 只報總準確率，不報知識更新等分題型結果（精讀時發現）[arXiv:2503.08026]。
- Hindsight 有報 knowledge-update 分項，同一個 OSS-20B 從 full-context 的 60.3 升到 84.6 [arXiv:2512.12818]。但這一題型的評審提示詞規定，最後給出更新後的答案、同時提到舊資訊也算對；精讀時發現，這個分數因此不能證明狀態層真的做了更新 [arXiv:2512.12818]。

**LLM 評審的寬鬆程度各篇不同。** 跨篇的數字因此不在同一把尺上：

- MemGPT 的 DMR 評審被要求從寬判定 [arXiv:2310.08560]。
- Mem0 的 judge 提示詞要求只要涉及同一主題就算對 [arXiv:2504.19413]。精讀時讀公開評估程式發現，judge 是與作答模型相同的 gpt-4o-mini，而且只跑一次，和論文的說法不符 [arXiv:2504.19413]。
- Hindsight 自己的列用 GPT-OSS-120B 評審，LongMemEval 的外部基線取自另一份技術報告、用 GPT-4o 評審 [arXiv:2512.12818]。
- RMM 的 Gemini-1.5-Pro 同時是評審與被評的生成器之一 [arXiv:2503.08026]。

**全文脈絡基線常在「放得下」的規模上比。** LOCOMO 每段平均約 26K token，放得進 gpt-4o-mini 的視窗；精讀時指出，「歷史超出脈絡」這個前提因此從未出現 [arXiv:2504.19413]。MemGPT 的 DMR 沒有全文基線 [arXiv:2310.08560]。精讀時用公開資料實測，MemoryBank 每位使用者 10 天只有 17–52 輪 [arXiv:2305.10250]。Hindsight 只測約 115k token 的 LongMemEval S，沒測更長的 M 版（精讀時發現）[arXiv:2512.12818]。

**LoCoMo 的總分有一半以上的權重落在標為 Open Domain 的那一欄。** 精讀時反推出 Single-Hop／Multi-Hop／Open Domain／Temporal 各 282／96／841／321 題，以此加權重現了 Hindsight Table 4 除了 Zep 以外所有列的總分（誤差 ≤ 0.01）[arXiv:2512.12818]。Open Domain 的權重是 841 ÷ (282 + 96 + 841 + 321) ≈ 54.6% [arXiv:2512.12818]。撰寫第 4 組草稿時，把同一組權重套在 Mem0 論文 Table 1 的 J 分項上：(67.13×282 + 51.15×96 + 72.93×841 + 55.51×321) ÷ 1,540 ≈ 66.88，與它 Table 2 的總分相同 [arXiv:2504.19413][arXiv:2512.12818]。程式驗證證實了這組權重，而且有兩個獨立的旁證 [arXiv:2504.19413][arXiv:2512.12818]：

- 不給權重、直接用最小平方擬合兩表各列，得到的比例與 282／96／841／321 幾乎一致 [arXiv:2504.19413][arXiv:2512.12818]。
- Hindsight 表有幾列的四個分項都能還原成整數題數；四個題數沒有公因數，加倍後的 1,540 × 2 = 3,080 題又超過 Mem0 論文寫的 10 段對話、平均每段約 200 題，所以這組權重很可能就是實際題數 [arXiv:2504.19413][arXiv:2512.12818]。

兩份全文都沒寫明這組題數，它是反推出來的 [arXiv:2504.19413][arXiv:2512.12818]。所以兩篇的 LoCoMo 總分都有一半以上的權重落在標為 Open Domain 的那一欄 [arXiv:2504.19413][arXiv:2512.12818]。但這一欄是否真是 LoCoMo 原始的 open-domain 類別，兩份全文都無法確立：Hindsight 的欄名沿用 Backboard 與 Mem0，Mem0 論文也沒列題數；要拿 LoCoMo 資料集的 category 欄位逐一對照各論文的欄名才能判定（見〈程式驗證〉）[arXiv:2504.19413][arXiv:2512.12818]。

**成本只算讀取端，變異量常缺。** Mem0 的 token 只計作答時檢索進 context 的量，1,764 ÷ 26,031 ≈ 6.8%；精讀時指出，寫入端每組訊息的抽取呼叫與每個候選事實的更新呼叫都沒有計入 [arXiv:2504.19413]。精讀時發現，MemGPT 每張表都是單一數字、沒有重複執行 [arXiv:2310.08560]；RMM 宣稱三次平均卻沒給標準差 [arXiv:2503.08026]。

**可信度排名不代表絕對品質（Generative Agents，精讀時發現）。** 受試者看得到記憶流，卻只被要求排可信度，沒有被要求核對事實 [arXiv:2304.03442]。作者自報完整架構對無記憶的 Cohen's d = 8.16，但用論文自己的數字算不出來：μ 差 29.89 − 21.21 = 8.68，用合併標準差得 8.68 / 0.71 ≈ 12.2，用 √(σ₁²+σ₂²) 則約 8.6 [arXiv:2304.03442]。每位受試者都排了五個條件，精讀時指出應該用 Friedman 而不是獨立樣本的 Kruskal-Wallis [arXiv:2304.03442]。

### 種子與變異：一到兩個點的差距多半沒有根據可判

| 論文 | 報了什麼 | 出處 |
| --- | --- | --- |
| GLAD | 10 個種子的平均與標準差；但基線數字是抄各論文的單一數值 | [arXiv:1805.09655] |
| SUMBT | 20 個種子；說自己 significantly outperformed，卻沒有做任何檢定（精讀時發現） | [arXiv:1907.07421] |
| TripPy | 3 個種子，±0.28；消融中遮罩的 +0.21 小於這個標準差 | [arXiv:2005.02877] |
| SimpleTOD | 精讀時判定只跑一次，沒有種子或顯著性檢定 | [arXiv:2005.00796] |
| T5DST | zero-shot 每設定 3 個種子；表中七列的平均 JGA 標準差介於 0.17（Human）到 1.36（Naive），作者主推的 Slot Type 是 ±0.59；單一領域更不穩，Naive 在 Train 領域達 4.31 | [arXiv:2105.04222] |
| DaP | 全量微調的描述增益 +1.1、+0.9 都是單次實驗（精讀時指出） | [arXiv:2109.07506] |
| IC-DST | 主表 1% 設定的跨 run 標準差 1.13–2.66；消融全在 100 段 dev 對話上單次執行 | [arXiv:2203.08568] |
| FnCTOD | temperature 0.3 下每筆只推論一次（精讀時發現找不到 seed 設定） | [arXiv:2402.10466] |
| Lost in Conversation | 每個組合跑 10 次；溫度實驗每格只有 20 次取樣 | [arXiv:2505.06120] |

## 程式驗證

本章有四條主張送程式驗證，拆成十條子主張。每條主張一支程式，只用 Python 標準函式庫，輸入數字只取自精讀筆記與快取全文。完整輸出、輸入出處與逐條判讀見 [../verify/02-results.md](../verify/02-results.md)。「來源」一欄標的是主張最初從哪裡來：精讀時發現的是筆記 limitations_observed 裡精讀 agent 的分析，撰寫時推算或核對的是撰寫本章時自己的推算與比對。

| 子主張 | 來源 | 結論 | 正文位置 | 程式 | 出處 |
| --- | --- | --- | --- | --- | --- |
| Lost in Conversation 的 A⁹⁰／U⁹⁰₁₀ 在 0／100 的二元任務、每題跑 N=10 次時有機械性：答對 2 次以上 A 就是 100，答對 2–8 次 U 一律是 100 | 精讀時發現 | **證實**。答對 2–8 次的結果在六種百分位插值法下都一樣。範圍收窄兩處：只對觀察到的答對比例成立，真實成功率降到 0.3、0.2 時 A 的期望值已明顯下降；只作用在 Code、Database、Actions、Math 四個二元任務 | 〈模型有沒有在自己的錯誤之上繼續走〉 | [02-lic-au-percentile.py](../verify/02-lic-au-percentile.py) | [arXiv:2505.06120] |
| TRADE Table 2 五領域 GCE（joint 36.27、slot accuracy 98.42）違反「每輪比全部 pair」時的下界 JGA ≥ 1 − J×(1−SA) | 撰寫時推算 | **證實**，與每輪比幾個 pair 無關：臨界的 pair 數大於 Table 1 的 pair 總數 30 | 〈JGA 量的到底是什麼〉 | [02-trade-slot-acc-bound.py](../verify/02-trade-slot-acc-bound.py) | [arXiv:1905.08743] |
| restaurant 單領域的 GLAD 與 GCE 也違反下界，Table 2 其餘七格不違反 | 撰寫時推算 | **條件式證實**：只在「restaurant-only 評估每輪比 7 個 slot」的假設下成立，論文沒寫比幾個；slot 數超過各自的臨界值就不違反，所以這個前提本身無法判定。旁證是 MDBT 的 slot accuracy 若按 30 個 pair 算，等於每輪平均錯十幾個 pair，較不自然，傾向較小的 slot 數，但這只是推論。其餘七格在各自的假設下都不違反 | 同上 | [02-trade-slot-acc-bound.py](../verify/02-trade-slot-acc-bound.py) | [arXiv:1905.08743] |
| 違反的原因二選一：slot accuracy 只比非 none，或 Table 2 各列不是同一套程式算的 | 撰寫時推算 | **無法判定**：程式分不出是哪一種。改寫成較一般的說法：slot accuracy 的比對集合比 JGA 要求全對的集合小，或兩欄不是在同一組輪次上、用同一套程式算的 | 同上 | [02-trade-slot-acc-bound.py](../verify/02-trade-slot-acc-bound.py) | [arXiv:1905.08743] |
| SUMBT 的 joint accuracy 算式在地板除法下等於 JGA，改成真除法就變成平均 slot 準確率，後者恆大於等於 JGA | 精讀時發現 | **證實**，幾乎是恆等式：兩者相等若且唯若每回合都全對或全錯 | 〈JGA 量的到底是什麼〉 | [02-sumbt-floor-div.py](../verify/02-sumbt-floor-div.py) | [arXiv:1907.07421] |
| 官方程式碼確實是那一行、張量是整數型別、PyTorch 1.7 起改成真除法，所以換 torch 版本分數會靜默虛高 | 精讀時發現 | **無法判定**：快取只有論文全文、沒有評估程式碼，本機沒有 torch，規則也不允許下載。程式只證明了三個前提都成立時，後果如主張所述 | 同上 | [02-sumbt-floor-div.py](../verify/02-sumbt-floor-div.py) | [arXiv:1907.07421] |
| 以 282／96／841／321 題加權，可以重現 Hindsight Table 4 除 Zep 外各列的總分，以及 Mem0 論文的 Overall J | 精讀時發現；套到 Mem0 論文是撰寫時推算 | **證實**：兩表各列誤差都在 0.01 以內。最小平方擬合與整數題數是兩個獨立的旁證，都與這組權重相容；題數的倍數被 Mem0 論文寫的總題數排除。這組題數兩份全文都沒寫明，是反推的 | 〈記憶系統的評估〉 | [02-locomo-weights.py](../verify/02-locomo-weights.py) | [arXiv:2512.12818][arXiv:2504.19413] |
| Hindsight 表中 Zep 的總分 75.14 與它的分項加權對不起來 | 精讀時發現 | **照原表欄位證實**。但後三欄輪換後加權就對上，而且是 24 種欄位排列中唯一的一種，所以說法改成「Zep 列的類別對應與其他列不一致」；是抄錯還是來源的類別排序不同，快取分不出 | 〈記憶子領域內的爭議〉 | [02-locomo-weights.py](../verify/02-locomo-weights.py) | [arXiv:2512.12818] |
| Hindsight 表中 Mem0、Mem0-Graph、LangMem、OpenAI 四列與 Mem0 論文逐格相同 | 撰寫時核對 | **證實**，四列逐格全同。後半句「因此帶著 Mem0 的 gpt-4o-mini judge」仍是由前半句推出的；Hindsight 原文說照 Backboard 公布的數字列出，中間可能還隔了一手 | 〈記憶子領域內的爭議〉 | [02-locomo-weights.py](../verify/02-locomo-weights.py) | [arXiv:2512.12818][arXiv:2504.19413] |
| LoCoMo 的總分由 Open Domain 主導 | 精讀時發現 | **無法判定**：權重已證實，但標為 Open Domain 的那一欄是否就是 LoCoMo 原始的 open-domain 類別，兩份全文都無法確立。要拿 LoCoMo 資料集的 category 欄位逐一對照各論文的欄名，這個檢查也同時能解 Zep 那一條。正文已改成「標為 Open Domain 的那一欄」 | 〈記憶系統的評估〉 | [02-locomo-weights.py](../verify/02-locomo-weights.py) | [arXiv:2512.12818][arXiv:2504.19413] |

**沒有送驗的推算。** 本章另有幾處精讀時或撰寫時的推算，不在本輪送驗的四條候選裡：SGD Alarm 領域空狀態輪次比例的下界 [arXiv:1909.05855]、Generative Agents 的 Cohen's d 重算 [arXiv:2304.03442]、D3ST SS(JGA) 隨正確率機械下降的推論 [arXiv:2201.08904]、Drift No More 在 i.i.d. 雜訊下的迴歸模擬 [arXiv:2510.07777]、Lost in Conversation 中 Snowball 與 Recap 補回比例的重算 [arXiv:2505.06120]，以及 MultiWOZ 回合數的重算 [arXiv:1810.00278]。其中寫成四則算式的部分，數字比對工具已驗算過算術；但推算所依賴的前提沒有經過程式驗證，例如 SGD 每個服務的 slot 上限與部分分數的合併方式、SS(JGA) 的確切定義、Drift No More 的虛無模型。所以正文維持原來「推算、未經程式驗證」的標註。

## 爭議、矛盾與反證

### 跨子領域的爭議

**系統提議、使用者接受的值算不算狀態：五篇、三種立場、兩個方向的錯誤。** 這條爭議橫跨兩個 DST 子領域：

- **MultiWOZ 2.2：沒接受就不算，接受之後怎麼算沒定。** 系統提了、使用者還沒接受就先標進狀態的值叫 early markup，被列為幻覺值 [arXiv:2007.12720]。它也指出標註者對這類值看法不一：有人追蹤使用者同意的所有值，有人只追蹤使用者自己說出的值 [arXiv:2007.12720]。撰寫第 2 組草稿時核對全文，沒看到對「使用者同意的值要不要追蹤」的統一規則 [arXiv:2007.12720]。
- **TripPy：這是一條正規的來源。** inform gate 讓使用者以確認或接受的方式指涉系統本回合說出的值，並直接複製進狀態 [arXiv:2005.02877]。
- **SimpleTOD：沒標就是雜訊。** 它把「context 足以判斷卻沒標」列為 Type 2 雜訊，57.47 的額外清理補的主要是這類標籤（另含部分 Type 4）[arXiv:2005.00796]。精讀時發現，它舉的例子有些正落在這條邊界上：MUL0088 那一回合的旅館是系統推薦的，使用者只追問設施與地址 [arXiv:2005.00796]。
- **DaP 與 TransferQA：錯誤落在相反兩側。** DaP 的錯誤分析說，20% 的錯誤是模型沒把「系統提供、使用者接受」的資訊寫進狀態 [arXiv:2109.07506]。TransferQA 的典型錯誤則相反，把系統提議、使用者尚未確認的值填進了狀態 [arXiv:2109.04655]。
- **FnCTOD：寫在提示詞裡，但沒量。** 精讀時從公開程式碼讀到，它的系統提示固定附上「只用使用者明確提供或確認的值」這類注意事項；論文附錄沒寫，也沒有量它的效果 [arXiv:2402.10466]。

撰寫本章時的判斷：這類回合的「正解」取決於標註政策，而 MultiWOZ 2.2 說兩種政策在同一份資料裡並存 [arXiv:2007.12720]。所以在這些回合上的 JGA 差距，有一部分量到的是模型學到了哪一種標註政策，而不是追蹤能力 [arXiv:2007.12720][arXiv:2109.07506][arXiv:2109.04655]。

**完整歷史、上一輪狀態，還是外部記憶：三個子領域各有一組相反的證據。**

- **DST：上一輪狀態勝過完整歷史，但證據有三個缺口。** IC-DST 的 Table 3（MultiWOZ 2.4 dev 100 段、5%、Codex）裡，以狀態變化為標籤時，「前一輪狀態＋本輪」58.7，「只有本輪」55.8，「完整歷史」52.0 [arXiv:2203.08568]。缺口如下：
  - 論文自己說明，完整歷史要截斷才塞得進 context；撰寫第 3 組草稿時認為，輸掉的可能是截斷而不是歷史本身 [arXiv:2203.08568]。
  - 改用完整狀態當標籤時，同樣的輸入只有 47.9。精讀時指出，每種設定都重訓了一個檢索器，所以 58.7 − 47.9 = 10.8 的增益，分不出來自標籤較簡單，還是檢索器比較好找範例 [arXiv:2203.08568]。
  - 沒有「餵 gold 的上一輪狀態」與「餵預測的上一輪狀態」的對照（精讀時指出）[arXiv:2203.08568]。
- **同一個 session 內：一次給齊遠勝逐輪補齊。** Lost in Conversation 的 Concat 平均是 Full 的 95.1%，Sharded 卻平均掉 39% [arXiv:2505.06120]。資訊一樣多，差在是不是模型自己在多輪中累積起來的 [arXiv:2505.06120]。
- **跨 session：全文脈絡勝負在兩種規模下相反。**
  - Mem0 在 LOCOMO 上，全文脈絡 J 72.90 高於 Mem0g 68.44 與 Mem0 66.88；作者也承認記憶系統是以些微準確率換取延遲與 token [arXiv:2504.19413]。
  - Hindsight 在 LongMemEval S 上，full-context OSS-20B 只有 39.0%，Hindsight OSS-20B 是 83.6% [arXiv:2512.12818]。
  - RMM 在 LongMemEval 上，Long Context 57.4，RMM-GTE 70.4 [arXiv:2503.08026]。

撰寫本章時的判斷：三組跨 session 的條件，在歷史長度（約 26K 對約 115K token）、backbone 與評審上都不同，沒有一篇做對話長度的掃描 [arXiv:2504.19413][arXiv:2512.12818][arXiv:2503.08026]。精讀時發現，Mem0 說全文脈絡的成本會急遽成長，全文卻沒有任何長度掃描實驗 [arXiv:2504.19413]。把三個子領域合起來看，「壓成狀態」與「保留原文」誰好，至今沒有一個在同一模型、同一評審下掃過長度的實驗可以回答 [arXiv:2203.08568][arXiv:2505.06120][arXiv:2504.19413][arXiv:2512.12818]。

**自然語言描述到底有沒有用：只在 schema 沒見過時明顯。**

- SGD 以描述為條件，但沒有「描述對名稱」的消融，描述也全由同一團隊撰寫（精讀時發現）[arXiv:1909.05855]。
- T5DST：人寫描述沒有帶來 zero-shot 增益（33.14 對 slot name 的 33.56）；全量訓練下 Slot Type 描述只加 0.56（2.0）與 0.30（2.1）[arXiv:2105.04222]。
- DaP：M2M 上借來的描述讓 Sim-M 從 83.3 降到 81.0 [arXiv:2109.07506]。
- D3ST：在 SGD 上，Language 描述明顯勝過元素名（Large 80.0 對 73.7，XXL 86.4 對 79.7）[arXiv:2201.08904]。但精讀時從 Table 2 看出，MultiWOZ 上 Large 在 2.1、2.3、2.4 都是 Name 較好（55.1 對 54.5、59.6 對 58.6、72.2 對 70.8）[arXiv:2201.08904]。字元亂排的 Random 描述，XXL 在 MultiWOZ 2.1 與 2.4 幾乎不輸 Language（57.6 對 57.8、73.6 對 75.9）[arXiv:2201.08904]。

撰寫第 3 組草稿時歸納：描述的價值集中在 schema 沒見過的情境；schema 固定、資料充足時，名稱與描述差不多，模型夠大時連亂碼也差不多 [arXiv:2105.04222][arXiv:2109.07506][arXiv:2201.08904]。「夠大」這個條件不能省：Random 描述的 Large 在 MultiWOZ 2.2 只有 9.0，作者說它訓練難以收斂 [arXiv:2201.08904]。

**多輪退化是累積的還是有界的（📖 反例）。**

- **Lost in Conversation：會累積。** Sharded 平均掉 39%，答案越改越長、不撤回舊假設，中間輪次引入的文件被引用的比例偏低 [arXiv:2505.06120]。
- **Drift No More（📖）：有界。** 它宣稱 KL 散度維持在窄帶內，並用 ΔD_t 對 D_t 的迴歸斜率全為負來佐證有恢復力 [arXiv:2510.07777]。
- **反證：迴歸診斷沒有鑑別力。** 精讀時指出，若 D_t 只是 i.i.d. 雜訊，OLS 必然得到 b 約為 −1、R² 約為 0.5；Table 6 的 b 為 −0.957、−1.049、−1.007，兩列 R² 都是 0.494，幾乎就是這個虛無模型的期望值 [arXiv:2510.07777]。撰寫第 4 組草稿時以常態 i.i.d. 雜訊模擬，得到與虛無模型期望相符的結果 [arXiv:2510.07777]。
- **兩篇量的不是同一件事。** Lost in Conversation 量 assistant 承接自己先前回答時的任務分數；Drift No More 量使用者模擬器輸出分佈相對參考模型的距離，也沒報 τ-bench 的任務成功率（精讀時發現）[arXiv:2505.06120][arXiv:2510.07777]。撰寫本章時的判斷：這篇 📖 論文推翻不了前者的發現 [arXiv:2505.06120][arXiv:2510.07777]。

**「靠 agent 框架重述有限」被自己的數字削弱。**

- Lost in Conversation 正文說 Snowball 能挽回 15–20% 的退化，並據此主張 LLM 應原生支援多輪 [arXiv:2505.06120]。
- 精讀時用它自己的 Table 2 換算，撰寫第 4 組草稿時重算一致：Snowball 補回 (61.8 − 50.4) ÷ (86.8 − 50.4) ≈ 31%（GPT-4o-mini）與 (65.3 − 59.1) ÷ (93.0 − 59.1) ≈ 18%（GPT-4o）[arXiv:2505.06120]。Recap 是 (66.5 − 50.4) ÷ (86.8 − 50.4) ≈ 44% 與 (76.6 − 59.1) ÷ (93.0 − 59.1) ≈ 52% [arXiv:2505.06120]。15–20% 只對得上 GPT-4o 的 Snowball [arXiv:2505.06120]。
- 精讀時指出，Recap 與 Snowball 都只是把使用者原話重貼進已經含有錯誤嘗試的上下文；「由 LLM 把目前狀態彙整成結構化摘要，放進乾淨的上下文重問」沒被測 [arXiv:2505.06120]。而這正是 MemGPT 的 working context、RMM 的主題摘要、Mem0 的事實抽取在做的事；依各篇筆記，這三個系統沒有一篇在 session 內逐輪補齊的設定下被測過（撰寫第 4 組草稿時整理）[arXiv:2310.08560][arXiv:2503.08026][arXiv:2504.19413][arXiv:2505.06120]。

**少資料的優勢隨資料量消失，規模和方法的貢獻混在一起。**

- IC-DST 在 MultiWOZ 2.1 對最強基線的領先，從 1% 的 43.13 − 33.76 = 9.37，縮到 5% 的 47.08 − 44.20 = 2.88，再到 10% 的 48.67 − 46.92 = 1.75 [arXiv:2203.08568]。100% 時 IC-DST 的 50.65 反而輸給 SGPDST（即 DaP）的 56.66 [arXiv:2203.08568]。
- TOD-BERT 對 BERT 的 DST 增益，5% 時是 28.6 − 19.6 = 9.0，全量時只剩 48.0 − 45.6 = 2.4 [arXiv:2004.06871]。
- D3ST 在 SGD 與 MultiWOZ 全量訓練的頭條數字都是 11B 的 XXL（留一領域那張表沒寫尺寸）；精讀時指出，它在 MultiWOZ 上 Large 還輸給 Base（2.2 是 54.2 對 56.1，2.3 是 58.6 對 59.1）[arXiv:2201.08904]。
- D3ST 在 SGD-X 上，XXL 平均掉 86.4 − 77.8 = 8.6，Large 只掉 80.0 − 75.3 = 4.7；XXL 的 SS(JGA) 0.27 也不低於 Large 的 0.26 [arXiv:2201.08904]。精讀時據此指出，XXL 的一部分增益綁在原始描述的特定措辭上 [arXiv:2201.08904]。
- TransferQA 用 T5-large，T5DST 用 T5-small，平均 JGA 是 35.77（2.1）對 35.20（2.0）；TransferQA 換成 T5-base 只有 32.89 [arXiv:2109.04655][arXiv:2105.04222]。

### 傳統 DST 子領域內的爭議

**MultiWOZ 2.1 的名次分不出高下（TripPy 對 SimpleTOD）。** TripPy 報 55.29 ± 0.28（三個種子、等價比對），SimpleTOD 報 55.76（單次執行，精讀時判定）[arXiv:2005.02877][arXiv:2005.00796]。差距 55.76 − 55.29 = 0.47，約為 TripPy 種子標準差的 (55.76 − 55.29) / 0.28 ≈ 1.7 倍 [arXiv:2005.02877][arXiv:2005.00796]。精讀時另外發現，55.76 出自 12 層 GPT-2，端對端 combined 92.98 則出自 6 層 DistilGPT2，後者的 JGA 只有 54.54，所以「一個模型同時在 DST 與端對端拿到最佳」沒有被單一模型證明 [arXiv:2005.00796]。之後 D3ST 說自己在所有基準上接近或達到最佳，但依它自己的表，MultiWOZ 2.3 的最佳是 BERT Base 的 TripPy（63.0），高於 D3ST XXL 的 60.8 [arXiv:2201.08904]。

**SUMBT 在 MultiWOZ 上幾分，要看引的是哪一份。**

- 論文：0.4240，MultiWOZ 2.0，35 個 slot，作者自行清理過資料 [arXiv:1907.07421]。
- 官方 README（精讀時查到）：0.48806 與 0.49064，用的學習率不在論文的搜尋空間內 [arXiv:1907.07421]。
- ConvLab-2（精讀時查到）：換成它的前處理與評估程式，是 0.30 [arXiv:1907.07421]。
- TripPy 把 42.40 放進 MultiWOZ 2.1 的表，並加註這是 2.0 的結果 [arXiv:2005.02877]。

**資料蒐集方式：WOZ 與模擬互相批評，各自的弱點都沒量。** MultiWOZ 批評機器對機器蒐集的自然度完全取決於模擬器設計，所以選擇人對人的 Wizard-of-Oz [arXiv:1810.00278]。SGD 反過來主張模擬式蒐集的標註錯誤較少，並引用 MultiWOZ 2.0 有 40% 的 turn 帶標註錯誤 [arXiv:1909.05855]。兩邊都沒有量自己那一側的弱點 [arXiv:1810.00278][arXiv:1909.05855]：

- MultiWOZ 沒量 belief state 的標註一致性（精讀時發現）[arXiv:1810.00278]。
- SGD 自承無法和既有資料集並排比較自然度 [arXiv:1909.05855]。精讀時還發現，SGD 改寫階段強制群眾工作者逐字保留 slot 值，這對 span 抽取特別有利 [arXiv:1909.05855]。

MultiWOZ 2.2 則把問題留在 WOZ 這一側，改用事後修正：17.3% 的 user 輪被修改，但精讀時發現，修改大多是把同一個值的各種說法列進清單，也就是放寬評估，而不是更正錯值 [arXiv:2007.12720]。

**方法論文的主張只在一部分設定上成立。**

- **TRADE 的零樣本亮點只在 taxi。** 60.58 只出現在 taxi，作者自己解釋是因為它的 slot 都能在其他領域找到相近的值 [arXiv:1905.08743]。精讀時也發現，零樣本設定排除的是目標 (domain, slot) 的監督，而不是含目標領域語句的對話 [arXiv:1905.08743]。
- **TRADE 的持續學習。** GEM 在 train（54.31 對 naive 59.83）與 restaurant（39.24 對 42.42）新領域上反而較差（精讀時發現）[arXiv:1905.08743]。
- **GLAD 的 local 模組搬到多領域未必有用。** WoZ dev 消融顯示拿掉 local 會讓 joint 從 88.8 掉到 86.6 [arXiv:1805.09655]。但在 TRADE 的 MultiWOZ 重跑裡，拿掉 slot 專屬 RNN 的簡化版 GCE 反而略高於 GLAD：五領域 36.27 對 35.57，restaurant 60.93 對 53.23 [arXiv:1905.08743]。
- **NBT 的「不需要人工資源」。** 精讀時指出，它仍需要人工列舉所有值的 ontology，而且效能依賴一組注入了 PPDB 改寫資源的詞向量 [arXiv:1606.03777]。反過來，基線所謂建不起來的字典，在 DSTC2 只有 3 條、在 WOZ 只有 38 條，就把 joint goal 從 69.1 拉到 72.9、從 70.8 拉到 83.7 [arXiv:1606.03777]。
- **SGD 的「有競爭力」。** 主模型在 MultiWOZ 2.1 是 0.434，低於論文自己引用的已知最佳 0.456；超過最佳的 0.489 來自一個細節沒有揭露的複製變體（精讀時發現）[arXiv:1909.05855]。
- **SUMBT 的「universal and scalable」。** 精讀時發現，論文沒有任何留出 slot、新領域或零樣本的實驗支撐這個標題 [arXiv:1907.07421]。

### 零樣本 DST 子領域內的爭議

**一次生成全部 slot 好，還是逐 slot 生成好。** DaP 在同一 T5 骨幹下比較，一次生成所有三元組比逐槽解碼差：T5-small 差 55.2 − 48.9 = 6.3，T5-base 差 56.7 − 51.2 = 5.5 [arXiv:2109.07506]。D3ST 的主張方向相反，認為一次解碼所有 active slot 既有效率又可擴展 [arXiv:2201.08904]。兩邊的證據都不乾淨：

- 精讀時發現，DaP 公開程式碼的 sequential 變體吃的是「上一輪狀態＋當輪對話對」，與論文描述的「吃完整歷史」不同 [arXiv:2109.07506]。
- D3ST 聲稱 Base 在 SGD 與 MultiWOZ 上都比 DaP 好；精讀時指出，它自己的 Table 1(a) 就推翻了 MultiWOZ 那一半：DaP(ind) 在 2.1、2.2 是 56.7、57.6，D3ST Base 只有 54.2、56.1 [arXiv:2201.08904]。
- D3ST 沒有任何延遲或吞吐的量測 [arXiv:2201.08904]。

撰寫第 3 組草稿時判斷，本章沒有一篇在同尺寸、同輸入下直接比較過「索引式一次解碼」與「逐槽解碼」[arXiv:2109.07506][arXiv:2201.08904]。

### 記憶子領域內的爭議

**Mem0、Zep 與 Hindsight 的比較表。**

- **Mem0 自己表中的 Zep。** Zep 的 Overall J 是 65.99；但 Mem0 摘要說四個題型都勝過所有既有記憶系統，Open Domain 其實是 Zep 最高（76.60 對 Mem0g 的 75.71）[arXiv:2504.19413]。
- **Zep 的反駁（精讀時發現，屬競爭廠商自述）。** Zep 官方部落格指控 Mem0 設定錯誤，並報告更正後 Zep 的 J 為 75.14 ± 0.17（https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/）[arXiv:2504.19413]。精讀 agent 讀公開的 Zep 寫入腳本，確認其中兩點指控與程式相符；但雙方各有利益衝突，未見第三方裁定 [arXiv:2504.19413]。
- **Hindsight 表中的 Zep（精讀時發現，程式驗證證實並修正說法）。** 總分寫 75.14，但照原表欄位加權只得 (74.11×282 + 66.04×96 + 67.71×841 + 79.79×321) ÷ 1,540 ≈ 71.30，對不起來 [arXiv:2512.12818]。程式驗證另外發現，把 Zep 列後三欄輪換（66.04 移到 Temporal、67.71 移到 Multi-Hop、79.79 移到 Open Domain），加權就是 (74.11×282 + 67.71×96 + 79.79×841 + 66.04×321) ÷ 1,540 ≈ 75.13，四格也都能還原成整數題數；在 4 × 3 × 2 = 24 種欄位排列中，只有這一種如此 [arXiv:2512.12818]。所以比較精確的說法是：Zep 列的類別對應與其他列不一致。這是抄錯，還是來源用了不同的類別排序，快取分不出來，因為 Zep 部落格的原表不在快取裡 [arXiv:2512.12818]。
- **Hindsight 表中另外四列（撰寫第 4 組草稿時核對兩篇全文發現，程式驗證證實）。** Mem0、Mem0-Graph、LangMem、OpenAI 四列的分項，與 Mem0 論文 Table 1 的 J 值逐格相同，總分 66.88、68.44、58.10、52.90 也相同，四列共 4 × 5 = 20 格無一例外；Zep 列則五格全都不同 [arXiv:2512.12818][arXiv:2504.19413]。Hindsight 原文說這些基線照 Backboard 公布的數字列出，只當參考點，所以中間可能還隔了 Backboard 一手 [arXiv:2512.12818]。逐格相同支撐「這四列源自 Mem0 論文」；若是如此，它們就帶著 Mem0 那把寬鬆的 gpt-4o-mini judge，而 Hindsight 自己的列用 GPT-OSS-120B 評審，同一張表因此混了至少兩把尺（這一步是撰寫者由前半句推論，未能從原文證實）[arXiv:2512.12818][arXiv:2504.19413]。

**衝突與過時事實怎麼處理，六篇的做法沒有被互相比較過。**

- Mem0 基本版的 DELETE 是實體刪除；精讀時指出，這和作答提示詞「記憶矛盾時取最新」互相矛盾，也讓「以前住哪」這類問題無從回答 [arXiv:2504.19413]。
- Mem0g 保留失效的邊，對 Mem0 的整體 J 只多 68.44 − 66.88 = 1.56，p95 總延遲卻是 2.590 ÷ 1.440 ≈ 1.8 倍（精讀時發現）[arXiv:2504.19413]。
- 精讀時推測，Hindsight 的 knowledge-update 增益來自時間資訊與答題 LLM 的讀取時裁決，而不是狀態層真的做了更新 [arXiv:2512.12818]。
- 精讀時也發現，MemoryBank 只追加與衰減，使用者改口時新舊事實會同時被取回 [arXiv:2305.10250]。

### 論文文字、表格與程式碼彼此不一致

以下各點多為精讀時讀全文、表格或公開程式碼發現，不是論文的主張。它們大多不動搖主結論，但引用數字時要小心：

- **MultiWOZ 的回合數。** Table 1 光訓練集就有 113,556 turns，§4.1 卻說全部 10,438 則共 115,434 turns [arXiv:1810.00278]。依 §4.1 自己的平均回合數重算，3,406×8.93 + 7,032×15.39 ≈ 138,638，而訓練集 8,438×13.46 ≈ 113,575 與 Table 1 吻合，所以 115,434 才是異數 [arXiv:1810.00278]。
- **GLAD 的錯誤範例。** Table 3 的錯誤範例，正文說的方向與表格圖例相反 [arXiv:1805.09655]。
- **NBT 的官方程式碼。** 它實作的是用學習式信念更新取代規則的後續版本，找不到 λ=0.55，本文的規則式設定無法直接重現 [arXiv:1606.03777]。
- **MultiWOZ 2.2 的 action 補標。** §4.4 說 8,333 輪是群眾標註的，資料目錄的 README 卻說是用微調 T5 標註、再人工核對 [arXiv:2007.12720]。
- **DaP 的文字與表格。** 正文說描述讓兩個模型都提升超過 1%，但 T5-base 只有 57.6 − 56.7 = 0.9 [arXiv:2109.07506]。錯誤分析說隨機抽了 50 輪，但 53.33%、20% 這組比例對應的分母是 30 [arXiv:2109.07506]。
- **T5DST 的「一致提升」。** Slot Type 被說成在所有領域一致提升，但 Taxi 上 64.62 與只用 slot 名稱完全相同 [arXiv:2105.04222]。
- **IC-DST 的 zero-shot 增幅。** 引言說每個領域提升 10–30 個百分點，但 taxi 只比 T5DST 高 71.35 − 64.62 = 6.73，而且 64.62 還是 MultiWOZ 2.0 的數字 [arXiv:2203.08568][arXiv:2105.04222]。
- **FnCTOD 的「超越先前最佳」。** 它說 Baichuan2-13B-Chat 超越先前最佳，但它的 56.56 低於 IC-DST 的 56.96 [arXiv:2402.10466]。
- **Generative Agents 的程式碼。** 官方 repo 的檢索權重是 recency 0.5、relevance 3、importance 2，不是論文說的全部為 1 [arXiv:2304.03442]。
- **MemGPT 的 DMR baseline。** 排序和模型能力相反：GPT-4 的 32.1% 低於 GPT-3.5 的 38.7% [arXiv:2310.08560]。精讀提出的假說是 baseline 被要求資訊不足時回 NO ANSWER，而這個回答會被判錯 [arXiv:2310.08560]。
- **Hindsight 的貢獻列表。** 列表說 20B backbone 在 LoCoMo 上從 75.78% 升到 85.67%，但依 Table 4，85.67% 是 OSS-120B 的結果，75.78% 是 Memobase [arXiv:2512.12818]。
- **Mem0 的評估對象。** 被量的是 Mem0 雲端平台的 MemoryClient，平台專案還設了一段只給 Mem0 的 LOCOMO 專用抽取指示，論文沒有提到 [arXiv:2504.19413]。
- **Lost in Conversation 的整體退化幅度。** 摘要寫 −39%，Figure 1 寫 −35%，引言寫 90%→65% [arXiv:2505.06120]。

## 商用採納現況

本節只用採納摘要裡附 URL 的證據。被論文引用、學術引用數、排行榜與學術工具組的整合都不算採納。整體來看，兩個 DST 子領域幾乎沒有商用採納的證據；第三個子領域有幾條產品線，但多半是作者自己的公司，而且產品已經偏離論文的設計（撰寫本章時的歸納）[arXiv:2310.08560][arXiv:2504.19413][arXiv:2512.12818]。

### 論文自述部署

計入的 23 篇沒有一篇在論文裡描述自己已經部署到產品（依各篇筆記的採納欄位）[arXiv:1606.03777][arXiv:2504.19413]。

- **Mem0 最接近，但仍歸在作者自家。** 標題寫 production-ready，正文談到部署上的考量 [arXiv:2504.19413]。作者公開的評估程式直接呼叫 Mem0 雲端平台的 MemoryClient，也就是被量的系統就是它的商用服務（https://github.com/mem0ai/mem0/blob/393a4fd5a6cfeb754857a2229726f567a9fadf36/evaluation/src/memzero/add.py）[arXiv:2504.19413]。但這是程式碼顯示的事實，不是論文自述部署，所以列在下面「作者自家」一類。
- **NBT 只談可能性。** 論文只說這個框架更適合擴展到真實系統，沒有描述任何實際部署 [arXiv:1606.03777]。

### 廠商官方文件採用

- **Google Cloud Vertex AI Memory Bank ← RMM 的 Prospective Reflection。**
  - 官方部落格（2025-07-09，https://cloud.google.com/blog/products/ai-machine-learning/vertex-ai-memory-bank-in-public-preview）說明，Memory Bank 的記憶處理流程以 Google 一項 ACL 2025 研究為基礎，超連結直接指向本篇，描述為以主題為基礎的記憶學習與回想 [arXiv:2503.08026]。
  - 官方文件（https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/memory-bank）描述的抽取、整併、相似度檢索，與 Prospective Reflection 的形狀一致；但這一頁本身沒有引用論文 [arXiv:2503.08026]。
  - 這一條要附兩個但書 [arXiv:2503.08026]：
    - 廠商就是作者的雇主，部落格作者之一推定是論文作者。
    - 以引用為獎勵、用 RL 訓練 reranker 的 Retrospective Reflection，官方部落格與文件都沒有提到。
- **Oracle OCI-STM ← Lost in Conversation 的基準與問題定義。** Oracle 官方部落格（2026-04-20，https://blogs.oracle.com/ai-and-datascience/multiturn-ocistm）介紹 OCI GenAI 的短期記憶功能，它定期把較舊的對話輪次壓縮成結構化的 memory state [arXiv:2505.06120]。文中說以 sharded 版的 GSM8K、HumanEval、Spider、BFCL 等多輪基準驗證，並把本篇列為參考文獻 [arXiv:2505.06120]。採納的是基準與問題定義，不是狀態方法，因為本篇本身沒有提出狀態方法 [arXiv:2505.06120]。品質結果只有圖，沒有數字；精讀者以 WebFetch 與 curl 都被擋，改用瀏覽器確認內容 [arXiv:2505.06120]。
- **LangChain ← Generative Agents 的三項加權檢索。**
  - 官方部落格（2023-04-18，https://www.langchain.com/blog/agents-round）說這篇的檢索邏輯看起來可泛化，因此做成 TimeWeightedVectorStoreRetriever [arXiv:2304.03442]。
  - langchain-experimental 的 GenerativeAgentMemory（https://github.com/langchain-ai/langchain-experimental/blob/main/libs/experimental/langchain_experimental/generative_agents/memory.py）以相同措辭的重要度量表請 LLM 打分，累計超過門檻就反思 [arXiv:2304.03442]。
  - 這是開源框架層級的採納。對話系統在實際產品中用這套記憶做多輪狀態追蹤，未見證據 [arXiv:2304.03442]。
- **Mem0 產品的第三方整合。** 下列三項採納的是 Mem0 這個產品，不能歸因於論文的實驗結果 [arXiv:2504.19413]：
  - Microsoft AutoGen 官方文件提供 Mem0Memory 類別（https://microsoft.github.io/autogen/stable//user-guide/agentchat-user-guide/memory.html）[arXiv:2504.19413]。
  - Strands Agents 官方工具庫內建 mem0_memory 工具（https://github.com/strands-agents/tools）[arXiv:2504.19413]。
  - AWS Database Blog 以 Mem0 開源版示範參考架構（https://aws.amazon.com/blogs/database/build-persistent-memory-for-agentic-ai-applications-with-mem0-open-source-amazon-elasticache-for-valkey-and-amazon-neptune-analytics/）。但共同作者包含 Mem0 CTO，也沒有宣稱生產環境使用 [arXiv:2504.19413]。
- **NVIDIA 的 DST 示範資產。** 兩者都是工具包層級的支援，不是產品部署 [arXiv:1810.00278][arXiv:1909.05855]：
  - NGC 官方模型目錄有一張「TRADE - MultiWOZ 2.1 - Dialogue State Tracker」model card，是以 NeMo 在 MultiWOZ 2.1 上訓練的檢查點，test JGA 47.77%（https://catalog.ngc.nvidia.com/orgs/nvidia/-/models/trade___dialogue_state_tracker___multiwoz_2_1/-）[arXiv:1810.00278]。這張卡在採納摘要裡歸在 MultiWOZ 名下；TRADE 的筆記本身判為未見商用採納 [arXiv:1810.00278][arXiv:1905.08743]。
  - NeMo 官方文件把 SGD 列為支援的任務，提供 SGDQA 模型（https://docs.nvidia.com/nemo-framework/user-guide/24.07/nemotoolkit/nlp/dialogue.html），頁面標示為已封存 [arXiv:1909.05855]。
- **弱證據：MemGPT 的參考實作。** LangChain 官方 org 發布過 lang-memgpt，README 說受 MemGPT 等論文啟發；它是範例不是產品，已封存（https://github.com/langchain-ai/lang-memgpt）[arXiv:2310.08560]。

### 僅作者自家釋出

- **MemGPT → Letta。** 作者成立 Letta 公司接手開源專案，推出託管服務 Letta Cloud（https://www.letta.com/blog/memgpt-and-letta/、https://www.letta.com/blog/announcing-letta/、https://github.com/letta-ai/letta）[arXiv:2310.08560]。但 Letta 現行文件顯示 memory blocks 正在棄用、改推另一套記憶系統（https://docs.letta.com/concepts/memgpt/），今天的產品已經不是照論文的分層設計在跑 [arXiv:2310.08560]。
- **Mem0。** 開源函式庫同時提供自架版與雲端平台（https://github.com/mem0ai/mem0）[arXiv:2504.19413]。
- **Hindsight → Vectorize。**
  - 作者公司把它開源並提供託管版（https://github.com/vectorize-io/hindsight、https://vectorize.io/product、https://hindsight.vectorize.io/）[arXiv:2512.12818]。
  - README 自稱在 Fortune 500 企業的生產環境中使用，但沒有列出具名客戶 [arXiv:2512.12818]。它說的「獨立重現」，重現單位也都是作者的所屬機構 [arXiv:2512.12818]。
  - 產品的記憶類型清單已不列 opinion，所以不能證明論文那一版的設計被原樣採用 [arXiv:2512.12818]。
- **Generative Agents → Simile。** 作者共同創辦的公司對企業銷售行為模擬服務（https://www.simile.com/）；投資方文章說它的 agent 以結構化訪談與行為訊號為基礎（https://baincapitalventures.com/insight/the-human-layer-of-ai-why-we-re-continuing-to-invest-in-simile/）[arXiv:2304.03442]。沒有證據顯示記憶流與反思架構本身在產品中上線 [arXiv:2304.03442]。第三方的 AI Town 自稱受本篇啟發，但 README 沒有描述記憶設計（https://github.com/a16z-infra/ai-town）[arXiv:2304.03442]。
- **研究程式碼、資料與官方部落格的釋出。** 以下都只是研究釋出，不構成採納：
  - SGD：Google Research 部落格宣布釋出（https://research.google/blog/introducing-the-schema-guided-dialogue-dataset-for-conversational-assistants/），只把 Google Assistant 當成問題背景 [arXiv:1909.05855]。
  - D3ST：Google Research 部落格（https://research.google/blog/simple-and-effective-zero-shot-task-oriented-dialogue/）；程式碼 repo 明寫不是 Google 官方支援的產品 [arXiv:2201.08904]。
  - SimpleTOD：Salesforce 官方部落格只當研究成果介紹（https://www.salesforce.com/blog/simpletod/），repo 已封存（https://github.com/salesforce/simpletod）[arXiv:2005.00796]。
  - T5DST 與 TransferQA：https://github.com/facebookresearch/Zero-Shot-DST，主體採非商用授權，已封存 [arXiv:2105.04222][arXiv:2109.04655]。
  - TOD-BERT：https://github.com/jasonwu0731/ToD-BERT 與 https://huggingface.co/TODBERT/TOD-BERT-JNT-V1 [arXiv:2004.06871]。
  - MultiWOZ 與 2.2：https://github.com/budzianowski/multiwoz [arXiv:1810.00278][arXiv:2007.12720]。
  - TRADE、GLAD、SUMBT：https://github.com/jasonwu0731/trade-dst、https://github.com/salesforce/glad、https://github.com/SKTBrain/SUMBT [arXiv:1905.08743][arXiv:1805.09655][arXiv:1907.07421]。

### 學術工具組的整合（不算採納）

ConvLab-2 把 TRADE 與 SUMBT 列為內建 DST（https://github.com/thu-coai/ConvLab-2），ConvLab-3 內建 TripPy（https://github.com/ConvLab/ConvLab-3），Hugging Face 上有 ConvLab 重做的 TripPy 權重（https://huggingface.co/ConvLab/roberta-base-trippy-dst-multiwoz21）[arXiv:1905.08743][arXiv:1907.07421][arXiv:2005.02877]。Amazon Alexa 組織下的 DialoGLUE 用修改過的 TripPy 當基線（https://github.com/alexa/dialoglue），儲存庫內沒有任何產品使用的說明 [arXiv:2005.02877]。這些都屬學術基礎建設 [arXiv:1905.08743][arXiv:1907.07421][arXiv:2005.02877]。

### 未見證據

NBT、TripPy、MultiWOZ 2.2、DaP、IC-DST、FnCTOD、MemoryBank 都未見附 URL 的商用採納證據 [arXiv:1606.03777][arXiv:2005.02877][arXiv:2007.12720][arXiv:2109.07506][arXiv:2203.08568][arXiv:2402.10466][arXiv:2305.10250]。📖 的 Drift No More 也未見證據 [arXiv:2510.07777]。IC-DST 的主模型 code-davinci-002 已由 OpenAI 下架（https://developers.openai.com/api/docs/deprecations），原始設定也不可能原樣延續在產品中 [arXiv:2203.08568]。

## 與其他節點的關係

### E2 State Adjustments（T5→T2）：反思修正的結果回寫對話狀態

標了這條邊的筆記有 10 篇，其中屬於本節點的只有 Generative Agents、MemGPT、RMM、Hindsight 四篇，其餘六篇的主節點在 T5、T3、T8 [arXiv:2304.03442][arXiv:2310.08560][arXiv:2503.08026][arXiv:2512.12818]。精讀者的標註有鬆有緊，本章用兩個判準逐篇重判：

- **(a) 寫回去的是不是「修正」。** 也就是由偵測到錯誤觸發，而不只是綜合出新內容或收到新資訊。
- **(b) 寫回的對象是不是同一段互動內的狀態。** 跨嘗試的長期記憶、搜尋樹、檢索器權重都不算。

| 論文 | 寫回什麼、寫到哪 | (a) 是修正嗎 | (b) 是互動內的狀態嗎 | 判定 | 出處 |
| --- | --- | --- | --- | --- | --- |
| MemGPT | 對話中出現與已存事實不符的新資訊時，LLM 以函式呼叫改寫 working context；函式的 runtime error 也回饋給 LLM | 是，但修正由同一個 LLM 在回覆流程中順手做，沒有獨立的反思模組 | 是 | 資料流最接近完整；沒有實驗量這條路徑的正確率 | [arXiv:2310.08560] |
| SWE-agent | agent 在格式錯誤之後改出合法回覆，history_processor 就把先前格式錯誤那幾輪從訊息歷史中刪除 | 是，但只限格式錯誤 | 是：改寫的是送進模型的對話歷史 | 完整但範圍很窄；論文沒量這一步的效果 | [arXiv:2405.15793] |
| WebCanvas | reward 模組輸出的 verbal reflection、狀態與分數寫回 agent 的 memory，下一步 planning 直接讀取 | 是：評估式的反思 | 部分：寫回的是 agent 在同一個 episode 內的工作記憶，不是對話狀態的 slot | 報了下游數字，而且是負面的，但只是單次、未經檢定：GPT-4 加上自評 reward 後 CR 從 46.9 降到 42.1、SR 從 16.9 降到 13.8，作者歸因於過度自信與低品質 reward 累積在 memory；精讀時指出只有 130 題、單次執行、沒有誤差棒，基準列的來源也可疑 | [arXiv:2406.12373] |
| Reflexion | 每則反思附加到長期記憶（滑動視窗 Ω = 1–3），下一次嘗試以它為條件 | 是 | 否：跨嘗試、環境重置之後 | 缺「互動內」那一半 | [arXiv:2303.11366] |
| RCI（Language Models can Solve Computer Tasks） | 計劃在回合開始時經一次修正後存成 current plan，放進之後每一步的提示 | 是，但只修一次 | 是 | 缺「執行途中回寫」那一半：偏離計劃後無法挽回 | [arXiv:2303.17491] |
| LATS | 反思結果與失敗軌跡存入記憶，當作後續擴展與評分的額外 context；同時更新整棵樹的 N 與 V | 是 | 部分：寫回的是 agent 的工作狀態與搜尋樹，不是對話狀態的 slot | 資料流存在，但對象不是對話狀態 | [arXiv:2310.04406] |
| 自我修正綜述（Automatically Correcting LLMs） | 整理幾種把修正結果接回後續生成的做法 | 是 | 部分 | 只有一兩句描述，沒討論回寫格式或衝突處理 | [arXiv:2308.03188] |
| Generative Agents | 反思產生的洞見寫回記憶流並參與之後的檢索；反應判定後重新生成計畫 | 否：是綜合，不是修正；沒有任何把錯誤記憶改掉或標記失效的機制 | 是 | 缺「修正」那一半 | [arXiv:2304.03442] |
| Hindsight | CARA 的 reflect 把回答時形成的新意見（附信心值）寫回意見網路，之後依新事實加強、減弱或改寫 | 部分：是信念修正，不是針對錯誤的自我修正 | 是 | 設計上有，實驗中把 profile 設成中性，這條回寫路徑沒有任何數字 | [arXiv:2512.12818] |
| RMM | Retrospective Reflection 以生成器的引用自評，用 REINFORCE 更新 reranker；改寫記憶內容的 Merge 由 session 結束觸發 | 自評是，但 Merge 不是由錯誤偵測觸發 | 否：改的是之後讀哪幾筆的讀取策略，不是狀態內容 | 標註過寬，實際不算這條邊 | [arXiv:2503.08026] |

**從 T2 這一側看：接得住修正的狀態格式，和真的被修正過的狀態，是兩回事（撰寫本章時的判斷）。**

- **接得住的格式有，但修正都不是反思觸發的。** 本章裡有明確刪除或改寫語法的狀態格式，有 IC-DST 的狀態變化（新增、刪除、改值）、Mem0 的 UPDATE／DELETE、MemGPT 的 working context 改寫 [arXiv:2203.08568][arXiv:2504.19413][arXiv:2310.08560]。但 IC-DST 與 Mem0 的更新由新進來的使用者語句觸發，不是由反思或錯誤偵測觸發 [arXiv:2203.08568][arXiv:2504.19413]。
- **更多的格式根本沒有修正的入口。** GLAD 與 TripPy 只覆寫不刪除，FnCTOD 只增不刪，Generative Agents 只增不刪 [arXiv:1805.09655][arXiv:2005.02877][arXiv:2402.10466][arXiv:2304.03442]。
- **這條資料流缺席時，只有旁證。** Lost in Conversation 觀察到，模型的答案越改越長，而不撤回先前的錯誤假設 [arXiv:2505.06120]。這可以當作這條資料流缺席時的旁證，但這是精讀時提出、本章採用的詮釋：Lost in Conversation 沒有測任何回寫機制，也沒有比較有無這條資料流 [arXiv:2505.06120]。
- **資料流做了之後，只有一筆單次、未經檢定的負面數字。** WebCanvas 報告，GPT-4 加上自評 reward 寫回 memory 後，CR 從 46.9 降到 42.1、SR 從 16.9 降到 13.8 [arXiv:2406.12373]。作者把原因歸於完成判斷過度自信，以及低品質的 reward 累積在 memory；但這個機制本身沒有被單獨量測 [arXiv:2406.12373]。精讀時指出兩個保留 [arXiv:2406.12373]：
  - 這組比較只有 130 題、單次執行、沒有誤差棒。CR 的落差 46.9 − 42.1 = 4.8，不到主表 GPT-4 標準差兩倍的 2 × 3.04 = 6.08 [arXiv:2406.12373]。
  - 無 reward 的基準列與另一張訓練集結果表高度重疊（GPT-4 的 CR 46.9 與 ES 3.77 相同），實際來源可疑，連帶讓 reward 模組的比較失去可信度 [arXiv:2406.12373]。
- **Generative Agents 的寫回也有放大錯誤的風險，但沒有量。** 精讀時指出，它的反思未經驗證就寫回、又能引用舊反思，錯誤會沿反思樹放大 [arXiv:2304.03442]。

所以這條邊目前只做了一半：T5 那一側會產生修正，T2 這一側有能寫入的格式。表中判準 (a)、(b) 都不是「否」的論文裡，報了寫回之後下游數字的只有 WebCanvas 那一筆單次、未經檢定的下降，以及 LATS 拿掉反思的消融（HotPotQA EM 從 0.63 降到 0.58，精讀時指出只差 100 題中的 5 題）；兩者寫回的對象都不是對話狀態 [arXiv:2406.12373][arXiv:2310.04406]。表中其他有數字的論文不符合這兩個判準，例如 Generative Agents 的反思寫回不是修正，Reflexion 與 RMM 的寫回不在同一段互動內的狀態上 [arXiv:2304.03442][arXiv:2303.11366][arXiv:2503.08026]。沒有一篇量過「修正寫回之後，狀態本身有沒有變得更對」（撰寫本章時的判斷）[arXiv:2310.08560][arXiv:2406.12373][arXiv:2504.19413]。

## 未解問題

1. **更新這一步本身怎麼量。** 三個子領域在〈方法比較〉的跨子領域表裡列了十三種維護方式，但量的一直是下游結果：JGA、問答準確率或可信度 [arXiv:1805.09655][arXiv:2005.02877][arXiv:2504.19413][arXiv:2512.12818]。卡在三處：
   - JGA 分不出「本輪抽錯」與「前面錯了一路帶下來」[arXiv:1805.09655]。
   - 記憶系統沒有操作層級的標註：沒有一篇為「該抽出哪些事實、該 UPDATE 還是 DELETE」標過 ground truth [arXiv:2310.08560][arXiv:2503.08026][arXiv:2504.19413][arXiv:2512.12818]。
   - 最接近的 knowledge-update 題型，Hindsight 的評審接受新舊答案並列 [arXiv:2512.12818]。
   
   資料上的更新型態也太窄：MultiWOZ 只有「查無資料改用替代值」一種目標變更，沒有撤銷、更正或回指修改（精讀時的分析）[arXiv:1810.00278]。

2. **累積狀態的錯誤傳遞與每輪重算的長度效應，哪一個代價較大。** 累積派（TripPy、SGD 原型、IC-DST、FnCTOD）沒有做 gold 與預測上一輪狀態的對照；重算派（SimpleTOD 與第二個子領域的五篇微調）沒有一篇按對話長度分析 JGA [arXiv:2005.02877][arXiv:2203.08568][arXiv:2402.10466][arXiv:2005.00796][arXiv:2201.08904]。卡在兩處：
   - 評估資料太短：IC-DST 所用的 MultiWOZ 平均每段只有 13.46 輪，SGD train 平均 20.44 turns [arXiv:2203.08568][arXiv:1909.05855]。
   - 唯一讓模型整段在自己的歷史上接下去的 Lost in Conversation，被測的 assistant 又沒有任何顯式狀態 [arXiv:2505.06120]。

3. **一把可以跨論文比較的尺。** JGA 在 slot 集合、標籤正規化、資料版本、空狀態輪次算不算、種子數上各不相同，同一個 MDBT 可以從 80.9 變成 17.98，同一個 SUMBT 可以是 0.4240、0.488–0.491 或 0.30 [arXiv:1810.00278][arXiv:1905.08743][arXiv:1907.07421]。「zero-shot」至少有五種意思，逐領域平均與多領域 JGA 可以差到 62.59 − 38.71 = 23.88 [arXiv:2402.10466]。記憶系統的 LLM 評審寬鬆度也各篇不同 [arXiv:2310.08560][arXiv:2504.19413][arXiv:2512.12818]。卡在：這些選擇都不寫進指標名稱；評估程式還可能因為相依版本而靜默改變語意（SUMBT，精讀時發現）[arXiv:1907.07421]。

4. **系統提議、使用者隱含接受的值，要不要進狀態。** MultiWOZ 2.2 把接受前就標進去的值列為幻覺，也承認標註者對接受後的值政策不一；TripPy 把它當正規的來源；DaP 與 TransferQA 的錯誤落在相反兩側 [arXiv:2007.12720][arXiv:2005.02877][arXiv:2109.07506][arXiv:2109.04655]。卡在：這一類的正解本身是政策選擇，而資料裡兩種政策並存，所以在這些回合上，模型之間的差距分不出是追蹤能力還是政策偏好 [arXiv:2007.12720]。

5. **刪除、撤回與衝突的語意。** 以下是本章各篇的做法：
   - GLAD、TripPy 只覆寫不刪除，FnCTOD 只增不刪 [arXiv:1805.09655][arXiv:2005.02877][arXiv:2402.10466]。
   - IC-DST 說狀態變化包含刪除，卻沒給 SQL 寫法 [arXiv:2203.08568]。
   - Mem0 基本版硬刪、圖版軟失效 [arXiv:2504.19413]。
   - Hindsight 的 world／experience 事實在寫入時不作廢，衝突主要延到讀取時裁決；observation 重新產生時取最新或證據最多，opinion 與背景另有寫入時的更新規則 [arXiv:2512.12818]。

   卡在基準：需要一個帶時間戳的事實變更序列，同時問「現在是什麼」與「以前是什麼」；Mem0 基本版的硬刪根本答不了後者（精讀時發現）[arXiv:2504.19413]。精讀時指出（未量化），MultiWOZ 上撤回與跨領域同輪修改都少見，JGA 因此看不出這類錯誤 [arXiv:2402.10466]。Hindsight 也自承意見與信念層還不支援受控遺忘與時間感知的信念修正 [arXiv:2512.12818]。

6. **session 內的狀態維持，和跨 session 的記憶接不起來。**
   - Lost in Conversation 量的是只拿到最小系統訊息、沒有任何記憶模組的 assistant [arXiv:2505.06120]。
   - 記憶系統在 session 結束時或逐組訊息寫入，並以跨 session 回想評估 [arXiv:2503.08026][arXiv:2504.19413]。
   - 「多長以後外部記憶才划算」沒有答案：約 26K token 時全文脈絡勝過 Mem0，約 115K token 時記憶系統大勝，而沒有一篇在同一個模型、同一個評審下掃過對話長度 [arXiv:2504.19413][arXiv:2512.12818][arXiv:2503.08026]。
   - 範圍裡的「指令在多輪中的保持」更是沒有一篇直接量過（撰寫本章時依筆記判斷）[arXiv:2505.06120]。

   卡在沒有實驗把兩邊放在一起：精讀時指出，「彙整後放進乾淨上下文重問」這個最直接的做法正好沒被測 [arXiv:2505.06120]。

7. **真正零曝光的 zero-shot，以及對 schema 措辭的穩健性。** 本章每一種 zero-shot 都帶著某種目標端曝光 [arXiv:2105.04222][arXiv:2201.08904][arXiv:2402.10466][arXiv:2004.06871]：
   - 訓練時看過目標領域語句。
   - 訓練提示可能含留出領域的描述。
   - 示範取自目標資料集。
   - 預訓練含 MultiWOZ 文字。

   換到 schema 慣例不同的資料集，D3ST XXL 的跨資料集 zero-shot 只有 28.9（SGD→MultiWOZ 2.4）與 23.1（MultiWOZ→SGD）[arXiv:2201.08904]。對措辭的穩健性只有 D3ST 在 SGD-X 上測過，XXL 最差的變體從 86.4 掉到 68.9 [arXiv:2201.08904]。唯一的量尺 SS(JGA) 本身也有疑問。撰寫第 3 組草稿時依 D3ST 的一句定義推論：若每輪 JGA 是 0／1、五個變體答對 k 次，母體標準差的變異係數是 √((5 − k)／k)，只由 k 決定，所以 SS 可能隨正確率機械地下降 [arXiv:2201.08904]。這一點尚待回 SGD-X 原論文核對。

8. **JGA 能不能預測任務完成。** 本章有兩處反例：
   - ConvLab-2 上，SUMBT 的 JGA 低於 TRADE，端對端的 success rate 卻較高（精讀時查到）[arXiv:1907.07421]。
   - SimpleTOD 自己也說，部分 oracle 設定下的名次推不到完整系統 [arXiv:2005.00796]。

   卡在：端對端分數同時受 DB 查詢、去詞彙化佔位符與政策模組影響，可以被設定灌高（精讀時推論）[arXiv:2005.00796][arXiv:2402.10466]。在同一條管線上同時量 JGA 與任務完成的比較，本章只有精讀時查到的 ConvLab-2 這一例 [arXiv:1907.07421]。

## 文獻表

<!-- bib:begin -->
標記：✅ 讀完全文並通過錨點驗證，計入本節點；📖 讀完全文但不計入（原因寫在一句話後面）；❌ 只拿得到摘要。一句話取自精讀筆記的 one_liner。

| 標記 | arXiv | 標題 | arXiv 年月 | 子領域 | 一句話 |
| --- | --- | --- | --- | --- | --- |
| ✅ | [1606.03777](https://arxiv.org/abs/1606.03777) | Neural Belief Tracker: Data-Driven Dialogue State Tracking | 2016-06 | 傳統任務型對話 DST 與資料集 | Mrkšić 等人（ACL 2017）提出 Neural Belief Tracker（NBT-DNN／NBT-CNN）：用固定不動的語意特化詞向量（Paragram-SL999）組出使用者語句與候選 slot-value 的表示，逐一判斷每個 slot-value 是否在本回合被表達，再以一條規則式插值把回合層級的判斷累加成信念狀態；不靠人工語意字典就在 DSTC2（joint goal 73.4）與本文擴充釋出的 WOZ 2.0（84.4）上追平加了字典的 delexicalisation 基線。 |
| ✅ | [1805.09655](https://arxiv.org/abs/1805.09655) | Global-Locally Self-Attentive Dialogue State Tracker | 2018-05 | 傳統任務型對話 DST 與資料集 | 提出 GLAD：以「全槽共用的 global biLSTM＋自注意力」與「每槽專屬的 local biLSTM＋自注意力」按每槽學到的比例混合來編碼使用者話語、前一輪系統動作與候選 slot-value，逐一做二元判斷，藉跨槽共享參數改善稀有 slot-value 的追蹤，在 WoZ 與 DSTC2 取得當時最佳的 joint goal accuracy。 |
| ✅ | [1810.00278](https://arxiv.org/abs/1810.00278) | MultiWOZ -- A Large-Scale Multi-Domain Wizard-of-Oz Dataset for Task-Oriented Dialogue Modelling | 2018-10 | 傳統任務型對話 DST 與資料集 | Budzianowski 等人（Cambridge／PolyAI，EMNLP 2018）用一套完全群眾外包的 Wizard-of-Oz 流程，蒐集出 10,438 則、橫跨 7 個領域（每則 1–5 個領域）的人對人打字任務型對話，每輪附 wizard 查詢表單留下的 belief state 與另行標註的 system dialogue act，並在 DST（只做 restaurant 子集）、以 oracle 狀態做的 context-to-response，以及 act-to-text 三個子任務上給出基準。這就是後來的 MultiWOZ 2.0，也是之後 2.1–2.4 各修正版的原版。 |
| ✅ | [1905.08743](https://arxiv.org/abs/1905.08743) | Transferable Multi-Domain State Generator for Task-Oriented Dialogue Systems | 2019-05 | 傳統任務型對話 DST 與資料集 | 提出 TRADE：以跨領域共用的編碼器、soft-gated 複製式狀態生成器與三分類 slot gate，逐一生成每個 (domain, slot) 的值，不需預先列舉所有可能值，在 MultiWOZ 五領域拿到 48.62% joint goal accuracy，並示範留一領域的零樣本與 1% 資料的少樣本領域擴充。 |
| ✅ | [1907.07421](https://arxiv.org/abs/1907.07421) | SUMBT: Slot-Utterance Matching for Universal and Scalable Belief Tracking | 2019-07 | 傳統任務型對話 DST 與資料集 | 把 domain-slot 名稱當成閱讀理解的「問題」：用 BERT 編碼當回合的系統與使用者語句，以 slot 名稱的 BERT 向量對語句做 multi-head attention，把結果送進每個 slot 各自一條的 RNN 跨回合累積，最後在凍結的 BERT 向量空間中，用距離從本體候選值裡挑出最近的一個。單一模型處理所有 slot，在 WOZ 2.0 得到 joint goal accuracy 0.910，在 MultiWOZ 得到 0.424。 |
| ✅ | [1909.05855](https://arxiv.org/abs/1909.05855) | Towards Scalable Multi-domain Conversational Agents: The Schema-Guided Dialogue Dataset | 2019-09 | 傳統任務型對話 DST 與資料集 | Google 用「schema＋對話模擬器＋群眾改寫」的流程做出 Schema-Guided Dialogue（SGD）資料集。train 有 16,142 段多領域對話、16 個領域、26 個服務，評估集另含未見過的服務與領域。論文同時提出 schema-guided 範式：每個服務以自然語言描述提供自己的 intent 與 slot，由單一模型在執行期針對這份動態 schema 做 DST。論文另附一個以 BERT 為基礎、能零樣本套用到新 API 的 DST 原型。 |
| ✅ | [2005.00796](https://arxiv.org/abs/2005.00796) | A Simple Language Model for Task-Oriented Dialogue | 2020-05 | 傳統任務型對話 DST 與資料集 | SimpleTOD 把任務型對話的三個子任務（belief state 追蹤、系統動作決策、去詞彙化回應生成）串成一條「context → belief → DB 結果 → action → response」的文字序列，用單一因果語言模型（GPT-2／DistilGPT2 微調）以標準 LM loss 一次學完；在 MultiWOZ 2.1 拿到 55.76 joint goal accuracy，在不給任何 oracle 狀態與動作的 MultiWOZ 2.0 設定下，Inform／Success 高於 DAMD。 |
| ✅ | [2005.02877](https://arxiv.org/abs/2005.02877) | TripPy: A Triple Copy Strategy for Value Independent Neural Dialog State Tracking | 2020-05 | 傳統任務型對話 DST 與資料集 | TripPy 以 BERT 編碼「本回合＋對話歷史」，替每個 domain-slot 配一個五類 slot gate，決定值要從使用者話語抽 span、從系統本回合告知過的值複製（inform），或從對話狀態裡另一個 slot 複製（refer），完全不用候選值清單，在 MultiWOZ 2.1 取得 55.29% JGA（當時最佳），並在 WOZ 2.0、sim-M、sim-R 上也領先非 oracle 基線。 |
| ✅ | [2007.12720](https://arxiv.org/abs/2007.12720) | MultiWOZ 2.2 : A Dialogue Dataset with Additional Annotation Corrections and State Tracking Baselines | 2020-07 | 傳統任務型對話 DST 與資料集 | 在 MultiWOZ 2.1 之上再修一輪對話狀態標註，改用 SGD 式 schema 把槽位分成 categorical 與 non-categorical，允許一個槽位的狀態是多個等價值的清單，並補上 span、copy_from、active intents、requested slots 與缺漏的 dialogue act，最後用 TRADE、SGD-baseline、DS-DST 建立 JGA 基準，釋出 MultiWOZ 2.2。 |
| ✅ | [2004.06871](https://arxiv.org/abs/2004.06871) | TOD-BERT: Pre-trained Natural Language Understanding for Task-Oriented Dialogue | 2020-04 | LLM 時代的 zero/few-shot DST | Wu 等人（Salesforce Research，EMNLP 2020）把九個人對人、多輪的任務型對話資料集（約 10 萬通對話、139 萬句、60 多個領域）合併，從 BERT-base 繼續預訓練：加入 [USR]／[SYS] 說話者標記做 MLM，並以批次內負樣本的 response contrastive loss 模擬回應選擇，得到 TOD-BERT；在意圖辨識、MultiWOZ 2.1 的 DST、對話行為預測與回應選擇四個下游任務上勝過 BERT，而在只拿 1%～25% 標註資料微調時差距更大（MWOZ 2.1 joint goal：全量 48.0 對 BERT 45.6；5% 資料 28.6 對 19.6）。 |
| ✅ | [2105.04222](https://arxiv.org/abs/2105.04222) | Leveraging Slot Descriptions for Zero-Shot Cross-Domain Dialogue State Tracking | 2021-05 | LLM 時代的 zero/few-shot DST | 把 DST 寫成「對話歷史＋slot 描述 → 生成 slot 值」的 T5 seq2seq 問答（T5DST），並比較五種 slot 描述寫法，發現在描述前加上 slot 型別前綴（number of／location of／time of…）最有利於 MultiWOZ 的 zero-shot 跨領域遷移。 |
| ✅ | [2109.04655](https://arxiv.org/abs/2109.04655) | Zero-Shot Dialogue State Tracking via Cross-Task Transfer | 2021-09 | LLM 時代的 zero/few-shot DST | TransferQA 把 DST 改寫成閱讀理解問答：用 T5-large 在 6 個抽取式與 2 個多選 QA 資料集上訓練一個統一的生成式 QA 模型，並以「負問句取樣」與「脈絡截斷」人工造出無法回答的樣本來學會回答 none，完全不用 DST 標註資料就在 MultiWOZ 2.1 做到 zero-shot per-domain 平均 JGA 35.77（前人最佳 28.18），few-shot 也大致勝過同為 QA 轉移的 STARC。 |
| ✅ | [2109.07506](https://arxiv.org/abs/2109.07506) | Dialogue State Tracking with a Language Model using Schema-Driven Prompting | 2021-09 | LLM 時代的 zero/few-shot DST | 把 schema 的 domain／slot 名稱（再加上自然語言描述與類別槽的可能值清單）當成提示，接在完整對話歷史後面一起餵進 T5 的雙向 encoder，對每個 domain-slot 各自生成一個值（沒有就生成 none），以全量資料微調 T5-small／base，在 MultiWOZ 2.2 取得當時最佳 JGA（57.6），在 MultiWOZ 2.1 與 M2M 與當時最佳相當（註：全量微調、無 zero/few-shot 實驗，子領域不符）。 |
| ✅ | [2201.08904](https://arxiv.org/abs/2201.08904) | Description-Driven Task-Oriented Dialog Modeling | 2022-01 | LLM 時代的 zero/few-shot DST | Google Research 提出 D3ST：把 schema 裡的 slot、intent 名稱整個換成自然語言描述，每個描述前面掛一個逐例隨機指派的索引，串在對話前面一起餵給 T5。模型一次解碼出所有 active slot 的「索引:值」與 active intent 的索引，藉此在 SGD 的未見服務與 MultiWOZ 的跨領域設定做 zero-shot 狀態追蹤。 |
| ✅ | [2203.08568](https://arxiv.org/abs/2203.08568) | In-Context Learning for Few-Shot Dialogue State Tracking | 2022-03 | LLM 時代的 zero/few-shot DST | IC-DST 把多領域 DST 改寫成 text-to-SQL，以「前一輪狀態＋最新一輪對話」取代完整歷史、只預測本輪狀態變化量，並用「狀態變化相似度」微調的 SBERT 檢索器挑選範例，讓凍結參數的 Codex 在 MultiWOZ 1%／5%／10% few-shot 與 zero-shot 設定下超越需要微調的前作。 |
| ✅ | [2402.10466](https://arxiv.org/abs/2402.10466) | Large Language Models as Zero-shot Dialogue State Tracker through Function Calling | 2024-02 | LLM 時代的 zero/few-shot DST | FnCTOD 把任務型對話每個領域的 schema 轉成一個函式規格，把 DST 改寫成「助理回覆前先呼叫該領域函式、以 slot 為參數」的 function calling，並拆成「先選函式、再填參數」兩步；在 MultiWOZ 2.1 上讓 GPT-4 的零樣本 Average JGA 達 62.59，讓 7B／13B 開源模型靠 5 筆示範追平或超越先前的 ChatGPT／Codex 提示法，另外用 7,200 段非 MultiWOZ 對話做 LoRA 微調，讓 LLaMA2-13B-Chat 追上 ChatGPT。 |
| ✅ | [2304.03442](https://arxiv.org/abs/2304.03442) | Generative Agents: Interactive Simulacra of Human Behavior | 2023-04 | LLM agent 的多輪狀態維護、對話記憶與多輪退化 | 提出以「記憶流（memory stream）＋三項加權檢索（recency／importance／relevance）＋重要度累積觸發的反思＋由粗到細的規劃」包住 gpt-3.5-turbo 的 agent 架構，在自建的 Smallville 沙盒放 25 個 agent 跑兩個遊戲日，用 100 位人評對訪談回答做可信度排名的消融實驗，並以資訊擴散、關係網密度、派對出席數描述湧現行為。 |
| ✅ | [2305.10250](https://arxiv.org/abs/2305.10250) | MemoryBank: Enhancing Large Language Models with Long-Term Memory | 2023-05 | LLM agent 的多輪狀態維護、對話記憶與多輪退化 | MemoryBank 在 LLM 外面掛一個長期記憶庫，分三層存：帶時間戳記的逐輪原文、LLM 產生的每日與全域事件摘要、每日與全域使用者畫像。每輪用使用者當句話做 dense 檢索，把取回的記憶放進提示；記憶要不要留，依艾賓浩斯遺忘曲線，由經過時間與被召回次數決定。作者拿它做成陪伴型聊天機器人 SiliconFriend，有 ChatGPT、ChatGLM、BELLE 三個版本。評估時讓 ChatGPT 模擬 15 名使用者、各產生 10 天對話，再用 194 題探針做人工評分；實驗只比較這三個版本，沒有「不掛記憶」的對照組，也沒有消融。 |
| ✅ | [2310.08560](https://arxiv.org/abs/2310.08560) | MemGPT: Towards LLMs as Operating Systems | 2023-10 | LLM agent 的多輪狀態維護、對話記憶與多輪退化 | 把 LLM 的 context window 當成作業系統的主記憶體，設計「main context＋外部儲存」的分層記憶，由 LLM 自己透過函式呼叫把資訊換入換出，讓固定長度的模型撐得起長期多 session 對話與超長文件分析。 |
| ✅ | [2503.08026](https://arxiv.org/abs/2503.08026) | In Prospect and Retrospect: Reflective Memory Management for Long-term Personalized Dialogue Agents | 2025-03 | LLM agent 的多輪狀態維護、對話記憶與多輪退化 | 提出 RMM（Reflective Memory Management）：每個 session 結束時用 LLM 把對話拆成「主題摘要＋原始對話片段」寫進記憶庫，並與既有記憶做 Add／Merge 整併（Prospective Reflection）；檢索時在固定的 dense retriever 後面接一個可學的輕量 reranker，以生成器回答時自己標的引用（有引用 +1、沒引用 −1）當獎勵，用 REINFORCE 線上更新（Retrospective Reflection）；在 MSC 與 LongMemEval 上勝過 RAG、MemoryBank、LD-Agent，並被 Google Cloud 官方部落格列為 Vertex AI Memory Bank 的研究基礎。 |
| ✅ | [2504.19413](https://arxiv.org/abs/2504.19413) | Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory | 2025-04 | LLM agent 的多輪狀態維護、對話記憶與多輪退化 | 提出 Mem0：每收到一組新訊息就用 LLM 抽出候選事實，再讓 LLM 以工具呼叫在 ADD/UPDATE/DELETE/NOOP 四種操作中擇一，維護跨 session 的使用者記憶庫（另有以實體關係圖儲存的 Mem0g）；在 LOCOMO 上只用全文脈絡約 7% 的檢索 token、p95 總延遲降低約 92%，LLM-judge 分數略低於全文脈絡（66.88／68.44 對 72.90）。 |
| ✅ | [2505.06120](https://arxiv.org/abs/2505.06120) | LLMs Get Lost In Multi-Turn Conversation | 2025-05 | LLM agent 的多輪狀態維護、對話記憶與多輪退化 | 作者把六個單輪基準的完整指令，半自動切成一組資訊碎片（shard）。GPT-4o-mini 扮演使用者模擬器，每輪最多揭露一片。用這套設定對 15 個 LLM 跑了逾 20 萬段模擬對話，結果所有模型在「資訊逐輪補齊」的多輪對話中平均掉 39%。退化主要來自同一題多次執行之間的不穩定度（unreliability）暴增，最佳情況下的能力（aptitude）只小幅下降。 |
| 📖 | [2510.07777](https://arxiv.org/abs/2510.07777) | Drift No More? Context Equilibria in Multi-Turn LLM Interactions | 2025-10 | LLM agent 的多輪狀態維護、對話記憶與多輪退化 | 把多輪對話中的 context drift 定義為「測試模型與 GPT-4.1 參考模型逐輪 token 分佈的 KL 散度」，用帶恢復力的隨機遞迴模型把它解讀成有界均衡，並在合成改寫任務與 τ-bench 使用者模擬器上測試固定輪次的目標提醒能否把均衡往下壓。（不計入：精讀後判為低價值：核心的「有界均衡」證據（b≈−1、R²≈0.49）在沒有任何動態的 i.i.d. 雜訊下也會出現，加上共用歷史的設計沒測到會累積的條件、表格之間多處數字互相矛盾，扣掉之後只剩固定輪次提醒讓 KL 降 6–12% 的小結果，而且用來佐證的 judge 看得到參考答案。） |
| ✅ | [2512.12818](https://arxiv.org/abs/2512.12818) | Hindsight is 20/20: Building Agent Memory that Retains, Recalls, and Reflects | 2025-12 | LLM agent 的多輪狀態維護、對話記憶與多輪退化 | Vectorize.io 提出的外部長期記憶系統 Hindsight。它把對話記憶切成 world／experience／opinion／observation 四個網路，由 TEMPR 負責 retain 與 recall：LLM 萃取帶時間區間的敘事事實、建實體／時間／語意／因果四種連結的圖，再用語意、BM25、圖擴散、時間四路檢索，經 RRF 融合、cross-encoder 重排，最後依 token 預算打包。CARA 負責 reflect：用 disposition 參數與意見信心值做偏好條件推理。在 LongMemEval S 上，同一個 GPT-OSS-20B 從 full-context 的 39.0% 提升到 83.6%；換更大的 backbone 後，LongMemEval 最高 91.4%、LoCoMo 最高 89.61%。 |
<!-- bib:end -->
