# chat-agent 對話完成框架調研計劃

**日期**：2026-09-26　**分支**：`docs/arxiv-chat-agent-research`

## 目標

把「AI Agent Dialogue Completion Framework」圖上的 8 個節點各自讀透：每個節點**至少 20 篇**有影響力、或有商用採納證據的 arXiv 論文，**全文精讀**，濾掉水論文。最後把節點之間的 6 條邊（圖上的虛線與點線）也講清楚，因為這個框架特有的價值在邊上。

使用者拍板的兩件事：

- **Agent Observation 兩種讀法都要，按配額切**：計入的 20 篇中約 12 篇講「agent 怎麼感知環境」（觀測空間），約 8 篇講「怎麼觀測 agent」（可觀測性與監控）。
- **純研究**：各章不附「對 nexus 的意涵」。

## 8 個節點與範圍

每個節點的完整定義（包含什麼、排除什麼、子領域配額）在 [`data/topics.json`](data/topics.json)。這裡只列骨架與最容易漂移的界線。

| 節點 | 一句話範圍 | 最容易跟誰混 |
| --- | --- | --- |
| T1 Goal Alignment & Intent Detection | 判斷使用者要什麼：意圖偵測、澄清提問、目標推斷 | 不收 AI 價值對齊 |
| T2 Multi-Turn State Tracking (DST) | 多輪中狀態的表示與維護：傳統 DST 與 LLM 時代 | 長期個人化記憶不收 |
| T3 Agent Observation | (a) 感知：環境回饋怎麼進 agent；(b) 可觀測性：怎麼觀測 agent | (b) 與 T4 的界線：即時監控歸 T3，事後的軌跡分析歸 T4 |
| T4 Agent Trace / Trajectory | 把一次執行當資料：收集、合成、失敗歸因、步驟級評分 | benchmark 設計歸 T7 |
| T5 Self-Correction & Reflection | 發現並修正自己的錯：內在反思、外部回饋、訓練出來的修正 | 一般 CoT 不收 |
| T6 User Simulator & Feedback Loop | 模擬使用者與利用使用者回饋 | 只把使用者模擬當一環的 benchmark 歸 T7 |
| T7 Agent Evaluation | **怎麼評**：環境、互動式評估、judge 與評估可靠性 | 分數定義歸 T8 |
| T8 Task Completion Score | **分數怎麼定義與聚合**：成功判準、pass^k、部分分數、多目標 | 環境設計歸 T7 |

圖上的邊（留到 W3 綜合時處理）：

| 邊 | 從 → 到 | 意思 |
| --- | --- | --- |
| E1 External Input | T6 → T1 | 使用者（模擬器）的輸入進入目標對齊 |
| E2 State Adjustments | T5 → T2 | 反思修正的結果回寫對話狀態 |
| E3 Anomalies Detected | T4 → T5 | 軌跡偵測到異常時觸發修正 |
| E4 Nominal Path | T4 → T6 | 正常路徑繼續與使用者互動 |
| E5 Correction Logs | T5 → T7 | 修正紀錄回流評估 |
| E6 Interaction Logs | T6 → T7 | 互動紀錄回流評估 |

## 篩選標準（可稽核）

**硬閘門**：每一個 arXiv ID 都要經 [`tools/arxiv_tool.py`](tools/arxiv_tool.py) `resolve --check` 解析、並比對標題（相似度 ≥ 0.85）。不符就丟。這一關是程式在擋，不是靠 agent 自律 —— agent 憑記憶或從綜述抽出來的 ID 一定有一部分是錯的。

**影響力訊號**（每篇都要記下數字，不寫形容詞）：

| 訊號 | 來源 | 用法 |
| --- | --- | --- |
| 引用數、年均引用、influentialCitationCount | Semantic Scholar batch API | 同一節點內相對排序；舊領域（例如傳統 DST）的絕對數字本來就小 |
| 發表處 | S2 venue + arXiv comment／journal_ref | 頂會／頂刊正式論文加分，workshop 扣分 |
| 商用採納 | model card、產品文件、主流框架或廣泛採用的 benchmark | **必須附具體證據與連結**，不能寫「業界廣泛使用」 |

2025–2026 的新論文引用數還少，只能靠「頂會正式論文」或「商用採納證據」入選，而且要附證據。

**水論文的判準**（符合就不收，落選理由逐篇記錄）：以年齡來說引用數低又沒有頂會；只是換個 prompt、評估又小；沒有基準線或消融；只在自建的小資料集上有結果；不能重現、也沒人採用；綜述只是重述、沒有新的分類。綜述每個節點最多 2 篇，而且必須是高引用的。

**不做沒交代的截斷**：候選、入選、落選、候補都存檔，落選附理由。

## 計數規則：什麼才算「讀了一篇」

一篇論文要計入某節點的 20 篇，必須**全部**成立：

