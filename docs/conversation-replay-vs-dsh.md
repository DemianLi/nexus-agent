# 日誌推回對話歷史：nexus 與 dsh 的對照

對照的是 `packages/nexus-core/src/conversation-replay.ts`（把一份會話日誌推回模型歷史）與 DeepSeek Harness（`deepseek-ai/deepseek-harness`）。所有 dsh 出處已對 `git show 8bd0733:<path>` 核過，行號是那個 SHA 上的；舊註解曾寫 `c291e79`、`477b4f4`，與 `8bd0733` 不同的地方逐條標出。

做法與 dsh 一樣的，只寫一行出處；不一樣的，寫完整的比較。

## 一、哪幾種事件產訊息（偏離）

**dsh：** 模型歷史由日誌推出。`Session.deriveMessages()`（`packages/core/session/src/index.ts:999`）逐顆走 surface 上的節點，每顆交給 `deriveEventMessage`（`surface.ts:120`，類別方法在 `index.ts:1028` 與 `surface.ts:667`）。哪些事件進歷史由 surface 這一軸決定（每顆事件上的 `surfaceOp`），摺疊在 `foldSurface`（`surface.ts:594`）。舊註解寫的 `index.ts:832`、`surface.ts:92` 在 `8bd0733` 上已不是這些符號，不再引用。

**nexus：** 日誌上沒有 surface 這一軸，所以「哪幾種事件產訊息」由型別 `ModelVisibleEventType` 決定（人打的字在 `turn/start`、模型回覆在 `assistant/message`、工具結果在 `tool/result`、外掛塞進對話的在 `user/message`、壓縮的摘要在 `compaction/summary`），迴圈用守衛 `isModelVisibleEvent` 分兩支：子聯集那一支逐種窮舉（`default` 是 `satisfies never`，漏一種編不過），其餘那一支只做記帳。

| 標準 | dsh（surface 軸） | nexus（型別加守衛） |
|---|---|---|
| 正確性 | 事件自己宣告進不進歷史，新增事件種類不用改推導 | 型別窮舉，漏一種編不過；新種類必須明確分到哪一支 |
| 失敗與恢復 | 缺少事件的投影定義，追加與恢復都拒絕 | 守衛外的種類走記帳，不認得的事件不算錯（詞彙可被別的套件擴充） |
| 維護成本 | 每顆事件帶一個欄位，寫入方要記得標 | 一份型別，寫入方不用標 |
| nexus 的產品需求 | 日誌格式要加 `surfaceOp` 欄位，等於改落盤格式，所有舊檔要遷移或補欄位 | 不動落盤格式 |
| 現有基座做不做得到 | n/a | 可 |

選 nexus 的做法，好在不改落盤格式、也不要求寫入方標註；代價是「哪幾種進模型」的知識在讀方一處，而不是跟著事件走。dsh 的 `deriveEventMessage` 對不產訊息的類型走 default 不處理，nexus 的記帳那一支同理。

## 二、沒配到結果的呼叫：補一則錯誤結果（照 dsh）

dsh 的 `interruptedTurnClosers`（`packages/core/session/src/repair.ts:209`，包 `openTurnClosers`，`:53`）對一份停在輪中的日誌補合成事件：沒配到結果的呼叫補錯誤結果、開著的 step 補 `step/end`、最後補 `turn/end`。nexus 的 `conversation-replay.ts` 在重放時同樣補，句子**與 dsh 逐字相同**：

- 記過 `tool/call`、結果沒記下來：`TOOL_OUTCOME_UNKNOWN_TEXT`，等於 `CLOSER_TEXT.interrupted.started`（`repair.ts:34`）。
- 回覆裡要了、還沒記到 `tool/call`：`TOOL_NOT_STARTED_TEXT`，等於 `CLOSER_TEXT.interrupted.notStarted`（`repair.ts:35`）。

