---
kind: upgrade-guide
description: serve 出廠就有 thread 數上限 500、閒置 2 小時撤出記憶體；到了上限新 thread 回 thread_at_capacity。
---

# `serve` 出廠有 thread 上限與閒置逐出

## 變更

v0.5.19 的 `serve` 對行程裡的 thread 數沒有上限，組過的 thread 一直留在記憶體裡直到重啟。新版（PR #1480、#1496、#1639）
加了清單上的 `thread-capacity` 那一列，出廠兩格都開著：

- **`maxThreads: 500`**：行程裡到了 500 條，新的 thread 一律拒收，回錯誤碼 `thread_at_capacity`。送訊息、開下行、讀歷史、
  續聊磁碟上的舊 thread 都算新 thread；已經在行程裡的不受影響。
- **`idleEvictAfterMs: 7200000`**：沒人看著的 thread 閒置 2 小時撤出記憶體，名額跟著回來。日誌在磁碟上，再開會照重啟後的路徑重組。

這一列關不掉（寫 `disabled: true` 會起不來）。啟動輸出多兩行 `thread 上限：…`、`thread 閒置逐出：…`。

受影響的：所有 `serve` 主機。使用者多、側欄常一次點開很多舊對話的主機，比較可能碰到上限。

## 遷移

1. 要新的預設：不用動。
2. 要放寬或回到接近 v0.5.19 的行為：在 `--patch` 覆寫檔（或 `plugin config set thread-capacity --file -`）寫這一列，
   `maxThreads` 調大（沒有「不限」，最小是 1），`idleEvictAfterMs` 設 `0` 就不逐出：

   ```yaml
   - id: thread-capacity
     config:
       maxThreads: 1000
       idleEvictAfterMs: 0
   ```

3. 確認：啟動輸出的 `thread 上限：…` 與 `thread 閒置逐出：…` 是你要的值。細節見 [`docs/operations.md`](../../../operations.md) 的 `thread-capacity` 那一段。
