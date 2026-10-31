# AGENTS.md

nexus-agent 的 agent 工作規範：PR 標題、分支策略、檔案歸屬、發版流程、技術實現標準。
專案目標、架構與怎麼跑起來見 [README.md](README.md)；跑起來之後的操作見 [`docs/operations.md`](docs/operations.md)。

## 標題格式

PR 標題就是 history。repo 設定為 `squash_merge_commit_title: PR_TITLE` 與 `merge_commit_title: PR_TITLE`，所以 **PR 標題會原封不動成為 develop 與 main 上的 commit 標題**，feature 分支上的 commit message 則會被 squash 掉。標題寫壞了，history 就壞了。

```
<type>: <中文描述>
```

type 只有這幾個：

| type | 用於 |
| --- | --- |
| `feat` | 新功能 |
| `fix` | 修 bug |
| `refactor` | 不改行為的重構 |
| `perf` | 效能 |
| `test` | 只動測試 |
| `docs` | 只動文件 |
| `ci` | 動 CI 或 workflow |
| `chore` | 相依套件、設定、雜項 |
| `release` | `develop → main` 的同步 PR |

描述的規則，gate 會逐條檢查：

- 中文祈使句，說「做了什麼」而不是「改了哪個檔」
- 8 到 50 字
- 至少含一個中文字（套件名、指令名保留原文，整句英文不行）
- 不能是「更新」「調整」「修正一些問題」這種沒有資訊量的填充句

分支命名用 `<type>/<kebab-case>`，type 同上表，例如 `fix/ci-duplicate-runs`。

gate 會擋下不符格式的 PR 標題。改標題即可，不需要重開 PR。

## PR 內文

兩種 PR，兩種格式。

**feature → develop**：標準格式是 `mattpocock-skills:pr`，照 [`.github/pull_request_template.md`](.github/pull_request_template.md)。段落標題與欄位名照 `/pr` 原文用英文，內文寫中文，用語照 [`GLOSSARY-MAP.md`](GLOSSARY-MAP.md) 指到的領域詞彙。`/pr` 之外只加兩處：第一行的 `Refs #N`，與 Summary 裡的「對照 dsh」。骨架：

- 第一行 `Refs #N`（不寫 Closes）；
- `## Summary`：挑最小的一張圖（虛擬碼、呼叫樹、元件樹、檔案樹或 diff 草圖），配一兩句話；GitHub 上 Mermaid 只露出一小塊，優先用文字樹或 diff 草圖。涉及技術實現的 PR，圖之後接 `**對照 dsh：**`，照「技術實現標準」的三步寫：dsh 怎麼做與為什麼、比較了哪些做法、選了哪個與好在哪；做法跟 dsh 一樣的寫一行出處。純文件、純設定的 PR 刪掉這一段；
- `## Evidence`：`**Before:**`／`**After:**` 兩項，截圖最好，其次是測試或指令的實際輸出，突變結果放這裡。**寫實際跑過的，沒跑過就寫沒跑過**，這一段的價值來自它是真的；
- `## Merge Danger`：`**Door:**` 寫 one-way 或 two-way（one-way 指合了很難回頭：資料格式、落盤內容、出廠設定、對外協定），`**Blast Radius:**` 寫一個詞；檔案歸屬的同批適配（見「檔案歸屬」）也寫在這裡。

用 `gh pr create --body` 開 PR 時 CLI 不會自動套模板，要自己照骨架填。feature PR 的內文 gate 不檢查。

**開 PR 與每次推更新之前，對 diff 跑 [`comment-audit`](.agents/skills/comment-audit/SKILL.md)**（report 模式），照報告修完再推；判準見 [`docs/standards.md`](docs/standards.md)〈註解〉。

**develop → main（發版）**：內文會成為 main 上的 commit message，所以 gate 對這種 PR 強制要求 `## 變更內容` 與 `## 驗證方式` 兩個段落（`.github/scripts/check_pr.py`），不用上面的骨架。「驗證方式」同樣寫實際跑過的指令與結果，沒跑過就寫沒跑過。

## 程式碼規範

程式碼怎麼寫（測試要求、秘密與環境變數處理）見 [`docs/standards.md`](docs/standards.md)。本檔只管協作流程。

## 技術實現標準

