# 04｜Agent Trace / Trajectory（軌跡）

## 這一章回答什麼

本章把 agent 的一次執行當成一個資料物件，回答三個問題：軌跡用什麼格式記錄、怎麼收集與合成，又怎麼拿來訓練 agent；軌跡失敗時怎麼分類，怎麼歸因到哪一步、哪個 agent；以及怎麼替整條軌跡或每一步打分，包括 process reward。以 benchmark 整體設計為主的論文屬 T7，分數的定義與聚合屬 T8，即時監控屬 T3(b)，本章只在對照時引用它們的筆記：T8 的子目標與關鍵節點分數放進〈「步驟分數」至少有六種語意〉，T7 的 Agent-as-a-Judge 與 T3 的 SWE-agent 失敗分類放進相關的對照段落 [arXiv:2401.13178][arXiv:2406.12373][arXiv:2410.10934][arXiv:2405.15793]。本節點精讀二十四篇，二十四篇全部計入，另有六篇候補未讀。各子領域的計入篇數是：軌跡的格式、收集與合成八篇，軌跡分析、失敗分類與歸因七篇，軌跡／步驟層級評估與 process reward 九篇。

名目上的篇數要打折看。二十四篇中有七篇是單輪數學推理，沒有工具呼叫、環境回饋或多輪互動：process reward 那九篇裡的六篇，加上被計入失敗歸因的 ProcessBench [arXiv:2211.14275][arXiv:2305.20050][arXiv:2312.08935][arXiv:2406.06592][arXiv:2410.08146][arXiv:2501.07301][arXiv:2412.06559]。所以在 agent 軌跡上做失敗歸因的實際是六篇 [arXiv:2503.13657][arXiv:2505.00212][arXiv:2505.08638][arXiv:2506.18824][arXiv:2509.03312][arXiv:2509.25370]。在本調研讀過的論文裡，以 rollout 估計的 Q 值訓練出獨立的步驟評分模型（PRM），再接上 agent 的線上 RL 與推論期挑選的，只有 AgentPRM 一篇 [arXiv:2502.10325]。下面三篇在 agent 上也用了步驟層級的訊號，但接法不同，三篇都沒有以步驟標籤訓練評分模型：ETO 以單次 rollout 的最終報酬決定第 t 步誰好，直接做單步 DPO；Pan et al. 用 LM 逐步判定進度，拿來篩 filtered BC 的訓練資料，這個判定只在 50 個 state-action pair 上人工驗過；UI-TARS 以人工標出的錯誤步組成修正配對，做 reflection SFT 與 DPO [arXiv:2403.02502][arXiv:2404.06474][arXiv:2501.12326]。AgentRewardBench 只到軌跡層級 [arXiv:2504.08942]。本章凡是談「訓練成 PRM 的步驟分數在 agent 上堪不堪用」的判斷，都只建立在 AgentPRM 這一篇上。

**範圍。** 本章的結論有三條邊界：

- **時間窗。** 計入的二十四篇依 arXiv 編號落在 2022-10 到 2025-09，最早是 ReAct，最晚是 AgenTracer 與 AgentDebug [arXiv:2210.03629][arXiv:2509.03312][arXiv:2509.25370]。2025 年以後的候選要有頂會、附 URL 的採納證據或足夠的 influential 引用才能入選，不符合的由程式硬規則（RECENT-INELIGIBLE）刷掉；所以時間窗之後、以及窗內較晚而未入選的論文，本章都沒有讀。
- **未讀的六篇候補。** 各自原本要補的是：
  - Training Verifiers to Solve Math Word Problems（arXiv 2110.14168，未讀）：依標題，它研究訓練驗證器來解數學應用題；原本要補的是本章用來對照的 ORM 與驗證器的早期來源。
  - Watch Every Step! LLM Agent Learning via Iterative Step-Level Process Refinement（arXiv 2406.11176，未讀）：依標題，它研究以迭代的步驟層級過程精煉來訓練 LLM agent；原本要補的是 agent 上的步驟信用分派。
  - Group-in-Group Policy Optimization for LLM Agent Training（arXiv 2505.10978，未讀）：依標題，它研究 LLM agent 訓練用的一種 policy optimization；原本要補的是 agent 上的步驟信用分派與多步線上 RL。
  - AgentGym: Evolving Large Language Model-based Agents across Diverse Environments（arXiv 2406.04151，未讀）：依標題，它研究讓 LLM agent 跨多種環境演化；原本要補的是跨環境的軌跡收集。
  - WebGPT: Browser-assisted question-answering with human feedback（arXiv 2112.09332，未讀）：依標題，它研究以瀏覽器輔助問答、並使用人類回饋；原本要補的是以人類為來源的軌跡收集。
  - InterCode: Standardizing and Benchmarking Interactive Coding with Execution Feedback（arXiv 2306.14898，未讀）：依標題，它研究把互動式寫程式標準化成基準，並提供執行回饋；原本要補的是統一的軌跡格式。
- **不涵蓋的部分。** 時間窗之後的論文，以及上面六篇、〈已知缺口與未讀〉列出的幾塊，本章的結論都不涵蓋。本章的否定句（「沒有一篇」「只有」「從沒」）一律指本調研讀過的論文。

## 問題的演進

本章的論文從 2022 年 10 月排到 2025 年 9 月，年月取自 arXiv 編號的前四碼。三個子領域的起點不同：

- **軌跡合成。** 在本章語料裡，從 ReAct 定下的 Thought／Action／Observation 交錯格式出發 [arXiv:2210.03629]。更早以人類示範在瀏覽器中收集軌跡的一支沒有讀，見〈已知缺口與未讀〉。
- **process reward。** 在本章語料裡，從數學解題上「逐步監督值不值得花」的問題出發 [arXiv:2211.14275]。全章拿來對照的 outcome reward model（ORM），更早的來源沒有讀，見〈已知缺口與未讀〉。
- **失敗歸因。** 這個子領域計入的七篇裡，最早的是 2024 年 12 月在數學題上做成基準的 ProcessBench，2025 年才有多 agent 執行紀錄上的歸因 [arXiv:2412.06559][arXiv:2505.00212]。但這只是分組的結果，不是這件事的歷史：ReAct 在 2022 年就在 HotpotQA 上人工分類過 ReAct 與 CoT 共 200 條答對與答錯軌跡的成功／失敗模式（其中答錯的 ReAct 軌跡 50 條），Uesato et al. 在 2022 年就定下「只標第一個重大錯誤」的人工協定，SWE-agent 在 2024 年 5 月已經用 LM 自動替 agent 軌跡做失敗分類 [arXiv:2210.03629][arXiv:2211.14275][arXiv:2405.15793]。

三條線反覆碰到同樣三個問題：軌跡與標籤由誰產生、標在什麼粒度，以及「成功」與「錯誤」怎麼定義 [arXiv:2210.03629][arXiv:2211.14275][arXiv:2412.06559][arXiv:2505.00212][arXiv:2412.21139]。下面依子領域敘述，最後一小節把三條線的交會與斷點接起來。

### 軌跡的格式、收集與合成（8 篇）

本小節八篇從 2022 年 10 月排到 2024 年 12 月，都把一次執行當成可以記錄、篩選、改寫，再拿去訓練下一個 agent 的資料 [arXiv:2210.03629][arXiv:2412.21139]。

**這一小節實際涵蓋什麼。** 名稱裡的三件事，份量並不相等：

- **格式。** 八篇都是訓練配方，格式是配方的副產品；沒有一篇以軌跡格式或統一 schema 為主要貢獻，最接近的是把格式當變因之一的 Agent-FLAN [arXiv:2403.12881]。各篇格式的並列見〈方法比較〉的格式對照表。
- **訓練方法。** 只涵蓋 SFT、軌跡層級 DPO 與 RFT [arXiv:2310.05915][arXiv:2403.02502][arXiv:2412.21139]。以結果獎勵直接做多輪線上 RL 的那一支沒有計入，見〈已知缺口與未讀〉。
- **使用者回合。** 依各篇筆記記載的任務與環境，八篇的軌跡都從一次給定的指令開始，中途沒有真實或模擬使用者的回合；AgentTuning 的「使用者回合」放的是環境回饋，Agent-FLAN 的「多輪對話」精讀時也指出只是把 agent 與環境的互動改寫成對話（其餘為本章比對）[arXiv:2310.05915][arXiv:2310.12823][arXiv:2403.02502][arXiv:2403.12881]。多輪使用者與 agent 對話軌跡怎麼合成，本章沒有涵蓋。

整條線沿五條軸推進：

- **軌跡由誰產生。** 本章八篇從人寫的範例，換成強教師模型，再換成 agent 自己的探索，最後由外部知識或可執行環境引導產生 [arXiv:2210.03629][arXiv:2310.05915][arXiv:2403.02502][arXiv:2412.09605][arXiv:2412.19723][arXiv:2412.21139]。這條敘述漏了大規模人類示範這一支。T7 精讀的 Mind2Web 以群眾外包在 137 個真實網站上收集 2,350 個任務的人類示範動作序列與網頁快照，並用來訓練 MindAct [arXiv:2306.06070]。AgentTuning 雖然把 Mind2Web 列為 held-in 來源，用的卻只是它 train split 的指令：軌跡由 GPT-4 或 GPT-3.5 重新 rollout，23,378 條指令只留下 122 條 [arXiv:2310.12823]。
- **用什麼訊號判斷好壞。** 從最終答案的 EM，換成環境 reward、LLM 評審，最後是單元測試 [arXiv:2210.03629][arXiv:2310.12823][arXiv:2412.09605][arXiv:2412.19723][arXiv:2412.21139]。
- **失敗的軌跡怎麼處理。** 從整批丟掉，到拿來當負例、按分數降權，或用來訓練評審 [arXiv:2310.05915][arXiv:2403.02502][arXiv:2412.19723][arXiv:2412.21139]。
- **軌跡記成什麼格式。** 從純文字的 Thought／Action／Observation，到多輪對話、多輪聊天加逐輪 loss 遮罩，再到含截圖、AXTree 與可重放 trace 的多層紀錄 [arXiv:2210.03629][arXiv:2310.12823][arXiv:2403.12881][arXiv:2412.09605]。
- **要多少、多雜。** 各篇的說法方向一致，但證據都薄：
  - **FireAct。** 核心主張是方法與任務的多樣性。資料量的效應依基座而異：Llama 在 100 或 200 條時學不會 ReAct 格式，GPT-3.5 在 100 條時 EM 已約 35 [arXiv:2310.05915]。
  - **SWE-Gym。** 訓練軌跡從 25% 加到 100% 時解題率持續上升、看不到飽和，但只有圖、沒有數字 [arXiv:2412.21139]。精讀時指出，491 條軌跡只涵蓋 294 個實例，scaling 只有三個點、各訓練一次，推不出「多樣性已經足夠」[arXiv:2412.21139]。
  - **Agent-FLAN。** 反向的證據：依能力重新配比後，訓練 token 從 37.3M 降到 18.1M，T-Eval 從 64.9 升到 66.3、HotpotQA 從 27.9 升到 28.5 [arXiv:2403.12881]。但精讀時指出，配比就是在這兩個 held-out 集上挑的 [arXiv:2403.12881]。

**2022 年 10 月：ReAct 定下軌跡的樣子。** 它要解決的是推理與行動分家：只推理的 CoT 不接觸外部世界、容易捏造，只行動的方法不做高階推理、長程任務中容易忘記進度 [arXiv:2210.03629]。ReAct 把動作空間擴成「環境動作 ∪ 語言」，thought 不改變環境、只附加進上下文，一次執行因此成為 Thought、Action、Observation 交錯的文字序列 [arXiv:2210.03629]。HotpotQA、FEVER 每一步都有 thought；ALFWorld、WebShop 則把 thought 包成一個特殊動作，環境一律回「OK.」[arXiv:2210.03629]。同一種格式被拿去做三件事 [arXiv:2210.03629]：

- **當 few-shot 範例。** 每個任務只用 1 到 6 條人寫軌跡 [arXiv:2210.03629]。
- **當微調資料。** 用 PaLM-540B 提示產生軌跡，只留答案 EM 正確的 3,000 條，拿去微調 PaLM-8B／62B [arXiv:2210.03629]。這是由大到小的蒸餾，不是 agent 用自己的輸出自我改進 [arXiv:2210.03629]。
- **當人工失敗分類的對象。** 抽 200 條軌跡標註成功與失敗模式 [arXiv:2210.03629]。

它留下兩個缺口。第一，依論文自己的 Table 2，ReAct 答對的軌跡有 6% 是推理或事實捏造的 false positive，答錯的軌跡有 29% 其實是標籤歧義；精讀時據此推論，那 3,000 條訓練資料既混進過程錯誤、也丟掉了好軌跡 [arXiv:2210.03629]。第二，失敗分類停在軌跡層級，沒有指出哪一步出錯，重複迴圈也被併進 reasoning error、沒有單獨量化（精讀時發現）[arXiv:2210.03629]。

**2023 年 10 月：用強教師量產軌跡，系統地問「怎麼訓練」。** FireAct 與 AgentTuning 相隔 10 天上傳 [arXiv:2310.05915][arXiv:2310.12823]。

- **FireAct：統一格式，研究配方。** 當時的語言 agent 幾乎都靠 few-shot 提示，以軌跡微調只有零星結果，依 FireAct 的說法，還沒有人系統回答用什麼軌跡、用多少、混哪些方法 [arXiv:2310.05915]。它讓 GPT-4 以 ReAct、CoT、Reflexion 三種提示解 HotpotQA 等 QA 題，只留答對的軌跡，全部轉成 ReAct 格式 [arXiv:2310.05915]。用 500 條 ReAct 軌跡微調後，Llama-2-7B 的 HotpotQA EM 從 14.8 升到 26.2，GPT-3.5 從 31.4 升到 39.2，仍低於老師 GPT-4 ReAct prompting 的 42.0 [arXiv:2310.05915]。混入哪種方法的軌跡會改變學生的輪數：只用 ReAct 平均 3.2 輪，加 CoT 2.7 輪，加 Reflexion 3.8 輪 [arXiv:2310.05915]。它只做 QA、只有一個 Google 搜尋工具，作者自己也承認 [arXiv:2310.05915]。
- **AgentTuning：搬到多環境，混入一般資料。** 開源模型在 AgentBench 這類多輪互動任務上遠落後 GPT-3.5／GPT-4，既有做法不是只改提示，就是用單一任務資料微調、犧牲一般能力 [arXiv:2310.12823]。它把軌跡記成多輪對話：環境回饋放在使用者回合，模型回合是 Thought＋Action，整條附一個最終 reward r [arXiv:2310.12823]。GPT-4 在 6 個 AgentBench 環境 rollout，除 Mind2Web 放寬到 r≥2/3 外只留 r=1 的軌跡，35,341 條指令最後剩 1,866 條（5.29%）[arXiv:2310.12823]。沒有訓練集的 OS 與 DB 任務，由 GPT-4 self-instruct 出題，連同參考解與評估腳本一起產生，當作可執行的驗證器 [arXiv:2310.12823]。軌跡再與 ShareGPT 一般對話以 η=0.2 混合訓練 [arXiv:2310.12823]。論文用兩個消融撐起這兩個設計：只用 agent 軌跡時，7B 的 held-out Overall 只有 0.09；不過濾時，7B 的 held-in／held-out 從 1.96／0.65 降到 1.34／0.47 [arXiv:2310.12823]。這兩個消融都有混淆，見〈爭議、矛盾與反證〉[arXiv:2310.12823]。
- **優先權的說法要打折。** AgentTuning 自稱第一個以多個 agent 任務的互動軌跡做指令微調，但比它早 10 天的 FireAct 已經用 GPT-4 軌跡微調 Llama-2，它也沒有引用 FireAct（精讀時發現）[arXiv:2310.12823][arXiv:2310.05915]。

**2024 年 3 月：開始利用失敗軌跡，也開始把格式本身當變因。**

- **ETO：失敗軌跡變成 DPO 的負例。** 行為複製只看過成功示範、從沒在環境裡碰過自己的錯誤，直接跑 PPO 又不穩定 [arXiv:2403.02502]。它先用專家軌跡做 SFT，再讓 agent 在訓練指令上探索，把最終報酬較低的自產軌跡與同一指令的專家軌跡配成偏好對，在軌跡層級做 DPO，並反覆多輪 [arXiv:2403.02502]。Llama-2-7B-Chat 在 WebShop 的平均報酬從 SFT 的 63.1 升到 67.4，ScienceWorld-Unseen 從 53.0 升到 65.0 [arXiv:2403.02502]。它也試了步驟層級對比：從專家前綴的第 t 步起讓 agent 自己跑完，再用最終報酬決定第 t 步誰好 [arXiv:2403.02502]。WebShop 上，在與軌跡層級相同的 lr 1e-6、β 0.1 下只剩 8.3；改用更低的 lr 1e-7、更大的 β 0.5 後是 62.8，與 SFT 的 63.1 相當；兩者混合是 64.3，都不如軌跡層級的 67.4 [arXiv:2403.02502]。作者自述步驟層級對比不穩定，推測原因是只用最終報酬估計單步動作的品質不夠準 [arXiv:2403.02502]。作者自承讓整條失敗軌跡一起背鍋是簡化，因為錯誤多半從中間某一步才開始；沒有專家軌跡、跳過 SFT 時，單獨的 ETO 只有 12.5，低於未微調模型的 17.9 [arXiv:2403.02502]。
- **Agent-FLAN：序列化格式與組成本身就是訓練訊號。** 它認為 AgentTuning、FireAct 這類做法直接拿 ReAct 加 JSON 的軌跡做 SFT，把格式遵循和推理糾纏在一起，也忽略了沒給工具時硬套格式、呼叫不存在工具這類幻覺 [arXiv:2403.12881]。它做了三件事 [arXiv:2403.12881]：
  - **改寫成聊天格式。** Thought、工具名、參數各成一輪 assistant 回覆，loss 只算在 assistant 輪 [arXiv:2403.12881]。
  - **按能力重新配比。** 每一輪標成 reasoning、retrieval、understanding、instruction following 四種能力之一，依 1:0.25:0.75 重新配比，訓練 token 從 37.3M 降到 18.1M [arXiv:2403.12881]。
  - **補負樣本。** 補上「沒給工具卻被要求用工具」「給了工具但只是閒聊」兩種負樣本 [arXiv:2403.12881]。

  它的 held-out Overall 是 41.7，作者自行重做的 AgentTuning 是 38.2 [arXiv:2403.12881]。精讀時發現，格式對齊的增益和訓練 token 幾乎翻倍（19.2M→37.3M）混在一起，分不開 [arXiv:2403.12881]。

**2024 年 12 月：把合成管線做大，把判斷成敗的訊號換掉。** 三篇都在這個月上傳 [arXiv:2412.09605][arXiv:2412.19723][arXiv:2412.21139]。

- **AgentTrek：網路教學當軌跡骨架。** 網頁 agent 需要多步軌跡，人工標註難以擴充，無引導的 LLM 探索合成又成功率低、任務不真實 [arXiv:2412.09605]。它把網路上人寫的操作教學看成「沒有觀測與動作的軌跡草稿」：從 RedPajama 以規則、GPT-4o mini 與 FastText 層層篩出教學，標準化成任務規格；讓 GPT-4o 在真實瀏覽器裡照著重放，補上截圖、AXTree、推理與 Playwright 動作；再由 GPT-4o 評估器只留判定成功的軌跡 [arXiv:2412.09605]。23,430 份教學產出 10,398 條軌跡，每條約 0.551 美元；有教學引導的重放成功率 52%，只給高層目標時是 15.78% [arXiv:2412.09605]。精讀時發現，論文宣稱評估器會做逐步分析、找出最早失敗點，實際的提示詞卻只要求二元判定，判準也很寬鬆 [arXiv:2412.09605]。
- **OS-Genesis：先互動、後反推任務。** task-driven 合成先讓模型想任務再執行，任務常與環境的實際功能對不上；以 labeler 二元過濾又丟掉未完成軌跡裡仍有價值的探索 [arXiv:2412.19723]。它把順序倒過來：先以規則式遍歷收集〈動作前畫面、動作、動作後畫面〉三元組，讓 GPT-4o 從單步轉移反推低階與高階指令、再依高階指令執行出完整軌跡，最後由軌跡獎勵模型（TRM）給 1–5 分、按分數比例抽樣，不丟任何軌跡 [arXiv:2412.19723]。Qwen2-VL-7B 在 AndroidWorld 的成功率是 17.41，對照 task-driven 的 6.25、self-instruct 的 9.82 [arXiv:2412.19723]。精讀時發現，TRM 給 1 分的軌跡仍有滿分軌跡五分之一的機率被抽到，論文也沒報分數分佈 [arXiv:2412.19723]。
- **SWE-Gym：可執行環境與單元測試當標籤來源。** SWE-Bench 的 train split 只有 gold patch，沒有逐步動作、可執行環境與獎勵訊號 [arXiv:2412.21139]。它建了 2,438 個真實 GitHub issue 任務，每題有 Docker 環境與單元測試，任何 agent 跑出的軌跡都能自動標上成敗 [arXiv:2412.21139]。491 條教師成功軌跡讓 Qwen2.5-Coder-32B 在 SWE-Bench Verified 從 7.0% 升到 20.6%；成功與失敗各 1,318 條訓練出的軌跡層級 ORM，Best@16 達 32.0% [arXiv:2412.21139]。精讀時發現，這個 ORM 只給整條軌跡一個分數，沒有步驟層級歸因 [arXiv:2412.21139]。

**這條線停在結果層級。** 八篇的品質訊號全是結果層級：答案 EM、環境最終 reward、LLM 評審的整條判定、單元測試 [arXiv:2210.03629][arXiv:2310.05915][arXiv:2310.12823][arXiv:2403.02502][arXiv:2412.09605][arXiv:2412.19723][arXiv:2412.21139]。八篇裡唯一的步驟層級嘗試是 ETO：步驟層級對比在一組超參數下崩到 8.3，調低 lr、加大 β 後回到 62.8，與 SFT 持平，但沒有勝過軌跡層級 [arXiv:2403.02502]。精讀時指出，這組結果只說明「用單次 rollout 的最終報酬替單步標好壞」效果差，因為第 t 步之後整段都由 agent 自己產生，最終報酬混入了後續所有動作的好壞；Table 4 不應被外推成「過程層級監督在 agent 上無效」[arXiv:2403.02502]。精讀筆記也點名一篇 ETO 第一作者參與、改走步驟層級過程監督的後續 [arXiv:2403.02502]；本章沒有讀，所以無法判斷步驟層級監督在 agent 上用別的估計方式時效果如何，見〈已知缺口與未讀〉。怎麼替每一步打分，是下一小節那條線在做的事。

### 軌跡／步驟層級評估與 process reward（9 篇）

本小節九篇回答同一個問題：一條多步驟的軌跡，除了看最後對不對，能不能替每一步打分；這個分數從哪裡來，又怎麼知道它準不準 [arXiv:2211.14275][arXiv:2305.20050][arXiv:2312.08935][arXiv:2406.06592][arXiv:2410.08146][arXiv:2501.07301][arXiv:2404.06474][arXiv:2502.10325][arXiv:2504.08942]。其中六篇在單輪數學推理上，沿路換掉步驟標籤的來源；數學那六篇都沒有工具呼叫、環境回饋或多輪互動 [arXiv:2211.14275][arXiv:2305.20050][arXiv:2312.08935][arXiv:2406.06592][arXiv:2410.08146][arXiv:2501.07301]。另外三篇在 agent 軌跡上，三篇的終點判定各不相同 [arXiv:2404.06474][arXiv:2502.10325][arXiv:2504.08942]：

- **AgentPRM。** ALFWorld 由環境自動給結果獎勵，只是只在終點給 [arXiv:2502.10325]。
- **AgentRewardBench。** 五個基準都有規則式判定；它的論點是規則式判定不準（recall 55.9），不是沒有判定 [arXiv:2504.08942]。
- **Pan et al.** WebArena 以手寫 oracle 當基準；AitW 沒有成功判定，改以人工判定當 oracle；iOS 則兩者都沒有 [arXiv:2404.06474]。

三篇裡，Pan 與 AgentPRM 都在 agent 軌跡上逐步打分，AgentRewardBench 只到軌跡層級 [arXiv:2404.06474][arXiv:2502.10325][arXiv:2504.08942]。前兩篇的差別在分數從哪裡來、拿去做什麼：Pan 由 LM 讀動作前後的畫面判定進度，拿來篩 filtered BC 的訓練資料，準確度只在 iOS 的 50 個 state-action pair 上人工驗過；AgentPRM 以 rollout 估計的 Q 值訓練出 PRM，接上 online DPO 與推論期的 best-of-N [arXiv:2404.06474][arXiv:2502.10325]。

**數學這條線：步驟標籤的來源一換再換。**

