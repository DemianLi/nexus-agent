---
kind: upgrade-guide
description: 會話日誌的格式升到 55，請求快照改寫在模型呼叫開始之前、不帶 modelCall；新版續接或新開過的對話 v0.6.0 讀不了。
---

# 會話日誌格式升到 55

## 變更

新版的會話日誌是格式 55（[#2416](https://github.com/DemianLi/nexus-agent/issues/2416)），在
[54](../session-log-format-54/guide.md) 之上再改下面幾樣。每一版改了什麼，紀錄在
[`packages/nexus-core/src/session-store.ts`](../../../../packages/nexus-core/src/session-store.ts) 裡 `SESSION_LOG_FORMAT_VERSION` 的說明。

- **請求快照換位置、不帶 `modelCall`**：`request/system` 與 `request/header` 記在它所屬那次 `model/start` **之前**，不再帶
  `modelCall`；順序是快照、`model/start`，兩顆一起落盤之後才送出請求（耐久檢查點被關掉時不等落盤）。54 以前的快照記在 `model/start` 之後、帶 `modelCall`。
  自己讀 `.jsonl` 的程式（稽核、匯出）照 `modelCall` 把快照接到呼叫上的，碰到不帶 `modelCall` 的快照要改接**下一顆**
  `model/start`；落在一次還沒收尾的呼叫裡的（同一次呼叫重送時記的那一份），歸那一次。兩種形狀會出現在同一份日誌裡
  （54 寫的前半、新版續接的後半）。
- **作廢的那半段回覆不能略過**：`assistant/attempt` 不再標 `ignorable`。
- **`turn/end` 的收尾理由**：多一種 `max-turns`（撞到輪數上限），**還沒有任何地方寫它**。讀盤驗證與對話史認得它；軌跡與
  token-meter 還沒有這一支，會當成正常完成。寫入與讀盤都拒不認得的收尾理由。
- **讀盤多驗四條關係**（規則見 [事件關係在讀盤時驗](../session-log-relationships-on-read/guide.md)，「落在輪內」只在有輪的日誌上判）：新形狀的快照要落在輪內，
  輪收掉之前要等到 `model/start`（行程在快照之後死掉、續接補成 `interrupted` 的那一輪不算）；`assistant/attempt` 要落在輪內，
  帶 `modelCall` 的要在那次呼叫以 `error` 或 `aborted` 收尾之後。出貨過的寫入器寫的日誌都過得了。
- **續接與遷移、單向**：同 53 那一份，世代檔換成 `session.v55.jsonl`。

受影響的：之後可能要退回 v0.6.0 的主機；自己解析會話日誌的程式。

## 遷移

1. 往前升不用做任何事。
2. 可能要退回的話，同 53 那一份的第 2 步。
3. 自己解析會話日誌的程式，照上面第一點改快照的接法，用一份新版寫的和一份 v0.6.0 寫的日誌各跑一次。
4. 確認：新版起來之後開一條升級前的舊對話、送一句話，內容都在，那條對話的目錄裡是 `session.v55.jsonl`（系統提示詞與
   工具沒變的話，續接的那一輪不會再記快照）。再開一條新對話送一句話，它的日誌裡 `request/system` 與 `request/header`
   排在第一顆 `model/start` 前面、不帶 `modelCall`。
