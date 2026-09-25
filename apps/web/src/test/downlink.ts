import type {
  Event,
  InboxPayload,
  QueueUpdateAction,
  UplinkResult,
  WireQueuedInput,
} from '@nexus/wire';
import { INBOX, QUEUE_ITEM_NOT_FOUND, TITLE } from '@nexus/wire';

/**
 * 假 client 的下行：開線時先吐一批事先備好的 frame，之後還能再推（#645）。
 *
 * **送出不再自己畫人的話**：伺服器收下 `run.start` 之後才推兩顆 `inbox`——先是「排著一件」，閒著時緊接著「領走」
 * 帶 `claimed`，人的泡泡由後面那顆畫（`thread-pump.ts` 的順序，見 `@nexus/wire` 的 `inbox.ts`）。只記下送了什麼、
 * 什麼都不推的替身，等於假裝伺服器會回聲一件它根本不回聲的事。
 *
 * 推的 frame 的 `seq` 從很大的數起算：折疊器丟掉 `seq <= lastSeq` 的 frame，而各檔事先備好的 frame 從 0 起算。
 */
export function fakeDownlink() {
  const listeners = new Map<string, Set<(events: readonly Event[]) => void>>();
  const queues = new Map<string, WireQueuedInput[]>();
  let seq = 1_000_000;
  let runs = 0;

  /** 一條這條 thread 的下行：先吐 `initial`，再吐之後推給這條 thread 的。 */
  function open(
    threadId: string,
    initial: readonly Event[],
  ): AsyncGenerator<Event, void, undefined> {
    const queue: Event[] = [...initial];
    let wake: (() => void) | undefined;
    const listener = (events: readonly Event[]) => {
      queue.push(...events);
      wake?.();
    };
    const set = listeners.get(threadId) ?? new Set();
    set.add(listener);
    listeners.set(threadId, set);
    return (async function* stream() {
      for (;;) {
        while (queue.length > 0) yield queue.shift()!;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    })();
  }

  function push(threadId: string, events: readonly Event[]): void {
    for (const listener of listeners.get(threadId) ?? []) listener(events);
  }

  function customFrame(name: string, payload: unknown): Event {
    const current = seq++;
    return {
      type: 'event',
      seq: current,
      event_id: `${name}:${current}`,
      method: 'custom',
      params: { namespace: [], timestamp: 0, data: { name, payload } },
    } as Event;
  }

  function inboxFrame(payload: InboxPayload): Event {
    return customFrame(INBOX, payload);
  }

  /** 會話標題（#649）：伺服器在第一句人話開跑時推，#650 之後模型產生的標題會再推一顆。 */
  function titleFrame(title: string): Event {
    return customFrame(TITLE, { title });
  }

  /**
   * 伺服器收下一句話：推「排著一件」，`claim` 為真時（閒著）緊接著推「領走」。回給呼叫端的 `run_id` 就是項目 id。
   * `claim` 為假是一輪還沒收尾（跑著、停在核准點）：那一件留在隊裡。
   */
  function accept(threadId: string, text: string, claim = true): string {
    runs += 1;
    const id = `run-${runs}`;
    const queue = [
      ...(queues.get(threadId) ?? []),
      { id, text, source: { kind: 'user' as const } },
    ];
    queues.set(threadId, queue);
    push(threadId, [inboxFrame({ items: queue })]);
    if (claim) {
      const rest = queue.filter((item) => item.id !== id);
      queues.set(threadId, rest);
      push(threadId, [inboxFrame({ items: rest, claimed: { id, text } })]);
    }
    return id;
  }

  /** 改或刪一件（`queue.update`）：照伺服器回收下或「不在隊裡」，清單的新樣子走下行。 */
  function update(
    threadId: string,
    params: { readonly item_id: string; readonly action: QueueUpdateAction },
  ): UplinkResult {
    const queue = queues.get(threadId) ?? [];
    if (!queue.some((item) => item.id === params.item_id)) {
      return { type: 'error', id: 4, error: QUEUE_ITEM_NOT_FOUND, message: '這一件已經不在隊裡' };
    }
    const { action } = params;
    const next =
      action.kind === 'remove'
        ? queue.filter((item) => item.id !== params.item_id)
        : queue.map((item) => (item.id === params.item_id ? { ...item, text: action.text } : item));
    queues.set(threadId, next);
    push(threadId, [inboxFrame({ items: next })]);
    return { type: 'success', id: 4, result: { accepted: true } };
  }

  return { open, push, accept, update, inboxFrame, titleFrame };
}
