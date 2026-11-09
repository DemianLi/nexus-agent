# 會話日誌的形狀驗證：對照 dsh

這份記 `apps/harness/src/session-log-validation.ts` 各段跟 dsh 的對照與取捨。程式碼註解只寫 nexus 自己的契約，對照紀錄放在這裡（見 [`docs/standards.md`](../docs/standards.md)〈註解〉）。內容是從原本的註解搬過來的（[#2381](https://github.com/DemianLi/nexus-agent/issues/2381)）。

- **路徑**：一律相對 `references/deepseek-harness/packages/`。
- **SHA**：當初寫這支模組時對的是 `687f282e`。標了 `8bd07339` 的，是 2026-11-04 重讀時新加或改過的出處。沒標的沿用 `687f282e` 的行號，在 `8bd07339` 上還大致對得上。

## 整支模組

**對照 dsh 的位置**：dsh 讀盤的驗證分兩處。

- header 在解碼一開始就驗：`session/session-format-v1-to-v2/src/codec.ts` 的 `createDecoder`。
- 繼承與事件之間的關係在讀檔器收尾時驗：`session/session-format-v3-to-v4/src/validation.ts`、`restoreReleasedV4Artifact`。

nexus 的做法：header 驗證拋 `TypeError`，讀盤那一側再換成 `SessionCorruptionError`。建立那一側同 dsh 的 `materializeCreateHeader` 拋 `TypeError`（`session/session-persistence/src/storage-contract.ts:112-121`，`8bd07339`）。

## header 的鍵與各格（`assertStoredHeaderFields`）

- **精確鍵白名單**：照 dsh `assertReleasedV4Header` 的 `required` 與 `allowed`（`session/session-format-v3-to-v4/src/validation.ts:19-42`）。缺必填的鍵、多出這一版不寫的鍵、某一格型別不對，都拒。
- **版本不在這裡判**：
  - 建立時，版本要等於這一版，同 dsh 的 `encodeCurrentHeader`（`session/session-format/src/catalog.ts:110`，`8bd07339`）。
  - 讀盤時，版本由版本邊目錄判。這一側的鍵與型別檢查對到 dsh 讀 header 時的精確檢查（`session/session-format-v1-to-v2/src/codec.ts:40-75`）。
- **非負安全整數**：同 dsh 的 `sessionFormatCount`（`session/session-format/src/json.ts:23-27`，`8bd07339`），只差一點：dsh 另外拒 `-0`，nexus 的 `isCount` 收 `-0`。
- **`origin`**：只准 `'subagent'`，同 dsh。
- **`isSeeded`**：dsh 是必填的 boolean。nexus 只在值為 true 時才寫這一格，所以落盤的 `false` 不是任何一版寫得出來的，只准 `true`。
- **dsh 有、nexus 沒有的鍵**：兩個都經 #1567 重核，判定不成立。
  - `delegationDepth`：dsh 裡是必填的非負整數。
  - `agentPreset`：dsh 裡是選填字串，記這個會話掛的 agent preset id，例如 `experimental/webhook/src/session.ts:113` 把 `preset.id` 寫進 meta（`8bd07339`）。nexus 沒有同名的鍵。格式 53 加的 `profile`（[#2367](https://github.com/DemianLi/nexus-agent/issues/2367)）記這個會話是用哪一種組裝開的，角色相近，但只准 `'embed'`，不收任意字串。
- **nexus 有、dsh 沒有的鍵**：`workspaceRoot`、`build`、`plugins`、`configHash`、`modelEntryId`、`profile`，各照 `StoredSessionHeader` 的宣告驗。

## 繼承（`assertStoredInheritance`）

**對照 dsh**：照 dsh 讀盤的兩條（`session/session-format-v3-to-v4/src/validation.ts:52-76`、`session/session-format-v1-to-v2/src/codec.ts:114-127`）：

- 帶 `isSeeded` 的會話，要有 inherited 標記；
- 沒帶的會話，不能有標記。

**不同處**：dsh 另有「切點超過事件數」「seeded 而切點不等於最後一顆標記」兩條。nexus 的切點不另外落盤，直接取最後一顆標記的 `seq`，切點必然落在標記上，這兩條在 nexus 寫不出來，所以沒有。

**放在尾端復原之後**：同 dsh，codec 只數已接受的事件（`session/session-format-v1-to-v2/src/codec.ts:104-117`），驗證在 `finish()` 跑。標記本身被當成壞尾巴丟掉時拋損壞，同 dsh（同一檔 `:121-123`）。

## 事件之間的關係（`assertStoredRelationships`）

**對照 dsh**：照 dsh 的 `assertReleasedV4Relationships`（`session/session-format-v3-to-v4/src/validation.ts:110-130`）。呼叫點是讀檔器收尾的 `finish()`（`session/session-persistence-jsonl/src/format.ts:468`）。逐項對照：

- **子代理只登記一次**：照 dsh `validation.ts:122-127`。只掃切點之後（含）的事件，同 dsh：`validation.ts:122` 底下整段 `catalogFact` 都在 `event.seq >= inheritedEventCount` 的條件裡。
- **`childId` 不是字串也拒**：照 dsh 的 `catalogFact`（`session/session-format-v3-to-v4/src/facts.ts:72-84`）。
  - dsh 那一支還驗 `version`、`mode` 列舉、`label`、`childCreatedAt`。
  - nexus 的 `SubagentCatalogData` 有 `mode`（`'one-shot' | 'continuable'`），這裡不驗；另外多一格 `callId`；沒有 `version`、`label`、`childCreatedAt`。
  - 這裡只驗這條規則用得到的 `childId`。
- **turn、工具、模型呼叫的配對**：
  - dsh 在同一支收尾裡呼叫 `assertV4LifecycleRelationships`（`validation.ts:129`，`8bd07339`）。
  - nexus 改用 core 的 `createSessionRelationshipChecker`（#1597）。執行期的配套入口（`sessionInvariant`）用的也是這一支，所以讀盤與執行期是同一套規則。
- **標題的來源**：照 dsh 的 `titleSources`（`session/session-format-v3-to-v4/src/relationships.ts:349-375`，由同一檔 `:306` 把 `session/title`、`session/title-llm-request` 交給它，`8bd07339`）。
  - 相同的規則：使用者改名時，`messageSeqs` 恰好是空的；每一格都要指到更早、不重複的人話。
  - 不同處一：人話的認法。dsh 認 `source.kind === 'user'` 的 `user/message`，nexus 認 `turn/start {kind:'message'}`。
  - 不同處二：dsh 另外驗 `session/title-llm-request` 的 `messages` 對得上 `messageSeqs`，nexus 不驗，只要求模型標題的請求至少指一顆人話。
  - 不同處三：nexus 把這條放在 harness，因為這兩種事件是 harness 用 `declare module` 補進來的詞彙，core 不解讀。

## 單筆資料（`assertStoredEventData`）

**對照 dsh**：照 dsh 後端讀盤的 `validateStoredEvents`（`session/session-persistence/src/storage-contract.ts:69-104`）。它逐筆跑 `adoptSessionEvent` → `validateSessionEventData`，不過就包成損壞錯誤。

dsh 的呼叫點在 `session/session-persistence-jsonl/src/index.ts:862` 的 `readStoredLog` 裡（`8bd07339`）。

nexus 的呼叫點是 `jsonl-session-store.ts` 的 `validateStoredLog`，續接、唯讀打開、遷移都會走到。
