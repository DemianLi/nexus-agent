/**
 * 會話日誌的**耐久 seam**：{@link ./session-log.ts | SessionLog} 是記憶體裡的真相，
 * 這一層說它怎麼落盤。
 *
 * 形狀照 dsh 的 `session-persistence`（`docs/subsystems/persistence.zh.md`，
 * 本地 clone SHA `d347e703908d0406b7a7ef80e3a0e594d86b2215`）：一個抽象的服務交出
 * **逐 session 的把手**，所有讀寫都經過把手流動，而不是拿 id 去叫服務的方法。
 *
 * ## 三條照抄的規則
 *
 * 1. **`append` 是盡力而為，`flush` 是耐久屏障。** append resolve 只保證「這一批被接受、
 *    排好序」，後端可以把物理寫入緩衝或批次化；**只有 resolve 掉的 `flush` 承諾它撐得過
 *    崩潰**。要活過崩潰的呼叫端自己 flush。
 * 2. **事件從 seq 0 連續，寫過的不重寫。** 一批的第一顆 `seq` 必須等於已存的 next-seq。
 * 3. **實體化可以延後。** 後端可以把建檔推遲到第一次 `append` 或 `flush`——那是純粹的
 *    優化，dsh 明文允許。所以 {@link SessionStore.create} 是同步的，IO 在把手上。
 *
 * ## 讀回有兩條
 *
 * - **續接**（{@link SessionStore.resume}）：拿寫租約、截掉撕裂的尾巴、交出接著寫的把手。對到 dsh 的
 *   `open(id, 'write')`。CLI 的 `--resume <run 目錄>` 與 serve 碰到一條 thread 時走它
 *   （[#251](https://github.com/DemianLi/nexus-agent/issues/251) 的門 A）。
 * - **唯讀**（{@link SessionStore.list} 與 {@link SessionStore.open}）：照 dsh 的 `list` 與 `open(id, 'read')`
 *   （[#665](https://github.com/DemianLi/nexus-agent/issues/665)）。**不拿租約、不截尾巴、不動 header**，別的行程
 *   握著的那一份照樣讀得到。讀方：serve 的會話列表（[#302](https://github.com/DemianLi/nexus-agent/issues/302)）與
 *   按內容搜尋（[#631](https://github.com/DemianLi/nexus-agent/issues/631)），都在產品路徑上——所以列與冷讀要經過這個
 *   介面，檔名與 header 的規則只留在後端。離線掃描（[#268](https://github.com/DemianLi/nexus-agent/issues/268)）
 *   在產品路徑外、要讀比這一版新的，不走 `list`，只 import 後端那一份檔名與 header 規則
 *   （同 dsh 的日誌匯出只 import 檔名定義）。
 *
 * ## 跟 dsh 不一樣的
 *
 * - **沒有 `stat`**：今天沒有消費者（dsh 拿它給投影快取，那一層在
 *   [#725](https://github.com/DemianLi/nexus-agent/issues/725) 等決定）。`list` 的
 *   {@link StoredSessionSnapshot.revision} 照抄了：內容搜尋的索引就是 dsh 說的衍生讀取快取。
 * - **`list` 只列落了盤的**：dsh 連這個行程 `create` 了、還沒實體化的也列
 *   （`packages/session/session-persistence/src/index.ts:125-130`）。#665 是不改行為的重構，照舊只讀盤；要照 dsh
 *   列得另開一刀（demian 2026-09-29 拍板）。
 * - **`list` 多回一格 {@link StoredSessionListing.unreadable}**：dsh 的 JSONL `list` 碰到讀不懂或版本太新的 header
 *   直接略過、不數。我們的列表把它數出來、一路畫到 web 上（不數的話「少了一條」跟「本來就沒有」分不出來），
 *   demian 2026-09-29 拍板照舊。
 * - **唯讀讀有撿回模式**（{@link StoredSessionReadOptions.salvage}）：dsh 的冷讀碰到中段壞掉就拋。我們的列表與搜尋
 *   以前各自逐行撿回、不讓一份壞檔拖垮整份清單；#665 把那條規則收進後端，只留一份。不是新偏離，是搬家。
 * - **`create` 撞到已存在的 session 必須拒絕**，不得覆寫也不得續寫。我們的 session id 只在
 *   一次組裝內唯一（`SessionRegistry` 的 `<root>/<runId>`），不像 dsh 的 `SessionId` 全域
 *   唯一，所以後端要自己把每一次組裝隔開。這條拒絕**在續接出現之後照樣成立**：續接是另一個
 *   方法（{@link SessionStore.resume}），它明著打開一份已存的，`create` 撞到已存在的仍然
 *   拒絕——撞名照樣會響，續接不會被當成撞名。
 *
 * **跨行程的寫租約照抄了**（{@link SessionAlreadyOwnedError}）：兩個行程寫同一份會話的話
 * `seq` 會撞號，dsh 靠 `open(id, 'write')` 的所有權把第二個擋掉，我們同樣。**擋的機制是後端
 * 的事**（JSONL 那個見 `apps/harness/src/session-lease.ts`），這裡只定契約：`resume` 撞上
 * 別人握著就拋它，而且在讀之前就拋。有了它，上面那條 `create` 的拒絕從「唯一的防線」變成
 * 「多一道」——撞名仍然由它擋，同名同時寫由租約擋。
 *
 * @module
 */

import type { SessionEvent } from './session-log.js';