- **2022 年 11 月，Uesato et al.：先問逐步監督值不值得。** 它把一次解題當成換行分隔的步驟序列，在 GSM8K 上比較只監督最終答案（outcome）與逐步監督（process），比較橫跨 SFT、reward model 重排序與 expert iteration RL [arXiv:2211.14275]。它定下兩個元件：只標「第一個重大錯誤步驟」、再展開成前綴二元標籤的人工協定，以及 trace error 指標，也就是最終答案正確的樣本中至少有一步被人判錯的比例 [arXiv:2211.14275]。首錯的形狀後來在 Lightman 的 PRM800K 裡又出現，但 Lightman 把「只監督到第一個錯誤步」寫成自己的刻意選擇，沒有歸給 Uesato；trace error 這個指標在本章其他二十三篇的全文裡都沒有被沿用（本章以全文搜尋確認）[arXiv:2305.20050][arXiv:2211.14275]。兩種監督的最終答案錯誤率相近：Few-shot+Final-Answer RL 對 SFT，多數決下是 23.5% 對 22.3%，ORM 重排序下是 16.6% 對 14.8% [arXiv:2211.14275]。只用最終答案標籤訓練的 ORM，逐步預測與 PRM 標籤的一致率是 85%，反而高於與自己訓練標籤的 77% [arXiv:2211.14275]。PRM 只有 1560 份樣本、530 題、9856 個步驟標籤，而且從 ORM 權重初始化；精讀時指出，兩者最終答案錯誤率接近（14.1% 對 14.8%），可能大半反映共同的 ORM 底子 [arXiv:2211.14275]。
- **2023 年 5 月，Lightman et al.：把人工標註放大。** 它以 GPT-4 base 為基底蒐集 PRM800K：約 80 萬個步驟標籤，涵蓋 75K 份解答、12K 題 [arXiv:2305.20050]。PRM 在每一步結尾預測 positive／negative／neutral，整份解答的分數取各步 positive 機率的乘積 [arXiv:2305.20050]。在 MATH 的 500 題子集上，best-of-1860 的結果是 PRM 78.2%、ORM 72.4%、多數決 69.6% [arXiv:2305.20050]。標註資料以主動學習挑選「目前 PRM 評分很高、但最終答案錯」的解答，資料效率約為均勻標註的 2.6 倍 [arXiv:2305.20050]。作者自承大尺度的 ORM 與 PRM 訓練集無法直接比較，也刻意不用 PRM 做 RL；精讀時指出，所有評估都是最終答案正確率，沒有直接量 PRM 找出第一個錯誤步的能力 [arXiv:2305.20050]。
- **2023 年底，Math-Shepherd：用補完 rollout 取代人工。** 它針對 PRM800K 的兩個問題：人工逐步標註昂貴，而且標註對象是 GPT-4 的輸出，和要監督的開源模型分布不同 [arXiv:2312.08935]。做法是固定前綴到第 i 步，讓 completer 往下補完 N 條解，只要有一條答到標準答案就標為正（hard estimation）；實際用 LLemma-7B 當 completer、N=8 [arXiv:2312.08935]。以 LLaMA2-70B 為生成器做 best-of-256，GSM8K 93.2、MATH500 44.5，分別高於 ORM 的 91.8 與 40.4 [arXiv:2312.08935]。PRM 分數也被當成逐步 PPO 的 reward：Mistral-7B 在 GSM8K 從 77.9 升到 84.1、MATH 從 28.6 升到 33.0，高於只在結尾給 reward 的 ORM-PPO（81.8／31.3）[arXiv:2312.08935]。精讀時指出，這個標籤量的是「在這個 completer 下還救不救得回來」，不是「這一步本身對不對」[arXiv:2312.08935]。
- **2024 年 6 月，OmegaPRM：把逐步 MC 改成二分搜尋。** 它點名 Math-Shepherd 這類做法對每一步都 rollout k 次，policy 呼叫數是 O(kM)，而且 rollout 用完就丟 [arXiv:2406.06592]。它從一個前綴取樣 k=8 個 rollout，只要有一個答對就視前綴正確；再假設前綴正確性單調，以二分搜尋在 O(k log M) 次呼叫內找到第一個錯誤步，途中的 rollout 存成樹重複利用 [arXiv:2406.06592]。同樣算力下，逐步暴力法產生 200K 筆資料，OmegaPRM 產生 15M 筆 [arXiv:2406.06592]。k=64 的 PRM 加權多數決中，Gemini Pro 在 MATH500 上得 69.4，多數決本身 67.2、PRM800K 67.6 [arXiv:2406.06592]。精讀時發現，頭條的 51 → 69.4 裡，67.2 − 51 = 16.2 點來自多數決，69.4 − 67.2 = 2.2 點才來自 PRM；自動標籤也沒有做任何人工稽核 [arXiv:2406.06592]。
- **2024 年 10 月，Setlur et al.：步驟分數該量進展，不是價值。** 它把 Math-Shepherd 與 OmegaPRM 歸為同一類自動 PRM：以未來答對的機率（Q 值）當步驟分數 [arXiv:2410.08146]。它引 DeepSeekMath 的結果指出，自動 PRM 當 RL 的 dense reward 只比 ORM 好 1–2% [arXiv:2410.08146]。它主張步驟分數應該是 advantage，也就是走這一步前後成功機率的變化，而且要在一個與基礎策略互補的 prover 下計算 [arXiv:2410.08146]。理由有三：Q 值把前一個狀態的潛力和這一步的好壞混在一起；prover 與基礎策略相同時，policy gradient 與只用 outcome reward 完全一樣；prover 太強或太弱時，A^μ 都趨近 0 [arXiv:2410.08146]。以 Bo4(π) 為 prover 的 beam search，要達到 ORM best-of-128 的準確率，Gemma 2B 與 9B 省 10× 計算、27B 省 5×，相對只用 Q^π 的 beam search 省 8× [arXiv:2410.08146]。dense-reward 線上 RL 比 ORM-RL 高 >7%，2B 達到同樣準確率快 6× [arXiv:2410.08146]。精讀時指出，實驗只有 MATH 一個資料集、只有 Gemma 2 系列 [arXiv:2410.08146]。
- **2025 年 1 月，Qwen 團隊：MC 標籤量的是 value，只看 BoN 看不出差別。** 作者照 Math-Shepherd 式的 MC 慣例訓練 PRM，發現 MC 造出的 PRM 在逐步錯誤定位上遠輸人工標註，BoN 分數卻看不出差別 [arXiv:2501.07301]。它把 MC 估計重新詮釋成 value：錯的步驟可能被續寫救回來，對的步驟也可能被續寫寫壞 [arXiv:2501.07301]。在同一批 86 萬筆題目與回應上，ProcessBench 平均 F1 是 LLM 判官 46.5、MC 估計 40.1；人工標註組用的是 PRM800K 本身的 264k 筆，資料不同，平均 F1 是 56.5 [arXiv:2501.07301]。Best-of-8 平均的排序卻相反：同一批 86 萬筆上 MC 65.9、判官 65.3，PRM800K 組是 64.9 [arXiv:2501.07301]。它的解法是共識過濾：MC 估計與 Qwen2.5-72B-Instruct 判官對第一個錯誤步的位置一致才保留，並改用 hard label [arXiv:2501.07301]。釋出的 Qwen2.5-Math-PRM-7B／72B 在 ProcessBench 的平均 F1 是 73.5／78.3，o1-mini 是 87.9 [arXiv:2501.07301]。精讀時發現，Best-of-64 時 PRM-7B 平均 56.1，低於 maj@64 的 56.3 [arXiv:2501.07301]。

**agent 這條分支：從讀軌跡的評估器，到 agent 上的 PRM，再回頭量評估器。**

- **2024 年 4 月，Pan et al.：讓 VLM 直接讀 agent 的軌跡。** 它把「評估一條軌跡」定義成一個函式：讀入指令、動作字串與截圖；軌跡層級只在最後一步給 1 或 0，逐步層級則把每一步分成「完成」「朝目標前進」「沒有貢獻」三類 [arXiv:2404.06474]。評估器有兩種實作：端到端交給 GPT-4V，或先用微調過的 QWen-VL-chat 把截圖轉成描述、再交給 Mixtral 或 GPT-4 推理 [arXiv:2404.06474]。和人工基準的一致率，WebArena 上（對手寫 oracle）是 74.4–82.1%，AitW 上（對人工判定）是 89.8–92.9% [arXiv:2404.06474]。評估器被接到兩處：當 Reflexion 的獎勵，以及當 filtered BC 的資料篩選器 [arXiv:2404.06474]。在 Android 的 96 題評估上，AutoUI-base 原本解出 15 題，filtered BC 後是 26.0 ± 0.8 題，不篩選的 self-training 是 18.9 ± 1.0 題 [arXiv:2404.06474]。它和數學那條線的差別之一，是評估器不需要手寫判定，所以能用在沒有 benchmark 的 iOS 上；WebArena 與 AitW 那兩處則仍有 oracle 或人工判定可以對照 [arXiv:2404.06474]。但多數實驗做的是軌跡層級評估，WebArena 與 AitW 的一致率、WebArena 的 Reflexion 都只餵最後一張截圖加動作字串 [arXiv:2404.06474]。逐步評估用在 iOS 與 Android 的 filtered BC，準確度卻只在 iOS 隨機抽的 50 個 state-action pair 上人工檢查過，其中 43 個一致 [arXiv:2404.06474]。
- **2025 年 2 月，AgentPRM：把 rollout 步驟標籤搬進 agent 環境。** 數學推理的轉移確定且已知；agent 的動作會改變外部環境，轉移未知又隨機，結果獎勵只在終點給 [arXiv:2502.10325]。它直接把 PRM 定義成回合層級 MDP 上的 Q^π(s,a)：同一任務重複 roll out，把經過同一個 (s,a) 的軌跡折扣報酬取平均當軟標籤；策略以 online DPO 更新，推論時每回合抽 N 個候選、執行 PRM 分數最高的那一個 [arXiv:2502.10325]。另一個變體 InversePRM 只用專家示範，把 IRL 的判別器直接參數化成 Q [arXiv:2502.10325]。ALFWorld 上，Llama-3.2-3B 從 π0 的 64.9 升到 π3 的 88.1，BoN(π3,Q2) 是 91.0 [arXiv:2502.10325]。PRM 只用 10k 條 rollout 訓練時，約 400 步後成功率由 82% 掉到 70%，驗證集上的 process reward 卻一路上升 [arXiv:2502.10325]。精讀時發現兩件事：PRM 從沒被直接當步驟評估器驗證過；雜湊鍵是完整歷史加上候選動作清單，重訪的狀態很少，所以大部分 Q̂ 其實只是單條軌跡的折扣結果 [arXiv:2502.10325]。
- **2025 年 4 月，AgentRewardBench：回頭量「評軌跡的評估器」。** LLM judge 已被拿來過濾 rejection finetuning 的資料、當 RL 的 reward，但既有工作多半只用下游效能間接驗證 judge，或只拿規則式評估當對照 [arXiv:2504.08942]。它讓 4 個 agent 在 5 個基準上跑出 1302 條軌跡，由 6 位專家逐條標成功、副作用、重複循環三題 [arXiv:2504.08942]。受測的 12 個 judge 裡包括 Pan et al. 的 AER，由作者改用 GPT-4o 重新實作 [arXiv:2504.08942]。沒有任何 judge 的整體成功 precision 超過 70%，最高是 GPT-4o (A) 的 69.8；重做的 AER-C、AER-V 是 67.7、67.6；規則式的 precision 83.8，recall 只有 55.9 [arXiv:2504.08942]。副作用這一題的最佳 precision 只有 14.1 [arXiv:2504.08942]。精讀時發現，它只有軌跡層級的標籤，沒有步驟層級標註，無法拿來評 process reward model 或出錯步驟的定位 [arXiv:2504.08942]。

**兩次同形的批評。** Qwen 批評「只用 BoN 間接評 PRM」，AgentRewardBench 批評「只用下游效能間接評 judge」；兩者形狀相同，只是一個在數學的步驟層級，一個在網頁 agent 的軌跡層級（本章比對）[arXiv:2501.07301][arXiv:2504.08942]。

**「步驟分數」至少有六種語意。** 名字都叫 process reward、step-level evaluation 或 progress，量的卻不是同一件事（本章歸納）。前五種出自本章計入的論文，第六種出自 T8 的筆記：

- **到此步為止是否仍正確。** Uesato 的人工首錯標註 [arXiv:2211.14275]。
- **人工三值標籤。** Lightman 的 positive／negative／neutral；精讀時指出 neutral 的定義在 §2.4 與 Appendix D 前後不一 [arXiv:2305.20050]。
- **續寫下能否到達正解的價值。** Math-Shepherd、OmegaPRM 的 MC 標籤，Qwen 稱之為 value；AgentPRM 更直接把 PRM 定義成 Q^π [arXiv:2312.08935][arXiv:2406.06592][arXiv:2501.07301][arXiv:2502.10325]。
- **prover 下成功機率的變化。** Setlur 的 advantage [arXiv:2410.08146]。
- **LM 讀前後畫面後判定的進度。** Pan 的三類逐步標籤 [arXiv:2404.06474]。
- **預先標好的中間子目標或關鍵節點是否已達成。** 兩篇的做法：
  - **AgentBoard 的 progress rate。** 把目標拆成人工標註的子目標，用 regex 比對必要觀測，或用狀態相似度函式打分，每一步取到目前為止的最高值 [arXiv:2401.13178]。它的效度驗證是 4 位作者對每個任務 60 條軌跡打整體進度分，8 個任務的 Pearson 都超過 0.95；打的是整條軌跡的進度，不是逐步標籤，而且精讀時指出評分者就是標子目標的作者 [arXiv:2401.13178]。
  - **WebCanvas 的 key node。** 人工標出任何成功路徑都必經的中間狀態，以 URL 或元素比對判定是否到達 [arXiv:2406.12373]。它自己量到，104 題中只有 46 題的最後一個 key node 足以代表任務完成 [arXiv:2406.12373]。

  這一種和前五種的差別，是分數由規則比對事先標好的中間狀態，不是由模型學出來或由續寫估出來。代價是每一題都要人工標子目標，而且要把有多條路徑的題目改寫成單一路徑：AgentBoard 在 ScienceWorld 改了 36 題（40%）[arXiv:2401.13178]。

六種語意之間只有零星的兩兩比較：Math-Shepherd 比了自動標籤與 PRM800K 人工標籤，Setlur 比了 advantage 與 Q^π，Qwen 比了 MC、判官與人工三種標註，而這些比較都混了其他變因（見〈爭議、矛盾與反證〉）[arXiv:2312.08935][arXiv:2410.08146][arXiv:2501.07301]。依本調研讀過的筆記，子目標型的分數沒有和 PRM 或 Q 值型的步驟分數在同一批軌跡上比過 [arXiv:2401.13178][arXiv:2406.12373][arXiv:2502.10325]。

**評審對人工的另一組讀數。** T7 的 Agent-as-a-Judge 讓一個會讀工作區與軌跡的 agent，依階層式需求逐條判定開發型 agent 有沒有達成 [arXiv:2410.10934]。它與人類共識的一致率是 83.88–92.07%，同樣輸入的 LLM-as-a-Judge 是 60.38–84.15% [arXiv:2410.10934]。它和 Pan、AgentRewardBench 一樣在量「自動評審對人工準不準」，但判的是 DevAI 上的需求項目，指標是一致率而不是 precision [arXiv:2410.10934][arXiv:2404.06474][arXiv:2504.08942]。作者自己也指出需求判定是類別不平衡的任務，達成的需求少時，一律判未達成也能拿到高一致率 [arXiv:2410.10934]。所以三組數字不能直接比較，只能說三篇都量了，量法不同（本章比對）。

### 軌跡分析、失敗分類與歸因（7 篇）

本小節七篇落在 2024 年 12 月到 2025 年 9 月 [arXiv:2412.06559][arXiv:2503.13657][arXiv:2505.00212][arXiv:2505.08638][arXiv:2506.18824][arXiv:2509.03312][arXiv:2509.25370]。七篇面對三個問題：錯誤要標在哪個粒度、由誰來標，以及「錯誤」本身怎麼定義 [arXiv:2412.06559][arXiv:2505.00212][arXiv:2509.25370]。

- **粒度。** 整條軌跡的多標籤 [arXiv:2503.13657]、最早錯誤步 [arXiv:2412.06559]、agent 加步驟 [arXiv:2505.00212][arXiv:2509.03312]、span 加類別 [arXiv:2505.08638]、相鄰兩步的語意關係 [arXiv:2506.18824]、步驟加模組加類型 [arXiv:2509.25370]。
- **標註者。** 專家共識 [arXiv:2412.06559][arXiv:2505.00212]、LLM judge [arXiv:2503.13657]，以及反事實重放加故障注入 [arXiv:2509.03312]。

七篇裡的 ProcessBench 是單輪數學題，所以在 agent 軌跡上做失敗歸因的實際是另外六篇 [arXiv:2412.06559][arXiv:2503.13657][arXiv:2505.00212][arXiv:2505.08638][arXiv:2506.18824][arXiv:2509.03312][arXiv:2509.25370]。另有一篇 T3 的論文也在 agent 軌跡上做了自動失敗分類：SWE-agent 以 GPT-4o 把 SWE-bench Lite 上 248 條未解軌跡分成 9 類，在 15 題驗證集上與作者的人工標註一致率 87% [arXiv:2405.15793]。精讀時指出，分類器拿 gold patch 當參考，類別也是看過軌跡後才定義的，所以只能事後使用 [arXiv:2405.15793]。

論文自己點名的承接關係只有幾條：Who&When 把 ProcessBench 列為步驟層級人工標註的前例 [arXiv:2505.00212]；TRAIL 點名 MAST 以解析成純文字的軌跡為主 [arXiv:2505.08638]；AgenTracer 點名 Who&When 的準確率太低、人工標註集太小 [arXiv:2509.03312]；AgentDebug 把 MAST 與 Who&When 歸為多停在列舉錯誤類型的前作 [arXiv:2509.25370]。SWE 軌跡研究的全文沒有提到這些論文，是軟體工程這一支平行發展出來的（本章以全文搜尋確認）[arXiv:2506.18824]。它在相關工作裡列了 SWE-Agent，但只當成程式修復 agent 的例子，沒有和 SWE-agent 的失敗分類對照（本章以全文搜尋確認）[arXiv:2506.18824]。

**2024 年 12 月：ProcessBench 在數學題上定出「最早錯誤步」協定。** 既有基準題目太簡單、只標最終答案，而 PRM 過去多透過 Best-of-N 間接評估，結果受生成模型左右 [arXiv:2412.06559]。它要受測者輸出最早錯誤步的索引、全對則輸出 -1；只問最早的錯，是因為之後的步驟建立在錯的前提上，對錯難以界定 [arXiv:2412.06559]。評分把錯誤樣本的索引命中率與正確樣本答 -1 的比率取調和平均當 F1；資料是 12 個開源生成器的自然解，依最終答案對錯平衡抽樣，共 3,400 筆，3 位博士級數學背景的標註者一致才定標 [arXiv:2412.06559]。結果有三點：

- **答案對、過程錯隨難度上升。** 最終答案正確、過程卻被專家判為有錯的比例，GSM8K 3.5%、MATH 18.8%、OlympiadBench 32.2%、Omni-MATH 51.8% [arXiv:2412.06559]。
- **現有開源 PRM 在難題上退步。** Skywork-PRM-7B 從 GSM8K 的 70.8 掉到 Omni-MATH 的 21.0，RLHFlow-PRM-Mistral-8B 從 50.4 掉到 15.8；Math-Shepherd-PRM-7B 的平均 F1 只有 31.5；只在人工標註的 PRM800K 上微調的 PRM 是 56.5 [arXiv:2412.06559]。作者把問題歸到以 Math-Shepherd 為代表的 MC 式合成資料，但論文沒有交代 Skywork 的兩個 PRM 怎麼訓練，只有 Math-Shepherd 與 RLHFlow 那兩個 PRM 寫明走 MC 式做法 [arXiv:2412.06559]。精讀時指出，這個歸因只是推論：各 PRM 的底模、資料量與步驟切法都不同，沒有控制實驗 [arXiv:2412.06559]。
- **推理型模型當 critic 最強。** QwQ-32B-Preview 平均 71.5（maj@8）、GPT-4o-0806 61.9（greedy）、o1-mini 87.9 [arXiv:2412.06559]。

這篇與上一小節的 Qwen PRM 論文出自同一團隊，後者直接拿它評 PRM [arXiv:2501.07301]。精讀時指出，資料是單輪純文字數學題，平均 5–9 步，沒有工具、環境觀測或多 agent；生成器都是非長思考的 instruct 模型，「最早錯誤」與「決定性錯誤」在這裡很少分岔 [arXiv:2412.06559]。

**2025 年 3 月：MAST 給多 agent 失敗一套詞彙。** 作者實測 7 個開源 MAS，失敗率落在 41%–86.7%，而既有 benchmark 只給總體成功率，開發者看不出系統壞在哪裡 [arXiv:2503.13657]。6 位專家用紮根理論分析 150 多條軌跡，再做 3 輪標註者一致度研究（共 15 條軌跡），定出 14 個失敗模式、3 大類：系統設計、agent 間失準、任務驗證 [arXiv:2503.13657]。定義與人工範例放進 o1 的 few-shot 提示詞，逐條軌跡輸出 14 個二元標籤；用這個 judge 標了 1642 條軌跡，公開為 MAST-Data [arXiv:2503.13657]。人工一致度 κ 0.88，judge few-shot 的 accuracy 0.94、F1 0.80、κ 0.77 [arXiv:2503.13657]。最常見的單一模式是 FM-1.3 步驟重複（15.7%）、FM-2.6 推理與行動不符（13.2%）、FM-1.5 不知道終止條件（12.4%）[arXiv:2503.13657]。精讀時指出，產出只到軌跡層級，沒有指出是第幾步、哪個 agent 出錯 [arXiv:2503.13657]。

**2025 年 5 月之一：Who&When 把「誰、哪一步」定成一個任務。** 多 agent 開發的日常，是人工讀冗長的 log、找出害任務失敗的元件；三位標註者標完 184 條軌跡共花了約 84 個工時 [arXiv:2505.00212]。它用反事實定義「關鍵錯誤」(i, t)：只要換掉 agent i 在第 t 步的動作，系統就會從失敗翻成成功，任務是找出其中最早的一個 [arXiv:2505.00212]。資料集有 126 條 algorithm-generated 軌跡與 58 條 hand-crafted 軌跡，比較 all-at-once、step-by-step、binary search 三種 zero-shot 判讀法 [arXiv:2505.00212]。agent-level 最好是 53.5%（all-at-once），step-level 最好是 14.2%（step-by-step），log 越長兩種準確率都越低 [arXiv:2505.00212]。精讀時指出，反事實定義從沒透過實際重放驗證，資料也只收失敗軌跡 [arXiv:2505.00212]。

**2025 年 5 月之二：TRAIL 把軌跡換成實務上的 OpenTelemetry span。** 它點名 MAST 這類分類法針對解析成純文字的軌跡，缺少 API 錯誤、環境設定、資源管理這類系統執行錯誤，也不對應 agent 框架實際輸出的結構化 span [arXiv:2505.08638]。它定出推理、規劃協調、系統執行三大類約 20 個葉節點，人工逐 span 標註 148 條軌跡，每個錯誤標出類別、span id、證據與影響程度，再把整份原始 JSON 交給長上下文 LLM 要它輸出同樣格式的清單 [arXiv:2505.08638]。最好的 Gemini-2.5-Pro，聯合準確率在 GAIA 分割是 0.183、SWE 分割是 0.050；o1、o3、Claude-3.7-Sonnet 因上下文不足，跑不了 SWE 分割 [arXiv:2505.08638]。

**2025 年 6 月：SWE 軌跡研究不找單一錯誤，改比成功與失敗的行為分布。** 不同框架的日誌格式各異，沒有共同的動作詞彙 [arXiv:2506.18824]。它把 RepairAgent、AutoCodeRover、OpenHands 的日誌統一成 (thought, action, result) 三元組，抽樣 120 條軌跡、2,822 次迭代，用 8 類動作與 4-gram 探勘比較序列，並對約 14K 對相鄰元件做 18 個語意關係標籤的開放編碼 [arXiv:2506.18824]。失敗組連續重複同一動作的比例較高：RepairAgent 6.1% 對 13.6%、AutoCodeRover 0.0% 對 8.8% [arXiv:2506.18824]。精讀時指出，論文沒有做顯著性檢定，每個 agent 的成功組只有約 10 條軌跡 [arXiv:2506.18824]。作者歸納出三個除錯反模式：重複動作卻不處理結果、連續修補卻不測試、沒有適當的測試驗證就結束 [arXiv:2506.18824]。精讀時指出，它只做分布層級的比較，沒有替每條失敗軌跡標出決定性錯誤步 [arXiv:2506.18824]。

**2025 年 9 月之一：AgenTracer 自動產生歸因標籤，再訓練專用歸因器。** 它沿用 Who&When 的反事實定義，改用程式近似，標籤有兩種來源 [arXiv:2509.03312]：

- **反事實重放。** 對失敗軌跡，由看得到 ground truth 的 DeepSeek-R1 逐步提出局部修正、重跑，翻成成功的那一步就是標籤 [arXiv:2509.03312]。
- **故障注入。** 在成功軌跡的某一步植入錯誤，系統因此失敗，錯誤位置就是構造時已知的標籤 [arXiv:2509.03312]。

它從 4,655 條軌跡中標出 2,476 條，用 GRPO 加多粒度獎勵把 Qwen3-8B 訓練成 AgenTracer-8B [arXiv:2509.03312]。Who&When handcraft 的 step-level 是 20.68／20.68（有 GT／無 GT），automated 是 42.86／37.30 [arXiv:2509.03312]。程式驗證從全文 Table 1 逐格解析後證實（`verify/04-agentracer-table1.py`），八格中有六格是表中最高；automated 無 GT 的兩格不是：agent-level 63.73 低於 DeepSeek-R1 的 65.08，step-level 37.30 低於 Claude-Sonnet-4 的 38.83 [arXiv:2509.03312]。精讀筆記寫成兩個子集、兩個層級都最高，說過頭了 [arXiv:2509.03312]。精讀時指出，自動標籤沒有經過人工驗證，重放缺少「原樣重跑」的對照，權重也沒有釋出 [arXiv:2509.03312]。

**2025 年 9 月之二：AgentDebug 做單 agent 的模組化根因，並從關鍵步重跑。** 它認為 self-reflection、ToT、Best-of-N 把步驟當成彼此獨立，不處理錯誤的級聯 [arXiv:2509.25370]。它把每步切成 memory、reflection、planning、action 四個模組，另設 system 類，共 17 類錯誤；200 條失敗軌跡由 10 名研究生標註 [arXiv:2509.25370]。偵錯時由 GPT-4.1 逐步逐模組標錯、挑出最早的關鍵錯，再從該步帶著修正指引重跑，最多 5 輪 [arXiv:2509.25370]。平均 Step／Step+Module／All Correct 是 45.0／31.3／24.3，Direct Prompting 是 28.0／10.0／0.3 [arXiv:2509.25370]。ALFWorld 上 GPT-4o-mini 從 21 升到 55，論文沒有標單位與評估集大小 [arXiv:2509.25370]。

### 三條線在哪裡交會、在哪裡斷開

**「最早錯誤步」的形狀一路傳下來，但明說的承接只有一處。** Uesato 的人工協定只標第一個重大錯誤 [arXiv:2211.14275]；Lightman 的 PRM 只監督到第一個錯誤步 [arXiv:2305.20050]；ProcessBench 要受測者輸出最早錯誤步 [arXiv:2412.06559]；Who&When 找最早的關鍵錯誤 [arXiv:2505.00212]；AgentDebug 找修正後就可能成功的最早根因 [arXiv:2509.25370]。這五處形狀相同，但只有 Who&When 明說 ProcessBench 是前例 [arXiv:2505.00212]。ProcessBench 的全文沒有提到 Uesato（本章以全文搜尋確認）[arXiv:2412.06559]。

**合成那條線缺的步驟信用分派，是 process reward 那條線在做的事，但兩邊在 agent 上還沒接好。** 形狀上，ETO 的步驟層級對比就是只取一條 rollout 的 MC 估計（本章比對）[arXiv:2403.02502]。數學那邊每個前綴取的續寫數是：Math-Shepherd N=8、OmegaPRM k=8、Setlur n_mc=20 [arXiv:2312.08935][arXiv:2406.06592][arXiv:2410.08146]。AgentPRM 把 MC 式的 Q 搬進 ALFWorld，但精讀時發現它的 Q̂ 多半退化成單條軌跡的估計 [arXiv:2502.10325]。在本調研讀過的論文裡，以 rollout 估計的 Q 值訓練出獨立的步驟評分模型、再接上 agent 的訓練與推論的，只有 AgentPRM 這一篇 [arXiv:2502.10325]。下面四篇也把步驟層級的訊號接上 agent，但四篇都沒有以步驟標籤訓練評分模型：ETO 以單次 rollout 的最終報酬直接當步驟層級 DPO 的偏好標籤，Pan 用 LM 的逐步進度判定篩 filtered BC 的訓練資料，UI-TARS 以人工標出的錯誤步組成 DPO 的偏好對，LATS 則在推論期讓 LLM 替樹節點打分、再以終局 reward 回傳的平均值挑分支 [arXiv:2403.02502][arXiv:2404.06474][arXiv:2501.12326][arXiv:2310.04406]。AgenTracer 倒是以重放與故障注入得到的 (agent, step) 標籤訓練出一個模型，但它輸出的是失敗出在哪個 agent 的哪一步，拿來當回饋注入下一輪，不是替每一步打分 [arXiv:2509.03312]。對話那一側另有兩篇接近的做法，也不符合上一句的條件：一篇以想像的對話做離線 RL，用 ILQL 以 Bellman 目標學 Q 值、解碼時依 Q 重新加權；CollabLLM 以使用者模擬器往後模擬幾輪，即時算出每一輪回應的獎勵，當 DPO 的偏好或 PPO 的獎勵，這個獎勵不是訓練出來的評分模型 [arXiv:2311.05584][arXiv:2502.00640]。ETO 的步驟對比也不能讀成「失敗」：lr 1e-6、β 0.1 時 WebShop 是 8.3，lr 1e-7、β 0.5 時是 62.8，與 SFT 的 63.1 相近，但低於軌跡層級的 67.4 [arXiv:2403.02502]。它和 AgentPRM 的用法也不同（前者做步驟層級 DPO，後者拿 Q 替候選排序），所以無法據此判斷單次 rollout 的步驟估計到底堪不堪用（本章判斷）[arXiv:2403.02502][arXiv:2502.10325]。這一段的「只有 AgentPRM」只在語料內成立，可以檢驗它的兩篇候補本章沒有讀，見〈已知缺口與未讀〉。

