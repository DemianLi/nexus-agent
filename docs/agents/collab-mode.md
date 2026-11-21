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

- engineer 與 verifier 都開成 session，不開成 subagent。PM 開 session 時不讓 app 建 worktree（app 會自己取分支名、加前綴，跟 `<type>/<kebab-case>` 不合），讓 session 從主 checkout 起跑，自己照 worker.md 開 worktree，之後只在那個 worktree 裡改。
- engineer 推出 code-ready 的 head 之後，回報 PM 並結束這一輪，不自己合併。PM 把 verifier 的判定用訊息轉給 engineer；engineer 收到 `PASS` 才進 Shipping 第 2 步，收到 `FAIL` 就照理由修。

## worktree 與上下文

- 一張卡一個 worktree，從 `origin/develop` 開、`--no-track`（指令見 [worker.md](../../.agents/skills/pstack/skills/poteto-mode/worker.md)）。卡合併、合併後那一輪綠了，PM 照 [Worktree cleanup](../../.agents/skills/pstack/skills/poteto-mode/playbooks/worktree-cleanup.md) 移除它。
- **上下文只放在進版控的檔或共用的記憶目錄。** worktree 是用完即丟的工作台：不建 `.claude/settings.local.json`，`.env` 從主 checkout 讀。
- 兩張卡會寫到同一個檔時，PM 讓它們依序跑，不同時派。
- engineer 與 verifier 的開場第一行讀主 checkout 的檔，`.env` 也從主 checkout 讀，所以 PM 每次派工前先把主 checkout 同步到 `origin/develop`（`git -C <主 checkout> pull --ff-only`）。

## 合併與撤回

- 放行條件是 verifier `PASS`（或 `PASS+NOTES`）加 `gate` 綠，由 engineer 自己 squash 合併。同步 `develop` 後 patch-id 沒變就沿用判定；有衝突，engineer 自己解，PM 重開 verifier（[Shipping](../../.agents/skills/pstack/skills/poteto-mode/playbooks/shipping.md) 第 2 步）。
- **`gate` 綠**是最新那一輪的 `gate` 為 `SUCCESS` 或 `SKIPPED`。輕模式下，`plan` 成功、`rust` 為 `false`、其餘 job 全部跳過時 `gate` 不起 job，顯示 `SKIPPED`，ruleset 照樣放行（`.github/workflows/ci.yml` 裡 `gate` 的 `if`）。`SKIPPED` 時再確認 `plan` 是 `SUCCESS`。
- 一張卡最多 `FAIL` 三次：前兩次 `FAIL` 退回同一位 engineer 修（它的 worktree 與分支就是要接續的狀態），第三次 `FAIL` 就停（解衝突之後的重判不算進去），PM 標 `needs-info`，在卡上寫明卡在哪，交給 operator。
- 修 `FAIL` 理由的 commit，就算只改註解或文件，也一律由 PM 開新的 verifier 判新的 head。
- 判定只記在 PR 上，卡上只放那則留言的連結。
- `gate` 對功能分支 → `develop` 的 PR 只跑跟異動有關的檢查；動到 `.github/workflows|scripts|actions` 的照樣全跑。跑哪些見 `.github/workflows/ci.yml` 檔頭。只改 PR 內文不重跑 gate（`develop → main` 例外，由 `pr-edited.yml` 重跑），改標題會。
- **合進 `develop` 之後，每個 commit 各跑一輪完整的 CI**（`.github/workflows/post-merge.yml`）。它不擋合併，由合併的 engineer 盯：紅了先只重跑失敗的 job 一次；轉綠、而且同一個 tree 在 PR 上是綠的，就當成偶發，開 backlog 卡或在既有的卡上記一筆；還是紅，engineer 立刻開撤回 PR 讓 `develop` 先恢復綠，修好再重新開 PR。只含 `git revert` 的撤回 PR 不需要 verifier，gate 綠就合。engineer 確認自己合併 commit 的那一輪是綠的（或已撤回）之前，不開下一張 PR。
- 合併後那一輪的「視覺差異」有差時會在 PR 留言，它不讓這一輪變紅、不走撤回；作者開下一張 PR 之前回那則留言：都在打算改的範圍裡就回「畫面變動符合預期」，不是就當成 bug 修（[`apps/web/COMPONENTS.md`](../../apps/web/COMPONENTS.md)〈視覺差異〉）。
- `main` 只收來自 `develop` 的 PR，由人合併、由人發版（[`docs/release.md`](../release.md)）。緊急修補同樣先進 `develop`。
- 分支合併後由 GitHub 自動刪除；突變、實驗分支在對應的卡結了之後可以清。`develop` 與 `main` 之外的分支同樣不 force push。

## 收尾與封存

每個 session 收尾的第一句寫 `可封存：…` 或 `不可封存：…`（[AGENTS.md](../../AGENTS.md)〈收尾〉）。三個角色什麼時候算可封存：

| 角色 | 可封存的時候 | 誰封存 |
| --- | --- | --- |
| engineer | 合併後那一輪是綠的，或撤回 PR 已經合了；Shipping 第 5 步的回報已經寫在卡上 | PM |
| verifier | 判定已經貼在 PR 上 | PM |
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
| verifier `PASS` 才合併 | 只有文件（ruleset 不要求 approval） |
| 合併後那一輪紅了：重跑一次，還是紅就撤回 | 只有文件（engineer 照 Shipping 做） |
| 內文寫 `Refs #N`，不寫 Closes | 只有文件 |
| 分支命名 `<type>/<kebab-case>` | 只有文件 |
| 上下文只放進版控的檔或共用記憶目錄 | 只有文件 |
| 開完 PR 開 Auto-fix | 只有文件（auto mode 會擋下 engineer 開，擋下就在卡上記一筆，不重試；沒開成，engineer 照 [Babysit](../../.agents/skills/pstack/skills/poteto-mode/playbooks/babysit.md) 自己盯 CI） |
| 收尾第一句寫可封存或不可封存 | 只有文件 |
| engineer 可封存之後拿掉 `ready-for-agent`、結卡、封存 | 只有文件（PM 照〈收尾與封存〉做） |
| 卡的正文是唯一的規格、寫到的程式碼現況要核過 | verifier（Spec 軸對程式碼核正文的前提） |
| ADR 的位置、檔名、編號與標題行 | gate（`check_adrs.py`） |
| ADR 只在三個條件都成立時寫 | verifier |
| 程式碼裡的 dsh 引用數只降不升 | gate（`check_ratchets.py`，基準 `.github/ratchets.json`） |
| 註解裡的變更敘事用語只降不升 | gate（同上） |

只降不升的計數以目錄為單位，計法見 `check_ratchets.py` 的 `EXTENSIONS`、`EXCLUDED_PREFIXES`、`EXCLUDED_PARTS`、`EXEMPT`、`DSH`、`COMMENT_OR_INLINE_SLASHES`、`NARRATIVE`。清掉引用的 PR 要在同一張把基準調低：`python3 .github/scripts/check_ratchets.py --write`。基準不能調高，gate 會拿分歧點那一版的基準比。