/**
 * 目前的日誌格式版本。
 *
 * **第一天就蓋，不是為了現在有兩個版本。** dsh 的 `SessionHeader` 帶 `version`
 * （`SESSION_FORMAT_VERSION`），而且它為此養著 `session-format` 加兩個遷移包
 * （`v0-to-v1`、`v1-to-v2`）。我們的事件詞彙從 [#89](https://github.com/DemianLi/nexus-agent/issues/89)
 * 的六種一路長到今天、還會再長；不蓋版本的話，第一次改詞彙就是一次**沒有版本可以
 * 分支的遷移**——讀方只能靠猜。
 *
 * ## 2：`turn/start` 多了 `kind: 'goal'`
 *
 * 續行驅動器（[#180](https://github.com/DemianLi/nexus-agent/issues/180)）加了第三種輪次
 * 來源，那是一次詞彙變更，所以版本跟著走。
 *
 * ## 3：`session/end-seed`
 *
 * 門 A（[#251](https://github.com/DemianLi/nexus-agent/issues/251)）加了一顆由建構子寫的
 * 事件。**同一張卡也長出了第一個讀方**（{@link SessionStore.resume}），所以這個號從今天起
 * 有人讀：
 *
 * - **舊的號直接讀。** v1 是 v2 的子集——`turn/start` 的 `kind` 從
 *   [#98](https://github.com/DemianLi/nexus-agent/pull/98) 就在，格式版本到
 *   [#173](https://github.com/DemianLi/nexus-agent/pull/173) 才開始蓋，v2 只多了 `goal`
 *   這個變體；v2 之於 v3、v3 之於 v4 同理，各只多了一種事件。所以不需要遷移包——dsh 養兩個是因為它的
 *   舊版真的長得不一樣。
 * - **比這個號新的拒絕**，而且跟壞檔分開報（{@link SessionFormatUnsupportedError} 與
 *   {@link SessionCorruptionError}，照 dsh 的 `SessionFormatUnsupportedError`／
 *   `SessionPersistenceCorruptionError`）：新版寫的檔不是壞的，是這一版讀不懂。
 * - **續寫進去的是這一版的詞彙**，所以續接的把手第一次寫入時把 header 的 `version` 蓋成
 *   這個號——dsh 同樣在讀的時候把歷史 header 翻成目前的版本。
 *
 * ## 4：`plan/mode`
 *
 * 計劃模式從 graph state 搬進日誌（[#251](https://github.com/DemianLi/nexus-agent/issues/251)
 * 的第二刀）。v3 的檔直接讀：一顆 `plan/mode` 都沒有的日誌，計劃模式照組裝的初值起算——
 * 跟 v3 那時候續接回來的結果一樣。
 *
 * ## 5：`tool/call`／`tool/result`
 *
 * 工具呼叫與它的結果進日誌（[#264](https://github.com/DemianLi/nexus-agent/issues/264)）。
 * v4 的檔直接讀：一顆工具事件都沒有的日誌，就是 v4 那時候寫出來的樣子——沒有任何讀方拿
 * 「沒有工具事件」推論什麼。
 *
 * ## 6：`model/start`／`model/end`
 *
 * 模型呼叫的起訖進日誌，會話統計拿它數步數（[#266](https://github.com/DemianLi/nexus-agent/issues/266)）。
 * v5 的檔直接讀：一顆都沒有的日誌折出來的步數是 0——**那是「沒記」不是「沒叫」**，讀舊檔的
 * 統計要照格式版本表態，不能把 0 當成真的沒叫過模型。
 *
 * ## 7：`turn/end` 帶 `reason`，工具碼多一個 `ABORTED_BEFORE_DISPATCH`
 *
 * 中止這一輪（[#276](https://github.com/DemianLi/nexus-agent/issues/276)）：被中止的那一輪以帶
 * `reason: {kind:'aborted', ...}` 的 `turn/end` 收尾。v6 的檔直接讀：沒有 `reason` 就是正常結束——
 * **那時候也沒有中止這條路**，所以讀舊檔數中止要表態成「沒記」，不是 0。
 *
 * ## 8：`feedback/*` 三顆，`command/run` 的 `args` 變成選填
 *
 * 評分與 `/feedback`（[#278](https://github.com/DemianLi/nexus-agent/issues/278)）。v7 的檔直接讀：
 * 一顆回饋事件都沒有的日誌就是那時候寫出來的樣子——**那時候也沒有評分這條路**，所以讀舊檔數點踩
 * 要表態成「沒記」，不是 0。`args` 選填是 dsh 的 `recordInput: false`：v7 以前每一顆 `command/run`
 * 都帶它，讀舊檔的人照舊讀得到。
 *
 * ## 9：對話內容進日誌——`assistant/message`、`user/message`，`tool/result` 帶 `message`，`compaction/summary` 帶 `summary`
 *
 * 日誌成為對話的真相（[#305](https://github.com/DemianLi/nexus-agent/issues/305)），模型歷史由它推出來
 * （[#306](https://github.com/DemianLi/nexus-agent/issues/306)）。v8 的檔直接讀：多出來的四格一格都沒有
 * ——**那時候沒記，不是那時候沒有**，推模型歷史的一側對 8 以前的檔推不出完整的對話，要照格式版本表態。
 *
 * **這一次比前幾次更非升不可。** 前幾次升版是慣例，這一次是閘：一個讀不懂 9 的舊 runtime 接續新檔的話，
 * 它寫下去的輪次沒有回覆、沒有結果內容，推出來的歷史就有洞。它得看到「版本太新」而拒讀
 * （{@link SessionFormatUnsupportedError}）。守這條線的**只有**這個號：那時我們的 body parser 對不認得的
 * `type` 照收（`apps/harness/src/jsonl-session-store.ts`），沒有 dsh 那個逐顆的 `ignorable` 旗標（32 補上了，見下）。
 *
 * ## 10：評分指名回覆，不指名輪
 *
 * `feedback/message-put` 的 `item` 與 `feedback/message-delete` 帶 `messageId`（那顆 `assistant/message`
 * 記的訊息 id），同 dsh（[#382](https://github.com/DemianLi/nexus-agent/issues/382)）。v9 以前的檔直接讀：
 * 以輪記的那幾顆由 `currentMessageFeedback` 對到那一輪最後一則有文字的回覆。**非升不可**：讀不懂 10 的
 * 舊 runtime 會把 `messageId` 那幾顆當成輪讀，`item.turn` 是 `undefined`。
 *
 * ## 11：`deliverables/presented`
 *
 * 模型用 `present` 宣告交付的檔案（[#441](https://github.com/DemianLi/nexus-agent/issues/441)）。v10 的檔直接讀：
 * 一顆都沒有的日誌就是那時候寫出來的樣子——**那時候也沒有 `present` 這個工具**，所以讀舊檔數交付要表態成
 * 「沒記」，不是 0。升版照前幾次新增種類的慣例：讀不懂 11 的舊 runtime 看到「版本太新」而拒讀，不會把它
 * 不認得的那幾顆照收之後續寫下去。
 *
 * ## 12：`workspace/changes`
 *
 * 一輪改了工作區的檔，摘要留在 server 上（[#443](https://github.com/DemianLi/nexus-agent/issues/443)）。v11 的
 * 檔直接讀：那時候沒有記錄器，一顆都沒有就是當時的樣子。從檔案接回來的這一顆指到的摘要一律不在了（摘要只活到
 * 會話結束），路由回 404。升版理由同 11。
 *
 * ## 13：header 多一格 `workspaceRoot`
 *
 * 會話日誌記下它跑在哪個工作區根底下（[#504](https://github.com/DemianLi/nexus-agent/issues/504)）。
 * **這是 header 的形狀第一次變**——前十二次全是事件詞彙的變更，header 從 v1 起沒動過。
 *
 * **非升不可，而且機制指得出來。** 不升的話：一台停在 12 的 server 接回一份帶著
 * `workspaceRoot: /A` 的日誌，續接重寫 header 那一行是 `{ ...header, version: … }`
 * （`apps/harness/src/jsonl-session-store.ts`），**未知欄位原樣活過重寫**；而 12 沒有任何守衛
 * 在比這一格，於是它在 `/B` 底下跑、把 `/B` 生出來的事件續寫進同一份日誌，之後一台 13 讀它，
 * 照 header 把 `/B` 的檔錨到 `/A`。升到 13 把這條路封掉——12 讀 header 的時候就以
 * {@link SessionFormatUnsupportedError} 拒讀。這正是 dsh 那條門檻寫的原文情形
 * （`packages/core/session/src/types.ts:75-87`，`ddefc45`：「parses without error」不算 correctness，
 * 靜靜略過會左右重建的內容就是一次讀錯）。
 *
 * 12 以前的檔直接讀，但這一次「舊檔怎麼讀」跟前幾次不同：**沒有那一格是常態，不是異常**
 * ——每一份 13 以前的日誌都缺它，而且續接**不回填**。所以續接的守衛對「沒記」放行，
 * 跟 `cwd` 那一格的「沒記就拒」相反，四格表在 `apps/harness/src/resume-guards.ts`。
 *
 * ## 14：`context/measure`
 *
 * 摘要器量到的每一次模型呼叫：離自動摘要還有多遠（[#528](https://github.com/DemianLi/nexus-agent/issues/528)，
 * web 的用量表讀它）。v13 的檔直接讀：那時候沒有這一層，一顆都沒有就是當時的樣子——用量表要等接回來之後的第一次
 * 模型呼叫才畫得出來（它看的是 `measure`；舊檔裡的 `model/usage` 照樣送上線）。升版理由同 11。
 *
 * ## 15：`turn/end` 的 `reason` 多一種 `max-tokens`
 *
 * root 的回覆撞到輸出上限的那一輪以 `reason: {kind:'max-tokens'}` 收尾（[#433](https://github.com/DemianLi/nexus-agent/issues/433)）。
 * **非升不可**：14 讀到它會當成正常結束——14 的 goal 續行只認得 `aborted`，於是在一輪撞到上限之後照樣
 * 排下一輪，而 15 在那一刻收回了續行授權。同 dsh 那條門檻（「no longer handle a new log with full semantic
 * correctness」，`packages/core/session/src/types.ts:74-85`，`477b4f4`）。
 *
 * v14 的檔直接讀：沒有這一種就是那時候沒記——**不是沒撞到**。那時候的 `assistant/message` 已經帶著
 * `response_metadata.finish_reason`，要數舊檔的截斷得從那一格推，不能讀 `turn/end`。
 *
 * ## 16：`tool/result` 帶 `meta`
 *
 * 讀檔、搜尋、改檔的結構化結果，給 web 的專屬卡畫（[#617](https://github.com/DemianLi/nexus-agent/issues/617)），
 * 同 dsh 的 `tool/result.meta`（`packages/core/session/src/types.ts:363-385`，`477b4f4`）。模型看不到它，推模型
 * 歷史的一側不讀。v15 的檔直接讀：沒有這一格就是那時候沒記，接回來的卡走 generic。
 *
 * 升版照新增詞彙的慣例（同 11、12、14），不是 15 那種非升不可：15 讀到這一格只是不畫專屬卡，重建出來的
 * 對話不差一個字。
 *
 * ## 17：`inbox/spliced`
 *
 * 送出佇列（[#637](https://github.com/DemianLi/nexus-agent/issues/637)）：人送出、還沒開跑的那幾句存在 server 上，由
 * 這一顆折出來。v16 的檔直接讀：那時候送出的話不排進日誌，一顆都沒有就是當時的樣子，接回來的佇列是空的。
 *
 * **非升不可**：16 接回一份 17 的日誌時認不得這一顆，停住的那幾件從它眼裡消失——續寫下去之後，一台 17 再接回來
 * 時它們又冒出來、而且排在 16 那段時間送出並跑完的話前面。同 13 那條門檻：靜靜略過會左右重建的內容就是一次讀錯。
 *
 * ## 18：`session/title`
 *
 * 這條會話叫什麼（[#647](https://github.com/DemianLi/nexus-agent/issues/647)），web 的 header 與列表讀它。v17 的檔直接讀：
 * 那時候沒有這一顆，讀的人照 v17 的做法從第一則人打的字推（列表與歷史都是）。
 *
 * 升版照新增詞彙的慣例（同 11、12、14、16），不是 17 那種非升不可：這一版只有 `fallback` 一種，17 自己推出來的
 * 標題一字不差。
 *
 * ## 19：LLM 標題
 *
 * `session/title` 的 `source` 多一種 `provider`（模型產生的），加一顆只進日誌的 `session/title-llm-request`
 * （[#650](https://github.com/DemianLi/nexus-agent/issues/650)）。v18 的檔直接讀：那時候沒有模型產生的標題，一顆都沒有就是
 * 當時的樣子。
 *
 * 升版照新增詞彙的慣例（同 18），不是非升不可：18 讀到 `provider` 的標題照樣拿最後一顆，一字不差；讀到
 * `session/title-llm-request` 只是不認得一種它本來就不用的事件。
 *
 * ## 20：插話（`next-step`）
 *
 * 跑著的那一輪可以插話（[#710](https://github.com/DemianLi/nexus-agent/issues/710)）：`inbox/spliced` 的 `target` 多一種
 * `next-step`，`user/message` 的 `source` 多一種 `user`（輪中領走、送進模型的那一句）。v19 的檔直接讀：那時候只有
 * `next-turn`，也沒有人話的 `user/message`，一顆都沒有就是當時的樣子。
 *
 * **非升不可**，同 17：19 的折疊不看 `target`，每一顆都套在同一條清單上——`next-step` 的變動會混進 `next-turn`，
 * 或讓折疊拋錯。19 推回模型時也把人話的 `user/message` 當成外掛注入的那一種讀。
 *
 * ## 21：引用別的會話的快照
 *
 * `user/message` 的 `source` 多一種 `session-reference`（[#713](https://github.com/DemianLi/nexus-agent/issues/713)）：人在句子裡
 * `@` 了別的會話，準備那一步把那條會話當時看得到的對話凍成一則 user-role 訊息，緊跟在那句人話後面。v20 的檔直接讀：那時候沒有
 * 引用，一顆都沒有就是當時的樣子。
 *
 * **非升不可**，同 13、17：20 讀到一份 21 的日誌時，`source` 不是 `plugin` 也不是 `user`，推回模型時照「外掛塞的」那一種讀、
 * 畫面（歷史）對它視而不見，goal 的授權判準與內容搜尋各自的判斷也都沒見過這個成員——靜靜略過會左右重建的內容就是一次讀錯。
 *
 * ## 22：`turn/end` 的 `aborted` 多一種原因 `parent`
 *
 * 父代理用 `interrupt_agent` 只停一個背景子代理當下那一輪（[#838](https://github.com/DemianLi/nexus-agent/issues/838)），
 * 該子代理的日誌以 `reason: {kind:'aborted', cause:{kind:'parent'}}` 收尾。v21 的檔直接讀：那時候沒有這條路，
 * `cause` 只有 `user`。
 *
 * 升版照新增詞彙的慣例（同 11、12、14、16），不是非升不可：21 讀到它只看 `reason.kind`，一樣當成「被打斷」，
 * 沒有任何讀方分 `cause`。
 *
 * ## 23：`turn/start` 多一種 `agent-message`
 *
 * 父代理用 `send_message` 給背景子代理追加指示（[#839](https://github.com/DemianLi/nexus-agent/issues/839)），子代理那一輪
 * 以 `{kind:'agent-message', text, senderSessionId}` 開頭。v22 的檔直接讀：那時候沒有這條路，子代理的輪只有 `message`。
 *
 * 升版照新增詞彙的慣例（同 18、19、22），不是非升不可：授權判別對認不得的 `kind` 都是停住回假（fail closed），
 * 22 讀到它不會把它當成人。
 *
 * ## 24：背景子代理結算通知（`subagent-settled`）
 *
 * 背景子代理結算時通知主對話（[#840](https://github.com/DemianLi/nexus-agent/issues/840)），root 日誌上出現三處新詞彙：
 * `turn/start` 的 `subagent-settled`（閒著時通知開了一輪）、`user/message` 的 `source: {kind:'subagent-settled', form:'notice', …}`
 * （忙著時被插話領走），以及送出佇列 `inbox/spliced` 項目的 `source: {kind:'subagent-settled', …}`。v23 的檔直接讀：那時候沒有這條路。
 *
 * 升版照新增詞彙的慣例（同 18、19、22、23）：23 讀到它，授權判別對認不得的 `kind` 停住回假，不會把它當成人；但畫面（歷史）
 * 與送出佇列的 wire 投影沒見過這個成員，所以這一版改了它們。
 *
 * ## 25：子代理寫給主對話的話（`agent-message` 進 root 日誌）
 *
 * 背景子代理用 `send_message` 寫給主對話（[#849](https://github.com/DemianLi/nexus-agent/issues/849)），root 日誌上出現：
 * `turn/start` 的 `agent-message`（v23 起就有，那時只出現在子代理日誌）、`user/message` 的
 * `source: {kind:'agent-message', form:'relay', senderSessionId}`（忙著時被插話領走），以及送出佇列項目的
 * `source: {kind:'agent-message', senderSessionId}`。v24 的檔直接讀：那時候沒有這條路。
 *
 * 升版照新增詞彙的慣例（同 24）：授權判別對認不得的 `kind` 停住回假。
 *
 * ## 26：子代理選模型的政策（`subagent/model-selection-policy`）
 *
 * root 日誌上出現新事件種類 `subagent/model-selection-policy`（[#875](https://github.com/DemianLi/nexus-agent/issues/875)，
 * 卡 [#709](https://github.com/DemianLi/nexus-agent/issues/709)）：沒有歷史的新會話在設定打開時寫一顆 `{allowedModels}`，
 * 事件存在＝政策開著。v25 的檔直接讀：沒有這一顆就是關，跟那時一樣。
 *
 * 升版照新增詞彙的慣例：25 的讀者遇到它會當成認不得的種類略過（各 switch 都有 `default`），不會壞，只是不知道政策——
 * 而 25 的組裝也沒有逐次選模型這個功能，所以略過是對的。
 *
 * ## 27：結算通知多一格 `reason`
 *
 * 背景子代理結算通知的來源多一個選填欄 `reason`（`completed`／`aborted`／`max-tokens`／`error`，
 * [#884](https://github.com/DemianLi/nexus-agent/issues/884)）：`turn/start` 與 `user/message` 的 `subagent-settled`，
 * 以及送出佇列項目的 `source`。畫面據它分得出「完成、被停止、失敗、超出上限」，不去解析給模型看的英文 `summary`。
 * v26 的檔直接讀：沒有這一格，畫面退成中性的說法，不假裝成「已完成」。
 *
 * 升版照新增欄位的慣例（同 21 的 `cause`），不是非升不可：26 讀到它只多一個不認得的欄位，一樣照舊投影。
 *
 * ## 28：模型重試（`llm/retry`、`llm/retry-started`）
 *
 * 真模型的請求失敗、排定重試時寫 `llm/retry`，等完重打前寫 `llm/retry-started`
 * （[#712](https://github.com/DemianLi/nexus-agent/issues/712)），落在一次模型呼叫的 `model/start`／`model/end`
 * 之間。維運者查「這一輪為什麼慢」靠它。v27 的檔直接讀：那時候重試不進日誌，一顆都沒有就是當時的樣子——
 * **不是沒重試過**。
 *
 * 升版照新增詞彙的慣例（同 26）：27 的讀者遇到它們會當成認不得的種類略過（各 switch 都有 `default`），兩顆都不進模型、
 * 也不左右任何折疊，所以略過是對的。
 *
 * ## 29：`turn/end` 的 `reason` 多一種 `interrupted`（續接補寫的收尾）
 *
 * 行程在一輪中間死掉，續接時把那一輪的收尾寫回檔上（[#721](https://github.com/DemianLi/nexus-agent/issues/721)）：
 * 記過 `tool/call` 沒配到結果的各補一顆「結果不明」的 `tool/result`，最後補 `turn/end {reason:{kind:'interrupted'}}`，
 * 兩者都在 `session/end-seed` 前面。v28 的檔直接讀：那時候續接只補 end-seed，當掉的那一輪永遠開著，
 * 模型那一側由 replay 在記憶體裡補同樣的句子——**不是沒有當掉過**。
 *
 * 升版照新增詞彙的慣例（同 22、23），不是非升不可：28 讀到 `interrupted` 時，goal 續行只認得 `aborted`、`max-tokens`
 * 就把它當正常收尾，但那顆 `turn/end` 在 end-seed 之前，而 28 的續行判準從 `currentTurnStart`（不往 end-seed 前找）起算，
 * 續接回來的授權也從 `disarmed` 起，所以不會因此多排一輪；歷史把它當完成收掉，同 28 在 end-seed 收掉的那一條。
 *
 * ## 30：header 多四格——`build`、`plugins`、`configHash`、`modelEntryId`
 *
 * 拿到一份日誌要答得出「哪一版程式寫的、掛了哪些插件、用哪一筆模型型錄」（[#1025](https://github.com/DemianLi/nexus-agent/issues/1025)）。
 * 四格都是**建立者的描述**，見 {@link StoredSessionHeader} 各格。這是 header 的形狀第二次變（第一次是 13）。
 *
 * 升版照新增欄位的慣例（同 27），也照 dsh 那條門檻把 header 的形狀列為結構性變更、「拿不準就升」
 * （`packages/core/session/src/types.ts:74-87`，`5badb15`），**不是 13 那種非升不可**：29 續接一份 30 的日誌時，
 * 重寫 header 那一行是 `{ ...header, version: … }`（`apps/harness/src/jsonl-session-store.ts`），這四格原樣活過重寫；
 * 而它們描述的本來就是**最初寫這份日誌的那一個行程**，續接的行程不該蓋掉它（30 自己續接也不蓋），沒有任何讀方拿它們
 * 判准不准續接、怎麼重建對話。
 *
 * 29 以前的檔直接讀：一格都沒有就是那時候沒記。**判準是那一格在不在，不是 {@link StoredSessionHeader.version}**
 * ——續接會把舊檔的 `version` 蓋成這一版而不回填這四格，理由同 13 的 `workspaceRoot`。
 *
 * ## 31：`subagent/catalog`
 *
 * 父那一份記下派出去的子代理：子會話 id 與派它的那一顆 `tool/call`（[#1023](https://github.com/DemianLi/nexus-agent/issues/1023)，
 * 照 dsh 的同名事件，見 `subagent-catalog.ts`）。v30 以前的檔直接讀：那時候沒有這一顆，前景子代理從父日誌找不到，只剩子日誌 header
 * 的 `parentSession`；背景的仍可從 `tool/result.meta.runId` 推。讀的人照「沒記」表態（「—」），**不是沒有子代理**。
 *
 * 升版照新增詞彙的慣例（同 26、28），不是非升不可：30 的讀者遇到它會當成認不得的種類略過（各 switch 都有 `default`），它不進模型、
 * 也不左右任何折疊，所以略過是對的。
 *
 * ## 32：事件信封多一格 `ignorable`，讀方開始拒絕不認得的必需種類
 *
 * 每一筆事件可以帶 `ignorable: true`（[#507](https://github.com/DemianLi/nexus-agent/issues/507)，見 {@link SessionEvent.ignorable}），
 * 同時讀方多了一道守衛：**碰到不認得的 `type`、又沒有這個標記，就拒絕重建整份日誌**（{@link SessionEventUnsupportedError}），
 * 不再照收。前面三十一版「對不認得的種類照收」，所以那時守這條線的**只有版本號**，詞彙每長一次都得升。
 *
 * **非升不可，而且這是最後一次因為「守衛不存在」而升**：31 以前的 runtime 沒有這道守衛，讀到一份 32 以後的日誌裡它不認得、
 * 也沒有人替它把關的種類，只會照收然後續寫下去。升到 32，它們讀 header 就以 {@link SessionFormatUnsupportedError} 拒讀。
 * 同 dsh 那條門檻裡的「事件信封」一項（`packages/core/session/src/types.ts:74-87`，`5badb15`）。
 *
 * ### 32 起什麼時候要升版
 *
 * 照 dsh：**判準是寫方寫出來的東西，一台舊 runtime 還能不能完整正確地處理**，不是「讀得過不過」。只有結構性變更才算：
 * header 的形狀、事件信封、**已有種類的語意**（含它進不進模型、左右不左右折疊）、以及會左右重建的必需種類。純資訊性的新種類
 * **不升**，由 `ignorable` 承擔——新增時在 {@link ./session-log.ts | SessionLog.append} 帶 `{ ignorable: true }`；一台還不認得它的舊 runtime
 * 讀得回這份日誌，把它略過。**拿不準就升**：多升一次的代價是營運面的（一台停在舊號的 server 接不回新號寫過的 thread），
 * 少升一次是舊 runtime 靜靜讀錯；忘了標 `ignorable` 則只是多拒一次（預設必需），不會讀錯。
 *
 * ### 這一版的讀法
 *
 * - **舊的號直接讀。** 31 以前的檔沒有 `ignorable` 這一格，而它們裡面的每一種都在 {@link ./session-log.ts | isKnownSessionEventType} 的表裡——
 *   **種類只增不減**（缺席＝必需，所以任何一版寫過的種類這一版都必須認得；要退役一種，留在表裡、只是不再寫）。
 *   這是一條要守的前提，`session-log.test.ts` 有一份凍結的清單釘它。
 * - **守衛只在讀方**，不在 append：append 時拒絕詞彙會讓正在跑的會話的耐久寫入卡住（同 dsh）。離線掃描
 *   （`apps/harness/src/eval/session-scan.ts`，產品路徑外）不守，它照格式版本表態、認不得的略過並報數。
 * - **不追溯改前三十一次的版本號**：寫下的 header 就是那些號。
 *
 * ### 32 之內新增、沒有升版的欄位
 *
 * - **`modelCall`**（[#1021](https://github.com/DemianLi/nexus-agent/issues/1021)）：`model/end`、`model/usage`、`llm/retry`、
 *   `llm/retry-started`、`assistant/message`、`context/measure` 各多一個選填欄，值是所屬那次模型呼叫的 `model/start` 的 `seq`。
 *   **不升**：前五種不進模型；`assistant/message` 進，但新欄不左右它怎麼進。六種都不左右任何折疊，沒有任何舊讀方拿這一格做事；
 *   一台 32 的舊 runtime 讀回這份日誌，多一個不認得的欄位照舊投影，只是不知道誰屬於哪次呼叫。判準同上：寫方寫出來的東西，
 *   舊 runtime 還能不能完整正確地處理——能。**沒有這一格就是沒記**（這一版以前寫的，或寫入點不在呼叫範圍裡），讀的人標「—」，
 *   不是推位置（`indexModelCalls`）。
 * - **`outcome` 與 `usage`**（[#1022](https://github.com/DemianLi/nexus-agent/issues/1022)）：`model/end` 與 `model/usage` 各多一個選填的
 *   `outcome`（`error`｜`aborted`，只在那次呼叫沒有正常回來時帶），`compaction/summary` 多一個選填的 `usage`（生摘要那次報的用量）。
 *   另外失敗的呼叫現在也可能寫出 `model/usage`（帶 `outcome`）。**不升**：兩個 `outcome` 與 `usage` 都是選填欄、沒有人拿它們
 *   左右重建；失敗那顆 `model/usage` 不進模型，**舊讀方照常讀它**——加總的折疊本來就該把花掉的 token 都算進去，「目前大小」讀最新一筆的
 *   也照讀（同 dsh：`contextPressure` 連 `assistant/attempt` 的用量也取樣，那份請求真的送出去過），所以一台 32 的舊 runtime
 *   讀回這份日誌的畫面與新 runtime 一樣。判準同上：寫方寫出來的東西，舊 runtime 還能不能完整正確地處理——能。**沒有這幾格就是沒記**
 *   （這一版以前寫的，或供應商沒報），讀的人標「—」，不是 0。
 * - **`approval/asked` 與 `approval/decided`**（[#1029](https://github.com/DemianLi/nexus-agent/issues/1029)）：核准的問與答各一顆，
 *   新增的**種類**、都帶 `ignorable: true`。**不升**：判準同上（寫方寫出來的東西，舊 runtime 還能不能完整正確地處理）——能，
 *   它們不進模型、不左右任何折疊，一台 32 的舊 runtime 讀回這份日誌時略過它們，畫面與新 runtime 只差側欄那一格。**沒有這兩顆
 *   就是沒記**（這一版以前寫的），讀的人標「—」，不是「沒有人被問過」。同批：核准拒絕的 `tool/result.error` 多了
 *   `APPROVAL_REJECTED_BY_USER` 等碼（`tool-events.ts`），`error` 本來就是選填，舊讀方照收。
 * - **`session/resumed`**（[#1138](https://github.com/DemianLi/nexus-agent/issues/1138)）：續接時實際載入的建置版本、插件清單與設定雜湊
 *   （形狀同 header 的那三格）。新增的**種類**、帶 `ignorable: true`。**不升**：判準同上——它不進模型、不左右任何折疊，
 *   一台 32 的舊 runtime 讀回這份日誌時略過它，只少了「後來是哪一版接手的」。**沒有這一顆就是沒記**（這一版以前續接的），
 *   讀的人拿 header 那份當答案，並知道它只是建立當下的。header 本身不動。
 * - **`turn/failed.error`**（[#434](https://github.com/DemianLi/nexus-agent/issues/434)）：`turn/failed` 多一個選填的 `error`
 *   （`{ message, code, status? }`，失敗的分類）。**不升**：判準同上——一台 32 的舊 runtime 讀回這份日誌，`turn/failed` 的每個讀者
 *   （goal 續行、歷史、統計、遙測…）只認「有這顆事件」或讀 `message`，多一個不認得的欄位照舊投影。**沒有這一格就是沒記**
 *   （這一版以前寫的），讀的人標「—」，不是 `UNKNOWN`；`UNKNOWN` 是「記了、而且不是供應商的錯」。
 * - **前景子代理日誌的第一顆 `user/message`**（[#1159](https://github.com/DemianLi/nexus-agent/issues/1159)）：基座 `task` 派出的前景子代理，
 *   子日誌出生時多寫一顆來源 `user` 的 `user/message`，內容是它收到的那句話（`task` 的 `description`）。**不升**：沒有新種類、沒有新欄位，
 *   舊 runtime 讀它就是一顆平常的 `user/message`，且前景子代理是 one-shot，沒有續接這回事。**沒有這一顆就是沒記**（這一版以前寫的前景子日誌）：
 *   從那種日誌推子代理的歷史會缺開頭那句話，讀的人要從父日誌 `tool/call` 的 `description` 補，不能當成「沒有輸入」。
 *
 * ## 33：續接把當掉那一輪的收尾寫回日誌（[#721](https://github.com/DemianLi/nexus-agent/issues/721)）
 *
 * 續接時（{@link ./interrupted-turn.ts | resumeClosingInterruptedTurn}）日誌尾巴停在一輪開著，就在 `session/end-seed` **之前**補寫：
 * 沒配到結果的呼叫各一顆錯誤 `tool/result`、開著的 `model/start` 各一顆 `model/end {outcome:'error'}`、最後一顆 `turn/end {reason:{kind:'interrupted'}}`。
 * 照 dsh 的 `interruptedTurnClosers`（見該檔檔頭）。
 *
 * **升的理由是已有種類的語意變了，不是新增了種類**（判準見 32 的「什麼時候要升版」）：
 *
 * - `tool/result` 現在可以**沒有前面的 `tool/call`**：回覆裡要了、行程在記 `tool/call` 之前死掉的呼叫，補的結果帶 `TOOL_NOT_STARTED`
 *   （dsh 的不變量同樣明文放行）。一台 32 的舊 runtime 的不變量會把它報成違規。
 * - `turn/end` 之後才接 `session/end-seed` 成了常態；舊 runtime 重建對話時在 end-seed 處把「開著的呼叫」補成結果不明，
 *   讀到新檔時那些呼叫已有真的結果，它得靠對得上才不重複補——這個對法左右模型看到的歷史，屬於「會左右重建」那一類。
 *
 * **讀舊檔**：32 以前的檔尾巴沒有補結，照舊靠重建當下在記憶體補（`closer()`）；新程式碼續接它們時會把補結寫在 end-seed **後面**
 * （dsh 的 `repair.ts` 掃描遇到 end-seed 不重設，所以這個形狀是它本來就允許的），之後再續接不會重複補（冪等）。
 * 數字影響：被當掉收尾的輪現在在檔上是 `interrupted` 而不是「開著」，`session-stats`、`eval/session-scan`、`eval/session-draft` 與 web 歷史
 * 對「當掉的輪」的計數會從「沒收尾」移到「被中斷」，見 PR 內文。
 *
 * ## 34：核准政策進日誌（[#437](https://github.com/DemianLi/nexus-agent/issues/437)）
 *
 * 新增 `approval/policy { policy: 'ask' | 'never', source? }`（root 起始值與每次切換；子代理日誌一顆 `source: 'delegation'`）。
 *
 * **升版，而且不標 `ignorable`**——它是新增的**種類**，但判準（見 32 的「什麼時候要升版」）看的是舊 runtime 略過它會不會讀錯：
 * 它**左右續接之後的行為**（記著 `never` 的日誌，被一台 33 的 runtime 略過後會當 `ask` 續接，也就是本來被回絕的事開始去問人）。
 * 同 `sandbox/mode`，也同 dsh（它的 `approval/policy` 沒有略過旗標）：舊 runtime 該拒絕讀。
 *
 * **讀舊檔**：33 以前沒有這一顆，續接時照 `ask` 起算，也就是以前的行為，不補寫歷史。
 *
 * ## 35：具名權限組合進日誌（[#437](https://github.com/DemianLi/nexus-agent/issues/437)）
 *
 * 新增 `permission/preset { preset }`（使用者選了哪一組；由 `@nexus/plugin-permission-presets` 宣告與寫入）。
 *
 * **升版，不標 `ignorable`**——它自己不控制執行（兩顆旋鈕各自的事件才控制），但 dsh 的 `permission/preset` 同樣沒有略過旗標，而且它是
 * 新增的**種類**：舊 runtime 讀到不認得的種類就該拒絕，由版本號管相容，不要靠「略過了應該沒事」。
 *
 * **讀舊檔**：34 以前沒有這一顆，續接時由目前的沙箱與核准值推導現在是哪一組，不補寫歷史；新會話在起始時把推出來的那一組釘進去。
 *
 * ## 36：`model/usage` 的輸入分桶（[#724](https://github.com/DemianLi/nexus-agent/issues/724)）
 *
 * `model/usage` 與 `compaction/summary.usage` 的 `inputTokens` 改成**未快取**的輸入，新增選填的 `cacheReadTokens`、`cacheWriteTokens`
 * （缺席＝沒記），四桶互不重疊，照 dsh 的 `TokenUsage`。完整的 prompt 是三桶相加。
 *
 * **升版，不標 `ignorable`——而且這次非升不可**：事件種類沒變，**欄位的語意變了**。一台 35 的 runtime 讀新檔，會把未快取的 `inputTokens`
 * 當成整個 prompt，總帳與上下文壓力都少算快取的那一段，而且不會有任何東西報錯。同 13、15、17 那條門檻，dsh 對核心事件語意改變也升版（#507）。
 *
 * **讀舊檔**：35 以前沒有快取兩格，`inputTokens` 當未快取（它本來就是整個 prompt）、兩桶當「沒記」，總帳與壓力的數字跟以前一樣，
 * 不必逐版分辨。
 *
 * ## 37：每會話模型選擇（[#723](https://github.com/DemianLi/nexus-agent/issues/723)）
 *
 * 新增 `model/selection { modelId, reasoningEffort? }`（使用者替會話選了下一步起用的模型與強度），並讓 `model/start` 多一格選填的
 * `route { model, effort? }`（這次請求實際走的路由）。
 *
 * **升版，`model/selection` 不標 `ignorable`**——它左右續接之後的行為：一台 36 的 runtime 略過它，續接時會悄悄用回部署預設那顆。
 * `model/start.route` 單獨看是純附加的選填欄位，但它是續接「沒選過的會話」時沿用上一次路由的依據，所以跟著同一個版本。
 *
 * **讀舊檔**：36 以前沒有這兩樣，續接時走部署預設、不補寫歷史；舊日誌上沒有路由，所以第一次選了別顆之後也不附換模型的通知
 * （沒有「上一次走的是誰」可比）。
 *
 * ## 38：訊息帶附件（[#732](https://github.com/DemianLi/nexus-agent/issues/732)）
 *
 * 人送出的一句話可以帶檔案與圖片。位元組在日誌之外（附件儲存，內容定址），日誌與存檔點只留**參照**：`inbox/spliced` 裡那一件
 * （`QueuedInput`）與 `turn/start`（`kind: 'message'`）各多一格選填的 `attachments`（`AttachmentRef` 的陣列，照選取順序），
 * 輪中插話被領走時記的 `user/message` 的 `HumanMessage` 內容多了 `nexus-file`／`nexus-image` 區塊。
 *
 * **升版，不標 `ignorable`——而且前例（#1021、#1022 的觀測欄位）不適用**：那兩次的欄位只供觀測，這次的欄位**左右續接之後的行為**。
 * 一台 37 的 runtime 讀到新檔會把 `attachments` 略過：排著的項目被折回來重跑時附件悄悄消失，模型收到一句缺了檔案的話，沒有任何東西報錯。
 *
 * **讀舊檔**：37 以前沒有這一格，等於沒有附件，不補寫歷史。
 *
 * ## 39：目標續行走送出佇列（[#638](https://github.com/DemianLi/nexus-agent/issues/638)）
 *
 * `inbox/spliced` 裡的 `QueuedInput.source` 多一種成員 `{ kind: 'goal', goalId, revision, round }`：排程器為下一輪預約的一件，
 * 以前續行直接開一輪、不經佇列。開跑時 `turn/start` 照舊是 `kind: 'goal'`（那一顆沒變）。
 *
 * **升版，不標 `ignorable`**——`inbox/spliced` 是既有種類，新增的是**欄位值的成員**，舊 runtime 不能略過這一顆（略過就是佇列折錯）。
 * 一台 38 的 runtime 折到新檔時，佇列裡還排著的一件預約它認不得來源：`pumpInputOf` 對不認得的來源大聲拋，這條 thread 起不來——
 * 這是對的方向（拒絕讀），但要由版本號擋在讀檔那一步，而不是等到續接後第一次領走才炸。
 *
 * **讀舊檔**：38 以前沒有這個來源，續行是直接開的一輪，不補寫歷史。日誌裡**排著沒領走的預約**（行程死在預約與開跑之間）：
 * 重啟後折回來和人排的一樣停住，領走時驗證不過（授權不持久，重啟後一定是 `disarmed`）就丟掉、不開那一輪。
 *
 * ## 40：`turn/end` 多一種原因 `blocked`（[#633](https://github.com/DemianLi/nexus-agent/issues/633)）
 *
 * 封存的會話不跑模型：每一步送出模型請求之前問一次準入閘門，被擋下的那一輪以 `reason: { kind: 'blocked' }` 收尾、一個請求都沒發
 * （見 {@link ./session-log.ts | TurnEndReason}）。背景子代理被擋下的輪同樣以它收尾。
 *
 * **升版，不標 `ignorable`**——`turn/end` 是既有種類，新增的是**欄位值的成員**，而且舊 runtime 照舊讀會讀錯：39 的讀方只認
 * `aborted`／`max-tokens`（goal 續行的判準），對不認得的 `reason.kind` 一律當一輪正常做完，於是一輪**什麼都沒做**的收尾被讀成做完了，
 * 歷史也不會標出來。拒絕讀（由版本號在讀檔那一步擋下）才是對的方向。
 *
 * **讀舊檔**：39 以前沒有這個原因，不補寫歷史。
 *
 * ## 41：`session/title` 的 `source` 多一種 `user`（[#633](https://github.com/DemianLi/nexus-agent/issues/633)）
 *
 * 使用者改名：追加一顆 `session/title`，`source: { kind: 'user' }`、`messageSeqs: []`，**釘住**這個標題（見 {@link ./session-log.ts | SessionTitleSource}）。
 * 40 以前的檔直接讀：那時沒有人工改名，一顆 `user` 都沒有就是當時的樣子。
 *
 * 升版照新增詞彙的慣例（同 18、19），不是非升不可：40 讀到 `user` 標題照樣拿最後一顆（列表、歷史讀的就是文字），一字不差。釘住由寫標題的人
 * 守：退回標題只在沒有標題時寫，模型標題在寫入前看到最後一顆是 `user` 就放棄（見 `apps/harness/src/session-title.ts` 的 `titlePinnedByUser`）。
 *
 * ## 42：訊息點名子代理（[#328](https://github.com/DemianLi/nexus-agent/issues/328) 第 2 項）
 *
 * 人送出的一句話可以點名派哪一個子代理（`run.start` 的 `mention`）。`inbox/spliced` 裡那一件（`QueuedInput`）與 `turn/start`（`kind: 'message'`）各多一格選填的
 * `mention { kind: 'subagent', name }`；輪中插話被領走時記的 `user/message` 的 `HumanMessage` 內容在文字之後多一個固定的文字區塊（見 `subagent-mention.ts`）。
 *
 * **升版，不標 `ignorable`**——同 38：這個欄位**左右續接之後的行為**。一台 41 的 runtime 讀到新檔會把 `mention` 略過，排著的項目被折回來重跑時，
 * 模型收到的是一句沒有點名的話，沒有任何東西報錯。
 *
 * **讀舊檔**：41 以前沒有這一格，等於沒有點名，不補寫歷史。
 *
 * ## 43：`image/offload`——把最舊的幾張圖永久從之後的請求省略（[#1270](https://github.com/DemianLi/nexus-agent/issues/1270)）
 *
 * 看圖模型的請求超過型錄宣告的圖片額度（`imageBudget`）時（adapter 在送出之前量到、以 `IMAGE_OFFLOAD_REQUIRED` 失敗，上層接住），記一筆 `image/offload { targets: [{ seq, imageIndexes }] }`，最舊的幾張換成佔位字，
 * 之後每一次請求都沿用（見 {@link ./session-log.ts | SessionEventMap} 的 `image/offload`）。
 *
 * **升版，不標 `ignorable`**——它左右之後模型看到什麼：一台 42 的 runtime 會拒絕讀這種新檔（不認得又沒標可忽略），那是對的方向；略過它，
 * 模型就又看到已經省略的圖，請求再度超額，沒有任何東西說為什麼。
 *
 * **讀舊檔**：42 以前沒有這一種，等於沒省略過，不補寫歷史。
 */
