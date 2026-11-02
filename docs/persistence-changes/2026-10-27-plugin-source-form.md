---
description: "記錄一次持久化型別轉換與它的相容性確認。"
kind: persistence-change
---

# 2026-10-27-plugin-source-form

## 摘要

`user/message` 的 `plugin` 來源多一格選填的 `form`，值只有 `'instructions'`（#1567 N0136，照 dsh 22ddee37 的 ContextForm，`packages/llm/llm/src/message.ts:55-101`）：說這則注入是給模型的指示。唯一的生產者是 `agent-instructions` 插件，經 `agent/pre-step` 交給宿主（`@nexus/agent-loop` 契約 1.3.0），宿主驗過之後原樣記進日誌。同一張卡讓子代理結算來源的 `summary` 落盤前截到 120 字（`boundContextSummary`，同 dsh `packages/llm/llm/src/message.ts:122-133`）；那是值的變化，不是型別的變化。會話格式版本不變。

## 目錄

- [聲明](#declaration)
- [相容性](#compatibility)
- [驗證](#verification)
- [開發備註](#dev-note)

<a id="declaration"></a>
## 聲明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-27-plugin-source-form
baseline: false
changes:
  - root: "event:user/message"
    previous: "2026-10-23-skill-invocation-source"
    after: "ff3e70f92ea83a7c8a01307e3c56861722eccd0c7058a2db11de61fb72d1246c"
    decision: same-version
```

<a id="compatibility"></a>
## 相容性

同版。舊紀錄：沒有這一格的 `plugin` 來源照舊，`kind` 與 `plugin` 兩格一個字沒動；讀 `plugin` 來源的地方（`packages/nexus-plugin-time-context/src/index.ts`、`packages/nexus-core/src/model-selection.ts`、`packages/nexus-core/src/conversation-replay.ts`、`packages/nexus-plugin-trajectory/src/trajectory.ts`）都按 `kind` 與 `plugin` 讀，不看有沒有 `form`。舊讀方（develop 21a07277）讀新紀錄：讀盤驗證（`apps/harness/src/session-log-validation.ts`）不驗 `user/message` 的來源鍵，上面那幾個讀方同樣不拒多出來的鍵；wire 不轉 `plugin` 來源給網頁。多一格沒人讀的欄位，不拒收、不判損壞。不需要拒絕訊號，不升版。

<a id="verification"></a>
## 驗證

`apps/harness/src/pre-step-middleware.test.ts`：listener 交自己名字、帶 `form: 'instructions'` 的 `plugin` 來源，訊息的 `nexus_source` 與日誌的 `source` 都記這一格；`form` 不是 `'instructions'`、或別人的名字帶 `form`，拋錯、不落盤；真的 `agent-instructions` listener 經宿主注入的那則帶 `form: 'instructions'`。`packages/nexus-plugin-agent-instructions/src/index.test.ts`：listener 回的那則帶這個來源。沒有 `form` 的舊形狀由既有測試照讀（例如 `packages/nexus-core/src/conversation-replay.test.ts`）。`pnpm --filter @nexus/harness run persistence-changes --check` 綠。

<a id="dev-note"></a>
## 開發備註

無。
