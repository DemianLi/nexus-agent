# dsh 對藍圖量測紀律的實際做法對照（#996）

- **dsh 版本**：`deepseek-ai/deepseek-harness` 預設分支 `master`，clone SHA `5badb15009ae1756c3afe0ae0cef1faafc290ccc`（commit 時間 2026-10-03T11:48:13+08:00）。clone 當下以 `git ls-remote origin HEAD` 對照，遠端預設分支也是同一個 SHA。
- **查證日期**：2026-10-04。
- **問題來源**：`.docs/chat-agent-research/blueprint.md` 第 3 節的規則 1–7（第 111–151 行），加上 T7、T8 稽核後仍是 A 級的九張卡：T7-01（第 831 行）、T7-02（第 840 行）、T7-03（第 850 行）、T7-06（第 878 行）、T7-08（第 887 行）、T8-02（第 934 行）、T8-03（第 954 行）、T8-04（第 964 行）、T8-06（第 982 行）。等級以該檔標題為準。
- **範圍**：這份只回答「dsh 有沒有、怎麼做」，不判斷 nexus 該不該照做。
- 下文所有 `檔案:行號` 都相對於上面那個 SHA 的 dsh repo 根目錄。

## 先講結論

**dsh 的產品路徑上沒有評估子系統。**出廠的六個 bundle 與四個 agent preset（見下一節）都沒有掛分數、評審、判定器、模擬使用者、重跑統計或區間計算。dsh 對「這一輪做完了沒」的回答，是**讓模型自己宣告，並明文把獨立評估器列為延後的工作**（`packages/goal/goal/README.md:159`、`packages/workflow/tool-ralph/README.md:161`）。

跟這些規則形狀相近的做法，只出現在 dsh **自己的開發與測試工具**裡，而且對象是 harness 本身，不是 agent 的任務成績：

1. **真模型 e2e 的「驗世界，不驗自報」**（`docs/testing.md:33-35`）：在 agent 外面重跑指令、確認沒被要求改的檔案逐位元組不變。
2. **實驗性 auto-review 閘門的 8 個案例認證**（`packages/experimental/auto-review/tests/auto-review.e2e.ts:250-347`）：應放行與應攔下兩個方向的案例都有，每個案例只跑一次，`retry: 0`。
3. **效能 benchmark 的重跑與雜訊規矩**（`benchmarks/AGENTS.md:11-12`、`.agents/skills/dsh-speed-up-perf/SKILL.md:74`）：每個情境開 5 個新行程、取中位數、做負對照、預算不得低於量過的雜訊下限。量的是延遲與記憶體，不是 agent 品質。

另外有兩份**提案中、沒有實作**的筆記，用到了「獨立評審」與「同預算對照」的說法；其中提到的 bench 套件與報表管線不在 repo 裡。agent 品質的 benchmark 由外部程式透過 Python SDK 驅動 `sdk-minimal` profile 來跑（`BENCHMARK.md:3`）。評分程式不在這份 repo 裡，見文末〈盲區〉。

## 數過的 profile

出廠 profile 的組成寫在 `packages/boot/app-boot/src/profile.ts:179-195`：`acp`、`web`、`headless`、`sdk` 都是「base 加上一個模式 bundle」，`sdk-minimal` 只用自己那一個 bundle。web 另外帶四個 agent preset（`packages/bundle/web-app/package.json:43-48` 起）。下表依 `packages/bundle/*/cordis.patch.yml` 與 `packages/bundle/web-app/presets/*.patch.yml` 逐檔列出 `- id:` 與 `disabled:`：

