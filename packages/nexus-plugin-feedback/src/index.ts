/**
 * 評分與 `/feedback`：人事後對這個會話的看法，**只進日誌、不進模型**。
 *
 * 規則照 dsh 的兩個套件（`references/deepseek-harness`，SHA `c291e79`）：
 *
 * - 評分：`packages/feedback/message-feedback/src/index.ts`——樂觀鎖（新建要 `ifVersion: null`、
 *   修改要帶目前的版本）、內容一樣就不記也不換版本、收回不存在的成功但不記、備註不能全是空白
 *   而且有位元組上限、先驗備註再驗目標再驗版本。
 * - 評語：`packages/feedback/command-feedback/src/index.ts`——`/feedback <文字>` 記一顆
 *   `feedback/record`，空字串回用法說明，`recordInput: false`。
 *
 * 評分的目標是一則回覆的訊息 id，同 dsh；格式 10 以前以輪記的怎麼讀、其他偏離見 `@nexus/core` 的
 * `feedback.ts`。這裡的偏離：
 *
 * - **回覆拿掉「Anonymous user」那一行**：我們沒有匿名使用者 id（遙測的偏離二），印一個編出來的
 *   id 就是說假話。
 * - **沒有 dsh 的非同步寫入權（`enqueue`）**：我們的日誌是同步寫的，見 `FeedbackService`。
 * - **沒有 `session-not-found`**：規則拿到的一定是一份活的日誌；「這條 thread 不存在」由 wire 那一
 *   側回。
 *
 * 見 [#278](https://github.com/DemianLi/nexus-agent/issues/278)。
 *
 * @module
 */

import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { currentMessageFeedback, loggedMessageId } from '@nexus/core';
import { z } from 'zod';
import type {
  FeedbackRecord,
  FeedbackService,
  MessageFeedbackDeleteRequest,
  MessageFeedbackDeleteResult,
  MessageFeedbackItem,
  MessageFeedbackListResult,
  MessageFeedbackPutRequest,
  MessageFeedbackPutResult,
  NexusPlugin,
  PluginEntry,
  SessionEvent,
  SessionLog,
} from '@nexus/core';

/** `/feedback` 的命令名。 */
export const FEEDBACK_COMMAND_NAME = 'feedback';

/** 沒寫內容時的用法說明。dsh 的 `Usage: /feedback <text>` 翻過來。 */
export const FEEDBACK_USAGE = '要寫下回饋的內容。用法：/feedback <內容>';

/** 這個 plugin 的設定。 */
export const feedbackConfigSchema = z.strictObject({
  /**
   * 一則備註最多幾個 UTF-8 位元組。**必填、沒有預設值**，照 dsh（`Config.maxNoteBytes` 是
   * `required()`）：這是部署方的選擇，由組裝點給。
   */
  maxNoteBytes: z.number().int().positive(),
});

/** 驗過的設定。 */
export type FeedbackConfig = z.infer<typeof feedbackConfigSchema>;

/**
 * 工廠與 {@link createFeedbackService} 收的東西。
 *
 * **服務那一支自己留著執行期檢查**：它是一支獨立的 API，走得到的路不只有 plugin 這一條
 * （`apps/harness` 有測試直接叫它），而 schema 只守 plugin 那條路。
 */
export type FeedbackPluginOptions = z.input<typeof feedbackConfigSchema>;

/**
 * 從日誌折出每一則回覆目前的評分，同 dsh 的 `currentItems`。舊日誌裡以輪記、對不到回覆的那幾筆不在裡面：
 * 它們沒有訊息 id 可以指名，這裡的操作也就碰不到它們。
 *
 * @param events - 一份日誌的全部事件。
 * @returns 訊息 id → 目前那一筆，依第一次評的先後。
 */
export function currentFeedbackItems(
  events: readonly SessionEvent[],
): ReadonlyMap<string, MessageFeedbackItem> {
  const items = new Map<string, MessageFeedbackItem>();
  for (const { item } of currentMessageFeedback(events)) {
    if ('messageId' in item) items.set(item.messageId, item);
  }
  return items;
}

/**
 * 這份日誌裡有沒有一顆 `assistant/message` 記著這個訊息 id。同 dsh 的「目標必須是一則附加上去的
 * assistant 訊息」。人打的那一則、子代理的回覆（在它自己那一份日誌）、不存在的 id 都不是。
 */
function isAssistantMessage(events: readonly SessionEvent[], messageId: string): boolean {
  return events.some(
    (event) =>
      event.type === 'assistant/message' && loggedMessageId(event.data.message) === messageId,
  );
}

/**
 * 建評分與評語的規則。
 *
 * @param options - 備註上限。
 * @returns 掛到 `registry.feedback` 上的那個。
 * @throws `maxNoteBytes` 不是正的安全整數。
 */
