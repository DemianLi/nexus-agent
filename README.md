# nexus-agent

TypeScript + React (shadcn/ui) 專案，架構分為 harness 與 web UI 兩部分。

## 分支策略

```
feature/*  --squash-->  develop  --merge commit-->  main  --workflow_dispatch-->  Release
```

| 分支 | 角色 |
|---|---|
| `develop` | 預設分支。所有日常開發的整合目標。 |
| `main` | 發佈分支。唯一能產出 GitHub Release 的分支。 |

### 規則

- **兩條分支都禁止直接 push**，一律走 Pull Request。
- **`gate` CI 必須綠燈**才能合併，且分支必須與 base 同步（strict）。
- **`main` 只接受來自 `develop` 的 PR**，由 `gate` 檢查 head branch 強制執行。緊急修補同樣先進 `develop`。
- **禁止 force push 與刪除分支**，無人可繞過規則（含 repo owner）。
- 合併方式：`feature → develop` 只能 squash；`develop → main` 只能 merge commit（保留可追溯性，因此 `main` 不啟用 linear history）。

### 發佈

到 Actions 頁面執行 **Release** workflow，branch 選 `main` 並輸入版號（`vX.Y.Z`）。
workflow 會自行打 tag 並建立 GitHub Release。因為 `workflow_dispatch` 限定在 `main` 執行，
「從 develop 發版」在機制上不可能發生。

## CI

`gate` 是唯一的 required status check，名稱永久固定。
它無條件觸發，在 job 內以 `git diff` 計算異動檔案再決定要掃什麼；
沒有可掃的檔案時直接綠燈通過，因此純文件的 PR 不會卡住。
