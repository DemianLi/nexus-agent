# 日誌推回對話歷史：nexus 與 dsh 的對照

對照的是 `harness/packages/nexus-core/src/conversation-replay.ts`（把一份會話日誌推回模型歷史）與 DeepSeek Harness（`deepseek-ai/deepseek-harness`）。所有 dsh 出處已對 `git show 8bd0733:<path>` 核過，行號是那個 SHA 上的；舊註解曾寫 `c291e79`、`477b4f4`，與 `8bd0733` 不同的地方逐條標出。

做法與 dsh 一樣的，只寫一行出處；不一樣的，寫完整的比較。

## 一、哪幾種事件產訊息（偏離）

**dsh：** 模型歷史由日誌推出。`Session.deriveMessages()`（`packages/core/session/src/index.ts:999`）逐顆走 surface 上的節點，每顆交給 `deriveEventMessage`（`surface.ts:120`，類別方法在 `index.ts:1028` 與 `surface.ts:667`）。哪些事件進歷史由類型集合加上每顆事件上的 `surfaceOp` 決定（`surfaceOp` 另外區分追加與取代、遮蔽），摺疊在 `foldSurface`（`surface.ts:594`）。舊註解寫的 `index.ts:832`、`surface.ts:92` 在 `8bd0733` 上已不是這些符號，不再引用。

**nexus：** 日誌上沒有 surface 這一軸，所以「哪幾種事件產訊息」由型別 `ModelVisibleEventType` 決定（人打的字在 `turn/start`、模型回覆在 `assistant/message`、工具結果在 `tool/result`、外掛塞進對話的在 `user/message`、壓縮的摘要在 `compaction/summary`），迴圈用守衛 `isModelVisibleEvent` 分兩支：子聯集那一支逐種窮舉（`default` 是 `satisfies never`，漏一種編不過；照 dsh session-reference 的投影，`packages/context/session-reference/src/projection.ts:60` 的 `assertNever`，`8bd0733`），其餘那一支只做記帳。

| 標準 | dsh（surface 軸） | nexus（型別加守衛） |
|---|---|---|
| 正確性 | 事件種類集合 `SURFACE_EVENT_TYPES`（`surface.ts:50`）加上 `surfaceOp` 標記（`isSurfaceEvent`，`surface.ts:72-76`）決定；`deriveEventMessage` 依 `event.type` switch（`surface.ts:120-153`），新增會產訊息的種類仍要改這兩處 | 型別窮舉，漏一種編不過；新種類必須明確分到哪一支 |
| 失敗與恢復 | 缺少事件的投影定義，追加與恢復都拒絕 | 守衛外的種類走記帳，不認得的事件不算錯（詞彙可被別的套件擴充） |
| 維護成本 | 每顆事件帶一個欄位，寫入方要記得標 | 一份型別，寫入方不用標 |
| nexus 的產品需求 | 日誌格式要加 `surfaceOp` 欄位，等於改落盤格式，所有舊檔要遷移或補欄位 | 不動落盤格式 |
| 現有基座做不做得到 | n/a | 可 |

選 nexus 的做法，好在不改落盤格式、也不要求寫入方標註；代價是「哪幾種進模型」的知識在讀方一處，而不是跟著事件走。dsh 的 `deriveEventMessage` 對不產訊息的類型走 default 不處理，nexus 的記帳那一支同理。

## 二、沒配到結果的呼叫：補一則錯誤結果（照 dsh）

dsh 的 `interruptedTurnClosers`（`packages/core/session/src/repair.ts:209`，包 `openTurnClosers`，`:53`）對一份停在輪中的日誌補合成事件：沒配到結果的呼叫補錯誤結果、開著的 step 補 `step/end`、最後補 `turn/end`。nexus 的 `conversation-replay.ts` 在重放時同樣補，句子**與 dsh 逐字相同**：

- 記過 `tool/call`、結果沒記下來：`TOOL_OUTCOME_UNKNOWN_TEXT`，等於 `CLOSER_TEXT.interrupted.started`（`repair.ts:34`）。
- 回覆裡要了、還沒記到 `tool/call`：`TOOL_NOT_STARTED_TEXT`，等於 `CLOSER_TEXT.interrupted.notStarted`（`repair.ts:35`）。

**為什麼這兩句不能隨手改字：** 它們是模型讀得到的文字，措辭就是行為。舊註解寫 `repair.ts:106`、`:107`，`8bd0733` 上這兩句在 `:34`、`:35`（`CLOSER_TEXT` 另有一組 `forked` 的句子，nexus 沒有分叉補結，沒用）。`conversation-replay.test.ts` 有一格把兩個常數的完整字面寫死（不引用常數），改字要同時改那格測試，那是刻意的摩擦；其他測試多半引用常數，另有 `harness/apps/harness/src/background-cold-dangling.test.ts:82` 用字面子字串釘了 `interrupted after it was recorded`。

