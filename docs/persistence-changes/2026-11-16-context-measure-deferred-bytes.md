---
description: "記錄一次持久化型別轉換與它的相容性確認。"
kind: persistence-change
---

# 2026-11-16-context-measure-deferred-bytes

## 摘要

`context/measure` 的 `sources` 每一筆多一個選填的 `deferredBytes`（#2777）：這一次放不下、沒放進去的原文位元組數（正整數），沒有延後就沒有這一格。可延後的四個源（`agent-instructions`、`skill-catalog`、`skill-invocation`、`memory`）超過預算表的上限時整份（清單是整條）不放、原地留一行指標，這一格記的是沒放的那些。接在系統提示上的源由那一步的塊帶 `deferredBytes` 回報（`system-prompt-step.ts`）；放在訊息串裡的兩個源由插件寫在那一則訊息 `additional_kwargs` 的 `nexus_injection_deferred_bytes`（新的選填鍵，隨 `user/message` 的訊息落盤），摘要器從送出的串上讀、同源幾則相加。寫方仍只有 `summarization.ts` 的 `withTokenBudget` 一處。沒有讀方：`conversation-history.ts` 的 `contextMeasureData` 與 `nexus-wire` 的 `reduceContextMeasure` 都沒有改，這一格不上線。會話格式版本不變。

## 目錄

- [聲明](#declaration)
- [相容性](#compatibility)
- [驗證](#verification)
- [開發備註](#dev-note)

<a id="declaration"></a>
## 聲明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-16-context-measure-deferred-bytes
baseline: false
changes:
  - root: "event:context/measure"
    previous: "2026-11-16-context-measure-sources"
    after: "8d222261f5cf81586b6abc1a4a0e996f7c28b9e87fed017666352233619e9af6"
    decision: same-version
```

<a id="compatibility"></a>
## 相容性

同版。新讀方讀舊紀錄：沒有讀方讀 `deferredBytes`；舊訊息沒有 `nexus_injection_deferred_bytes`，`messageInjectionSources` 當成沒有延後。舊讀方（develop 5fed223c）讀新紀錄：讀盤驗證不看 `context/measure` 的 data，也不驗訊息的 `additional_kwargs` 有哪些鍵（`logged-message.ts` 的 `fromLoggedMessage` 原樣推回）；`contextMeasureData` 與 `reduceContextMeasure` 逐欄挑、不讀 `sources`；舊的 `messageInjectionSources` 只看來源標記與內容，多出來的鍵被略過。所以不需要拒絕訊號，不升版。

<a id="verification"></a>
## 驗證

沒有在舊版 worktree 上跑探針；舊讀方略過多餘欄位是讀原始碼確認的（同上面列的四處）。本分支測試：`nexus-core` 的 `injection-sources.test.ts`「延後的位元組」（塊帶的數跟著回報、訊息上那一格只認正整數並同源相加、`sources` 上只有延後過的源有這一格）、`base-prompt-text.test.ts`「整段不超過上限」；`apps/harness` 的 `skill-invocation-on-tree.test.ts`（serve 的樹上一輪：70,000 位元組的 `AGENTS.md` 整份延後，`sources` 的 `agent-instructions` 那一列是 `deferredBytes: 70000`、`bytes` 等於實際送出的那一行指標，其餘各列沒有這一格）與 `injection-budget-pins.test.ts`（兩個插件寫的鍵名等於 core 讀的）。

<a id="dev-note"></a>
## 開發備註

無。
