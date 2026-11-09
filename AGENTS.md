# AGENTS.md

專案目標、架構與怎麼跑起來見 [README.md](README.md)；跑起來之後的操作見 [`docs/operations.md`](docs/operations.md)。

## 標題格式

PR 標題就是 history：squash 與 merge commit 都取 PR 標題，**原封不動成為 develop 與 main 上的 commit 標題**，feature 分支上的 commit message 會被 squash 掉。

```
<type>: <中文描述>
```

type 只有這幾個：`feat` 新功能、`fix` 修 bug、`refactor` 不改行為的重構、`perf` 效能、`test` 只動測試、`docs` 只動文件、`ci` 動 CI 或 workflow、`chore` 相依套件／設定／雜項、`release` `develop → main` 的同步 PR。

描述的規則，gate 會逐條檢查：

- 中文祈使句，說「做了什麼」而不是「改了哪個檔」
- 8 到 50 字
- 至少含一個中文字（套件名、指令名保留原文，整句英文不行）
- 不能是「更新」「調整」「修正一些問題」這種沒有資訊量的填充句

分支命名用 `<type>/<kebab-case>`，type 同上，例如 `fix/ci-duplicate-runs`。

gate 擋下標題時改標題即可，不需要重開 PR。

## PR 內文

**feature → develop**：用 `mattpocock-skills:pr`，照 [`.github/pull_request_template.md`](.github/pull_request_template.md)；段落標題與欄位名用英文，內文寫中文，用語照 [`GLOSSARY-MAP.md`](GLOSSARY-MAP.md) 指到的領域詞彙。模板之外的規則：

- 第一行寫 `Refs #N`，不寫 Closes；
- Summary 的圖優先用文字樹或 diff 草圖：GitHub 上 Mermaid 只露出一小塊；
- 「對照 dsh」照「技術實現標準」的三步寫；純文件、純設定的 PR 刪掉這一段；
- Evidence **寫實際跑過的，沒跑過就寫沒跑過**，這一段的價值來自它是真的；
- 檔案歸屬的同批適配（見「檔案歸屬」）寫在 Merge Danger。

用 `gh pr create --body` 開 PR 時 CLI 不會自動套模板，要自己照模板填。feature PR 的內文 gate 不檢查。

**開 PR 與每次推更新之前，對 diff 跑 [`comment-audit`](.agents/skills/comment-audit/SKILL.md)**（report 模式），照報告修完再推；判準見 [`docs/standards.md`](docs/standards.md)〈註解〉。

**develop → main（發版）**：內文會成為 main 上的 commit message，所以 gate 對這種 PR 強制要求 `## 變更內容` 與 `## 驗證方式` 兩個段落（`.github/scripts/check_pr.py`），不用上面的模板。「驗證方式」同樣寫實際跑過的指令與結果，沒跑過就寫沒跑過。

## 程式碼規範

程式碼怎麼寫（測試要求、秘密與環境變數處理）見 [`docs/standards.md`](docs/standards.md)。本檔只管協作流程。

## 技術實現標準

