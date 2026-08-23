# AGENTS.md

nexus-agent 的 agent 工作規範。分支策略、發版流程、開發指令見 [README.md](README.md)。

## 標題格式

Commit 與 PR 共用同一個格式，因為 develop 用 squash merge — **PR 標題會原封不動成為 develop 上的 commit message**。標題寫壞了，history 就壞了。

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

描述用中文祈使句，說「做了什麼」而不是「改了哪個檔」，50 字以內。

分支命名用 `<type>/<kebab-case>`，type 同上表，例如 `fix/ci-duplicate-runs`。

gate 會擋下不符格式的 PR 標題。改標題即可，不需要重開 PR。

## PR 內文

[`.github/pull_request_template.md`](.github/pull_request_template.md) 是唯一格式。

用 `gh pr create --body` 開 PR 時 CLI 不會自動套模板，要自己照模板的段落填。

「驗證方式」寫實際跑過的指令與結果。沒跑過就寫沒跑過 — 這一段的價值來自它是真的。