**agent 軌跡上已有步驟層級的人工真值，但本調研讀過的論文裡沒有一篇拿來評 PRM 式的步驟分數。** 只看 process reward 那條線，AgentPRM 有 agent 步驟分數卻沒有逐步真值，Pan 的逐步進度判定只在 iOS 的 50 個 state-action pair 上做過人工比對，AgentRewardBench 有專家真值卻只到軌跡層級，Qwen 有步驟真值卻只有數學 [arXiv:2502.10325][arXiv:2404.06474][arXiv:2504.08942][arXiv:2501.07301]。放到整章來看，Who&When（184 條）、TRAIL（148 條）與 AgentDebug（200 條）都在 agent 軌跡上有步驟或 span 層級的人工標籤 [arXiv:2505.00212][arXiv:2505.08638][arXiv:2509.25370]。依本章二十四份筆記，沒有一篇拿這些標籤去評 PRM 或 Q 值型的步驟分數（本章比對）[arXiv:2505.00212][arXiv:2505.08638][arXiv:2509.25370][arXiv:2502.10325]。而且 Who&When 與 AgentDebug 只收失敗軌跡，拿來評步驟分數時，會少掉 ProcessBench 那種「全對就答 -1」的另一半 [arXiv:2505.00212][arXiv:2509.25370][arXiv:2412.06559]。這句話只在語料內成立：調研時間窗之後有一篇「ToolPRMBench: Evaluating and Advancing Process Reward Models for Tool-using Agents（arXiv 2601.12294，未讀）」，依標題，它研究的正是工具型 agent 上 PRM 的評估，可以直接檢驗這一句。

**合成時當標籤來源的 LLM 評審，正是 AgentRewardBench 量的那種東西。** AgentTrek 的 GPT-4o 評估器在 558 筆人工金標準上與人工一致 84.0% [arXiv:2412.09605]。OS-Genesis 的 TRM 在 100 條軌跡上與人工評分的 Spearman 是 0.813／0.798 [arXiv:2412.19723]。Pan 的評估器被拿來當 filtered BC 的篩選器 [arXiv:2404.06474]。AgentRewardBench 以專家標註量這類 judge，最好的 precision 是 69.8，重做的 AER-C 是 67.7 [arXiv:2504.08942]。一致率、相關係數與 precision 是不同的量，數字不能直接對比（本章比對）[arXiv:2412.09605][arXiv:2412.19723][arXiv:2504.08942]。還有一層：Pan 在 WebArena 上拿手寫的規則式 oracle 當基準，而 AgentRewardBench 量到規則式評估的 recall 只有 55.9，所以對規則式 oracle 的一致率，也繼承了規則式漏判的成功軌跡（本章推論）[arXiv:2404.06474][arXiv:2504.08942]。

## 方法比較

三張表依子領域拆開；每張表的列依 arXiv 編號的時間排序。表中數字都是各論文自報，打折的理由放在下一節。

### 軌跡的格式、收集與合成

先把八篇在三條軸上的位置並列：

| 論文 | 軌跡由誰產生 | 成敗訊號 | 失敗軌跡的去向 | 出處 |
| --- | --- | --- | --- | --- |
| ReAct | 人寫 few-shot 範例；PaLM-540B 提示產生微調資料 | 最終答案 EM | 丟掉 | [arXiv:2210.03629] |
| FireAct | GPT-4 few-shot（ReAct／CoT／Reflexion） | 最終答案答對（EM 或其他標準未明寫） | 丟掉 | [arXiv:2310.05915] |
| AgentTuning | GPT-4 在 6 個環境 rollout（Mind2Web 部分改用 GPT-3.5） | 環境最終 reward | 丟掉 | [arXiv:2310.12823] |
| ETO | 專家軌跡（人工、GPT-4、啟發式搜尋）加上 agent 自己探索 | 同一指令下兩條軌跡的最終報酬比大小 | 當 DPO 的負例 | [arXiv:2403.02502] |
| Agent-FLAN | 沿用 AgentInstruct 與 ToolBench；負樣本由 gpt-3.5-turbo 產生 | 只做格式與 FinalAnswer 過濾 | 未處理 | [arXiv:2403.12881] |
| AgentTrek | GPT-4o 照網路教學重放 | GPT-4o 評估器二元判定 | 丟掉 | [arXiv:2412.09605] |
| OS-Genesis | 規則式遍歷＋GPT-4o 反推任務並執行 | GPT-4o TRM 1–5 分 | 按分數降權抽樣，不丟 | [arXiv:2412.19723] |
| SWE-Gym | gpt-4o、claude-3.5-sonnet 教師與微調後的 policy | 單元測試 | 與成功軌跡等量訓練 ORM | [arXiv:2412.21139] |

方法本身的比較：

| 方法 | 核心機制 | 需要的資料或監督 | 評估在哪 | 關鍵數字 | 出處 |
| --- | --- | --- | --- | --- | --- |
| ReAct | Thought／Action／Observation 交錯的文字軌跡（密集與稀疏兩種）；同一格式兼作 few-shot 範例、自產微調資料與人工失敗分類對象 | 每任務 1 到 6 條人寫軌跡；微調資料由 PaLM-540B 自產、答案 EM 正確的 3,000 條 | HotpotQA（EM）、FEVER（Acc）、ALFWorld（134 個未見過的遊戲）、WebShop（500 條測試指令） | HotpotQA EM 27.4（CoT 29.4）；ALFWorld 成功率最佳 71、平均 57（Act 最佳 45）；WebShop score／SR 66.6／40.0；失敗軌跡中 hallucination CoT 56%、ReAct 0% | [arXiv:2210.03629] |
| FireAct | GPT-4 產生多方法軌跡，只留答對的，統一成 ReAct 格式後 SFT；推論時不給 few-shot 範例 | 500 條 GPT-4 ReAct 成功軌跡（另有 187 條 CoT、47 條 Reflexion）；多任務版總計 2,470 條 | HotpotQA dev 隨機 500 題、Bamboogle 125 題、StrategyQA、MMLU | Llama-2-7B 14.8→26.2、GPT-3.5 31.4→39.2（GPT-4 ReAct 42.0）；搜尋回 None 時 EM 下降 ReAct −33.8%、FireAct −14.2% | [arXiv:2310.05915] |
| AgentTuning | 軌跡記成多輪對話加最終 reward；只留 r=1；與 ShareGPT 以 η=0.2 混合 SFT | 35,341 條指令篩出 1,866 條 GPT-4 軌跡（5.29%）；OS／DB 由 GPT-4 self-instruct 出題並附參考解與評估腳本 | 6 個 held-in（AgentBench）、6 個 held-out、4 個一般能力基準；分數對受評模型平均正規化 | held-out Overall 70B 0.51→1.40（GPT-3.5 1.49）；7B 只用一般資料 0.64、混合 0.67；agent only 7B held-out 0.09 | [arXiv:2310.12823] |
| ETO | 專家軌跡 SFT 後探索；同一指令的專家（勝）與 agent 失敗（敗）軌跡配對做軌跡層級 DPO，迭代 | 每條訓練指令都要一條專家軌跡；環境最終報酬 | WebShop（測試 200）、ScienceWorld（seen 194、unseen 241）、ALFWorld（seen 140、unseen 134） | WebShop 63.1→67.4（GPT-4 63.2）；ScienceWorld-Unseen 53.0→65.0，成功率只從 73.5 到 78.2；步驟層級對比 8.3（lr 1e-6、β 0.1），lr 1e-7、β 0.5 時 62.8；無專家時 ETO 12.5 | [arXiv:2403.02502] |
| Agent-FLAN | ReAct 軌跡改寫成多輪聊天、逐輪標能力並重新配比、加入「何時不該用工具」的負樣本 | AgentInstruct 1,836 條加 ToolBench 22,867 條；761 筆 query 造負樣本；ShareGPT 1:1 混合 | HotpotQA、SciWorld、WebArena、T-Eval、自建 Agent-H（1,845 筆） | held-out Overall 41.7 對 AgentTuning* 38.2；訓練 token 37.3M→18.1M；H_Score 89.1（無負樣本 84.5） | [arXiv:2403.12881] |
| AgentTrek | 網路教學標準化成任務規格，GPT-4o 在真實瀏覽器照教學重放，GPT-4o 評估器過濾 | RedPajama 語料；GPT-4o 重放與評估；不需人工示範 | WebArena、ScreenSpot Web 子集、Multimodal-Mind2Web | 10,398 條軌跡、每條約 0.551 美元；Qwen2.5-7B WebArena 3.80→10.46；評估器與人工一致率 84.0% | [arXiv:2412.09605] |
| OS-Genesis | 無任務遍歷收集三元組，GPT-4o 反推低階與高階指令後執行；TRM 1–5 分當抽樣權重 | GPT-4o 負責遍歷時的輸入、反推、執行與評分；主實驗 1K 條軌跡 | AndroidWorld（實跑 112 題）、AndroidControl（High／Low）、WebArena（241 次） | AndroidWorld SR（Qwen2-VL-7B）：OS-Genesis 17.41、TD 6.25、SI 9.82；TRM 與人工 Spearman 0.813／0.798 | [arXiv:2412.19723] |
| SWE-Gym | 可執行的 repo 層級環境，單元測試自動標記成敗；成功軌跡 SFT，成敗平衡後訓練軌跡層級 ORM 做 Best@k | 2,438 題（約 200 小時人工設定環境）；491 條教師成功軌跡；ORM 用 2,636 條 | SWE-Bench Lite（300）、SWE-Bench Verified（500） | 32B Verified 7.0%→20.6%；Best@16 32.0%（Pass@16 42.8%）；on-policy 混訓 Lite 15.3%→8.7% | [arXiv:2412.21139] |

軌跡本身的格式在八篇裡都不是研究對象，而是訓練配方的附帶決定；下表只把各篇寫明的部分並列，「未說明」表示論文沒寫（依各篇精讀筆記）：

| 論文 | 序列化的形狀 | 環境觀測放在哪 | loss 算在哪些 token | thought 從哪來 | 出處 |
| --- | --- | --- | --- | --- | --- |
| ReAct | 純文字「Thought／Action／Observation」編號交錯；知識任務每步都有 thought，ALFWorld、WebShop 把 thought 包成一個 think 動作 | Observation 行 | 未說明 | 人寫 few-shot 範例；微調資料由 PaLM-540B 自產 | [arXiv:2210.03629] |
| FireAct | 同 ReAct 的純文字；CoT 轉成單輪、Reflexion 轉成中途插入反思的長軌跡 | Observation 行；finish 之後是固定的 reward 訊息 | 附錄 A.7 比較了遮與不遮觀測 loss；精讀筆記由 Table 13 推得主實驗不遮 | GPT-4 few-shot 產生 | [arXiv:2310.05915] |
| AgentTuning | 照 Vicuna 標準化成多輪 chatbot 格式（human／gpt 兩個角色） | 使用者回合 | 只算模型回合（Thought＋Action） | GPT-4 rollout；原本沒有 thought 的軌跡由 GPT-4 事後補寫 | [arXiv:2310.12823] |
| ETO | ReAct 的 Thought＋Action 視為一個動作，和指令、觀測串成一段序列 | 序列中動作之間 | 只算 agent 動作；指令與觀測遮蔽 | ScienceWorld 的專家 CoT 由 GPT-4 事後補寫；其他環境原文未明說 | [arXiv:2403.02502] |
| Agent-FLAN | ReAct 攤平成多輪 user／assistant 聊天，Thought、工具名、參數各成一輪 assistant；另保留約一成原 ReAct 格式 | 改寫後的聊天輪 | 只算 assistant 輪；公開資料逐輪帶布林 loss 欄位 | 沿用 AgentInstruct 與 ToolBench 的軌跡 | [arXiv:2403.12881] |
| AgentTrek | 四層：任務規格、截圖或錄影、Playwright 原生 trace、後處理成「任務 metadata＋觀測＋推理＋動作」 | 文字 agent 用 AXTree，視覺 agent 只用截圖；動作由 Playwright 映射到 pyautogui | 未說明 | GPT-4o 重放時寫下的推理 | [arXiv:2412.09605] |
| OS-Genesis | 高階指令、低階指令、狀態（截圖＋a11ytree）、動作四件套 | 狀態當輸入條件 | 兩個訓練目標只預測低階指令與動作 | GPT-4o 反推的低階指令兼作逐步敘述 | [arXiv:2412.19723] |
| SWE-Gym | OpenHands 的多輪訊息，觀測與動作交錯 | 題目、指令輸出與錯誤訊息都算觀測 | 未說明 | gpt-4o 與 claude-3.5-sonnet 在同一個 OpenHands scaffold 下產生 | [arXiv:2412.21139] |

這張表看得出三件事（本章比對）。第一，loss 算在哪些 token，只有 AgentTuning、ETO、Agent-FLAN、OS-Genesis 四篇寫明，其中 OS-Genesis 不是描述遮罩，而是寫出兩個只預測低階指令與動作的訓練目標；ReAct、AgentTrek、SWE-Gym 沒寫，FireAct 則兩種都試過 [arXiv:2310.12823][arXiv:2403.02502][arXiv:2403.12881][arXiv:2412.19723][arXiv:2210.03629][arXiv:2412.09605][arXiv:2412.21139][arXiv:2310.05915]。第二，AgentTuning 與 ETO 有一部分 thought 是動作決定之後由 GPT-4 補寫的 [arXiv:2310.12823][arXiv:2403.02502]；精讀時指出，ETO 的 ScienceWorld 專家 CoT 因此與動作的因果方向相反 [arXiv:2403.02502]，AgentTuning 補寫的那部分也是同一種情形（本章推論）。第三，八篇都沒有真人或使用者模擬器的回合；AgentTuning 的「使用者回合」裝的是環境回饋 [arXiv:2310.12823]，Agent-FLAN 的多輪對話精讀時也指出只是把 agent 與環境的互動改寫成聊天 [arXiv:2403.12881]。精讀時發現，AgentTrek 公開的資料只有一個文字模態的 JSON 檔，四層 schema 的後三層無法由公開資料驗證 [arXiv:2412.09605]。分析那一側另有兩種格式：TRAIL 用 OpenTelemetry span 樹，SWE 軌跡研究把三個框架的日誌統一成 (thought, action, result) 三元組 [arXiv:2505.08638][arXiv:2506.18824]。在本調研讀過的論文裡，沒有一篇比較不同軌跡格式之間的轉換損失，見〈已知缺口與未讀〉。

### 軌跡／步驟層級評估與 process reward

| 方法 | 核心機制 | 需要的資料或監督 | 評估在哪 | 關鍵數字 | 出處 |
| --- | --- | --- | --- | --- | --- |
| Uesato et al. 的 ORM／PRM（process 對 outcome） | 70B LM 在每步後預測 correct／incorrect token；ORM 每步標籤等於整條解的最終答案對錯，PRM 標籤是「到此步為止的前綴是否全對」；RM-weighted decoding 重排；expert iteration 分別以最終答案、ORM、PRM 為獎勵 | GSM8K 7118 題訓練；PRM 用人工首錯標註（1560 份樣本、530 題、9856 個步驟標籤）；ORM 用 policy 自己的樣本（每題 K=96）加最終答案比對 | GSM8K 測試集 1319 題；MATH pre-algebra 633 題（OOD） | 最終答案錯誤率 Final-Answer RL 對 SFT：多數決 23.5% 對 22.3%、ORM 重排 16.6% 對 14.8%；SFT+PRM reranking trace 3.5%、final 14.1%；SFT+ORM-RL final 12.7%、trace 3.4%；ORM 對 PRM 標籤一致率 85% 對 77% | [arXiv:2211.14275] |
| PRM800K（Lightman et al.） | GPT-4 base 微調成逐步分類器，在每步結尾預測 positive／negative／neutral，只監督到第一個錯誤步；解答分數為各步 positive 機率連乘；主動學習挑「高分錯答」送標 | 約 80 萬個人工步驟標籤（75K 解答、12K 題），標註者拿到正確最終答案、不拿參考解；ORM 用每題 100 個均勻樣本加最終答案比對 | MATH 500 題子集（best-of-N，N 最高 1860）；AP Calculus／Chemistry／Physics 與 AMC10/12（best-of-100） | best-of-1860：PRM 78.2%、ORM 72.4%、多數決 69.6%；主動學習資料效率約 2.6 倍；OOD 合計 72.9%／63.8%／61.3% | [arXiv:2305.20050] |
| Math-Shepherd | 固定前綴到第 i 步，由 completer 補完 N 條，任一條答對即標正（HE）；在 ки 位置以兩個特殊 token 做逐步二元分類；best-of-N 取各步最小值；逐步 PPO 在每步結尾給 PRM 分數 | 只需題目與標準答案，零人工步驟標註；LLemma-7B completer、N=8；約 170k（GSM8K）加 270k（MATH）個解 | GSM8K 與 MATH500（best-of-256）；MATH 全測試集（RL）；匈牙利高中數學期末考 33 題（OOD）；160 步人工集（量標籤品質） | LLaMA2-70B：GSM8K 93.2（ORM 91.8、SC 88.0）、MATH500 44.5（ORM 40.4、SC 39.4）；Mistral-7B 逐步 PPO：GSM8K 77.9→84.1、MATH 28.6→33.0（ORM-PPO 81.8／31.3）；HE 對人工標註 86%（LLaMA2-70B completer、N=4） | [arXiv:2312.08935] |
| Agent-Eval-Refine（Pan et al.） | VLM／LM 讀軌跡（指令、動作字串、截圖），輸出整條軌跡的 1／0 或逐步的進度標籤；GPT-4V 端到端，或 captioner 轉描述後由 Mixtral／GPT-4 推理；當 Reflexion 的獎勵與 filtered BC 的篩選器 | 評估器不需手寫測試案例；captioner 用 1,263 筆截圖加詳細描述微調；多數實驗只餵最後一張截圖加動作字串 | WebArena（對手寫 oracle）；AitW 抽 120 題（對人工判定）；自建 iOS 52 題測試；Android 96 題評估 | 一致率 WebArena 74.4–82.1%、AitW 89.8–92.9%；Reflexion 相對成功率 +16%（Captioner + Mixtral）、+29%（GPT-4V）；Android filtered BC 26.0 ± 0.8 題、self-training 18.9 ± 1.0 題；逐步評估 50 對中 43 對與人工一致 | [arXiv:2404.06474] |
| OmegaPRM | k=8 rollout 的 MC 估計加二分搜尋定位第一個錯誤步；rollout 存成樹，用 Q 加 PUCT 挑下一條；以 MC 值為 soft label | 題目與 golden answer；能從任意前綴續寫的 policy；不需人工步驟標籤 | MATH500、GSM8K 上的 PRM 加權多數決（k=64）；規模未說明的自建步驟分類集 | Gemini Pro／MATH500：69.4，多數決 67.2、PRM800K 67.6；同算力下 15M 對 200K 筆；soft／hard／pairwise 分類準確率 70.1／63.3／64.2 | [arXiv:2406.06592] |
| PAV（Setlur et al.） | 步驟獎勵為 prover μ 下的 advantage，A^μ = Q^μ(s_h,a_h) − Q^μ(s_{h−1},a_{h−1})；有效獎勵 Q^π + α·A^μ 同時用在 beam search 選步與線上 RL；BoK(π) 的 Q 以 1 − (1 − Q^π)^K 換算 | 只需最終答案比對（Rex）；seed rollout 加每個前綴 n_mc=20 次續寫的蒙地卡羅 Q 標籤、first-pit 取樣；每個基礎策略超過 30 萬筆（前綴, Q̂） | MATH（Gemma 2B／9B／27B SFT 基礎策略）；教學用合成任務 | 達 ORM best-of-128 準確率所需計算：2B、9B 省 10×，27B 省 5×（摘要寫 1.5–5×）；相對 Q^π beam search 省 8×；PAV-RL 比 ORM-RL 高 >7%，2B 快 6× | [arXiv:2410.08146] |
| Qwen2.5-Math-PRM（共識過濾） | MC 估計與 LLM 判官對第一錯誤步位置一致才保留；hard label、門檻 0；BoN 時步驟分數連乘 | 題目與標準答案；每步 8 次續寫；Qwen2.5-72B-Instruct 判官 | 7 個數學基準的 Best-of-8（prm@8）；ProcessBench 四子集 | ProcessBench 平均 F1：PRM-7B 73.5、PRM-72B 78.3、o1-mini 87.9；Best-of-8：PRM-7B 67.6 對 maj@8 66.2；Best-of-64：PRM-7B 56.1 對 maj@64 56.3 | [arXiv:2501.07301] |
| AgentPRM／InversePRM | PRM 等於回合層級的 Q^π；經過同一 (s,a) 的 rollout 折扣報酬平均成軟標籤；online DPO，KL 錨在上一輪策略；InversePRM 以專家轉移對學習者轉移做二元分類 | 可重置、可大量平行 roll out 的環境與結果獎勵（AgentPRM），或專家示範（InversePRM） | ALFWorld OOD 評估局的任務成功率與動作數 | π0 64.9 → π3 88.1，BoN(π3,Q2) 91.0；InversePRM π1 82.8；10k rollout 時成功率由 82% 掉到 70% | [arXiv:2502.10325] |
| AgentRewardBench（簡化 judge） | 以專家對成功、副作用、重複循環的標註為真值，評各種 judge；簡化 judge 只讀動作、agent 推理與最後一步觀測 | 1302 條網頁 agent 軌跡與 3906 個專家二元標註 | WebArena、VisualWebArena、AssistantBench、WorkArena、WorkArena++ 的軌跡；各維度的 P／R／F1 | 成功 precision 最高 69.8（GPT-4o (A)）；AER-C 67.7、AER-V 67.6；規則式 P 83.8、R 55.9；副作用 precision 最高 14.1 | [arXiv:2504.08942] |

### 軌跡分析、失敗分類與歸因

| 方法 | 核心機制 | 需要的資料或監督 | 評估在哪 | 關鍵數字 | 出處 |
| --- | --- | --- | --- | --- | --- |
| ProcessBench | 輸出最早錯誤步索引或 -1；錯誤樣本命中率與正確樣本答 -1 率取調和平均當 F1；同一協定同時評 PRM（逐步判分，取第一個判錯的步）與 critic（提示詞逐段審查） | 3,400 筆專家標註（博士級數學背景，3 人一致才定標，丟棄約 30%）；12 個生成器的自然解，依最終答案對錯平衡抽樣 | ProcessBench 四子集：GSM8K 400 筆，MATH、OlympiadBench、Omni-MATH 各 1,000 筆 | 自訓 PRM800K 模型平均 F1 56.5；Skywork-PRM-7B 42.1；Math-Shepherd-PRM-7B 31.5；QwQ-32B-Preview 71.5（maj@8）；GPT-4o-0806 61.9（greedy）；o1-mini 87.9 | [arXiv:2412.06559] |
| MAST | 紮根理論從軌跡歸納 14 個失敗模式、3 大類；o1 few-shot judge 對整條軌跡輸出 14 個二元標籤 | 6 位專家分析 150 多條軌跡；3 輪 IAA 共 15 條；judge 的 few-shot 範例取自人工標註；任務成敗由人工或 benchmark 判定 | 7 個 MAS × ProgramDev、SWE-Bench Lite、GSM-Plus、GAIA 等，共 1642 條（MAST-Data） | 人工 κ 0.88；judge accuracy 0.94、F1 0.80、κ 0.77；新系統上人對人 κ 0.79；平均每條 1.8 美元 | [arXiv:2503.13657] |
| Who&When | 反事實定義最早關鍵錯誤 (i*, t*)；all-at-once、step-by-step、binary search 三種 zero-shot LLM 判讀，另有 hybrid | 184 條失敗軌跡，由三位專家三輪共識標註負責 agent、步驟與理由（約 84 工時）；沒有實際重放 | Who&When：126 條 algorithm-generated（GAIA、AssistantBench）＋58 條 hand-crafted（Magentic-One） | agent-level 最佳 53.5%（all-at-once）；step-level 最佳 14.2%（step-by-step）；hybrid 在 hand-crafted 的 step 12.28、149,177 tokens | [arXiv:2505.00212] |
| TRAIL | OpenTelemetry／OpenInference span 樹＋三大類約 20 個葉節點的分類法；整份原始 JSON 交給 LLM，輸出逐錯誤的類別、span id 與四項 rubric 分數 | 4 位標註者逐 span 標類別、位置、證據、影響，另有四輪複核；不查證軌跡以外的資訊 | GAIA 分割（o3-mini 的 OpenDeepResearch）＋SWE-Bench Lite 分割（claude-3-7-sonnet 的 CodeAct），共 148 條、841 個錯誤 | 最佳 Gemini-2.5-Pro：GAIA Cat F1 0.389／Loc 0.546／Joint 0.183；SWE 0.148／0.238／0.050 | [arXiv:2505.08638] |
| SWE 軌跡研究 | 異質日誌統一成 (thought, action, result)；8 類動作＋4-gram；相鄰元件 18 個語意關係標籤；比較成功組與失敗組 | 三個 agent 原始評估留下的日誌，不重跑；約 14K 對主要由第一作者標註五個月；成功標籤沿用原評估 | RepairAgent（Defects4J）、AutoCodeRover v1 與 OpenHands（SWE-bench Lite），共 120 條、2,822 次迭代 | Repetition（成功對失敗）：RepairAgent 6.1% 對 13.6%、OpenHands 0.5% 對 3.8%、AutoCodeRover 0.0% 對 8.8%；Misalignment 在 RepairAgent 反向（2.3% 對 1.3%） | [arXiv:2506.18824] |
| AgenTracer | 反事實重放＋故障注入自動產生 (agent, step) 標籤；Qwen3-8B 以 GRPO 訓練，獎勵是格式閘門乘上 agent 對錯與 step 距離 Gaussian 的加權 | 可自動判定成敗的 ground truth 與可重跑的系統；DeepSeek-R1 同時當分析者與擾動者；沒有人工標註 | Who&When 兩子集（分布外）；TracerTraj 保留測試集（同分布，147／63／56 條）；下游 GAIA、HumanEval+、MATH-500 | Who&When handcraft agent 69.10／63.82、step 20.68／20.68；automated step 42.86／37.30；TracerTraj-math step 57.63 | [arXiv:2509.03312] |
| AgentDebug | 每步切成四個模組逐一標錯；LLM 以全域視角挑最早的關鍵錯並產生修正指引；從 t* 帶指引重跑，最多 5 輪 | 作者結構化 rollout 提示詞產生的軌跡；200 條由 10 名研究生標註步驟、模組、類型與根因（κ 0.55）；偵錯器用 GPT-4.1；重跑需要可重設的環境與成功判定 | AgentErrorBench（ALFWorld 100、WebShop 50、GAIA 50）；下游 ALFWorld、WebShop、GAIA 成功率 | Step／Step+Module／All：45.0／31.3／24.3（Direct Prompting 28.0／10.0／0.3，Brute Force 12.0／4.3／0.0）；ALFWorld GPT-4o-mini 21→55 | [arXiv:2509.25370] |

