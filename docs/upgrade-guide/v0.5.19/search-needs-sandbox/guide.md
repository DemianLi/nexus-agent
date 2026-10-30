---
kind: upgrade-guide
description: grep、glob 與改動卡的 git 改經沙箱跑；沒有 Landlock 的主機與非 Linux 上搜尋會失敗、改動卡不出現，核心比 5.3 舊的主機所有模式都跑不了工具。
---

# grep、glob 與改動卡的 git 改經沙箱跑，沒有 Landlock 的主機上會失敗

## 變更

v0.5.19 的 `grep`、`glob` 由 serve 直接起 rg，不套作業系統的沙箱。新版（#1946）在 Linux 上一律經產物裡的 `native/nexus-sandbox-spawner` 起：seccomp 擋網路，Landlock 只給讀工作區、rg 本身與 rg 會讀的忽略規則。

- **沒有 Landlock 的 Linux 主機，以及非 Linux：** `read-only`、`workspace-write` 下的 `grep`、`glob` 一律失敗，工具結果的碼是 `SEARCH_FAILED`，訊息裡有 `SANDBOX_UNAVAILABLE`。不會退回不設防的 rg。
- **改動卡：** workspace-changes 的 git 同樣經 spawner，模式跟著會話。上面那些主機上改動卡不會出現，日誌只講一句，也不會退回不設防的 git。git 要裝在 `/usr` 或 `/lib` 底下；改了全域 git 設定要重起 serve；repo 根包住 `$HOME` 時改動卡不出現。
- **核心比 5.3 舊的主機：** spawner 起不來，連 `danger-full-access` 也跑不了工具。
- **Landlock ABI 不到 6 的主機：** 工具照跑，serve 的日誌印一次「只有部分強制」。
- **`danger-full-access`：** 不上 Landlock，有沒有 Landlock 都能跑（核心要 5.3 以上）；Linux 上網路照擋。

受影響的是核心比 5.13 舊、或開機的 LSM 清單沒有 `landlock` 的主機，以及在 Mac 上跑 serve 的開發者。編進核心不夠，LSM 清單沒有它一樣沒開，要在開機參數 `lsm=` 加上。

## 遷移

1. 確認主機有沒有 Landlock：`cat /sys/kernel/security/lsm` 的輸出要有 `landlock`。有就不必遷移，跳到最後一步。
2. 沒有的話，擇一處理：
   - 換成核心 5.13 以上、有啟用 Landlock 的主機（建議）；
   - 把 `danger-full-access` 加回權限表，用它起 serve，寫法見 [`docs/operations.md`](../../../operations.md)。這一組不限制檔案工具，只適合單人使用的環境。
3. 起 serve，看起動那一行 `沙箱：…`，再讓模型跑一次 `grep`：那一行寫著強制，結果正常，訊息裡沒有 `SANDBOX_UNAVAILABLE`，就是改好了。