| profile | 檔案 | 跟本題有關的列 |
| --- | --- | --- |
| base | `packages/bundle/base/cordis.patch.yml` | `goal`（313）、`goal-round-driver`（316）、`command-goal`（319）、`tool-goal`（437）預設掛著；`tool-ralph`（447）`disabled: true`；`token-meter`（338）、`command-feedback`（310）、`otel`、`session-telemetry-otel` 掛著 |
| headless | `packages/bundle/headless/cordis.patch.yml` | 以 base 為底；沒有新增任何量測或評估相關的列 |
| acp-app | `packages/bundle/acp-app/cordis.patch.yml` | 同上 |
| sdk-app | `packages/bundle/sdk-app/cordis.patch.yml` | 同上 |
| sdk-minimal | `packages/bundle/sdk-minimal/cordis.patch.yml` | **不以 base 為底**的完整樹，共 27 個 `- id:` 列：沒有 goal、tool-goal、feedback、token-meter；`BENCHMARK.md:3` 指定的 benchmark 入口就是這個 profile |
| web-app | `packages/bundle/web-app/cordis.patch.yml` | 主機層把 `command-goal`（511）、`tool-goal`（514）、`tool-ralph`（564）關掉，改由 preset 掛回；新增 `message-feedback`（69）、`session-stats`（102）、`ui-goal`（393）、`ui-message-feedback`（399）、`ui-trajectory`（445） |
| preset standard | `packages/bundle/web-app/presets/standard.patch.yml` | `command-goal`（42）、`tool-goal`（44）掛著；`tool-ralph`（141）關 |
| preset ptc | `packages/bundle/web-app/presets/ptc.patch.yml` | `command-goal`（42）、`tool-goal`（44）掛著；`tool-ralph`（143）關 |
| preset cordis | `packages/bundle/web-app/presets/cordis.patch.yml` | `command-goal`（41）、`tool-goal`（43）掛著；`tool-ralph`（140）關 |
| preset minimal | `packages/bundle/web-app/presets/minimal.patch.yml` | 只有 persona 與持久 shell；沒有 goal |

**沒有出現在任何 profile 的**：`packages/experimental/auto-review`（README 第 12 行寫「ships this layer switched off」，只能用 `pnpm dsh plugin --profile web add` 自己裝）、`packages/experimental/session-inspector`、`inspector`、`inspector-profile`（開發者工具，預設關）。

## 對照表

「產品路徑」指出廠 profile 預設會走到的程式；「開發工具」指 dsh 自己的測試、CI、benchmark、skill 或 Agent Note；「提案」指 `.agents/notes/proposed/` 裡還沒實作的筆記。「機制」指 dsh 為了這件事專門寫的規則或程式碼；「副作用」指為了別的目的存在、只是剛好碰到這件事的東西。