export const SESSION_LOG_FORMAT_VERSION = 43;

/**
 * 寫這份日誌的程式碼是哪一版（[#1025](https://github.com/DemianLi/nexus-agent/issues/1025)）。
 *
 * 取法同 eval 結果檔（`apps/harness/src/eval/result-file.ts` 的 `readGitProvenance`，#1000）：**拿不到就是 `null`**，
 * 不填 `'unknown'` 字串——字串會被當成一個 SHA 比對，`null` 不會。
 */
export interface StoredSessionBuild {
  /** `git rev-parse HEAD`；不在 git 底下、沒有 git 就是 `null`。 */
  readonly commit: string | null;
  /** 工作樹有沒有未提交的改動（含未追蹤的檔）；問不到就是 `null`。只記 SHA 的話，本機改過的程式會冒名成那個 commit。 */
  readonly dirty: boolean | null;
}

/**
 * 疊完的插件清單上的一列，**不帶 `config`**（[#1025](https://github.com/DemianLi/nexus-agent/issues/1025)）。
 *
 * 設定可能含金鑰或內網位址，所以內容不進日誌，只進 {@link StoredSessionHeader.configHash}。
 */
export interface StoredSessionPluginRow {
  /** 那一列的 `name`：**模組 specifier**（`@nexus/…`、`#settings/…`、`file:` 網址），不是 plugin 物件上的 `name`。 */
  readonly name: string;
  /** 那一列寫的 `id`；沒寫就沒有這一格（不補載入器補的號，那是 `--dump-config` 印不出來的東西）。 */
  readonly id?: string;
  /** 那一列寫了 `disabled: true`。 */
  readonly disabled: boolean;
}

