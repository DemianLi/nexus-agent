# 協作模式

需求由人和 agent 一起釐清，開成卡之後由 agent 全自動開發到合進 `develop`；合進 `main` 與發版仍然由人來。為什麼選這套見 [ADR 0001](../adr/0001-pm-engineer-verifier-collab-mode.md)。

## 流程

```text
grill（討論）
  → grill-with-docs（ADR、詞彙表）
  → 功能卡：to-spec（只寫要什麼、為什麼、測試接縫）
    機械卡：to-tickets
  → 標 ready-for-agent
  → PM 派工 → engineer 開發、開 PR → verifier 判定 → engineer 合進 develop
```

`ready-for-agent` 之前每一步都要人回答；之後不等人，只有 [poteto-mode](../../.agents/skills/pstack/skills/poteto-mode/SKILL.md)〈Autonomy〉列的動作會停下來。

- **卡的正文是唯一的規格。** 標 `ready-for-agent` 之前，把留言裡還要做的併進正文；沒併進去的，engineer 不做。
- **正文寫到程式碼現況的地方，要對 `origin/develop` 核過，附 `path:line` 與 SHA**，不從舊留言或記憶抄。前提跟程式碼不合時，engineer 照程式碼做，把差異列成可逆的預設。

## 角色

operator（demian）、PM、engineer、verifier 的職責與模型見 [poteto-mode](../../.agents/skills/pstack/skills/poteto-mode/SKILL.md)〈Nexus roles〉與〈Subagents〉。PM 照 [Autopilot-full](../../.agents/skills/pstack/skills/poteto-mode/playbooks/autopilot-full.md) 跑佇列，engineer 照 Feature 或 Bug fix 開發、照 [Shipping](../../.agents/skills/pstack/skills/poteto-mode/playbooks/shipping.md) 合併。

pstack 不走 Skill 工具：照 [Claude Code 對照](../../.agents/skills/pstack/docs/harness/claude-code.md)直接讀 `SKILL.md`。副本的來源與改寫見 [UPSTREAM.md](../../.agents/skills/pstack/UPSTREAM.md)。

## 開場說明

PM 由 operator 開，開場整段貼：

```text
Read .agents/skills/pstack/skills/poteto-mode/SKILL.md and docs/agents/collab-mode.md before anything else.
你是 PM。照 .agents/skills/pstack/skills/poteto-mode/playbooks/autopilot-full.md 跑 ready-for-agent 佇列。
同時進行的 engineer 上限：<N>。
```

engineer 由 PM 開，一張卡一個 session、一個 worktree：

```text
Read <主 checkout>/.agents/skills/pstack/skills/poteto-mode/worker.md before anything else.
再讀 .agents/skills/pstack/skills/poteto-mode/SKILL.md 與 docs/agents/collab-mode.md。
你是 engineer，負責 #<issue>。照 .agents/skills/pstack/skills/poteto-mode/playbooks/autopilot-full.md 第 2 步做到合併。
```

verifier 由 PM 開，只給 issue 與 PR，不給 engineer 的對話：

```text
Read <主 checkout>/.agents/skills/pstack/skills/poteto-mode/worker.md before anything else.
再讀 .agents/skills/pstack/skills/poteto-mode/SKILL.md（〈Nexus roles〉的 Verifier）與 docs/agents/collab-mode.md。
你是 verifier，判定 #<issue> 的 PR #<pr>。照 .agents/skills/pstack/skills/poteto-mode/playbooks/autopilot-full.md 第 4 步與 shipping.md 第 1 步，在 PR 上貼 PASS、PASS+NOTES 或 FAIL。
```

`<主 checkout>` 換成主 checkout 的絕對路徑：worker.md 要求第一行是絕對路徑，而每個 worktree 的路徑都不同。