1. **主節點是這個節點**。同一篇論文只會被指派給一個主節點、只精讀一次；別的節點可以引用它，但不計入別的節點的 20 篇。所以 8 × 20 是 **160 篇不重複**的論文。
2. **讀到全文**（`level=full`，來源是 arXiv HTML 或 ar5iv）。只拿得到摘要的不計。
3. **精讀後沒有被判成低價值**。讀了才發現是水論文的，如實標出，不計。
4. **錨點驗證通過**：筆記裡每個關鍵數字與主張都附一小段原文錨點，由 `arxiv_tool.py anchors` 對快取全文做字串比對，至少 3 個 exact，**而且其中至少 2 個落在全文 20% 之後**。試跑時閱讀 agent 的錨點全取自摘要與引言，那樣驗不到方法與實驗的主張，所以加了深處的門檻。

計數由 [`tools/check_notes.py`](tools/check_notes.py) 重跑錨點比對算出，不採用閱讀 agent 自己回報的數字。

湊不滿 20 就先讀候補；**候補讀完還是不足，如實報缺口，不降標準填數字**。

## 執行方式：三支 workflow，每支之間停一次

一支 workflow 從搜尋跑到綜合的話，shortlist 選錯會讓後面兩百個精讀全部白做。所以分三段，每段跑完我先看結果再開下一段。

| 階段 | 做什麼 | agent 數（估） |
| --- | --- | --- |
| **W1 發現與篩選** | 每個節點 3 路並行找候選（綜述 snowball、arXiv 關鍵字、商用採納），每路都先過 ID 閘門；再 1 個篩選 agent 查引用數、依標準排出 24 主選加 6 候補；最後做跨節點去重，由 1 個仲裁 agent 決定共用論文的主節點 | 8×3 + 8 + 1 ≈ **33** |
| **W1b 重新篩選** | W1 的篩選 agent 轉抄的數字不可信、寫在 prompt 裡的規則沒人擋，所以改成程式建候選池（[`tools/pool.py`](tools/pool.py)）算數字與硬旗標，agent 只做範圍判斷，另有反方 agent 挑錯 | 8 篩選 + 8 反方 + 1 仲裁 |
| **人工複核** | W1b 的結果過 [`tools/build_shortlist.py`](tools/build_shortlist.py) 閘門仍有系統性問題（仲裁判錯節點、高引用但離題的論文混入、經典漏收），由我逐節點審查，每篇的歸屬與理由寫在 [`tools/review_overlay.py`](tools/review_overlay.py) | 0 |
| **W2 精讀** | 一篇一個 agent（全文 40–80k tokens，一個 agent 塞多篇會擠爆 context）。讀全文、寫結構化筆記、交錨點；主選讀完不足 20 再讀候補 | 8×24 + 候補 ≈ **200–240** |
| **W3 綜合與驗證** | 每節點一章；對抗式查核每章的主張是否有筆記支持；能用程式驗的主張寫程式驗；最後一份跨節點綜合，處理 6 條邊；再由一個 completeness critic 問「缺了什麼」 | 8 + 8 + 1 + 1 ≈ **20–30** |

合計約 **260–300 個 agent**。成本大頭在 W2。模型全部沿用 session 預設，搜尋、解析這類機械性步驟用低 effort。

**helper 的角色**：S2、arXiv API、HTML 全文這三種請求全部走 `tools/arxiv_tool.py`。每個主機一次只有一個請求（檔案鎖），請求之間有最小間隔（arXiv API 3 秒），429 時指數退避，結果按 ID 快取。幾十個 agent 同時跑也不會把 arXiv 或 S2 打爆。

**驗證程式碼**：只驗能用確定性方法驗的主張，例如 pass@k 與 pass^k 的關係、JGA 與 slot accuracy 的差別、judge 一致性的 kappa。放在 [`verify/`](verify/)，只用 Python 標準函式庫，不碰 `apps/`、`packages/`，也不進 pnpm workspace。

## 產出結構

```
.docs/chat-agent-research/
├── plan.md                 這份計劃
├── README.md               入口：各章索引與跨節點綜合（W3）
├── chapters/NN-<slug>.md   每節點一章（W3）
├── data/
│   ├── topics.json         8 個節點與 6 條邊的定義
│   ├── pool/               每節點的候選池：來源、S2 數字、旗標（W1b）
│   ├── candidates/         每節點全部候選與篩選決定
│   ├── w1b-result.json     W1b 篩選 agent 的原始結果
│   ├── review-final.json   人工複核後交給閘門的最終輸入
│   ├── shortlist.json      去重後的最終名單：主選與候補
│   └── reading-status.json 每篇精讀的計數結果（W2，check_notes.py 產出）
├── notes/<arxiv-id>.json   每篇精讀筆記（W2）
├── verify/                 驗證程式碼（W3）
├── tools/                  arxiv_tool.py（arXiv／S2）、pool.py、build_shortlist.py、review_overlay.py、check_notes.py
└── .cache/                 全文、API 快取與錨點原文（不進版控）
```

**版權**：全文快取與錨點原文只存在 `.cache/`（gitignore），進版控的筆記與章節只寫轉述、數字與章節位置，不貼大段原文。

## 誠實標記

每章的文獻表都標讀到的層級：✅ 全文精讀並通過錨點驗證 ／ 📖 全文但錨點未全過 ／ ❌ 只有摘要。只有 ✅ 計入 20 篇。

每支 workflow 跑完就 commit 一次，讓成果持續落地。