/**
 * 一次組裝裡**每一份新建的 header** 都帶的那三格，由入口算一次、交給
 * {@link ./session-persistence.ts | attachSessionPersistence}（[#1025](https://github.com/DemianLi/nexus-agent/issues/1025)）。
 */
export interface SessionHeaderBuildMetadata {
  readonly build: StoredSessionBuild;
  readonly plugins: readonly StoredSessionPluginRow[];
  /** 見 {@link StoredSessionHeader.configHash}。算不出來（金鑰檔讀不到）就沒有這一格。 */
  readonly configHash?: string;
}

/**
 * 一份已存會話的元資料，**存在事件日誌之外**。
 *
 * 照 dsh：header 不進 `SessionEventMap`，也不會到 `deriveMessages()`。它描述的是這份
 * 存檔，不是對話裡發生過的事。
 */
export interface StoredSessionHeader {
  /** 格式版本，蓋 {@link SESSION_LOG_FORMAT_VERSION}。 */
  readonly version: number;
  /** 這份日誌屬於誰，就是 `SessionLog.sessionId`。 */
  readonly id: string;
  /** 建立當下的 Unix 毫秒。 */
  readonly createdAt: number;
  /** 建立當下的工作目錄，有的話。 */
  readonly cwd?: string;
  /**
   * 建立當下的工作區根——`--workspace` 解析出來的絕對路徑，**沒跑在工作區底下就沒有這一格**
   * （[#504](https://github.com/DemianLi/nexus-agent/issues/504)）。
   *
   * **跟 {@link cwd} 是兩件事。** `--workspace` 照 cwd 解析，所以同一個 cwd 底下換一個
   * `--workspace`，兩次跑的根不同而 `cwd` 一模一樣——`cwd` 那一格分不出這件事。記下它是為了
   * 讓一顆重播的 `deliverables/presented` 有錨（#452），而
   * [#519](https://github.com/DemianLi/nexus-agent/issues/519) 起真的有人在讀它：
   * `apps/harness/src/wire-handler.ts` 的 `locateAt` 拿「這一格在不在」當准不准用今天
   * 這個根的判準（**不是拿 {@link version} 判**，理由見那裡與下一段）。
   *
   * **舊日誌永遠沒有這一格，而且續接不回填。** 續接時 root 那一份走的是已存的把手，
   * `attachSessionPersistence` 新建的 header 只有這個行程新開的 subagent 用得到；
   * 所以同一個 run 目錄裡會出現「root 沒有這一格、subagent 有」，那是對的，不要順手補齊
   * ——補進去等於替那些更早的事件宣稱一個沒人驗證過的錨。
   */
  readonly workspaceRoot?: string;
  /**
   * 它 fork／spawn 自哪一份，有的話。
   *
   * subagent 的日誌帶 root 的 id——**血緣要讀得出來**，同 `SessionRegistry` 檔頭那條
   * 「id 是 `<root>/<runId>`，對到 dsh 的 `header.parentSession`」。
   */
  readonly parentSession?: string;
  /**
   * 寫這份日誌的程式碼版本（[#1025](https://github.com/DemianLi/nexus-agent/issues/1025)）。
   *
   * **續接不改它**：續接的行程沿用已存的 header，所以這一格永遠是最初那一個行程。續接之後才新開的 subagent
   * 日誌帶的是續接那個行程的版本——同 {@link workspaceRoot} 那條「root 沒有、subagent 有」，那是對的，不要回填。
   * 30 以前的日誌沒有這一格。
   */
  readonly build?: StoredSessionBuild;
  /** 建立當下疊完的插件清單，順序同 `--dump-config`。見 {@link StoredSessionPluginRow}；續接規則同 {@link build}。 */
  readonly plugins?: readonly StoredSessionPluginRow[];
  /**
   * 建立當下疊完的整份插件設定（含每一列的 `config` 與 `disabled`）的**帶鍵雜湊**，格式 `hmac-sha256:<16 個十六進位字元>`。
   *
   * **只能跟同一台機器、同一個 harness home 寫的比**：鍵是 home 底下一個只有擁有者讀得到的檔，不進日誌。不用無鍵
   * 雜湊是因為設定的大半是公開的（出貨的 `cordis.yml` 在 repo 裡），剩下的未知數常常只是一個內網位址——無鍵的話，
   * 拿日誌的人可以逐一猜到雜湊對上。續接規則同 {@link build}。
   */
  readonly configHash?: string;
  /**
   * root 用的那一筆模型型錄 id（`live-model` 的 `modelId`）。**只有 root 的 header 有**：subagent 可能被選模型政策換成
   * 型錄裡的另一筆，蓋上 root 的 id 等於替它宣稱一個沒用過的模型；假模型（沒帶 `--live`）不是型錄裡的一筆，也沒有。
   * 續接規則同 {@link build}。
   */
  readonly modelEntryId?: string;
}

