/**
 * 一條對話的接線：開下行、把 frame 折進狀態、把話送上行。
 *
 * **折疊本身不在這裡**，在 `@nexus/wire` 的 `reduceConversation`——那一層才驗得到
 * 真的 agent 跑出來的 frame（見 `@nexus/harness` 的 `conversation-wire.test.ts`）。
 * 這個 hook 只負責 React 那一半：連線的生命週期與送出的時機。
 */

import type {
  AnswerEntry,
  ConversationState,
  SlashDescriptor,
  QueueUpdateAction,
  SlashRunOutcome,
  UplinkResult,
  WireClient,
  WireFeedbackCategory,
  WireFeedbackItem,
  WireFeedbackRating,
} from '@nexus/wire';
import {
  answerResponse,
  appendAnswers,
  appendDecision,
  emptyConversation,
  prependEntries,
  QUEUE_ITEM_NOT_FOUND,
  reduceAll,
  reduceConversation,
  uniformDecisions,
} from '@nexus/wire';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createAgentClient } from '@/lib/agent';
import { FEEDBACK_COMMAND_LINE, FEEDBACK_COPY } from '@/lib/feedback';
import { FramePublisher, publicationOf } from '@/lib/frame-publisher';
import type { Publication } from '@/lib/frame-publisher';
import { RatingsController } from '@/lib/feedback-ratings';
import type { RatingsView } from '@/lib/feedback-ratings';
import { RECOVERED_NOTICE_MS, reconnectDelay } from '@/lib/reconnect';

/** 回饋對話框開給誰：一則回覆（按了讚或踩），或整個會話（只打了 `/feedback`）。 */
export type FeedbackTarget =
  | { readonly kind: 'session' }
  | { readonly kind: 'reply'; readonly messageId: string; readonly rating: WireFeedbackRating };

export interface FeedbackDialogState {
  readonly target: FeedbackTarget;
  readonly submitting: boolean;
  /** 上一次送出失敗的那句話。失敗時框留著（照 dsh）。 */
  readonly failure?: string;
}

export interface UseConversationOptions {
  /** 注入用；省略即連同源的 harness。 */
  readonly client?: WireClient;
  /** 省略即這一次載入自己開一條新的。 */
  readonly threadId?: string;
}

/** 畫面上那段歷史的現況（#306）。 */
/** 一句話伺服器沒收下（#645 Q4）。 */
export interface SendRejected {
  readonly message: string;
}

/** 佇列的改或刪沒收下。`gone` 是那一件已經不在隊裡：多半是剛開跑了，也可能是別的分頁刪的。 */
export interface QueueUpdateRejected {
  readonly gone: boolean;
  readonly message: string;
}

export interface HistoryView {
  /** 更早還有看得見的東西，「載入更早的對話」按得動。 */
  readonly hasMore: boolean;
  /** 舊格式的會話：模型的回覆沒有保存。見 `@nexus/wire` 的 `ThreadHistoryResult.legacy`。 */
  readonly legacy: boolean;
  /** 正在拿更早的那一頁。 */
  readonly loading: boolean;
  /**
   * 上一次往前翻拿不到的原因。**跟 {@link Conversation.historyError} 分開**：那一格是第一頁讀不到、畫在上方；
   * 這一格畫在按鈕旁邊，有它就不自動載入（`earlier-pager.tsx`）。再按一次就清掉。
   */
  readonly error?: string;
  /** 最近一次往前翻接上了幾則（人打的字與模型的回覆各算一則，同 wire 一頁的單位），報讀用。 */
  readonly loaded?: number;
}

