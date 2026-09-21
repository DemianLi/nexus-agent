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

[`.github/pull_request_template.md`](.github/pull_request_template.md) 是唯一格式。

用 `gh pr create --body` 開 PR 時 CLI 不會自動套模板，要自己照模板的段落填。

`develop → main` 的 PR 內文會成為 main 上的 commit message，所以 gate 對這種 PR 強制要求 `## 變更內容` 與 `## 驗證方式` 兩個段落。feature PR 的內文不強制。

「驗證方式」寫實際跑過的指令與結果。沒跑過就寫沒跑過 — 這一段的價值來自它是真的。

## 程式碼規範

程式碼怎麼寫（測試要求、秘密與環境變數處理）見 [`docs/standards.md`](docs/standards.md)。本檔只管協作流程。

## 技術實現標準

凡技術實現方法的問題，一律以 **DeepSeek Harness**（[`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)，Cordis 插件框架、TypeScript、MIT）的實際做法為標準。

**先讀原始碼，不要靠搜尋或記憶回答。** 那份 clone 不進版控（`.gitignore` 與 `.prettierignore` 都排除 `references/`），所以要自己拉一份：

```bash
git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness.git references/deepseek-harness
```

唯讀，不要改它。`docs/` 每份都有 `.zh.md` 中文版，入口是 `docs/architecture.zh.md`、`docs/cordis-primer.zh.md`、`docs/subsystems/*.zh.md`；房規在根目錄的 `AGENTS.md` 與 `packages/AGENTS.md`。

**偏離規則**：一律照 dsh 的實際做法，**只有當現有基礎建設（deepagents / LangChain JS / LangGraph JS）表達不出來時**，才退到最接近的實作 —— 而且要在決議或 PR 內文裡明確標註是哪一條、為什麼表達不出來、退到什麼。不得因為「我們的形狀不同」就自由發揮。

這條規則撐起了 [`.docs/development-plan.md`](.docs/development-plan.md) 裡大半的設計決定；來龍去脈見已關閉的地圖 [#26](https://github.com/DemianLi/nexus-agent/issues/26)。

**不在這條範圍內的：web 的 UI/UX**（視覺、設計 token、互動、動效）。這一塊以 **shadcn＋Tailwind 為基底**、[Libraries.dev](https://github.com/Jakubantalik/Libraries.dev) 為模仿對象（元件多樣性、交互體驗、動效呈現），最後長成本專案自己的系統風格。dsh 在 UI/UX 上**最多只參考元件的多樣性**（有哪些元件、哪些面），不拿來當建議的依據，也不需要寫偏離標註。會動到執行語意的介面行為（例如按下去這一輪停不停）仍照上面的規則。來龍去脈見地圖 [#372](https://github.com/DemianLi/nexus-agent/issues/372) 的 Notes。

## 分支策略

```
feature/*  --squash-->  develop  --merge commit-->  main  --workflow_dispatch-->  Release
```

| 分支 | 角色 |
|---|---|
| `develop` | 預設分支。所有日常開發的整合目標。 |
| `main` | 發佈分支。唯一能產出 GitHub Release 的分支。 |

- **兩條分支都禁止直接 push**，一律走 Pull Request。
- **`gate` CI 必須綠燈**才能合併。
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

`packages/*` 的一次型別收緊會讓消費它的 `apps/*` **當場編不過**。拆成兩張 PR 的話，中間那段
時間樹是紅的，而 `develop` 要求 gate 綠燈 —— 兩張都合不進去。

**先確認拆不開。** 很多收緊其實拆得開，而拆開是預設：加一個必填欄位就是 —— 對方那一刀
（把新欄位補進測試建構器之類）在**還沒有那個欄位的樹上**照樣編得過、照樣綠，先合它完全無害。
判準是實測，不是直覺：把對方那一刀單獨套在今天的 `develop` 上，typecheck 與測試跑一遍。

拆不開的長這樣：**聯集少一支、欄位改名、函式簽名換形狀** —— 對方的適配在舊樹上編不過，
你的改動在對方適配之前也編不過，**沒有一個順序是綠的**。這一節管的就是這一類。

那時候：**提出改動的那一方可以連同對方目錄裡那份最小機械適配一起送**，四個條件要全部成立：

- **真的拆不開**，而且是上面那段的實測判準說拆不開，不是覺得麻煩。
- **只做機械適配**，不做對方領域的設計判斷。分不出算不算「機械」的時候，它就不算 —— 停下來
  交回去問。
- **足跡取最小**。改一個共用的測試建構器，勝過改二十個呼叫點：對方正在改的東西撞上你的機會
  跟著變小。
- **PR 內文寫明動了哪個目錄、為什麼必須同批**，而且**當面知會那個 session**。

這條例外只管「編不過」。對方領域裡**行為**要跟著改的那一類（畫面、互動、文案），不在射程內
—— 那是一張自己的卡。

## 發版

到 Actions 頁面執行 **Release** workflow，branch 選 `main` 並輸入版號（`vX.Y.Z`）。workflow 會自行
打 tag 並建立 GitHub Release。因為 `workflow_dispatch` 限定在 `main` 執行，「從 develop 發版」在機制上
不可能發生。

版號規則在 1.0 之前從簡：**完成一個 Phase 跳 minor，其餘一律 patch**。1.0 之前 semver 本來就不承諾
相容性，此刻套用完整規則只是徒增判斷成本。

不維護手寫的 CHANGELOG。release notes 由 `--generate-notes` 依 PR 標題自動生成，而 PR 標題規範已經
強制每個變更都有一句可讀的中文描述 —— 那就是 changelog 的原料。

## Agent skills

### Issue tracker

Issue 與 spec 都放在 GitHub Issues（`DemianLi/nexus-agent`），一律用 `gh` CLI 操作。見 [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md)。

### Triage labels

沿用五個 canonical 角色名稱，標籤字串未改寫：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。見 [`docs/agents/triage-labels.md`](docs/agents/triage-labels.md)。

### Dev environment

遠端容器上會撞到的坑與繞法（目前只有一條：Stop hook 把 squash merge 後的分支誤報成未推送）。見 [`docs/agents/dev-environment.md`](docs/agents/dev-environment.md)。那份文件裡的腳本**不會被任何東西自動執行**——它改的是 Claude Code 自己的 hook，不是本 repo 的程式碼。

### Domain docs

多 context 佈局：root 的 `CONTEXT-MAP.md` 指向 `apps/*` 各自的 `CONTEXT.md`。見 [`docs/agents/domain.md`](docs/agents/domain.md)。

### Code search

用 codebase-memory-mcp 的知識圖檢索程式碼，專案名 `nexus-agent` 與 `deepseek-harness`，索引各自在本機建。正向查找走圖；「沒有」「只有 N 個」這類否定宣稱要配 `check_index_coverage` 與 grep。見 [`docs/agents/codebase-memory.md`](docs/agents/codebase-memory.md)。