- PM 直接開 engineer 與 verifier，不先問 operator（operator 的常設授權）。`name` 用 `eng-<issue>`、`ver-<pr>`，`model` 與 `effort` 照 [SKILL.md](../../.agents/skills/pstack/skills/poteto-mode/SKILL.md)〈Subagents〉的角色表；`PreToolUse` hook 擋下 `eng-`／`ver-` 開頭但參數不合、title 是 engineer／verifier 卻沒給 `name`、用 fork 或 cloud 開的，出錯就放行。app 在自動事件叫醒的回合（例如背景工作跑完）會拒絕開 session；被拒才改成提案卡，收尾框不另放「開始」按鈕，並用一句話說是 app 擋下的。PM 在 engineer 回報 code-ready 的那一輪開 verifier。
- engineer 與 verifier 都開成 session，不開成 subagent。PM 開 session 時不讓 app 建 worktree（app 會自己取分支名、加前綴，跟 `<type>/<kebab-case>` 不合），讓 session 從主 checkout 起跑，自己照 worker.md 開 worktree，之後只在那個 worktree 裡改。
- engineer 推出 code-ready 的 head 之後，回報 PM 並結束這一輪，不自己合併。PM 把 verifier 的判定用訊息轉給 engineer；engineer 收到 `PASS` 或 `PASS+NOTES` 才進 Shipping 第 2 步，收到 `FAIL` 就照理由修。
- verifier 開背景子代理（例如 code-review 兩軸）之後，先做完自己的部分（重跑 Evidence、突變護欄、核行號）才結束回合，少停幾次；判定貼上之前，自己移除它開的 worktree。

## worktree 與上下文

- 一張卡一個 worktree，從 `origin/develop` 開、`--no-track`（指令見 [worker.md](../../.agents/skills/pstack/skills/poteto-mode/worker.md)）。卡合併、合併後那一輪綠了，PM 照 [Worktree cleanup](../../.agents/skills/pstack/skills/poteto-mode/playbooks/worktree-cleanup.md) 移除它。
- **上下文只放在進版控的檔或共用的記憶目錄。** worktree 是用完即丟的工作台：不建 `.claude/settings.local.json`，`.env` 從主 checkout 讀。
- 兩張卡會寫到同一個檔時，PM 讓它們依序跑，不同時派。
- engineer 與 verifier 的開場第一行讀主 checkout 的檔，`.env` 也從主 checkout 讀，所以 PM 每次派工前先把主 checkout 同步到 `origin/develop`（`git -C <主 checkout> pull --ff-only`）。

## 合併與撤回

- 放行條件是 verifier `PASS`（或 `PASS+NOTES`）加 `gate` 綠，由 engineer 自己 squash 合併。同步 `develop` 後 patch-id 沒變就沿用判定；有衝突，engineer 自己解，PM 重開 verifier（[Shipping](../../.agents/skills/pstack/skills/poteto-mode/playbooks/shipping.md) 第 2 步）。
- **`gate` 綠**是最新那一輪的 `gate` 為 `SUCCESS` 或 `SKIPPED`。輕模式下，`plan` 成功、`rust` 為 `false`、其餘 job 全部跳過時 `gate` 不起 job，顯示 `SKIPPED`，ruleset 照樣放行（`.github/workflows/ci.yml` 裡 `gate` 的 `if`）。`SKIPPED` 時再確認 `plan` 是 `SUCCESS`。
- 一張卡最多 `FAIL` 三次：前兩次 `FAIL` 退回同一位 engineer 修（它的 worktree 與分支就是要接續的狀態），第三次 `FAIL` 就停。每一次 `FAIL` 都算，解衝突之後的重判也算，不然解壞了可以一直退回。停下時 PM 標 `needs-info`、拿掉 `ready-for-agent`，在卡上寫明卡在哪，交給 operator；engineer 不封存，留著它的 worktree 等 operator 回覆。
- 修 `FAIL` 理由的 commit，就算只改註解或文件，也一律由 PM 開新的 verifier 判新的 head。
- 判定只記在 PR 上，卡上只放那則留言的連結。
- `gate` 對功能分支 → `develop` 的 PR 只跑跟異動有關的檢查；動到 `.github/workflows|scripts|actions` 的照樣全跑。跑哪些見 `.github/workflows/ci.yml` 檔頭。只改 PR 內文不重跑 gate，例外是 `develop → main` 與清 dsh 對照的 PR（階段 1，見〈對照 dsh〉）：它們的 gate 讀內文，由 `pr-edited.yml` 重跑，改標題也會重跑。
- **合進 `develop` 之後，每個 commit 各跑一輪完整的 CI**（`.github/workflows/post-merge.yml`）。它不擋合併，由合併的 engineer 盯：紅了先只重跑失敗的 job 一次；轉綠、而且同一個 tree 在 PR 上是綠的，就當成偶發，開 backlog 卡或在既有的卡上記一筆；還是紅，engineer 立刻開撤回 PR 讓 `develop` 先恢復綠，再由同一位 engineer 修好、重新開 PR，照常走 verifier。只含 `git revert` 的撤回 PR 不需要 verifier，gate 綠就合。engineer 確認自己合併 commit 的那一輪是綠的（或已撤回）之前，不開下一張 PR。
- 合併後那一輪的「視覺差異」有差時會在 PR 留言，它不讓這一輪變紅、不走撤回；作者開下一張 PR 之前回那則留言：都在打算改的範圍裡就回「畫面變動符合預期」，不是就當成 bug 修（[`apps/web/COMPONENTS.md`](../../apps/web/COMPONENTS.md)〈視覺差異〉）。
- `main` 只收來自 `develop` 的 PR，由人合併、由人發版（[`docs/release.md`](../release.md)）。緊急修補同樣先進 `develop`。
- 分支合併後由 GitHub 自動刪除；突變、實驗分支在對應的卡結了之後可以清。`develop` 與 `main` 之外的分支同樣不 force push。

