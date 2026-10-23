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
 *
 * ## 落盤確認與重放驗證（[#1606](https://github.com/DemianLi/nexus-agent/issues/1606)，照 dsh `687f282e`）
 *
 * - **評分寫進去、落了盤才回答**：put／delete 在同步段裡讀、比、append，之後 `await` 宿主提供的 `sessionDurability`
 *   （`@nexus/session`）。它排空、讀回、比對，失敗就拋，呼叫端拿到的是錯誤，不是假的成功（dsh `:238-258`）。內容一樣的
 *   put 與收回不存在的 delete 不記事件，但照樣確認一次（dsh `:183`、`:214`）。
 * - **評語（`record`、`/feedback`）不等落盤**，照 dsh `command-feedback/src/index.ts:4-7`：「eager but unflushed」，回答的是記進日誌了，
 *   不是到了磁碟。
 * - **沒掛落盤時評分不在、評語照常**（#1606 題 2 (a)）：dsh 的 `messageFeedback` inject `sessionPersistence`（`:119`），沒掛落盤它就不在；
 *   `sessionFeedback` 與 `/feedback` 只要 `sessions`／`commands`，照常。我們把兩個服務併成一個（`@nexus/feedback` 檔頭的偏離），所以
 *   `sessionDurability` 是**選配**、**每次呼叫當下才讀**：沒有它時 list／put／delete 拋 `FeedbackDurabilityUnavailableError`（wire 回
 *   `not_supported`），record 與 `/feedback` 照常。經這一列的 `ctx` 用 `optionalService` 讀（不 `inject`，dsh `packages/AGENTS.md:6`）；
 *   列卸載之後宿主手上的快照照樣讀得到（見下面「形狀」，測試「這一列卸載之後」釘住）。
 * - **讀到的評分事件先驗再折**（dsh `:62-73`、`:96-115`）：結構不對就拋 `FeedbackLogCorruptionError`，不折進畫面。
 *   schema 不含 `sessionId`（「沒有 sessionId」的偏離見 `@nexus/core` 的 `feedback.ts`）；格式 10 以前以輪記的那一種
 *   （`turn` 取代 `messageId`）照同一套規則驗。
 * - **dsh 有、這裡不做的三條**（nexus 沒有對應的失敗，不算偏離）：
 *   - 逐會話的 promise 鏈（dsh `:300-310`）：讀、比版本、append 都在同一個同步段，await 排在 append 之後，兩個並發的 put
 *     交錯不了。`feedback-durability.test.ts` 的驗收 D 釘住這個前提。
 *   - 拆卸閘（dsh `:142-147`）：宿主拿的是服務快照，列卸載之後照樣能叫（`@nexus/feedback` 檔頭的「宿主取的是快照」），沒有要關的把手。
 *   - 冷會話那一支（dsh `:261-283`）：wire 一律在活的 thread 上操作。
 * - **沒有 `session-not-found`**：規則拿到的一定是一份活的日誌；「這條 thread 不存在」由 wire 那一
 *   側回。
 * - **兩顆套件併成一顆、兩個服務併成一個**（#1456 Q3 (a)，類別：遷移卡不改行為（暫時））：dsh 的
 *   `message-feedback` 與 `command-feedback` 是兩顆套件、兩個服務（`messageFeedback`、`sessionFeedback`）。這裡一顆套件，
 *   `record` 是 `FeedbackService` 的第四個方法。理由與撤除條件見 `@nexus/feedback` 的檔頭。
 *
 * 見 [#278](https://github.com/DemianLi/nexus-agent/issues/278)。
 *
 * ## 形狀（#1456：第五顆搬上 Cordis 樹的插件，第一顆 `provides` 非空的）
 *
 * 函式插件，具名匯出 `name`／`inject`／`Config`／`manifest`／`apply`，**沒有 default**。相依只有 `@nexus/sdk`、
 * `@nexus/commands`（命令的登記）、`@nexus/feedback`（服務的定義）與 `@nexus/session`（日誌的讀法與型別）：**沒有一行
 * import `@nexus/core`**（決議 §3-4 第 17 條；#1420 的 lint 規則擋它）。
 *
 * - **提供一個服務**：`apply` 裡 `new` 一個繼承 `ContractService` 的類別，建構時 `provide`。用 `new` 不用 `ctx.plugin(Class)`
 *   （後者開子 fiber）；歸屬（`.provider`）是這一列的 id，宿主據此只把服務折給 active 的這一列。
 * - **消費一個接縫**：`commands`，經 `inject` 宣告（`^1.0.0`），登記是 effect，這一列卸載時登記處自己撤掉。
 * - 服務的方法**一律不碰 `this.ctx`**（設定在建構時進閉包、日誌由呼叫端傳進來），所以列卸載之後宿主手上那份快照仍能呼叫。
 *
 * 舊的 `NexusPlugin` 外殼（`feedbackPlugin`、`createFeedbackPlugin`）不在這裡：它是測試夾具，住在 `apps/harness` 的
 * `feedback.fixture.ts`。
 *
 * @module
 */

import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';

import { commandsToken } from '@nexus/commands';
import {
  currentMessageFeedback,
  FEEDBACK_CATEGORIES,
  FeedbackDurabilityUnavailableError,
  FeedbackLogCorruptionError,
  feedbackToken,
} from '@nexus/feedback';
import type {
  FeedbackRecord,
  FeedbackService,
  MessageFeedbackDeleteRequest,
  MessageFeedbackDeleteResult,
  MessageFeedbackItem,
  MessageFeedbackListResult,
  MessageFeedbackPutRequest,
  MessageFeedbackPutResult,
} from '@nexus/feedback';
import type { Context } from '@nexus/cordis';
import {
  ContractService,
  defineManifest,
  injectOf,
  need,
  optionalService,
  service,
} from '@nexus/sdk';
import { loggedMessageId, sessionDurabilityToken } from '@nexus/session';
import type { SessionDurabilityService, SessionEvent, SessionLog } from '@nexus/session';
import { z } from 'zod';

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
 * {@link createFeedbackService} 收的東西。
 *
 * **服務那一支自己留著執行期檢查**：它是一支獨立的 API，走得到的路不只有 plugin 這一條
 * （`apps/harness` 有測試直接叫它），而 schema 只守 plugin 那條路。
 */
export type FeedbackPluginOptions = z.input<typeof feedbackConfigSchema>;

/** 時間戳：非負的安全整數（dsh `:62`）。 */
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** 一筆評分的共同欄位，照 dsh `:63-71` 的 `itemSchema`，目標那一格另外接。 */
const itemFields = {
  rating: z.enum(['positive', 'negative']),
  note: z
    .string()
    .refine((note) => note.trim().length > 0)
    .optional(),
  category: z.enum(FEEDBACK_CATEGORIES).optional(),
  version: z.uuid(),
  createdAt: timestamp,
  updatedAt: timestamp,
};

/** 評分事件的酬載。目標是一則回覆（dsh 的形狀），或格式 10 以前的一輪。 */
const putSchema = z.object({
  item: z
    .union([
      z.object({ messageId: z.string().min(1), ...itemFields }),
      z.object({ turn: z.number().int().nonnegative(), ...itemFields }),
    ])
    .refine((item) => item.updatedAt >= item.createdAt),
});

/** 收回事件的酬載，照 dsh `:73`；舊日誌指名的是輪。 */
const deleteSchema = z.union([
  z.object({ messageId: z.string().min(1) }),
  z.object({ turn: z.number().int().nonnegative() }),
]);

/**
 * 先驗日誌裡每一顆評分事件的結構，照 dsh `currentItems` 的逐顆 `parse`（`:96-115`）。
 *
 * @throws {FeedbackLogCorruptionError} 任何一顆不合，訊息指名哪一顆。
 */
function assertFeedbackEvents(events: readonly SessionEvent[]): void {
  for (const event of events) {
    const schema =
      event.type === 'feedback/message-put'
        ? putSchema
        : event.type === 'feedback/message-delete'
          ? deleteSchema
          : undefined;
    if (schema === undefined) continue;
    const parsed = schema.safeParse(event.data);
    if (!parsed.success) {
      throw new FeedbackLogCorruptionError(
        `第 ${String(event.seq)} 顆 ${event.type} 的內容不合規則：${parsed.error.message}`,
      );
    }
  }
}

/**
 * 從日誌折出每一則回覆目前的評分，同 dsh 的 `currentItems`：**先驗再折**，壞的就拋。舊日誌裡以輪記、對不到回覆的那幾筆
 * 不在裡面：它們沒有訊息 id 可以指名，這裡的操作也就碰不到它們。
 *
 * 繼承來的前綴裡的評分不算（#1579，偏離見 core 的 `currentMessageFeedback`）；驗證照樣驗整份，同 dsh 先 `parse` 再看是誰的。
 *
 * @param events - 一份日誌的全部事件。
 * @param inheritedEventCount - 切點（`SessionLog.inheritedEventCount`）。省略即 0。
 * @returns 訊息 id → 目前那一筆，依第一次評的先後。
 * @throws {FeedbackLogCorruptionError} 有一顆評分事件結構不對。
 */
export function currentFeedbackItems(
  events: readonly SessionEvent[],
  inheritedEventCount = 0,
): ReadonlyMap<string, MessageFeedbackItem> {
  assertFeedbackEvents(events);
  const items = new Map<string, MessageFeedbackItem>();
  for (const { item } of currentMessageFeedback(events, inheritedEventCount)) {
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
      event.type === 'assistant/message' &&
      // 講到一半被停下來的那則不是評分的目標，它帶的 id 只用來對補送與歷史（#1044）。
      event.data.interrupted !== true &&
      loggedMessageId(event.data.message) === messageId,
  );
}

/**
 * 建評分與評語的規則。
 *
 * @param options - 備註上限。
 * @param durability - 每次呼叫當下取落盤確認；`undefined` 就是這個組裝沒掛落盤，評分那三個方法拋
 *   `FeedbackDurabilityUnavailableError`。見檔頭。
 * @returns 提供成 `messageFeedback` 服務的那個。
 * @throws `maxNoteBytes` 不是正的安全整數。
 */
export function createFeedbackService(
  options: FeedbackConfig,
  durability: () => SessionDurabilityService | undefined,
): FeedbackService {
  const { maxNoteBytes } = options;
  if (!Number.isSafeInteger(maxNoteBytes) || maxNoteBytes < 1) {
    throw new TypeError(`回饋的 maxNoteBytes 要是正的安全整數，拿到的是 ${String(maxNoteBytes)}。`);
  }
  /** 評分那三個方法的第一步：沒掛落盤，同 dsh 的 `messageFeedback` 根本不在。 */
  const durable = (): SessionDurabilityService => {
    const found = durability();
    if (found === undefined) throw new FeedbackDurabilityUnavailableError();
    return found;
  };

  return {
    // 讀、比、append 都在第一個 await 之前（同步段），理由見檔頭「dsh 有、這裡不做的三條」。
    async put(
      log: SessionLog,
      request: MessageFeedbackPutRequest,
    ): Promise<MessageFeedbackPutResult> {
      const checkpoint = durable();
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
      const existing = currentFeedbackItems(events, log.inheritedEventCount).get(request.messageId);
      if (request.ifVersion !== (existing?.version ?? null)) {
        return { ok: false, error: { code: 'version-conflict', current: existing ?? null } };
      }
      if (
        existing !== undefined &&
        existing.rating === request.rating &&
        existing.note === note &&
        existing.category === request.category
      ) {
        // 不記事件，但照樣確認一次（dsh `:183`）。
        await checkpoint.checkpoint(log);
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
      await checkpoint.checkpoint(log);
      return { ok: true, value: item };
    },

    async delete(
      log: SessionLog,
      request: MessageFeedbackDeleteRequest,
    ): Promise<MessageFeedbackDeleteResult> {
      const checkpoint = durable();
      const existing = currentFeedbackItems(log.events, log.inheritedEventCount).get(
        request.messageId,
      );
      if (existing !== undefined) {
        if (request.ifVersion !== existing.version) {
          return { ok: false, error: { code: 'version-conflict', current: existing } };
        }
        log.append('feedback/message-delete', { messageId: request.messageId });
      }
      // 收回不存在的不記事件，但照樣確認一次（dsh `:214`）。
      await checkpoint.checkpoint(log);
      return { ok: true, value: { absent: true } };
    },

    // async：驗不過的拋錯走 rejection，不在呼叫當下同步拋。
    async list(log: SessionLog): Promise<MessageFeedbackListResult> {
      durable();
      return {
        ok: true,
        value: {
          items: [...currentFeedbackItems(log.events, log.inheritedEventCount).values()],
        },
      };
    },

    // 不等落盤，照 dsh（見檔頭）。
    async record(log: SessionLog, entry: FeedbackRecord) {
      const text = entry.text?.trim() ?? '';
      log.append('feedback/record', {
        ...(text.length === 0 ? {} : { text }),
        ...(entry.category === undefined ? {} : { category: entry.category }),
      });
      return { ok: true as const, value: { recorded: true as const } };
    },
  };
}

/** 插件在樹上的列用的名字（`ctx.fiber.runtime.name`，錯誤訊息、log 與相容層清單用）。 */
export const name = 'feedback';

/**
 * 要的服務：`commands`，契約 `^1.0.0`。範圍在這裡宣告，落進 Cordis 的 `Context.intercept`，提供者的 `check` 讀得到。
 * `sessionDurability` 是選配，不放進 `inject`（dsh `packages/AGENTS.md:6`），每次呼叫當下才讀，見檔頭。
 */
export const inject = injectOf(need(commandsToken, '^1.0.0'));

/** 設定的 schema，與 {@link manifest}.config 是同一個物件（一致性套件比對）。 */
export const Config = feedbackConfigSchema;

export const manifest = defineManifest({
  id: 'feedback',
  version: '0.1.0',
  owner: '平台團隊',
  provides: [{ token: feedbackToken.name, version: feedbackToken.version }],
  consumes: [
    { token: commandsToken.name, range: '^1.0.0' },
    { token: sessionDurabilityToken.name, range: '^1.0.0', optional: true },
  ],
  config: feedbackConfigSchema,
  // 換程式碼要重啟行程；設定一改，下一條 thread 看到新的上限，開著的不動（#1405、決議 §3-2 第 6 條）。
  reload: { code: 'restart', config: 'next-thread' },
  capabilities: [],
});

/**
 * `messageFeedback` 服務的實作：把 {@link createFeedbackService} 的規則掛成一個契約服務。
 *
 * 四個方法是**自己的屬性、閉包住規則**，不是原型上的方法，也不用 `#私有欄位`：宿主取到的是 traceable proxy，方法在
 * proxy 的 shadow 上執行，私有欄位在那個 receiver 上會拋。方法體一律不碰 `this.ctx`（見檔頭）。
 */
class MessageFeedbackService extends ContractService<FeedbackService> implements FeedbackService {
  readonly put: FeedbackService['put'];
  readonly delete: FeedbackService['delete'];
  readonly list: FeedbackService['list'];
  readonly record: FeedbackService['record'];

  constructor(ctx: Context, rules: FeedbackService) {
    super(ctx, feedbackToken);
    this.put = (log, request) => rules.put(log, request);
    this.delete = (log, request) => rules.delete(log, request);
    this.list = (log) => rules.list(log);
    this.record = (log, entry) => rules.record(log, entry);
  }
}

/**
 * 掛上評分規則與 `/feedback`。
 *
 * `/feedback` 寫的是**命令執行器交給 handler 的那一份日誌**（`CommandInvocation.sessionLog`，
 * root 那一份）：照 dsh 的 `/feedback` 直接讀 invocation 上的目標，這個 plugin 因此不必當 sessions
 * 參與者、也不必自己追「接了幾份」（[#688](https://github.com/DemianLi/nexus-agent/issues/688)）。
 *
 * **每次掛載才有的狀態一律活在這裡**：設定是這一次掛載的，規則（含備註上限）建在 `apply` 裡，兩列各掛一次各算各的上限。
 *
 * **單一佔位，重名當場拋**（[#477](https://github.com/DemianLi/nexus-agent/issues/477)）：同名服務由 Cordis 在
 * `provide` 當場拋（`service "messageFeedback" has been registered at …`），後掛的那一列掉在 `apply`。兩份規則就是兩種
 * 「內容一樣算不算一次」的答案。
 *
 * @param ctx - 這一列的 Cordis context。
 * @param config - 驗過的設定。
 */
export function apply(ctx: Context, config: FeedbackConfig): void {
  // 落盤確認每次呼叫當下才讀（見檔頭）。
  const rules = createFeedbackService(config, () => optionalService(ctx, sessionDurabilityToken));
  // 用 `new` 不用 `ctx.plugin(Class)`：不開子 fiber，歸屬就是這一列。建構子 `provide` 是 effect，列卸載時服務跟著撤。
  new MessageFeedbackService(ctx, rules);
  service(ctx, commandsToken).register({
    name: FEEDBACK_COMMAND_NAME,
    description: '記下對這個會話的回饋',
    input: { hint: '<內容>' },
    // 那段文字由 `feedback/record` 帶著，`command/run` 不再記一次（照 dsh）。
    recordInput: false,
    handler: async ({ rawInput, sessionLog }) => {
      if (rawInput.trim().length === 0) return { kind: 'error', text: FEEDBACK_USAGE };
      await rules.record(sessionLog, { text: rawInput });
      return { kind: 'success', text: `已記下對這個會話的回饋（${sessionLog.sessionId}）。` };
    },
  });
}
