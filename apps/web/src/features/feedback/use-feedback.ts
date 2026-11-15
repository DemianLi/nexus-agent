import type {
  WireClient,
  WireFeedbackCategory,
  WireFeedbackItem,
  WireFeedbackRating,
} from '@nexus/wire';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Conversation } from '@/shared/connection/use-conversation';

import { FEEDBACK_COPY } from './feedback';
import { RatingsController } from './ratings';
import type { RatingsView } from './ratings';

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

export interface UseFeedbackOptions {
  readonly client: WireClient;
  readonly threadId: string;
  /** {@link Conversation.connections}：每次下行接上就加一，評分靠它在重連時重讀。 */
  readonly connections: number;
  /** {@link Conversation.setStatusLine}：收回評分失敗與送出之後的謝謝，講在狀態列上。 */
  readonly setStatusLine: Conversation['setStatusLine'];
}

export interface Feedback {
  /**
   * 這條 thread 目前的評分，以訊息 id（`AiEntry.messageId`）為鍵（[#382](https://github.com/DemianLi/nexus-agent/issues/382)）。
   * **第一次 {@link Feedback.seedRatings} 之前是空的**，照 dsh。
   */
  readonly ratings: ReadonlyMap<string, WireFeedbackItem>;
  /** 讀回評分失敗了（dsh 的 `error.load`）。下一次滑過或按下去會再試。 */
  readonly ratingsLoadFailed: boolean;
  /**
   * 這台伺服器不收評分（`not_supported`，[#1849](https://github.com/DemianLi/nexus-agent/issues/1849)）：讚踩停用、講原因，按下去不開對話框。
   * 重連之後重讀，讀得到就恢復。評語（只打 `/feedback`）不受影響。
   */
  readonly ratingsUnsupported: boolean;
  /** 讀回這條 thread 的評分，讀過就不再讀。畫面掛在讚踩的第一次滑過或聚焦上。 */
  seedRatings(): void;
  readonly feedbackDialog?: FeedbackDialogState;
  /**
   * 按了一則回覆的讚或踩。**再點已選的那顆是收回**，另一顆開對話框，送出之後才記（照 dsh）。
   * 先等讀回評分：還沒滑過就直接按的話，看到的也是存著的那一筆。
   */
  rate(messageId: string, rating: WireFeedbackRating): Promise<void>;
  /** 對整個會話開回饋對話框（只打了 `/feedback`，接在 `UseConversationOptions.onFeedbackCommand` 上）。 */
  openSessionDialog(): void;
  /** 送出回饋對話框。可以空著送。 */
  submitFeedback(draft: {
    readonly category?: WireFeedbackCategory;
    readonly text: string;
  }): Promise<void>;
  dismissFeedback(): void;
}

/**
 * 一條 thread 的評分與回饋對話框。
 *
 * **一條 thread 一個**：換 thread 時整個 view 重掛（`app/App.tsx` 的 `key`），不會拿著上一條的評分。
 */
export function useFeedback({
  client,
  threadId,
  connections,
  setStatusLine,
}: UseFeedbackOptions): Feedback {
  const [ratingsView, setRatingsView] = useState<RatingsView>(() => ({
    status: 'cold',
    items: new Map(),
  }));
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
  const dialogRef = useRef(feedbackDialog);
  dialogRef.current = feedbackDialog;
  const clientRef = useRef(client);
  clientRef.current = client;

  // **讀過的評分重讀一次**（#772），照 dsh 的 `connection/reset`：每次連上都發、第一次也算，評分外掛只重讀
  // 不是 `cold` 的那份，冷的等人滑過再讀。斷線期間別的分頁可能改過；走 `resync` 排在路上的修改後面，
  // 晚回來的舊清單才不會蓋掉剛寫進去的版本。
  useEffect(() => {
    if (connections === 0) return;
    if (ratingsController.view.status !== 'cold') void ratingsController.resync();
  }, [connections, ratingsController]);

  const seedRatings = useCallback(() => {
    void ratingsController.ensure();
  }, [ratingsController]);

  const rate = useCallback(
    async (messageId: string, rating: WireFeedbackRating) => {
      const loaded = await ratingsController.ensure();
      // 伺服器不收評分（#1849）：不開對話框，免得填完送出才報錯。畫面那側已經停用了，這裡是保險（滑過與按下是同一下的觸控）。
      if (ratingsController.view.status === 'unsupported') return;
      if (!loaded.ok || ratingsController.view.items.get(messageId)?.rating !== rating) {
        setFeedbackDialog({ target: { kind: 'reply', messageId, rating }, submitting: false });
        return;
      }
      // 再點一次已選的那顆：收回。結果不走對話框，失敗的話跟命令的失敗講在同一行。
      setStatusLine({});
      const result = await ratingsController.retract(messageId, rating);
      if (!result.ok) setStatusLine({ error: result.failure });
    },
    [ratingsController, setStatusLine],
  );

  const openSessionDialog = useCallback(() => {
    setFeedbackDialog({ target: { kind: 'session' }, submitting: false });
  }, []);

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
      // 送出之後的那句謝謝跟命令的結果講在同一行：兩者都是「這一側要說的話」，不進 transcript。
      setStatusLine({ notice: FEEDBACK_COPY.recorded });
    },
    [threadId, ratingsController, setStatusLine],
  );

  const dismissFeedback = useCallback(() => {
    setFeedbackDialog(undefined);
  }, []);

  return {
    ratings: ratingsView.items,
    ratingsLoadFailed: ratingsView.status === 'failed',
    ratingsUnsupported: ratingsView.status === 'unsupported',
    seedRatings,
    rate,
    openSessionDialog,
    submitFeedback,
    dismissFeedback,
    ...(feedbackDialog === undefined ? {} : { feedbackDialog }),
  };
}
