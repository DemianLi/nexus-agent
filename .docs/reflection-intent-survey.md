# 反思層與意圖分類層調研 —— 給 #16 的前置決定

[#16](https://github.com/DemianLi/nexus-agent/issues/16) 提兩個強化方向：**Reflection plugin**（「在迴圈中加入明確的反思步驟（自我批判、重新規劃）。代價是每步多一次 LLM 呼叫」）與 **Intent plugin**（「顯式意圖分類，先於主迴圈判斷任務類型並路由到對應 subagent / 工具組」）。這份筆記只服務一個決定：**這兩個方向該不該啟動**。

**調研日期**：2026-09-01。

## 這份筆記的來源與可信度

**第一版由子代理產出，而它只做了本地那半。** 它自己在報告裡誠實標了三級（已讀 ✅ ／知道但未讀 📖 ／未做 ❌），而學術與生產級 agent 那兩塊整個落在後兩級 —— 也就是說，**它交出「建議關掉 #16」這個結論時，支持側與實務側的證據一條都沒讀過**。那半是後來（同一天）重讀第一手來源補的，補的人是主代理。

分工如下：

| 區塊 | 誰做的 | 狀態 |
| --- | --- | --- |
| dsh 的 plan / goal / todo README | 子代理直讀 | 未逐條回核，但與既有的 `plan-mode/src/index.ts` 檔頭一致 |
| `@nexus/plugin-validation` 的現況 | 子代理直讀 | 與樹相符 |
| 基座（deepagents / LangChain）有無內建反思 | 子代理 grep，**主代理複核** | ✅ 複核成立，見下 |
| 論文原文（Reflexion / Self-Refine / Huang et al. / 2512.24103） | 主代理讀 arXiv | ✅ 第一手 |
| 生產級 agent（SWE-agent / OpenHands） | 主代理讀官方論文 | ✅ 第一手（有一次抽取失敗，見下） |
| LangChain 官方對 reflection 的立場 | 主代理讀官方 repo | ✅ 第一手 |
| Aider / Cline / Goose | **沒做** | ❌ 未讀原始碼，本文不對它們做任何宣稱 |

**一次工具出錯要記下來。** 用 WebFetch 抽 SWE-agent 的 NeurIPS PDF 時，回來的摘要把 ACI 展開成 “Action-Criticism-Iteration”，並據此描述了一個「Criticism」階段。那是錯的：ACI 是 **agent-computer interface**（arXiv abs 頁的原文：「SWE-agent's custom agent-computer interface (ACI)」）。PDF 抽取那次不可採信，本文對 SWE-agent 的敘述改以 abs 頁為準。**如果那次沒被抓到，它會變成一條「SWE-agent 迴圈裡有 criticism 階段」的假證據，而且方向剛好與結論相反。**

**基座 grep 的複核**（主代理親跑，`apps/harness/node_modules/`）：

```
reflect:      deepagents/dist/langsmith-*.{cjs,js}（LangSmith bundle，非反思模式）
critique:     零命中
selfCorrect:  零命中
self_correct: 零命中
```

子代理的否定性宣稱成立：**deepagents 1.13.1 與 langchain 1.5.10 的 dist 裡沒有內建的反思 middleware。** 但這句話有個重要的邊界，見下面第 4 節 —— 「npm 套件裡沒有」不等於「官方不推」。

## 全文的軸：把「反思」拆成兩種

- **(A) 有外部訊號的迭代** —— 跑測試／type check／linter／schema 驗證失敗，把錯誤訊息餵回去重試。**判準來自模型之外。**
- **(B) 無外部訊號的自我批判** —— 同一個模型在同一個 context 裡評自己剛產出的東西，沒有新的外部證據進來。

**#16 講的是 (B)**（它自己寫「每步多一次 LLM 呼叫」）。而 nexus 樹裡**已經有 (A)**：`packages/nexus-plugin-validation`（schema 驗證＋失敗回饋重試）。所以真正要證的不是「反思有沒有用」，是**「(B) 加在 (A) 旁邊有沒有增益」**。

這個區分不是本文發明的，是文獻自己的用語（Huang et al. 稱 (B) 為 *intrinsic self-correction*）。**大量二手文章混談這兩件事**，而混談的方向幾乎一律是拿 (A) 的成績去背書 (B) 的做法。

## 1. 反面側：第一手，而且直接命中 (B)

**Huang et al., "Large Language Models Cannot Self-Correct Reasoning Yet", ICLR 2024**（[arXiv:2310.01798](https://arxiv.org/abs/2310.01798)，2026-09-01 讀 abs 頁）。摘要原文：

> "LLMs struggle to self-correct their responses without external feedback, and at times, their performance even degrades after self-correction."

兩件事要分開記：(1) 沒有外部回饋時自我修正**幫不上忙**；(2) **有時候會變差**。作者明確把有外部回饋的那一類排除在這個否定結論之外。

這篇直接打在 #16 的 (B) 上。

## 2. 支持側：兩篇最常被引的，其實都不是 (B) 的證據

**Reflexion（Shinn et al., [arXiv:2303.11366](https://arxiv.org/abs/2303.11366)，讀 abs ＋ HTML 全文）。** 摘要說它「flexible enough to incorporate various types (scalar values or free-form language) and sources (**external or internally simulated**) of feedback signals」—— 也就是說它是個框架，(A) 與 (B) 都塞得進去。**關鍵在它的 coding 實驗用的是哪一種**，而全文說得很清楚：

> "The task of programming presents a unique opportunity to use more **grounded** self-evaluation practices such as **self-generated unit test suites**."

流程是 CoT 生測試 → 過濾語法有效的 → **執行** → 用通過與否當訊號。**那是 (A)。** 拿 Reflexion 在 HumanEval 上的成績去支持「每步多一次 LLM 自評」是誤引。

作者自己還列了這條路的限制：測試生得不好會造成 false positive（錯的程式碼通過全部測試），讓 refinement loop 提早收工。

**Self-Refine（Madaan et al., [arXiv:2303.17651](https://arxiv.org/abs/2303.17651)，讀 abs）。** 這篇**是**純 (B)：「uses a single LLM as the generator, refiner, and feedback provider」。但它的評估範圍是「7 diverse tasks, ranging from dialog response generation to mathematical reasoning」—— **不含 repo 級的軟體工程任務**。（abs 頁沒有列出完整 7 項清單，本文不宣稱那 7 項各是什麼。）

## 3. 支持側：真的有一篇支持 (B)，但適用範圍要看清楚

**"Enhancing LLM Planning Capabilities through Intrinsic Self-Critique"**（[arXiv:2512.24103](https://arxiv.org/abs/2512.24103)，讀 abs 頁）。這是本次調研找到的**唯一一條直接支持 (B) 的第一手證據**，而且它是衝著 Huang et al. 那條線來的：明說「without external source such as a verifier」，critique 完全來自模型自己。

- **成績**：在 **Blocksworld、Logistics、Mini-grid** 三個 planning 域上「significant performance gains」，宣稱在所考慮的模型類別上達到 new state-of-the-art。
- **範圍**：那是 **planning benchmark，不是軟體工程任務**。沒有 SWE-bench、沒有 repo 級修改。
- **模型世代**：abs 說的是 2024 年 10 月的 LLM checkpoints。

（PDF 全文抽取失敗，上面只用 abs 頁的內容；增益的具體數字、與 Huang et al. 的正面對話、消融設計都**未驗**。）

**怎麼讀這條證據**：它證明的是「在有明確狀態空間與正確性定義的 planning 域裡，(B) 可以有增益」。nexus 的任務域是**在真實 repo 上改程式碼**，那裡有真的 type checker、真的測試、真的 linter —— 也就是 (A) 的訊號到處都是。這篇沒有證明「(A) 已經在的地方，(B) 還有增量」。那正是 #16 要的那一步，而它沒有被任何人證過。

## 4. 基座的官方立場：有 reflection，而且兩種都擺出來

**這裡要更正一個容易寫歪的說法。** 子代理的結論是「基座不提供這個功能，要加得自己實作」—— npm 套件那句成立（見上面的複核），但 **LangChain 官方另外發了一個 `langgraph-reflection` 套件**（[github.com/langchain-ai/langgraph-reflection](https://github.com/langchain-ai/langgraph-reflection)，2026-09-01 讀 README）。所以「基座官方不推 reflection」是**假的**，不能拿來當論據。

它的架構是 main agent ＋ critique agent 互相循環。而 README 給的兩個範例，剛好就是本文那條軸的兩邊：

- **LLM-as-a-Judge** —— 另一個 LLM 依 accuracy / completeness / clarity / helpfulness / safety 評分。**這是 (B)。**
- **Code validation** —— 跑 **Pyright** 做靜態型別檢查，把錯誤回給 main agent 修。**這是 (A)。**

**README 沒有給「什麼時候該用哪一種」的準則**，兩個並列。這對 #16 的意義是：基座官方確實提供了 (B) 的做法，但它同時提供了 (A)，而且沒有主張 (B) 更好 —— 這不是背書，是把選擇留給你。

## 5. 生產級 coding agent：實際上怎麼做

**SWE-agent**（[arXiv:2405.15793](https://arxiv.org/abs/2405.15793)，讀 abs 頁）。論文的貢獻是 **agent-computer interface (ACI)** —— 「significantly enhances an agent's ability to create and edit code files, navigate entire repositories, and **execute tests and other programs**」。研究的問題是**介面設計**怎麼影響 agent 表現，abs 裡**沒有**自我批判機制。（全文的逐節查證未做；本文只宣稱 abs 的內容。）

**OpenHands Software Agent SDK**（[arXiv:2511.03690](https://arxiv.org/html/2511.03690v1)，讀 HTML 全文，第一方論文）。三件事直接對上 #16：

- **迴圈裡沒有專門的自我批判階段**。它是 event-driven 的 action–observation 迴圈：「Agents execute through an event-driven loop that processes conversation state step-by-step.」
- **沒有前置意圖分類器**。它有 sub-agent，但那是**當工具呼叫的委派**，不是主迴圈上游的路由器：「Sub-agents operate as independent conversations that inherit the parent's model configuration and workspace context」。
- 它有的是 **condenser**（上下文壓縮，預設 `LLMSummarizingCondenser`）與**安全／批准閘門**（高風險動作要人確認）。後者是 (A) 那一側 —— 判準來自人。

**dsh**（本地唯讀 clone，SHA `0a53fb55bea101816fa226bb964ae2bed71c343b`）：三個相關套件 `packages/plan/plan-mode/`、`packages/todo/tool-todo/`、`packages/goal/goal/` 的 README 都不是評估器 —— plan mode 是「先探索設計、把完成的計劃交人批准」（判準是人），goal 是狀態容器，todo 是清單工具。**沒有 (B)。**

**一條反面的實務數據**（來源為搜尋摘要轉述，**未讀原文，可信度低，僅供反問**）：有工作報告 SWE-Bench-Verified 上 88.0% 的軌跡含顯式 self-verification（生測試、迭代改 patch），而其中 35.7% 仍然沒產出正確 patch。若屬實，它說的是「單軌自我驗證不夠」，而那已經是 (A) 那一側的自我驗證了。**要用這個數字之前必須先找到原始論文。**

## 6. Intent plugin 那一半

#16 要的是「**先於主迴圈**判斷任務類型並路由」。

**實務側是反的。** OpenHands 第一方論文裡沒有這種上游分類器（見上）。而 **Agent-as-a-Router**（[arXiv:2606.22902](https://arxiv.org/abs/2606.22902)，讀 abs 頁）雖然名字像，路由的其實是**模型**不是意圖 —— 而且它的核心主張正好是在批評靜態前置分類：

> "Existing routers treat this as a **static, one-off classification** problem."

它的解法是改用執行過程累積的證據（C–A–F 迴圈：Context → Action → Feedback → Context），並報告加上表現統計後有 15.3% 的相對增益。**這對 #16 的形狀是反面證據**：把判斷放在迴圈前面、只做一次，正是它指認的瓶頸。

**有一個條件成立時前置分類是划算的**：工具數量爆炸。找到的說法是「417 tools 時讓 LLM 自己選會掉到 20% 準確率」，但**那個數字來自部落格（二手），沒有回溯到第一手實驗，不可採信為事實**。即使它成立，nexus 目前全樹 `tools.register(` 的呼叫點是 **14 個**（`grep -rn --include="*.ts" "tools.register(" packages apps`，排除 node_modules 與測試），差了一個半數量級。**這個強化的觸發條件在我們這裡不成立。**

## 對 #16 的建議

**關掉，理由記在卡片上。** 不是「dsh 沒有所以不能做」那種規則式的理由 —— 是下面三條：

1. **卡片的前提誤讀了現狀。** #16 把反思層寫成「薄覆蓋、先以最小可行方式處理」，指的是「只有結果校驗 middleware（schema 驗證＋失敗回饋重試）與 LangSmith 追蹤」。但那不是權宜之計，**那就是有效的那一種**（(A)）。#16 想加的是自評版本 (B)，而 (B) 唯一命中的第一手否定證據（Huang et al.）說它在沒有外部回饋時不但沒用、有時更差。

2. **最常被拿來支持它的證據不支持它。** Reflexion 在 coding 上跑的是自生成單元測試的**執行結果**，作者自己稱之為 more grounded self-evaluation —— 那是 (A)。Self-Refine 是純 (B)，但沒有評過 repo 級軟體工程。唯一真正支持 (B) 的（arXiv 2512.24103）是 planning benchmark，而且**沒有回答「(A) 已經在的地方 (B) 還有沒有增量」**。

3. **Intent 那一半的觸發條件不成立**，而且它的形狀（前置、一次性分類）正是 Agent-as-a-Router 指認的瓶頸。

**不建議改寫成「用 eval 證偽的實驗」。** 現有判準有已知的鈍化問題（見記憶：判準鈍化的兩個來源、簡單題會稀釋平均），跑出來的 null result 兩邊都證明不了，只會把「沒證出來」誤讀成「證明沒有」。

**#16 底下唯一還開著的東西是一張驗證卡**：`packages/nexus-plugin-plan-mode/src/index.ts:9` 寫著「`TodoListMiddleware` 已經蓋掉 todo 那塊」，但全樹零處引用它，而 deepagents 的型別檔明寫 “Add `todoListMiddleware` explicitly to opt in.”（`apps/harness/node_modules/deepagents/dist/agent-D50BBbJT.d.ts:1604`，那句話出現在 **subagent spec** 的說明裡，主 agent 的預設 middleware stack 有沒有帶它**未驗**）。那是一張驗證卡，還不是實作卡。

**如果將來要重啟 (B)**，重啟的條件應該寫成可否證的形式，而且不是「加了會不會變好」，是：**在 (A) 的訊號已經接滿的路徑上，(B) 是否還有增量** —— 那才是 #16 真正在賭的那句話，而目前沒有任何一份第一手證據碰過它。

## 沒做的事（不要當成已驗）

- **Aider、Cline、Goose 的原始碼**：完全沒讀，本文對它們零宣稱。
- **Stechly et al.、Valmeekam et al.、CRITIC**：只知道名字，未讀原文，本文不引用它們的結論。
- **arXiv 2512.24103 的全文**：PDF 抽取失敗，只用了 abs 頁。增益數字、消融、與 Huang et al. 的正面對話都未驗。
- **SWE-agent 的全文**：只讀 abs 頁（PDF 抽取那次不可信，見開頭）。
- **SWE-Bench-Verified 88.0% / 35.7% 那組數字**：來自搜尋摘要，未找到原始論文。
- **主 agent 的預設 middleware stack 含不含 `todoListMiddleware`**：只驗到 subagent spec 那句話。
