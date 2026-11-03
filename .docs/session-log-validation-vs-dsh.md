# 會話日誌的形狀驗證：對照 dsh

`apps/harness/src/session-log-validation.ts` 各段跟 dsh 的對照與取捨。程式碼的註解只寫 nexus 自己的契約，對照紀錄放這裡（[`docs/standards.md`](../docs/standards.md)〈註解〉）。從原本的註解搬過來（[#2381](https://github.com/DemianLi/nexus-agent/issues/2381)）。

dsh 的路徑有兩組 SHA：當初寫這支模組時對的是 `687f282e`；`agentPreset` 那一條是 2026-11-04 對 `8bd07339` 重讀的。路徑都相對 `references/deepseek-harness/packages/`。

## 整支模組

照 dsh `session/session-format-v3-to-v4/src/validation.ts`（`687f282e`）：header、繼承、事件之間的關係各一支，讀檔器收尾時跑。

header 驗證拋 `TypeError`、讀盤那一側再換成 `SessionCorruptionError`：同 dsh 建立那一側的 `materializeCreateHeader` 拋 `TypeError`。

## header 的鍵與各格（`assertStoredHeaderFields`）

- **精確鍵白名單**：照 dsh `assertReleasedV4Header` 的 `required` 與 `allowed`（`validation.ts:19-42`）。缺必填的、多出這一版不寫的鍵、某一格型別不對，都拒。
- **版本不在這裡判**：建立時要等於這一版（同 dsh 的 `encodeCurrentHeader`），讀盤時由版本邊目錄判。讀盤那一側對到 dsh 讀 header 時的精確鍵與型別檢查（`session-format-v1-to-v2/src/codec.ts:40-75`）。
- **非負安全整數**：同 dsh 的 `sessionFormatCount`。
- **`origin`** 只准 `'subagent'`，同 dsh。
- **`isSeeded`** 只准 `true`：dsh 是必填的 boolean；nexus 只在 true 時寫，落盤的 `false` 不是任何一版寫得出來的，所以只准 `true`。
- **dsh 有、nexus 沒有的鍵**：
  - `delegationDepth`：dsh 必填的非負整數。nexus 的 header 沒有（#1567 重核判不成立）。
  - `agentPreset`：dsh 是選填字串，記這個會話掛的 agent preset id（例如 `packages/experimental/webhook/src/session.ts:113` 把 `preset.id` 寫進 meta，`8bd07339`）。nexus 沒有同名的鍵；格式 53 加的 `profile`（[#2367](https://github.com/DemianLi/nexus-agent/issues/2367)）記這個會話是哪一種組裝開的，角色相近，但只准 `'embed'`，不是任意字串。
- **nexus 有、dsh 沒有的鍵**：`workspaceRoot`、`build`、`plugins`、`configHash`、`modelEntryId`、`profile`，各照 `StoredSessionHeader` 的宣告驗。

## 繼承（`assertStoredInheritance`）

照 dsh 讀盤的兩條（`session-format-v3-to-v4/src/validation.ts:52-76`、`session-format-v1-to-v2/src/codec.ts:114-127`，`687f282e`）：帶 `isSeeded` 的要有 inherited 標記，沒帶的不能有。

不同處：nexus 的切點不另外落盤，取最後一顆標記的 `seq`，所以 dsh 的「切點超過事件數」「seeded 而切點不等於最後一顆標記」兩條，在 nexus 收成同一條「seeded 卻沒有標記」。切點本來就是從標記推出來的，另外兩條在 nexus 寫不出來。

放在尾端復原之後：同 dsh，codec 只數已接受的事件（`codec.ts:104-117`），驗證在 `finish()` 跑。標記本身被當成壞尾巴丟掉時拋損壞，同 dsh（`codec.ts:121-123`）。

## 事件之間的關係（`assertStoredRelationships`）

照 dsh 的 `assertReleasedV4Relationships`（`session-format-v3-to-v4/src/validation.ts:110-130`；呼叫點是讀檔器收尾的 `finish()`，`session-persistence-jsonl/src/format.ts:468`）。

- **子代理只登記一次**：dsh `validation.ts:122-127`。只掃切點之後（含）的，同 dsh（`validation.ts:122`，整段 `catalogFact` 都在 `event.seq >= inheritedEventCount` 底下）。
- **`childId` 不是字串也拒**：照 dsh 的 `catalogFact`（`session-format-v3-to-v4/src/facts.ts:72-84`）。dsh 那一支還驗 `version`、`mode` 列舉、`label`、`childCreatedAt`；nexus 的 `SubagentCatalogData` 沒有那些格，只驗這條規則用得到的 `childId`。
- **turn、工具、模型呼叫的配對**：dsh 在同一支收尾呼叫 `assertV4LifecycleRelationships`（`validation.ts:129`，`8bd07339`）。nexus 改用 core 的 `createSessionRelationshipChecker`（#1597），跟執行期的配套入口同一支，讀盤與寫入用同一套規則。
- **標題的來源**：`session/title` 是 nexus 的詞彙，規則是 nexus 自己的（#1597）。

## 單筆資料（`assertStoredEventData`）

照 dsh 後端讀盤的 `validateStoredEvents`（`session-persistence/src/storage-contract.ts:69-104`）：逐筆 `adoptSessionEvent` → `validateSessionEventData`，不過就包成損壞錯誤。呼叫點 `session-persistence-jsonl/src/index.ts:860`，續接與唯讀打開共用。
