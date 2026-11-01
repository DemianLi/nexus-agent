---
description: "記錄一次持久化型別轉換與它的相容性確認。"
kind: persistence-change
---

# 2026-11-01-settle-notice-cause

## 摘要

結算通知多一格選填的 `cause`，值與 `turn/end` 的 `reason.cause` 同形（#1847）：`user/message` 的 `subagent-settled` 來源、`turn/start` 的 `subagent-settled` 輸入、`inbox/spliced` 排著的 `subagent-settled` 來源都帶。`reason` 是 `aborted` 時才寫，說這一輪是被父代理中斷還是撞到一輪時限，wire 帶得到，不用去讀子代理自己的日誌。

## 目錄

- [聲明](#declaration)
- [相容性](#compatibility)
- [驗證](#verification)
- [開發備註](#dev-note)

<a id="declaration"></a>
## 聲明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-01-settle-notice-cause
baseline: false
changes:
  - root: "event:inbox/spliced"
    previous: "2026-10-26-image-original-dimensions"
    after: "dcb3c88c4bce2c47d1932c3a17055f3b01dee808e3ac4b72804f062fc7166ff3"
    decision: same-version
  - root: "event:turn/start"
    previous: "2026-10-26-image-original-dimensions"
    after: "454064e0c2af8968af406daf1e6e9fbc8b267129827d4dc621efefd7b2e973b0"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-plugin-source-form"
    after: "8ce7d58ecb2675c0ad02d1513108e397327ef44bcf36655a3586c64266ba1527"
    decision: same-version
```

<a id="compatibility"></a>
## 相容性

同版。舊紀錄：沒有這一格的結算通知照舊，`reason`、`summary`、`senderSessionId` 一個字沒動；讀的地方（`apps/harness/src/conversation-history.ts`、`apps/harness/src/thread-pump.ts`、`packages/nexus-wire/src/conversation.ts`）缺這格就不帶，畫面只看 `reason`，不猜原因；值認不得時 wire 的 `isTurnStopCause` 當作沒有。舊讀方讀新紀錄：讀盤驗證（`validateSessionEventData` 與信封白名單）不看這些事件的內層欄位，不拒收、不判損壞；送出佇列的折疊（`spliceInbox`）整件保留，投影上線與領走時（`conversation-history.ts`、`thread-pump.ts` 的 `pumpInputOf`、`packages/nexus-wire/src/conversation.ts`）逐欄取值，略過這一格，通知照舊畫成「背景子代理已被停止」。舊行程領走排著的通知時，寫回日誌的 `turn/start`／`user/message` 不帶 `cause`：原因少一筆，其餘不受影響。

<a id="verification"></a>
## 驗證

`apps/harness/src/settle-notice.test.ts`：閒著開一輪走 `turn/start`、輪中插話走 `user/message`、排隊中走 `inbox/spliced`，三條路即時與歷史都帶這一格；舊日誌與認不得的值都沒有。`apps/harness/src/background-settle.test.ts`：真組裝、真 `createWireHandler`，背景這一輪到點，原因走到日誌與畫面。

<a id="dev-note"></a>
## 開發備註

無。