export interface Conversation {
  readonly state: ConversationState;
  /** 歷史拿到了沒、還有沒有更早的。**拿到之前是 `undefined`**，拿不到時看 {@link historyError}。 */
  readonly history?: HistoryView;
  /** 第一頁歷史拿不回來的原因。對話照樣接得下去，只是之前說過的話不在畫面上。往前翻的失敗在 {@link HistoryView.error}。 */
  readonly historyError?: string;
  /** 往前翻一頁，接在最前面。沒有更早的、或正在拿時什麼都不做。 */
  loadEarlier(): Promise<void>;
  /** 下行開好了沒。**開好之前不能送**——這條線沒有重播，早送的那一輪會看不到。斷了就翻回 `false`。 */
  readonly connected: boolean;
  /** 上一次開線失敗、或下行斷掉的原因。接回來就清掉。串流自己正常收掉時沒有原因可講，這一格不在。 */
  readonly connectionError?: string;
  /**
   * 下行斷了（或第一次就沒開成），正在自動重接（[#593](https://github.com/DemianLi/nexus-agent/issues/593)）。
   * `wasConnected` 分得出「連上過、中斷了」與「從沒連上」；`offline` 是瀏覽器說沒有網路，這時不排重試，
   * 回到線上才從頭算。
   */
  readonly reconnecting?: { readonly wasConnected: boolean; readonly offline: boolean };
  /** 剛重新接上：狀態列短暫講一句，{@link RECOVERED_NOTICE_MS} 後收掉。 */
  readonly recovered: boolean;
  /** 不等退避，立刻重接一次，退避從頭算。沒在重接時什麼都不做。 */
  reconnectNow(): void;
  /**
   * 上一個上行指令被拒的原因。
   *
   * **這條線的上行會拒絕東西**（停在核准點時的 `run.start`、對不上的 `interrupt_id`、
   * 筆數不對的決定），而拒絕是 200 ＋ error 封包。不看回應等於把它們靜靜吞掉——
   * 那正是這一版在 server 端拒絕動作要避免的事。
   */
  readonly commandError?: string;
  /**
   * 這條 thread 打得出哪些斜線命令。**拿來顯示，不做選單**——
   * dsh 的 `CommandDirectory`（epoch guard、single-flight、`ensureReady`）是另一張卡。
   */
  readonly slashCommands: readonly SlashDescriptor[];
  /**
   * 上一個斜線命令自己失敗的原因，或那一行不是認得的命令。
   *
   * **跟 {@link Conversation.commandError} 是兩件事**：那個是這條線拒絕發派
   * （停在核准點、正在跑），這個是發派成功之後命令自己講的話。混在一起的那一刻，
   * 「這條 thread 正在跑」就會被顯示成「這個命令壞了」。
   */
  readonly slashError?: string;
  /**
   * 上一個斜線命令成功時要說的話。**命令的結果不進 transcript**——命令是人對工具說的
   * 話，不是對模型說的話，而 transcript 折的是線上的 `Event`。CLI 那邊的對應是
   * `printer.log`。
   */
  readonly slashNotice?: string;
  /**
   * 送一行進去。**第一個字是 `/` 就走 `slash.run`**，其餘走 `run.start`。
   *
   * 認不得的命令在這裡是錯誤，不像 CLI 那樣照原樣送給模型——瀏覽器這個發派面手上
   * 就有清單，說「不認得」比把一行斜線丟給模型有用
   * （[#123](https://github.com/DemianLi/nexus-agent/issues/123)）。
   *
   * **一句話送出去不畫任何東西**（#645）：伺服器收下就進送出佇列，開跑那一刻才由 `inbox` 的 `claimed` 畫人的泡泡。
   * 伺服器沒收下（回錯誤或這一趟就斷了）時回 {@link SendRejected}，呼叫端把草稿放回去並說出原因；斜線命令與
   * `/feedback` 各自報自己的結果，一律回 `undefined`。
   */
  send(text: string): Promise<SendRejected | undefined>;
  /**
   * 改或刪送出佇列裡的一件（`queue.update`，#637）。**只回有沒有收下**：清單的新樣子走下行的 `inbox`，
   * 不拿回條改本地的東西。
   */
  updateQueue(itemId: string, action: QueueUpdateAction): Promise<QueueUpdateRejected | undefined>;
  /**
   * 回答**指名的那一顆**核准請求。
   *
   * 一個決定套到那顆中斷的整批 `actionRequests` 上——逐筆按在基座那側分不出來
   * （見 `ApprovalCard`）。**但不會套到同一輪的其他中斷上**：`interruptId` 就是
   * 那道分界，基座據它逐 task 派送（[#232](https://github.com/DemianLi/nexus-agent/issues/232)）。
   * 認不得那顆 id 時什麼都不做。
   */
  respond(interruptId: string, decision: string): Promise<void>;
  /**
   * 回答**指名的那一顆**問答請求。
   *
   * 與 {@link Conversation.respond} 是兩個方法不是一個加寬的：送出的形狀不同
   * （`{answers:[…]}` 對 `{decisions:[…]}`），而型別上分開才擋得住「把答案送給核准
   * 那條路」。認不得那顆 id、或那顆不是問答時，什麼都不做。
   */
  answer(interruptId: string, answers: AnswerEntry['answers']): Promise<void>;
  /**
   * 按停止（`run.cancel`，[#276](https://github.com/DemianLi/nexus-agent/issues/276)）。
   *
   * **只送出、不等停穩，也不自己改狀態**：停下來的事實走下行，折疊器把狀態翻成 `stopped`。
   * 停在核准點時按它就是收回那幾張卡，收回的結果由伺服器那側寫。
   */
  cancel(): Promise<void>;
  /**
   * 這條 thread 目前的評分，以訊息 id（`AiEntry.messageId`）為鍵（[#382](https://github.com/DemianLi/nexus-agent/issues/382)）。
   * **第一次 {@link seedRatings} 之前是空的**，照 dsh。
   */
  readonly ratings: ReadonlyMap<string, WireFeedbackItem>;
  /** 讀回評分失敗了（dsh 的 `error.load`）。下一次滑過或按下去會再試。 */
  readonly ratingsLoadFailed: boolean;
  /** 讀回這條 thread 的評分，讀過就不再讀。畫面掛在讚踩的第一次滑過或聚焦上。 */
  seedRatings(): void;
  readonly feedbackDialog?: FeedbackDialogState;
  /**
   * 按了一則回覆的讚或踩。**再點已選的那顆是收回**，另一顆開對話框，送出之後才記（照 dsh）。
   * 先等讀回評分：還沒滑過就直接按的話，看到的也是存著的那一筆。
   */
  rate(messageId: string, rating: WireFeedbackRating): Promise<void>;
  /** 送出回饋對話框。可以空著送。 */
  submitFeedback(draft: {
    readonly category?: WireFeedbackCategory;
    readonly text: string;
  }): Promise<void>;
  dismissFeedback(): void;
}

