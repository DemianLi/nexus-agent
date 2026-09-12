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
 * - **沒有 `stat`／`list`，讀回只有一個 `resume`。** dsh 的 `open`／`stat`／`list` 是給一個
 *   會列出、查詢、續接任何會話的服務用的；我們的讀方只有一個——CLI 的 `--resume <run 目錄>`
 *   （[#251](https://github.com/DemianLi/nexus-agent/issues/251) 的門 A），它手上已經有位址，
 *   不需要列。所以只抄續接要的那一條：讀回、交出一個接著寫的把手。`stat`／`list` 等有人
 *   要列的那天再加。
 * - **沒有跨行程的寫租約（`SessionAlreadyOwnedError`）。** 退到最弱但夠用的一條：
 *   {@link SessionStore.create} 對**已經存在的 session**必須拒絕，不得覆寫也不得續寫。
 *   我們的 session id 只在一次組裝內唯一（`SessionRegistry` 的 `<root>/<runId>`），
 *   不像 dsh 的 `SessionId` 全域唯一，所以後端要自己把每一次組裝隔開。這條拒絕
 *   **在續接出現之後照樣成立**：續接是另一個方法（{@link SessionStore.resume}），它明著打開
 *   一份已存的，`create` 撞到已存在的仍然拒絕——撞名照樣會響，續接不會被當成撞名。
 *   **沒有寫租約的代價仍然在**：兩個行程同時 `--resume` 同一個目錄，兩邊會往同一個檔續寫，
 *   `seq` 會撞號。dsh 靠 `open(id, 'write')` 的所有權把第二個擋掉，我們沒有。
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
 *   這個變體；v2 之於 v3 同理，只多了一種事件。所以不需要遷移包——dsh 養兩個是因為它的
 *   舊版真的長得不一樣。
 * - **比這個號新的拒絕**，而且跟壞檔分開報（{@link SessionFormatUnsupportedError} 與
 *   {@link SessionCorruptionError}，照 dsh 的 `SessionFormatUnsupportedError`／
 *   `SessionPersistenceCorruptionError`）：新版寫的檔不是壞的，是這一版讀不懂。
 * - **續寫進去的是這一版的詞彙**，所以續接的把手第一次寫入時把 header 的 `version` 蓋成
 *   這個號——dsh 同樣在讀的時候把歷史 header 翻成目前的版本。
 */
export const SESSION_LOG_FORMAT_VERSION = 3;

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
   * @throws 這個 id 在這裡沒有存檔。
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
