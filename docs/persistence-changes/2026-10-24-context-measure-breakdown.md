---
description: "記錄一次持久化型別轉換與它的相容性確認。"
kind: persistence-change
---

# 2026-10-24-context-measure-breakdown

## 摘要

`context/measure` 多一個選填的 `breakdown: { systemTokens, toolsTokens, messageTokens }`（#1571 N1193）：這一次呼叫送出去的請求，系統提示、工具定義、對話訊息各約多少 token。系統與工具是對 `sent` 請求的純估算（`estimateRequestParts`），訊息那格是環上的數（`approxTokens`，可能被供應商實數錨過）扣掉前兩格、夾在 0。寫方只有 `summarization.ts` 的 `withTokenBudget` 一處，讀方只有 `conversation-history.ts` 的 `contextMeasureData`（逐欄手抄上線）與 `nexus-wire` 的 `reduceContextMeasure`（用戶端重建）。會話格式版本不變（51），`TOKEN_METER_VERSION` 不動（折疊狀態不落盤）。

## 目錄

- [聲明](#declaration)
- [相容性](#compatibility)
- [驗證](#verification)
- [開發備註](#dev-note)

<a id="declaration"></a>
## 聲明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-24-context-measure-breakdown
baseline: false
changes:
  - root: "event:context/measure"
    previous: "2026-10-23-initial"
    after: "beb7e7ac726b7a277b7fdf60854b59f5aee9576634229b0e68ed9dccfa4777ff"
    decision: same-version
```

<a id="compatibility"></a>
## 相容性

同版。新讀方讀舊紀錄：沒有 `breakdown` 的 `context/measure` 走的分支沒變，重放出來的 `measure` 不出這個 key（`conversation-history.test.ts`、`context-pressure.test.ts` 兩邊各有「沒有就不出這個 key」的斷言）。舊讀方（develop 50ec4287）讀新紀錄：讀盤驗證（#1549，`validateSessionEventData`）只驗 `request/header` 與 `tool/result` 兩種的資料規則、信封只驗鍵白名單與 `seq`／`time`，不看 `context/measure` 的 data，所以不拒收、不判損壞；舊的 `contextMeasureData` 與 `reduceContextMeasure` 只挑認得的欄位，多出來的 `breakdown` 被略過，畫面照沒有它的算法畫。所以不需要拒絕訊號，不升版。

<a id="verification"></a>
## 驗證

在 50ec4287 的獨立 worktree（`git worktree add --detach`，自己 `pnpm install`；該樹的 `session-log.ts`、`conversation-history.ts`、`conversation.ts` 對 `breakdown` 的出現次數都是 0，確認是真的舊讀方）上跑探針（不進 PR）：本分支讓 serve 的樹用腳本模型跑兩輪，把 root 日誌原樣寫成 JSONL（兩筆 `context/measure` 都帶 `breakdown`，檔內可 grep 到），舊讀方用 `openJsonlSessionStore` 唯讀打開——讀回的事件數等於寫入數、每筆 `context/measure` 的 data 與寫入的逐欄相等（連 `breakdown` 都原樣在）、`store.resume` 照常、`historyPage` 產出的畫面事件經 `reduceAll` 得到的 `contextPressure.measure` 的 `approxTokens`／`messageCount` 與記的相同、`replayConversation` 回 `replayed`。對照：把其中一筆 `approxTokens` 改成字串，探針的逐欄比對轉紅（探針量得到差異），同時說明舊讀方連這種壞值也不驗這個事件的資料。本分支測試：`nexus-core` 的 `summarization.test.ts`（接線：三格非負整數、和等於 `approxTokens`、無系統提示與工具時兩格是 0、錨定時三格仍等於環上的數、系統加工具超過環上的數時訊息格夾 0）與 `token-estimate.test.ts`（三格和等於 `estimateRequestTokens`、含 `singleDigits`）、`nexus-wire/context-pressure.test.ts`（有就帶、沒有就不出 key、形狀不對整顆不收）、`apps/harness/src/conversation-history.test.ts` 與 `context-pressure.test.ts`（即時與重放逐一相等）。breakdown 這一側的突變 5 條（摘要器不寫 `breakdown`、`estimateRequestTokens` 單獨動、`estimateRequestParts` 單獨動、wire reducer 丟掉、手抄丟掉）逐條轉紅，每條紅在預期的斷言上。

<a id="dev-note"></a>
## 開發備註

無。
