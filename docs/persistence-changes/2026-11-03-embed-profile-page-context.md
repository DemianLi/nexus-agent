---
description: "記錄一次持久化型別轉換與它的相容性確認。"
kind: persistence-change
---

# 2026-11-03-embed-profile-page-context

## 摘要

會話格式 52 → 53（#2367、D177）：header 多一格選填的 `profile: 'embed'`，從嵌入的對話框開的 root 會話才寫，之後不管誰打開都照嵌入版組；`turn/start`（`kind: 'message'`）與 `inbox/spliced` 排著的那一件各多一格選填的 `context { label }`，是嵌入的頁面附在那一句話上的畫面情境，送進模型時接在使用者那句話之後（`packages/nexus-core/src/page-context.ts`）。`SessionHeader` 與 `JsonlHeaderLine` 的 `version` 字面量從 52 變 53。

## 目錄

- [聲明](#declaration)
- [相容性](#compatibility)
- [驗證](#verification)
- [開發備註](#dev-note)

<a id="declaration"></a>
## 聲明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-03-embed-profile-page-context
baseline: false
changes:
  - root: "JsonlHeaderLine"
    previous: "2026-10-30-session-generation-layout"
    after: "91c6a89347f6e605919ab901f31c8554dcb5bc9420805530e2ae2fde59dbee2f"
    decision: version-bump
  - root: "SessionHeader"
    previous: "2026-10-30-session-generation-layout"
    after: "e04afc7da27409dcc075e96043db4468039464876ceb84247e6fc959584f0a80"
    decision: version-bump
  - root: "event:inbox/spliced"
    previous: "2026-11-01-settle-notice-cause"
    after: "4aa70134429ca16499c0df9dec90ea71cc08106c613fbfd2e727202dbc570da2"
    decision: version-bump
  - root: "event:turn/start"
    previous: "2026-11-01-settle-notice-cause"
    after: "552ee49e52c11df19b41e74647becb8adc8e8ee1e167631fcfa9a18a52bf33d0"
    decision: version-bump
```

<a id="compatibility"></a>
## 相容性

升版。新讀方讀舊紀錄：52 以前沒有 `profile` 也沒有 `context`，等於獨立頁面開的、沒附情境；讀盤照讀，續接時照 52 的規則遷成 `session.v53.jsonl`（header 只改 `version`，不補 `profile`）。舊讀方（v0.6.0 與 develop 7803cd3a）讀新紀錄：世代檔與墓碑的版號 53 比它們認得的新，報格式不支援、不當損壞、不截尾、不覆寫。不升版的話：52 的 `assertStoredHeaderFields` 白名單沒有 `profile`，會把帶它的 header 拒成壞檔（原始碼 `apps/harness/src/session-log-validation.ts`，7803cd3a）；`context` 會被 52 的 `pumpInputOf` 與 `turnStartMessage` 逐欄取值時略過，排著的項目折回來重跑時情境悄悄不見。拒絕訊號就是 header 的版號。

<a id="verification"></a>
## 驗證

apps/harness/src/embed-profile.test.ts（header 的 profile 跨重啟、情境跨重啟重放、只有嵌入版收情境、label 驗證）、packages/nexus-core/src/page-context.test.ts、session-format-fixtures.test.ts、persistence-schema.test.ts。pnpm --filter @nexus/harness run persistence-changes --check 綠。

<a id="dev-note"></a>
## 開發備註

無。
