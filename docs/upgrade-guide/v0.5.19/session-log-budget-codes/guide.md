---
kind: upgrade-guide
description: 會話日誌超過額度時，打開 thread 不再回 unknown_error，改回 thread_log_too_large 或 thread_log_busy。
---

# 會話日誌超過額度改回專用錯誤碼

## 變更

舊行為：`serve` 因會話日誌額度拒收一條 thread 時，回 `unknown_error`，訊息開頭是「這條 thread 建不起來：」。

新行為：回兩個專用碼，訊息不加那個開頭，內容一樣寫出日誌大小、額度與下一步。

- `thread_log_too_large`：這一份本身就超過額度。重試沒用，要等管理者調整記憶體或額度並重啟。
- `thread_log_busy`：這一份放得下，但額度被別的開著的 thread 佔滿。等它們關掉或閒置逐出之後再試。

受影響的：自己接 wire 的客戶端，只要它把 `unknown_error` 當成可重試，或比對過「建不起來」這段文字。會續接舊 thread 的路都可能回這兩個碼，例如開下行、讀歷史、送訊息、改名。

## 遷移

1. 在客戶端搜尋 `unknown_error` 的處理與「建不起來」的比對。
2. 把 `thread_log_busy` 加進暫時失敗的分支，比照 `thread_at_capacity`：可以稍後重試。
3. 把 `thread_log_too_large` 當成永久失敗，不要重試，請使用者聯絡管理者。
4. 確認：在 `thread-capacity` 那一列把 `sessionLogBudgetMiB` 設成 `1`，重啟 `serve`，打開一條日誌超過 1 MiB 的 thread，應該收到 `thread_log_too_large`。確認後拿掉這個設定。
