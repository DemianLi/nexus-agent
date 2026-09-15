# 把 nexus 接進 Proteus 做自進化 —— 那張架構圖、原始碼、與我們的兩題

這份筆記回答三個問題：Proteus 官方那張架構圖上的每一格**在 v0.3.0 有沒有實作**；把我們的
harness 接進去**要做什麼**；接進去**我們拿得到什麼**。

上游是 [Proteus](https://github.com/proteus-evolve/Proteus)（`proteus-evolve/Proteus`，Python
3.10+、MIT、v0.3.0、自標 research preview）。它與 [dsh](https://github.com/deepseek-ai/deepseek-harness)
的關係在 [`plugin-architecture-gap-survey.md`](plugin-architecture-gap-survey.md) §四 講過：
**dsh 是 harness，Proteus 是量 harness 的儀器，兩者不同層**；本檔是那一節的後續，只談「接進去」
這件事。

**調研日期**：2026-09-15。對讀版本：Proteus `962304b320c57475227f056f52a71f3cd3d437f0`
（main，2026-08-28）—— 與 9/02 那份調研同一個 SHA，所以兩份可以並讀。clone 在
`references/Proteus`，不進版控（`.gitignore` 與 `.prettierignore` 都排除 `references/`）。

那張架構圖是上游 repo 裡的 `docs/assets/proteus-architecture.png`（同 SHA），由
`web/static/index.html:243` 當成 hosted playground 的「print version」引用。**圖檔不抄進本 repo**
—— `.docs/` 今天沒有任何二進位，連過去就夠。

## 這份筆記的來源與可信度

| 區塊 | 誰做的 | 核對狀況 |
| --- | --- | --- |
| 圖逐格對程式碼（§二） | 主代理讀 | 第一手；`proteus/core/{adapter,goal,episode,budget}.py`、`proteus/adapters/dsh.py`、`proteus/measure/*.py`、`docs/{ADAPTERS,EPISODE,MEASUREMENTS,RECIPES}.md`、`ROADMAP.md`、`web/static/index.html` |
| 改善迴圈存不存在（§三） | 主代理讀 | 第一手；**這一節是一個改正**，見下 |
| 契約 × 我們現況（§四） | 主代理讀 | 第一手；每一列都給我們這側的檔名或行號 |
| 拿得到什麼、幫不到什麼（§五、§六） | 主代理 | 判斷，不是事實；理由逐條附出處 |
| 規模與成本（§七） | 主代理 | **次數是算的，錢與時間是未量**，見該節 |

**一個被推翻的宣稱，記在這裡而不是刪掉**：討論的第一輪我寫過「Proteus 不會讓 harness 變好，
它是 measurement instrument 而不是 optimizer」。**那句話錯了** —— `selection="accept_reject"`
是一個貨真價實的爬坡外迴圈，benchmark 當目標是一級用法。改正與仍然成立的較窄版本在 §三。

## 一、結論

**那張圖是願景圖，不是 v0.3.0 的實作圖。** 圖上十一格：✅ 五格、⚠️ 四格（其中一格連名字帶語意
一起換了）、❌ 一格。最大的落差在演化迴圈的第 2 格與它右邊那塊：圖上寫 `PURPOSE`（「推斷目的、
設定目標、形成演化方向」）＋ 一整格 `GOAL SELECTOR`（「提議、排序、選出下一個探索階段的目標」），
**而程式碼的第二個 phase 叫 `propose`，提的是「改自己 harness 的方案」，並且整個 repo 沒有任何
提議或排序目標的機制**。目標是呼叫端給的常數。

**它真的會讓 harness 進化，而且有爬坡外迴圈。** 這是 §三 那個改正。但改善是 **opt-in**
（預設不開）、**貪心**（低於 best-so-far 就拒、被拒的不帶往下一輪）、而且**落在 run-local 的
那份拷貝上**（上游 checkout 明文不動）。

**對我們有兩題，而第一題是第二題的全部前置。** 研究題：無目標，看 agent 會不會動我們的執行期
組裝面，還是只寫筆記。工程題：把 `apps/harness/src/eval/` 那套包成 evaluator ＋ `accept_reject`，
當一個隔離的 harness 改動提案產生器。第一題跑完，第二題只差一個 evaluator。

## 二、那張圖逐格對程式碼

先講一件圖本身沒說、但同一份 repo 自己說了兩次的事。**海報與程式碼對自己的描述不一樣**：

- 海報標題：`A Framework for Self-Evolving Agents`，標語 `CONTINUOUSLY EVOLVE. ADAPT
  EXPONENTIALLY. BECOME MORE.`
- 同一個 hosted playground 頁面，上一節的標題是 **`The instrument`**（`web/static/index.html:206`），
  而那頁的互動迴圈 SVG 的 `aria-label` 是 **`"observe, propose, act, reflect cycle"`**（`:234`）——
  不是 purpose。
- README 的「Why Proteus is different」第三點：`A measurement instrument, not just a score`。

也就是說「海報是願景敘事、程式碼與互動頁是儀器」這個判斷不是我們推論出來的，**是它自己兩處
文字的差別**。

| 圖上那一格 | v0.3.0 的對應 | 判定 |
| --- | --- | --- |
| **1 OBSERVE** | `PHASES = ("observe", "propose", "act", "reflect")`（`proteus/core/budget.py:14`） | ✅ |
| **2 PURPOSE**「推斷目的、設定目標、形成演化方向」 | 第二個 phase 叫 **`propose`**，README 對它的說明是 *list ways to **improve your own harness***。`purpose` 這個詞在整個 repo 的 `.py`／`.md` 裡只以無關的 "on purpose" 出現 | ⚠️ **換名也換了語意**：propose 提的是改 harness 的方案，不是目標 |
| **3 ACT** | `PHASES[2]`；`docs/EPISODE.md` 的四 phase 交易 | ✅ |
| **4 REFLECT** | `PHASES[3]`；邊界閘門在 reflect **之後**才跑 | ✅ |
| **GOAL SELECTOR**（提議／排序／選目標；Diverse・Novel・Valuable・Feasible） | **找不到對應**。`goal selector`／`propose_goal`／`select_goal` 全部零命中。目標是呼叫端給的常數（`GoalConfig.no_goal()`／`of()`／`single()`／`multi()`，`proteus/core/goal.py`），一個 run 的 goal 進 `manifest.json` 的**不可變** condition。`selection` 的型別註解寫 `"none" \| "accept_reject" \| "rank"`（`goal.py:129`），但 **`rank` 沒有實作** —— `episode.py:587` 是唯一的分派點，只認 `accept_reject` | ❌ 沒有 |
| **PREFERENCE INJECTOR**（Human Feedback・Preferences・Constraints） | `Disposition`：**單一、可移除**的動作偏好擾動，t=0 裝一次，載體 prompt／config／patch 三選一；`install_disposition` ＋ `disposition_fingerprint` 保證可移除，`proteus check` 兩個方向都驗 | ⚠️ 有，但比圖窄得多：它是**一次性的實驗擾動**，不是持續注入人類回饋的通道 |
| **RULER / EVALUATOR**（多維：Correctness・Safety・Helpfulness・Efficiency） | 契約有：`(trace, ctx) -> EvalResult`，四欄位、`HIDDEN`／`OBSERVE` 兩種可見度。**但那四個維度一個都不內建** —— `correctness`／`helpfulness`／`efficiency` 在 `.py` 裡零命中。內建三個是 `surface_units(surface)`、`tool_calls()`、`structural_step(surfaces)`（`proteus/core/evaluators.py`，CLI 形式 `units:<surface>`／`tool-calls`／`step`） | ⚠️ 框架有、維度要自己帶 |
| **HARNESS ADAPTOR**（AKi・DeepSeek・Custom） | 七方法 ＋ 三旗標的 `HarnessAdapter`（`docs/ADAPTERS.md:40-58`）。**內建五個** adapter：`minimal`／`llm`／`dsh`／`pi`／`aki` —— 圖上少畫了 `pi` 與兩個 built-in。`aki` 是「paper 的頭條實驗跑的那個 harness」（`adapters/aki.py` 檔頭） | ✅ 有（圖畫少了） |
| **SANDBOX MANAGEMENT** | `LocalSandbox`（信任）／`DockerSandbox`（OS 級隔離、網路可調）。明文：會自己寫並執行程式碼的 agent，**應用層檔案沙箱關不住**，所以真 harness 一律 Docker | ✅ |
| **AGENT EVOLUTION**（Current → Evaluation → Code Rewrite → Validation → New Harness → Deploy & Replace） | **圖上跟程式碼最貼的一列**：staged activation（`EpisodeSpec.active_root` 唯讀掛 `/workspace`、可寫 candidate 掛 `/workspace/candidate`）、`validate_candidate()` 模型無關閘門、晉升／保留＋還原的交易語意（`docs/EPISODE.md` §8：被拒的 tree **先 commit 進 history** 再 `git restore` 回上一個 accepted，然後 `clean -fdx`） | ✅ |
| **OBSERVABILITY & DATA LAYER**（Trajectory Store・Metric Store・Artifact Store・Experiment Tracking・Logging & Telemetry） | **全部是檔案，沒有 store 服務**：`traces/epNNN.json`（adapter 擁有）、`progress/<run-id>.jsonl`（**必須在 run root 之外** —— 受量主體讀得到自己的 run root）、`.snapshot.git`（episode 0 ＋ 每個完成的 episode 恰好一個 commit，無斷號）、`.proteus-records/<run-id>/{eval_history.json,disposition_fingerprint.json}`、`manifest.json`／`seeds.jsonl`；`proteus watch` 出一份自帶的 `report.html`。**沒有遙測子系統** —— `environments/README.md:67` 反而要求把受量 harness 自己的遙測關掉（`DSH_TELEMETRY_MODE=DISABLED`） | ⚠️ 語彙是 store，實作是檔案樹 |

**小計**：✅ 5、⚠️ 4、❌ 1（另有「圖畫少了 adapter」一項不算落差）。

**判斷：這張圖可以當路線圖讀，不能當 API 讀。** 如果我們的研究題需要「自動提議與排序目標」
（`GOAL SELECTOR`）或「持續注入人類回饋」（`PREFERENCE INJECTOR` 的完整版），那兩塊要自己寫；
框架今天給的是「一個 run 一組固定目標 ＋ 一次性可移除擾動」。

## 三、它會不會讓 harness 變好 —— 一個改正

**改善的機器真的在那裡**，逐條有出處：

- **默認的 episode 協議本身朝改善去**：propose 那格的原文是 *list ways to improve your own
  harness*，act 是動手改，reflect 是決定留什麼。
- **`selection="accept_reject"` 是爬坡外迴圈**：平均分數低於 best-so-far 就拒（`docs/EPISODE.md:245`），
  拒了非破壞性地還原（同檔 §8）。
- **`Visibility.OBSERVE` 是內迴圈回饋**：上一輪分數進下一個 episode 的 observe prompt，被拒還附
  一句「你的改動沒有留下」。
- **benchmark 當目標是一級用法**：`docs/RECIPES.md` 的「A benchmark as the goal」，`local:`／
  `polyglot:`／SWE-bench 都有；`<run>/task/` 是練習題而非受量主體，不隨 harness 被拒而回滾。
- **通過閘門的 candidate 下一個 episode 真的成為控制中的 harness**，不是模擬；演化結果是
  `.snapshot.git` 上可 `snapshot.materialize` 取回的產物。

**仍然成立、但範圍比我原話窄的三件**：

1. **改善是 opt-in。** `GoalConfig.selection` 預設 `"none"`（`goal.py:129`），`EvaluatorSpec.visibility`
   預設 `HIDDEN`，`no_goal()` 是他們論文條件的第一個 preset。什麼都不配就跑，拿到的是無壓力漂移
   ＋ 量測。
2. **爬坡是貪心的，而分數是無權平均。** `docs/MEASUREMENTS.md:133` 明文：`accept_reject` 取**所有
   掛上的 evaluator 分數的無權平均**，並警告不要混未正規化的尺度 —— 把通過率跟 `units:notes`、
   `tool-calls` 這類計數混在一起，外迴圈就在優化一個沒有意義的合成量。加上「valid but
   lower-scoring 的 selection 拒絕不往下帶」（`EPISODE.md` §8），所以沒有探索預算，多樣性只能靠
   seeds／arms 買。
3. **變好的是 run-local 那份拷貝，不是我們的 repo。** `docs/ADAPTERS.md`：*the upstream repository
   stays pinned and untouched*。Proteus 沒有合併回上游的路；要拿回來是我們自己 materialize、讀
   diff、人工挑。**這對我們是好消息**：它等於一個隔離的提案產生器，產出照常走我們的 PR 與 gate。

**還有一個更要緊的區別**（這一條決定工程題的成本）：Proteus 內建的 benchmark evaluator 量的是
「**agent 在這個 episode 把那份 task 做得多好**」（`polyglot:bowling` 評的是 `<run>/task/` 的產出），
**不等於「演化後的 harness 在一組任務上變好了」**。後者要在 evaluator 裡拿候選 harness 再跑一遍
基準，而框架沒有內建這個形狀 —— 三個內建 evaluator 都是內在量，不重跑 harness。機器其實有
（`measure/crystallize.py` 就是透過同一個 adapter 驅動探測 episode），但它用在行為保真度，不在
評分。**要自己接，代價是每個 episode 多一次完整基準跑。**

## 四、接進來要做什麼

adapter 是七方法 ＋ 三旗標。逐項對我們今天的樹：

| Proteus 要的 | 我們今天 | 缺口 |
| --- | --- | --- |
| 無頭一次性入口（一個 episode 跑得起來、跑得完） | `apps/harness/src/cli.ts`：`--live --workspace --sandbox --session-log "<話>"`，跑完退出 | ✅ |
| `read_trace` 從 harness 自己的日誌解析（**明文禁止為了測量往 harness 加儀器**，`ADAPTERS.md:112-115`） | jsonl **原始行、不壓縮** —— `jsonl-session-store.ts` 檔頭選 JSONL 的三條理由之一就是「未來 Proteus 的 `read_trace` 解析的就是 jsonl」；有 `tool/call`／`tool/result`／`assistant/message` | ✅ 比 dsh 省一層：dsh 那側要 zstd 部分解碼（`adapters/dsh.py` 的 `_zstd_partial`） |
| 日誌落在受量樹之外 | `resolveSessionLogDir` 拒絕 `--workspace` 之內或之下（[#170](https://github.com/DemianLi/nexus-agent/issues/170) 的「歷史是基礎建設，不是 agent 的工作區」） | ✅ 同一條約束兩邊各自到達 |
| `validate_candidate()` 模型無關的可行性閘門 | `cli.ts` 檔頭那條「三件事刻意留給錯誤自己說話」：清單載不起來、fold 前置不成立、基座擋下組裝 → 原樣進 stderr、非零退出 | ✅ **我們最強的一格** |
| `install_disposition` 可移除的載體 ＋ `disposition_fingerprint` | memory plugin 讀 `/AGENTS.md`（`DEFAULT_MEMORY_SOURCE`），跟 dsh 一樣走標記區塊 ＋ `disposition_in_files = True`；指紋用上游通用的 `adapters/instructions.py::block_fingerprint` | ✅ 現成，指紋不用寫 |
| `surfaces()` 宣告成資料 | memory `/AGENTS.md`、skills `/skills/` 是 **backend 命名空間**路徑，要配 `--workspace`（`ContainedFilesystemBackend`）才落到真實磁碟 | ⚠️ 要宣告 |
| Docker 環境映像（釘死、state 只走 mount） | **repo 裡一個 Dockerfile 都沒有** | ❌ 要寫 |
| `staged_activation` ＋ active／candidate 雙 mount | 無 | ❌ 要做 |
| `seed()`（episode 0 的狀態 ＋ 指令檔裡點名每個 surface） | 無 | ❌ 要寫 |
| `continuity_mode` | 我們有 `--resume <run 目錄>`（沙箱模式、目標、計劃模式、對話都照日誌回來）→ 可宣告 `native`；dsh／pi 宣告 `framework` 並用 `HandoffStore` | ⚠️ **是一個決定，不是預設** —— 見下 |

**adapter 那側的代價**（9/02 那份 §4.5 預告過，這次重新核了）：他得**明著傳 `--session-log`**
（我們沒有 `DSH_HOME` 那種「不給旗標日誌也會出現在已知目錄」的設計，那是
[#172](https://github.com/DemianLi/nexus-agent/issues/172) 明文的選擇、
[#174](https://github.com/DemianLi/nexus-agent/issues/174) 決定維持），而且 run 目錄命名
`<ISO 時間戳>-<uuid8>/`（`jsonl-session-store.ts:566`）要餵得進他的 glob。**這不是缺口，是規格。**

**`continuity_mode` 那一格值得當決策登記**：`native` 讓四個 phase 看到完整對話（更像我們產品路徑
真正的樣子），`framework` 只讓一份有界的 handoff 過去（更可比，而且上游明文「never persist raw
model reasoning or tool results」）。這個選擇會改變量出來的東西的意義。

**「自我」是哪一塊 —— 兩條路**：

- **路線 A（執行期組裝面）**：surface ＝ `instructions`（AGENTS.md）＋ `notes/` ＋ `skills/` ＋
  **plugin 清單**。`--plugins <module>` 收的就是一個檔案路徑，約定薄到只有一句「預設匯出是一個
  plugin 陣列」（`cli.ts` 的 `loadPluginModule`）—— 也就是**我們的清單今天已經是一個 agent 寫得動
  的檔**。image 裡放 built 好的 `@nexus/*`，不必 rebuild、不必 offline pnpm store。
  `validate_candidate` ＝ 用 candidate 的清單跑一次 load-only。
- **路線 B（源碼面，照 `environments/dsh-src/`）**：把 `packages/` ＋ `apps/` 的 TS 抽進
  `harness/src/`，boot 時同步、hash 變了就用專案自己的 toolchain 重建、輸出 cache 在 `/state`。
  我們跟 dsh 同形（TS ＋ pnpm workspace），那 39 行 Dockerfile ＋ 204 行 `boot.sh` 幾乎可以照搬；
  代價也一樣（baked offline store、`pnpm-lock.yaml` 要一致、他們量到一次全建約 330s、閘門 timeout
  設 900s）。

**建議先 A。** 理由三條：A 的閘門我們已經有了（上表第四列），B 的要現造；Proteus 快照時**關掉所有
ignore 規則**（`docs/EPISODE.md`），所以 B 會踩上 dsh 得在 seed instructions 明文禁止 `node_modules`
的同一顆雷；而 A 量的正好是我們架構的主張。

**一個要先知道的顆粒度限制**：`unit="top_level_def"` 是用 Python `ast.parse` 實作的
（`measure/distance.py` 的 `_defs`，解析失敗就整檔一個 hash），**TS 檔拿不到 def 級**。dsh 自己的
`loop` surface 因此宣告 `unit="file"`（`adapters/dsh.py:181`）。我們要「一個 plugin 一個 unit」，
清單就得一檔一個 plugin —— 而 `packages/` 本來就是一套件一 plugin，這個形狀免費。

## 五、接進去我們拿得到什麼

**四個讀數**：

1. **結構距離**（`measure/distance.py`）：定義在**結構單位**上而不是位元組（「位元組數量量的是囉嗦
   程度」），逐 surface 把 added／dropped／revised／unchanged **分開報** ——「只會加的在累積，會改會
   刪的在策展」；travel 是逐 episode 的**路徑長度**而非端點位移（surface 從空的開始，端點距離第一個
   episode 就飽和）。→ 對我們：「萬物皆可插件」的第一個外部證據，讀數會直接說 agent 動不動組裝面。
2. **行為距離 R ＋ 標籤排列檢定**（`measure/stream.py`）：三層預先承諾 —— unigram JS（頻率）、
   bigram JS（順序）、bz2 NCD（程序）；R ＝ between-arm ÷ within-arm，問「動作的是誰」能不能解釋
   比隨機重貼標籤更多的散布。→ 我們今天**沒有任何行為分布的尺**：`eval/runner.ts` 量的是「跑完之後
   做到了什麼」（工具呼叫從 `result.messages`、token 從 `usage_metadata`）。這把尺可以借來做 harness
   變更的回歸。**限制**：分母是同臂自我相似度，seeds 少的時候分母是噪音、讀數無意義（預先登記的
   門檻 R < 0.5）。
3. **結晶／交換測試**（`measure/crystallize.py`，他們自稱最鋒利的宣稱）：把演化過的 harness 掛在
   **中性** disposition 下（拿掉擾動、保留 agent 蓋的全部），跑一個探測 episode 把行為讀回來。
   Stage A 問「結構有沒有帶著一個身分」，Stage B 問「那身分是不是植入的那個」。→ 對我們是記憶設計
   的實驗：memory middleware 是**唯讀注入**、寫回只能靠模型自己呼叫 `edit_file`
   （`plugin-memory` 檔頭第 1 條的實測結論），所以「指令面的痕跡會不會沉澱進 notes／skills 並在指令
   移除後還在」**是我們架構上真的不知道答案的問題**。
4. **escape／awareness 證據**（`proteus audit`）：引用而不評分 —— agent 自己寫的、可能離開 harness
   的程式碼（`subprocess`、`eval`、socket、URL fetch，以及指名研究自己目錄的路徑片段），與主體把
   處境描述成實驗的片段；與 episode-0 快照相同的檔跳過。→ 我們有 `--sandbox` 三檔 ＋ backend fence
   ＋ `sandbox-policy.ts`，但從沒有一個**真的在寫工具的 agent** 壓過它。**限制**：刻意過度收錄、
   recall 有限（他們自己說有一顆 seed 是人讀筆記才抓到），輸出是「要讀什麼」不是「可以排除什麼」。

**三個外溢的工程收穫（讀數是 null 也拿得到）**：

1. **會話日誌的第一個外部消費者。** 今天三個消費者全是我們自己（`--resume`、`eval/session-scan.ts`、
   web）。`read_trace` 是第一個由別人的契約定義的讀法，而上游**明文不准為了測量往 harness 加儀器**。
   十種事件若重建不出 `ActionEvent(turn, phase, tool, surface, params, text)`，那是日誌設計的真缺口，
   而這是唯一能把它逼出來的測試 —— #172／#174 的選擇會在這裡拿到一張外部成績單。
2. **第一份 Dockerfile ＋ 無頭契約。** 一個「一次呼叫跑完、退出、日誌落在受量樹之外」的釘死映像，
   對 CI 也有用，不是研究專用品。
3. **`validate_candidate` 反過來驗我們**：第一次有人**從外面**踩那條 fail-closed 路徑，而不是我們
   自己的 `cli.test.ts`。

**兩題**：

- **研究題**：no-goal、單臂、`units:*`／`step`／`tool-calls` 全 hidden，問一句「**在沒有目標壓力下，
  agent 會不會動我們的組裝面，還是只寫筆記**」。答案兩邊都有資訊量 —— 「只寫筆記」對我們的架構
  主張是一個比任何自評都硬的否證。
- **工程題**：目標 ＝ 我們自己的基準（`eval/dataset.ts` 是供應商中立的：一句 prompt ＋ 期望工具
  呼叫、逐鍵比對，配 `scorers.ts`／`compare.ts`／`tiers.ts`）＋ `accept_reject`，當成會產出 harness
  改動提案的迴圈，我們挑著收。**貴**：每 episode 多一次完整基準跑（§三 末段），而且尺度要先想清楚
  （只掛一個正規化過的 benchmark evaluator 進 selection，其餘量測全 `HIDDEN` 且不進 selection）。

**研究題是工程題的全部前置** —— 它順便驗完的 Dockerfile、`read_trace` 餵得進去、`validate_candidate`
擋得住，就是工程題要的全部管線。

## 六、它幫不到的

- **對 §三那張 dsh 對照表零貢獻**（`plugin-architecture-gap-survey.md` §4.4 已登記：它不是 harness，
  沒有 compaction／hooks／permissions 可以對照）。
- **量不到沒宣告成 surface 的東西。** 我們還開著的 `hooks`、`storage` 不是 surface。
- **跨臂比較要自己寫**：`proteus compare`（多 arm 並排、效應量、信賴區間）還在 `ROADMAP.md` T3 的
  `[medium]`；今天 `measure`／`reliability`／`audit` 只吐數字。
- **自動提議目標、持續注入人類回饋**：就是 §二 那兩格 ❌／⚠️。
- **不是 benchmark 平台**：SWE-bench 實作了但 heavy（T2 明文：x86_64 ＋ 大硬碟），grading 還在往
  sandbox 遷。
- research preview、v0.3.0；`selection` 的 `rank` 只是型別註解上的字。

**順帶一個對他們也是新的點**：五個內建 adapter 沒有一個以 **plugin 清單**為 surface；`ROADMAP.md`
T1 把 OpenClaw（TS ＋ pnpm build ＋ Plugin SDK）列為 medium-high 但還沒做。所以「執行期組裝面當受量
對象」在上游也還沒有先例。

## 七、規模與成本

- 上游示範規模：3 arms × 4 seeds × 8 episodes（README）。
- 一個 episode 四個 phase；dsh 的 `PHASE_TIMEOUT_S = 600`。**路線 A 沒有 rebuild**，省掉他們那條
  每 episode 一次的建置（全建約 330s）。
- 粗估最小有意義的一組：2 arms（neutral vs 一個 disposition）× 3 seeds × 8 episodes ＝ 48 episodes
  ≈ **192 次 live CLI 呼叫**，模型是 `nvidia/nemotron-3-super-120b-a12b`（`live-model.ts:72`）。
- 網路策略**不能是 `none`**：我們的 CLI 要打 NVIDIA 的 OpenAI 相容端點（`NVIDIA_API_KEY`），
  environment manifest 要開 API 出口。
- **上面是次數，不是錢。** 我沒有實測過我們一次 live 呼叫的耗時與 token，**這一項標為未量**；
  要算錢得先量一次。

## 八、沒查的

1. `environments/openhands/`、`swe-agent/` 是 adapter 還是 bench 環境 —— 沿用 9/02 那份的第 5 條
   （`proteus/adapters/` 裡沒有對應檔、`ROADMAP.md` T1 把它們列為待做），**這次沒有新查**。
2. `web/server.py` 的 hosted playground：只讀了 `web/static/index.html` 的兩行（第 206、234、243 行），
   伺服器那側沒讀。
3. 那張海報是哪一版畫的、是否對應某個未合併的設計 —— `docs/assets/proteus-architecture.png` 沒有被
   任何 `.md` 引用，只有 `web/static/index.html:243` 當 print version 連它；**沒查它的 git 歷史**。
4. adapter 用 Python 寫，**住哪還沒定**：往上游送一份 `proteus/adapters/nexus.py` ＋
   `environments/nexus/`（他們 CLI 明文 *loads your adapter with no registration*），或在我們 repo 開
   一個目錄並從 `prettier --check .`／`pnpm -r lint` 排除。這是一個待決的協作面問題，不是技術問題。
