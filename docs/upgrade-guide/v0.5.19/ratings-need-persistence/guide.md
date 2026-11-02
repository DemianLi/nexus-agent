---
kind: upgrade-guide
description: 清單把會話日誌落盤關掉時，評分（讚／踩）改成整個不能用，評語照常。
---

# 評分要落盤才收

## 變更

v0.5.19 評一則回覆，寫進記憶體裡的日誌就回成功，不等磁碟。新版（#1606）評分與收回評分要等那一筆真的寫進會話日誌、讀回來比對過才回成功，
所以：

- **清單把落盤關掉時**（`--patch` 或 `cordis.yml` 裡 `session-persistence` 那一列 `disabled: true`），評分整個不能用：`feedback.put`、
  `feedback.list`、`feedback.delete` 回 `not_supported`，訊息是「這個組裝沒有掛落盤，評分存不住」，畫面上的讚／踩按了會報錯。
  評語（`/feedback` 與 `feedback.record`）照常。
- **落盤開著、但那一筆寫不進去時**（磁碟滿、權限被改），評分回 `unknown_error`「評分沒存成，原因記在 serve 的日誌」，不再回成功。
- **日誌裡有一顆評分事件結構不對時**，那條對話的評分讀寫回 `unknown_error`「評分紀錄壞了：…」；對話本身與歷史照常讀得到。

受影響的：把落盤關掉、只放記憶體跑的主機，以及會直接打 wire 的 `feedback.*` 的客戶端。

## 遷移

1. 要繼續收評分：讓 `session-persistence` 那一列掛著。用覆寫檔關的，把那一列的 `disabled: true` 拿掉；用
   `plugin disable session-persistence` 關的，跑 `plugin enable session-persistence`。並照 [`docs/operations.md`〈升級與回滾〉](../../../operations.md#升級與回滾) 把 home 納入備份。
2. 要維持只放記憶體：不用改設定。評分會關掉，評語照收；要讓使用者知道畫面上的讚／踩不能用。
3. 直接打 wire 的客戶端：`feedback.put`／`feedback.delete`／`feedback.list` 要處理 `not_supported` 與 `unknown_error`，不要當成網路錯誤重送。
4. 確認：啟動輸出是 `會話日誌：<目錄>`（不是「只在記憶體裡」），開一條對話評一則回覆，重新整理之後評分還在。