| 規則或卡號 | dsh 有沒有 | 有的話：檔案:行號 | 機制或副作用 | 產品路徑或開發工具 |
| --- | --- | --- | --- | --- |
| 規則 1　每個分數旁並列平凡基準 | **dsh 沒有**（沒有任務分數，所以也沒有 do-nothing、隨機、多數類這類地板） | 最接近的只有兩處：一是 `apps/cli/tests/profiles/headless/tests/coding-task.e2e.ts:53-55`，agent 動手前先確認夾具會失敗（單題的「什麼都不做必敗」檢查）；二是效能 gate 的負對照 `benchmarks/session-open/session-open.bench.ts:295-300`、`.agents/notes/implemented/testing/2026-09-04-session-open-performance-gate.md:46` | 前者是機制（逐題的前置檢查），後者是效能預算的機制，對象不同 | 開發工具 |
| 規則 2　閘門兩個方向的錯分開量，並量接上後的淨效益 | **dsh 沒有**（不量偽陽性率、偽陰性率，也不量接上後的淨效益） | 產品面唯一的模型閘門是 auto-review：實驗性、預設關、不在任何 profile（`packages/experimental/auto-review/README.md:12`）。它的認證測試 `auto-review.e2e.ts:250-347` 跑 8 個案例，應放行與應攔下兩邊都有，以 `toEqual` 逐案比對；決策筆記 `.agents/notes/implemented/feature/2026-08-28-auto-review.md:81` 寫明每案一次、不重試、不跳過；同一份筆記 `:79` 自承「can misclassify effects」 | 機制（逐案認證），不是比例量測 | 開發工具（認證測試）；閘門本身是選配 |
| 規則 3　判分資訊不進迴圈；產生行為的一方不判分 | **dsh 沒有這條規則；產品路徑上正好相反**：任務完成由模型自己宣告，獨立評估器明文延後 | 生產者是 `packages/goal/tool-goal/src/index.ts:291-318`：模型呼叫 `update_goal` 帶 `complete` 時，程式直接 `ctx.goals.complete(...)`。明文延後的地方：`packages/goal/goal/README.md:159`、`packages/goal/goal-round-driver/README.md:125`、`packages/goal/tool-goal/README.md:149`、`packages/workflow/tool-ralph/README.md:161`、`packages/bundle/base/cordis.patch.yml:440-449`（ralph 預設關的理由），以及 `.agents/notes/implemented/feature/2026-07-19-model-facing-goal-tools.md:50`（否決「把 blocked 門檻當評估器」）與 `:64`。auto-review 的審查者沿用當前 agent 的 provider 與 model（`2026-08-28-auto-review.md:33`）。開發工具這邊有「驗世界，不驗自報」：`docs/testing.md:33-35`、`coding-task.e2e.ts:69-81` | 產品路徑：模型自報是機制，獨立評估器明文延後。開發工具：「不採信自報」是機制 | 產品路徑（goal：base、headless、acp-app、sdk-app，以及 standard、ptc、cordis 三個 preset）；開發工具（e2e 規矩） |
| 規則 4　固定並記錄設定，自己重算 | **dsh 沒有**（沒有分數，所以沒有「分數附設定」，也沒有統一重算） | 副作用一：每個請求的 `request/header` 記下 provider、model、reasoningEffort、temperature、maxTokens 與工具 schema（`packages/core/session/src/types.ts:234-251`、`:386-395`；`packages/llm/llm/src/call-config.ts:23-30`），目的是重建請求（`AGENTS.md:136`）。副作用二：`plugin-package-inventory-deepseek` 把已啟用套件的名稱與版本隨 DeepSeek 官方 API 請求送出（`packages/llm/plugin-package-inventory-deepseek/README.md:12`、`:31`），目的是請求診斷。副作用三：minimal preset 的提示詞與工具說明被測試逐字釘住（`apps/cli/tests/web-agent-presets.e2e.ts:312-323`，測試名稱叫 "exact RL prompt"），但 repo 內沒有任何程式拿它算分。效能量測則有記錄要求：命令、revision、runtime、平台、原始樣本都要存（`dsh-speed-up-perf/SKILL.md:61`），作者自報、本地新量、CI 三種數字分開寫（`:92`） | 前三項是副作用；效能那條是機制，對象不同 | 前三項在產品路徑；效能那條是開發工具 |
| 規則 5　只讀終態的判準，要另量漏掉多少 | **dsh 沒有**（沒有任務判準，也不報「終態通過、但違反」的比例） | 開發工具裡的對應物：`docs/testing.md:35` 規定「Assert untouched files are byte-identical」；`coding-task.e2e.ts:73-77` 檢查測試檔沒被改；auto-review 認證比對實際的外部效果，看檔案是被刪了還是被擋下（`auto-review.e2e.ts:280-283`） | 機制，但都是逐案斷言，不是抽樣比例 | 開發工具 |
| 規則 6　模擬使用者是共用量具 | **dsh 沒有** | 全樹沒有使用者模擬器。真模型 e2e 的使用者輸入是寫死的字串（例如 `coding-task.e2e.ts:60-66`） | — | — |
| 規則 7　重跑與不確定度；成本並列 | **在 agent 品質上 dsh 沒有** | 真模型 e2e 的預設是 `retry: 2`（`vitest.e2e.config.ts:50-55`、`.github/workflows/e2e.yml:65-67`），也就是失敗就重跑、三次裡過一次就算過，理由是共用 key 會撞到併發配額。auto-review 認證把它改成 `retry: 0`、每案一次。成本這邊：每一步的 `usage` 跟著 `assistant/message` 一起記錄（`packages/core/session/src/types.ts:331-347`），`session-stats` 提供逐 session 的時間統計（`packages/session/session-stats/README.md:12`）；但 goal 與 ralph 只限制輪數，不計 token 或金額（`packages/goal/goal/README.md:158`、`packages/workflow/tool-ralph/README.md:167`），也沒有成功率可以跟成本並列。效能面則有完整的規矩：每個情境 5 個新行程取中位數（`benchmarks/session-open/session-open.bench.ts:34-35`），CI 機器倍率 2、變異餘裕 1.25（`benchmarks/support/calibration.ts:3-6`），兩次 CI 的中位數最多差 5.2%（`2026-09-04-session-open-performance-gate.md:40`），並且明寫「低於量過的雜訊下限的預算不可靠」（`dsh-speed-up-perf/SKILL.md:74`） | e2e 的 `retry: 2` 是機制，方向跟這條規則相反；usage 紀錄是副作用；效能規矩是機制，對象不同 | e2e 與效能規矩是開發工具；usage 紀錄在產品路徑 |
| T7-01　判定器的地板與雙向人工重判 | **dsh 沒有** | 同規則 1。相鄰但不同的一件事：`.agents/notes/implemented/testing/2026-06-19-real-api-e2e-ci.md:42-44` 的 preflight 會在缺 key 時讓整個 e2e 失敗，避免全部 self-skip 之後報綠。它處理的是「量具沒跑卻報綠」，不是地板 | — | 開發工具 |
| T7-02　評審對人的一致率 | **dsh 沒有** | 沒有任何對人一致率、κ 或多數類基準的計算；auto-review 也沒有對人量過 | — | — |
| T7-03　成對比較逐題交換位置 | **dsh 沒有** | 沒有成對比較的評審 | — | — |
| T7-06　跑幾次、區間怎麼算 | **dsh 沒有** | 同規則 7：agent 層沒有重跑次數或區間；e2e 是 `retry: 2`；只有效能層有 5 個樣本取中位數 | — | 開發工具（僅效能） |
| T7-08　終態判準另量回歸與過程 | **dsh 沒有比例量測** | 同規則 5：逐位元組不變與外部重跑是逐案斷言（`docs/testing.md:35`、`coding-task.e2e.ts:73-84`）。`ui-trajectory`、`session-turn-outline`（web-app 第 445、107 行）是把軌跡畫給人看的介面，沒有自動的過程檢查 | 機制（逐案） | 開發工具 |
| T8-02　避免寬鬆的成功判準 | **dsh 沒有任務成功判準** | 開發工具的規矩點名了其中一種寬鬆判準：`docs/testing.md:35` 寫「a keyword probe on the agent's own output lets a cheating agent pass」。`coding-task.e2e.ts:76-84` 同時檢查四件事：退出碼為 0、stdout 含 `PASS`、測試檔不變、原本的 bug 寫法不見了；其中仍有一條是子字串比對 | 機制 | 開發工具 |
| T8-03　判準誤判分方向、分層報 | **dsh 沒有** | 沒有偽陽性率、偽陰性率或分層抽樣。auto-review 認證兩個方向都有案例，但每案一次，不是比例（見規則 2） | — | — |
| T8-04　用同一評分程式重算，並附版本 | **dsh 沒有** | 同規則 4：沒有評分程式。設定紀錄只以副作用的形式存在（`request/header`、套件清單）；效能層有「作者自報、本地新量、CI 分開寫」（`dsh-speed-up-perf/SKILL.md:92`） | 副作用；效能那條是機制 | 產品路徑（副作用）／開發工具（效能） |
| T8-06　逐題配對檢定、檢定力分析 | **dsh 沒有** | 全樹沒有 McNemar、標準誤、檢定力、bootstrap 或顯著性計算。效能 gate 是拿中位數跟固定預算比，不做檢定 | — | — |

