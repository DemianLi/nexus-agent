---
description: "記錄一次持久化型別轉換與它的相容性確認。"
kind: persistence-change
---

# 2026-11-08-request-snapshot-before-model-start

## 摘要

會話格式 54 → 55（#2416）：`model/start` 延後到請求快照之後才寫，`request/system`、`request/header` 改寫在它所屬那次 `model/start` 之前、不帶 `modelCall`，快照與 `model/start` 一起排空之後才送出請求（耐久檢查點被關掉時不排空，同 #599）；`assistant/attempt` 不再標 `ignorable`；`turn/end` 的 `reason.kind` 多一種 `max-turns`（讀得懂、還沒有生產者），append、seed 與讀盤拒不認得的收尾理由。讀盤的關係驗證多四條：新形狀的快照要在輪內、輪收之前要等到 `model/start`（被 `interrupted` 收掉的輪不檢）；作廢的嘗試要在輪內、要在它那次呼叫以 `error` 或 `aborted` 收尾之後。`SessionHeader` 與 `JsonlHeaderLine` 的 `version` 字面量從 54 變 55。

## 目錄

- [聲明](#declaration)
- [相容性](#compatibility)
- [驗證](#verification)
- [開發備註](#dev-note)

<a id="declaration"></a>
## 聲明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-08-request-snapshot-before-model-start
baseline: false
changes:
  - root: "JsonlHeaderLine"
    previous: "2026-11-06-embed-thread-owner"
    after: "14f9bedc96f1450e500a8d5992044fadc3abb856816d3e8217088c8a87de15d7"
    decision: version-bump
  - root: "SessionHeader"
    previous: "2026-11-06-embed-thread-owner"
    after: "c23241c37cc35eae25c73173ec39370bd96086793b5dc04cc49185fff01fa694"
    decision: version-bump
  - root: "event:turn/end"
    previous: "2026-10-23-initial"
    after: "faedc6dc8eb7cbf70b93fddef8c04f743f68877a0a3e4b0778ac6d12e6c20428"
    decision: version-bump
```

<a id="compatibility"></a>
## 相容性

升版。新讀方讀舊紀錄：讀方以有沒有 `modelCall` 分快照的形狀（`packages/nexus-core/src/session-relationships.ts:168`），54 以前帶 `modelCall` 的只檢它指得到 `model/start`，不套新的位置規則；54 的產品路徑上快照一定帶 `modelCall`（兩顆中介層只在 `fold.ts` 一起掛、用同一個 `forCall`，`modelCalls` 在外層，eab4b1c6）。54 寫的 `assistant/attempt` 本來就落在失敗收尾之後、輪內，過得了新規則；54 以前的 `turn/end` 理由都在白名單內。續接照 53 的規則遷成 `session.v55.jsonl`。舊讀方（develop eab4b1c6）讀新紀錄：世代檔與墓碑的版號 55 比它認得的新，報格式不支援、不當損壞、不截尾、不覆寫；退回舊版之後，55 寫的會話在舊版打不開。非升不可的是 `turn/end` 的 `max-turns`：54 的讀方認不得的收尾理由一律當成正常完成（軌跡與 token-meter 的 `endOf` 落到 `default`，對話史畫成完成或停在核准點等人，eab4b1c6），#2359 會在 55 之下寫它、之後不再為它升版，所以要讓 54 的讀方以格式太新拒讀；寫入與讀盤驗 `reason` 是同一件事。今天的軌跡與 token-meter 的 `endOf` 也還沒有 `max-turns` 這一支（同樣落到完成），跟寫入方一起在 #2359 補；升版擋的是 54 的讀方。快照與嘗試的位置單看不必升：54 的軌跡與 token-meter 照位置讀不帶 `modelCall` 的快照照樣歸對。

<a id="verification"></a>
## 驗證

packages/nexus-core/src/session-relationships.test.ts（新形狀的四條規則與 54 形狀的分支，各條拿掉都紅）、session-log-data-rules.test.ts（turn/end 理由白名單）、request-snapshot.test.ts、model-call-identity.test.ts、packages/nexus-core/src/native-loop/recorder-cells.test.ts、session-title-llm.test.ts、session-format-fixtures.test.ts（v54 與 mixed-v54-v55 夾具）、persistence-schema.test.ts。pnpm --filter @nexus/harness run persistence-changes --check 綠。

<a id="dev-note"></a>
## 開發備註

無。
