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
  appendHumanTurn,
  appendQuestionCancel,
  cancelResponse,
  emptyConversation,
  prependEntries,
  reduceAll,
  reduceConversation,
  uniformDecisions,
} from '@nexus/wire';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createAgentClient } from '@/lib/agent';
import {
  FEEDBACK_COMMAND_LINE,
  FEEDBACK_COPY,
  NO_REPLY_TAILS,
  failureCopy,
  trackReplyTails,
} from '@/lib/feedback';
import type { ReplyTails } from '@/lib/feedback';

/** 回饋對話框開給誰：一則回覆（按了讚或踩），或整個會話（只打了 `/feedback`）。 */
export type FeedbackTarget =
  | { readonly kind: 'session' }
  | { readonly kind: 'reply'; readonly replyId: string; readonly rating: WireFeedbackRating };

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
export interface HistoryView {
  /** 更早還有看得見的東西，「載入更早的對話」按得動。 */
  readonly hasMore: boolean;
  /** 舊格式的會話：模型的回覆沒有保存。見 `@nexus/wire` 的 `ThreadHistoryResult.legacy`。 */
  readonly legacy: boolean;
  /** 正在拿更早的那一頁。 */
  readonly loading: boolean;
}

export interface Conversation {
  readonly state: ConversationState;
  /** 歷史拿到了沒、還有沒有更早的。**拿到之前是 `undefined`**，拿不到時看 {@link historyError}。 */
  readonly history?: HistoryView;
  /** 歷史拿不回來的原因。對話照樣接得下去，只是之前說過的話不在畫面上。 */
  readonly historyError?: string;
  /** 往前翻一頁，接在最前面。沒有更早的、或正在拿時什麼都不做。 */
  loadEarlier(): Promise<void>;
  /** 下行開好了沒。**開好之前不能送**——這條線沒有重播，早送的那一輪會看不到。 */
  readonly connected: boolean;
  readonly connectionError?: string;
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
   */
  send(text: string): Promise<void>;
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
   * 放棄**指名的那一組**問題。工具會收到錯誤，模型因此知道人不打算走這條路
   * （dsh 的 `ASK_CANCELLED`）——**與「每一題都跳過」不同**，後者仍是一份答案。
   */
  cancelQuestions(interruptId: string): Promise<void>;
  /**
   * 按停止（`run.cancel`，[#276](https://github.com/DemianLi/nexus-agent/issues/276)）。
   *
   * **只送出、不等停穩，也不自己改狀態**：停下來的事實走下行，折疊器把狀態翻成 `stopped`。
   * 停在核准點時按它就是收回那幾張卡，收回的結果由伺服器那側寫。
   */
  cancel(): Promise<void>;
  /** 長評分按鈕的那幾則回覆（[#278](https://github.com/DemianLi/nexus-agent/issues/278)），見 `trackReplyTails`。 */
  readonly replyTails: ReadonlySet<string>;
  /**
   * 這個分頁看過的評分，以回覆 id 為鍵。**只在記憶體裡**：還沒有 `list`，重新整理或切回舊會話就沒了，
   * 重播出來的舊回覆也沒有按鈕。見 [#382](https://github.com/DemianLi/nexus-agent/issues/382)。
   */
  readonly ratings: ReadonlyMap<string, WireFeedbackItem>;
  readonly feedbackDialog?: FeedbackDialogState;
  /**
   * 按了一則回覆的讚或踩。**再點已選的那顆是收回**，另一顆開對話框，送出之後才記（照 dsh）。
   */
  rate(replyId: string, rating: WireFeedbackRating): Promise<void>;
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

