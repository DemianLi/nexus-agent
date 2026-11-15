---
description: "記錄一次持久化型別轉換與它的相容性確認。"
kind: persistence-change
---

# 2026-11-15-context-measure-summary-index

## 摘要

`context/measure` 的 `breakdown.messageParts` 多一個選填的 `summaryIndexTokens`（#2776）：`summaryTokens` 裡屬於索引條目（摘要本文的 `<index>…</index>`）的那一截，非負整數、不大於 `summaryTokens`，現況連同前言是兩者相減。它不是第五格，四格相加等於 `messageTokens` 的規則不變。算法是索引那一段在摘要訊息文字裡佔的字元比例乘上 `summaryTokens`、無條件捨去；摘要沒有索引時是 `0`；請求裡沒有摘要訊息就不寫這一格，所以沒摘要過的會話，`context/measure` 的位元組與加這一格以前相同。寫方只有 `summarization.ts` 的 `withTokenBudget` 一處（`withSummaryIndexTokens`），讀方只有 `conversation-history.ts` 的 `contextMeasureData`（逐欄手抄上線）與 `nexus-wire` 的 `reduceContextMeasure`（用戶端重建）；web 的畫面沒有改，還不畫這一格。`compaction/summary` 沒有加欄位：條目與現況都在既有的 `summary` 文字裡。會話格式版本不變。

## 目錄

- [聲明](#declaration)
- [相容性](#compatibility)
- [驗證](#verification)
- [開發備註](#dev-note)

<a id="declaration"></a>
## 聲明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-15-context-measure-summary-index
baseline: false
changes:
  - root: "event:context/measure"
    previous: "2026-11-14-context-measure-message-parts"
    after: "593ef3f64c157e98d40bb42817a5dec2caefb7b6ea0bc99bff1b5ac2622ae598"
    decision: same-version
```

<a id="compatibility"></a>
## 相容性

同版。新讀方讀舊紀錄：`messageParts` 沒有 `summaryIndexTokens` 的 `context/measure` 走的分支沒變，重放出來的 `messageParts` 不出這個 key（`nexus-wire` 的 `context-pressure.test.ts` 與 `apps/harness` 的 `conversation-history.test.ts` 各有斷言）。舊讀方（develop 6b37e438）讀新紀錄：讀盤驗證不看 `context/measure` 的 data；舊的 `contextMeasureData` 與 `reduceContextMeasure` 從 `messageParts` 只挑四格，多出來的 `summaryIndexTokens` 被略過（`nexus-wire` 既有的斷言：`messageParts` 多帶一個不認得的欄位時照四格收），畫面照舊。所以不需要拒絕訊號，不升版。

<a id="verification"></a>
## 驗證

沒有在舊版 worktree 上跑探針；舊讀方略過多餘欄位的行為由 6b37e438 就有的測試釘住（`nexus-wire` 的 `context-pressure.test.ts`：`messageParts` 帶 `extra: 1` 時重建結果只有四格）與讀原始碼確認（兩個讀方都是逐欄挑）。本分支測試：`nexus-core` 的 `summarization.test.ts`（帶索引的摘要：`summaryIndexTokens` 等於 `summaryTokens` 乘字元比例取整、小於 `summaryTokens`、四格總和不變；沒有索引的摘要是 0、沒有摘要訊息時不出這個 key）、`nexus-wire` 的 `context-pressure.test.ts`（有就帶、沒有就不出 key、負數與大於 `summaryTokens` 整顆不收）、`apps/harness` 的 `conversation-history.test.ts`（手抄帶上線）與 `context-pressure.test.ts`（即時與重放逐一相等、不大於 `summaryTokens`、不算進四格總和）。

<a id="dev-note"></a>
## 開發備註

無。