## 收尾與封存

每個 session 收尾的第一句寫 `可封存：…`、`不可封存：…` 或 `還在等：…`（[AGENTS.md](../../AGENTS.md)〈收尾〉）。三個角色什麼時候算可封存：

| 角色 | 可封存的時候 | 誰封存 |
| --- | --- | --- |
| engineer | 自己合的 PR 合併後那一輪是綠的，Shipping 第 5 步的回報也寫在卡上了。撤回 PR 合了不算：撤回之後它還要修好、重新開 PR | PM |
| verifier | 判定已經貼在 PR 上，自己開的 worktree 也移除了 | PM |
| PM | 長駐的不封存；有終點的（例如試跑），交出報告之後 | operator |

PM 在 engineer 可封存時依序做三件事：

1. 拿掉卡上的 `ready-for-agent`，免得下一輪再派一次。
2. engineer 的回報說卡上要做的都做完了，就結卡；沒做完，就把剩下的寫在卡上，卡留著。
3. 封存 engineer，再照 [Worktree cleanup](../../.agents/skills/pstack/skills/poteto-mode/playbooks/worktree-cleanup.md) 移除它的 worktree。

## 導正

engineer 遇到可逆的選擇就先做一版，把預設決定和理由列在卡上（[Shipping](../../.agents/skills/pstack/skills/poteto-mode/playbooks/shipping.md) 第 5 步）。operator 在卡上回覆不同意，就開一張修正卡。

同一類 verifier `FAIL` 理由在兩張不同的卡上各出現一次，PM 就開一張 `correct` 卡，把那條規則改成機械檢查，並更新下面的表。

## 對照 dsh

技術實現以 deepseek-harness 為參照（[AGENTS.md](../../AGENTS.md)〈技術實現標準〉）。**先讀原始碼，不要靠搜尋或記憶回答。** engineer 自己做、自己選：