## 提案中、沒有實作的兩份筆記

下面兩份寫在 `.agents/notes/proposed/`，狀態都是 `proposed`，不能當成 dsh 的做法：

- `.agents/notes/proposed/process/2026-07-13-human-review-skill-maintenance.md`：用兩個「獨立設定的審查 adapter」分類並審查技能修改（`:41`）；兩個審查指令解析成逐位元組相同的執行檔時拒絕執行，並寫明「獨立的 provider 或模型」由操作者負責保證（`:47`）；否決「作者兼最終判定者」（`:66`）。工具本身放在維護者的機器上，不進 repo（`:55`）。這跟規則 3 的「產生者不判分」形狀相同，但用在 dsh 自己的開發流程。
- `.agents/notes/proposed/feature/2026-07-06-recallable-compaction.md`：驗收條件寫「在 long-horizon bench 套件上，同預算下任務成功率不低於 `compaction-basic`」，並「經由 dsh bench report pipeline」逐次回報（`:100`）；另外寫明 benchmark 與 RL 設計交由後訓練那一側處理（`:64`）。這份 repo 裡找不到 long-horizon bench 套件，也找不到 bench report pipeline：`long-horizon|bench report|post-training` 在本 SHA 只命中這份筆記本身，以及 `docs/subsystems/persistence.md:110`（一般用語）和一份模型清單 fixture。