/**
 * 通往一份已存會話的一條打開的通道。
 *
 * **單一擁有者的狀態，不是共用服務**：一份會話一個把手，`close()` 是唯一的收尾
 * （冪等）。關掉之後的每一個操作都要拒絕。
 */
export interface StoredSession {
  /**
   * 續在目前邏輯尾端後面的一批，**照 `seq` 排、連續**。
   *
   * 盡力而為：resolve 只代表這一批被接受並排好序，**耐久要靠 {@link flush}**。
   *
   * @param events - 這一批，第一顆的 `seq` 必須等於已存的 next-seq。
   * @throws 這一批不連續、或把手已經關掉。
   */
  append(events: readonly SessionEvent[]): Promise<void>;
  /**
   * 耐久屏障——**唯一承諾儲存的那個操作**。resolve 之後，每一筆被接受過的 append
   * 都撐得過崩潰。
   *
   * @throws 寫不進去。**要響亮地拒絕**：這是呼叫端唯一聽得見耐久失敗的地方。
   */
  flush(): Promise<void>;
  /**
   * 收掉：排空還沒落地的東西、放掉資源。冪等。
   *
   * @throws 排空失敗。理由同 {@link flush}——收尾時吞掉寫入失敗，等於讓一次靜默的
   *   資料遺失看起來像正常關機。
   */
  close(): Promise<void>;
}

