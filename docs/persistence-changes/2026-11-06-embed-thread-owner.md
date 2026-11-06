---
description: "記錄一次持久化型別轉換與它的相容性確認。"
kind: persistence-change
---

# 2026-11-06-embed-thread-owner

## 摘要

會話格式 53 → 54（#2370、#1827 D231 Q3）：header 多兩格選填的 `owner { userId }` 與 `embedOrigin { embedder, loginSessionSha256 }`，嵌入身分（換票兌換來的嵌入 cookie）開的 root 會話才寫，兩格一起出現、只跟 `profile: 'embed'` 一起；建立時寫，之後不改，續接不補，分叉不抄。嵌入身分只打得開使用者代號與嵌入方都對上的那幾條（`apps/harness/src/embed-thread-owner.ts`）。`loginSessionSha256` 是對方登入 session id 的 sha256 hex，跟嵌入稽核檔記的同一個值，兌換時拿來找這一次登入最新開的那一條。`SessionHeader` 與 `JsonlHeaderLine` 的 `version` 字面量從 53 變 54。

## 目錄

- [聲明](#declaration)
- [相容性](#compatibility)
- [驗證](#verification)
- [開發備註](#dev-note)

<a id="declaration"></a>
## 聲明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-06-embed-thread-owner
baseline: false
changes:
  - root: "JsonlHeaderLine"
    previous: "2026-11-03-embed-profile-page-context"
    after: "9b58747b97c44275d593e33f8c76451e79da95c93458ccb258df9ea0d2989d67"
    decision: version-bump
  - root: "SessionHeader"
    previous: "2026-11-03-embed-profile-page-context"
    after: "96bd0f041fb2f4aec011aa1efde651187eff546fc48286ad538a4db0aa561daa"
    decision: version-bump
```

<a id="compatibility"></a>
## 相容性

升版。新讀方讀舊紀錄：53 以前沒有 `owner` 與 `embedOrigin`，等於沒有擁有者；讀盤照讀，嵌入身分打不開（擁有者照樣打得開），續接時照 53 的規則遷成 `session.v54.jsonl`（header 只改 `version`，不補擁有者）。舊讀方（v0.6.0 與 develop 858e0c17）讀新紀錄：世代檔與墓碑的版號 54 比它們認得的新，報格式不支援、不當損壞、不截尾、不覆寫；所以退回舊版之後，54 寫的會話在舊版打不開，要升回來才看得到。不升版的話：53 的 `assertStoredHeaderFields` 白名單沒有這兩格，會把帶它們的 header 拒成壞檔（原始碼 `apps/harness/src/session-log-validation.ts`，858e0c17）。拒絕訊號就是 header 的版號。

<a id="verification"></a>
## 驗證

apps/harness/src/serve-embed-owner.test.ts（header 記開它的人、跨重啟照樣擋、續接不改擁有者、擁有者從嵌入路由開的不記、兌換帶回這一次登入最新的那一條）、apps/harness/src/embed-thread-owner.test.ts（冷讀 header 與建好之後再核兩道各自量）、apps/harness/src/jsonl-session-store-read-validation.test.ts（兩格缺一、沒有 profile: embed、形狀不對都拒成壞檔）、session-format-fixtures.test.ts、persistence-schema.test.ts。pnpm --filter @nexus/harness run persistence-changes --check 綠。

<a id="dev-note"></a>
## 開發備註

無。