## 掃描方法與盲區

### 怎麼掃的

- **量具**：rtk 會把 `grep`、`find`、`git` 改寫並過濾輸出，所以掃描一律直接叫 `/opt/homebrew/bin/rg`、`/usr/bin/grep`、`/usr/bin/find`、`/usr/bin/git`。主要的掃描腳本排除了 `node_modules/`、`vendor/`、`pnpm-lock.yaml`、`*.i18n.yaml`、`docs/i18n/`、`*.zh.md`，以及兩份自動生成的大型 JSON 目錄檔；另外用一支沒有排除 `*.zh.md` 的腳本專掃中文詞。量具校準：`judge`、`evaluator`、`benchmark` 這些詞都有命中，所以排除規則沒有把整棵樹濾掉。
- **profile**：逐檔列出上面六個 bundle 與四個 preset 共十個 patch 檔的 `- id:` 與 `disabled:`。exp 套件是否在 profile 裡，是對 `packages/bundle`、`packages/preset` 的 yml 與 `package.json` 搜尋 `auto-review`，結果零命中。
- **從生產者讀起**：goal 完成是從 `tool-goal/src/index.ts` 的 `update_goal` 實作讀到 `ctx.goals.complete`，不是從 UI 或 fold 端倒推；auto-review 是從 e2e 認證本體與決策筆記讀起，再回頭確認它不在任何 profile 裡。
- **英文詞的形狀**（括號內是本 SHA 命中的檔案數；有命中的都逐條讀過）：
  - 統計：`mcnemar`（0）、`kappa`（0）、`cohen`（0）、`bootstrap…(ci|interval|resampl)`（0）、`confidence.interval`（0）、`p-value|pValue|p_value`（7，都是 `…StartupValues` 這類型別名的子字串誤中）、`stddev|standard deviation|stdDev|std_dev|stdev`（3，都是 SVG 的 `stdDeviation`）、`statistically|significan(t|ce)|power analysis|effect size|standard error|variance`（效能的變異餘裕與無關的型別 variance）、`percentile|p95|p50|median`（30，效能 benchmark）。
  - 判準與評審：`false.positive`（6，lint 與 runtime 的註解）、`false.negative`（0）、`precision|recall`（字面命中但都是一般用語）、`auroc|roc.curve`（0）、`llm.?as.?a.?judge|llm.judge`（0）、`\bjudge`（66，都是「判斷」的一般動詞，加上 workflow-ptc 測試裡一段叫 Judge 的腳本 phase）、`grader|scorer|rubric`（10，除了 `claude-code-mods` 測試裡一個叫 `grader` 的 fixture 名稱，其餘都是誤中）、`evaluator`（21，主要是 cordis 與 typert 的表達式求值器，以及 goal、goal-round-driver、tool-goal、tool-ralph 四份 README 和 goal tools 決策筆記裡的「沒有獨立評估器」聲明）、`\beval(s|uation)?\b`（排除 JS `eval` 之後，只剩 PR 核准計分與模組求值）、`oracle|ground.?truth|gold`（測試裡的「獨立預期值」用語）。
  - 成對比較：`position.bias|swap(ped)?.order`（0）、`pairwise|side-by-side|A/B|arena|win.?rate|inter-?rater|agreement rate|human label`（沒有相關命中）。
  - 基準與成績：`do-nothing|doNothing|no-?op.agent`（0）、`baseline`（370，都是效能基準與 lint baseline JSON）、`pass@k|pass\^k|passAtK`（0）、`success.?rate`（0）、`terminal-bench|swe-?bench|tau-bench|webarena|osworld|gaia`（1，`coding-task.e2e.ts` 的「swebench-style」註解）、`majority.vote|self-consistency`（0）、`contamination|canary|leakage`（16，都是測試環境污染、發版 channel，以及 CoT 洩漏的文件 skill）。
  - 使用者模擬：`user.?simulator|simulated.user|simulate[ds]?.user`（0）、`scripted.?user|fake.?user|mock.?user|synthetic.?user|role-?play|simulat(e|ed|or|ion)`（只有錯誤注入與 `fake-user-${seq}` 這種訊息 id）。
  - 重跑：`flaky|flakiness`（9，CI 可靠度 skill、code review skill、單元測試註解，以及一份提案筆記）、`retry: *[0-9]`（在 `*.e2e.ts` 與 `*.config.ts` 裡逐條讀過）。
