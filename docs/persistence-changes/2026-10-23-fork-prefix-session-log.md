---
description: "記錄一次持久化型別轉換與它的相容性確認。"
kind: persistence-change
---

# 2026-10-23-fork-prefix-session-log

## 摘要

會話日誌承載分叉前綴（#1579），照 dsh 687f282e 的形狀：`SessionHeader` 多兩格選填的 `origin: 'subagent'`（新建的子代理一律寫）與 `isSeeded: true`（分叉來的，只在 true 時寫）；`session/end-seed` 的 data 由空物件放寬成 `{ inherited?: true }`，標出繼承前綴的切點。切點不另外落盤，照 dsh 讀盤從最後一顆 inherited 標記推（`session-format-v1-to-v2/src/codec.ts:114-127`），所以沒有 dsh v0 的 `seedLength`。會話格式版本 50 → 51。

## 目錄

- [聲明](#declaration)
- [相容性](#compatibility)
- [驗證](#verification)
- [開發備註](#dev-note)

<a id="declaration"></a>
## 聲明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-23-fork-prefix-session-log
baseline: false
changes:
  - root: "SessionHeader"
    previous: "2026-10-23-initial"
    after: "eb5bcaa512ec4a442a07dabbe20ac46594b5f651143a54303ce54251d4755a54"
    decision: version-bump
  - root: "event:session/end-seed"
    previous: "2026-10-23-initial"
    after: "e436ba3b86f7031927b102f4f361626674b71ed304910e4e8269c03e88530d25"
    decision: version-bump
```

<a id="compatibility"></a>
## 相容性

升版，理由是舊讀方對新資料沒有有效的拒絕訊號，只會讀錯或報錯錯。開工時在 develop f210b3ac（格式 50）上實測：header 帶 `origin` 的 50 檔，`parseHeader` 的鍵白名單（#1549）拋 `SessionCorruptionError`（「session header 有這一版不寫的鍵 "origin"」），帶 `isSeeded` 的同樣拋損壞——一份好好的新檔被判成壞檔、列表算成壞的；只帶 inherited 標記、header 沒新鍵的 50 檔照常讀回 5 筆，標記被當成普通的 end-seed、繼承前綴被當成自己的。升到 51 之後：50 的 runtime 讀 51 的檔在讀本文之前拋 `SessionFormatUnsupportedError`（「格式版本是 51，這一版只讀得懂到 50。檔案沒有壞，是比這一版新」），列表算進 unreadable，這是有效的拒絕訊號；51 的 runtime 讀 50 以前的檔直接讀：沒有 `origin` 也沒有 `isSeeded`、end-seed 都是空物件，等於不是分叉，子代理靠 `parentSession` 認（`isSubagentSessionHeader` 的退路），續接時 header 改寫成 51 但不補 `origin`、不寫 `isSeeded`。版本邊 50→51 記為 additive。回滾的後果同 49、50：被 51 碰過的 thread，50 的 runtime 打不開。

<a id="verification"></a>
## 驗證

探針（develop `f210b3ac`，50 的讀方）：header 帶 `origin` 或 `isSeeded` 拋 `SessionCorruptionError`；只帶 inherited 標記照常讀回 5 筆；51 的檔拋 `SessionFormatUnsupportedError`。`apps/harness/src/jsonl-session-store-fork-prefix.test.ts`：header 新鍵的壞值、合法分叉、seeded 卻沒有標記、沒 seeded 卻有標記、撕裂的標記、標記之後的壞尾巴、前綴與自己的區段同 childId 照常讀回、自己的區段重複照舊拒、50 的檔續接後 header 是 51 且不補新鍵。`packages/nexus-core/src/fork-prefix.test.ts`：切點、`buildForkSeed`、續接、子代理判準表。突變 21 條（拿掉切點過濾、判準任一條、讀盤兩條一致性檢查、歷史頁目錄 frame、token-meter links、eval 評語等）全部轉紅。全 repo `pnpm -r run test`、`typecheck` 綠。

<a id="dev-note"></a>
## 開發備註

無。
