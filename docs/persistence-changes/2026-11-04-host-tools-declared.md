---
description: "記錄一次持久化型別轉換與它的相容性確認。"
kind: persistence-change
---

# 2026-11-04-host-tools-declared

## 摘要

新增一般事件 `host-tools/declared`（#2374、D185 Q7）：嵌入的對話框在 `run.start` 替宿主頁宣告工具時，那一輪的 `turn/start` 之後寫一顆，`tools` 是整份宣告原文（`name`、`description`、`parameters`）。只給稽核看，寫的時候標 `ignorable`。會話格式版號不動。

## 目錄

- [聲明](#declaration)
- [相容性](#compatibility)
- [驗證](#verification)
- [開發備註](#dev-note)

<a id="declaration"></a>
## 聲明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-04-host-tools-declared
baseline: false
changes:
  - root: "event:host-tools/declared"
    previous: null
    after: "5b44009b73d65cc51f868a8e0875a7d9a6a0c6c9c261e67830e84a08313c4644"
    decision: same-version
```

<a id="compatibility"></a>
## 相容性

同版，新增一般事件類型。新讀方讀舊紀錄：舊日誌沒有這種事件，等於那幾輪沒有宿主頁工具，讀盤、重放、續接照舊。舊讀方（v0.6.0 與 develop cb35a7ea）讀新紀錄：這種事件不在它們的已知事件表上，但寫的時候帶 `ignorable`，`isUnreadableSessionEvent` 照 #507 的規則略過，不拒絕重建、不當損壞、不截尾。它不進模型也不左右任何折疊：重放與續接不讀它，宿主頁工具每一句由 `run.start` 重送，所以舊讀方略過它不改變任何一輪模型看到的東西。

<a id="verification"></a>
## 驗證

apps/harness/src/host-tools-wire.test.ts（第一條斷言落盤的 `host-tools/declared` 就是宣告原文）、known-event-types.test.ts、persistence-schema.test.ts、persistence-changes.test.ts。pnpm --filter @nexus/harness run persistence-changes --check 綠。

<a id="dev-note"></a>
## 開發備註

無。
