# nexus-agent

TypeScript + React (shadcn/ui) 專案，架構分為 harness 與 web UI 兩部分。

## 專案結構

```
apps/harness   step 執行器（Node / TypeScript）
apps/web       Vite + React 19 + Tailwind v4 + shadcn/ui
```

pnpm workspace，Node >= 22。

## 開發

```bash
pnpm install
pnpm dev          # 啟動 web（http://localhost:5173）
pnpm lint         # eslint（遞迴全部套件）
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run
pnpm build        # vite build
```

clone 之後各自設定一次，讓 `git fetch` / `git pull` 自動清掉遠端已刪除的分支：

```bash
git config fetch.prune true
```

PR 合併後 GitHub 會自動刪掉 head branch（repo 開了 `delete_branch_on_merge`），
沒設 prune 的話本地會累積一堆早已不存在的 `origin/*`。這條寫在 `.git/config`，不進版控。

新增 shadcn/ui 元件：

```bash
pnpm --filter @nexus/web dlx shadcn@latest add <component>
```

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
- **PR 標題必須符合 `<type>: <描述>` 格式**，由 `gate` 強制；格式見 [AGENTS.md](AGENTS.md)。
- **`main` 只接受來自 `develop` 的 PR**，由 `gate` 檢查 head branch 強制執行。緊急修補同樣先進 `develop`。
- **禁止 force push 與刪除分支**，無人可繞過規則（含 repo owner）。
- **`develop` 要求分支與 base 同步（strict）**；`main` 刻意不開 strict — 因為 `develop → main` 的 merge commit 只存在於 `main`，開了 strict 會讓第二次發版的 PR 永遠處於 out-of-date 而無法合併。
- 合併方式：`feature → develop` 只能 squash；`develop → main` 只能 merge commit（保留可追溯性，因此 `main` 不啟用 linear history）。

### 發佈

到 Actions 頁面執行 **Release** workflow，branch 選 `main` 並輸入版號（`vX.Y.Z`）。
workflow 會自行打 tag 並建立 GitHub Release。因為 `workflow_dispatch` 限定在 `main` 執行，
「從 develop 發版」在機制上不可能發生。

版號規則在 1.0 之前從簡：**完成一個 Phase 跳 minor，其餘一律 patch**。
1.0 之前 semver 本來就不承諾相容性，此刻套用完整規則只是徒增判斷成本。

不維護手寫的 CHANGELOG。release notes 由 `--generate-notes` 依 PR 標題自動生成，
而 PR 標題規範已經強制每個變更都有一句可讀的中文描述 — 那就是 changelog 的原料。

## CI

`gate` 是唯一的 required status check，名稱永久固定。
它無條件觸發，在 job 內以 `git diff` 計算異動檔案再決定要掃什麼；
沒有可掃的檔案時直接綠燈通過，因此純文件的 PR 不會卡住。
