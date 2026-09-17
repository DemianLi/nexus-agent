/**
 * 人對這個會話的回饋：評分（綁在**輪**上）與 `/feedback` 的一則評語。
 *
 * 形狀照 dsh 的兩個套件（`references/deepseek-harness`，SHA `c291e79`）：評分是
 * `packages/feedback/message-feedback/src/types.ts`，評語與分類是
 * `packages/feedback/command-feedback/src/types.ts`。規則（樂觀鎖、內容一樣就不記、備註上限）
 * 住在 `@nexus/plugin-feedback`，這裡只放兩邊都要讀的詞彙。決議見
 * [#267](https://github.com/DemianLi/nexus-agent/issues/267)，落地是
 * [#278](https://github.com/DemianLi/nexus-agent/issues/278)。
 *
 * ## 對 dsh 的偏離
 *
 * - **目標是輪不是訊息**：dsh 的 `messageId` 在這裡是 `turn`——起頭那顆 `turn/start` 的 `seq`
 *   （往回找第一顆不是 `resume` 的）。我們的日誌不記回覆（`session-log.ts` 檔頭），能指名的最小
 *   單位就是輪；而 dsh 的評分按鈕本來就只放在每一輪最後一則回覆上，所以評到的是同一件事。
 * - **沒有 `sessionId`**：dsh 帶它是因為分叉出來的會話會繼承父會話的回饋。我們不分叉，一份日誌
 *   就是一個會話。
 *
 * ## 還沒做的
 *
 * - **`list`**：dsh 靠它在重新整理後把評分畫回來。**這不是偏離**：評分已經在日誌裡，web 也重播得出
 *   舊回覆（#306），缺的是把重播回覆對到輪、在上面放按鈕。見
 *   [#382](https://github.com/DemianLi/nexus-agent/issues/382)。
 */

import type { SessionLog } from './session-log.js';

/**
 * 回饋的分類，**依畫面呈現的順序**。字面是日誌詞彙，照抄 dsh
 * （`command-feedback/src/index.ts:30-38`）；每個畫面自己擁有它的顯示文字。
 */
export const FEEDBACK_CATEGORIES = [
  'task-result',
  'instruction-following',
  'product-interaction',
  'service-stability',
  'resource-cost',
  'security-privacy-permission',
  'other',
] as const;

/** 七種分類之一。 */
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

/**
 * 一則對整個會話的評語（`/feedback` 記的那一顆）。**兩格都選填**：兩格都沒有的一筆照樣記，
 * 它記下的是「人要人看看這個會話」這件事——照 dsh。
 */
export interface FeedbackRecord {
  /** 去掉前後空白的自由文字；有這一格時一定不是空的。 */
  readonly text?: string;
  readonly category?: FeedbackCategory;
}

/** 對一輪的整體判斷。 */
export type MessageFeedbackRating = 'positive' | 'negative';

/** 一輪目前的評分與它的樂觀鎖版本。 */
export interface MessageFeedbackItem {
  /** 被評的那一輪：起頭那顆 `turn/start` 的 `seq`。 */
  readonly turn: number;
  readonly rating: MessageFeedbackRating;
  /** 選填的說明，驗過之後原樣保留（不 trim）。 */
  readonly note?: string;
  readonly category?: FeedbackCategory;
  /** 只拿來比相等的版本記號，每一次有實質內容的新建或修改都換一個（`randomUUID()`）。 */
  readonly version: string;
  /** 第一次評的時間，Unix epoch 毫秒。 */
  readonly createdAt: number;
  /** 最近一次有實質內容的修改時間。 */
  readonly updatedAt: number;
}

/** `feedback/message-put` 的酬載：修改之後的完整值（含原本的建立時間）。 */
export interface MessageFeedbackPut {
  readonly item: MessageFeedbackItem;
}

/** `feedback/message-delete` 的酬載：哪一輪的評分被收回了。 */
export interface MessageFeedbackDelete {
  readonly turn: number;
}

