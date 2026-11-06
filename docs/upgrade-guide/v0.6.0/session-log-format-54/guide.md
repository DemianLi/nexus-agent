---
kind: upgrade-guide
description: 會話日誌的格式升到 54，換票登入開的嵌入版對話記開它的人；新版續接或新開過的對話 v0.6.0 讀不了。
---

# 會話日誌格式升到 54

## 變更

新版的會話日誌是格式 54（[#2370](https://github.com/DemianLi/nexus-agent/issues/2370)），在
[53](../session-log-format-53/guide.md) 之上再多一樣：用換票登入的身分（嵌入 cookie）開的嵌入版對話，header 記著開它的人
（`owner` 與 `embedOrigin`）。每一版改了什麼，紀錄在
[`packages/nexus-core/src/session-store.ts`](../../../../packages/nexus-core/src/session-store.ts) 裡 `SESSION_LOG_FORMAT_VERSION` 的說明。

- **換票登入的身分只打得開自己開的對話**：使用者代號與嵌入方都要對上。沒記開它的人的嵌入版對話（54 以前開的、主機擁有者從
  嵌入路由開的），換票登入的身分打不開，主機擁有者照樣打得開。v0.6.0 沒有換票登入，所以升級前的對話沒有人因此打不開。
- **續接與遷移、單向**：同 53 那一份，世代檔換成 `session.v54.jsonl`。續接不補開它的人。
- 新版續接過的對話與新版新開的對話，換回 v0.6.0 之後都讀不了；新版沒續接過的照常讀得到。

受影響的：之後可能要退回 v0.6.0 的主機。

## 遷移

1. 往前升不用做任何事。
2. 可能要退回的話，同 53 那一份的第 2 步。
3. 確認：嵌入方的後端換票、元件兌換之後送一句話（元件還沒有收票的入口時，照 [`operations.md`〈嵌入方換票登入〉](../../../operations.md#嵌入方換票登入) 直接打 API），
   那條對話的目錄裡是 `session.v54.jsonl`，header 有 `owner` 與 `embedOrigin`；換另一位使用者換票，打不開那一條，回 `thread_not_owned`。
