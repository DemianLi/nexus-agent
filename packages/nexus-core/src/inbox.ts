/**
 * 送出佇列：人送出、還沒開跑的那幾句（[#637](https://github.com/DemianLi/nexus-agent/issues/637)）。
 *
 * 照 dsh 的收件匣（`packages/core/agent-loop/src/inbox.ts`，`477b4f4`）：**狀態不另外存，由日誌上一顆顆
 * `inbox/spliced` 折出來**。每一次變動（送進來、領走、改、刪）落一顆，折疊就是陣列的 `splice`。
 *
 * - 送進來：`inserted` 非空，接在尾巴。
 * - 領走（一輪開始）：`removedCount: 1`，不帶 `outcome`。
 * - 刪：`removedCount: 1` 加 `outcome: 'canceled'`。
 * - 改：同一顆裡 `removedCount: 1` 加 `inserted: [新的]`，帶 `outcome: 'canceled'`，id 不變。
 *
 * 寫的人只有 web 的 pump（`apps/harness/src/thread-pump.ts`）：CLI 的 REPL 一行一輪，沒有排隊。
 *
 * @module
 */

/**
 * 收件匣的哪一條清單。dsh 有 `next-turn` 與 `next-step` 兩條，後者是插話（steer）用的，**這一版只有前者**
 * ——插話另開一張（#637 的 Q3）。留著這一格是讓那張加成員就好，事件的形狀不用再變一次。
 */
export type InboxTarget = 'next-turn';

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

/**
 * 套一次變動，回傳新的清單。**不合規就拋**，照 dsh 的 `inboxProjectionDefinition.apply`：範圍超出、id 重複
 * 都代表寫的那一側壞了，靜靜收下的話佇列會跟實際跑的東西對不上。
 *
 * 寫的那一側先用它算出下一份、驗過了才落日誌（同 dsh 的 `mutate`），所以產品路徑上它不會在讀的那一側拋。
 *
 * @param inbox - 目前的清單。
 * @param splice - 這一次變動。
 * @returns 新的清單。
 * @throws 範圍不合規，或變動之後有兩件同 id。
 */
export function spliceInbox(
  inbox: readonly QueuedInput[],
  splice: InboxSplice,
): readonly QueuedInput[] {
  const removedCount = splice.removedCount ?? 0;
  if (
    !Number.isSafeInteger(splice.start) ||
    splice.start < 0 ||
    splice.start > inbox.length ||
    !Number.isSafeInteger(removedCount) ||
    removedCount < 0 ||
    splice.start + removedCount > inbox.length
  ) {
    throw new Error(
      `送出佇列的變動超出範圍：start ${String(splice.start)}、removedCount ${String(removedCount)}，` +
        `清單只有 ${inbox.length} 件`,
    );
  }
  const next = inbox.toSpliced(splice.start, removedCount, ...splice.inserted);
  const ids = new Set<string>();
  for (const item of next) {
    if (ids.has(item.id)) throw new Error(`送出佇列裡已經有一件 id 是 "${item.id}"`);
    ids.add(item.id);
  }
  return next;
}

/**
 * 從一段日誌折出目前的清單。**從日誌開頭折起**：佇列不會在一輪開頭清空，前幾頁插進來、還沒領走的只看
 * 一段會漏掉。
 *
 * @param events - 一份日誌到目前為止的事件（或它的開頭一段）。只讀 `inbox/spliced`。
 * @returns 目前的清單。
 * @throws 某一顆不合規，見 {@link spliceInbox}。訊息帶那一顆的 `seq`。
 */
export function foldInbox(
  events: Iterable<{ readonly type: string; readonly seq: number; readonly data: unknown }>,
): readonly QueuedInput[] {
  let inbox: readonly QueuedInput[] = [];
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
