---
description: "記錄一次持久化型別轉換與它的相容性確認。"
kind: persistence-change
---

# 2026-11-16-context-measure-sources

## 摘要

`context/measure` 多一個選填的 `sources`（#2777）：這份請求裡各注入源放了多少，陣列照 `id` 排序、`id` 不重複，每筆是 `{ id, bytes, limit? }`。`id` 是 `injection-budget.ts` 預算表的鍵或系統提示中段的段名；`bytes` 是接上的文字的 UTF-8 位元組數；`limit` 是這個窗口下的上限，只有表上整個源一個上限的才有，目前只是對照用的數字、超過不會有任何動作。接在系統提示上的源由 `system-prompt-step.ts` 在接上的那一刻回報、摘要器開的收集格收下（`injection-sources.ts`）；放在訊息串裡的源（`agent-instructions`、`skill-invocation`）由摘要器從送出的訊息上的來源標記認。寫方只有 `summarization.ts` 的 `withTokenBudget` 一處，每一筆 `context/measure` 都寫（沒有源時是空陣列）。沒有讀方：`conversation-history.ts` 的 `contextMeasureData` 與 `nexus-wire` 的 `reduceContextMeasure` 都沒有改，這一格不上線，web 不畫。會話格式版本不變。

## 目錄

- [聲明](#declaration)
- [相容性](#compatibility)
- [驗證](#verification)
- [開發備註](#dev-note)

<a id="declaration"></a>
## 聲明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-16-context-measure-sources
baseline: false
changes:
  - root: "event:context/measure"
    previous: "2026-11-15-context-measure-summary-index"
    after: "9c0609b671a3374c4d34753a3855c09a198d3d10d07793477d3b0816e539d295"
    decision: same-version
```

<a id="compatibility"></a>
## 相容性

同版。新讀方讀舊紀錄：沒有讀方讀這一格，舊紀錄沒有它不影響任何分支。舊讀方（develop b93e5c2b）讀新紀錄：讀盤驗證不看 `context/measure` 的 data；`contextMeasureData` 逐欄手抄、`reduceContextMeasure` 只解構認得的頂層欄位，多出來的 `sources` 被略過，畫面照舊。所以不需要拒絕訊號，不升版。

<a id="verification"></a>
## 驗證

沒有在舊版 worktree 上跑探針；舊讀方略過多餘頂層欄位是讀原始碼確認的（`apps/harness/src/conversation-history.ts` 的 `contextMeasureData`、`packages/nexus-wire/src/conversation.ts` 的 `reduceContextMeasure`，兩處都是逐欄挑）。本分支測試：`nexus-core` 的 `injection-sources.test.ts`（收集格的相加與覆蓋、巢狀、外層掛在請求上往內帶、訊息來源的認法、`limit` 的附法）與 `injection-budget.test.ts`（表與上限算法）；`apps/harness` 的 `skill-invocation-on-tree.test.ts`「各注入源的用量」（serve 的樹上一輪：九個源的 `bytes` 逐一等於實際送出的那幾塊系統提示與那幾則訊息的位元組數，包含在摘要器外層接上的 Skills 目錄）。

<a id="dev-note"></a>
## 開發備註

無。