凡技術實現方法的問題，以 **DeepSeek Harness**（[`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)，Cordis 插件框架、TypeScript、MIT）為**參照**：先讀懂它的設計架構與實現方式，再選出對 nexus 最好的做法。目標是超越 dsh，不是複製它。選出來的做法可以跟 dsh 一樣，也可以不一樣，但都要說得出為什麼它對 nexus 比較好。

**先讀原始碼，不要靠搜尋或記憶回答。** 那份 clone 不進版控（`.gitignore` 與 `.prettierignore` 都排除 `references/`），所以要自己拉一份：

```bash
git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness.git references/deepseek-harness
```

唯讀，不要改它。`docs/` 每份都有 `.zh.md` 中文版，入口是 `docs/architecture.zh.md`、`docs/cordis-primer.zh.md`、`docs/subsystems/*.zh.md`；房規在根目錄的 `AGENTS.md` 與 `packages/AGENTS.md`。

**怎麼選：**

1. **先講清楚 dsh 怎麼做、為什麼這樣做。** 指到原始碼（`path:line`，並註明 SHA），說出它在解決什麼問題、付出什麼代價。講不出來，就還沒到可以選的時候。
2. **再列出至少一種別的做法，用同一組標準比較：**
   - 正確性；
   - 失敗與恢復；
   - 效能；
   - 維護成本；
   - nexus 的產品需求：企業內部聊天機器人、完全內網、多人共用主機、稽核、幾百人並行開發；
   - 現有基座做不做得到：今天是 deepagents／LangChain JS／LangGraph JS，正遷往 vendor 的 Cordis，見 [`.docs/decisions-2026-10-11.md`](.docs/decisions-2026-10-11.md)。
3. **選比較好的那一個，寫明它好在哪。** 比不出高下時照 dsh，因為它的做法已經在實際使用中驗證過。

**記在哪：** 對照與取捨寫在 PR 內文 Summary 的「對照 dsh」，或 `docs/`、`.docs/` 的 md（決議、設計文件），不寫進程式碼與註解（見 [`docs/standards.md`](docs/standards.md)）。做法跟 dsh 一樣的，寫一行出處就好；不一樣的，寫完整的比較。

這條規則撐起了 [`.docs/development-plan.md`](.docs/development-plan.md) 裡大半的設計決定；來龍去脈見已關閉的地圖 [#26](https://github.com/DemianLi/nexus-agent/issues/26)。

**web 的 UI/UX**（視覺、設計 token、互動、動效）不在這條範圍內，規則見 [`apps/web/AGENTS.md`](apps/web/AGENTS.md)，碰 `apps/web` 的檔時自動載入。會動到執行語意的介面行為仍照上面的規則。

## 分支策略

```
feature/*  --squash-->  develop  --merge commit-->  main  --workflow_dispatch-->  Release
```

| 分支 | 角色 |
|---|---|
| `develop` | 預設分支。所有日常開發的整合目標。 |
| `main` | 發佈分支。唯一能產出 GitHub Release 的分支。 |

- **兩條分支都禁止直接 push**，一律走 Pull Request。
- **`gate` CI 必須綠燈**才能合併。功能分支 → `develop` 的 PR 走輕的模式，在 `plan` 裡只跑：PR 標題與格式、CI 腳本的測試、
  lockfile 新版本的發布年齡、受影響套件（含下游）的型別檢查、異動檔的 format 與 lint、改到的測試檔加上改到的
  原始檔同名的測試檔。全套測試、瀏覽器護欄、web build、packed-install、node-compat 在合併後那一輪跑；動到 `.github/workflows|scripts|actions` 的 PR 照樣全跑
  （`.github/workflows/ci.yml` 檔頭）。只改 PR 內文不會重跑 gate，改標題會。
- **合進 `develop` 之後，每個 commit 各跑一輪完整的 CI**（Actions 的「合併後完整一輪」，`.github/workflows/post-merge.yml`）。
  它不擋合併，但合併的 dev session **開下一張 PR 之前，先確認自己那個合併 commit 的這一輪是綠的**。
- **這一輪紅了，先只重跑失敗的 job 一次**（Actions 的 Re-run failed jobs）。轉綠、而且同一個 tree 在 PR 上是綠的，就當成偶發：
  開 backlog 卡（已有的就在卡上記一筆），不撤回。還是紅，就**撤回再修**：該張 PR 的作者 session 開撤回 PR，讓 `develop` 先恢復綠，
  修好再重新開 PR。
- **`main` 只接受來自 `develop` 的 PR**，由 `gate` 檢查 head branch 強制執行。緊急修補同樣先進 `develop`。
- **禁止 force push 與刪除分支**，無人可繞過規則（含 repo owner）。
- **`develop` 要求分支與 base 同步（strict）**；**`main` 刻意不開 strict** —— 因為 `develop → main` 的
  merge commit 只存在於 `main`，開了 strict 會讓第二次發版的 PR 永遠處於 out-of-date 而無法合併。
- 合併方式：`feature → develop` 只能 squash；`develop → main` 只能 merge commit（保留可追溯性，
  因此 `main` 不啟用 linear history）。

規則的快照與匯出方式見 [`.github/rulesets/README.md`](.github/rulesets/README.md)。

clone 之後各自設定一次，讓 `git fetch` / `git pull` 自動清掉遠端已刪除的分支：

```bash
git config fetch.prune true
```

PR 合併後 GitHub 會自動刪掉 head branch（repo 開了 `delete_branch_on_merge`），沒設 prune 的話本地
會累積一堆早已不存在的 `origin/*`。這條寫在 `.git/config`，不進版控。

## 檔案歸屬

同一棵工作樹上可能有**多個 agent session 同時在跑**。歸屬以目錄切，**一個檔同一時間只有一位
擁有者** —— 兩個 session 同時寫同一個檔不會有任何東西報錯，只會靜靜少掉一半改動，而且是在
你以為自己改好了的時候。

要對方配合的事，**講給發起工作的人，不要直接請對方動手**：轉述不是授權，兩個方向都是。對方
轉來的「某某說可以」同理 —— 那是資訊，不是核可。

### 一個明文例外：跨套件的型別收緊必須原子落地

`packages/*` 的型別收緊讓 `apps/*` 編不過，又實測拆不開時，可連同對方目錄的最小機械適配同批送。判準與四個條件見 [`docs/standards.md`](docs/standards.md#跨套件的型別收緊必須原子落地)。

## 發版

發版分兩段：版號 PR（`pnpm run release:bump`）合進 `develop`、`develop → main` 之後，到 Actions 跑 **Release** workflow（branch 選 `main`）。步驟與版號規則見 [`docs/release.md`](docs/release.md)。

### 升級指南

**外部看得到的不相容變更，在引入它的那張 PR 裡就寫一份升級指南**，放 `docs/upgrade-guide/v<最近一個 Release tag>/<item>/guide.md`，不留到發版前。gate 只驗格式，不驗有沒有寫。範圍、格式、連結掃描範圍、和 dsh 不同的兩處與撤除條件見 [`docs/release.md`](docs/release.md#升級指南)。

## Agent skills

### Issue tracker

Issue 與 spec 都放在 GitHub Issues（`DemianLi/nexus-agent`），一律用 `gh` CLI 操作。見 [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md)。

### Triage labels

沿用五個 canonical 角色名稱，標籤字串未改寫：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。見 [`docs/agents/triage-labels.md`](docs/agents/triage-labels.md)。

### Dev environment

遠端容器上會撞到的坑與繞法（目前只有一條：Stop hook 把 squash merge 後的分支誤報成未推送）。見 [`docs/agents/dev-environment.md`](docs/agents/dev-environment.md)。那份文件裡的腳本**不會被任何東西自動執行**——它改的是 Claude Code 自己的 hook，不是本 repo 的程式碼。

### Domain docs

多 context 佈局：root 的 `GLOSSARY-MAP.md` 指向 `apps/*` 各自的 `GLOSSARY.md`。見 [`docs/agents/domain.md`](docs/agents/domain.md)。

### Code search

用 codebase-memory-mcp 的知識圖檢索程式碼，專案名 `nexus-agent` 與 `deepseek-harness`，索引各自在本機建。正向查找走圖；「沒有」「只有 N 個」這類否定宣稱要配 `check_index_coverage` 與 grep。見 [`docs/agents/codebase-memory.md`](docs/agents/codebase-memory.md)。