export function createFeedbackService(options: FeedbackConfig): FeedbackService {
  const { maxNoteBytes } = options;
  if (!Number.isSafeInteger(maxNoteBytes) || maxNoteBytes < 1) {
    throw new TypeError(`回饋的 maxNoteBytes 要是正的安全整數，拿到的是 ${String(maxNoteBytes)}。`);
  }

  return {
    put(log: SessionLog, request: MessageFeedbackPutRequest): MessageFeedbackPutResult {
      const { note } = request;
      if (note !== undefined) {
        if (note.trim().length === 0) return { ok: false, error: { code: 'note-blank' } };
        const actualBytes = Buffer.byteLength(note, 'utf8');
        if (actualBytes > maxNoteBytes) {
          return {
            ok: false,
            error: { code: 'note-too-large', maxBytes: maxNoteBytes, actualBytes },
          };
        }
      }
      const events = log.events;
      if (!isAssistantMessage(events, request.messageId)) {
        return { ok: false, error: { code: 'target-not-found', messageId: request.messageId } };
      }
      const existing = currentFeedbackItems(events).get(request.messageId);
      if (request.ifVersion !== (existing?.version ?? null)) {
        return { ok: false, error: { code: 'version-conflict', current: existing ?? null } };
      }
      if (
        existing !== undefined &&
        existing.rating === request.rating &&
        existing.note === note &&
        existing.category === request.category
      ) {
        return { ok: true, value: existing };
      }
      const now = Date.now();
      const item: MessageFeedbackItem = {
        messageId: request.messageId,
        rating: request.rating,
        ...(note === undefined ? {} : { note }),
        ...(request.category === undefined ? {} : { category: request.category }),
        version: randomUUID(),
        createdAt: existing?.createdAt ?? now,
        updatedAt: existing === undefined ? now : Math.max(now, existing.updatedAt),
      };
      log.append('feedback/message-put', { item });
      return { ok: true, value: item };
    },

    delete(log: SessionLog, request: MessageFeedbackDeleteRequest): MessageFeedbackDeleteResult {
      const existing = currentFeedbackItems(log.events).get(request.messageId);
      if (existing !== undefined) {
        if (request.ifVersion !== existing.version) {
          return { ok: false, error: { code: 'version-conflict', current: existing } };
        }
        log.append('feedback/message-delete', { messageId: request.messageId });
      }
      return { ok: true, value: { absent: true } };
    },

    list(log: SessionLog): MessageFeedbackListResult {
      return { ok: true, value: { items: [...currentFeedbackItems(log.events).values()] } };
    },

    record(log: SessionLog, entry: FeedbackRecord) {
      const text = entry.text?.trim() ?? '';
      log.append('feedback/record', {
        ...(text.length === 0 ? {} : { text }),
        ...(entry.category === undefined ? {} : { category: entry.category }),
      });
      return { ok: true, value: { recorded: true } };
    },
  };
}

/**
 * 掛上評分規則與 `/feedback`。
 *
 * `/feedback` 寫的是**這次組裝接上的 root 那一份日誌**：同 `@nexus/plugin-goal` 的命令，只接
 * root、subagent 那些一份都不接；接到的不是剛好一份時當場回一句錯誤，不猜。
 *
 */
export const feedbackPlugin: NexusPlugin<FeedbackConfig> = {
  name: 'feedback',
  Config: feedbackConfigSchema,
  apply(registry, config: FeedbackConfig) {
    // **服務建在 `apply` 裡，不在模組層級**：設定是這一次掛載的，而 `serve.ts` 每個
    // thread 組裝一次。共用一份的話兩邊會用同一個上限，而且誰都改不動。
    const service = createFeedbackService(config);
    registry.feedback.use(service);
    const rootsHere: SessionLog[] = [];
    registry.sessions.join((subject) => {
      if (subject.address.kind !== 'root') return undefined;
      rootsHere.push(subject.log);
      return () => {
        const at = rootsHere.indexOf(subject.log);
        if (at >= 0) rootsHere.splice(at, 1);
      };
    });
    registry.commands.register({
      name: FEEDBACK_COMMAND_NAME,
      description: '記下對這個會話的回饋',
      input: { hint: '<內容>' },
      // 那段文字由 `feedback/record` 帶著，`command/run` 不再記一次（照 dsh）。
      recordInput: false,
      handler: ({ rawInput }) => {
        if (rawInput.trim().length === 0) return { kind: 'error', text: FEEDBACK_USAGE };
        const [log, ...others] = rootsHere;
        if (log === undefined || others.length > 0) {
          return {
            kind: 'error',
            text: `這次組裝接著 ${String(rootsHere.length)} 份會話日誌，挑不出要記在哪一份。`,
          };
        }
        service.record(log, { text: rawInput });
        return { kind: 'success', text: `已記下對這個會話的回饋（${log.sessionId}）。` };
      },
    });
  },
};

export default feedbackPlugin;

/**
 * 建一個條目。**薄薄一層**：設定不在這裡驗，驗在載入的時候——那時候才有 id 可以指名。
 *
 * @param options - 設定，形狀見 {@link feedbackConfigSchema}。
 * @returns 可以放進組裝點清單的條目。
 */
export function createFeedbackPlugin(options: FeedbackPluginOptions): PluginEntry {
  return { plugin: feedbackPlugin, config: options };
}