## 評估方式與關鍵數字

**三個子領域各量什麼。**

- **合成那條線** 量的是用軌跡訓練出來的 agent 在下游 benchmark 上的成績：HotpotQA 的 EM、AgentBench 的正規化 Overall、WebShop 與 ScienceWorld 的平均報酬、AndroidWorld 與 WebArena 的成功率、SWE-Bench 的解題率 [arXiv:2210.03629][arXiv:2310.12823][arXiv:2403.02502][arXiv:2412.19723][arXiv:2412.21139]。軌跡本身的品質，例如評估器與人工的一致率、TRM 與人工評分的相關，只是附帶量測 [arXiv:2412.09605][arXiv:2412.19723]。
- **process reward 那條線** 的主要量法，是 best-of-N 或加權多數決之後的最終答案正確率 [arXiv:2305.20050][arXiv:2312.08935][arXiv:2406.06592][arXiv:2410.08146]。直接量步驟判斷的只有 Uesato 的 trace error、Qwen 採用的 ProcessBench F1、Pan 在 iOS 50 個 state-action pair 上的人工比對，以及 AgentRewardBench 在軌跡層級的 precision／recall [arXiv:2211.14275][arXiv:2501.07301][arXiv:2404.06474][arXiv:2504.08942]。
- **失敗歸因那條線** 的共同尺，是步驟索引完全命中的 step-level accuracy 與負責者的 agent-level accuracy；另有 ±k 容忍度、span 層級的 Location／Joint Accuracy、多標籤 F1、Cohen's κ，以及介入後的下游成功率 [arXiv:2412.06559][arXiv:2505.00212][arXiv:2505.08638][arXiv:2503.13657][arXiv:2509.25370][arXiv:2509.03312]。

**頭條數字與打折後的讀法。** 下表把各篇最常被引用的數字，與精讀或本章找到的打折理由並列。標「精讀時」的出自精讀筆記的 limitations_observed，是精讀 agent 自己的分析（含它依公開資料重算的結果），沒有經過同儕審查；標「本章」的是撰寫本章時自己的比對、換算或判斷，尚未有人複核；其中寫明「程式驗證」的，已由 `verify/04-*.py` 從快取全文或筆記重算（見〈程式驗證〉）。

| 論文 | 頭條數字 | 打折後的讀法 | 出處 |
| --- | --- | --- | --- |
| ReAct | ALFWorld 成功率 71 | 在同樣 134 個評估遊戲上從 6 組提示挑出的最佳值，平均是 57（精讀時發現） | [arXiv:2210.03629] |
| ETO | ScienceWorld-Unseen 平均報酬 53.0→65.0 | 成功率只從 73.5 升到 78.2；平均報酬含子目標的部分分數 | [arXiv:2403.02502] |
| Agent-FLAN | held-out Overall 41.7 對 38.2 | Overall 含只有它針對性訓練過的自建 Agent-H；扣掉後四項平均是 29.8 對 26.7（精讀時重算） | [arXiv:2403.12881] |
| OmegaPRM | MATH500 從 51 到 69.4 | 51 是在完整 MATH test 上量的；67.2 − 51 = 16.2 點來自多數決，PRM 只貢獻 69.4 − 67.2 = 2.2 點（精讀時發現） | [arXiv:2406.06592] |
| Qwen2.5-Math-PRM | Best-of-8 PRM-7B 67.6 對 maj@8 66.2 | Best-of-64 時 PRM-7B 56.1 低於 maj@64 的 56.3（精讀時發現） | [arXiv:2501.07301] |
| Pan et al. | WebArena 評估器一致率 74.4–82.1% | 被評的是 WebArena 釋出的 GPT-4 軌跡，WebArena 原報這個 agent 的成功率 14.41% [arXiv:2307.13854]，Pan 自己重現為 15.6%；若軌跡集的成功率落在這兩者之間，永遠回答「失敗」就有 100 − 15.6 = 84.4 到 100 − 14.4 = 85.6（%），高於評估器（精讀時指出） | [arXiv:2404.06474][arXiv:2307.13854] |
| AgentPRM | 3B 模型 88.1，勝過 ReAct gpt-4o | π0 純 SFT 已是 64.9，與 ReAct gpt-4o 的 65.7 持平；PRM 的貢獻是 88.1 − 64.9 = 23.2 點（精讀時發現） | [arXiv:2502.10325] |
| ProcessBench | QwQ-32B-Preview 平均 71.5，與 GPT-4o 相當 | 71.5 是 maj@8；greedy 下平均 (70.9+56.3+34.6+34.6)/4 ≈ 49.1，低於 GPT-4o greedy 的 61.9（精讀時指出） | [arXiv:2412.06559] |
| Who&When | step-level 最佳 14.2%（step-by-step 四格平均） | 在 algorithm-generated 子集，一律猜第 1 步就有 34/126 ≈ 26.98% 的 step-level，高於 Table 1 在該子集的最佳值（step-by-step 有 GT 的 25.51）（精讀時依公開標註重算）；但程式驗證發現 Table 1 三種方法在該子集的百分比沒有一格能寫成 k/126，兩邊的分母未必相同，這個比較無法由論文數字確認 | [arXiv:2505.00212] |
| TRAIL | Joint Accuracy 最佳 0.183／0.050 | 官方腳本的分母是金標集合，本質是 recall，多列 span 不扣分（精讀時從官方腳本讀出；本地沒有官方腳本，程式驗證無法判定） | [arXiv:2505.08638] |
| AgenTracer | Who&When handcraft step-level 20.68 | 約是 12/58，與 Claude-Sonnet-4 的 17.24／18.97 只差 1–2 條軌跡（精讀時反推；程式驗證證實 20.68 是 12/58 捨去到兩位小數） | [arXiv:2509.03312] |
| AgentDebug | 摘要的「24%」「17%」 | 其實是百分點差：24.3 − 0.3 = 24.0、45.0 − 28.0 = 17.0 | [arXiv:2509.25370] |
| AgentTrek | 評估器與人工一致率 84.0% | 判準寬鬆（超過 8 個正確動作就算成功、沒按送出也算成功），輸入只有文字、沒有截圖（精讀時發現） | [arXiv:2412.09605] |
| AgentRewardBench | 副作用 GPT-4o (A) recall 91.7 | precision 只有 7.7；以精讀推算、程式驗證證實的分母 72 換算，約判出 91.7% × 72 ÷ 7.7% ≈ 857 條有副作用（本章推算） | [arXiv:2504.08942] |

以下依陷阱的種類整理；同一類陷阱出現在不同子領域時放在一起。

**best-of-N 的最終答案正確率，被當成步驟評分器的品質。**

- **量到的是重排效果。** Lightman、Math-Shepherd、OmegaPRM、Setlur 的主要數字都是同一種量法：用 RM 從 N 個候選中挑一個或加權投票，再看最終答案對不對 [arXiv:2305.20050][arXiv:2312.08935][arXiv:2406.06592][arXiv:2410.08146]。這量的是重排效果，不是找出錯步的能力；精讀時指出，Lightman 沒有在保留的人工步驟標籤上回報 PRM 找出第一個錯誤步的 precision 或 recall [arXiv:2305.20050]。
- **落差有直接證據。** ProcessBench 量到 Math-Shepherd-PRM-7B 找最早錯誤步的平均 F1 只有 31.5 [arXiv:2412.06559]。Qwen 的三種標註資料在 ProcessBench 與 BoN 上的排序大致相反，因為 policy 常產出「答案對、過程錯」的回應，放過它們的 PRM 在 BoN 上不吃虧 [arXiv:2501.07301]。
- **增益多半來自投票。** OmegaPRM 在四組 policy × 資料集上，比多數決只多 2.2／3.5／0.9／1.6 點，比 PRM800K 多 1.8／1.0／0.7／0.5 點；程式驗證從全文 Table 1 逐格相減證實 [arXiv:2406.06592]。AgentPRM 的 BoN 從 π3 到 BoN(π3,Q2) 是 91.0 − 88.1 = 2.9 點，精讀時換算只差 4 局 [arXiv:2502.10325]。
- **Lightman、Math-Shepherd、OmegaPRM、Setlur 與 Uesato 當中，只有 Uesato 把人工判定的步驟錯誤當成模型評估指標（trace error）（本章比對）。** 但每個模型只評 200 題，評估集的 Cohen's κ 只有 0.34 [arXiv:2211.14275]。精讀時指出，Table 1 的區間大幅重疊，例如 SFT+ORM-RL 3.4%（0.0–6.8）與 SFT+PRM reranking 3.5%（0.5–6.5），PRM 與 ORM 的高下無法判定 [arXiv:2211.14275]。trace error 又只在各模型自己答對的樣本上計算，分母因模型而異（精讀時指出）[arXiv:2211.14275]。

**只有失敗軌跡，或只量一類錯誤。**

- **失敗歸因的評估集只有失敗軌跡。** Who&When、AgenTracer、AgentDebug 都是如此 [arXiv:2505.00212][arXiv:2509.03312][arXiv:2509.25370]。Who&When 的 Without-GT 提示詞還告訴 judge 這是錯的解答，所以誤報率從沒被量過（精讀時指出）[arXiv:2505.00212]。
- **TRAIL 的定位指標只算 recall。** 論文本文沒有寫出 Location 與 Joint Accuracy 的公式，程式掃描快取全文證實了這一點 [arXiv:2505.08638]。精讀時從官方腳本讀出，分母是金標集合，預測多列 span 不扣分，列出所有 span id 理論上就能拿到 Location Accuracy 1.0；本地沒有官方腳本，這一半程式驗證無法判定 [arXiv:2505.08638]。o3 在 GAIA 的 Loc 0.535 對 Joint 0.092，精讀時指出這分不出是「位置對、類別錯」還是大量撒網 [arXiv:2505.08638]。
- **ProcessBench 是反例。** 它把錯誤樣本與正確樣本分開計算再取調和平均，任一類偏低都會拉下 F1 [arXiv:2412.06559]。例如 Qwen2.5-Math-7B-Instruct 在 GSM8K 的兩類是 15.5 與 100.0，F1 為 2×15.5×100/(15.5+100) ≈ 26.8 [arXiv:2412.06559]。
- **不平衡資料上的 accuracy 會被多數類撐高。** Pan 的 WebArena 一致率可能低於永遠答「失敗」的基線（見上表，精讀時指出）[arXiv:2404.06474]。本章再推一步：accuracy 等於 π·TPR + (1 − π)·TNR，準確率 A 低於 1 − π 時，失敗軌跡被判成成功的比例至少是 1 − A／(1 − π)；以 π 取 WebArena 原報的 GPT-4 成功率 14.41%（四捨五入成 14.4%）[arXiv:2307.13854] 代入，GPT-4V 至少 1 − 0.806/(1 − 0.144) = 5.8%，Captioner + Mixtral 至少 1 − 0.744/(1 − 0.144) = 13.1% [arXiv:2404.06474]。這組下界只在該軌跡集的成功率確實約為 14.4% 時成立 [arXiv:2404.06474]。
- **MAST judge 的 accuracy 大半來自負例。** 精讀時指出，在 14 個稀疏的二元標籤上，accuracy 0.94 主要由負例撐起 [arXiv:2503.13657]。本章在「accuracy、recall、precision 都對全部格子做 micro 計算」的前提下（論文沒寫明），取 judge 的 recall 0.77、precision 0.833 [arXiv:2503.13657]，反推正例率約 (1−0.94)/((1−0.77)+0.77×(1/0.833−1)) ≈ 0.156；在這個正例率下，一律答「沒出現」的判讀器 accuracy 也有 1−(1−0.94)/((1−0.77)+0.77×(1/0.833−1)) ≈ 0.844 [arXiv:2503.13657]。
- **AgentRewardBench 只比 precision，等於在不同的操作點上比。** 各 judge 輸出的都是二元標籤，論文沒有機率、PR 曲線或校準分析；規則式 precision 83.8 最高卻被論文認定不足，這本身就說明單看 precision 排不出好壞（精讀時發現）[arXiv:2504.08942]。精讀時推算、程式驗證證實：副作用 recall 都能寫成 k/72，測試集中只有約 72 條（72/1106 ≈ 6.51%）被標為有副作用，GPT-4o mini (A) 的 precision 7.2 幾乎等於這個基率，最佳的 Claude 3.7 (S) 也只有 14.1 [arXiv:2504.08942]。程式驗證還發現，72 不只是最小的相容分母：加上 precision 與 F1 的約束、要求預測筆數不超過測試集之後，72 是唯一解，Table 8 五個基準的最小分母加總 3 + 28 + 21 + 2 + 18 = 72 也對得上 [arXiv:2504.08942]。

**「命中」的寬窄各篇不同。**

- **完全比對與訓練獎勵不一致。** ProcessBench 與 Who&When 的 step-level 都要求索引完全相等 [arXiv:2412.06559][arXiv:2505.00212]。AgenTracer 評估也用完全比對，但訓練獎勵是 σ = 1 的 Gaussian，差一步仍得約 0.61 分（精讀時指出兩者不一致）[arXiv:2509.03312]。TRAIL 一律取錯誤第一次出現的 span，唯獨 Resource Abuse 取最後一次 [arXiv:2505.08638]。
- **放寬容忍度就改寫排名。** Who&When hand-crafted 上，±1 時 step-by-step 最高（14.66），±5 時 all-at-once 以 43.10 反超 [arXiv:2505.00212]。精讀時依公開資料算出，均勻隨機在 ±2、±3、±5 分別是 16.05、21.77、31.70，所以 step-by-step 在 ±3 的 18.10 其實低於隨機，而論文的容忍度實驗沒有隨機對照 [arXiv:2505.00212]。
- **評分腳本用子字串比對。** 精讀時發現，Who&When 的公開腳本用子字串比對：真值 4 時，預測 14 或 24 都算命中；hand-crafted 有 28 條標籤是個位數，step-level 可能被高估，但無法確認論文數字是否出自這支腳本 [arXiv:2505.00212]。

**彙總與正規化方式會改變頭條。**

- **AgentTuning 的 Overall 依受評模型集合而定。** 它先把每個任務的分數除以本次所有受評模型的平均，再加權平均；精讀筆記指出換一組受評模型分數就會變 [arXiv:2310.12823]。
- **Who&When 的摘要數字來自兩種方法、四格不加權平均。** (54.33+55.17+51.12+53.44)/4 ≈ 53.5 是 all-at-once 的 agent-level，(25.51+7.02+15.31+8.77)/4 ≈ 14.2 是 step-by-step 的 step-level（精讀時指出）[arXiv:2505.00212]。
- **TRAIL 的摘要 11%。** 接近兩個分割聯合準確率的簡單平均 (0.183+0.050)/2 ≈ 0.1165；依軌跡數加權則是 (118×0.183+30×0.050)/148 ≈ 0.156（精讀時算出）[arXiv:2505.08638]。
- **Qwen 的 Table 5 用算術平均。** 「答案對、過程錯」子集的四個子集分別有 7／94／161／259 題，Avg. 欄是四者的算術平均，所以 GSM8K 子集每題佔 100 ÷ 7 ≈ 14.3 分 [arXiv:2501.07301]。本章改以 7 + 94 + 161 + 259 = 521 題合併計算：Skywork-PRM-7B 與 EurusPRM-Stage2 從算術平均的 27.8 對 27.4，變成 (57.1 × 7 + 26.6 × 94 + 14.3 × 161 + 13.1 × 259) ÷ (7 + 94 + 161 + 259) ≈ 16.5 對 (42.9 × 7 + 27.7 × 94 + 18.0 × 161 + 20.8 × 259) ÷ (7 + 94 + 161 + 259) ≈ 21.5，排名對調 [arXiv:2501.07301]。程式驗證從全文 Table 5 解析後證實：Avg. 欄在 11 列都等於四個子集的算術平均，11 × 4 = 44 格都能寫成「命中題數 ÷ 子集題數」；11 個 PRM 兩兩配成 11 × 10 ÷ 2 = 55 組，兩種彙總下排名相反的有 5 組：4 組牽涉 Skywork 的兩個 PRM（3 組是對 EurusPRM，1 組是兩者互比），另一組是 RLHFlow 的兩個 PRM [arXiv:2501.07301]。合併正確率只是另一種彙總，不是正解；要點是排序隨彙總方式改變 [arXiv:2501.07301]。
- **MAST 的整體比重偏向程式任務與弱模型。** 1642 條中有 700 條是 ProgramDev-v2 的程式任務，CodeLlama-7b 在兩個框架上每 100 條分別出現 97 與 99 次 FM-1.3（精讀時指出）[arXiv:2503.13657]。
- **SWE 軌跡研究的比例偏向失敗軌跡。** Table II 把所有元件對合併才算百分比，而失敗軌跡比較長（RepairAgent 平均 40 步對 22 步）；精讀時指出，Repetition 偏高也可能只是預算耗盡前原地打轉的結果 [arXiv:2506.18824]。

**基線太弱，或根本沒定義。**

- **Who&When 只和 random 比。** 精讀時依公開標註重算：hand-crafted 一律猜 WebSurfer，agent-level 在現行版本是 33/58 ≈ 56.9%，照論文當時的標籤是 31/58 ≈ 53.4%，與 all-at-once 的 55.17／53.44 相當 [arXiv:2505.00212]。這兩個計數要讀資料集才能驗，程式驗證無法判定（見〈程式驗證〉）[arXiv:2505.00212]。精讀時也加了但書：多數類基準用到測試集的標籤分佈，量的是「只靠先驗能拿幾分」，不是可部署的方法 [arXiv:2505.00212]。
- **Who&When 的 Random 列本身有疑點。** 精讀時算出 alg-gen 的均勻隨機 step-level 是 12.0，Table 1 卻寫 19.06，而「all-at-once 的 step-level 低於 random」的結論就建立在這一格上 [arXiv:2505.00212]。
- **其他論文的比較對象。** AgenTracer 的基線全部只用 all-at-once 提示詞，沒有其他經訓練的歸因器 [arXiv:2509.03312]。TRAIL 沒有切塊、逐 span 掃描或有工具裁判的對照組（精讀時指出）[arXiv:2505.08638]。MAST 的 judge 沒有和其他分類法或自動標註方法比較 [arXiv:2503.13657]。

**標籤的一致度：有的沒報，有的報錯了對象。**

- **人工標註。** MAST 的人對人 κ 0.88 只來自 3 輪、共 15 條軌跡；§3.4 的 0.79 是新系統上的人對人一致度，不是 judge 對人（精讀時指出）[arXiv:2503.13657]。AgentDebug 的 κ 0.55，作者稱為 substantial，依 Landis–Koch 慣例屬於 moderate（精讀時指出）[arXiv:2509.25370]。TRAIL 拿複核後被改動的 span 比例（5.31%、5.63%）當一致性證據，那不是兩位標註者各自獨立標註後的一致度（精讀時指出）[arXiv:2505.08638]。Who&When 只報不確定比例 15–30%，沒有 κ [arXiv:2505.00212]。SWE 軌跡研究約 14K 對元件主要由一人標註 [arXiv:2506.18824]。Uesato 評估集的 κ 只有 0.34 [arXiv:2211.14275]。Math-Shepherd 的 160 步人工集沒有交代標註者、準則與一致性（精讀時指出）[arXiv:2312.08935]。AgentRewardBench 的雙標一致率 89.3% 只量在一個 agent × 一個基準的子集上（精讀時發現）[arXiv:2504.08942]。
- **LLM 給的標籤。** OS-Genesis 的 TRM 與人工的 Spearman 在 1–5 分的粗刻度上很高，但精讀時發現，TRM 只看執行器自己寫的低階指令與最後三張截圖，也沒有報標註者人數與一致度 [arXiv:2412.19723]。TRAIL 的 Security rubric 在 147 份可解析的金標裡全部是 5，常數序列的 Pearson 相關在數學上沒有定義，Table 6 卻對每個模型都報 1.00（精讀時統計）[arXiv:2505.08638]。

**樣本小到一條軌跡就值好幾個百分點。**

- **失敗歸因。** Who&When 的 hand-crafted 只有 58 條，每條約 1.7 個百分點，多模型、推理模型、hybrid、容忍度實驗都只在這 58 條上做，沒有重複執行（精讀時指出）[arXiv:2505.00212]。MAST 的 ChatDev 介入用 32 題，+9.4 與 +15.6 個百分點只是多對 3 題與 5 題（精讀時指出）[arXiv:2503.13657]。AgentDebug 的 GAIA、WebShop 各 50 條，TRAIL 的 SWE 分割約 30 條，SWE 軌跡研究每個 agent 約 10 條成功軌跡（精讀時指出）[arXiv:2509.25370][arXiv:2505.08638][arXiv:2506.18824]。
- **AgenTracer 的分母有疑點。** 精讀時發現，Table 2 的 TracerTraj-math 列中 AgenTracer 的三格都落在 59 條上（例如 35/59 ≈ 59.32%），多數基線卻落在 Table 3 所列的 63 條上（例如 29/63 ≈ 46.03%）[arXiv:2509.03312]。本章補充、程式驗證證實：Table 1 的 handcraft 欄中，Qwen3-8B 42.10、Qwen3-32B 44.80 也不是任何 k/58，而表中 3.45 與 3.44 並存、都對應 2/58，可見捨入方式不一 [arXiv:2509.03312]。程式另外發現，表中 9 個模型各有 4 格，handcraft 欄 9 × 4 = 36 格中有 9 格不是任何 k/58，包括 AgenTracer 自己 agent-level 的 69.10 與 63.82；automated 欄同樣 9 × 4 = 36 格中有 11 格不是任何 k/126 [arXiv:2509.03312]。所以「20.68 約是 12/58」這類以條數換算的讀法，只對能寫成 k/58 的格子成立 [arXiv:2509.03312]。
- **process reward。** Lightman 的測試集只有 500 題，精讀時估算 78.2 對 72.4 約 2.1 個標準誤，OOD 各科只有 45–84 題 [arXiv:2305.20050]。Math-Shepherd 的 best-of-256 只報 3 組取樣的平均，RL 只有單一種子 [arXiv:2312.08935]。AgentPRM 134 局中 1 局約 100 ÷ 134 ≈ 0.75 點，Pick 2 類只有 17 局 [arXiv:2502.10325]。OmegaPRM 沒有重複 seed，精讀時粗估 MATH500 在約 68% 時標準誤約 ±2.1 點，對 PRM800K 的差距全在一個標準誤內 [arXiv:2406.06592]。
- **合成。** 合成那八篇裡，只有 FireAct 明確寫出每個設定的二項標準誤；SWE-Gym 的 Table 3 也有 ± 值，但沒說明怎麼算（精讀時指出）（本章比對）[arXiv:2310.05915][arXiv:2412.21139]。精讀時發現 FireAct 的 Bamboogle 標準誤是用 500 題算的，實際只有 125 題，按 125 題重算約 4.4 [arXiv:2310.05915]。OS-Genesis 的 AndroidWorld 只有 112 題、單次執行，精讀時換算 17.41% × 112 ≈ 19.5，會出現半題 [arXiv:2412.19723]。SWE-Gym 的 cap 消融各設定只差 0.4–2.0 個百分點，相當於 300 題中的 1 到 6 題（精讀時發現）[arXiv:2412.21139]。

**在評估集上挑設定（皆為精讀時發現）。**

- **合成。** ReAct 的 ALFWorld 最佳值是在評估遊戲上從 6 組提示挑出來的 [arXiv:2210.03629]；AgentTuning 的 η 依 held-out 表現挑出 [arXiv:2310.12823]；Agent-FLAN 的能力配比直接在 T-Eval 與 HotpotQA 這兩個 held-out 集上挑 [arXiv:2403.12881]；ETO 的迭代輪數與 β 正好落在各資料集曲線的最佳點 [arXiv:2403.02502]；SWE-Gym 的 verifier 設定與 capping 門檻都在 SWE-Bench 上比過才定 [arXiv:2412.21139]。
- **process reward。** Uesato 的 expert iteration 依測試集的最終答案錯誤率挑最佳模型，而 RL 在 SFT＋ORM 重排之上的增益只有 14.8 − 12.7 = 2.1 個百分點，偏誤可能和增益同量級 [arXiv:2211.14275]。
- **失敗歸因。** ProcessBench 中 Skywork PRM 的二值化門檻，是在 GSM8K 測試子集上挑 F1 最高的值 [arXiv:2412.06559]。

**解碼預算與格式失敗混進排行榜。**

- **ProcessBench 的預算不對等。** 開源 critic 用 maj@8、GPT-4o 用 greedy、o1-mini 只取樣一次；PRM 對每條解法只做一次前向判分，critic 則取樣 8 次、每次最多 8192 token（精讀時指出）[arXiv:2412.06559]。
- **格式失敗被算成判斷失敗。** ProcessBench 的 Qwen2.5-Coder-7B-Instruct 在 greedy 下，GSM8K 的錯誤樣本 0.0、正確樣本 20.2，精讀時推測是 \boxed{} 解析失敗 [arXiv:2412.06559]。AgenTracer 表中，本身就是標註者的 DeepSeek-R1 在 code 子集只有 agent 11.81、step 10.23，精讀時推測也是輸出解析失敗 [arXiv:2509.03312]。TRAIL 的公開腳本把超出上下文或無法解析的軌跡直接跳過、不計入分母（精讀時指出）[arXiv:2505.08638]。
- **Best@k 的曲線混了溫度。** SWE-Gym 的第一條 rollout 用溫度 0、之後用 0.5，精讀筆記指出「Best@k 大致對 log k 線性」的斜率因此包含溫度改變的效果 [arXiv:2412.21139]。

**「沒看過」的定義與汙染。**

- **AgentTuning。** held-out 的 MiniWoB++、WebArena 和訓練中的 WebShop、Mind2Web 同屬網頁操作；汙染分析只對 held-in 做，WebShop 200 題中有 196 題落在 20–80% 的灰色地帶（精讀時發現）[arXiv:2310.12823]。
- **AgentTrek 與 OS-Genesis。** AgentTrek 稱 WebArena 為 OOD，但重放範例畫面正是 WebArena 購物後台所用的 Magento Admin Panel；OS-Genesis 就在 AndroidWorld 與 WebArena 的 app 與網站上探索，真正 OOD 的只有 AndroidControl（皆為精讀時發現）[arXiv:2412.09605][arXiv:2412.19723]。
- **Pan 的 captioner。** 訓練資料含 AitW 訓練集與 iOS 截圖，AitW 與 iOS 上的評估不是零樣本（精讀時指出）[arXiv:2404.06474]。
- **Qwen 與 ProcessBench。** 精讀時指出三件事：ProcessBench 由同一團隊發表；判官提示詞「找到第一個錯就停」與 ProcessBench 的協定同形；最終資料只留下與判官一致的樣本 [arXiv:2501.07301]。
- **SWE-Gym 在設計上避開重疊。** 它的 11 個 repo 與 SWE-Bench 刻意不重疊，是合成那八篇中唯一在設計階段就處理汙染的一篇（本章的判斷）[arXiv:2412.21139]。

