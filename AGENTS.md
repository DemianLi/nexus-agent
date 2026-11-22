# AGENTS.md

專案目標、架構與怎麼跑起來見 [README.md](README.md)；跑起來之後的操作見 [`docs/operations.md`](docs/operations.md)。

## 協作模式

需求釐清成 `ready-for-agent` 的卡之後，由 PM、engineer、verifier 自動開發到合進 `develop`。流程、開場說明、合併與撤回、對照 dsh、ADR、「規則與執行者」表見 [`docs/agents/collab-mode.md`](docs/agents/collab-mode.md)；執行方式見 [pstack 副本](.agents/skills/pstack/skills/poteto-mode/SKILL.md)。**上下文只放在進版控的檔或共用的記憶目錄。**

## 收尾

每個 session 回合結束時，最後那段話的第一句是下面三種之一：

- `可封存：<一句理由>`：這個 session 裡沒有只存在它身上的東西。沒有沒 commit 的檔、沒推的 commit、自己開而還沒合的 PR、在等的 CI 或背景工作，被問的事也答完了。環境提供封存按鈕時一併附上，由 operator 點；engineer 與 verifier 由 PM 封存。
- `不可封存：<還差什麼>`：上面任何一項還在。
- `還在等：<等什麼>`：被 app 叫醒（例如子 session 中途停下、背景工作跑完），而狀態跟上一次收尾比沒變。只寫這一行。

engineer、verifier、PM 另有自己的判準（例如長駐的 PM 不封存），以角色的為準；判準與誰來封存見 [collab-mode](docs/agents/collab-mode.md#收尾與封存)。session 不封存自己。`Stop` hook（`.claude/settings.json`）檢查這一輪最後一則訊息（輸入裡的 `last_assistant_message`，沒有就不檢查）的第一個非空行：不是三種前綴之一加冒號，或 `還在等：` 不只一行，就擋回去重寫一次。它只擋一次，出錯就放行，也看不出理由寫得對不對。

## 標題格式

PR 標題原封不動成為 `develop` 與 `main` 上的 commit 標題：

```
<type>: <中文描述>
```

type：`feat` `fix` `refactor` `perf` `test` `docs` `ci` `chore`，`develop → main` 用 `release`。描述是中文祈使句、8 到 50 字、說「做了什麼」而不是改了哪個檔；至少一個中文字，套件名與指令名保留原文；不寫「更新」「調整」這類填充句（gate 檢查 type、字數、中文與填充句，擋下時改標題即可）。分支命名 `<type>/<kebab-case>`。

## PR 內文

- **feature → develop**：`mattpocock-skills:pr` 照 [`.github/pull_request_template.md`](.github/pull_request_template.md)，段落標題與欄位名用英文、內文寫中文，用語照 [`GLOSSARY-MAP.md`](GLOSSARY-MAP.md)。Summary 的圖優先用文字樹或 diff 草圖。第一行 `Refs #N`，不寫 Closes。`gh pr create --body` 不會套模板，要自己照填。Evidence **寫實際跑過的，沒跑過就寫沒跑過**。一般功能 PR 的內文 gate 不檢查；清掉註解裡 dsh 對照的 PR（階段 1，規則見 [collab-mode](docs/agents/collab-mode.md#對照-dsh)）例外，內文要附逐句證據，本機跑 `python3 .github/scripts/check_dsh_cleanup.py` 印出要填的列。
- 開 PR 與每次推更新之前，對 diff 跑 [no-comments](.agents/skills/pstack/skills/no-comments/SKILL.md)，刪掉的註解列進內文。
- **develop → main**：內文要有 `## 變更內容` 與 `## 驗證方式`（gate 檢查）；驗證方式同樣只寫實際跑過的。

## 分支

```
feature/*  --squash-->  develop  --merge commit-->  main  --workflow_dispatch-->  Release
```

兩條分支都只走 PR、`gate` 綠才能合，禁止 force push 與刪除，無人可繞過；`develop` 要求 strict。合併後那一輪與撤回見 [collab-mode](docs/agents/collab-mode.md#合併與撤回)；規則快照見 [`.github/rulesets/README.md`](.github/rulesets/README.md)。

## 技術實現標準

技術實現以 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 為參照：先讀懂它怎麼做、為什麼，再比過至少一種別的做法，選對 nexus 最好的；目標是超越，不是複製。原始碼 clone 在 `references/deepseek-harness`（唯讀）。方法與記錄位置見 [collab-mode](docs/agents/collab-mode.md#對照-dsh)。web 的 UI/UX 照 [`apps/web/AGENTS.md`](apps/web/AGENTS.md)，會動到執行語意的介面行為仍照這條。

## 發版

版號 PR 合進 `develop`、`develop → main` 之後，到 Actions 跑 **Release**（branch 選 `main`）。外部看得到的不相容變更，**在引入它的那張 PR** 寫升級指南。步驟、版號規則與指南格式見 [`docs/release.md`](docs/release.md)。

## 文件索引

- 程式碼規範：[`docs/standards.md`](docs/standards.md)
- issue：[`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md)；標籤：[`docs/agents/triage-labels.md`](docs/agents/triage-labels.md)
- 開發環境：[`docs/agents/dev-environment.md`](docs/agents/dev-environment.md)
- 領域文件與 ADR：[`docs/agents/domain.md`](docs/agents/domain.md)
- 程式碼檢索：[`docs/agents/codebase-memory.md`](docs/agents/codebase-memory.md)。正向查找走圖；「沒有」「只有 N 個」這類否定宣稱配 `check_index_coverage` 與 grep。