/**
 * 開得出已存會話的後端。
 *
 * **同步**，因為實體化可以延後（見模組說明第 3 條）。
 */
export interface SessionStore {
  /**
   * 開一份新的已存會話。
   *
   * @param header - 這份存檔的元資料。
   * @returns 它的把手。IO 延後到第一次 `append`／`flush`。
   */
  create(header: StoredSessionHeader): StoredSession;
  /**
   * 讀回一份已存的會話，交出一個**接著寫**的把手
   * （[#251](https://github.com/DemianLi/nexus-agent/issues/251) 的門 A）。
   *
   * 照 dsh 的續接：讀回來的是**實體上有效的前綴**——最後一行寫到一半（當掉時的常態）不算
   * 進去，把手第一次寫入之前把它截掉。中段的壞行或缺號不是當掉，是壞檔，要拒絕。
   *
   * @param id - 要續接的會話 id，就是當初 `create` 的 `header.id`。
   * @returns 讀回來的 header（`version` 是存的那個）、事件，與 next-seq 等於事件數的把手。
   * @throws {@link SessionFormatUnsupportedError} header 的版本比這一版新。
   * @throws {@link SessionCorruptionError} header 或某一行讀不懂、或 `seq` 不連續。
   * @throws {@link SessionNotFoundError} 這個 id 在這裡沒有存檔。
   */
  resume(id: string): Promise<ResumedStoredSession>;
  /**
   * 列出這裡每一份**落了盤的**會話，照 dsh 的 `list`（`packages/session/session-persistence/src/index.ts:201`）。
   * 唯讀：不拿租約、不讀本文。root 與 subagent 都列，誰要過濾誰自己濾。
   *
   * @param options - 中止訊號，同 dsh 的 `SessionPersistenceListOptions`。
   * @returns 讀得懂的每一份，**不承諾順序**；與讀不懂、版本太新而沒列的份數（偏離，見模組說明）。
   * @throws 存放處存在但讀不到；`signal` 中止時拋它的 `reason`。
   */
  list(options?: StoredSessionListOptions): Promise<StoredSessionListing>;
  /**
   * 唯讀打開一份，照 dsh 的 `open(id, 'read')`（`packages/session/session-persistence/src/index.ts:165`）。
   * **不拿租約、不截尾巴、不動 header**：別的行程握著的那一份照樣打得開，打開、讀完，一個位元組都不改。
   *
   * @param id - 哪一份，就是 `header.id`。
   * @param access - 只有 `'read'`。寫的那一條是 {@link resume}。
   * @returns header 已讀好的把手；本文等 {@link ReadonlyStoredSession.read} 才讀。
   * @throws {@link SessionFormatUnsupportedError} header 的版本比這一版新。
   * @throws {@link SessionCorruptionError} header 讀不懂。
   * @throws {@link SessionNotFoundError} 這個 id 在這裡沒有存檔。
   */
  open(id: string, access: 'read'): Promise<ReadonlyStoredSession>;
}