1. **廣度**：在 `deepseek-harness` 與 `nexus-agent` 兩個圖上用 `search_graph`、`trace_path` 找出相關的符號與呼叫路徑。「沒有」「只有 N 個」這類否定宣稱，配 `check_index_coverage` 再 grep 一次（[codebase-memory.md](codebase-memory.md)）。
2. **深度**：對圖找到的關鍵點讀原始碼，引用寫 `path:line` 並註明 SHA（[引用 deepseek-harness 之前](codebase-memory.md#引用-deepseek-harness-之前)）。說出 dsh 在解決什麼問題、付出什麼代價；講不出來，就還不能選。
3. **選**：至少比一種別的做法，用同一組標準比：正確性、失敗與恢復、效能、維護成本、nexus 的產品需求（企業內部聊天機器人、完全內網、多人共用主機、稽核、幾百人並行開發）、現有基座做不做得到（今天是 deepagents／LangChain JS／LangGraph JS，正遷往 vendor 的 Cordis，見 [`.docs/decisions-2026-10-11.md`](../../.docs/decisions-2026-10-11.md)）。選比較好的那一個；比不出高下就照 dsh，因為它的做法已經在實際使用中驗證過。

比較結果寫在 PR 內文 Summary 的「對照 dsh」；符合下面 ADR 條件的寫成 ADR，「對照 dsh」只放一行連結。不寫進程式碼與註解。operator 事後不同意，走上面的導正。

**清掉程式碼註解裡的 dsh 對照的 PR**（階段 1：dsh 計數下降，而且除了註解與字串內容，程式碼沒變）有三條規則，gate 會讀這張 PR 的內文（`.github/scripts/check_dsh_cleanup.py`）：

1. 帶 dsh 對照的句子預設整句刪。要留或改寫，內文逐句附 nexus 實作的 `path:line`；改寫與新增的每一句，內文都要有一列（整句加 `path:line`，在 head 上要存在）。
2. 階段 1 不改段名（註解裡的 `##` 標題與表格的名稱格；含 dsh 的段名不在此限，括號裡的說明不算）。改名留給階段 2，跟所有指向它的地方同一張 PR 改。
3. 刪掉一段或段名之前，找全 repo 指向它的地方；script 列出候選，每一個要在這張 PR 改掉，或在內文有一列寫明為什麼仍成立。

本機跑 `python3 .github/scripts/check_dsh_cleanup.py` 印出第 1、3 條要填的列，貼進內文再補。補完內文不用推 commit，gate 會用新內文重判（`pr-edited.yml`）。句子是真是假、理由成不成立，script 判不了，由 verifier 判。

## ADR

三個條件都成立才寫：**難以撤回、少了背景會讓人意外、是真的取捨過的結果**。少一個就不寫，比較留在 PR 內文。

- 全系統的決策放 [`docs/adr/`](../adr/)，單一 app 的放 `apps/<name>/docs/adr/`；`packages/*` 的歸到根目錄。
- 檔名 `NNNN-<kebab-slug>.md`，四位數編號從 `0001` 起依序遞增、不跳號。第一行 `# <標題>`，正文一段話說清楚情境、決定與理由就夠；有價值時才加「Considered Options」與「Consequences」（格式照 `domain-modeling` 的 ADR-FORMAT）。
- `docs/` 只寫現況；決策與取捨寫 ADR；`.docs/` 逐步退場，不再新增。

## 規則與執行者

每條規則由誰擋。「只有文件」的列代表還沒機械化，agent 跳過它時什麼都不會失敗。

| 規則 | 執行者 |
| --- | --- |
| PR 標題的 type、8 到 50 字、至少一個中文字、不是填充句 | gate（`.github/scripts/check_pr.py`） |
| PR 標題是祈使句、說做了什麼 | 只有文件 |
| `main` 只收 `develop` | gate（`.github/actions/plan-checks`） |
| 發版 PR 內文要有〈變更內容〉〈驗證方式〉 | gate（`check_pr.py`） |
| 發版 PR 的〈驗證方式〉只寫實際跑過的 | 只有文件 |
| md 相對連結連得過去 | gate（`check_md_links.py`） |
| 升級指南的格式 | gate（`check_upgrade_guides.py`） |
| 升級指南有沒有寫 | verifier |
| 禁止直接 push、force push、刪 `develop`／`main` | ruleset |
| `develop` 只收 squash、要求 strict；`main` 只收 merge commit | ruleset |
| `gate` 綠才能合 | ruleset |
| 沒有測試的套件不得通過 | 全跑的 CI（`develop → main` 的 gate 與合併後那一輪；功能 PR 的輕模式不擋） |
| 會話日誌格式升版要補版本邊 | 執行期（不補邊，模組載入就拋） |
| home 狀態檔改 schema 要留 v1 夾具 | 測試（`home-state-v1-fixtures.test.ts`）＋ verifier |
| 秘密不進程式碼 | GitHub push protection（已知格式）＋ verifier |
| 不得有預設 key 或 fallback | verifier |
| 修 bug 先寫會紅的測試 | verifier |
| 護欄要證明會紅 | verifier（自己突變一次） |
| 期望值不取自被測物、斷言看得到被宣稱的東西 | verifier |
| Evidence 只寫實際跑過的 | verifier（重跑每一條） |
| 跨套件型別收緊先實測拆不拆得開 | verifier |
| 註解規則 | engineer 跑 no-comments ＋ verifier |
| 清 dsh 對照的 PR：改寫與新增的每句註解，內文有一列整句加存在的 `path:line` | gate（`check_dsh_cleanup.py`） |
| 清 dsh 對照的 PR：那一行撐不撐得起那一句 | verifier |
| 清 dsh 對照的 PR 不改註解裡原有的段名（含 dsh 的除外） | gate（`check_dsh_cleanup.py`） |
| 刪掉一段或段名之前，找全 repo 指向它的地方；每個候選指向改掉或在內文寫為什麼仍成立 | gate（`check_dsh_cleanup.py` 列候選、查內文有一列）＋ verifier（理由對不對、script 找不到的寫法） |
| verifier `PASS` 才合併 | 只有文件（ruleset 不要求 approval） |
| 合併後那一輪紅了：重跑一次，還是紅就撤回 | 只有文件（engineer 照 Shipping 做） |
| 內文寫 `Refs #N`，不寫 Closes | 只有文件 |
| 分支命名 `<type>/<kebab-case>` | 只有文件 |
| 上下文只放進版控的檔或共用記憶目錄 | 只有文件 |
| 開完 PR 開 Auto-fix | 只有文件（工具不在或被權限檢查擋下時，在卡上記一筆，不重試；沒開成，engineer 照 [Babysit](../../.agents/skills/pstack/skills/poteto-mode/playbooks/babysit.md) 自己盯 CI） |
| 收尾第一句寫可封存、不可封存或還在等 | `Stop` hook（`.github/scripts/session_hooks.py`；只看前綴與 `還在等：` 是否一行，擋一次、出錯放行） |
| engineer、verifier 照角色表的 `model`、`effort` 開 | `PreToolUse` hook（同上，看 `name` 的 `eng-`、`ver-` 與 title；沒給 `name`、title 也不像角色的就看不到） |
| 開 session 被 app 拒絕時改成提案卡、不另放開始按鈕 | 只有文件（app 行為，hook 看不到工具結果與收尾框） |
| engineer 可封存之後拿掉 `ready-for-agent`、結卡、封存 | 只有文件（PM 照〈收尾與封存〉做） |
| 卡的正文是唯一的規格、寫到的程式碼現況要核過 | verifier（Spec 軸對程式碼核正文的前提） |
| ADR 的位置、檔名、編號與標題行 | gate（`check_adrs.py`） |
| ADR 只在三個條件都成立時寫 | verifier |
| 程式碼裡的 dsh 引用數只降不升 | gate（`check_ratchets.py`，基準在 `.github/ratchets/`） |
| 註解裡的變更敘事用語只降不升 | gate（同上） |

只降不升的計數以目錄為單位，計法見 `check_ratchets.py` 的 `EXTENSIONS`、`EXCLUDED_PREFIXES`、`EXCLUDED_PARTS`、`EXEMPT`、`DSH`、`COMMENT_OR_INLINE_SLASHES`、`NARRATIVE`。基準每個目錄一個檔：`.github/ratchets/<目錄，/ 換成 __>.json`，根目錄是 `_root.json`，沒有檔的目錄算 0。清掉引用的 PR 要在同一張把基準調低：`python3 .github/scripts/check_ratchets.py --write`（只重寫數字變了的檔），平行的 PR 改不同目錄就不會互相衝突。基準不能調高，gate 會拿分歧點那一版的基準比：分歧點有新資料夾就比資料夾，只有舊的 `.github/ratchets.json` 就比它，有 `check_ratchets.py` 卻讀不到基準會報錯，連腳本都沒有（例如 `main` 的舊版本）才跳過並印出原因。
