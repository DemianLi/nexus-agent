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
 * ## 兩條刻意沒抄的
 *
 * - **沒有 `open`／`stat`／`list`，只有 `create`。** 那三個是給「讀回一份已存的會話」用的，
 *   而我們**今天沒有任何一個讀回的呼叫端**：三個入口都沒有跨重啟的續接
 *   （[#155](https://github.com/DemianLi/nexus-agent/issues/155) 實測）。加一個沒有消費者的
 *   讀路徑，換到的是一份沒有人走過的程式碼。**要加的時候，`create` 的拒絕就是它的掛點**
 *   ——見下一條。
 * - **沒有跨行程的寫租約（`SessionAlreadyOwnedError`）。** 退到最弱但夠用的一條：
 *   {@link SessionStore.create} 對**已經存在的 session**必須拒絕，不得覆寫也不得續寫。
 *   我們的 session id 只在一次組裝內唯一（`SessionRegistry` 的 `<root>/<runId>`），
 *   不像 dsh 的 `SessionId` 全域唯一，所以後端要自己把每一次組裝隔開。這條拒絕是
 *   **未來那個 seeded／rehydrate 路徑的絆索**：在它出現以前，任何撞名都會響。
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
 * 的六種長到今天的十種、還會再長；不蓋版本的話，第一次改詞彙就是一次**沒有版本可以
 * 分支的遷移**——讀方只能靠猜。
 *
 * ## 2：`turn/start` 多了 `kind: 'goal'`
 *
 * 續行驅動器（[#180](https://github.com/DemianLi/nexus-agent/issues/180)）加了第三種輪次
 * 來源，那是一次詞彙變更，所以版本跟著走。
 *
 * **沒有跟著來的遷移包**，理由不是「先欠著」：`SessionStore` 只有 `create`／`append`／
 * `flush`／`close`，**整條讀取路徑不存在**——沒有任何程式碼把存下來的 header 或事件讀
 * 回來，所以沒有讀方需要分支。dsh 為此養兩個遷移包，是因為它真的讀舊檔。這個號今天
 * 只有寫入端，它記的是「這一份存檔是照哪一版詞彙寫的」，給日後的讀方用。
 */
export const SESSION_LOG_FORMAT_VERSION = 2;

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
}
