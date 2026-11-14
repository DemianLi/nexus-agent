---
description: "記錄一次持久化型別轉換與它的相容性確認。"
kind: persistence-change
---

# 2026-11-14-compaction-summary-duration

## 摘要

`compaction/summary` 多一個選填的 `durationMs`（#2774）：生這份摘要的那一次模型呼叫的牆鐘，毫秒、非負整數，從叫生摘要的模型起到回覆通過檢查為止，含這次呼叫自己的重試與退避。拋錯或被拒收的那一次不記 `compaction/summary`，它花的時間不在這一格。寫方只有 `summarization.ts` 一處（`quietInvoke` 量、`withCompactionLog` 寫）；讀方只有 `nexus-plugin-token-meter` 的折疊，折成選填的 `summaryMs` 並從 `unaccountedMs` 扣掉。會話格式版本不變（56），`TOKEN_METER_VERSION` 不動（選填的 view 欄位，折疊狀態不落盤）。

## 目錄

- [聲明](#declaration)
- [相容性](#compatibility)
- [驗證](#verification)
- [開發備註](#dev-note)

<a id="declaration"></a>
## 聲明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-14-compaction-summary-duration
baseline: false
changes:
  - root: "event:compaction/summary"
    previous: "2026-10-23-initial"
    after: "d097ba5cc030e48c8c47ebeb3cdaab0ea0a65ae67aa3a4934b4662621860f7c4"
    decision: same-version
```

<a id="compatibility"></a>
## 相容性

同版。新讀方讀舊紀錄：沒有 `durationMs` 的 `compaction/summary` 照舊折，那一段不出 `summaryMs`、生摘要的時間照舊留在 `unaccountedMs`；同一段裡只要有一顆沒帶就整格缺席、不扣，所以逐輪各段加總在兩種日誌上都等於牆鐘（`fold.test.ts`「生摘要的耗時」四條）。舊讀方（develop ebfca0d9）讀新紀錄：讀盤驗證只驗 `request/header` 與 `tool/result` 兩種的資料規則，不看 `compaction/summary` 的 data，所以不拒收、不判損壞；舊的 token-meter 折疊只讀 `usage`，重放端（`conversation-replay.ts`）只讀 `cutoffIndex`、`messagesBefore`、`summary`、`beforeCall`，多出來的 `durationMs` 被略過，生摘要的時間照舊算在殘差。所以不需要拒絕訊號，不升版。

<a id="verification"></a>
## 驗證

在 ebfca0d9 的獨立 worktree（`git worktree add --detach`，自己 `pnpm install --offline`；該樹的 `session-log.ts`、`conversation-history.ts`、`nexus-wire` 的 `conversation.ts`、token-meter 的 `fold.ts` 對 `durationMs` 與 `messageParts` 的出現次數都是 0，確認是真的舊讀方）上跑探針（不進 PR）：本分支用 `openJsonlSessionStore` 寫一份七筆事件的 JSONL，事件是手組的，形狀同寫方測試釘住的那一份，其中 `compaction/summary` 帶 `durationMs: 37`、`context/measure` 的 `breakdown` 帶 `messageParts`；舊讀方唯讀打開，讀回的事件數等於寫入數、每筆的 `type` 與 `data` 與寫入的逐欄相等（新欄位原樣在），`store.resume` 照常，舊的 token-meter 折疊得到 `summaries` 是 1、view 沒有 `summaryMs`、那一輪牆鐘 300、模型 100、殘差 200（生摘要的時間留在殘差）。對照：把期望值的 `durationMs` 改成 38，探針的逐欄比對轉紅。本分支測試：`nexus-core` 的 `summarization.test.ts`（接線：生摘要的假模型等 40 毫秒，事件的 `durationMs` 是整數且不小於 35）、`nexus-plugin-token-meter` 的 `fold.test.ts`（每顆都帶時逐輪與會話各有 `summaryMs` 且各段加總等於牆鐘、舊紀錄不出這一格、同一輪有一顆沒帶就整格缺席、壞值當沒帶）、`apps/harness` 的 `compaction-log.test.ts`（整條鏈跑出來的每一筆 `compaction/summary` 的鍵含 `durationMs`）。突變 3 條（摘要器不寫 `durationMs`、折疊不扣 `summaryMs`、折疊不看是否每顆都帶）逐條轉紅。

<a id="dev-note"></a>
## 開發備註

無。
