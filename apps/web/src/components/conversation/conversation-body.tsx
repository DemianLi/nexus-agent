/**
 * 對話區的中段（空白頁或對話紀錄），從 `App.tsx` 的會話畫面拆出來，獨立頁面與嵌入版共用（#2366）。
 */

import { EmptyHero } from '@/components/empty-hero';
import { AttachmentImageContext } from '@/components/sent-attachments';
import { SessionReferenceContext } from '@/components/session-reference';
import type { SessionReferenceLinks } from '@/components/session-reference';
import { SubagentControlContext } from '@/components/tool/subagent-control';
import type { SubagentControl } from '@/components/tool/subagent-control';
import { Transcript } from '@/components/transcript';
import type { TranscriptFork } from '@/components/transcript';
import type { Conversation } from '@/hooks/use-conversation';
import type { AttachmentImageSource } from '@/lib/attachment-image';
import type { ChangesStores } from '@/lib/changes-diff';
import type { DeliverableDownloader } from '@/lib/deliverable-download';

/**
 * 對話區的中段：還沒有任何一則就是空白頁，否則是對話紀錄，連同它讀的三個 context（會話引用、送出過的圖、子代理）。
 *
 * @param hasSteers - 有排著的插話（#710）：就算這一輪是從還沒有任何一則的地方跑起來的，也有東西可畫。
 * @param fork - 分支鈕（#1581）。沒給就不畫。
 * @param changes - 改動卡從哪裡讀（#443）。沒給就不畫改動卡。
 * @param fileDrop - 空白頁提不提「把檔案拖進來」，見 {@link EmptyHero}。
 */
export function ConversationBody({
  conversation,
  isFresh,
  hasSteers,
  sessionLinks,
  imageSource,
  subagentControl,
  changes,
  deliverableDownload,
  fork,
  fileDrop,
}: {
  readonly conversation: Conversation;
  readonly isFresh: (id: string) => boolean;
  readonly hasSteers: boolean;
  readonly sessionLinks: SessionReferenceLinks;
  readonly imageSource: AttachmentImageSource;
  readonly subagentControl: SubagentControl;
  readonly changes?: ChangesStores;
  readonly deliverableDownload: DeliverableDownloader;
  readonly fork?: TranscriptFork;
  readonly fileDrop?: boolean;
}) {
  if (conversation.state.entries.length === 0 && !hasSteers) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6">
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
            feedback={{
              ratings: conversation.ratings,
              busy: !conversation.connected,
              loadFailed: conversation.ratingsLoadFailed,
              unsupported: conversation.ratingsUnsupported,
              onSeed: conversation.seedRatings,
              onRate: (messageId, rating) => void conversation.rate(messageId, rating),
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