**「重複迴圈」至少有四種量法。** 這是三個子領域都碰到、卻各量各的一種異常（本章比對）：

- **規則。** AgentTuning 的 harness 把模型連續三次輸出相同內容判為失敗；SWE-Gym 的 Stuck in Loop 定義成連續三次輸出同一動作 [arXiv:2310.12823][arXiv:2412.21139]。精讀時發現，換個參數的近似迴圈或來回振盪都抓不到 [arXiv:2412.21139]。
- **失敗分類的一格。** ReAct 把它併進 reasoning error，沒有單獨量化 [arXiv:2210.03629]；MAST 的 FM-1.3 步驟重複佔 15.7%，是最常見的單一模式 [arXiv:2503.13657]。
- **分布比較。** SWE 軌跡研究的 Repetition 在失敗組較高，但沒有顯著性檢定，每個 agent 的成功組只有約 10 條（精讀時指出）[arXiv:2506.18824]。
- **judge 的旗標。** AgentRewardBench 的重複循環 precision 在 78.6–92.3 之間 [arXiv:2504.08942]。

四種量法的定義不同、資料也不同，在本調研讀過的論文裡找不到任何一篇拿兩種量法比對同一批軌跡 [arXiv:2310.12823][arXiv:2412.21139][arXiv:2503.13657][arXiv:2506.18824][arXiv:2504.08942]。

**基準在發表後改版（精讀時比對 Who&When repo 的歷史）。** 論文 v3 之後，hand-crafted 的標籤又改過；論文實驗時，有 3/58 條的步驟標籤指到 log 結尾之後，任何方法都不可能命中 [arXiv:2505.00212]。公開程式把 GT 寫死在提示詞裡，初版 hand-crafted 資料的鍵名又和程式讀取的鍵名不同，讀到的是空字串，所以照 2025-04-30 釋出的程式與資料跑，hand-crafted 的「有 GT」實際上等於沒有 GT [arXiv:2505.00212]。後續論文拿 Who&When 比較時，用的可能是不同版本的標籤 [arXiv:2505.00212]。

**時變環境與不完整的成本帳。**

- **即時查詢的環境會變。** ReAct 的 Wikipedia API、FireAct 的 SerpAPI Google 搜尋都是即時查詢，同一個提示重跑，觀測可能不同 [arXiv:2210.03629][arXiv:2310.05915]。
- **成本只算了部分環節（皆為精讀時發現）。** AgentTrek 的每條 0.551 美元不含預篩運算、9 萬筆 GPT-4o mini 標註、FastText 訓練與人工複核 [arXiv:2412.09605]。Setlur 的計算效率只計入取樣，沒有攤提約 600 萬次部分 rollout 的訓練資料成本 [arXiv:2410.08146]。Math-Shepherd 沒有量化補完標註的成本，精讀時估為千萬次級的補完解碼 [arXiv:2312.08935]。

## 程式驗證

本章有八條主張寫了程式驗證：前四條出自精讀筆記 limitations_observed，後四條大多是撰寫本章時的換算或比對，原本只標「本章」或「對照全文」；其中 AgenTracer 的 12/58，以及 OmegaPRM 比多數決、比 PRM800K 的差距，出自精讀筆記 [arXiv:2505.00212][arXiv:2505.08638][arXiv:2504.08942][arXiv:2403.12881][arXiv:2410.08146][arXiv:2501.07301][arXiv:2406.06592][arXiv:2305.20050][arXiv:2509.03312]。程式只用 Python 標準函式庫，輸入由程式直接從快取全文解析或取自筆記，沒有下載任何資料集或 repo；方法、實際輸出與重現指令見 [04-results.md](../verify/04-results.md)。

| 被驗證的主張 | 結論 | 驗證檔 | 出處 |
| --- | --- | --- | --- |
| Who&When 的 algorithm-generated 子集一律猜第 1 步，step-level 是 34/126 ≈ 26.98%，高於 Table 1 在該子集的最佳值 25.51；hand-crafted 一律猜 WebSurfer，agent-level 與 all-at-once 相當 | **無法判定。** 算術與比較都成立，但 34、33、31 這三個計數要讀 Who&When 資料集才能驗，依規則不下載。程式另外發現，Table 1 三種方法在 alg-gen 的百分比沒有一格能寫成 k/126，而 hand-crafted 的 agent-level 都落在 k/58；「與 Table 1 同子集、同條件」這個前提無法由論文數字確認 | [04-whowhen-trivial-baseline.py](../verify/04-whowhen-trivial-baseline.py) | [arXiv:2505.00212] |
| TRAIL 的 Location／Joint Accuracy 只量 recall、不罰誤報，列出所有 span id 可得 Location Accuracy 1.0；論文本文沒有定義這些指標 | **核心無法判定，「本文沒有定義」證實。** 前一半要讀並執行官方 calculate_scores.py，本地沒有，依規則不下載。後一半由掃描器確認：全文所有指標名稱的命中處附近都沒有定義句型，兩個正向對照也都成立，排除了掃描器太鈍的可能（全文保留了行內數學式、同一支掃描器抓得到 Agent-FLAN 的 H_Score 定義）。範圍限快取全文，不含 PDF 版 | [04-trail-metric-definition-scan.py](../verify/04-trail-metric-definition-scan.py) | [arXiv:2505.08638] |
| AgentRewardBench Table 7 的副作用 recall 都能寫成 k/72，測試集中只有約 72 條有副作用；GPT-4o mini (A) 的 precision 7.2 幾乎等於基率 | **證實，而且證據比原主張強。** 只看 recall 時，72 只是最小的相容分母；加上 precision 與 F1 的約束、要求預測筆數不超過 1106 之後，72 是唯一解。Table 8 五個基準的最小分母加總 3 + 28 + 21 + 2 + 18 = 72，各 judge 的命中數加總也與 Table 7 一致。基率 72/1106 ≈ 6.51%，最佳 precision 14.1 也只有基率的 14.1 ÷ (72/1106 × 100) ≈ 2.17 倍 | [04-arb-side-effect-base-rate.py](../verify/04-arb-side-effect-base-rate.py) | [arXiv:2504.08942] |
| Agent-FLAN Table 3 無負樣本那一列的 H_Score 依子指標重算應為 85.45，表中是 84.5 | **證實為單列不一致。** 兩項平均的公式算得回其他三列，列舉的其他讀法沒有一種能同時對上四列，所以不是公式讀錯。「負樣本的實際效果約 3.65 分」要以「錯的是 H_Score、子指標正確」為前提，表格本身分辨不出，這一半無法判定 | [04-agentflan-hscore.py](../verify/04-agentflan-hscore.py) | [arXiv:2403.12881] |
| AgentRewardBench Table 3：排除 Llama 3.3 沒跑的 VWA 與專家平手的一對後，14 組有嚴格順序的 agent 配對中，judge 顛倒 2 組、規則式顛倒 4 組 | **證實，另補兩組平手。** 3 + 6 + 5 = 14 組、judge 顛倒 2 組且都在 GPT-4o 對 Qwen2.5-VL、規則式顛倒 4 組，全部對上。程式另外找出 judge 在 VWA 把 Claude 3.7 Sonnet 與 Qwen2.5-VL 都判成 34.8、規則式在 VWA 把 GPT-4o 與 Qwen2.5-VL 都判成 17.4，後者正是論文說的 VWA 上兩者相等 | [04-arb-ranking-flips.py](../verify/04-arb-ranking-flips.py) | [arXiv:2504.08942] |
| Setlur 的 PAV：依 App D，兄弟步驟用有效獎勵排序和只用 Q^π 排序完全相同，「相對 Q^π beam search 省 8×」只能來自跨父狀態的 beam 名額重新分配 | **在 App D 的讀法下證實。** 程式先在全文找到 App D 的換算式、跨父狀態取前 B 名、Eq. 2 的差分形、α 取 0.5 與 0.2、K = 4 這幾個前提；α 取這兩個值、K = 4 時，窮舉的兄弟組合沒有一組排序不同，跨父狀態則找得到選出不同 beam 的例子。§4 說另外訓練一個 PAV 預測 A^μ，若實驗用的是它，這個推論就不成立，全文分不出是哪一種 | [04-pav-sibling-order.py](../verify/04-pav-sibling-order.py) | [arXiv:2410.08146] |
| 三個 PRM 表格的重算：Qwen Table 5 改成按題數合併後排名對調；OmegaPRM 比多數決與 PRM800K 的差距；Lightman OOD 的 224 對 234，以及 ORM 按題數加權的合計對不上表中的 63.8 | **三項全部證實。** Qwen 的 Avg. 欄在 11 列都是算術平均，11 × 10 ÷ 2 = 55 組 PRM 配對中有 5 組排名隨彙總方式對調。OmegaPRM 的差距逐格相減對得上。Lightman 的 ORM 能寫成 k/n 的格子用精確分數、其餘格子給 ±0.05 的捨入誤差後，四捨五入與捨去都到不了 63.8；PRM 與多數決兩欄照同樣做法，兩種捨入都對得上表中的 72.9 與 61.3，分辨不出表格用哪一種。Chemistry 的 ORM 與 AMC10/12 三格都不是「答對題數 ÷ 題數」，所以 63.8 從哪裡來無法反推 | [04-prm-table-recompute.py](../verify/04-prm-table-recompute.py) | [arXiv:2501.07301][arXiv:2406.06592][arXiv:2305.20050] |
| AgenTracer Table 1：八格中六格最高、automated 無 GT 兩格不是；Qwen3-8B 42.10 與 Qwen3-32B 44.80 不是 k/58；3.45 與 3.44 並存；20.68 約是 12/58 | **三條都證實，另有新發現。** handcraft 欄 9 × 4 = 36 格中有 9 格不是任何 k/58，包括 AgenTracer 自己的 69.10 與 63.82；automated 欄 9 × 4 = 36 格中有 11 格不是任何 k/126。子集大小 58 與 126 取自 Who&When 的筆記，並與 Who&When 全文的總數 184 對帳 | [04-agentracer-table1.py](../verify/04-agentracer-table1.py) | [arXiv:2509.03312][arXiv:2505.00212] |

正文已依這些結果改寫：AgentRewardBench 的副作用基率與 Agent-FLAN 的 H_Score 改標為「精讀時發現，程式驗證證實」；Who&When 的瑣碎基準與 TRAIL 的 recall 性質維持「精讀時」的標記，並註明程式驗證無法判定 [arXiv:2504.08942][arXiv:2403.12881][arXiv:2505.00212][arXiv:2505.08638]。後四條的結果也寫回正文：〈排名翻轉〉補上兩組平手，Setlur 那一條註明只在 App D 讀法下成立，Qwen 的彙總一條補上 55 組中 5 組對調，AgenTracer 的分母一條補上 9 格與 11 格對不上 k/n 的發現，Lightman 那一列補上「用精確分數加權時，PRM 與多數決兩欄分辨不出捨入方式」[arXiv:2504.08942][arXiv:2410.08146][arXiv:2501.07301][arXiv:2509.03312][arXiv:2305.20050]。八條都沒有被推翻 [arXiv:2505.00212][arXiv:2505.08638][arXiv:2504.08942][arXiv:2403.12881][arXiv:2410.08146][arXiv:2501.07301][arXiv:2406.06592][arXiv:2305.20050][arXiv:2509.03312]。

本章其餘標「精讀時」的主張都沒有經過程式驗證，仍是精讀 agent 自己的分析；標「本章」而沒寫「程式驗證」的換算與比對，也還沒有人複核 [arXiv:2505.00212][arXiv:2412.06559][arXiv:2503.13657]。其中需要讀公開資料集或執行官方程式碼才能驗的，例如 Who&When 評分腳本的子字串比對、容忍度實驗的均勻隨機基準，以及 TRAIL Security rubric 的常數序列，依規則不下載，所以沒有寫程式 [arXiv:2505.00212][arXiv:2505.08638]。

## 爭議、矛盾與反證

### 「錯的那一步」與「這一步值多少」沒有共同定義

這是本章最根本的分歧：三個子領域都在找「步驟層級的真值」，但各篇定義的東西不同，彼此也沒有同資料、同策略的對照（本章歸納）。

| 論文 | 步驟層級的真值或分數怎麼定義 | 真值從哪裡來 | 出處 |
| --- | --- | --- | --- |
| Uesato et al. | 到此步為止的前綴是否全對；只標第一個重大錯誤 | 人工 | [arXiv:2211.14275] |
| Lightman et al. | positive／negative／neutral 三值，只監督到第一個錯誤步 | 人工 | [arXiv:2305.20050] |
| Math-Shepherd、OmegaPRM | 從這個前綴續寫，能不能到達正解（value） | MC 續寫 | [arXiv:2312.08935][arXiv:2406.06592] |
| Setlur et al. | 在 prover 下，走這一步前後成功機率的變化（advantage） | MC 續寫 | [arXiv:2410.08146] |
| Qwen2.5-Math-PRM | 第一個錯誤步，MC 與 LLM 判官一致才算 | MC＋LLM 判官 | [arXiv:2501.07301] |
| AgentPRM | 回合層級的 Q^π(s,a) | 同一 (s,a) 的 rollout 折扣報酬 | [arXiv:2502.10325] |
| Pan et al. | 完成／朝目標前進／沒有貢獻三類 | LM 讀前後畫面判定 | [arXiv:2404.06474] |
| ProcessBench | 最早錯誤步；不區分之後被自己修正的錯與致命的錯（精讀時指出） | 專家共識 | [arXiv:2412.06559] |
| Who&When | 三種定義並存：§2 的反事實最早關鍵錯誤、§3.3 要標註者挑最嚴重的、提示詞問負責 agent 第一次犯錯（精讀時發現） | 人工，從沒實際重放 | [arXiv:2505.00212] |
| AgenTracer | 沿用反事實定義，真的重放；但公開 repo 由 R1 直接指定步驟、最多試 3 輪，「最早」沒有被強制（精讀時指出） | 反事實重放＋故障注入 | [arXiv:2509.03312] |
| AgentDebug | 修正後就可能成功的最早根因 | 人工 | [arXiv:2509.25370] |
| TRAIL | 不找決定性錯誤，窮舉每個錯誤、各標第一次出現的 span | 人工 | [arXiv:2505.08638] |
| AgentBoard（T8） | 目標拆成子目標，每一步取到目前為止達成的最高進度 | 人工標子目標，以 regex 或狀態相似度比對 | [arXiv:2401.13178] |
| WebCanvas（T8） | 任何成功路徑都必經的 key node 是否已到達 | 人工標 key node，以 URL 或元素比對 | [arXiv:2406.12373] |

幾組衝突特別值得寫出來：

- **反事實搜尋對人工標籤最差。** AgentDebug 照自己的反事實定義去搜的 Brute Force 基準，Step accuracy 只有 12.0%，低於直接提示的 28.0% [arXiv:2509.25370]。精讀時據此質疑：要嘛人工標的不是反事實意義上的關鍵步，要嘛修正動作的產生器太弱 [arXiv:2509.25370]。精讀時也發現，§3.2 正文把 Stage 2 寫成反事實測試，但 Algorithm 1、附錄提示詞與 README 都是單次 LLM 判斷 [arXiv:2509.25370]。
- **AgenTracer 用重放標籤訓練，卻在人工判斷的 Who&When 上評估。** 所以它在 Who&When 上的分數，混進了「兩種標籤定義之間的一致度」；AgentDebug 的 Brute Force 結果又暗示這兩種定義本來就不太一致（本章推論）[arXiv:2509.03312][arXiv:2505.00212][arXiv:2509.25370]。重放本身也缺「原樣重跑」的對照組，重跑後成功可能只是重新取樣剛好成功（精讀時指出）[arXiv:2509.03312]。
- **value 型分數會把「後面救不救得回來」混進「這一步對不對」。** Qwen 據此說 MC 分數是 value，不是這一步的 reward [arXiv:2501.07301]。同一個「錯了但後來被修正」的步驟，在 Math-Shepherd 的 hard estimation 下是正例，在首錯協定下是負例 [arXiv:2211.14275][arXiv:2312.08935]。依 Qwen 的區分，AgentPRM 明白定義成 Q^π 的 PRM 在概念上是 value model（本章的判斷）[arXiv:2501.07301][arXiv:2502.10325]。拿它回答「哪一步出錯」時，就會碰上同一個問題 [arXiv:2501.07301]。
- **二分搜尋的單調假設很脆弱。** OmegaPRM 要求前綴正確性單調 [arXiv:2406.06592]。精讀時推算，一個正確但困難的前綴，若 policy 從該處單次答對率約 25%，8 個 rollout 全錯的機率約 10%，第一錯誤位置就會被往前推；本章以 0.75 的 8 次方重算約 0.100 [arXiv:2406.06592]。
- **Setlur 的 advantage 證據比篇幅薄。** 作者自承，理論假設看得到每個狀態的所有動作，在那個設定下 Q 與 advantage 沒有差別，分析只用來說明 prover 的選擇 [arXiv:2410.08146]。精讀時據此指出，這套理論撐不起本文最核心的「用 advantage 而非 Q」；RL 也只和 ORM-RL 比，沒有實證比較以 Q^π-PRM 做 RL 的設定 [arXiv:2410.08146]。論文 §4.1 說另外訓練一個 PAV 預測 A^μ，App D 卻寫明 BoK 的 Q 值由同一個 Q^π 模型以 1 − (1 − Q^π)^K 換算；精讀時依 App D 的讀法指出，這組實驗裡的 A^μ 只是同一個 PRM 的輸出經非線性重塑再做差分 [arXiv:2410.08146]。本章再推一步：從同一個父狀態展開的兄弟步驟共用父項，而 q + α(1 − (1 − q)^K) 對 q 嚴格遞增，所以兄弟之間用有效獎勵排序和只用 Q^π 排序完全相同，「相對 Q^π beam search 省 8×」只能來自跨父狀態時 beam 名額的重新分配 [arXiv:2410.08146]。程式驗證在 App D 的讀法下證實（`verify/04-pav-sibling-order.py`）：α 取論文用的 0.5 與 0.2、K = 4 時，窮舉的兄弟組合沒有一組排序不同；跨父狀態時則找得到兩種打分選出不同 beam 的例子 [arXiv:2410.08146]。但若實驗實際用的是 §4 所說另外訓練的 PAV，兄弟排序就不必相同，這個推論只在 App D 的讀法下成立 [arXiv:2410.08146]。

### process 監督比 outcome 好嗎，人工標籤比自動標籤好嗎

這一節的比較範圍要先講清楚：process 對 outcome 的比較，只發生在本章計入的 PRM 那一側論文之間，比的是同一套管線裡換成 ORM 或 PRM [arXiv:2211.14275][arXiv:2305.20050][arXiv:2312.08935]。只用規則式結果獎勵做大規模 RL 的路線不在本章語料內。「DeepSeek-R1: Incentivizing Reasoning Capability in LLMs via Reinforcement Learning（arXiv 2501.12948，未讀）」依標題，研究以強化學習提升 LLM 的推理能力；AgentPRM 的筆記把它當大規模 RL 的代表，GUI-R1 的筆記把自己的做法稱為 DeepSeek-R1 式的規則獎勵強化學習 [arXiv:2502.10325][arXiv:2504.10458]。本章沒有讀它，不引用它的任何內容。語料內看得到的只有兩處側面：Setlur 引 DeepSeekMath 的結果，說自動 PRM 當 RL 的 dense reward 只比 ORM 好 1–2% [arXiv:2410.08146]；AgentPRM 在問題陳述裡說大規模 RL 在 agent 情境的樣本成本太高，這是它改做 PRM 的動機，不是兩條路線的對照實驗 [arXiv:2502.10325]。語料內最接近「結果獎勵式 RL」的 agent 論文是 T3 的 GUI-R1，它用規則式可驗證獎勵做 GRPO，但訓練的是單步動作、評估在離線基準上 [arXiv:2504.10458]。所以下面的結論只回答「PRM 那一側的論文彼此怎麼說」，不回答「process 監督是否比純結果獎勵的 RL 好」。

- **process 對 outcome：三篇的答案不一樣，而且都混了其他變因。** Uesato 的 PRM 重排與 ORM 重排是 14.1% 對 14.8%，差不多；Lightman 的 PRM 明顯勝出，78.2% 對 72.4%；Math-Shepherd 的差距在較難的 MATH 上較大，GSM8K 差 93.2 − 91.8 = 1.4，MATH500 差 44.5 − 40.4 = 4.1 [arXiv:2211.14275][arXiv:2305.20050][arXiv:2312.08935]。但 Uesato 的 PRM 從 ORM 初始化、只有 1560 份樣本，頭條比的 Few-shot+Final-Answer RL 與 SFT 也不是單變數實驗（精讀時指出）[arXiv:2211.14275]。Lightman 的大尺度 PRM 與 ORM 在標籤來源、資料分布、資料量三處都不同；精讀時還指出，PRM800K 的解答由評估時所用的同一個 generator 產生，並以它的高分錯答為目標挑選，PRM 的優勢可能有一部分是針對這個 generator 的對抗式訓練 [arXiv:2305.20050]。
- **人工對自動：OmegaPRM 與 Qwen 的答案相反。** OmegaPRM 在四組設定上都勝過 PRM800K，領先 1.8／1.0／0.7／0.5 點，據此說自動資料勝過人工 [arXiv:2406.06592]。Qwen 則顯示在 ProcessBench 上 PRM800K 的 56.5 遠勝 MC 的 40.1，只看 BoN 時 MC 反而最高 [arXiv:2501.07301]。本章的判斷是，OmegaPRM 唯一的下游比較就是加權多數決，正是 Qwen 批評的量法；精讀時也指出 PRM800K 對 Gemini／Gemma policy 是 off-policy [arXiv:2406.06592][arXiv:2501.07301]。在本調研讀過的論文裡，找不到任何一篇把 OmegaPRM 的資料放到步驟層級基準上量過 [arXiv:2406.06592][arXiv:2501.07301]。
- **Math-Shepherd 對 PRM800K 的比較也有混淆。** Uesato 顯示人工步驟標籤優於以中間數值做字串比對的啟發式標籤，最終答案錯誤率 14.1% 對 15.9% [arXiv:2211.14275]。Math-Shepherd 則主張在 MATH 上自動標註的 PRM 勝過 PRM800K 訓練的 PRM；精讀時指出，這混了分布與 4 倍的資料量，只給圖、沒給數值，而實際產生訓練資料的設定（LLemma-7B completer、N=8）在正文沒有報告標註準確率 [arXiv:2312.08935]。
- **soft 還是 hard label：方向相反，量尺不可比。** OmegaPRM 的 soft label 70.1、hard label 63.3、pairwise 64.2 [arXiv:2406.06592]。Qwen 則說經共識過濾後 hard label 明顯勝過 soft，過濾前兩者差不多 [arXiv:2501.07301]。可比的只有未過濾的 MC 標籤，此時 Qwen 說差不多、OmegaPRM 差 70.1 − 63.3 = 6.8 點，但一邊量 ProcessBench 與 BoN，一邊是規模與標註方式都沒寫、精讀時懷疑有循環的自建集（本章比對）[arXiv:2501.07301][arXiv:2406.06592]。

### 失敗或部分完成的軌跡，該丟、該降權，還是拿來對比

- **AgentTuning：不過濾就變差。** 7B 用未過濾軌跡訓練，held-in 從 1.96 降到 1.34 [arXiv:2310.12823]。但精讀時發現，論文沒交代未過濾組有幾條軌跡、有沒有同樣混 ShareGPT，而它的 held-in 1.34 與「只用 agent 資料」完全相同，這個消融混淆了資料量與模仿失敗兩個因素 [arXiv:2310.12823]。
- **OS-Genesis：保留部分完成的軌跡、按分數降權，反而較好。** 它主張 TRM 加權在高階任務上勝過不用 RM 與只留完整軌跡的 labeler，但這個比較只有 Figure 5 的相對長條，沒有數字 [arXiv:2412.19723]。
- **ETO 與 SWE-Gym：失敗軌跡當對比訊號或評審的訓練資料。** ETO 把失敗軌跡當 DPO 的負例，SWE-Gym 把失敗與成功軌跡等量拿來訓練 ORM [arXiv:2403.02502][arXiv:2412.21139]。
- **第五種做法沒有計入。** 直接以結果獎勵做線上 RL 時，失敗軌跡透過 advantage 拿到負訊號，不必丟也不必另外配對；本章計入的八篇合成論文都沒有以它為主要方法 [arXiv:2310.05915][arXiv:2403.02502][arXiv:2412.21139]。ETO 把直接以最終報酬做 RL 的 PPO 列為基線，Table 2 五欄中 PPO 只在 WebShop 高於 SFT：WebShop 64.2 對 63.1，ScienceWorld Seen／Unseen 59.4／51.7 對 67.4／53.0，ALFWorld Seen／Unseen 22.1／29.1 對 60.0／67.2；精讀時指出論文沒有任何 PPO 設定細節，無法排除是調參不足 [arXiv:2403.02502]。SWE-Gym 的作者則把 PPO 或大規模線上 RL 列為自我改進的下一步 [arXiv:2412.21139]。語料內最接近的是 GUI-R1 的 GRPO，但它是單步動作，沒有多步軌跡 [arXiv:2504.10458]。以結果獎勵做多步 agent RL 的論文本章沒有讀，見〈已知缺口與未讀〉。
- **本章的判斷。** AgentTuning 的未過濾組是 reward<1 的軌跡等權放進 SFT，OS-Genesis 的低分軌跡則是降權後仍放進 SFT；兩篇都沒有變異估計，比較條件也不對等，所以還回答不了「部分完成的軌跡放進 SFT 是好是壞」[arXiv:2310.12823][arXiv:2412.19723]。

### 觀測 token 要不要算進 loss，本調研讀到的唯一直接實驗沒有定論

AgentTuning 與 Agent-FLAN 只對 assistant 回合算 loss，ETO 把指令與環境觀測的 token 一律遮蔽 [arXiv:2310.12823][arXiv:2403.12881][arXiv:2403.02502]。ReAct 的目標寫明要解碼整條軌跡（含 observation），但沒說有沒有遮；精讀時推測，不遮等於教模型自己生成觀測，可能反而助長捏造 [arXiv:2210.03629]。在本調研讀過的論文裡，FireAct 附錄 A.7 是唯一的直接實驗，同一組設定在不同規模上方向相反：13B 的 ReAct+CoT 遮與不遮分別是 24.8 與 30.2，7B 則是 24.0 與 22.2 [arXiv:2310.05915]。FireAct 主實驗預設「不遮」，是精讀筆記從 Table 13 與 Table 2 的數字對應推出來的，論文沒有明說 [arXiv:2310.05915]。「遮觀測」在這幾篇是慣例，不是被證明過的最佳做法（本章的判斷）[arXiv:2310.12823][arXiv:2403.12881][arXiv:2403.02502][arXiv:2310.05915]。

### 用自己產生的軌跡繼續訓練，結果時好時壞

