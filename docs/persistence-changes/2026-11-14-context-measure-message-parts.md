---
description: "記錄一次持久化型別轉換與它的相容性確認。"
kind: persistence-change
---

# 2026-11-14-context-measure-message-parts

## 摘要

`context/measure` 的 `breakdown` 多一個選填的 `messageParts: { summaryTokens, injectedTokens, toolResultTokens, conversationTokens }`（#2774）：把 `messageTokens` 再拆成摘要訊息、機器塞進來的 user-role 訊息（帶來源而且不是人的，加上重複工具提醒）、工具結果、其餘對話四格，四格相加等於 `messageTokens`。每一格先算那一類訊息的純估算（`estimateMessageGroups`），再把 `messageTokens` 照比例分下去（最大餘數法），所以錨在供應商實數上的修正量由四格照比例分攤。分類用訊息上已有的標記（摘要的 `lc_source`、來源 `nexus_source`、重複工具提醒的記號），沒有新增標記。寫方只有 `summarization.ts` 的 `withTokenBudget` 一處，讀方只有 `conversation-history.ts` 的 `contextMeasureData`（逐欄手抄上線）與 `nexus-wire` 的 `reduceContextMeasure`（用戶端重建）；web 的畫面沒有改，還不畫這四格。會話格式版本不變（56）。

## 目錄

- [聲明](#declaration)
- [相容性](#compatibility)
- [驗證](#verification)
- [開發備註](#dev-note)

<a id="declaration"></a>
## 聲明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-14-context-measure-message-parts
baseline: false
changes:
  - root: "event:context/measure"
    previous: "2026-10-24-context-measure-breakdown"
    after: "efd67acf2143f481fe0fdef2fd6aadf36f489ca895a6af38084485e70c0e40f0"
    decision: same-version
```

<a id="compatibility"></a>
## 相容性

同版。新讀方讀舊紀錄：`breakdown` 沒有 `messageParts` 的 `context/measure` 走的分支沒變，重放出來的 `breakdown` 不出這個 key（`conversation-history.test.ts`、`nexus-wire` 的 `context-pressure.test.ts` 兩邊各有「沒有就不出這個 key」的斷言）。舊讀方（develop ebfca0d9）讀新紀錄：讀盤驗證不看 `context/measure` 的 data，所以不拒收、不判損壞；舊的 `contextMeasureData` 與 `reduceContextMeasure` 只挑 `systemTokens`、`toolsTokens`、`messageTokens` 三格，多出來的 `messageParts` 被略過，畫面照三格畫。所以不需要拒絕訊號，不升版。

<a id="verification"></a>
## 驗證

在 ebfca0d9 的獨立 worktree（`git worktree add --detach`，自己 `pnpm install --offline`；該樹的 `session-log.ts`、`conversation-history.ts`、`nexus-wire` 的 `conversation.ts`、token-meter 的 `fold.ts` 對 `durationMs` 與 `messageParts` 的出現次數都是 0，確認是真的舊讀方）上跑探針（不進 PR）：本分支用 `openJsonlSessionStore` 寫一份七筆事件的 JSONL，事件是手組的，形狀同寫方測試釘住的那一份，其中 `compaction/summary` 帶 `durationMs: 37`、`context/measure` 的 `breakdown` 帶 `messageParts`；舊讀方唯讀打開，讀回的事件數等於寫入數、每筆的 `type` 與 `data` 與寫入的逐欄相等（新欄位原樣在），`store.resume` 照常，`historyPage` 產出的畫面事件經 `reduceAll` 得到的 `contextPressure.measure` 的 `approxTokens` 與記的相同、`breakdown` 恰好是原本的三格（沒有 `messageParts`）。對照：改掉期望值的一格，探針的逐欄比對轉紅。本分支測試：`nexus-core` 的 `summarization.test.ts`（接線：四類訊息各一則時每一格等於那一類的純估算、錨定時四格相加仍等於 `messageTokens` 且各格離照比例的精確值不到 1、只有對話時前三格是 0、`messageTokens` 夾 0 時四格都是 0、摘要過的請求摘要那一格大於 0）與 `token-estimate.test.ts`（各組相加等於 `estimateRequestParts` 的訊息那一格，含 `singleDigits`）、`nexus-wire` 的 `context-pressure.test.ts`（有就帶四格、沒有就不出 key、形狀不對整顆不收）、`apps/harness` 的 `conversation-history.test.ts` 與 `context-pressure.test.ts`（即時與重放逐一相等、四格相加等於 `messageTokens`）。突變 5 條（摘要器不寫 `messageParts`、分攤不補餘數、提醒不算注入、wire reducer 丟掉、手抄丟掉）逐條轉紅。

<a id="dev-note"></a>
## 開發備註

無。
