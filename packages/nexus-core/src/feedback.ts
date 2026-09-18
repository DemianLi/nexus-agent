/**
 * 人對這個會話的回饋：評分（綁在**一則回覆**上）與 `/feedback` 的一則評語。
 *
 * 形狀照 dsh 的兩個套件（`references/deepseek-harness`，SHA `c291e79`）：評分是
 * `packages/feedback/message-feedback/src/types.ts`，評語與分類是
 * `packages/feedback/command-feedback/src/types.ts`。規則（樂觀鎖、內容一樣就不記、備註上限）
 * 住在 `@nexus/plugin-feedback`，這裡只放兩邊都要讀的詞彙。決議見
 * [#267](https://github.com/DemianLi/nexus-agent/issues/267)，落地是
 * [#278](https://github.com/DemianLi/nexus-agent/issues/278)。
 *
 * ## 目標是回覆自己的 id，同 dsh
 *
 * `messageId` 是 root 日誌裡那顆 `assistant/message` 記的訊息 id（`message.data.id`），dsh 的檢查
 * 也是這一條（`message-feedback/src/index.ts` 的 `deriveEventMessage(event)?.id === messageId`，
 * `ddefc45`）。即時畫面那一側拿得到同一個值：串流 `message-start` 的 `id` 就是日誌記下的那個——
 * 供應商給了 id 就是它，沒給的話串流層補 `run-<runId>` 並寫回訊息，而且補在日誌記下之前
 * （[#382](https://github.com/DemianLi/nexus-agent/issues/382) 的量測；絆索在
 * `apps/harness/src/feedback-wire.test.ts`）。
 *
 * **只有記了 id 的回覆評得到。** 沒記 id 的不是目標，畫面上也不長按鈕：被停下來的那半段（pump 新建的一則），
 * 以及不走 v3 串流、供應商又沒給 id 的那幾則（CLI 跑假模型時就是這樣；CLI 接真的供應商實測有
 * `chatcmpl-…`）。
 *
 * **格式 10 以前以輪記的評分照舊讀得到**（[#278](https://github.com/DemianLi/nexus-agent/issues/278)
 * 那時我們的日誌還不記回覆）：日誌只增不改，讀的時候把它對到那一輪最後一則有文字的回覆，見
 * {@link currentMessageFeedback}。
 *
 * ## 對 dsh 的偏離
 *
 * - **沒有 `sessionId`**：dsh 帶它是因為分叉出來的會話會繼承父會話的回饋。我們不分叉，一份日誌
 *   就是一個會話。
 */

import type { LoggedMessage } from './logged-message.js';
import type { SessionEvent, SessionLog } from './session-log.js';

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

/** 對一則回覆的整體判斷。 */
export type MessageFeedbackRating = 'positive' | 'negative';