/** {@link SessionStore.list} 的選項。 */
export interface StoredSessionListOptions {
  readonly signal?: AbortSignal;
}

/**
 * {@link SessionStore.list} 的一格，照 dsh 的 `SessionPersistenceSnapshot`
 * （`packages/session/session-persistence/src/index.ts:50-59`）。`eventCount`、`sizeBytes` 是選填的，沒抄。
 */
export interface StoredSessionSnapshot {
  /** 存的那份 header，原樣。 */
  readonly header: StoredSessionHeader;
  /**
   * 不透明的變更記號，照 dsh（`index.ts:184-189`）：**只能跟同一個後端、同一個 id 的比**；相等可以當成這份沒變，
   * 不相等什麼都不承諾。給衍生的讀取快取用（按內容搜尋的索引），不參與 {@link SessionStore.open}／
   * {@link SessionStore.resume}。
   */
  readonly revision: string;
}

/** {@link SessionStore.list} 交出來的東西。 */
export interface StoredSessionListing {
  readonly sessions: readonly StoredSessionSnapshot[];
  /**
   * header 讀不懂、版本比這一版新而沒列的份數。**dsh 沒有這一格**（它的 JSONL `list` 略過不數），見模組說明。
   */
  readonly unreadable: number;
}

/** {@link ReadonlyStoredSession.read} 的選項。 */
export interface StoredSessionReadOptions {
  /**
   * 中段壞掉時**撿回讀得懂的**，不拋：解析不動、或不像一筆事件（沒有數字的 `seq` 與 `time`）的那幾行略過，
   * 其餘照原樣交出——`seq` 可能不連續。給「一份壞檔不該拖垮整份清單」的讀方用（列表、按內容搜尋）；推回模型、
   * 續接這種要整份對得上的，不要開。偏離，見模組說明。
   */
  readonly salvage?: boolean;
}

