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
 * ## 兩處跟 dsh 不一樣的
 *
 * - **沒有 `stat`／`list`，讀回只有一個 `resume`。** dsh 的 `open`／`stat`／`list` 是給一個
 *   會列出、查詢、續接任何會話的服務用的；我們的讀方只有續接——CLI 的 `--resume <run 目錄>`
 *   與 serve 碰到一條 thread 時（[#251](https://github.com/DemianLi/nexus-agent/issues/251)
 *   的門 A），兩個手上都已經有位址（目錄與 thread id），不需要列。所以只抄續接要的那一條：讀回、交出一個接著寫的把手。`stat`／`list` 等有人
 *   要列的那天再加。**離線掃描（[#268](https://github.com/DemianLi/nexus-agent/issues/268)）是列的，
 *   但它不經過這個介面**：它在產品路徑外、只讀 JSONL 後端的檔（`apps/harness/src/eval/session-scan.ts`），
 *   不要把手也不拿租約。所以這一條說的仍是執行期的讀方。
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
 * （{@link SessionFormatUnsupportedError}）。守這條線的**只有**這個號：我們的 body parser 對不認得的
 * `type` 照收（`apps/harness/src/jsonl-session-store.ts`），沒有 dsh 那個逐顆的 `ignorable` 旗標。
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
 */
export const SESSION_LOG_FORMAT_VERSION = 18;

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
   * `apps/harness/src/wire-handler.ts` 的 `locateRequested` 拿「這一格在不在」當准不准用今天
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
  override readonly name = 'SessionFormatUnsupportedError';

  /**
   * @param id - 哪一份會話。
   * @param version - 存檔上寫的版本，原樣。
   */
  constructor(
    readonly id: string,
    readonly version: unknown,
  ) {
    super(
      `會話 "${id}" 的格式版本是 ${JSON.stringify(version)}，這一版只讀得懂到 ` +
        `${SESSION_LOG_FORMAT_VERSION}。檔案沒有壞，是比這一版新。`,
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
