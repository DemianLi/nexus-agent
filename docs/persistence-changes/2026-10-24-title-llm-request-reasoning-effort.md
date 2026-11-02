---
description: "記錄一次持久化型別轉換與它的相容性確認。"
kind: persistence-change
---

# 2026-10-24-title-llm-request-reasoning-effort

## 摘要

標題模型請求的紀錄多一格選填的 `reasoningEffort`（#1573 N0885）：`session/title-llm-request` 的酬載多 `reasoningEffort?: string`，照 dsh 1517a4db `session-title-llm/src/index.ts:267-275`（有 effort 才多記一格）。唯一的生產者是 `generateThreadTitle`（`apps/harness/src/session-title-llm.ts`）：標題那一顆的型錄條目宣告了 `off`（`reasoningEfforts` 有 `off` 這個鍵）就記 `'off'`，沒宣告就不放這個 key。只進日誌的資訊欄位，沒有任何讀方讀它；送出去的請求不受影響。會話格式版本不變。

## 目錄

- [聲明](#declaration)
- [相容性](#compatibility)
- [驗證](#verification)
- [開發備註](#dev-note)

<a id="declaration"></a>
## 聲明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-24-title-llm-request-reasoning-effort
baseline: false
changes:
  - root: "event:session/title-llm-request"
    previous: "2026-10-23-initial"
    after: "0d2720e89f07b8c0aff1363e57c66b15356dcf70ab3561bea82bbf2054112cee"
    decision: same-version
```

<a id="compatibility"></a>
## 相容性

同版。舊紀錄：沒有這一格的 `session/title-llm-request` 照舊，酬載型別只多不少，既有的五格一個字沒動。舊讀方（develop a29c1acc）讀新紀錄：這個事件類型在 `known-event-types.ts` 裡，不會被當成不認得的類型；讀盤只驗信封（`assertSessionEventEnvelope` 的鍵白名單，`data` 在不在）與兩條資料規則，兩條都只看 `request/header` 與 `tool/result`（`validateSessionEventData`，`packages/nexus-core/src/session-log.ts`），不驗這個事件的酬載；全 repo 沒有任何執行期程式碼讀 `session/title-llm-request` 的酬載（`git grep` 只剩寫方、型別宣告、已知類型表、`model-call-index.ts` 的位置判斷與 smoke 的事件過濾，都只看 `type`）。所以舊讀方多看到一格沒人用的欄位，不拒收、不判損壞、不影響標題、列表、歷史或續接。新讀方讀舊紀錄：沒有這一格就是沒有紀錄推理強度，與以前相同。不需要拒絕訊號，不升版。

<a id="verification"></a>
## 驗證

`apps/harness/src/session-title-llm.test.ts`：(1) 單元：組裝端交 `reasoningEffort` 就原樣記進請求紀錄，沒交就沒有這個 key，且模型收到的訊息兩邊一字不差；跟隨的那一顆用自己的（沒交不借預設那顆的）。(2) 產品組裝路徑（`createCliAgent` → `titleLlmFor`，假端點）：預設條目（`off: null` 加 `compat`）紀錄帶 `off` 且送出的請求帶 `chat_template_kwargs`；宣告 `off: null` 但沒有 `compat` 的紀錄也帶 `off`、送出的請求什麼都不加；沒有 `reasoningEfforts`、`reasoningEfforts: false` 的紀錄沒有這個 key；每一格都斷言紀錄上的 system 與訊息就是端點收到的那一份。(3) `runServe --live`：兩條 thread 各選型錄的一顆（宣告 `off` 的記 `off`、沒宣告的沒有 key），標題跟著走。突變 10 條（拿掉切行、拿掉剝強調、拿掉內層同記號判斷、拿掉第五行、預設那顆不交 effort、跟隨那顆不交 effort、條件改成 `thinkingOffBody` 非空、寫死 `off`、產生器不記這格、跟隨借預設的）全部轉紅，每條紅的測試見 PR 內文。

<a id="dev-note"></a>
## 開發備註

無。