/** {@link SessionStore.open} 交出來的唯讀把手。 */
export interface ReadonlyStoredSession {
  /** 存的那份 header，原樣。 */
  readonly header: StoredSessionHeader;
  /**
   * 讀整份本文：**實體上有效的前綴**，同續接——最後一行寫到一半不算進去，但也不截掉。只有 header 沒有本文的是零顆。
   * 每叫一次讀一次，讀到的是叫的當下。
   *
   * @throws {@link SessionCorruptionError} 中段某一行讀不懂、或 `seq` 不連續（開了 {@link StoredSessionReadOptions.salvage}
   *   就不拋）。
   */
  read(options?: StoredSessionReadOptions): Promise<readonly SessionEvent[]>;
}

/** {@link SessionStore.resume} 交出來的東西。 */
export interface ResumedStoredSession {
  /** 存的那份 header，**原樣**——`version` 是寫它的那一版，不是這一版。 */
  readonly header: StoredSessionHeader;
  /** 讀回來的事件，照 `seq` 排、從 0 連續。拿去當 `SessionLog` 的 seed。 */
  readonly events: readonly SessionEvent[];
  /** 接著寫的把手。它的 next-seq 就是 `events.length`。 */
  readonly stored: StoredSession;
}

/**
 * 存檔的格式版本比這一版新——**不是壞的，是讀不懂**。
 *
 * 與 {@link SessionCorruptionError} 分開，照 dsh：「数据没有损坏」。兩者混在一起的話，
 * 一個升級過的使用者拿舊版打開新檔，看到的會是「你的檔案壞了」。
 */
export class SessionFormatUnsupportedError extends Error {
  // 子類（{@link SessionEventUnsupportedError}）換名字，所以不寫成字面量型別。
  override readonly name: string = 'SessionFormatUnsupportedError';

  /**
   * @param id - 哪一份會話。
   * @param version - 存檔上寫的版本，原樣。
   * @param message - 子類說明自己是怎麼發現的；省略即「版本比這一版新」。
   */
  constructor(
    readonly id: string,
    readonly version: unknown,
    message?: string,
  ) {
    super(
      message ??
        `會話 "${id}" 的格式版本是 ${JSON.stringify(version)}，這一版只讀得懂到 ` +
          `${SESSION_LOG_FORMAT_VERSION}。檔案沒有壞，是比這一版新。`,
    );
  }
}

/**
 * 存檔裡有一筆事件的種類這一版不認得、又沒標 {@link SessionEvent.ignorable}——**不是壞的，是讀不懂**
 * （[#507](https://github.com/DemianLi/nexus-agent/issues/507)）。
 *
 * 繼承 {@link SessionFormatUnsupportedError}：兩者對讀者是同一件事（這份是更新的版本寫的、升級再來），
 * 所以列表、搜尋、引用候選那幾處本來就擋 `SessionFormatUnsupportedError` 的地方不用改。差別只在是怎麼發現的：
 * 版本號比這一版新（讀 header 就知道），或版本號沒升但本文裡有這一版不認得的必需種類（讀到那一行才知道）。
 * 不認得的必需事件可能左右後面每一筆怎麼讀，所以拒絕整份而不是略過那一筆。
 */
export class SessionEventUnsupportedError extends SessionFormatUnsupportedError {
  override readonly name: string = 'SessionEventUnsupportedError';

  /**
   * @param id - 哪一份會話。
   * @param version - header 上寫的版本，原樣。
   * @param seq - 那一筆事件的 `seq`。
   * @param eventType - 那一筆的 `type`，原樣。
   */
  constructor(
    id: string,
    version: unknown,
    readonly seq: number,
    readonly eventType: string,
  ) {
    super(
      id,
      version,
      `會話 "${id}" 的第 ${seq} 筆事件種類是 ${JSON.stringify(eventType)}，這一版（格式版本 ` +
        `${SESSION_LOG_FORMAT_VERSION}）不認得它，它也沒標可忽略。檔案沒有壞，多半是更新的版本寫的。`,
    );
  }
}

/**
 * 這個 id 在這裡沒有存檔——照 dsh 的 `SessionPersistenceNotFoundError`。
 *
 * **它有自己的型別，是因為有人要據此改走「新開一份」**：serve 碰到一條 thread 時先試著接，
 * 接不到才開新的。拿不到型別的話那一步只能比對字串、或一律改開新的——後者會讓一份壞掉
 * 或版本太新的日誌退到 `create`，撞上 `wx`，而那個失敗在協調器的背景路徑上被收成一行
 * warn：**那條 thread 的日誌就這樣沒了**。所以只有這一種失敗准退，其餘照拋。
 */
export class SessionNotFoundError extends Error {
  override readonly name = 'SessionNotFoundError';

  /**
   * @param id - 找的是哪一份。
   * @param message - 後端自己的說法（例如它找的是哪個路徑）。
   */
  constructor(
    readonly id: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * 另一個寫入把手握著這份會話——照 dsh 的 `SessionAlreadyOwnedError`
 * （`packages/session/session-persistence/src/errors.ts`，SHA `c291e79`）。
 *
 * 多半是另一個行程還開著它：兩邊都寫的話 `seq` 會撞號，所以第二個不寫。行程死了租約就跟著
 * 放掉（kernel 放的），**沒有逾期**——卡住但還活著的持有者不會被搶，照 dsh。
 */
export class SessionAlreadyOwnedError extends Error {
  override readonly name = 'SessionAlreadyOwnedError';

  /** @param id - 哪一份會話。 */
  constructor(readonly id: string) {
    super(`會話 "${id}" 已經有另一個寫入把手握著（多半是另一個行程還開著它），這一次不寫。`);
  }
}

/** 存檔讀得到但讀不懂：header 或中段某一行不是這一版寫得出來的形狀、或 `seq` 不連續。 */
export class SessionCorruptionError extends Error {
  override readonly name = 'SessionCorruptionError';

  /**
   * @param id - 哪一份會話。
   * @param reason - 哪裡壞了。
   */
  constructor(
    readonly id: string,
    reason: string,
  ) {
    super(`會話 "${id}" 的存檔壞了：${reason}`);
  }
}
