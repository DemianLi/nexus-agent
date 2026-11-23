# 續接補結、冷讀與不變量配套入口：nexus 與 dsh 的對照

對照的是 `harness/packages/nexus-core/src/interrupted-turn.ts`、`harness/packages/nexus-core/src/invariant.ts` 與 DeepSeek Harness（`deepseek-ai/deepseek-harness`）。出處都用 `git show <sha>:<path>` 讀過，行號是標明的那個 SHA 上的。舊註解曾引 `477b4f4`、`687f282e`，與 `8bd0733` 不同的地方逐條標出。補結句子與重放那一側的對照見 [`conversation-replay-vs-dsh.md`](conversation-replay-vs-dsh.md)。

做法與 dsh 一樣的只寫一行出處，不一樣的寫完整的比較。

## 一、續接時算補結、寫回、再當 seed（照 dsh）

dsh 的 agent loop 續接時先拿寫所有權，冷讀整份日誌，`interruptedTurnClosers(persisted)` 算補結，`handle.append(closers)` 寫回，再以 `[...persisted, ...closers]` 當 seed：`packages/core/agent-loop/src/index.ts:800-801`（取 seed 在其後同一段）。舊註解寫 `:848-863`、SHA `477b4f4`，在 `477b4f4` 上屬實；`8bd0733` 上這一段在 `:785-815` 一帶，補結與寫回在 `:800-801`。

補結的內容：最後一輪沒配到結果的呼叫各補一顆錯誤結果，開著的 step 補 `step/end`，最後補 `turn/end`：`repair.ts:53`（`openTurnClosers`）的後半（`:80-97`），續接實際呼叫的是包在外面的 `interruptedTurnClosers`（`repair.ts:209`，cause 固定 `interrupted`）。舊註解寫 `repair.ts:159-162`，`477b4f4` 上正是 `step/end`、`turn/end` 的 push，屬實；`8bd0733` 上移到 `:92-96`。

nexus 同樣，差別在詞彙：沒有 `step/*` 事件，對應的是 `model/start`↔`model/end`，`model/end` 的 `outcome` 用 `'error'`。語意修復歸 agent 層、不歸存放層，所以 nexus 的寫回是獨立 helper，不放進 `SessionStore.resume`；dsh 同樣把修復放在 agent loop，persistence 只交還實體上有效的日誌（`agent-loop/src/index.ts:793-796` 的註解）。

## 二、補哪些

- **沒配到結果的呼叫：** dsh 以 `ToolCallRecovery`（`repair.ts:105`）追蹤，呼叫由回覆登記（`pendingCalls`，`:106`），`tool/call` 只標「開始了」，補的順序是登記的順序（`:164-165` 的註解）；nexus 的 `scanOpenTurn` 同（`unanswered` 這張表，照回覆要的順序）。差別：nexus 對沒有 `assistant/message` 的舊格式日誌，會從 `tool/call` 登記（順序就是 `tool/call` 的順序）；dsh 的 `tool/call` 只在已登記的呼叫上標 `callSeq`，不新增（`:132-133`）。
  句子：dsh 的 `CLOSER_TEXT.interrupted`（`repair.ts:34`、`:35`）與 nexus 的 `TOOL_OUTCOME_UNKNOWN_TEXT`、`TOOL_NOT_STARTED_TEXT` 字面一樣（`8bd0733`，逐字相同）；為什麼不能隨手改字見 [`conversation-replay-vs-dsh.md`](conversation-replay-vs-dsh.md)。