- **SWE-Gym 在 OpenHands 上退步。** 微調後的 32B 每題取樣 6 次得到 868 條成功軌跡，與 491 條教師軌跡混合後重訓，SWE-Bench Lite 從 15.3% 降到 8.7% [arXiv:2412.21139]。精讀時發現，這一輪沒有套用作者自己在 MoatlessTools 上證明有用的 per-instance capping，分不出是 on-policy 資料有害，還是資料偏向簡單題 [arXiv:2412.21139]。在 MoatlessTools 上，迭代 RFT 讓 7B 從 7.0% 到 9.0% 再到 10.0%，32B 從 19.0% 到 19.7% 就停了 [arXiv:2412.21139]。
- **ETO 前一兩輪有效，之後下降。** WebShop 與 ScienceWorld 前兩輪有提升、第三輪後下降，ALFWorld 只有第一輪有效；作者歸因於固定的專家集與訓練集造成過擬合 [arXiv:2403.02502]。沒有專家軌跡時，RFT 從 17.9 升到 48.4，單獨的 ETO 則降到 12.5；有 BC 起點時，RFT 在 WebShop 只從 63.1 升到 63.6，在 ALFWorld-Unseen 反而從 67.2 降到 66.4 [arXiv:2403.02502]。
- **ReAct 不能算自我改進的證據。** 它的 bootstrap 是 540B 教 8B／62B 的蒸餾 [arXiv:2210.03629]。
- **評估器也跟不上變強的策略。** Math-Shepherd 在 PPO 之後，PRM 單獨驗證在 MATH 上輸給 SC（41.1 對 42.3），作者解讀為初始 RM 監督不了變強的策略；精讀時指出 ORM 掉得幾乎一樣（41.3），比較像兩種 RM 都跟不上策略分布的移動 [arXiv:2312.08935]。Lightman 迭代重訓選樣器時出現無法診斷的不穩定 [arXiv:2305.20050]。Setlur 作者自承不知道怎麼為一連串策略迭代自動設計 prover，RL 中也沒能動態更新 prover [arXiv:2410.08146]。
- **驗證集上的 process reward 會騙人。** AgentPRM 的 10k rollout PRM 在驗證集上分數持續上升，真實成功率卻先升後降，用資料分割訓練的 ensemble 也一起上升、偵測不到 [arXiv:2502.10325]。Qwen 用「BoN 候選中最低步驟分數落在最後一步」的比例當 PRM 從評過程漂移成評結果的證據，精讀時指出 MC 標註本身就會讓最後一步承擔最多的負訊號，這只是相關證據 [arXiv:2501.07301]。

### 成功的軌跡也帶著「錯誤」

這是跨三個子領域都出現的現象：「答案對」不等於「過程對」，而「有缺陷」也不等於「失敗的原因」（本章歸納）。

- **合成時的 false positive。** ReAct 答對的軌跡有 6% 是推理或事實捏造 [arXiv:2210.03629]。Math-Shepherd 的作者觀察到 N 越大，hard estimation 的偽陽性越多；Lightman 也自承最終答案比對會把「答案對、推理錯」算成對 [arXiv:2312.08935][arXiv:2305.20050]。
- **專家量到的比例。** ProcessBench 在 Omni-MATH 上，最終答案正確、過程卻有錯的比例是 51.8% [arXiv:2412.06559]。Qwen 發現在「答案對、過程錯」的子集上，除了它自己的兩個模型，其他開源 PRM 的偵測準確率都低於 50% [arXiv:2501.07301]。
- **失敗模式在成功 run 裡照樣常見。** MAST Table 7 中，FM-3.3 在 ChatDev 的成功 run 是 20.0%、失敗 run 是 25.0%；精讀時發現 MetaGPT 的 FM-1.1 在成功 run（33.3%）反而比失敗 run（16.7%）高，並據此指出 MAST 標籤是「過程缺陷」，不等於「失敗原因」[arXiv:2503.13657]。SWE 軌跡研究的摘要把 thought–action 不一致寫成與失敗強相關，但 RepairAgent 成功組的 2.3% 高於失敗組的 1.3%（精讀時發現）[arXiv:2506.18824]。
- **只看失敗軌跡的研究看不到這一面。** Who&When、AgenTracer、AgentDebug 只在失敗軌跡上標註，看不到同樣的「錯誤」在成功軌跡上有多常見（本章推論）[arXiv:2505.00212][arXiv:2509.03312][arXiv:2509.25370]。

### 「失敗主要出在哪」受收集的腳手架左右

- **MAST：系統設計類最多。** 依 §4 的各模式比例加總，FC1 是 11.8+1.5+15.7+2.80+12.4 = 44.2，FC2 約 32.4，FC3 是 6.20+8.20+9.10 = 23.5 [arXiv:2503.13657]。
- **TRAIL：Output Generation 類最多。** 它佔 353/841 ≈ 42%；精讀時指出，SWE 分割的 256 個錯誤中這一類佔六成以上，正對應作者刻意加上的提示詞限制，例如禁用 git、一次只看 500 字元 [arXiv:2505.08638]。
- **AgentDebug：memory 與 reflection 錯是最主要的級聯源。** 精讀時指出，軌跡是用「每步強制輸出 memory、reflection 段」的提示詞跑出來的，這個分布可能有一部分是腳手架造成的 [arXiv:2509.25370]。
- **SWE-agent：第五套分類。** T3 的 SWE-agent 以 GPT-4o 把 SWE-bench Lite 上 248 條未解軌跡分成 9 類，15 題驗證集上與作者人工標註一致 87%；精讀時指出分類器拿 gold patch 當參考 [arXiv:2405.15793]。它和 SWE 軌跡研究都在 SWE-bench 系列上，但 SWE 軌跡研究分析的是 AutoCodeRover、OpenHands 與 RepairAgent 的軌跡，只在相關工作裡把 SWE-Agent 列為程式修復 agent 的例子，沒有重標同一批軌跡（本章以全文搜尋確認）[arXiv:2506.18824]。
- **五套標籤無法互相印證。** 依這五份筆記，沒有一篇把同一批軌跡用兩套以上的分類法標過，所以這五種分布結論彼此既無法印證、也無法反駁（本章推論）[arXiv:2503.13657][arXiv:2505.08638][arXiv:2509.25370][arXiv:2506.18824][arXiv:2405.15793]。

### LLM 當評審、判官或歸因器，夠不夠用

- **數學上，通用模型追得上專用 PRM。** ProcessBench 上 o1-mini 的 87.9 高於 Qwen2.5-Math-PRM-72B 的 78.3 [arXiv:2412.06559][arXiv:2501.07301]。精讀時發現，Qwen 附錄中 QwQ-32B-Preview 以成對淘汰賽做 Best-of-8 得 67.6，與 Qwen2.5-Math-PRM-7B 相同，論文沒有討論 [arXiv:2501.07301]。
- **網頁上，judge 不可靠。** 最好的 judge precision 也不到 70%，judge 還容易附和 agent 自述的錯誤推理 [arXiv:2504.08942]。兩者設定差太多（一邊是有標準答案的 BoN 選擇，一邊是開放網頁任務的成敗判定），只能說兩個領域的讀數不同（本章的判斷）[arXiv:2501.07301][arXiv:2504.08942]。
- **推理模型沒有全面勝出。** ProcessBench 上推理型 critic 最強，但同樣只解碼一次時 QwQ 輸給 GPT-4o [arXiv:2412.06559]。Who&When 的 hand-crafted 上，R1 在 4 格中輸 GPT-4o 3 格；o1 的 all-at-once agent-level 41.38 低於 GPT-4o 的 54.31，step-level 10.34 則高於 4.39，精讀時提醒這在 58 條軌跡上只差 3–4 條 [arXiv:2505.00212]。TRAIL 的 o3 從 high 降到 low 時 Cat F1 與 Loc 都單調下降，Joint 卻是 medium 的 0.104 高於 high 的 0.092（精讀時指出）[arXiv:2505.08638]。
- **偵錯器只有最強的底模堪用。** AgentDebug 的偵錯器底模消融中，GPT-4.1 的 Step 是 42.0，Llama-3.3-70B、GPT-4o-mini、Qwen3-Next-80B 都不超過 16.0 [arXiv:2509.25370]。
- **給 ground truth 有沒有幫助，兩篇說法相反。** Who&When §4.3 說有 GT 時三種方法在所有情況都比較好，精讀時卻在 Table 1 找到反例，例如 all-at-once 在 alg-gen 的 step-level 是 12.50（有 GT）對 13.53（無 GT）[arXiv:2505.00212]。AgenTracer 觀察到 GT 可能誤導基線，例如 Claude-Sonnet-4 在 TracerTraj-math 的 step-level 有 GT 38.10、沒有 GT 46.03 [arXiv:2509.03312]。論文說自己的模型在沒有 GT 時仍然穩健，但精讀時發現 Who&When automated 的 step-level 少了 GT 後，AgenTracer 掉 42.86−37.30 = 5.56 點，比 Claude-Sonnet-4 的 1.82 點多 [arXiv:2509.03312]。

### 軌跡裡 agent 的自述能不能當證據

本章各篇都把 agent 寫在軌跡裡的 thought、reasoning 或低階指令當成資料的一部分，但這段自述和 agent 實際做了什麼不一定一致（本章歸納）。語料內有三類證據：

- **自述與行動不一致是常見的失敗模式。** MAST 的 FM-2.6 推理與行動不符佔全部失敗出現次數的 13.2%，僅次於步驟重複 [arXiv:2503.13657]。SWE 軌跡研究的 thought–action 不一致在 RepairAgent 的成功組反而較高，2.3% 對 1.3%（精讀時發現）[arXiv:2506.18824]。
- **CoT 解釋會替真正的決策原因找理由。** T3 精讀的 Turpin et al. 在提示中加入模型不會說出口的偏誤特徵，抽查 426 篇支持偏誤預測的解釋，只有 1 篇明確提到偏誤 [arXiv:2305.04388]。這是單輪選擇題上的證據，沒有在 agent 軌跡上重做（本章的判斷）[arXiv:2305.04388]。
- **有些 thought 本來就是事後補寫的。** AgentTuning 與 ETO 的部分軌跡由 GPT-4 在動作決定後補寫 thought；精讀時指出，ETO 的 ScienceWorld 專家 CoT 與動作之間的因果方向是反過來的 [arXiv:2310.12823][arXiv:2403.02502]。

自述在本章被當成證據的地方至少有兩處：

- **合成資料的過濾。** AgentTrek 的 GPT-4o 評估器輸入只有推理與動作文字、沒有截圖；精讀時指出這等於讓 GPT-4o 評重放 agent 自己的自述，有自我確認偏誤 [arXiv:2412.09605]。OS-Genesis 的 TRM 只看執行器自己寫的低階指令加最後三張截圖；精讀時發現，點錯元素但敘述寫對時，中段的錯誤看不到 [arXiv:2412.19723]。
- **judge 的輸入。** AgentRewardBench 的質性分析指出，judge 會附和 agent 的錯誤推理，包括 agent 自述與畫面不符時照單全收 [arXiv:2504.08942]。精讀時發現，論文沒有做「拿掉推理、只留動作與觀測」的消融；Table 2 裡拿掉最終 AXTree 與截圖時，GPT-4o mini 的 success precision 只從 61.5–64.5 掉到 60.7，暗示 judge 主要靠動作清單與 agent 的自述判斷 [arXiv:2504.08942]。

真正沒解決的是：依本調研讀過的筆記，沒有一篇在 agent 軌跡上做過「有自述對沒有自述」的對照，來量自述對標註、評審或歸因結果的影響（本章比對）[arXiv:2504.08942][arXiv:2412.09605][arXiv:2412.19723][arXiv:2503.13657]。這個對照做出來之前，把 agent 自述當成判定依據的評估器，量到的可能有一部分是自述的說服力，而不是任務有沒有完成（本章推論）。

### 排名翻轉：規則式與 judge 都會

AgentRewardBench 說規則式評估在 WebArena 與 WorkArena++ 把 Qwen2.5-VL 排在 GPT-4o 之上，專家則在所有基準都偏好 GPT-4o [arXiv:2504.08942]。精讀時反駁，GPT-4o judge 在同一對上也翻轉了兩次，例如 WebArena 上 judge 給 Qwen 52.6、GPT-4o 50.0，專家是 33.3 對 42.3 [arXiv:2504.08942]。本章把 Table 3 的所有 agent 配對都算進來，排除 Llama 3.3 沒跑的 VWA 與專家平手的一對後，剩 3 + 6 + 5 = 14 組有嚴格順序的配對，judge 顛倒 2 組、規則式顛倒 4 組；程式驗證從全文 Table 3 解析後證實（`verify/04-arb-ranking-flips.py`）[arXiv:2504.08942]。程式也找出兩組平手，不算顛倒但也沒排對：judge 在 VWA 把 Claude 3.7 Sonnet 與 Qwen2.5-VL 都判成 34.8，專家是 28.3 對 21.7；規則式在 VWA 把 GPT-4o 與 Qwen2.5-VL 都判成 17.4，專家是 35.9 對 21.7，這就是論文說的 VWA 上兩者相等 [arXiv:2504.08942]。在 GPT-4o 對 Qwen2.5-VL 這一對上，judge 與規則式都在 WA 與 Wk++ 顛倒 [arXiv:2504.08942]。所以論文強調規則式翻轉較嚴重仍站得住，精讀的批評只在 GPT-4o 對 Qwen2.5-VL 這一對上成立（本章的判斷）[arXiv:2504.08942]。

### 「學生勝過老師」多半是同領域微調對上 few-shot 提示

- **AgentTuning 的 ALFWorld。** AgentLM-70B 86.0，GPT-4 78.0；精讀時發現，ALFWorld 50 題中有 6 題被汙染分析判為 dirty，6 題就等於 12 個百分點，而訓練指令直接取自同一資料集的 train split，教師正是 GPT-4 [arXiv:2310.12823]。
- **ETO 的 WebShop。** 67.4 對 GPT-4 的 63.2，但 GPT-4 只有 1-shot 提示，版本也沒註明（精讀時發現）[arXiv:2403.02502]。
- **AgentTrek 的 WebArena。** 32B 的 22.40 高於 GPT-4o 的 13.10，但表中沒有未微調的 32B 基線（精讀時發現）[arXiv:2412.09605]。
- **AgentPRM 的 3B 對 GPT-4o。** 起點 π0 已與 ReAct gpt-4o 持平，SFT 資料又來自以 gpt-4o 特權回饋訓練出的 LEAP 專家（精讀時發現）[arXiv:2502.10325]。
- **FireAct 是反例。** 微調後最強的 GPT-3.5（39.2）仍低於老師 GPT-4 ReAct 的 42.0，精讀筆記據此認為上限被老師綁住 [arXiv:2310.05915]。

### 下游修正的增益，無法歸功於精準歸因

AgentDebug 與 AgenTracer 都只把已知失敗的軌跡送去診斷，而判定失敗要靠成功 oracle；精讀時指出，報告的增益是有 oracle 時的上限 [arXiv:2509.25370][arXiv:2509.03312]。兩篇也都缺同一個對照：強模型給出、不做定位的通用回饋；AgentDebug 的修正指令由 GPT-4.1 產生、再餵給較弱的 backbone，AgenTracer 對照的 Self-Refine 與 CRITIC 是通用反思而不是歸因器（精讀時指出）[arXiv:2509.25370][arXiv:2509.03312]。AgenTracer 報告，以 GPT-4.1 實作的 CRITIC 在 MaAS＋GAIA 上第 2、3 輪分別是 −4.9% 與 −5.5% [arXiv:2509.03312]。

### 合成那條線的其他爭議

- **一般資料要不要混、混多少。** AgentTuning 說一般資料是泛化的前提，選了 η=0.2，但 7B 只用一般資料是 0.64、混合是 0.67，13B 只用一般資料的 0.81 甚至高於混合的 0.78 [arXiv:2310.12823]。Agent-FLAN 附錄 A 說照 AgentTuning 的做法混合 ShareGPT，比例卻寫成 1:1（本章比對兩篇發現）[arXiv:2403.12881][arXiv:2310.12823]。FireAct 完全不混；精讀時發現，只用 HotpotQA 微調的 Llama-2-7B 加 few-shot ReAct 後，StrategyQA 從 59.0 掉到 52.0 [arXiv:2310.05915]。
- **Agent-FLAN 的幻覺改善有一部分是指標送的（精讀時發現）。** Agent-H 只在「該一般回覆」的樣本上計幻覺，不懲罰該呼叫工具卻不呼叫，永遠不呼叫工具的模型可以拿滿分 [arXiv:2403.12881]。依 Table 3 重算，無負樣本那一列的 H_Score 應為 0.5 × ((1 − 0.156) + (1 − 0.135)) = 0.8545，即 85.45，表中卻是 84.5 [arXiv:2403.12881]。這是精讀時發現、程式驗證證實的單列不一致：同一公式算得回 Llama2-7B、AgentTuning、Agent-FLAN 三列，其他讀法都對不上四列 [arXiv:2403.12881]。若錯的是 H_Score 而子指標正確，負樣本的實際效果只有約 89.1 − 85.45 = 3.65 分；但表格本身分不出錯在哪一邊 [arXiv:2403.12881]。拿掉負樣本時 T-Eval 反而略高（66.3 對 66.0），正是過度婉拒可能出現的方向 [arXiv:2403.12881]。
- **「loss 低」不等於「學得快」。** Agent-FLAN 把各能力子集的 loss 高低當成學習速度來定配比，但格式 token 與函式名稱本來就是低熵、容易預測的 token（精讀時發現）[arXiv:2403.12881]。

### 對前作的描述與前作自己的數字不符

- **AgentTuning 的「第一」。** 見〈問題的演進〉：比它早 10 天的 FireAct 已經做了，它沒有引用（精讀時發現）[arXiv:2310.12823][arXiv:2310.05915]。
- **Agent-FLAN 的基線。** Agent-FLAN Table 1 中 Llama2-7B、AgentLM-7B、GPT-3.5、GPT-4 在 HotpotQA、SciWorld、WebArena 的數字，與 AgentTuning 的 Table 4 相同或只差四捨五入，例如 GPT-4 是 52.1／36.4／6.28；FireAct-7B 那格的 26.2 也與 FireAct 自報的 EM 相同 [arXiv:2403.12881][arXiv:2310.12823][arXiv:2310.05915]。本章推測是沿用而非重跑；若如此，同一欄就混了 AgentTuning 的 Reward 與 FireAct 的 EM 兩種協定，而 FireAct-7B 本來就在 HotpotQA 上訓練過，對它而言那一欄也不是 held-out [arXiv:2403.12881][arXiv:2310.12823][arXiv:2310.05915]。
- **AgenTracer 對 Who&When 的描述。** AgenTracer 說 Who&When 以 o1、R1 做歸因、準確率不到 10%，沒有說是哪個層級 [arXiv:2509.03312]。Who&When 自己的 Table 4 中，R1 的 step-level 是 3.45 與 6.90，確實不到 10%，但 o1 的 step-level 是 10.34 與 13.79，agent-level 更在 32.76–56.90 之間 [arXiv:2505.00212]。AgenTracer 又說 Who&When 只有 127 條人工標註；本章對照兩篇全文，127 是 Who&When 的系統數，它的標註任務是 184 條 [arXiv:2509.03312][arXiv:2505.00212]。
- **AgentDebug 的「第一」。** 它自稱第一個系統化標註的失敗軌跡資料集；精讀時指出 Who&When 與 MAST 更早就公開了標註過的軌跡，這個「第一」只在單 agent 加模組層級上成立 [arXiv:2509.25370]。

### 論文正文與自己的表格對不上

下表只收精讀或本章找到的不一致，引用這些論文時要以表格為準。

| 論文 | 不一致之處 | 出處 |
| --- | --- | --- |
| ReAct | PaLM-540B ReAct 的 HotpotQA EM 在 Table 1 是 27.4、Table 5 是 29.4（精讀時發現） | [arXiv:2210.03629] |
| FireAct | 同一個設定 Table 2 寫 39.2、Table 4 寫 39.4；引言說推論快 4 倍，Table 3 只有 9.0/2.7 ≈ 3.3 倍（精讀時發現） | [arXiv:2310.05915] |
| AgentTuning | 正文說 held-out 提升最多達 170%，表格是 +176%（精讀時發現） | [arXiv:2310.12823] |
| ETO | 正文說 WebShop 增加 8%，表格的相對增幅是 (67.4 − 63.1)/63.1 ≈ 6.8%（精讀時發現） | [arXiv:2403.02502] |
| AgentTrek | 52% 對 15.78% 被寫成「23% improvement」，實際差 52 − 15.78 = 36.22 個百分點；產出率 10,398/23,430 ≈ 44.4%，對不上成本公式用的 39.9%（精讀時發現） | [arXiv:2412.09605] |
| OS-Genesis | 正文說平均軌跡長 6.4 步，附錄 G 的 mobile 是 5.60 步、web 是 4.46 步（精讀時發現） | [arXiv:2412.19723] |
| SWE-Gym | on-policy 成功軌跡在 §4.2 是 868 條，§5.1.1 過濾後變成 875 條（精讀時發現） | [arXiv:2412.21139] |
| Uesato et al. | 結論寫「12.7% → 5.5%」，Table 1 是 12.4%；摘要的 trace 3.4% 屬於 SFT+ORM-RL，結論卻說成 SFT+PRM reranking（表上是 3.5%）（精讀時發現） | [arXiv:2211.14275] |
| Lightman et al. | 正文說 OOD 有 224 題，Table 1 各科相加是 45 + 60 + 45 + 84 = 234；本章按題數重算 ORM 合計，Calculus 與 Physics 用精確的 31/45、35/45，Chemistry 與 AMC 用表上的 68.9、49.1，得到 (31 + 0.689×60 + 35 + 0.491×84)/234 ≈ 63.50，表中卻是 63.8；程式驗證證實，Chemistry 與 AMC 兩格各給 ±0.05 的捨入誤差後，四捨五入與捨去都到不了 63.8（`verify/04-prm-table-recompute.py`）。PRM 與多數決兩欄照同樣做法，把能寫成 k/n 的格子換成精確分數後加權，四捨五入與捨去都對得上表中的 72.9 與 61.3，分辨不出捨入方式（算式見 `verify/04-results.md` 主張 7C）；只有改拿表上的一位小數加權時，才會誤得出「只有捨去對得上」。Chemistry 的 ORM 68.9 不是任何 k/60，AMC10/12 三格都不是任何 k/84，所以 63.8 從哪裡來無法由表格反推 | [arXiv:2305.20050] |
| Math-Shepherd | §5.3 說小 RM 驗大生成器反而比 SC 差；精讀時指出同篇 Table 1 用 LLemma-34B 的 RM 驗 DeepSeek-67B，仍從 SC 的 45.4 提升到 47.0 | [arXiv:2312.08935] |
| OmegaPRM | 邊的標籤取哪個狀態的 MC 值，§3.3 的例子與 Figure 2 caption 矛盾；Q(s,r) 公式沒有「答錯」項（精讀時發現） | [arXiv:2406.06592] |
| Setlur et al. | 計算效率在摘要寫 1.5–5×、Fig. 1 寫 5×、§4.1 寫 10×；對齊項在 Eq. 6 與 Eq. 27 是加號，到 Eq. 28–29 變成減號（精讀時指出） | [arXiv:2410.08146] |
| Qwen2.5-Math-PRM | 共識過濾保留率 §3.1.3 約 40%，§3.1.4 是 300 萬筆剩 150 萬筆；附錄 B.4 的 Best-of-64 被內文寫成 Best-of-8；「取最後一步分數最好」被 Table 13 的外部 MC 系 PRM 反駁（Math-Shepherd-PRM-7B 64.1 對連乘 64.2）（精讀時發現） | [arXiv:2501.07301] |
| AgentPRM | 內文寫 134 局、表註寫 136；本章逐類加總 InversePRM π2 是 117，117 ÷ 134 ≈ 87.3%，表上卻是 86.6%；repo 的折扣方向與式 (1) 相反（精讀時發現） | [arXiv:2502.10325] |
| AgentRewardBench | arXiv HTML v2 附錄 Table 9–12 與 Table 8 逐格相同；附錄系統提示問四題，正文說三題（精讀時發現） | [arXiv:2504.08942] |
| ProcessBench | 「難度提高時所有模型一致退步」有例外：QwQ-32B-Preview 的 Omni-MATH 61.3 高於 OlympiadBench 的 57.8（精讀時發現） | [arXiv:2412.06559] |
| MAST | §3.4 說 MAST-Data 包含 Manus，App B.3 卻說 Manus 被排除；H.3 主張改拓撲比改提示詞有效，但 Table 5 中 AG2 在 GPT-4 上是拓撲 85.50 對提示詞 89.75（精讀時發現） | [arXiv:2503.13657] |
| Who&When | Table 3 的 all-at-once agent-level 57.02，與 Table 1、Table 4 推得的 54.31 不一致；hybrid 的 149,177 tokens 高於兩法相加的 17,106+87,720 = 104,826（精讀時發現） | [arXiv:2505.00212] |
| TRAIL | 軌跡數同時出現 148、149、118+30 三種說法；錯誤總數 579+256 = 835，與 841 不符；§A.8 的 Claude-3.7 平均 0.738，四項平均是 (0.79+1.00+0.53+0.59)/4 ≈ 0.7275（精讀時發現） | [arXiv:2505.08638] |
| SWE 軌跡研究 | 「成功軌跡的 Triggering 比例較高」在 RepairAgent 上反向（57.6% 對 71.3%）（精讀時發現） | [arXiv:2506.18824] |
| AgenTracer | 「持續勝過 Claude-Sonnet-4」並非每格成立，例如 agentic 子集有 GT 的 agent-level 是 53.28 對 55.20；對 Gemini-2.5-Pro「最多高 18.18%」在 Table 1 找不到，兩者最大差距是 17.38 點（精讀時發現） | [arXiv:2509.03312] |
| AgentDebug | §4.2 的 50.0% 與 42.5%，與 Table 1 的平均 45.0、24.3 不符；「最多 26% 的相對提升」與 GPT-4o-mini 的 21→55 對不上，後者是 (55−21)/21 ≈ 1.62（精讀時發現） | [arXiv:2509.25370] |

### 過程監督的安全外推有反證

Lightman §6.2 主張過程監督帶有負的 alignment tax，可望被廣泛採用 [arXiv:2305.20050]。精讀時指出，本文完全沒有用 PRM 做 RL，這是從重排實驗外推到訓練；精讀時還引了 OpenAI 的 gpt-oss model card（https://cdn.openai.com/pdf/419b6906-9da6-406c-a19d-1bb078ac7637/oai_gpt-oss_model_card.pdf），兩個 open-weight 模型都決定不對 CoT 施加直接的最佳化壓力，理由是保留 CoT 的可監控性 [arXiv:2305.20050]。這不推翻本文的 best-of-N 結果，但削弱了「把過程監督當訓練訊號在安全上更好」的外推 [arXiv:2305.20050]。不走過程監督、只用結果獎勵的大規模 RL 這一支，本章語料沒有涵蓋，見〈已知缺口與未讀〉。

## 商用採納現況

只收附 URL 的證據；被論文引用、學術引用數、作者自己的程式碼與資料釋出都不算採納。

### 論文自述部署

未見證據。二十四篇都沒有描述產品部署 [arXiv:2210.03629][arXiv:2412.21139][arXiv:2505.08638][arXiv:2509.03312]。AgenTracer §5.3 所謂「部署到現成系統」，是作者在研究設定內把回饋接回 MetaGPT、MaAS、OWL，不是產品採納 [arXiv:2509.03312]。