## 三、續接時把補的事件寫回日誌（照 dsh，少一處）

dsh 的 agent loop 續接時，對停在輪中的日誌，用 `interruptedTurnClosers` 補的事件**寫回日誌**，當成一般批次追加（`packages/core/agent-loop/src/index.ts:800-801`；舊註解寫 `:855-856`、SHA `477b4f4`，`8bd0733` 上在 `:800-801`）。冷讀（只讀不改日誌的查詢）則只在記憶體裡補（`packages/session-query/session-query/src/cold-read.ts:23` 附近，README 寫「persistence is never mutated by a read」）。

nexus 同樣：續接時當掉那一輪的補結寫回日誌（`interrupted-turn.ts`），寫回之後重放讀到的是日誌上那些。沒寫回的在記憶體裡補，有四種情形：一輪收掉了結果卻沒到齊的、一輪失敗而當場補寫也失敗的、舊檔，這三種由 `conversation-replay.ts` 的 `closer` 補；冷讀由 `interrupted-turn.ts` 的 `readColdSession` 補（用 `interruptedTurnClosers`，不經 `closer`）。

**對現行 dsh 不成立：** 舊註解寫 dsh 對「合成的『還沒開始』結果沒有對應的 `tool/call`」在不變量檢查上明文放行（`invariant.ts:142-145`）。這在 `477b4f4` 上屬實；dsh 後來移除了整套 runtime invariants，`8bd0733` 上 `packages/core/session/src/invariant.ts` 已不存在（`git grep -i -E 'synthetic|not.?started'` 在 `packages/core/session/src` 只找到補結的產生端），所以對現行 dsh 不當事實引用。前因見 [`interrupted-turn-and-invariant-vs-dsh.md`](interrupted-turn-and-invariant-vs-dsh.md) 第四節。nexus 的放行是自己的：`session-relationships.ts` 的 `tool/result` 分支。

## 四、補結掃描遇到 `session/end-seed` 不重設（照 dsh）

dsh 的掃描（`repair.ts:53` 的 `openTurnClosers`）只在 `turn/start`、`turn/end`、`step/start`、`step/end` 移動輪與步的游標，「其他事件種類不動游標」（同函式內的註解）。`session/end-seed` 在 dsh 是真的事件：fork seed 在邊界後寫它（`packages/core/session/src/fork.ts:24`），Session 建立時帶 seed 才會補寫：帶繼承 seed 的快照且還沒有標記時寫 `{inherited:true}`（`packages/core/session/src/index.ts:698`），其他帶 seed 且最後一顆不是 end-seed 時寫 `{}`（`:700`）。nexus 的 `interrupted-turn.ts` 照同一條規則：掃描遇到 `session/end-seed` 不重設，所以舊檔「開著的輪＋`session/end-seed`、之後沒有新輪」的補結會接在 `end-seed` 後面；新檔的補結一律在 `end-seed` 前面。這一條與 dsh 一致，只是 nexus 有舊檔形狀要顧（#934 之前續接過的檔）。

**對現行 dsh 不成立：** `interrupted-turn.ts` 舊檔頭曾引 dsh 的 `invariant.ts:155-156`（不變量對 end-seed 不設限）。這在 `477b4f4` 上屬實（`case 'session/end-seed'` 的註解寫 Unconstrained）；`invariant.ts` 在 `8bd0733` 上已移除，見 [`interrupted-turn-and-invariant-vs-dsh.md`](interrupted-turn-and-invariant-vs-dsh.md)。

## 五、`origin` 回呼

`DeriveOptions.origin` 讓呼叫端拿到推出來的每一則訊息本身與它出自哪顆事件，用途是分辨哪幾則還在模型看得到的那一串、哪幾則已被壓縮蓋掉。dsh 的 `foldSurface`（`surface.ts:594`）回傳目前的節點 `nodes`，被遮蔽的區段記在 `replacements[].shadowedSeqs`（`SurfaceFoldResult`，`surface.ts:235`）。用途對應，做法不同：nexus 不在摺疊結果裡分，而是由壓縮的切點（`compaction/summary` 的 `cutoffIndex`）在推導端切。這一條的比較只讀了函式簽名與回傳型別，沒有逐行對 `foldSurface` 內部。

## 六、改 `conversation-replay.ts` 的人要知道的

`session-format.ts` 的 `readerBranch` 以「檔:行號」登記讀方分支（`conversation-replay.ts` 有兩處，都在 `compaction/summary` 那一支：摘要缺漏的判斷與 `beforeCall` 兩種順序的判斷；行號以 `session-format.ts` 的登記為準），`session-format-fixtures.test.ts` 逐條核錨點。在這個檔上面增減行會讓行號位移，要同批改登記，並在 `harness/apps/harness` 用一般設定與 `vitest.native.config.ts` 各跑一次那支測試。