/** 新建或換掉一輪的評分。 */
export interface MessageFeedbackPutRequest {
  readonly turn: number;
  readonly rating: MessageFeedbackRating;
  /** 選填、不能全是空白。 */
  readonly note?: string;
  /** 省略即不分類。 */
  readonly category?: FeedbackCategory;
  /** 看到的版本；`null` 表示要求目前沒有評分。 */
  readonly ifVersion: string | null;
}

/** 收回一輪的評分。 */
export interface MessageFeedbackDeleteRequest {
  readonly turn: number;
  /** 看到的版本；目前本來就沒有評分時不看。 */
  readonly ifVersion: string;
}

/** 那一輪指不到：不是這份日誌裡一顆起頭的 `turn/start`。 */
export interface MessageFeedbackTargetNotFound {
  readonly code: 'target-not-found';
  readonly turn: number;
}

/** 帶來的版本跟目前的對不上。`current` 是目前那一筆，沒有時是 `null`。 */
export interface MessageFeedbackVersionConflict {
  readonly code: 'version-conflict';
  readonly current: MessageFeedbackItem | null;
}

/** 備註全是空白。 */
export interface MessageFeedbackNoteBlank {
  readonly code: 'note-blank';
}

/** 備註超過設定的 UTF-8 位元組上限。 */
export interface MessageFeedbackNoteTooLarge {
  readonly code: 'note-too-large';
  readonly maxBytes: number;
  readonly actualBytes: number;
}

/** 評分操作共用的失敗。 */
export type MessageFeedbackFailure =
  | MessageFeedbackTargetNotFound
  | MessageFeedbackVersionConflict
  | MessageFeedbackNoteBlank
  | MessageFeedbackNoteTooLarge;

/** 成功。 */
export interface FeedbackSuccess<T> {
  readonly ok: true;
  readonly value: T;
}

/** 帶一個穩定業務碼的拒絕。 */
export interface FeedbackRejected<E> {
  readonly ok: false;
  readonly error: E;
}

/** `put` 的結果。 */
export type MessageFeedbackPutResult =
  FeedbackSuccess<MessageFeedbackItem> | FeedbackRejected<MessageFeedbackFailure>;

/** `delete` 的結果。**本來就沒有評分也算成功**，而且不記事件——重試跟第一次拿到同一個答案。 */
export type MessageFeedbackDeleteResult =
  FeedbackSuccess<{ readonly absent: true }> | FeedbackRejected<MessageFeedbackVersionConflict>;

/** `record` 的結果：記進日誌了。 */
export type FeedbackRecordResult = FeedbackSuccess<{ readonly recorded: true }>;

/**
 * 評分與評語的規則，由 `@nexus/plugin-feedback` 掛上 `registry.feedback`。
 *
 * **三個方法都是同步的，而那就是 dsh 那條 `enqueue` 的替身**：dsh 要把「讀、比、寫」包在一段
 * 非同步的寫入權裡，因為中間隔著磁碟；我們的日誌 `append` 是同步的，同一個行程裡兩次呼叫交錯
 * 不了，比對與寫入之間沒有縫。
 *
 * 呼叫端交進來的是**那個會話 root 的那一份日誌**——評分與評語都只寫 root。
 */
export interface FeedbackService {
  /**
   * 新建或換掉一輪的評分。內容一樣就不記、版本不換。
   * @param log - 會話 root 的那一份日誌。
   * @param request - 目標、想要的值與看到的版本。
   * @returns 目前那一筆，或一個業務碼。
   */
  put(log: SessionLog, request: MessageFeedbackPutRequest): MessageFeedbackPutResult;
  /**
   * 收回一輪的評分。本來就沒有也成功，而且不記。
   * @param log - 會話 root 的那一份日誌。
   * @param request - 目標與看到的版本。
   * @returns 「現在沒有了」，或版本衝突。
   */
  delete(log: SessionLog, request: MessageFeedbackDeleteRequest): MessageFeedbackDeleteResult;
  /**
   * 記一則對整個會話的評語。文字去掉前後空白，空的就當沒有。
   * @param log - 會話 root 的那一份日誌。
   * @param entry - 文字與分類，都可以省略。
   * @returns 記下了。
   */
  record(log: SessionLog, entry: FeedbackRecord): FeedbackRecordResult;
}