  // **收尾那則跟對話狀態住在同一格**：它要比對每一步的前後兩份狀態，分開存的話一批 frame 裡「跑起來又
  // 收掉」只剩頭尾，中間那次 `running` 會被吃掉（見 `trackReplyTails`）。
  const [view, setView] = useState<{ conversation: ConversationState; tails: ReplyTails }>(() => ({
    conversation: emptyConversation(),
    tails: NO_REPLY_TAILS,
  }));
  const state = view.conversation;
  /** 所有改對話狀態的地方都走這裡。 */
  const advance = useCallback((step: (previous: ConversationState) => ConversationState) => {
    setView((previous) => {
      const conversation = step(previous.conversation);
      if (conversation === previous.conversation) return previous;
      return {
        conversation,
        tails: trackReplyTails(previous.conversation, conversation, previous.tails),
      };
    });
  }, []);
  const [ratings, setRatings] = useState<ReadonlyMap<string, WireFeedbackItem>>(() => new Map());
  const [feedbackDialog, setFeedbackDialog] = useState<FeedbackDialogState | undefined>(undefined);
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | undefined>(undefined);
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
  // 送出的那一刻要讀的是**當下**的 pending，不是這次 render 閉包起來的那份。
  const stateRef = useRef(state);
  stateRef.current = state;
  const ratingsRef = useRef(ratings);
  ratingsRef.current = ratings;
  const dialogRef = useRef(feedbackDialog);
  dialogRef.current = feedbackDialog;

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

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
        if (page.kind === 'ok') {
          const { events: frames, ...cursor } = page.result;
          advance((previous) => reduceAll(previous, frames));
          setHistory({ ...cursor, loading: false });
        } else {
          setHistoryError(page.message);
        }
        setConnected(true);
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
          advance((previous) => reduceConversation(previous, event));
        }
      } catch (error) {
        if (!cancelled) {
          setConnectionError(error instanceof Error ? error.message : String(error));
        }
      }
    })();

    return () => {
      // **收的是這條線，不是 agent。** server 端不會因為瀏覽器離開就停掉 run。
      cancelled = true;
      controller.abort();
      setConnected(false);
    };
  }, [client, threadId, advance]);

  /** 收下上行的回條：被拒就說出來，成功就把上一次的抱怨收掉。 */
  const note = useCallback((result: UplinkResult) => {
    setCommandError(result.type === 'error' ? result.message : undefined);
  }, []);

  /** 斜線命令那一半。**不 `appendHumanTurn`**——命令不進模型，也就不進 transcript。 */
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
    async (text: string) => {
      const trimmed = text.trim();
      if (trimmed === '') {
        return;
      }
      if (trimmed === FEEDBACK_COMMAND_LINE) {
        // **只打 `/feedback` 開對話框**，照 dsh 的 `/feedback` 裝飾：送出的是 `feedback.record`，
        // 跑著也收。帶了文字的 `/feedback 很慢` 照舊走 `slash.run`（#267 的 Q2）。
        setSlashError(undefined);
        setSlashNotice(undefined);
        setFeedbackDialog({ target: { kind: 'session' }, submitting: false });
        return;
      }
      if (trimmed.startsWith('/')) {
        await runSlash(trimmed);
        return;
      }
      setSlashError(undefined);
      setSlashNotice(undefined);
      // 線上不會回聲使用者這句話，所以送出的那一刻自己補進去。
      advance((previous) => appendHumanTurn(previous, trimmed));
      note(await clientRef.current.runStart(threadId, trimmed));
    },
    [threadId, note, runSlash, advance],
  );

  const respond = useCallback(
    async (interruptId: string, decision: string) => {
      const pending = stateRef.current.pendings.find(
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
      const pending = stateRef.current.pendings.find(
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

  const cancelQuestions = useCallback(
    async (interruptId: string) => {
      const pending = stateRef.current.pendings.find(
        (candidate) => candidate.interruptId === interruptId,
      );
      if (pending === undefined || pending.kind !== 'question') {
        return;
      }
      advance((previous) => appendQuestionCancel(previous, interruptId));
      note(
        await clientRef.current.inputRespond(threadId, {
          namespace: [...pending.namespace],
          interrupt_id: pending.interruptId,
          response: cancelResponse(),
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
    setHistory({ ...current, loading: true });
    let page;
    try {
      page = await clientRef.current.threadHistory(threadId, {
        beforeSeq: current.firstSeq,
        throughSeq: current.throughSeq,
      });
    } catch (error) {
      setHistory({ ...current, loading: false });
      setHistoryError(error instanceof Error ? error.message : String(error));
      return;
    }
    if (page.kind === 'rejected') {
      setHistory({ ...current, loading: false });
      setHistoryError(page.message);
      return;
    }
    // 更早那一頁自己從空的折，再接在前面：折進現在這一份的話，它的收尾會把現在的狀態蓋掉。
    const earlier = reduceAll(emptyConversation(), page.result.events);
    advance((previous) => prependEntries(previous, earlier));
    setHistoryError(undefined);
    setHistory({
      ...current,
      firstSeq: page.result.firstSeq,
      hasMore: page.result.hasMore,
      loading: false,
    });
  }, [threadId, advance]);

  /** 記下一則回覆目前的評分；`null` 是沒有了。 */
  const keepRating = useCallback((replyId: string, item: WireFeedbackItem | null) => {
    setRatings((previous) => {
      const next = new Map(previous);
      if (item === null) next.delete(replyId);
      else next.set(replyId, item);
      return next;
    });
  }, []);

  const rate = useCallback(
    async (replyId: string, rating: WireFeedbackRating) => {
      const current = ratingsRef.current.get(replyId);
      if (current?.rating !== rating) {
        setFeedbackDialog({ target: { kind: 'reply', replyId, rating }, submitting: false });
        return;
      }
      // 再點一次已選的那顆：收回。結果不走對話框，失敗的話跟命令的失敗講在同一行。
      setSlashError(undefined);
      setSlashNotice(undefined);
      let outcome;
      try {
        outcome = await clientRef.current.feedbackDelete(threadId, {
          runId: replyId,
          ifVersion: current.version,
        });
      } catch (error) {
        setSlashError(
          `${FEEDBACK_COPY.generic}：${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      if (outcome.kind === 'rejected') {
        setCommandError(outcome.message);
        return;
      }
      if (outcome.result.ok) {
        keepRating(replyId, null);
        return;
      }
      const { error } = outcome.result;
      // 別的分頁先改了：畫上目前那筆，再說一聲（照 dsh 的 conflict 那一格）。
      if (error.code === 'version-conflict') keepRating(replyId, error.current);
      setSlashError(failureCopy(error.code));
    },
    [threadId, keepRating],
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
          const { replyId, rating } = open.target;
          const outcome = await clientRef.current.feedbackPut(threadId, {
            runId: replyId,
            rating,
            ...(text === '' ? {} : { note: text }),
            ...category,
            ifVersion: ratingsRef.current.get(replyId)?.version ?? null,
          });
          if (outcome.kind === 'rejected') {
            fail(`${FEEDBACK_COPY.generic}：${outcome.message}`);
            return;
          }
          if (!outcome.result.ok) {
            const { error } = outcome.result;
            if (error.code === 'version-conflict') keepRating(replyId, error.current);
            fail(failureCopy(error.code));
            return;
          }
          keepRating(replyId, outcome.result.value);
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
    [threadId, keepRating],
  );

  const dismissFeedback = useCallback(() => {
    setFeedbackDialog(undefined);
  }, []);

  return {
    state,
    connected,
    loadEarlier,
    ...(history === undefined
      ? {}
      : {
          history: { hasMore: history.hasMore, legacy: history.legacy, loading: history.loading },
        }),
    ...(historyError === undefined ? {} : { historyError }),
    slashCommands,
    send,
    respond,
    answer,
    cancelQuestions,
    cancel,
    replyTails: view.tails.ids,
    ratings,
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
