/**
 * 送出佇列：人送出、還沒送進模型的那幾句（[#637](https://github.com/DemianLi/nexus-agent/issues/637)、
 * [#710](https://github.com/DemianLi/nexus-agent/issues/710)）。
 *
 * 照 dsh 的收件匣（`packages/core/agent-loop/src/inbox.ts`，`477b4f4`）：**狀態不另外存，由日誌上一顆顆
 * `inbox/spliced` 折出來**。每一次變動（送進來、領走、改、刪）落一顆，折疊就是對那一條清單做陣列的 `splice`。
 *
 * 兩條清單，同 dsh：
 *
 * - `next-turn`：排著等開新一輪的。一輪開始時領第一件。
 * - `next-step`：插話（steer）。跑著的那一輪每次叫模型之前領走整條，送進模型；這一輪不停。
 *
 * 變動的形狀：
 *
 * - 送進來：`inserted` 非空。
 * - 領走（一輪開始領 `next-turn` 第一件、一步之前領整條 `next-step`）：`removedCount` 非零，不帶 `outcome`。
 * - 刪：`removedCount: 1` 加 `outcome: 'canceled'`。
 * - 改：同一顆裡 `removedCount: 1` 加 `inserted: [新的]`，帶 `outcome: 'canceled'`，id 不變。
 * - 排著的一件改成插話：從 `next-turn` 拿掉（帶 `outcome: 'canceled'`）、接到 `next-step` 尾巴，兩顆。
 *
 * **id 在兩條清單之間唯一**，同 dsh 的折疊：一件只會在其中一條。
 *
 * 寫的人只有 web 的 pump（`apps/harness/src/thread-pump.ts`）：CLI 的 REPL 一行一輪，沒有排隊也沒有插話。
 *
 * @module
 */

/**
 * 收件匣的哪一條清單，同 dsh 的 `InboxTarget`。格式 20 以前的日誌只有 `next-turn`（見 `session-store.ts`）。
 */
export type InboxTarget = 'next-turn' | 'next-step';

/**
 * 一件排著的輸入是誰送的。dsh 分人（`{kind:'user'}`）與目標續行（`{kind:'goal', …}`）；**這一版只有人**，
 * 續行走佇列是 [#638](https://github.com/DemianLi/nexus-agent/issues/638)。開跑時 `turn/start` 的 `kind` 由它決定。
 */
export type QueuedInputSource = { readonly kind: 'user' };

/**
 * 排著的一件。
 *
 * **對 dsh 的偏離**：dsh 的 `UserMessage.content` 收圖片與檔案，我們的 `run.start` 只收文字，所以這裡是 `text`。
 */
export interface QueuedInput {
  /** 就是 `run.start` 回給呼叫端的 `run_id`。改過之後不變。 */
  readonly id: string;
  readonly text: string;
  readonly source: QueuedInputSource;
}

/** 一次變動。形狀照 dsh 的 `agent/inbox/spliced`。 */
export interface InboxSplice {
  readonly target: InboxTarget;
  /** 從哪一格開始。 */
  readonly start: number;
  /** 拿掉幾件；沒拿就不放這個 key。 */
  readonly removedCount?: number;
  /** 插進去的。 */
  readonly inserted: readonly QueuedInput[];
  /** 拿掉的那幾件是被取消的（刪、改），不是被領走開跑。 */
  readonly outcome?: 'canceled';
}

/** 兩條清單。形狀照 dsh 的 `InboxState`。 */
export type InboxState = { readonly [target in InboxTarget]: readonly QueuedInput[] };

/** 還沒有任何變動時的收件匣。 */
export const EMPTY_INBOX: InboxState = { 'next-turn': [], 'next-step': [] };

/**
 * 套一次變動，回傳新的收件匣。**不合規就拋**，照 dsh 的 `inboxProjectionDefinition.apply`：範圍超出、id 重複
 * 都代表寫的那一側壞了，靜靜收下的話佇列會跟實際跑的東西對不上。
 *
 * 寫的那一側先用它算出下一份、驗過了才落日誌（同 dsh 的 `mutate`），所以產品路徑上它不會在讀的那一側拋。
 *
 * @param inbox - 目前的收件匣。
 * @param splice - 這一次變動，套在 `splice.target` 那一條上。
 * @returns 新的收件匣。
 * @throws 範圍不合規，或變動之後兩條清單合起來有兩件同 id。
 */
export function spliceInbox(inbox: InboxState, splice: InboxSplice): InboxState {
  const list = inbox[splice.target];
  const removedCount = splice.removedCount ?? 0;
  if (
    !Number.isSafeInteger(splice.start) ||
    splice.start < 0 ||
    splice.start > list.length ||
    !Number.isSafeInteger(removedCount) ||
    removedCount < 0 ||
    splice.start + removedCount > list.length
  ) {
    throw new Error(
      `送出佇列（${splice.target}）的變動超出範圍：start ${String(splice.start)}、` +
        `removedCount ${String(removedCount)}，清單只有 ${list.length} 件`,
    );
  }
  const next: InboxState = {
    ...inbox,
    [splice.target]: list.toSpliced(splice.start, removedCount, ...splice.inserted),
  };
  const ids = new Set<string>();
  for (const item of [...next['next-turn'], ...next['next-step']]) {
    if (ids.has(item.id)) throw new Error(`送出佇列裡已經有一件 id 是 "${item.id}"`);
    ids.add(item.id);
  }
  return next;
}

/**
 * 從一段日誌折出目前的收件匣。**從日誌開頭折起**：佇列不會在一輪開頭清空，前幾頁插進來、還沒領走的只看
 * 一段會漏掉。
 *
 * @param events - 一份日誌到目前為止的事件（或它的開頭一段）。只讀 `inbox/spliced`。
 * @returns 目前的收件匣。
 * @throws 某一顆不合規，見 {@link spliceInbox}。訊息帶那一顆的 `seq`。
 */
export function foldInbox(
  events: Iterable<{ readonly type: string; readonly seq: number; readonly data: unknown }>,
): InboxState {
  let inbox = EMPTY_INBOX;
  for (const event of events) {
    if (event.type !== 'inbox/spliced') continue;
    try {
      inbox = spliceInbox(inbox, event.data as InboxSplice);
    } catch (error: unknown) {
      throw new Error(`日誌 seq ${event.seq} 的 inbox/spliced 不合規`, { cause: error });
    }
  }
  return inbox;
}
