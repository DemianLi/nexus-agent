/**
 * 對話區的中段（空白頁或對話紀錄），從 `app/App.tsx` 的會話畫面拆出來，獨立頁面與嵌入版共用（#2366）。
 */

import { EmptyHero } from '@/features/transcript/empty-hero';
import { AttachmentImageContext, type AttachmentImageSource } from '@/features/attachments';
import { SessionReferenceContext } from '@/features/transcript/session-reference';
import type { SessionReferenceLinks } from '@/features/transcript/session-reference';
import { SubagentControlContext, type SubagentControl } from '@/features/tool';
import { Transcript } from '@/features/transcript/transcript';
import type { TranscriptFork } from '@/features/transcript/transcript';
import type { Conversation } from '@/shared/connection/use-conversation';
import type { ChangesStores } from '@/features/changes';
import type { DeliverableDownloader } from '@/features/deliverable';
import type { Feedback } from '@/features/feedback';
import { useReplayedIds } from '@/features/transcript/replay-end';
import type { ReplayEnd } from '@/features/transcript/replay-end';
import { refusalText } from '@/shared/connection/refusal-text';

/**
 * 對話區的中段：還沒有任何一則就是空白頁，否則是對話紀錄，連同它讀的三個 context（會話引用、送出過的圖、子代理）。
 *
 * @param hasSteers - 有排著的插話（#710）：就算這一輪是從還沒有任何一則的地方跑起來的，也有東西可畫。
 * @param fork - 分支鈕（#1581）。沒給就不畫。
 * @param changes - 改動卡從哪裡讀（#443）。沒給就不畫改動卡。
 * @param fileDrop - 空白頁提不提「把檔案拖進來」，見 {@link EmptyHero}。
 * @param replayEnd - 重播結尾那條線畫哪一種（`replay-end.tsx`）。沒給就不畫。
 */
export function ConversationBody({
  conversation,
  feedback,
  isFresh,
  hasSteers,
  sessionLinks,
  imageSource,
  subagentControl,
  changes,
  deliverableDownload,
  fork,
  fileDrop,
  replayEnd,
}: {
  readonly conversation: Pick<
    Conversation,
    'state' | 'connected' | 'history' | 'historyError' | 'loadEarlier'
  >;
  /** 評分與回饋對話框，由組裝層從 `useFeedback` 傳進來。 */
  readonly feedback: Feedback;
  readonly isFresh: (id: string) => boolean;
  readonly hasSteers: boolean;
  readonly sessionLinks: SessionReferenceLinks;
  readonly imageSource: AttachmentImageSource;
  readonly subagentControl: SubagentControl;
  readonly changes?: ChangesStores;
  readonly deliverableDownload: DeliverableDownloader;
  readonly fork?: TranscriptFork;
  readonly fileDrop?: boolean;
  readonly replayEnd?: ReplayEnd;
}) {
  const replayed = useReplayedIds(conversation.history !== undefined, conversation.state.entries);
  const historyError =
    conversation.historyError === undefined ? undefined : (
      <HistoryError error={conversation.historyError} />
    );
  if (conversation.state.entries.length === 0 && !hasSteers) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6">
        {historyError !== undefined && (
          <div className="mx-auto w-full max-w-2xl pt-4">{historyError}</div>
        )}
        <EmptyHero {...(fileDrop === undefined ? {} : { fileDrop })} />
      </div>
    );
  }
  return (
    <SessionReferenceContext.Provider value={sessionLinks}>
      <AttachmentImageContext.Provider value={imageSource}>
        <SubagentControlContext.Provider value={subagentControl}>
          <Transcript
            state={conversation.state}
            isFresh={isFresh}
            {...(changes === undefined ? {} : { changes })}
            deliverableDownload={deliverableDownload}
            {...(fork === undefined ? {} : { fork })}
            {...(replayEnd === undefined || replayed === undefined
              ? {}
              : { replay: { ids: replayed, end: replayEnd } })}
            {...(historyError === undefined ? {} : { head: historyError })}
            feedback={{
              ratings: feedback.ratings,
              busy: !conversation.connected,
              loadFailed: feedback.ratingsLoadFailed,
              unsupported: feedback.ratingsUnsupported,
              onSeed: feedback.seedRatings,
              onRate: (messageId, rating) => void feedback.rate(messageId, rating),
            }}
            {...(conversation.history === undefined
              ? {}
              : {
                  earlier: {
                    ...conversation.history,
                    onLoad: () => void conversation.loadEarlier(),
                  },
                })}
          />
        </SubagentControlContext.Provider>
      </AttachmentImageContext.Provider>
    </SessionReferenceContext.Provider>
  );
}

/**
 * 第一頁歷史拿不回來的那一句，畫在對話最上面，也就是重播歷史該在的位置。thread 數滿了、歷史太深、日誌超過額度、被別處握著、
 * 開在別的 home 或工作區都不是歷史掉了：換成那一句，不加前綴（#1478、#1753、#2203、#2214、#2222）。
 */
function HistoryError({ error }: { error: NonNullable<Conversation['historyError']> }) {
  return (
    <p className="text-destructive text-tip" data-testid="history-error">
      {refusalText(error.code, 'reading') ?? `之前說過的話拿不回來：${error.message}`}
    </p>
  );
}