- **中文詞的形狀**（含 `*.zh.md`）：`模拟用户|用户模拟|模擬使用者|使用者模擬`（0）、`置信区间|信賴區間|显著性|顯著`（0）、`成功率`（1，就是 recallable-compaction 那份提案的中文版）、`误报|漏报|假阳性|假阴性…`（17，都是翻譯規則與一般錯誤報告）、`评测|評測|评估|評估`、`基准|基線`、`对照|對照`、`裁判|评审|打分|评分`、`重跑`（都對應到上面已讀過的英文段落，或與本題無關）。
- **掃過的目錄**：`packages/`（60 個套件群組，含 `experimental/`、`test-support/`、`feedback/`、`goal/`、`guard/`）、`apps/`、`benchmarks/`、`scripts/`、`python/`、`snapshots/`、`.agents/notes/`（implemented、proposed、archived、rejected）、`.agents/skills/`、`.github/`、`docs/`，以及根目錄的 `BENCHMARK.md`、`AGENTS.md`。

### 看過但沒有放進表格的東西

- `packages/feedback/message-feedback/README.md:12`：使用者對訊息的評分只寫進日誌，不進模型歷史。這是一個人類判分訊號不進迴圈的事實，但 dsh 沒有把它說成量測紀律，也沒有拿這些評分做任何彙總，所以不算規則 3 的對應物。
- `packages/guard/repeat-tool-reminder`：工具重複呼叫的提醒是過程中的護欄，不是成功判準。
- `test:snapshot` 的錄製重播（`docs/testing.md:14`）：比對的是整份持久化的 session，但模型輸出是重播的，測的是 harness，不是 agent 的成績。
- `.github/review-ownership`：PR 核准的加權計分，跟 agent 評估無關。
- `.agents/notes/proposed/testing/2026-06-11-deterministic-and-stress-testing.md:19`：提案每晚用 `vitest --repeat=200 --shuffle` 重跑單元測試，把 flake 當 bug 修、不重試。它的重跑對象是單元測試的時序，不是 agent 成績，而且還沒實作（`:7`）。

### 盲區

- **agent 品質的評估多半不在這份 repo 裡。** `BENCHMARK.md:3` 只教人透過 Python SDK 驅動 `sdk-minimal`；評分程式、任務集、重跑設定都不在樹上。recallable-compaction 提案提到的 long-horizon bench 套件與 report pipeline 也找不到（`:64` 寫明交給後訓練那一側）。所以本表的「dsh 沒有」只對這份開源 repo 成立，不代表 DeepSeek 內部沒有。
- **只讀了預設分支的單一 SHA**，沒看其他分支、PR 討論或 issue。
- **文件只掃英文版，再用中文詞補掃。**`*.zh.md` 在主要掃描裡被排除；中文詞的補掃沒有發現英文版沒有的內容，但並沒有逐檔比對兩種語言。
- **`references/` 之外的 dsh 發佈物**（npm 套件、Python wheel）沒有拆開來看。所有結論都來自原始碼樹，沒有讀任何 sourcemap。
- **e2e 的 `retry: 2` 在 CI 上實際重試了多少次**，這裡沒有讀 CI 日誌，只讀了設定。