/** 一則回覆目前的評分與它的樂觀鎖版本。 */
export interface MessageFeedbackItem {
  /** 被評的那則回覆：root 日誌裡那顆 `assistant/message` 記的訊息 id。 */
  readonly messageId: string;
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

/**
 * 格式 10 以前記的評分：目標是**輪**——起頭那顆 `turn/start` 的 `seq`。只會從舊日誌讀到，不會再寫。
 */
export interface LegacyTurnFeedbackItem extends Omit<MessageFeedbackItem, 'messageId'> {
  readonly turn: number;
}

/** `feedback/message-put` 的酬載：修改之後的完整值（含原本的建立時間）。舊日誌裡是以輪記的那一種。 */
export interface MessageFeedbackPut {
  readonly item: MessageFeedbackItem | LegacyTurnFeedbackItem;
}

/** `feedback/message-delete` 的酬載：哪一則回覆的評分被收回了。舊日誌裡指名的是輪。 */
export type MessageFeedbackDelete = { readonly messageId: string } | { readonly turn: number };

/** 新建或換掉一則回覆的評分。 */
export interface MessageFeedbackPutRequest {
  readonly messageId: string;
  readonly rating: MessageFeedbackRating;
  /** 選填、不能全是空白。 */
  readonly note?: string;
  /** 省略即不分類。 */
  readonly category?: FeedbackCategory;
  /** 看到的版本；`null` 表示要求目前沒有評分。 */
  readonly ifVersion: string | null;
}

/** 收回一則回覆的評分。 */
export interface MessageFeedbackDeleteRequest {
  readonly messageId: string;
  /** 看到的版本；目前本來就沒有評分時不看。 */
  readonly ifVersion: string;
}

/** 那則回覆指不到：這份日誌裡沒有一顆 `assistant/message` 記著這個 id。 */
export interface MessageFeedbackTargetNotFound {
  readonly code: 'target-not-found';
  readonly messageId: string;
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

/** `list` 的結果：目前的評分，依第一次評的先後。 */
export type MessageFeedbackListResult = FeedbackSuccess<{
  readonly items: readonly MessageFeedbackItem[];
}>;

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
   * 新建或換掉一則回覆的評分。內容一樣就不記、版本不換。
   * @param log - 會話 root 的那一份日誌。
   * @param request - 目標、想要的值與看到的版本。
   * @returns 目前那一筆，或一個業務碼。
   */
  put(log: SessionLog, request: MessageFeedbackPutRequest): MessageFeedbackPutResult;
  /**
   * 收回一則回覆的評分。本來就沒有也成功，而且不記。
   * @param log - 會話 root 的那一份日誌。
   * @param request - 目標與看到的版本。
   * @returns 「現在沒有了」，或版本衝突。
   */
  delete(log: SessionLog, request: MessageFeedbackDeleteRequest): MessageFeedbackDeleteResult;
  /**
   * 讀回目前的評分，照 dsh 的 `list`：web 靠它在重新整理之後把讚／踩畫回來。舊日誌裡以輪記、對不到
   * 回覆的那幾筆不在裡面（沒有畫面上的東西可以掛）。
   * @param log - 會話 root 的那一份日誌。
   * @returns 目前的評分。
   */
  list(log: SessionLog): MessageFeedbackListResult;
  /**
   * 記一則對整個會話的評語。文字去掉前後空白，空的就當沒有。
   * @param log - 會話 root 的那一份日誌。
   * @param entry - 文字與分類，都可以省略。
   * @returns 記下了。
   */
  record(log: SessionLog, entry: FeedbackRecord): FeedbackRecordResult;
}

/** 一則訊息的文字：字串照原樣，區塊只取 `text` 那幾塊。 */
function hasText(message: LoggedMessage): boolean {
  const content: unknown = message.data.content;
  if (typeof content === 'string') return content !== '';
  if (!Array.isArray(content)) return false;
  return content.some((block: unknown) => {
    const typed = block as { type?: unknown; text?: unknown } | null;
    return typed?.type === 'text' && typeof typed.text === 'string' && typed.text !== '';
  });
}

/** 一顆 `assistant/message` 記的訊息 id；沒記的是 `undefined`。 */
export function loggedMessageId(message: LoggedMessage): string | undefined {
  const id: unknown = message.data.id;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/** 一則被評的回覆目前的評分，連同它所屬的那一輪。 */
export interface CurrentMessageFeedback {
  /**
   * 目前那一筆。舊日誌裡以輪記、而那一輪對得到回覆的，已經換成那則回覆的 id；對不到的
   * （例如格式 9 以前根本沒記回覆）原樣是 {@link LegacyTurnFeedbackItem}。
   */
  readonly item: MessageFeedbackItem | LegacyTurnFeedbackItem;
  /** 它所屬那一輪起頭那顆 `turn/start` 的 `seq`（往回找第一顆不是 `resume` 的）。 */
  readonly turn: number;
}

/**
 * 從日誌折出目前的評分：後寫覆蓋先寫，收回的就刪。同 dsh 的 `currentItems`，順序是第一次評的先後。
 *
 * **兩種格式混著讀**：格式 10 以前以輪記的那幾顆，對到那一輪**最後一則有文字、有 id** 的
 * `assistant/message`（那時的按鈕就放在那一則上），之後同一則回覆的新評分照常覆蓋它。對不到的照輪留著，
 * 只有按輪統計的讀方（離線掃描）用得到。
 *
 * @param events - root 那一份日誌的全部事件。
 * @returns 目前每一則回覆（或對不到回覆的舊的一輪）的評分。
 */
export function currentMessageFeedback(
  events: readonly SessionEvent[],
): readonly CurrentMessageFeedback[] {
  /** 訊息 id → 它所屬那一輪。 */
  const turnOfMessage = new Map<string, number>();
  /** 輪 → 那一輪到目前為止最後一則有文字、有 id 的回覆。 */
  const tailOfTurn = new Map<number, string>();
  let origin: number | undefined;
  for (const event of events) {
    if (event.type === 'turn/start' && event.data.kind !== 'resume') origin = event.seq;
    if (event.type !== 'assistant/message' || origin === undefined) continue;
    const id = loggedMessageId(event.data.message);
    if (id === undefined) continue;
    turnOfMessage.set(id, origin);
    if (hasText(event.data.message)) tailOfTurn.set(origin, id);
  }

  const current = new Map<string, CurrentMessageFeedback>();
  const keyOf = (target: { readonly messageId: string } | { readonly turn: number }): string => {
    if ('messageId' in target) return `message:${target.messageId}`;
    const tail = tailOfTurn.get(target.turn);
    return tail === undefined ? `turn:${String(target.turn)}` : `message:${tail}`;
  };
  for (const event of events) {
    if (event.type === 'feedback/message-put') {
      const stored = event.data.item;
      const key = keyOf(stored);
      if ('messageId' in stored) {
        const turn = turnOfMessage.get(stored.messageId);
        if (turn !== undefined) current.set(key, { item: stored, turn });
        continue;
      }
      const tail = tailOfTurn.get(stored.turn);
      if (tail === undefined) {
        current.set(key, { item: stored, turn: stored.turn });
        continue;
      }
      const { turn, ...rest } = stored;
      current.set(key, { item: { ...rest, messageId: tail }, turn });
    } else if (event.type === 'feedback/message-delete') {
      current.delete(keyOf(event.data));
    }
  }
  return [...current.values()];
}