凡技術實現方法的問題，以 **DeepSeek Harness**（[`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)）為**參照**：先讀懂它的設計與實現，再選出對 nexus 最好的做法。目標是超越 dsh，不是複製它。

**先讀原始碼，不要靠搜尋或記憶回答。** 原始碼不進版控，clone 到 `references/deepseek-harness`（唯讀，不要改它）；clone 指令、中文文件入口與引用前的 SHA 核對見 [`docs/agents/codebase-memory.md`](docs/agents/codebase-memory.md#引用-deepseek-harness-之前)。

**怎麼選：**

1. **先講清楚 dsh 怎麼做、為什麼這樣做。** 指到原始碼（`path:line`，並註明 SHA），說出它在解決什麼問題、付出什麼代價。講不出來，就還沒到可以選的時候。
2. **再列出至少一種別的做法，用同一組標準比較**：正確性、失敗與恢復、效能、維護成本、nexus 的產品需求（企業內部聊天機器人、完全內網、多人共用主機、稽核、幾百人並行開發）、現有基座做不做得到（今天是 deepagents／LangChain JS／LangGraph JS，正遷往 vendor 的 Cordis，見 [`.docs/decisions-2026-10-11.md`](.docs/decisions-2026-10-11.md)）。
3. **選比較好的那一個，寫明它好在哪。** 比不出高下時照 dsh，因為它的做法已經在實際使用中驗證過。

**記在哪：** 對照與取捨寫在 PR 內文 Summary 的「對照 dsh」，或 `docs/`、`.docs/` 的 md，不寫進程式碼與註解（見 [`docs/standards.md`](docs/standards.md)）。做法跟 dsh 一樣的，寫一行出處就好；不一樣的，寫完整的比較。

**web 的 UI/UX**（視覺、設計 token、互動、動效）不在這條範圍內，規則見 [`apps/web/AGENTS.md`](apps/web/AGENTS.md)；會動到執行語意的介面行為仍照上面的規則。

## 分支策略

```
feature/*  --squash-->  develop  --merge commit-->  main  --workflow_dispatch-->  Release
```

`develop` 是預設分支、日常開發的整合目標；`main` 是唯一能產出 Release 的發佈分支。

- **兩條分支都禁止直接 push**，一律走 Pull Request。
- **`gate` CI 必須綠燈**才能合併。功能分支 → `develop` 的 PR 只跑跟異動有關的檢查，全套留到合併後那一輪；動到 `.github/workflows|scripts|actions` 的 PR 照樣全跑。跑哪些見 `.github/workflows/ci.yml` 檔頭。只改 PR 內文不會重跑 gate，改標題會。
- **合進 `develop` 之後，每個 commit 各跑一輪完整的 CI**（Actions 的「合併後完整一輪」，`.github/workflows/post-merge.yml`）。
  它不擋合併，但合併的 dev session **開下一張 PR 之前，先確認自己那個合併 commit 的這一輪是綠的**。
- **這一輪紅了，先只重跑失敗的 job 一次**（Actions 的 Re-run failed jobs）。轉綠、而且同一個 tree 在 PR 上是綠的，就當成偶發：
  開 backlog 卡（已有的就在卡上記一筆），不撤回。還是紅，就**撤回再修**：該張 PR 的作者 session 開撤回 PR，讓 `develop` 先恢復綠，
  修好再重新開 PR。
- **`main` 只接受來自 `develop` 的 PR**，由 `gate` 檢查 head branch 強制執行。緊急修補同樣先進 `develop`。
- **禁止 force push 與刪除分支**，無人可繞過規則（含 repo owner）。
- **`develop` 要求分支與 base 同步（strict）**；`main` 刻意不開。
- 合併方式：`feature → develop` 只能 squash；`develop → main` 只能 merge commit。

`main` 不開 strict、不開 linear history 的原因，規則的快照與匯出方式見 [`.github/rulesets/README.md`](.github/rulesets/README.md)。

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

clone 之後要設的 git 選項，與開發時會撞到的坑和繞法。見 [`docs/agents/dev-environment.md`](docs/agents/dev-environment.md)。那份文件裡的腳本**不會被任何東西自動執行**——它改的是 Claude Code 自己的 hook，不是本 repo 的程式碼。

### Domain docs

多 context 佈局：root 的 `GLOSSARY-MAP.md` 指向 `apps/*` 各自的 `GLOSSARY.md`。見 [`docs/agents/domain.md`](docs/agents/domain.md)。

### Code search

用 codebase-memory-mcp 的知識圖檢索程式碼，專案名 `nexus-agent` 與 `deepseek-harness`，索引各自在本機建。正向查找走圖；「沒有」「只有 N 個」這類否定宣稱要配 `check_index_coverage` 與 grep。見 [`docs/agents/codebase-memory.md`](docs/agents/codebase-memory.md)。
