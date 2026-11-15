---
kind: upgrade-guide
description: 接了會話日誌的會話，摘要器不再把被摘掉的原文寫進 /conversation_history/<會話>.md，改由模型用 history_read、history_search 從會話日誌讀回；每個請求多兩個工具。
---

# 被摘掉的原文改從會話日誌讀回，不再另存歷史檔

## 變更

v0.6.2 的摘要器每次摘要都把被換掉的原文寫進 `/conversation_history/<會話>.md`（`summarization` 那一列的 `historyPathPrefix` 可以改到別處，
例如工作區裡），摘要訊息告訴模型去讀那個檔。預設位置的檔在 graph state 裡，續接之後讀不到。

新版（[#2777](https://github.com/DemianLi/nexus-agent/issues/2777)）：

- 開著 `summarization` 的組裝多兩個唯讀工具 `history_read`、`history_search`，從會話日誌讀回被摘掉的原文，續接之後照樣讀得到。
  每個送給模型的請求多這兩個工具的定義。
- 接了會話日誌的會話（`serve` 與 CLI 都是）**不再寫歷史檔**，摘要訊息改成指向這兩個工具；日誌裡 `compaction/summary` 的 `filePath` 是 `null`。
  `historyPathPrefix` 在這些會話上不再有作用，鍵還在、照樣收。
- 沒接會話日誌的組裝（程式直接叫 `createNexusAgent`、沒有另外接日誌）行為不變：照寫歷史檔，`historyPathPrefix` 照舊生效。

受影響的：把 `historyPathPrefix` 指到工作區、靠那些 `.md` 檔留存或檢視對話原文的主機；以及依賴工具清單或請求內容固定不變的測試與比對。
舊會話日誌照常讀，已經寫出來的歷史檔不會被刪。

## 遷移

1. 沒有改過 `historyPathPrefix`、也沒有另外讀那些歷史檔的：不用改。
2. 靠工作區裡的歷史檔留存原文的：改從會話日誌拿。原文在 home 的 `sessions/` 底下每個會話的日誌裡，位置與格式見
   [`docs/operations.md`〈會話日誌〉](../../../operations.md#會話日誌)；給了 `--session-log <目錄>` 的在那個目錄。`summarization` 那一列的 `historyPathPrefix` 可以留著，不會報錯。
3. 不要這兩個工具的：只有把 `summarization` 那一列整個關掉才不掛；關掉之後不摘要，長對話會直接撞到模型的窗口上限。
4. 確認：跑一段長到會摘要的對話，用 `jq 'select(.type=="compaction/summary") | .data.filePath'` 看那個會話的日誌，每一筆都是 `null`；
   改過 `historyPathPrefix` 的，那個目錄底下沒有新的 `session_*.md`。
