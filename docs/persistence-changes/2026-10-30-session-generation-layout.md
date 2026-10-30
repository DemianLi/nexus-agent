---
description: "記錄一次持久化型別轉換與它的相容性確認。"
kind: persistence-change
---

# 2026-10-30-session-generation-layout

## 摘要

會話格式 51 → 52（#1594 ③、#2132）：寫方從舊兩檔（`<base>.header.json` 加 `<base>.jsonl`）換成每份會話一個目錄、裡面一個世代檔 `<sessionDirectoryName(id)>/session.v52.jsonl`，第一行是 header 行，之後一行一顆事件；舊路徑 `<base>.header.json` 留一份墓碑（內容是同一份 header 行，沒有 `migratedFrom`）。新增 `JsonlHeaderLine` 根，照 dsh 從實體格式的宣告（`apps/harness/src/jsonl-session-store.ts` 的 `JsonlHeaderLine`）抽：邏輯 header 各格，加 `type: 'session'` 與選填的 `migratedFrom`（從舊兩檔遷過來的才有，記來源日誌的位元組數、已接受前綴的位元組數與 SHA-256）。`SessionHeader` 只有 `version` 的字面量從 51 變 52，其餘不變。事件與事件封裝不變。

## 目錄

- [聲明](#declaration)
- [相容性](#compatibility)
- [驗證](#verification)
- [開發備註](#dev-note)

<a id="declaration"></a>
## 聲明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-30-session-generation-layout
baseline: false
changes:
  - root: "JsonlHeaderLine"
    previous: null
    after: "442070964ed30dc9c303b6475184f2e0c849e342ad5db8765066dc6e79ec160f"
    decision: version-bump
  - root: "SessionHeader"
    previous: "2026-10-23-fork-prefix-session-log"
    after: "ba31a0d94f50107e9024da4742e2e86d1f95594991f2d386c1e28237e5ea1245"
    decision: version-bump
```

<a id="compatibility"></a>
## 相容性

升版。新讀方讀舊紀錄：header 版本 51 以下的舊兩檔照讀（唯讀打開、列表不動檔）；續接時遷成 v52 世代檔：已接受的前綴原樣複製、撕裂的尾巴不帶過去（warn 一行）、來源日誌一個位元組都不動，舊 header 換成墓碑。比 52 舊的世代檔續接時同樣遷成新世代。舊路徑上版本 52 以上的 header 一律當墓碑：旁邊沒有會話目錄（世代檔）就報 SessionCorruptionError（N8），這是行為改變，見 PR 內文。舊讀方（v0.5.19 與 develop 50a55794 以前）讀新紀錄：舊路徑上的墓碑版本是 52，比它們認得的新，報格式不支援、不當損壞、不截尾、不覆寫；它們不認得會話目錄，世代檔對它們不存在。v0.5.19 的實測見 PR 內文。拒絕訊號就是墓碑上的版號。

<a id="verification"></a>
## 驗證

apps/harness/src/session-generation-writer.test.ts（墓碑、N8、遷移、只讀不發佈、撞名、凍結夾具遷移）、session-dir-layout-read.test.ts、jsonl-session-store-materialize.test.ts、jsonl-session-store-header-replace.test.ts、jsonl-append-failure.test.ts、session-format-fixtures.test.ts（每份凍結夾具續接後遷成 v52、來源日誌位元組不變、墓碑是同一份 header 行）、persistence-schema.test.ts。pnpm --filter @nexus/harness run persistence-changes --check 綠。

<a id="dev-note"></a>
## 開發備註

無。