- **掃描何時清待結的呼叫：** dsh 在 `turn/start`、`turn/end`、`step/end` 清（`repair.ts:119-122`）。nexus 在 `turn/start`、`turn/end`（`turn/failed` 也算收工）清；`step/end` 對應的是 `model/start`：開著的輪遇到新的 `model/start` 就清，代表上一批已結清。另一個差別：dsh 的 `tool/result` 要同一個 turn、step 且是 `append` 才算配到（`:138-141`），nexus 只認 `callId`（`tool/result` 一到就算配到）。這是刻意的還是順手，我沒查有沒有測試釘它，不替它下結論。
- **配對檢查對合成的「還沒開始」結果放行：** dsh 在 `477b4f4` 的 `packages/core/session/src/invariant.ts:142-145`（`syntheticNotStarted`，認 `TOOL_NOT_STARTED` 碼）有這條放行。`8bd0733` 上這個檔已不存在（見第四節），所以對現行 dsh 這條出處**不成立**。nexus 的放行是自己的：`session-relationships.ts` 的 `tool/result` 分支，認同一個碼。
- **掃描遇到 `session/end-seed` 不重設：** dsh `repair.ts:74`（`8bd0733`，整個 switch 在 `:59-77`）的 `openTurnClosers` 只在 `turn/start`、`turn/end`、`step/start`、`step/end` 移動游標，「其他事件種類不動游標」。舊註解寫的 `repair.ts:107-109`，在 `477b4f4` 上正是這條規則，屬實；`8bd0733` 上是 `ToolCallRecovery` 的欄位宣告。dsh 的日誌會有「開著的輪後面接 end-seed」：fork seed 先接 end-seed、再接補結（`fork.ts:21-29`；`8bd0733` 上 end-seed 在 `fork.ts:24`）。舊註解還寫了 dsh 的不變量對 end-seed 不設限（`477b4f4` 的 `invariant.ts:155-156`），同樣因該檔已移除，對現行 dsh 不成立。
  nexus 與 dsh 一致，另外有自己的舊檔形狀要顧：#934 之前續接過又沒有新輪就停的檔，補結會接在 end-seed 後面；新檔的補結一律在 end-seed 前面。「只掃最後一顆 end-seed 之後」那個做法沒有採，理由是舊檔的形狀，不是基礎建設表達不出來。
- **開著的 `model/start` 補 `model/end`：** nexus 自己的詞彙，對應 dsh 補 `step/end`；規則同一條（每一個進入的呼叫恰好一顆結尾）。補的順序也一樣：結果、步的收尾、輪的收尾（dsh `repair.ts:88` 先取結果，`:92-96` 補 `step/end`、`turn/end`）。

## 三、冷讀（照 dsh，少一步）

dsh 的 `readColdSessionLog`（`packages/session-query/session-query/src/cold-read.ts:31`，`8bd0733`；舊註解寫 `:31-57`、SHA `687f282e`）唯讀打開、讀整份、關把手，再在記憶體接上 `interruptedTurnClosers`，不寫回。nexus 的 `readColdSession` 同樣不拿租約、不寫回；我們的唯讀把手沒有 `close()`，所以少「關把手」這一步。

補結的 `seq` 接在最後一顆真事件後面，所以「讀到哪裡」記的是補結的那一顆：dsh 的 `readSurface` 以 `capturedThroughSeq` 記（`packages/session-query/session-query/src/index.ts:315`，`8bd0733`），舊註解的行號對得上。nexus 同。

## 四、不變量配套入口（dsh 已移除）

nexus 的 `@nexus/core/invariant` 是照 dsh 的「每個 package 的 `./invariant` 配套入口」建的，檔頭曾寫形狀照 dsh 的 `@deepseek-ai/dsh-session/invariant`，並說 dsh 的標準組合（`agent-spine-demo`）也掛了它。核對 `8bd0733` 的結果：

- `packages/core/session/src/invariant.ts` 不存在（`git ls-tree` 找不到任何 `invariant` 原始檔）。`477b4f4`、`c291e79` 上有。
- dsh 的升級指南 `docs/upgrade-guide/v0.2.0-rc.2/remove-runtime-invariants/guide.md` 寫明：下一個版本不再發佈 `@deepseek-ai/dsh-invariants`、`InvariantRegistry`、`InvariantInstaller`、任何 `<package>/invariant` 子路徑；`sdk-minimal` 不再含 `session-invariant` 等五列。
- `agent-spine-demo` 在 `8bd0733` 也已移除（`.agents/notes/archived/simplification/2026-08-26-remove-agent-spine-demo.md`；只確認該檔存在與檔名，**沒讀內容**）；`477b4f4` 的 `harness/packages/` 下也已經沒有，所以舊檔頭那句在引 `477b4f4` 時就已過時。

所以：nexus 的配套入口**形狀來源在 dsh 現行版本上已不存在**。移除的提交是 `f028f25667d`（2026-09-30，`refactor: remove runtime invariant plugins`），是 `8bd0733` 的祖先、不是 `477b4f4` 與 `c291e79` 的祖先。這件事與前因已記在 `docs/adr/0002-invariant-companions-first-cut.md`（第二刀未決），這份對照不重複、也不替它下結論。檢的東西少、只檢擁有者自己不負責的那部分，是 nexus 這邊自己站得住的理由，不靠 dsh。

## 五、沒核到的

- dsh 移除 runtime invariants 的理由：這份對照只讀了升級指南的變更與遷移說明；理由與前因見決策紀錄。
- 「`tool/result` 只認 `callId`」與 dsh 要求同一個 turn、step 的差別，沒查有沒有實際會發生的日誌形狀（nexus 的日誌每輪的 callId 是否可能重複沒追）。