### 廠商官方文件採用

- **ReAct：被採納的是迴圈範式，不是字面格式。** Hugging Face smolagents 的官方文件把 ReAct 稱為目前建構 agent 的主要方法，所有 agent 都建立在它的抽象上（https://huggingface.co/docs/smolagents/conceptual_guides/react）[arXiv:2210.03629]。Google 的 Gemini API 文件有以 LangGraph 從頭做 ReAct agent 的範例（https://ai.google.dev/gemini-api/docs/langgraph-example），LangChain 官方模板（https://github.com/langchain-ai/react-agent）與 LlamaIndex 開發者文件（https://developers.llamaindex.ai/python/examples/agent/react_agent/）也都以 ReAct 為名提供 agent 迴圈 [arXiv:2210.03629]。LangGraph 的 create_react_agent 已標示棄用、改用 create_agent（https://reference.langchain.com/python/langgraph.prebuilt/chat_agent_executor/create_react_agent），現行的 LangChain agents 文件已不再提到 ReAct（https://docs.langchain.com/oss/python/langchain/agents）[arXiv:2210.03629]。精讀者的判斷是，被採納的是推理、行動、觀測的迴圈，不是文字格式或 bootstrap 微調流程 [arXiv:2210.03629]。
- **Hugging Face TRL 的 PRMTrainer：曾收錄，已移除。** TRL 的 PRMTrainer 文件說 process-supervised reward model 源自 Uesato et al.，標為 experimental API（https://huggingface.co/docs/trl/main/en/prm_trainer）[arXiv:2211.14275]。TRL v0.14.0 的文件以 Math-Shepherd 的資料當 PRMTrainer 的訓練範例（https://github.com/huggingface/trl/blob/v0.14.0/docs/source/prm_trainer.md 、https://github.com/huggingface/trl/blob/v0.14.0/examples/datasets/math_shepherd.py）[arXiv:2312.08935]。TRL 已合併 PR #7133，移除整個實驗性的 PRMTrainer 與 Math-Shepherd、PRM800K 的資料腳本，理由是使用量極低（https://github.com/huggingface/trl/pull/7133）[arXiv:2312.08935]。兩份筆記對這件事的描述看似矛盾，本章在 2026-09-26 查證後兩者都成立：gh 顯示該 PR 已於 2026-09-17 合併，同一天 main 版文件頁仍能開啟 [arXiv:2211.14275][arXiv:2312.08935]。也就是程式已移除、文件頁尚未撤下；這屬於開源工具鏈層級的收錄，而且已經撤回 [arXiv:2211.14275][arXiv:2312.08935]。
- **vLLM 支援 Qwen 的 PRM 架構：可用性，不是採納。** vLLM v0.9.2 官方文件的 Reward Modeling 表列出 Qwen2ForProcessRewardModel，範例模型是 Qwen2.5-Math-PRM-7B（https://docs.vllm.ai/en/v0.9.2/models/supported_models.html）[arXiv:2501.07301]。精讀者判定這是生態系層級的可用性；商用產品在正式環境使用這個 PRM，未見證據 [arXiv:2501.07301]。

### 僅作者自家釋出

**作者所屬組織自己的產品或模型。** 這幾條有附 URL 的證據，但採納者都與作者有關係，不是獨立第三方：

- **AgentTuning → 智譜 GLM-4。** 精讀時查到的採納證據（技術報告本身不在本調研的精讀名單內）：智譜的 ChatGLM 技術報告把 AgentTuning 列為 ChatGLM 開發過程中引入的技術之一，並寫明 GLM-4 以這些技術訓練（https://arxiv.org/abs/2406.12793）[arXiv:2310.12823]。部分作者標註智譜所屬，報告也沒交代用到什麼程度，精讀者判為弱到中等的證據 [arXiv:2310.12823]。
- **Agent-FLAN → InternLM2。** 精讀時抓了 InternLM2 技術報告的全文查證（報告本身不在本調研的精讀名單內）：§4.4 說 agent 能力的訓練照 Agent-FLAN 的做法（https://arxiv.org/abs/2403.17297）[arXiv:2403.12881]。採納者與作者同屬 Shanghai AI Lab，貢獻也沒有單獨量化 [arXiv:2403.12881]。
- **SWE-Gym → OpenHands LM 32B。** All Hands AI 的官方部落格與 model card 明言沿用 SWE-Gym 的框架：建訓練環境、用現有 agent 產生資料、只拿成功解題的例子微調，SWE-Bench Verified 37.2%（https://www.openhands.dev/blog/introducing-openhands-lm-32b-a-strong-open-coding-agent-model 、https://huggingface.co/OpenHands/openhands-lm-32b-v0.1）[arXiv:2412.21139]。SWE-Gym 的作者與 OpenHands 論文作者重疊 [arXiv:2412.21139]。SWE-Gym 的 README 另把 OpenHands Critic 列為下游使用，但官方的 critic model 部落格完全沒有提到 SWE-Gym（https://www.openhands.dev/blog/sota-on-swe-bench-verified-with-inference-time-scaling-and-critic-model），所以不計入 [arXiv:2412.21139]。
- **TRAIL → Patronus AI 的 Percival。** Patronus AI 官方部落格寫明，自家的 agent 軌跡除錯器 Percival 依 TRAIL 的分類法呈現 20 多種失敗模式（https://www.patronus.ai/blog/introducing-trail-a-benchmark-for-agentic-evaluation）[arXiv:2505.08638]。官方產品頁則同時列出 TRAIL 與 Percival（https://www.patronus.ai/agents），「依 TRAIL 分類法」這一點的證據只來自部落格 [arXiv:2505.08638]。Percival 的文件需要登入，無法核對分類法在產品內的實際對應 [arXiv:2505.08638]。
- **ProcessBench 與 Qwen PRM → Qwen 自家的 model card。** Alibaba Qwen 在 Qwen2.5-Math-PRM-7B／72B 的官方 model card 上以 ProcessBench 當錯誤辨識能力的評估依據，並釋出這兩個 PRM 的權重（https://huggingface.co/Qwen/Qwen2.5-Math-PRM-7B 、https://huggingface.co/Qwen/Qwen2.5-Math-PRM-72B）[arXiv:2412.06559][arXiv:2501.07301]。
- **Who&When → AG2 的 failure_attribution scorer。** AG2 官方原始碼內建一個自稱回答 Who&When 式問題的 scorer，輸出 decisive_step 與 responsible_agent（https://github.com/ag2ai/ag2/blob/57e02372a2542c677bbc3b348f615b7aa9f1d67a/ag2/eval/scorers/attribution.py）[arXiv:2505.00212]。它目前只支援單一 agent，實作的也不是論文三種方法之一；AG2 又是作者所屬組織的框架，精讀者判為概念層級的弱證據 [arXiv:2505.00212]。
- **AgentDebug → AgentDebugX。** 作者群後續發布開源工具包 AgentDebugX，README 寫明以本論文的分類法、基準與 AgentDebug 為基礎，並提供 Claude Code、Codex 外掛與 DeepSeek Harness 的 npm 外掛（https://github.com/AgentDebugX/AgentDebugX）[arXiv:2509.25370]。這是作者自己的開源延伸，README 沒有提到任何公司在生產環境使用 [arXiv:2509.25370]。

**作者自己的程式碼、資料與權重。** 例如 FireAct 的 repo（https://github.com/anchen1011/FireAct）、AgentInstruct 資料集（https://huggingface.co/datasets/THUDM/AgentInstruct）、Agent-FLAN 的模型（https://huggingface.co/internlm/Agent-FLAN-7b）、OS-Genesis 的程式與權重（https://github.com/OS-Copilot/OS-Genesis）、AgentPRM 的 repo（https://github.com/sanjibanc/agent_prm）[arXiv:2310.05915][arXiv:2310.12823][arXiv:2403.12881][arXiv:2412.19723][arXiv:2502.10325]。這些屬於可重現性，不算採納 [arXiv:2310.05915][arXiv:2412.19723][arXiv:2502.10325]。AgenTracer 的 README 明說目前不打算釋出 AgenTracer-8B 權重（https://github.com/bingreeky/AgenTracer），外部無法直接部署 [arXiv:2509.03312]。

### 未見證據

FireAct、ETO、AgentTrek、OS-Genesis、MAST、SWE 軌跡研究、AgenTracer、Lightman et al.、Setlur et al.、Pan et al.、OmegaPRM、AgentPRM、AgentRewardBench 的商用採納都未見證據 [arXiv:2310.05915][arXiv:2403.02502][arXiv:2412.09605][arXiv:2412.19723][arXiv:2503.13657][arXiv:2506.18824][arXiv:2509.03312][arXiv:2305.20050][arXiv:2410.08146][arXiv:2404.06474][arXiv:2406.06592][arXiv:2502.10325][arXiv:2504.08942]。其中 Lightman 那篇能查到的只有 Qwen 以 PRM800K 訓練的 Qwen2.5-Math-7B-PRM800K，而它的 model card 寫明只作為 ProcessBench 的重現基準（https://huggingface.co/Qwen/Qwen2.5-Math-7B-PRM800K）[arXiv:2305.20050]。OmegaPRM 的第三方實作（https://github.com/sanowl/OmegaPRM）自稱供教育與測試用途，OpenR 框架（https://github.com/openreasoner/openr）則是學術開源 [arXiv:2406.06592]。

## 與其他節點的關係

### E3 Anomalies Detected（T4→T5）：軌跡中偵測到異常時觸發自我修正

標了這條邊的筆記有四十二篇，其中十一篇的主節點是 T4，其餘來自 T3、T5、T6、T7、T8。這條資料流要成立，需要兩半：一個讀軌跡的元件判定「有異常」（最好附上位置），以及這個判定真的觸發修正。依各筆記的 how 逐篇判斷，可以分成五類（本章分類；精讀者的標註有的很鬆）。

**兩半都做到的。**

- **AgentDebug。** Stage 1、2 在失敗軌跡上逐步逐模組標錯並挑出最早關鍵錯，產出含步驟、模組、錯誤類型、根因、證據與 correction_guidance 的報告；Stage 3 把 correction_guidance 當高優先指令注入，從 t* 重跑，最多 5 輪 [arXiv:2509.25370]。缺的是觸發時機：要等 Eval 判定整條任務失敗之後，而不是執行中偵測到異常就介入 [arXiv:2509.25370]。
- **AgenTracer。** §5.3 把失敗軌跡交給 AgenTracer-8B 歸因，把診斷推理當外部回饋注入下一輪解題，迭代三輪，在 MaAS、OWL、MetaGPT 上帶來 4.8% 到 14.21% 的提升 [arXiv:2509.03312]。缺的是偵測：觸發條件是 oracle 給的失敗訊號，tracer 只負責定位 [arXiv:2509.03312]。
- **Pan et al.** WebArena 的 Reflexion 實驗中，評估器讀完一次執行後若判定失敗，就啟動 Self-Reflection 寫出失敗原因與新計劃、存進記憶後重試，最多 3 輪 [arXiv:2404.06474]。在本調研讀過的 T4 論文裡，這是唯一由偵測器自己的判定觸發修正、不靠 oracle 的例子（本章比對）[arXiv:2404.06474][arXiv:2509.25370][arXiv:2509.03312]。它也是兩半都量了的一篇：偵測那一半量了評估器對 WebArena oracle 的一致率 74.4–82.1%，修正那一半量了接上 Reflexion 後的相對成功率增益，Captioner + Mixtral 是 16%、GPT-4V 是 29% [arXiv:2404.06474]。但有三個保留：一，偵測那一半只報 accuracy，confusion matrix 只畫在 Figure 4，文字裡沒有誤報率與漏報率（精讀時指出）；二，若這批軌跡的成功率落在 WebArena 原報的 14.41% 與 Pan 重現的 15.6% 之間，一律判失敗就有約 84–86% 的 accuracy（精讀時指出，見〈評估方式與關鍵數字〉）[arXiv:2404.06474][arXiv:2307.13854]；三，Reflexion 之後的最終成功率仍由 WebArena oracle 計算 [arXiv:2404.06474]。缺的是位置：觸發訊號只有二元判定，沒有指出出錯的步驟 [arXiv:2404.06474]。
- **其他節點的論文。** Reflexion 用軌跡層級的啟發式觸發反思，例如同一動作得到同一回應連續超過 3 次、動作數超過 30 [arXiv:2303.11366]。LATS 讓 LLM 讀「到此為止的軌跡＋最新觀測」替每個節點打 1–10 分，低分分支在 UCT 中被冷落，走到失敗終點再觸發反思 [arXiv:2310.04406]。WebCanvas 的 reward 模組在最後兩步動作相同時判為 loop，要求改變方向 [arXiv:2406.12373]。ToolLLM 的 DFSDT 由 agent 自己判斷走不下去、放棄並回溯 [arXiv:2307.16789]。

**只做偵測那一半的。**

- **T4 的論文。** ProcessBench 在推理軌跡中找第一個異常步驟，critic 還附說明，但沒有把結果拿去觸發修正 [arXiv:2412.06559]。Who&When 的輸出（負責 agent、錯誤步驟、理由）正是這條邊要送的東西，但歸因是在已知失敗的完整 log 上離線執行；step-by-step 逐步判斷、遇錯就停，形式上最接近線上觸發器，實驗裡卻沒有這樣用 [arXiv:2505.00212]。TRAIL 輸出可被下游消費的異常紀錄（類別、span id、證據、描述、影響程度），但沒有回饋給 agent [arXiv:2505.08638]。AgentRewardBench 的簡化 judge 輸出副作用與重複循環兩個旗標，§3.1 說它們可以在推論時讓 agent 改走別的動作，但沒有實作任何由旗標觸發的修正 [arXiv:2504.08942]。MAST 用 judge 離線偵測失敗模式，修正是開發者手動重新設計系統，不是 agent 在執行期自我修正 [arXiv:2503.13657]。
- **其他節點的論文。** R-Judge 把互動紀錄交給監控 LLM 產出 unsafe 標籤，量的是訊號品質，沒有送進修正流程 [arXiv:2401.10019]。Llama Guard 逐輪判定回覆是否違反政策，沒有接到修正機制 [arXiv:2312.06674]。SHADE-Arena 的 turn-by-turn monitor 在每個回合前綴上打分，但沒有任何元件消費這個分數 [arXiv:2506.15740]。CoT 可監控性那篇只提出「監控器標記、再擋下或重抽」的概念，沒有實作 [arXiv:2507.11473]。

**有觸發閘門，但偵測對象不是多步軌跡。** 這一類示範了「偵測到異常才修正」的閘門形狀，偵測的卻是單一輸出、單一步驟或答案層級：RARR 的 agreement model 只在不一致時才呼叫編輯模型，拿掉閘門後 Pres_Lev 在三組分別掉 7.0／6.5／8.2 點 [arXiv:2210.08726]；CRITIC 當幻覺偵測器的 AUROC 是 0.81–0.83，但只有降毒任務以偵測結果當閘門 [arXiv:2305.11738]；Self-Debug 以單元測試失敗觸發 [arXiv:2304.05128]；SWE-agent 的 lint 在每次 edit 當下偵測語法錯誤並還原，一次失敗後最終成功的機率從 90.5% 降到 57.2%，軌跡層級的重複則完全沒有偵測 [arXiv:2405.15793]。其餘同類包括 Self-Correct、ProCo、以強 verifier 把關的小模型修正、RCI 的格式檢查、MINT 的直譯器與模擬使用者回饋、ToolSandbox 的工具例外、AI Agents That Matter 的重試、RISE、Feed Yourself 的滿意度分類器，以及 AI Control 的 defer to trusted [arXiv:2211.00053][arXiv:2405.14092][arXiv:2404.17140][arXiv:2303.17491][arXiv:2309.10691][arXiv:2408.04682][arXiv:2407.01502][arXiv:2407.18219][arXiv:1901.05415][arXiv:2312.06942]。兩篇綜述整理了這類觸發的來源 [arXiv:2308.03188][arXiv:2406.01297]。

**偵測只在離線或訓練期成立。** ETO 以最終報酬低於專家軌跡判定一條軌跡失敗，再拿去做 DPO，沒有推論期的偵測，也不定位出錯步驟 [arXiv:2403.02502]。UI-TARS 以規則、VLM 評分與人工標出的第一個錯誤步處理自產軌跡，再轉成 reflection SFT 與 DPO 的配對 [arXiv:2501.12326]。AgentQuest 的偵測那一半也是離線的：開發者讀軌跡上的進度與重複率曲線，發現「重複動作＋進度停滯」；執行期加上的是一條手寫的精確字串比對，猜過的答案就要求重猜，觸發條件不是任何讀軌跡的偵測器，RR60 由 0.32 降到 0 [arXiv:2404.06411]。精讀時指出，在這個門檻下 RR60 歸零是機制強制出來的，指標與修正幾乎同義反覆 [arXiv:2404.06411]。所以本章把它列在離線這一類，依據是筆記 edges 欄寫明，線上的觸發條件是精確字串比對，RR 只用在離線診斷與事後驗證 [arXiv:2404.06411]。

**標了，但算不上異常偵測。** ReAct 在步數上限內沒有 finish 就改走 CoT-SC，依據是軌跡長度，換上的是另一種方法 [arXiv:2210.03629]。FireAct 的 Reflexion 軌跡在固定的第 6、10 輪插入反思，觸發條件是輪數而不是從軌跡偵測到的異常 [arXiv:2310.05915]。

從這五類可以看出幾件事：

- **T4 交出的異常訊號，準確度遠低於下游修正需要的水準。** 以 LLM 定位推理錯誤的研究量到，定位準確率要到約 60–70% 修正才有淨效益，觸發位置錯了增益就大幅縮水 [arXiv:2311.08516]。T4 的偵測器是：Who&When step-level 最佳 14.2%，TRAIL 聯合準確率 0.183／0.050，AgenTracer 的 Who&When step-level 20.68–42.86，AgentDebug 的 Step 45.0 [arXiv:2505.00212][arXiv:2505.08638][arXiv:2509.03312][arXiv:2509.25370]。任務與錯誤定義都不同，只能當量級參考（本章比對）[arXiv:2311.08516][arXiv:2505.00212][arXiv:2509.25370]。
- **在本調研讀過的 T4 論文裡，完整迴路的觸發多半靠 oracle。** AgentDebug 與 AgenTracer 都要先知道任務失敗 [arXiv:2509.25370][arXiv:2509.03312]。Pan 是例外，但它的觸發器 accuracy 可能還不及一律判失敗的基準 [arXiv:2404.06474]。而 T5 那邊的研究顯示，增益主要來自觸發訊號的品質：GPT-3.5 在 CommonSenseQA 上，以 ground truth 決定要不要修正是 89.7，沒有任何異常訊號時是 41.8 [arXiv:2310.01798]。Self-Refine 沒有外部訊號時，94% 的回饋說沒有問題 [arXiv:2303.17651]。
- **誤報率多半沒量，觸發門檻無從設定。** Who&When、AgenTracer、AgentDebug 都沒有在成功軌跡上測過 [arXiv:2505.00212][arXiv:2509.03312][arXiv:2509.25370]。Pan 的混淆矩陣只在圖裡，文字沒有報誤報率（精讀時指出）[arXiv:2404.06474]。Pan 觀察到，把成功誤判成失敗會逼 agent 重做已成功的任務，而重做幾乎一定失敗，所以觸發用的偵測器應該偏向高 precision [arXiv:2404.06474]。AgentRewardBench 量到的 judge precision 卻都不到 70% [arXiv:2504.08942]。
- **偵測器一旦變成最佳化目標就會失效。** 監控 reasoning model 的研究顯示，把異常訊號併進訓練 reward 之後，偵測器的召回率接近 0 [arXiv:2503.11926]。AgentPRM 的 PRM 在驗證集上分數一路上升、真實成功率卻下降，ensemble 也偵測不到 [arXiv:2502.10325]。所以像 ETO、UI-TARS 那樣把偵測結果回灌進訓練，可能破壞觸發它的偵測器（本章推論）[arXiv:2403.02502][arXiv:2501.12326][arXiv:2503.11926]。
- **T4 的偵測幾乎都是事後、離線的。** Who&When、TRAIL、MAST、AgentDebug 都在完整 log 上事後執行 [arXiv:2505.00212][arXiv:2505.08638][arXiv:2503.13657][arXiv:2509.25370]。執行期就觸發的，都在其他節點，而且多半是規則式或逐步 LLM 打分 [arXiv:2303.11366][arXiv:2310.04406][arXiv:2406.12373][arXiv:2405.15793]。

### E4 Nominal Path（T4→T6）：正常路徑繼續與使用者（模擬器）互動

標了這條邊的筆記只有 3 篇，沒有一篇的主節點是 T4：

- **Feed Yourself。** 滿意度分類器的分數高於門檻時走正常路徑，bot 用排序出的回覆繼續對話，這條路徑上的使用者回覆同時被收成訓練資料；低於門檻則走修正流程 [arXiv:1901.05415]。它是三篇中唯一由偵測器的「沒有異常」判定把對話分流到正常路徑的（本章比對）[arXiv:1901.05415]。
- **MINT。** 每一輪都把完整軌跡交給 GPT-4 模擬使用者產生下一段回饋，不區分正常與異常路徑 [arXiv:2309.10691]。
- **τ²-Bench。** 正常路徑就是 agent 與使用者模擬器在雙控制環境中持續互動，直到模擬器輸出結束標記 [arXiv:2506.07982]。

所以在本調研讀過的論文裡，T4 這一側沒有論文實作「沒偵測到異常就繼續與使用者互動」這個分支（本章比對）[arXiv:1901.05415][arXiv:2309.10691][arXiv:2506.07982]。原因有一部分在本章的收錄範圍：本章計入的八篇合成論文，軌跡都從一次給定的指令開始，中途沒有使用者回合（見〈軌跡的格式、收集與合成〉）[arXiv:2310.12823][arXiv:2403.12881]。含使用者回合的多輪軌跡合成本章沒有讀，例如「APIGen-MT: Agentic Pipeline for Multi-Turn Data Generation via Simulated Agent-Human Interplay（arXiv 2504.03601，未讀）」，依標題是以模擬的 agent 與人互動產生多輪資料；所以這句話只在語料內成立，見〈已知缺口與未讀〉。缺的那一半，是偵測器在正常軌跡上說「沒問題」的可靠度，它決定多少正常路徑會被誤轉去修正（本章推論）：

- **在本調研讀過的論文裡，ProcessBench 是唯一在步驟層級量「全對時答 -1」的。** 兩個方向的偏差都有：許多中小模型幾乎一律判全對，例如 Qwen2.5-Math-7B-Instruct 在 GSM8K 的正確樣本 100.0、錯誤樣本只有 15.5；少數模型反過來過度挑剔，例如 Llama-3.1-8B-Instruct 的正確樣本只有 6.2 [arXiv:2412.06559]。前者會放過異常，後者會把正常路徑轉去修正（本章推論）[arXiv:2412.06559]。
- **AgentRewardBench 量了軌跡層級的 recall。** GPT-4o (A) 的成功 recall 是 83.1，也就是專家認定成功的軌跡中有 100 − 83.1 = 16.9% 被判成失敗；規則式的 recall 只有 55.9 [arXiv:2504.08942]。
- **MAST 的失敗模式在成功 run 裡照樣常見。** 以它的標籤當觸發條件，會把正常路徑也轉去修正（本章推論）[arXiv:2503.13657]。
- **Who&When、AgenTracer、AgentDebug 沒有成功軌跡。** 它們的偵測器在正常路徑上的表現完全未知 [arXiv:2505.00212][arXiv:2509.03312][arXiv:2509.25370]。

## 未解問題

以下八題是「在本調研讀過的二十四篇與其他節點的相關筆記裡」還沒解決的問題，不是整個領域在 2026 年的現況。證據窗止於 2025-09；之後有幾篇依標題看來直接回應前三題，因為程式硬規則或範圍判斷落選、本章沒有讀：

- 「Who&When Pro: Can LLMs Really Attribute Failures in AI Agents?（arXiv 2607.09996，未讀）」：依標題，它研究 LLM 能不能歸因 agent 的失敗，可以檢驗第 1 題的歸因定義與準確率。
- 「Rethinking Failure Attribution in Multi-Agent Systems: A Multi-Perspective Benchmark and Evaluation（arXiv 2603.25001，未讀）」：依標題，它從多個視角重新定義多 agent 系統的失敗歸因，可以檢驗第 1 題「真值怎麼定義」。
- 「Tracing Agentic Failure from the Flow of Success（arXiv 2607.12747，未讀）」：依標題，它從成功的流程回推失敗，可以檢驗第 2 題「只有失敗軌跡」這一句。
- 「ToolPRMBench: Evaluating and Advancing Process Reward Models for Tool-using Agents（arXiv 2601.12294，未讀）」：依標題，它評的是工具型 agent 上的 PRM，可以檢驗第 3 題「PRM 式步驟分數沒對過逐步真值」。

這四篇沒有讀，本章不引用它們的任何結果；下面各題若被它們回答了，應以它們為準。

1. **agent 軌跡上，步驟層級的真值要怎麼定義、由誰來標。** 在本調研讀過的論文裡，至少有人工判斷、反事實重放、「第一次出現」規則三種來源，定義也有五種以上 [arXiv:2412.06559][arXiv:2505.00212][arXiv:2509.03312][arXiv:2505.08638][arXiv:2509.25370]。卡在四處：反事實搜尋與人工標籤最不一致（12.0% 對 28.0%）[arXiv:2509.25370]；重放需要可重設、決定性的環境，而 GAIA 的網路搜尋並不決定（精讀時指出）[arXiv:2509.25370]；「單一最早決定性錯誤」的假設排除了需要多處修正的失敗，AgenTracer 從 4,655 條只標出 2,476 條，其餘去向沒有說明（精讀時指出）[arXiv:2509.03312]；人工那一邊的一致度要嘛沒報，要嘛只有 moderate 的 κ 0.55 [arXiv:2505.00212][arXiv:2509.25370]。

2. **偵測器在成功軌跡上會不會亂報。** 在本調研讀過的論文裡，Who&When、AgenTracer、AgentDebug 的評估集只有失敗軌跡，ProcessBench 平衡了兩類但只有數學題 [arXiv:2505.00212][arXiv:2509.03312][arXiv:2509.25370][arXiv:2412.06559]。卡在三處：「過程缺陷」與「失敗原因」兩種標籤語意還沒分開（精讀時指出）[arXiv:2503.13657]；要量誤報率就得在成功軌跡上逐步標註，而 Who&When 的 184 條失敗軌跡就花了約 84 工時 [arXiv:2505.00212]；AgentDebug 與 AgenTracer 的觸發本身就依賴成功 oracle [arXiv:2509.25370][arXiv:2509.03312]。

