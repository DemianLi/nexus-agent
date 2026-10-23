---
description: "記錄一次持久化型別轉換與它的相容性確認。"
kind: persistence-change
---

# 2026-10-23-skill-invocation-source

## 摘要

人寫 `/名字` 叫用技能（#1574 刀 2）：`user/message` 的 `source` 聯集多一個分支 `{ kind: 'skill-invocation', name: string, form: 'instructions' }`，形狀照 dsh 的 `SkillInvocationSource`（`packages/skill/skill/src/index.ts:146-152`，`687f282e`）。唯一的生產者是 `@nexus/plugin-skills/invocation` 的 `agent/pre-step` listener，經宿主 `apps/harness/src/pre-step-middleware.ts` 記盤；宿主拒絕 listener 交 `user` 來源。`session-log.ts` 這次的 diff 只有型別與註解；讀方只動了軌跡面板（`packages/nexus-plugin-trajectory/src/trajectory.ts`，不把技能正文當輪中輸入），讀盤驗證、歷史畫面、重放、續接的執行期程式碼沒有改。會話格式版本不變。

## 目錄

- [聲明](#declaration)
- [相容性](#compatibility)
- [驗證](#verification)
- [開發備註](#dev-note)

<a id="declaration"></a>
## 聲明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-23-skill-invocation-source
baseline: false
changes:
  - root: "event:user/message"
    previous: "2026-10-23-initial"
    after: "b2fafff27a68bad7be4c4653b758426879c7152a26e72c81dd7334b0d01670f6"
    decision: same-version
```

<a id="compatibility"></a>
## 相容性

同版。舊紀錄：沒有這個分支的日誌照舊，型別只多不少，既有分支一個字沒動。舊讀方（develop a603804a）讀新紀錄：讀盤驗證（#1549，`validateSessionEventData` 與信封白名單）不檢查 `user/message.source.kind` 的值表，所以不拒收、不判損壞；按來源分流的讀方都是正向判準——歷史畫面只畫 `kind === 'user'`（`conversation-history.ts:237`），goal 的直接人類授權只認 `user`（`packages/nexus-plugin-goal/src/authority.ts:73`），引用別的會話時組快照的角色（`session-reference.ts:215`）與 eval 的提醒鏈（`eval/session-scan.ts:309`）也只認 `user`；重放只特殊處理 `plugin`，其餘原樣放回模型歷史，所以續接後模型看到的與當下相同。舊讀方唯一的差別在軌跡面板：它把不認得的 kind 當成輪中輸入（不帶預覽）列一筆；新版照 `session-reference` 的規則略過（`packages/nexus-plugin-trajectory/src/trajectory.ts`）。這是可捨棄的觀測功能，舊讀方顯示多一筆，不影響日誌本身與續接。新讀方讀舊紀錄：行為與以前相同，沒有這個 kind 的日誌走的分支沒變。所以不需要拒絕訊號，不升版。

<a id="verification"></a>
## 驗證

沒有在 a603804a 上另跑探針：除了軌跡面板，這些讀方（`jsonl-session-store.ts`、`conversation-history.ts`、`conversation-replay.ts`）的執行期程式碼與 a603804a 相同（本 PR 對 `packages/nexus-core/src/session-log.ts` 只改型別與註解），所以以下在本分支跑的結果代表舊讀方的行為。`apps/harness/src/skill-invocation-on-tree.test.ts` 驗收 4：serve 的樹上真的跑一輪，日誌的 `user/message` 帶 `{kind:'skill-invocation',name:'release-notes',form:'instructions'}`；同一份事件寫成 JSONL，`openJsonlSessionStore` 唯讀打開讀回同一則、`resume` 照常；`historyFrames` 不含技能正文；`replayConversation` 回 `replayed`，那一則的來源照舊。`packages/nexus-plugin-goal/src/authority.test.ts`：技能叫用的注入不算人。`packages/nexus-plugin-trajectory/src/trajectory.test.ts`：不列成輪中輸入。突變 12 條（listener 不看 root、不分人話、不完整也注入、不看記號、不看 `user-invocable`、不帶 source、不切最後一則模型回覆，宿主不讀 source、不擋 user、邊驗邊記，列排到 time-context 之後，軌跡不略過）全部轉紅。

<a id="dev-note"></a>
## 開發備註

無。
