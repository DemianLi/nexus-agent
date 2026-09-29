import type {
  Event,
  InboxPayload,
  QueueSteerAction,
  QueueUpdateAction,
  UplinkResult,
  WireQueuedInput,
} from '@nexus/wire';
import {
  INBOX,
  parseSessionReferenceText,
  QUEUE_ITEM_NOT_FOUND,
  STEER_UNAVAILABLE,
  TITLE,
} from '@nexus/wire';
import type { WireClaimedInput } from '@nexus/wire';

/**
 * 假 client 的下行：開線時先吐一批事先備好的 frame，之後還能再推（#645）。
 *
 * **送出不再自己畫人的話**：伺服器收下 `run.start` 之後才推兩顆 `inbox`——先是「排著一件」，閒著時緊接著「領走」
 * 帶 `claimed`，人的泡泡由後面那顆畫（`thread-pump.ts` 的順序，見 `@nexus/wire` 的 `inbox.ts`）。只記下送了什麼、
 * 什麼都不推的替身，等於假裝伺服器會回聲一件它根本不回聲的事。
 *
 * 推的 frame 的 `seq` 從很大的數起算：折疊器丟掉 `seq <= lastSeq` 的 frame，而各檔事先備好的 frame 從 0 起算。
 */
/**
 * 被領走的一件在線上的樣子：`@` 了別的會話的話，引用網址已經換成 `@標題`，並帶去了重、照先後的 `references`
 * （伺服器在準備那一步換，#713）。壞掉的引用伺服器在收下時就拒絕了，這裡不會碰到；碰到就原樣。
 */
function claimedOf(id: string, text: string): WireClaimedInput {
  try {
    const parsed = parseSessionReferenceText(text);
    if (parsed.references.length === 0) return { id, text };
    const seen = new Set<string>();
    const references = parsed.references.filter(({ sessionId }) => {
      if (seen.has(sessionId)) return false;
      seen.add(sessionId);
      return true;
    });
    return { id, text: parsed.text, references };
  } catch {
    return { id, text };
  }
}

export function fakeDownlink() {
  const listeners = new Map<string, Set<(events: readonly Event[]) => void>>();
  const queues = new Map<string, WireQueuedInput[]>();
  /** 排著的插話（`next-step`，#710）。harness 每一顆 `inbox` 都帶這一條，空的也帶。 */
  const steers = new Map<string, WireQueuedInput[]>();
  /** 不收插話的那幾條 thread。 */
  const closedSteer = new Set<string>();
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

  function pushedFrame(method: string, id: string, data: unknown): Event {
    const current = seq++;
    return {
      type: 'event',
      seq: current,
      event_id: `${id}:${current}`,
      method,
      params: { namespace: [], timestamp: 0, data },
    } as Event;
  }

  function customFrame(name: string, payload: unknown): Event {
    return pushedFrame('custom', name, { name, payload });
  }

  /** root 那一輪的生命週期（開跑／收尾）。 */
  function lifecycleFrame(event: 'running' | 'completed'): Event {
    return pushedFrame('lifecycle', 'lifecycle', { event, graph_name: 'root' });
  }

  function inboxFrame(payload: InboxPayload): Event {
    return customFrame(INBOX, payload);
  }

  /** 會話標題（#649）：伺服器在第一句人話開跑時推一顆，模型產生標題（#650）後再推一顆，後到的取代先到的。 */
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
    const nextStep = steers.get(threadId) ?? [];
    push(threadId, [inboxFrame({ items: queue, nextStep })]);
    if (claim) {
      const rest = queue.filter((item) => item.id !== id);
      queues.set(threadId, rest);
      push(threadId, [inboxFrame({ items: rest, nextStep, claimed: claimedOf(id, text) })]);
    }
    return id;
  }

  /**
   * 伺服器收下一句插話（`run.start` 帶 `mode: 'steer'`，#710），這一輪還收插話：排進 `next-step`，推一顆
   * `inbox`。回給呼叫端的 `run_id` 就是項目 id。什麼時候被領走由測試自己叫 {@link claimSteers}。
   */
  function acceptSteer(threadId: string, text: string): string {
    runs += 1;
    const id = `run-${runs}`;
    const nextStep = [
      ...(steers.get(threadId) ?? []),
      { id, text, source: { kind: 'user' as const } },
    ];
    steers.set(threadId, nextStep);
    push(threadId, [inboxFrame({ items: queues.get(threadId) ?? [], nextStep })]);
    return id;
  }

  /** 這一輪不收插話了（跑完、按了停止、正在收尾）：之後的 `steer` 回 `steer_unavailable`。 */
  function closeSteer(threadId: string): void {
    closedSteer.add(threadId);
  }

  /** 下一次叫模型之前領走整條插話：清單清空，同一顆帶 `claimedNextStep`（照 `thread-pump.ts`）。 */
  function claimSteers(threadId: string): void {
    const claimed = (steers.get(threadId) ?? []).map(({ id, text }) => claimedOf(id, text));
    steers.set(threadId, []);
    push(threadId, [
      inboxFrame({ items: queues.get(threadId) ?? [], nextStep: [], claimedNextStep: claimed }),
    ]);
  }

  /** 改或刪一件（`queue.update`）：照伺服器回收下或「不在隊裡」，清單的新樣子走下行。 */
  function update(
    threadId: string,
    params: { readonly item_id: string; readonly action: QueueUpdateAction | QueueSteerAction },
  ): UplinkResult {
    const queue = queues.get(threadId) ?? [];
    if (!queue.some((item) => item.id === params.item_id)) {
      return { type: 'error', id: 4, error: QUEUE_ITEM_NOT_FOUND, message: '這一件已經不在隊裡' };
    }
    const { action } = params;
    // 把排著的一件改成插話（#710）：這一輪還收（預設收；`closeSteer` 關掉）就從 `next-turn` 拿掉、接到 `next-step` 尾巴，
    // 不收回 `steer_unavailable`，那一件照舊排著。照 harness 的 `queue.update`。
    if (action.kind === 'steer') {
      if (closedSteer.has(threadId)) {
        return { type: 'error', id: 4, error: STEER_UNAVAILABLE, message: '這一輪不收插話了' };
      }
      const moved = queue.find((item) => item.id === params.item_id)!;
      const rest = queue.filter((item) => item.id !== params.item_id);
      const nextStep = [...(steers.get(threadId) ?? []), moved];
      queues.set(threadId, rest);
      steers.set(threadId, nextStep);
      push(threadId, [inboxFrame({ items: rest, nextStep })]);
      return { type: 'success', id: 4, result: { accepted: true } };
    }
    const next =
      action.kind === 'remove'
        ? queue.filter((item) => item.id !== params.item_id)
        : queue.map((item) => (item.id === params.item_id ? { ...item, text: action.text } : item));
    queues.set(threadId, next);
    push(threadId, [inboxFrame({ items: next, nextStep: steers.get(threadId) ?? [] })]);
    return { type: 'success', id: 4, result: { accepted: true } };
  }

  return {
    open,
    push,
    accept,
    acceptSteer,
    claimSteers,
    closeSteer,
    update,
    inboxFrame,
    titleFrame,
    lifecycleFrame,
  };
}