export function useConversation(options: UseConversationOptions = {}): Conversation {
  const client = useMemo(() => options.client ?? createAgentClient(), [options.client]);
  const threadId = useMemo(() => options.threadId ?? crypto.randomUUID(), [options.threadId]);

  const [state, setState] = useState<ConversationState>(emptyConversation);
  // 串流的逐字片段按動畫幀合併交給 React（`FramePublisher`，#527 Q8）。它手上的那份永遠是最新的。
  const [publisher] = useState(() => new FramePublisher(state, setState));
  useEffect(() => () => publisher.cancel(), [publisher]);
  /** 所有改對話狀態的地方都走這裡。 */
  const advance = useCallback(
    (step: (previous: ConversationState) => ConversationState, publication?: Publication) => {
      publisher.apply(step, publication);
    },
    [publisher],
  );
  const [ratingsView, setRatingsView] = useState<RatingsView>(() => ({
    status: 'cold',
    items: new Map(),
  }));
  // **一條 thread 一個**：換 thread 時整個 view 重掛（`App.tsx` 的 `key`），不會拿著上一條的評分。
  const ratingsController = useMemo(
    () =>
      new RatingsController(
        {
          list: () => client.feedbackList(threadId),
          put: (params) => client.feedbackPut(threadId, params),
          delete: (params) => client.feedbackDelete(threadId, params),
        },
        setRatingsView,
      ),
    [client, threadId],
  );
  const [feedbackDialog, setFeedbackDialog] = useState<FeedbackDialogState | undefined>(undefined);
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | undefined>(undefined);
  const [reconnecting, setReconnecting] = useState<Conversation['reconnecting']>(undefined);
  const [recovered, setRecovered] = useState(false);
  /** 每加一就重開一次下行（#593）：自動重試與「立刻重連」都走這一格。 */
  const [generation, setGeneration] = useState(0);
  /**
   * 重接的帳。**放 ref 不放 state**：計時器與 `online` 事件在 effect 外面讀寫它，不需要為它重畫。
   * `attempt` 是連續第幾次重試（接上就歸零）；`lost` 是下行現在斷著；`everConnected` 分「中斷」與「從沒連上」。
   */
  const retry = useRef<{
    attempt: number;
    lost: boolean;
    everConnected: boolean;
    timer?: ReturnType<typeof setTimeout>;
    recoveredTimer?: ReturnType<typeof setTimeout>;
  }>({ attempt: 0, lost: false, everConnected: false });
  const [commandError, setCommandError] = useState<string | undefined>(undefined);
  const [slashCommands, setSlashCommands] = useState<readonly SlashDescriptor[]>([]);
  const [slashError, setSlashError] = useState<string | undefined>(undefined);
  const [slashNotice, setSlashNotice] = useState<string | undefined>(undefined);
  /** 往前翻要帶回去的兩格，跟畫面要的那三格放一起。 */
  const [history, setHistory] = useState<
    (HistoryView & { readonly firstSeq: number; readonly throughSeq: number }) | undefined
  >(undefined);
  const [historyError, setHistoryError] = useState<string | undefined>(undefined);
  const historyRef = useRef(history);
  historyRef.current = history;
  const clientRef = useRef(client);
  clientRef.current = client;
  const dialogRef = useRef(feedbackDialog);
  dialogRef.current = feedbackDialog;

  /** 排下一次重試。瀏覽器說離線就不排，等 `online`（照 dsh 的 `setNetworkAvailable`）。 */
  const scheduleRetry = useCallback(() => {
    const book = retry.current;
    clearTimeout(book.timer);
    book.timer = undefined;
    const offline = typeof navigator !== 'undefined' && !navigator.onLine;
    setReconnecting({ wasConnected: book.everConnected, offline });
    if (offline) return;
    book.attempt += 1;
    book.timer = setTimeout(() => {
      book.timer = undefined;
      setGeneration((current) => current + 1);
    }, reconnectDelay(book.attempt));
  }, []);

  const reconnectNow = useCallback(() => {
    const book = retry.current;
    if (!book.lost) return;
    clearTimeout(book.timer);
    book.timer = undefined;
    book.attempt = 0;
    setGeneration((current) => current + 1);
  }, []);

  // 網路回來時退避從頭算，離開時停掉排著的那一次（同 dsh：`online` 後照樣先等第 1 次的退避，不是當場接）。
  useEffect(() => {
    const onOnline = () => {
      if (!retry.current.lost) return;
      retry.current.attempt = 0;
      scheduleRetry();
    };
    const onOffline = () => {
      if (!retry.current.lost) return;
      scheduleRetry();
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [scheduleRetry]);

  // 卸載（換 thread 時整個 view 重掛）就把兩個計時器收掉：不能對已經離開的 thread 重接。
  useEffect(() => {
    const book = retry.current;
    return () => {
      clearTimeout(book.timer);
      clearTimeout(book.recoveredTimer);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    /** 這條下行斷了：翻回沒連上、講原因、排下一次（#593）。串流正常收掉也算——server 不會無故收線。 */
    const lose = (reason: string | undefined) => {
      const book = retry.current;
      book.lost = true;
      clearTimeout(book.recoveredTimer);
      setRecovered(false);
      setConnected(false);
      setConnectionError(reason);
      scheduleRetry();
    };

    void (async () => {
      try {
        const events = await client.openEvents(threadId, { signal: controller.signal });
        if (cancelled) {
          return;
        }
        // **歷史排在開線之後、放行送出之前**（#306），照 dsh 的「先訂閱、再拿 snapshot」：反過來的話，兩者
        // 之間發生的事兩邊都沒有。拿歷史時抽下行的迴圈還沒開始，這中間來的 frame 在線上排著，折完歷史才折
        // 它們，所以順序是對的。**`connected` 等歷史折完才翻**：早翻的話先送出去的那一句會排在歷史前面。
        const page = await client.threadHistory(threadId);
        if (cancelled) {
          return;
        }
        // **從空的重折，不接在現有的後面**（#593）：重接時傳輸 seq 可能從 0 重算（serve 重開過），折疊器又丟掉
        // `seq <= lastSeq` 的 frame，沿用舊的那份的話，新來的會全被當成重複。重接等於重新打開這一頁，只存在
        // 本地的東西（例如「已核准：X」）跟重新整理一樣不在了。第一次開線時現有的那份本來就是空的。
        if (page.kind === 'ok') {
          const { events: frames, ...cursor } = page.result;
          advance(() => reduceAll(emptyConversation(), frames));
          setHistory({ ...cursor, loading: false });
          setHistoryError(undefined);
        } else {
          advance(() => emptyConversation());
          setHistory(undefined);
          setHistoryError(page.message);
        }
        const book = retry.current;
        const wasLost = book.lost && book.everConnected;
        book.lost = false;
        book.attempt = 0;
        book.everConnected = true;
        setConnected(true);
        setConnectionError(undefined);
        setReconnecting(undefined);
        if (wasLost) {
          setRecovered(true);
          clearTimeout(book.recoveredTimer);
          book.recoveredTimer = setTimeout(() => setRecovered(false), RECOVERED_NOTICE_MS);
        }
        // **抓清單排在開線之後**，跟送話同一條規則：這條線沒有重播，所有的上行都等
        // 下行開好。清單本身不需要重播，但兩套順序規則比一套容易記錯。
        const listed = await client.slashList(threadId);
        if (cancelled) {
          return;
        }
        if (listed.kind === 'ok') {
          setSlashCommands(listed.commands);
        } else {
          setSlashError(listed.message);
        }
        for await (const event of events) {
          if (cancelled) {
            return;
          }
          advance((previous) => reduceConversation(previous, event), publicationOf(event));
        }
        if (!cancelled) lose(undefined);
      } catch (error) {
        if (!cancelled) {
          lose(error instanceof Error ? error.message : String(error));
        }
      }
    })();

    return () => {
      // **收的是這條線，不是 agent。** server 端不會因為瀏覽器離開就停掉 run。
      cancelled = true;
      controller.abort();
      setConnected(false);
    };
  }, [client, threadId, advance, generation, scheduleRetry]);

  /** 收下上行的回條：被拒就說出來，成功就把上一次的抱怨收掉。 */
  const note = useCallback((result: UplinkResult) => {
    setCommandError(result.type === 'error' ? result.message : undefined);
  }, []);

  /** 斜線命令那一半。命令不進模型，也就不進 transcript。 */
  const runSlash = useCallback(
    async (line: string) => {
      setSlashError(undefined);
      setSlashNotice(undefined);
      let outcome: SlashRunOutcome;
      try {
        outcome = await clientRef.current.slashRun(threadId, line);
      } catch (error) {
        setSlashError(error instanceof Error ? error.message : String(error));
        return;
      }
      if (outcome.kind === 'rejected') {
        // 這條線拒絕發派——跟 `run.start` 被拒是同一件事，所以走同一個欄位。
        setCommandError(outcome.message);
        return;
      }
      setCommandError(undefined);
      if (outcome.kind === 'unknown') {
        setSlashError(`不認得這個命令：${line}`);
        return;
      }
      if (outcome.kind === 'error') {
        setSlashError(outcome.text);
        return;
      }
      // 成功而沒話說時什麼都不顯示，跟 CLI 一樣（`result.text` 是選配的）。
      setSlashNotice(outcome.text);
    },
    [threadId],
  );

  const send = useCallback(
    async (text: string): Promise<SendRejected | undefined> => {
      const trimmed = text.trim();
      if (trimmed === '') {
        return undefined;
      }
      if (trimmed === FEEDBACK_COMMAND_LINE) {
        // **只打 `/feedback` 開對話框**，照 dsh 的 `/feedback` 裝飾：送出的是 `feedback.record`，
        // 跑著也收。帶了文字的 `/feedback 很慢` 照舊走 `slash.run`（#267 的 Q2）。
        setSlashError(undefined);
        setSlashNotice(undefined);
        setFeedbackDialog({ target: { kind: 'session' }, submitting: false });
        return undefined;
      }
      if (trimmed.startsWith('/')) {
        await runSlash(trimmed);
        return undefined;
      }
      setSlashError(undefined);
      setSlashNotice(undefined);
      let result: UplinkResult;
      try {
        result = await clientRef.current.runStart(threadId, trimmed);
      } catch (error) {
        return { message: error instanceof Error ? error.message : String(error) };
      }
      if (result.type === 'error') return { message: result.message };
      setCommandError(undefined);
      return undefined;
    },
    [threadId, runSlash],
  );

  const updateQueue = useCallback(
    async (itemId: string, action: QueueUpdateAction): Promise<QueueUpdateRejected | undefined> => {
      let result: UplinkResult;
      try {
        result = await clientRef.current.queueUpdate(threadId, { item_id: itemId, action });
      } catch (error) {
        return { gone: false, message: error instanceof Error ? error.message : String(error) };
      }
      if (result.type !== 'error') return undefined;
      return { gone: result.error === QUEUE_ITEM_NOT_FOUND, message: result.message };
    },
    [threadId],
  );

  const respond = useCallback(
    async (interruptId: string, decision: string) => {
      // 送出的那一刻要讀的是**當下**的 pending：不是這次 render 閉包起來的那份，也不是 React 手上可能落後幾幀的那份。
      const pending = publisher.current.pendings.find(
        (candidate) => candidate.interruptId === interruptId,
      );
      // 問答那一顆不收——它的送出形狀是 `{answers:[…]}`，送 `{decisions:[…]}` 過去
      // 會讓工具當場拋，而人只會看到一張永遠不動的卡。
      if (pending === undefined || pending.kind !== 'approval') {
        return;
      }
      // **決定在線上沒有回聲**——拒絕掉的那一批連一顆 frame 都不會有（實測），
      // 所以跟使用者那句話一樣，在送出的那一刻自己寫進去。
      advance((previous) => appendDecision(previous, interruptId, decision));
      note(
        await clientRef.current.inputRespond(threadId, {
          namespace: [...pending.namespace],
          interrupt_id: pending.interruptId,
          response: uniformDecisions(pending, decision),
        }),
      );
    },
    [threadId, note, advance],
  );

  const answer = useCallback(
    async (interruptId: string, answers: AnswerEntry['answers']) => {
      // 送出的那一刻要讀的是**當下**的 pending：不是這次 render 閉包起來的那份，也不是 React 手上可能落後幾幀的那份。
      const pending = publisher.current.pendings.find(
        (candidate) => candidate.interruptId === interruptId,
      );
      if (pending === undefined || pending.kind !== 'question') {
        return;
      }
      // 同 `respond`：線上不回聲，所以送出的那一刻自己寫進去。
      advance((previous) => appendAnswers(previous, interruptId, answers));
      note(
        await clientRef.current.inputRespond(threadId, {
          namespace: [...pending.namespace],
          interrupt_id: pending.interruptId,
          response: answerResponse(answers),
        }),
      );
    },
    [threadId, note, advance],
  );

  const cancel = useCallback(async () => {
    note(await clientRef.current.runCancel(threadId));
  }, [threadId, note]);

  const loadEarlier = useCallback(async () => {
    const current = historyRef.current;
    if (current === undefined || !current.hasMore || current.loading) return;
    // 上一次的錯誤與報讀在按下去的當下清掉：按鈕換成「讀取中…」，旁邊那一句不留著。報讀那一格先清空再寫，
    // 連續兩頁都是 50 則時第二次才唸得到（文字沒變的話 DOM 不動，polite 區不會再唸）。
    const { error: _previousError, loaded: _previousLoaded, ...rest } = current;
    setHistory({ ...rest, loading: true });
    let page;
    try {
      page = await clientRef.current.threadHistory(threadId, {
        beforeSeq: current.firstSeq,
        throughSeq: current.throughSeq,
      });
    } catch (error) {
      setHistory({
        ...rest,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (page.kind === 'rejected') {
      setHistory({ ...rest, loading: false, error: page.message });
      return;
    }
    // 更早那一頁自己從空的折，再接在前面：折進現在這一份的話，它的收尾會把現在的狀態蓋掉。
    const earlier = reduceAll(emptyConversation(), page.result.events);
    advance((previous) => prependEntries(previous, earlier));
    setHistory({
      ...rest,
      firstSeq: page.result.firstSeq,
      hasMore: page.result.hasMore,
      loading: false,
      loaded: earlier.entries.filter((entry) => entry.kind === 'human' || entry.kind === 'ai')
        .length,
    });
  }, [threadId, advance]);

  const seedRatings = useCallback(() => {
    void ratingsController.ensure();
  }, [ratingsController]);

  const rate = useCallback(
    async (messageId: string, rating: WireFeedbackRating) => {
      const loaded = await ratingsController.ensure();
      if (!loaded.ok || ratingsController.view.items.get(messageId)?.rating !== rating) {
        setFeedbackDialog({ target: { kind: 'reply', messageId, rating }, submitting: false });
        return;
      }
      // 再點一次已選的那顆：收回。結果不走對話框，失敗的話跟命令的失敗講在同一行。
      setSlashError(undefined);
      setSlashNotice(undefined);
      const result = await ratingsController.retract(messageId, rating);
      if (!result.ok) setSlashError(result.failure);
    },
    [ratingsController],
  );

  const submitFeedback = useCallback(
    async (draft: { readonly category?: WireFeedbackCategory; readonly text: string }) => {
      const open = dialogRef.current;
      if (open === undefined || open.submitting) return;
      setFeedbackDialog({ target: open.target, submitting: true });
      const fail = (failure: string): void => {
        setFeedbackDialog((current) =>
          current === undefined ? current : { target: current.target, submitting: false, failure },
        );
      };
      const text = draft.text.trim();
      const category = draft.category === undefined ? {} : { category: draft.category };
      try {
        if (open.target.kind === 'session') {
          const outcome = await clientRef.current.feedbackRecord(threadId, {
            ...(text === '' ? {} : { text }),
            ...category,
          });
          if (outcome.kind === 'rejected') {
            fail(`${FEEDBACK_COPY.generic}：${outcome.message}`);
            return;
          }
        } else {
          const { messageId, rating } = open.target;
          const result = await ratingsController.rate(messageId, rating, {
            ...(text === '' ? {} : { note: text }),
            ...category,
          });
          if (!result.ok) {
            fail(result.failure);
            return;
          }
        }
      } catch (error) {
        fail(`${FEEDBACK_COPY.generic}：${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      setFeedbackDialog(undefined);
      setSlashError(undefined);
      // 送出之後的那句謝謝跟命令的結果講在同一行：兩者都是「這一側要說的話」，不進 transcript。
      setSlashNotice(FEEDBACK_COPY.recorded);
    },
    [threadId, ratingsController],
  );

  const dismissFeedback = useCallback(() => {
    setFeedbackDialog(undefined);
  }, []);

  return {
    state,
    connected,
    recovered,
    reconnectNow,
    ...(reconnecting === undefined ? {} : { reconnecting }),
    loadEarlier,
    ...(history === undefined
      ? {}
      : {
          history: {
            hasMore: history.hasMore,
            legacy: history.legacy,
            loading: history.loading,
            ...(history.error === undefined ? {} : { error: history.error }),
            ...(history.loaded === undefined ? {} : { loaded: history.loaded }),
          },
        }),
    ...(historyError === undefined ? {} : { historyError }),
    slashCommands,
    send,
    updateQueue,
    respond,
    answer,
    cancel,
    ratings: ratingsView.items,
    ratingsLoadFailed: ratingsView.status === 'failed',
    seedRatings,
    rate,
    submitFeedback,
    dismissFeedback,
    ...(feedbackDialog === undefined ? {} : { feedbackDialog }),
    ...(connectionError === undefined ? {} : { connectionError }),
    ...(commandError === undefined ? {} : { commandError }),
    ...(slashError === undefined ? {} : { slashError }),
    ...(slashNotice === undefined ? {} : { slashNotice }),
  };
}