**為什麼這兩句不能隨手改字：** 它們是模型讀得到的文字，措辭就是行為；跟 dsh 逐字相同也讓我們的重放與 dsh 的補結在同一種日誌上對得起來。舊註解寫 `repair.ts:106`、`:107`，`8bd0733` 上這兩句在 `:34`、`:35`（`CLOSER_TEXT` 另有一組 `forked` 的句子，nexus 沒有分叉補結，沒用）。測試直接引用常數，改措辭不會被測試擋住，所以改之前要自己想一遍。

## 三、續接時把補的事件寫回日誌（照 dsh，少一處）

dsh 的 agent loop 續接時，對停在輪中的日誌，用 `interruptedTurnClosers` 補的事件**寫回日誌**，當成一般批次追加（`packages/core/agent-loop/src/index.ts:800-801`；舊註解寫 `:855-856`、SHA `477b4f4`，`8bd0733` 上在 `:800-801`）。冷讀（只讀不改日誌的查詢）則只在記憶體裡補（`packages/session-query/session-query/src/cold-read.ts:23` 附近，README 寫「persistence is never mutated by a read」）。

nexus 同樣：續接時當掉那一輪的補結寫回日誌（`interrupted-turn.ts`），寫回之後重放讀到的是日誌上那些；沒寫回的（冷讀、一輪收掉了結果卻沒到齊、舊檔）才在記憶體裡補。

**沒核到：** 舊註解還寫了 dsh 對「合成的『還沒開始』結果沒有對應的 `tool/call`」在不變量檢查上明文放行（`invariant.ts:142-145`）。`8bd0733` 上 `packages/core/session/src/invariant.ts` 不存在，我在 `packages/core/session/src` 底下也沒找到對應的放行，所以這條出處**沒核到**，不當事實引用。nexus 對這種合成結果放行的理由是自己的配對不變量（`invariant.ts`，nexus 那份）。

## 四、補結掃描遇到 `session/end-seed` 不重設（照 dsh）

dsh 的掃描（`repair.ts:53` 的 `openTurnClosers`）只在 `turn/start`、`turn/end`、`step/start`、`step/end` 移動輪與步的游標，「其他事件種類不動游標」（同函式內的註解）。`session/end-seed` 在 dsh 是真的事件：fork seed 在邊界後寫它（`packages/core/session/src/fork.ts:24`），Session 建立時也會補寫（`packages/core/session/src/index.ts:698`、`:700`）。nexus 的 `interrupted-turn.ts` 照同一條規則：掃描遇到 `session/end-seed` 不重設，所以舊檔「開著的輪＋`session/end-seed`、之後沒有新輪」的補結會接在 `end-seed` 後面；新檔的補結一律在 `end-seed` 前面。這一條與 dsh 一致，只是 nexus 有舊檔形狀要顧（#934 之前續接過的檔）。

**沒核到：** `interrupted-turn.ts` 檔頭另外引了 dsh 的 `invariant.ts:155-156`（不變量對 end-seed 不設限）。`invariant.ts` 在 `8bd0733` 上不存在，這條沒核到，也不在這張的範圍內。

## 五、`origin` 回呼

`DeriveOptions.origin` 讓呼叫端拿到推出來的每一則訊息本身與它出自哪顆事件，用途是分辨哪幾則還在模型看得到的那一串、哪幾則已被壓縮蓋掉。dsh 的 `foldSurface` 把訊息分成 `current` 與 `shadowed`（`surface.ts:594`）。用途對應，做法不同：nexus 不在摺疊結果裡分，而是由壓縮的切點（`compaction/summary` 的 `cutoffIndex`）在推導端切。這一條的比較只讀了函式簽名，沒有逐行對 `foldSurface` 內部。

## 六、改 `conversation-replay.ts` 的人要知道的

`session-format.ts` 的 `readerBranch` 以「檔:行號」登記讀方分支（`conversation-replay.ts` 有兩處，指到 `compaction/summary` 的兩種順序判斷），`session-format-fixtures.test.ts` 逐條核錨點。在這個檔上面增減行會讓行號位移，要同批改登記，並在 `apps/harness` 用一般設定與 `vitest.native.config.ts` 各跑一次那支測試。