3. **process reward 與失敗歸因兩條線，在 agent 軌跡上還沒交會。** 在本調研讀過的論文裡，PRM／Q 值型的 agent 步驟分數（AgentPRM 的 Q^π）沒有對過逐步真值；Pan 的逐步進度判定只在 iOS 的 50 個 state-action pair 上人工檢查過，43 個一致 [arXiv:2502.10325][arXiv:2404.06474]。已有的步驟真值（Who&When、TRAIL、AgentDebug）也沒被拿來評這類步驟分數（本章比對）[arXiv:2505.00212][arXiv:2505.08638][arXiv:2509.25370]。卡在 MC 式標註的前提在 agent 上不成立：數學題的狀態就是文字前綴，可以從任意前綴重新 rollout；工具呼叫有副作用，環境與使用者狀態都要能快照，多輪互動下每次補完還得連同使用者模擬器一起跑（精讀時指出）[arXiv:2312.08935][arXiv:2410.08146]。AgentPRM 改靠同一 (s,a) 被多次造訪，但雜湊鍵是完整歷史，多輪歷史幾乎不可能逐字相撞，Q̂ 會退化成單樣本估計（精讀時發現）[arXiv:2502.10325]。合成那條線在本調研裡唯一的步驟層級嘗試，ETO 的單次 rollout 回推，兩組超參數下分別是 8.3 與 62.8，前者崩掉、後者與 SFT 的 63.1 相近，都沒有勝過軌跡層級，作者自己說訓練不穩；只試了兩組設定，談不上證明這條路不可行 [arXiv:2403.02502]。

4. **失敗與部分完成的軌跡該怎麼用，自產軌跡的自我改進在什麼條件下有效。** 在本調研讀過的論文裡，丟掉、DPO 負例、按分數降權、ORM 負例四種做法並存，分散在不同環境、基座與資料量，撐起各自做法的消融又都有混淆 [arXiv:2310.12823][arXiv:2403.02502][arXiv:2412.19723][arXiv:2412.21139]。以結果獎勵做多步線上 RL 的第五種做法沒有計入（見〈失敗或部分完成的軌跡，該丟、該降權，還是拿來對比〉）。on-policy 的結果則是 SWE-Gym 在 OpenHands 上退步、ETO 迭代一到兩輪後下降 [arXiv:2412.21139][arXiv:2403.02502]。卡在三個混淆變因沒拆開：簡單題重複（SWE-Gym 那輪沒有 capping，精讀時發現）[arXiv:2412.21139]；探索多樣性不足（帶著真實環境報酬挑 10 條的 Best-of-N 只從 63.1 升到 63.8，精讀時據此推論 SFT agent 的取樣多樣性很低）[arXiv:2403.02502]；訓練集固定造成過擬合（ETO 作者的歸因）[arXiv:2403.02502]。

5. **自動標籤的雜訊有多大，又怎麼傳進訓練。** 成敗標籤與步驟標籤都有已知漏洞：以 EM 過濾會留下 6% 的 false positive [arXiv:2210.03629]；AgentTrek 的評估器判準寬鬆（精讀時發現）[arXiv:2412.09605]；OS-Genesis 的 TRM 評的是執行器的自述 [arXiv:2412.19723]；SWE-Gym 的失敗標籤可能混入基礎設施故障（精讀時發現）[arXiv:2412.21139]；OmegaPRM 沒有對任何一筆自動標籤做人工稽核 [arXiv:2406.06592]；Qwen 每步只做 8 次續寫、估計變異大，共識過濾又丟掉 50–60% 的資料，精讀時指出被丟的很可能正是難例 [arXiv:2501.07301]。卡在沒有人量過標籤錯誤率對訓練結果的影響，手上有 PRM800K 這種人工首錯資料的 OmegaPRM 也沒拿來量（精讀時發現）[arXiv:2406.06592]。

6. **長軌跡上，量到的是除錯能力，還是讀完整條軌跡的能力。** TRAIL 的 GAIA 軌跡平均約 287K tokens、最長 7.5M，所有指標都與輸入長度負相關，Location 的 Spearman ρ 是 −0.508；Who&When 在最長一級的 step-level 趨近 0% [arXiv:2505.08638][arXiv:2505.00212]。卡在三處：精讀時指出 TRAIL 的模型排名幾乎與長上下文排行榜一致 [arXiv:2505.08638]；Who&When 的三種讀法比較混了「有沒有附步驟編號」這個沒控制的變因（精讀時指出）[arXiv:2505.00212]；依筆記，沒有一篇拿切塊、摘要或有工具的裁判當對照，TRAIL 的公開腳本還直接跳過超限的軌跡 [arXiv:2505.08638][arXiv:2505.00212][arXiv:2509.03312]。

7. **評估器怎麼跟上變強的策略，不看結果時又怎麼偵測 reward hacking。** Math-Shepherd 在 PPO 後 PRM 輸給 SC，Setlur 沒能動態更新 prover，Lightman 迭代重訓選樣器時不穩定 [arXiv:2312.08935][arXiv:2410.08146][arXiv:2305.20050]。AgentPRM 試過 ensemble 偵測 reward hacking，無效，作者列為開放問題 [arXiv:2502.10325]。卡在兩處：補完式標籤每個前綴都要做 N 次或 n_mc 次續寫，策略一變就得重來 [arXiv:2312.08935][arXiv:2410.08146]；除了結果成功率沒有獨立於 reward 的訊號，而成功率本身也有偏差，規則式一致低估、judge 大多高估 [arXiv:2502.10325][arXiv:2504.08942]。

8. **軌跡格式與分類法無法互相對照。** 軌跡的序列化從純文字 TAO、多輪對話、多輪聊天加逐輪 loss 遮罩、OpenTelemetry span、(thought, action, result) 三元組到四模組的結構化輸出，各不相同，分類法也各自獨立 [arXiv:2210.03629][arXiv:2310.12823][arXiv:2403.12881][arXiv:2505.08638][arXiv:2506.18824][arXiv:2509.25370]。卡在三處：依筆記沒有共用的多重標註集 [arXiv:2503.13657][arXiv:2505.08638][arXiv:2506.18824][arXiv:2509.25370]；格式本身決定了哪些錯誤看得見，SWE 軌跡研究丟掉了 8.3% 無法歸類的動作，圖上也省略了 ErrorResponse 事件 [arXiv:2506.18824]；而原文說 AutoCodeRover 失敗軌跡長度的變異與離群值，常來自 Response Parse Error 這類內部錯誤，精讀時據此指出動作分析看不到這類失敗訊號 [arXiv:2506.18824]；本調研讀過的論文裡唯一直接比過格式的 Agent-FLAN 混入了 token 數翻倍，AgentTrek 宣稱的四層 schema 公開資料也只見文字模態的一個檔案（精讀時發現）[arXiv:2403.12881][arXiv:2412.09605]。

## 已知缺口與未讀

本節列出本章沒有涵蓋、因此結論只在語料內成立的幾塊。每一條寫明缺了什麼、哪些結論因此受限，以及可以補上的論文；標「未讀」的論文本章只看過標題，沒有引用任何結果。

- **ORM 與驗證器的源頭。** 缺的是 process 對 outcome 這條線最早的驗證器工作。受限的結論：〈問題的演進〉把 Uesato 當成 process reward 線的起點，〈process 監督比 outcome 好嗎〉的比較也從 Uesato 開始。可補的論文：Training Verifiers to Solve Math Word Problems（arXiv 2110.14168，未讀），依標題，它研究訓練驗證器來解數學應用題，可以檢驗〈問題的演進〉把 Uesato 當成 process reward 線起點的說法。
- **agent 上的步驟信用分派與 step-level PRM。** 缺的是除 AgentPRM 以外、在 agent 軌跡上訓練步驟評分模型或估計步驟層級 advantage 的論文。受限的結論：「以 rollout 估計的 Q 值訓練出步驟評分模型、再接上 agent 的只有 AgentPRM」「PRM 式步驟分數沒對過逐步真值」「沒有一篇拿步驟真值評 PRM」、〈這條線停在結果層級〉裡「步驟層級監督換個估計方式在 agent 上效果如何」，以及未解問題第 3 題。可補的論文：Watch Every Step! LLM Agent Learning via Iterative Step-Level Process Refinement（arXiv 2406.11176，未讀），依標題，它研究以迭代的步驟層級過程精煉來訓練 LLM agent，ETO 的精讀筆記把它列為 ETO 第一作者參與的後續 [arXiv:2403.02502]，可以檢驗「步驟層級監督換個估計方式」那一句；Group-in-Group Policy Optimization for LLM Agent Training（arXiv 2505.10978，未讀），依標題，它研究 LLM agent 訓練用的一種 policy optimization，可以檢驗「只有 AgentPRM」這句；時間窗之後有 ToolPRMBench: Evaluating and Advancing Process Reward Models for Tool-using Agents（arXiv 2601.12294，未讀），依標題，它評的是工具型 agent 上的 PRM，可以檢驗「沒有一篇拿步驟真值評 PRM」。
- **大規模人類示範的收集。** 缺的是以人類示範為主要軌跡來源的訓練工作；本章只從 T7 的 Mind2Web 筆記補了一例。受限的結論：〈軌跡的格式、收集與合成〉第一條軸「從人寫範例換成強教師模型」的敘事。可補的論文：WebGPT: Browser-assisted question-answering with human feedback（arXiv 2112.09332，未讀），依標題，它研究以瀏覽器輔助問答、並使用人類回饋，可以檢驗第一條軸漏掉以人為來源的那一支有多大。
- **只用規則式結果獎勵的大規模 RL。** 缺的是只用規則式結果獎勵做大規模 RL 的路線。受限的結論：〈process 監督比 outcome 好嗎，人工標籤比自動標籤好嗎〉整節，只回答 PRM 那一側的論文彼此怎麼說；〈過程監督的安全外推有反證〉也只談了一個方向。可補的論文：DeepSeek-R1: Incentivizing Reasoning Capability in LLMs via Reinforcement Learning（arXiv 2501.12948，未讀），依標題，它研究以強化學習提升 LLM 的推理能力；AgentPRM 的筆記把它當成大規模 RL 的代表，GUI-R1 的筆記把自己的做法稱為 DeepSeek-R1 式的規則獎勵強化學習 [arXiv:2502.10325][arXiv:2504.10458]。它可以檢驗〈process 監督比 outcome 好嗎〉開頭的範圍但書。
- **多步線上 RL 與含使用者回合的軌跡。** 缺的是以結果獎勵直接做多步 agent RL 的訓練方法，以及含真實或模擬使用者回合的多輪軌跡合成；另有兩份模型技術報告在候選池落選，本章沒有讀。受限的結論：「失敗軌跡的去向有四種做法」、未解問題第 4 題，以及 E4「T4 這一側沒有論文實作正常路徑」。可補的論文：Group-in-Group Policy Optimization for LLM Agent Training（arXiv 2505.10978，未讀），依標題，它研究 LLM agent 訓練用的一種 policy optimization，可以檢驗〈失敗或部分完成的軌跡〉「第五種做法沒有計入」，以及四種做法是否漏掉一種；APIGen-MT: Agentic Pipeline for Multi-Turn Data Generation via Simulated Agent-Human Interplay（arXiv 2504.03601，未讀），依標題，它以模擬的 agent 與人互動產生多輪資料，可以檢驗 E4「T4 這一側沒有論文實作正常路徑」。
- **統一的軌跡格式與跨環境收集框架。** 缺的是以軌跡 schema 或跨環境格式統一為主要貢獻的論文；候選池裡有一篇以統一軌跡格式為題的論文落選，本章沒有讀。受限的結論：〈方法比較〉的格式對照表只能並列八篇訓練配方的附帶決定，未解問題第 8 題「格式無法互相對照」也只在語料內成立。可補的論文：InterCode: Standardizing and Benchmarking Interactive Coding with Execution Feedback（arXiv 2306.14898，未讀），依標題，它研究把互動式寫程式標準化成基準，並提供執行回饋，可以檢驗〈方法比較〉「沒有一篇比較不同軌跡格式之間的轉換損失」；AgentGym: Evolving Large Language Model-based Agents across Diverse Environments（arXiv 2406.04151，未讀），依標題，它研究讓 LLM agent 跨多種環境演化，可以檢驗跨環境收集這一塊。
- **時間窗之後的失敗歸因。** 缺的是 2025-09 之後的歸因基準與方法。受限的結論：〈軌跡分析、失敗分類與歸因〉的整體敘事，以及未解問題第 1、2 題。可補的論文：Who&When Pro: Can LLMs Really Attribute Failures in AI Agents?（arXiv 2607.09996，未讀）、Rethinking Failure Attribution in Multi-Agent Systems: A Multi-Perspective Benchmark and Evaluation（arXiv 2603.25001，未讀）、Tracing Agentic Failure from the Flow of Success（arXiv 2607.12747，未讀）。

## 文獻表

<!-- bib:begin -->
標記：✅ 讀完全文並通過錨點驗證，計入本節點；📖 讀完全文但不計入（原因寫在一句話後面）；❌ 只拿得到摘要。一句話取自精讀筆記的 one_liner。

| 標記 | arXiv | 標題 | arXiv 年月 | 子領域 | 一句話 |
| --- | --- | --- | --- | --- | --- |
| ✅ | [2210.03629](https://arxiv.org/abs/2210.03629) | ReAct: Synergizing Reasoning and Acting in Language Models | 2022-10 | 軌跡的格式、收集與合成（含以軌跡訓練 agent） | 提出 ReAct：用少量人工撰寫的「Thought／Action／Observation」交錯軌跡當 few-shot 範例，讓凍結的 LLM（PaLM-540B）在 HotpotQA、FEVER、ALFWorld、WebShop 上邊推理邊呼叫外部環境；另外用 3,000 條答案正確的自產軌跡微調小模型，並對 HotpotQA 軌跡做人工的成功／失敗模式分類。 |
| ✅ | [2310.05915](https://arxiv.org/abs/2310.05915) | FireAct: Toward Language Agent Fine-tuning | 2023-10 | 軌跡的格式、收集與合成（含以軌跡訓練 agent） | 用 GPT-4 few-shot 產生 HotpotQA 等 QA 任務的 ReAct／CoT／Reflexion 軌跡，只留答對的，統一轉成 ReAct 的 Thought–Action–Observation 格式，拿來 SFT 較小的模型（GPT-3.5、Llama-2、CodeLlama）；再系統比較資料量、基座模型、方法混料與任務混料的影響。 |
| ✅ | [2310.12823](https://arxiv.org/abs/2310.12823) | AgentTuning: Enabling Generalized Agent Abilities for LLMs | 2023-10 | 軌跡的格式、收集與合成（含以軌跡訓練 agent） | 用 GPT-4 在六個 agent 環境中 rollout、以最終 reward 只留成功軌跡，做出 1,866 條 ReAct 格式的互動軌跡資料集 AgentInstruct，再與 ShareGPT 一般對話以 2:8 混合微調 Llama-2-chat，得到 AgentLM-7B／13B／70B。 |
| ✅ | [2403.02502](https://arxiv.org/abs/2403.02502) | Trial and Error: Exploration-Based Trajectory Optimization for LLM Agents | 2024-03 | 軌跡的格式、收集與合成（含以軌跡訓練 agent） | 提出 ETO：先以專家軌跡做 SFT 行為複製得到基礎 agent，再讓 agent 在訓練集任務上探索、收集最終報酬較低的失敗軌跡，與同一任務的專家軌跡配成「成功／失敗」偏好對，用 DPO 更新策略並反覆多輪；在 WebShop、ScienceWorld、ALFWorld 上以 Llama-2-7B-Chat 勝過 SFT、Best-of-N、RFT、PPO。 |
| ✅ | [2403.12881](https://arxiv.org/abs/2403.12881) | Agent-FLAN: Designing Data and Methods of Effective Agent Tuning for Large Language Models | 2024-03 | 軌跡的格式、收集與合成（含以軌跡訓練 agent） | 把 ReAct／JSON 格式的 agent 軌跡改寫成多輪對話，按「推理、檢索、理解、指令遵循」四種能力拆開逐輪重新配比，再補上「何時不該呼叫工具」的負樣本，用這份重組過的軌跡語料微調 Llama2 成為 agent。 |
| ✅ | [2412.09605](https://arxiv.org/abs/2412.09605) | AgentTrek: Agent Trajectory Synthesis via Guiding Replay with Web Tutorials | 2024-12 | 軌跡的格式、收集與合成（含以軌跡訓練 agent） | 從 RedPajama 撈出網頁操作教學、改寫成結構化任務，再讓 GPT-4o agent 在真實網站上照著教學重放並由 GPT-4o 評估器過濾，以每條約 0.55 美元合成出 10,398 條多模態網頁 agent 軌跡，並用來微調 Qwen2.5 與 Qwen2-VL。 |
| ✅ | [2412.19723](https://arxiv.org/abs/2412.19723) | OS-Genesis: Automating GUI Agent Trajectory Construction via Reverse Task Synthesis | 2024-12 | 軌跡的格式、收集與合成（含以軌跡訓練 agent） | 把 GUI 軌跡蒐集的順序倒過來：先用規則式遍歷在 Android 模擬器與瀏覽器裡逐一點擊介面元素、收集〈動作前畫面、動作、動作後畫面〉三元組，再讓 GPT-4o 從單步狀態轉移反推低階與高階指令、依高階指令執行出完整軌跡，最後用 1–5 分的軌跡獎勵模型（TRM）按分數加權取樣，拿來對開源 VLM 做 SFT。 |
| ✅ | [2412.21139](https://arxiv.org/abs/2412.21139) | Training Software Engineering Agents and Verifiers with SWE-Gym | 2024-12 | 軌跡的格式、收集與合成（含以軌跡訓練 agent） | 建出 SWE-Gym：2,438 個真實 GitHub issue 任務，每題都有可執行的 Docker 環境與單元測試。在其中用拒絕取樣收集 agent 軌跡，以單元測試自動標記成敗，成功軌跡拿來微調 Qwen2.5-Coder 成為 SWE agent，成功與失敗軌跡平衡後訓練軌跡層級的結果型 verifier（ORM）做 Best-of-k 重排，32B 開放權重系統在 SWE-Bench Verified 達到 32.0%。 |
| ✅ | [2412.06559](https://arxiv.org/abs/2412.06559) | ProcessBench: Identifying Process Errors in Mathematical Reasoning | 2024-12 | 軌跡分析、失敗分類與歸因 | 建立 3,400 筆由博士級數學專家標註「最早出錯步驟」的數學解題軌跡基準，用同一套「最早錯誤步索引或 -1」協定比較 PRM 與提示詞驅動的 critic 模型，發現以 MC 估計標籤訓練的 PRM 在難題上泛化最差，推理型模型當 critic 最強。 |
| ✅ | [2503.13657](https://arxiv.org/abs/2503.13657) | Why Do Multi-Agent LLM Systems Fail? | 2025-03 | 軌跡分析、失敗分類與歸因 | 先用紮根理論分析 150 多條多 agent 執行軌跡，歸納出 14 個失敗模式、分成 3 類的 MAST 分類法（人工一致度 κ=0.88）；再用 o1 few-shot LLM judge 自動標註 7 個 MAS 框架的 1642 條軌跡，公開成資料集 MAST-Data。 |
| ✅ | [2505.00212](https://arxiv.org/abs/2505.00212) | Which Agent Causes Task Failures and When? On Automated Failure Attribution of LLM Multi-Agent Systems | 2025-05 | 軌跡分析、失敗分類與歸因 | 把「多 agent 系統失敗時，是哪個 agent、在哪一步造成的」定義成自動失敗歸因任務，釋出 Who&When 資料集：184 條失敗軌跡，逐條標註負責 agent、關鍵錯誤步驟與理由。論文比較 all-at-once、step-by-step、binary search 三種 LLM 判讀法，最好的成績也只有 agent-level 53.5%、step-level 14.2%。 |
| ✅ | [2505.08638](https://arxiv.org/abs/2505.08638) | TRAIL: Trace Reasoning and Agentic Issue Localization | 2025-05 | 軌跡分析、失敗分類與歸因 | 提出涵蓋推理、規劃協調、系統執行三大類約 20 個葉節點的 agent 錯誤分類法，並以它人工標註 148 條 OpenTelemetry／OpenInference 結構化軌跡（1987 個 span、841 個錯誤）作為 benchmark，測 LLM 當裁判能否在原始軌跡 JSON 中找出錯誤類別與出錯的 span；最好的 Gemini-2.5-Pro 聯合準確率在 GAIA 分割只有 0.183、SWE-Bench 分割 0.050。 |
| ✅ | [2506.18824](https://arxiv.org/abs/2506.18824) | Understanding Software Engineering Agents: A Study of Thought-Action-Result Trajectories | 2025-06 | 軌跡分析、失敗分類與歸因 | 把 RepairAgent、AutoCodeRover、OpenHands 三個程式修復／issue 解決 agent 的異質日誌統一成 thought–action–result 三元組序列，抽樣 120 條軌跡（2,822 次迭代），用軌跡統計、8 類動作分類加 4-gram 序列探勘，以及對約 14K 對相鄰軌跡元件做開放編碼的語意關係標註，比較成功與失敗軌跡，歸納出除錯反模式並公開標註資料。 |
| ✅ | [2509.03312](https://arxiv.org/abs/2509.03312) | AgenTracer: Who Is Inducing Failure in the LLM Agentic Systems? | 2025-09 | 軌跡分析、失敗分類與歸因 | 提出 AgenTracer，用兩種方式自動標註多 agent 失敗軌跡的決定性錯誤（哪個 agent、哪一步），得到約 2.5K 筆的 TracerTraj：一是反事實重放，對失敗軌跡換上 DeepSeek-R1 提出的局部修正後重跑，看哪一步修好就能翻成成功；二是程式化故障注入，在成功軌跡的某一步植入錯誤使它失敗。再用 GRPO 加多粒度獎勵，把 Qwen3-8B 訓練成歸因器 AgenTracer-8B；它的診斷推理可當回饋餵回 MetaGPT、MaAS、OWL 等系統。 |
| ✅ | [2509.25370](https://arxiv.org/abs/2509.25370) | Where LLM Agents Fail and How They can Learn From Failures | 2025-09 | 軌跡分析、失敗分類與歸因 | 提出單 agent 的模組化失敗分類法 AgentErrorTaxonomy（5 模組 17 類）、200 條逐步逐模組標註根因的失敗軌跡資料集 AgentErrorBench，以及用 LLM 找出最早關鍵錯、再從該步帶著回饋重跑的偵錯框架 AgentDebug。 |
| ✅ | [2211.14275](https://arxiv.org/abs/2211.14275) | Solving math word problems with process- and outcome-based feedback | 2022-11 | 軌跡／步驟層級評估與 process reward | 在 GSM8K 上首度系統比較「只監督最終答案（outcome）」與「逐步監督推理過程（process）」兩類回饋，橫跨 SFT、reward model 重排序與 expert iteration RL，並提出以人工標註「第一個重大錯誤步驟」訓練的 process-supervised reward model（PRM）與 trace error 指標。 |
| ✅ | [2305.20050](https://arxiv.org/abs/2305.20050) | Let's Verify Step by Step | 2023-05 | 軌跡／步驟層級評估與 process reward | OpenAI 以 GPT-4 為基底，用 80 萬筆人工步驟標籤（PRM800K）訓練 process-supervised reward model（PRM），在 MATH 的 500 題子集上以 best-of-1860 重排解出 78.2%，勝過 outcome-supervised RM（72.4%）與多數決（69.6%）；並以大模型充當標註者做小尺度消融，顯示過程監督在同等資料下仍勝出、主動學習讓標註資料效率提升約 2.6 倍。 |
| ✅ | [2312.08935](https://arxiv.org/abs/2312.08935) | Math-Shepherd: Verify and Reinforce LLMs Step-by-step without Human Annotations | 2023-12 | 軌跡／步驟層級評估與 process reward | 固定解題前綴到某一步後讓補完模型往下解 N 次、以答到標準答案的比例自動產生逐步標籤，據此訓練出不需人工標註的數學 process reward model（Math-Shepherd），在 best-of-N 重排與逐步 PPO 兩種用途上都勝過 ORM 與 self-consistency。 |
| ✅ | [2404.06474](https://arxiv.org/abs/2404.06474) | Autonomous Evaluation and Refinement of Digital Agents | 2024-04 | 軌跡／步驟層級評估與 process reward | 用 VLM／LM 組成不需要人工測試案例的評估器，讀 digital agent 的執行軌跡（指令、動作字串、螢幕截圖）後給出整條軌跡的成功與否或逐步的進度標籤，驗證它與 WebArena 的 oracle 及 AitW 人工判定的一致度（74.4–92.9%），再把它當 Reflexion 的獎勵訊號與 filtered behavior cloning 的篩選器來改進 web 與手機 agent。 |
| ✅ | [2406.06592](https://arxiv.org/abs/2406.06592) | Improve Mathematical Reasoning in Language Models by Automated Process Supervision | 2024-06 | 軌跡／步驟層級評估與 process reward | Google DeepMind 提出 OmegaPRM：從答錯的解答出發，以每次 k=8 個 rollout 的 Monte Carlo 估計加二分搜尋定位第一個錯誤步，並把途中所有 rollout 存成一棵 state-action tree、用類 AlphaGo 的 PUCT 反覆挑「狀態看似該對、rollout 卻答錯」的樣本再搜尋，全自動蒐集 1.5M 筆步驟標籤訓練 PRM；在 MATH500／GSM8K 的 PRM 加權多數決上略勝 PRM800K 與 Math-Shepherd，但比單純多數決只多 0.9–3.5 個百分點。 |
| ✅ | [2410.08146](https://arxiv.org/abs/2410.08146) | Rewarding Progress: Scaling Automated Process Verifiers for LLM Reasoning | 2024-10 | 軌跡／步驟層級評估與 process reward | 主張步驟層級的 process reward 應衡量「進展」——在一個與基礎策略互補的 prover 策略下，走這一步前後答對機率的變化（advantage），並訓練 process advantage verifier（PAV）預測它；在 MATH 上讓 beam search 與線上 RL 相對 ORM 更準、更省計算與樣本。 |
| ✅ | [2501.07301](https://arxiv.org/abs/2501.07301) | The Lessons of Developing Process Reward Models in Mathematical Reasoning | 2025-01 | 軌跡／步驟層級評估與 process reward | Qwen 團隊整理自己訓練數學推理 PRM 的教訓：用 MC 估計造出來的步驟標籤雜訊很大，只看 Best-of-N 又會高估 PRM；於是改用「MC 估計與 LLM-as-a-judge 對第一個錯誤步的位置要一致」的共識過濾來造資料，評估則同時看 BoN 與 ProcessBench，最後釋出 Qwen2.5-Math-PRM-7B/72B。 |
| ✅ | [2502.10325](https://arxiv.org/abs/2502.10325) | Process Reward Models for LLM Agents: Practical Framework and Directions | 2025-02 | 軌跡／步驟層級評估與 process reward | 提出 AgentPRM：同一任務重複 roll out，把經過同一個（狀態，動作）的多條軌跡結果平均成逐步 Q 值軟標籤來訓練 agent 的 process reward model，再把它接進現成 RLHF（online DPO）迭代更新策略；另提出 InversePRM，只靠專家示範就能學出 PRM。在 ALFWorld 上，Llama-3.2-3B 的成功率由 SFT 的 64.9% 提升到 88.1%，搭配 Best-of-N 可達 91.0%。 |
| ✅ | [2504.08942](https://arxiv.org/abs/2504.08942) | AgentRewardBench: Evaluating Automatic Evaluations of Web Agent Trajectories | 2025-04 | 軌跡／步驟層級評估與 process reward | 收集 4 個 LLM 網頁 agent 在 5 個基準上的 1302 條軌跡，由專家逐條標註成功、副作用與重複循環，拿來量 12 個 LLM judge 與官方規則式評估對軌跡成敗的判定和專家差多少。 |
<!-- bib:end -->
