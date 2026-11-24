# 項目倉庫分成 harness 與 web 兩個頂層目錄

2026-11-23 的決定（類別：項目）。倉庫根只留 `harness/`、`web/`、`docs/`、`.github/` 與兩邊共用的 workspace、lockfile、tsconfig、eslint、prettier、tsdown、vitest 設定。`web/` 本身就是 web 套件；`harness/` 底下是 `apps/harness/`、`packages/`、`native/`、`vendor/`、`scripts/`，也就是原本放在根目錄的 `apps/harness`、`packages/`、`native/`、`vendor/`、`scripts/`。只搬檔與改路徑，行為不變；`.env` 往上找的層數、spawner 的搜尋範圍與發版成員的算法這三處跟著搬家改，各自在 [`operations.md`](../operations.md) 與測試裡說明。

為什麼這樣切：web 只相依 `@nexus/wire`，harness 與 `harness/scripts/` 不讀也不 import web（`.github/scripts/check_boundary.py` 擋），兩邊的邊界已經由 gate 守住；頂層目錄把這條邊界變成目錄結構，看目錄就知道哪一邊是前端。協作用的檔（agent 設定、協作流程文件與它的 hook 與測試）不屬於產品，移出項目倉庫，由外層的本地 git 管，項目倉庫單獨 clone 就是完整的產品原始碼與規範。

為什麼 harness 與 web 先不拆成兩個倉庫：兩邊共用 workspace、lockfile、型別與 lint 設定、CI 與發版成員（發版把同一個版本寫進 web 與每個 harness 套件），分開要先決定版本怎麼對齊、wire 怎麼發佈，那些問題在目前的規模沒有收益；而兩邊的邊界已經可以在同一個倉庫裡守住。之後要拆時，頂層目錄就是切口。

## Considered Options

- **維持 `apps/*`、`packages/*` 平鋪在根目錄**：web 與 harness 的界線只靠 gate 的字串檢查，目錄看不出來；根目錄混著前端、後端、原生程式與工具腳本。
- **現在就拆成兩個倉庫**：多出版本對齊與 wire 發佈的成本，換不到目前用得上的好處。
- **`harness/` 與 `web/` 各自有獨立的 workspace**：兩份 lockfile 與兩套 CI，共用的 tsconfig、lint 與發版成員要複製或發佈。

## Consequences

- 從原始碼跑、照路徑下指令的人，路徑多一層：`apps/harness` 變 `harness/apps/harness`，`apps/web` 變 `web`。
- 既有 checkout 在 `native/`、`apps/`、`packages/`、`vendor/`、`scripts/` 留下的建置產物，由 `.gitignore` 的過渡規則繼續忽略；漏搬的原始碼不會被藏起來。舊位置的 spawner 不會被拿來用，存在時啟動報錯並說要搬去哪裡。
- 搬家前開出來的分支合進來時，新檔會留在舊路徑、不在 workspace 裡，型別、lint、測試都跑不到：gate 會擋進版控的檔裡以 `apps/`、`packages/`、`native/`、`vendor/`、`scripts/` 開頭的路徑。
- 重開條件：兩邊的發版節奏要分開，或 wire 要給第三方消費。
