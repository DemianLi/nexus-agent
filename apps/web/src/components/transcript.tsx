/**
 * 對話的呈現。
 *
 * 四種東西：使用者說的、模型說的、工具跑的、人在核准點上按的。**最後那一種只有
 * 本地記得**——下行不回聲決定。被拒的那顆呼叫線上有一張失敗的卡，但「是人按了拒絕」
 * 只有這一則說得出來，所以兩則並存（見 `@nexus/wire` 的 `DecisionEntry`）。
 *
 * 人答的問題也只有本地記得，但**不自成一則**：答案列在配到的那張提問卡上（`pairAnswers`，§4.3，#409）。
 *
 * 交付也不在原位畫：同一輪 `present` 成功交付的檔案收攏成一張卡，放在這一輪尾端（`transcriptItems`，#441）。
 *
 * 模型的推理畫在它那則回覆的泡泡上方，預設收合（`ReasoningRow`，#527）。
 *
 * 模型與工具都可能來自 subagent，
 * 而**歸屬是折疊器 join 出來的**——線上沒有 subagent 的名字，只有 namespace 樹
 * （見 `@nexus/wire` 的 `conversation.ts`）。join 不起來的時候它說「未歸屬」，
 * 這裡就照樣顯示未歸屬：**寧可說不知道，不要說錯**。
 *
 * 外殼是 shadcn `message-scroller`＋`message`／`bubble`（規格 §4.2 列 9–11）；助理回覆走自建 markdown
 * （`markdown-text.tsx`，#405），使用者說的照原文畫（人打的字不當 markdown 解）。
 */

import { ArrowDown, ThumbsDown, ThumbsUp } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type {
  AnswerEntry,
  ConversationEntry,
  ConversationState,
  WireFeedbackItem,
  WireFeedbackRating,
} from '@nexus/wire';

import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { ChangesCard } from '@/components/changes-card';
import { DeliverablesCard } from '@/components/deliverables-card';
import { EarlierPager, earlierLoadedNotice, useEarlierAutoLoad } from '@/components/earlier-pager';
import type { EarlierHistory } from '@/components/earlier-pager';
import { MarkdownText } from '@/components/markdown-text';
import { ReasoningRow } from '@/components/reasoning-row';
import { AttributionBadge, ToolCard } from '@/components/tool-card';
import { Button } from '@/components/ui/button';
import { Message, MessageContent, MessageFooter, MessageHeader } from '@/components/ui/message';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ui/message-scroller';
import type { ChangesStores } from '@/lib/changes-diff';
import type { DeliverableDownloader } from '@/lib/deliverable-download';
import { transcriptItems } from '@/lib/deliverables-view';
import { FEEDBACK_COPY, isRatable } from '@/lib/feedback';
import { pairAnswers } from '@/lib/question-view';
import { reasoningRunning, visibleReasoning } from '@/lib/reasoning-view';

/**
 * 評分按鈕要的東西（[#278](https://github.com/DemianLi/nexus-agent/issues/278)、
 * [#382](https://github.com/DemianLi/nexus-agent/issues/382)）。放哪幾則由折疊器的 `turnTail` 決定（見
 * `isRatable`），這裡只畫。
 */
export interface TranscriptFeedback {
  /** 訊息 id → 目前那一筆。 */
  readonly ratings: ReadonlyMap<string, WireFeedbackItem>;
  readonly busy: boolean;
  /** 讀回評分失敗了：按鈕旁邊講一句（dsh 的 `error.load`）。 */
  readonly loadFailed: boolean;
  /** 第一次滑過或聚焦讚踩時讀回評分，照 dsh 的 `seed`。 */
  onSeed(): void;
  onRate(messageId: string, rating: WireFeedbackRating): void;
}

/**
 * 一則回覆底下的讚與踩。**已選的那顆實心、`aria-pressed`**，再點一次就是收回；另一顆開對話框
 * （照 dsh 的 `MessageFeedbackActions`）。
 */
function RatingButtons({
  messageId,
  feedback,
}: {
  messageId: string;
  feedback: TranscriptFeedback;
}) {
  const rating = feedback.ratings.get(messageId)?.rating;
  const likeLabel = rating === 'positive' ? FEEDBACK_COPY.likeActive : FEEDBACK_COPY.like;
  const dislikeLabel = rating === 'negative' ? FEEDBACK_COPY.dislikeActive : FEEDBACK_COPY.dislike;
  return (
    <div className="flex items-center gap-1" data-testid="rating-buttons">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7"
        title={likeLabel}
        aria-label={likeLabel}
        aria-pressed={rating === 'positive'}
        disabled={feedback.busy}
        onPointerEnter={feedback.onSeed}
        onFocus={feedback.onSeed}
        onClick={() => feedback.onRate(messageId, 'positive')}
      >
        <ThumbsUp className={rating === 'positive' ? 'fill-current' : undefined} />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7"
        title={dislikeLabel}
        aria-label={dislikeLabel}
        aria-pressed={rating === 'negative'}
        disabled={feedback.busy}
        onPointerEnter={feedback.onSeed}
        onFocus={feedback.onSeed}
        onClick={() => feedback.onRate(messageId, 'negative')}
      >
        <ThumbsDown className={rating === 'negative' ? 'fill-current' : undefined} />
      </Button>
      {feedback.loadFailed && (
        <span className="text-muted-foreground text-xs" role="status">
          {FEEDBACK_COPY.load}
        </span>
      )}
    </div>
  );
}

/** 決定紀錄（列 22）：置中的一顆 chip，不是對話的一則。 */
function Marker({ children, testId }: { children: string; testId: string }) {
  return (
    <div className="flex justify-center">
      <p
        className="text-muted-foreground bg-chip rounded-full px-3 py-1 text-xs"
        data-testid={testId}
      >
        {children}
      </p>
    </div>
  );
}

function Entry({
  entry,
  feedback,
  beam,
  answer,
}: {
  entry: ConversationEntry;
  feedback?: TranscriptFeedback;
  /** 這顆工具卡帶執行中的邊框光（同時最多一個）。 */
  beam: boolean;
  /** 配到這張提問卡的答案。 */
  answer?: AnswerEntry;
}) {
  if (entry.kind === 'human') {
    return (
      <Message align="end">
        <MessageContent>
          <Bubble variant="secondary" align="end">
            <BubbleContent className="text-body rounded-3xl px-4 py-2.5 whitespace-pre-wrap">
              {entry.text}
            </BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
    );
  }

  if (entry.kind === 'decision') {
    const approved = entry.decision === 'approve';
    return (
      <Marker testId="decision-entry">
        {`${approved ? '已核准' : entry.decision === 'reject' ? '已拒絕' : entry.decision}：${entry.actions.join('、')}${approved ? '' : '（沒有執行）'}`}
      </Marker>
    );
  }

  if (entry.kind === 'answer') {
    // 不自己畫：答案列在配到的那張提問卡上（`pairAnswers`，§4.3）。列表也不給它一格。
    return null;
  }

  if (entry.kind === 'deliverables' || entry.kind === 'workspace-changes') {
    // 不在原位畫：改動與交付收到這一輪尾端（`transcriptItems`，#441、#443）。
    return null;
  }

  if (entry.kind === 'tool') {
    return <ToolCard entry={entry} beam={beam} {...(answer === undefined ? {} : { answer })} />;
  }

  const reasoning = visibleReasoning(entry);
  // 正文只有空白也算空：模型呼叫工具前常先吐一段 `"\n\n"`，畫出來是一顆空泡泡（#527 驗收時量到）。
  const hasText = entry.text.trim() !== '';
  if (
    !hasText &&
    reasoning === undefined &&
    !entry.streaming &&
    entry.stopped !== true &&
    entry.error === undefined
  ) {
    // 講完了、沒正文、沒推理、沒被打斷、沒出錯，沒有東西可畫；畫出來是一顆空泡泡（#565）。
    return null;
  }

  const indented = entry.attribution.kind !== 'root';
  // **有推理時，正文空就不畫泡泡**（#527）：只想、只呼叫工具的那幾步只剩推理列；串流中也一樣，推理列在長，
  // 就是模型在動的訊號，不必再疊一顆帶游標的空泡泡。沒有推理的照舊。
  const bubble = hasText || reasoning === undefined;
  return (
    <Message
      align="start"
      className={indented ? 'border-border ml-4 border-l pl-3' : undefined}
      data-testid="ai-entry"
    >
      <MessageContent>
        {indented && (
          <MessageHeader className="px-0">
            <AttributionBadge attribution={entry.attribution} />
          </MessageHeader>
        )}
        {reasoning !== undefined && (
          <ReasoningRow text={reasoning} running={reasoningRunning(entry)} />
        )}
        {bubble && (
          <Bubble variant="ghost">
            <BubbleContent className="text-body">
              <MarkdownText
                text={entry.text}
                streaming={entry.streaming}
                // 串流中只有游標在閃；狀態由狀態列講，這裡不唸（§8）。
                {...(entry.streaming
                  ? { caret: <span className="stream-caret" aria-hidden /> }
                  : {})}
              />
            </BubbleContent>
          </Bubble>
        )}
        {/* 講到一半被人按了停止（#276）。不是失敗，所以不用紅字。 */}
        {entry.stopped === true && <MessageFooter className="px-0">（已停止）</MessageFooter>}
        {entry.error !== undefined && <p className="text-destructive text-xs">{entry.error}</p>}
        {feedback !== undefined && isRatable(entry) && (
          <RatingButtons messageId={entry.messageId} feedback={feedback} />
        )}
      </MessageContent>
    </Message>
  );
}

/**
 * 哪幾則（含等人處理的卡片）是**這一次看著它長出來的**：只有這些做進場動效（往上 8px，§7）、講完時唸一次（§8）。
 *
 * 不算的：第一次連上時已經在的（重播的歷史，而折疊器把歷史與 `connected` 在同一次 render 交出來，所以連上那一格
 * 看到的全算歷史）、連上前就在的、以及插在已知那幾則**前面**的（往回捲載入的更早歷史）。切換對話整個重掛，
 * 所以也不動。
 *
 * **要在常駐的元件裡呼叫**（`ConversationView`），不是在 `Transcript` 裡：對話還空著時畫的是 hero、`Transcript`
 * 還沒掛上，第一句話出現時它才掛——在它裡面判，第一句會被當成「連上時已經在的」。
 */
export function useFreshItems(ids: readonly string[], connected: boolean) {
  const fresh = useRef(new Map<string, boolean>());
  const settled = useRef(false);
  const live = connected && settled.current;
  let lastKnown = -1;
  ids.forEach((id, index) => {
    if (fresh.current.has(id)) lastKnown = index;
  });
  ids.forEach((id, index) => {
    if (!fresh.current.has(id)) fresh.current.set(id, live && index > lastKnown);
  });
  if (connected) settled.current = true;
  return (id: string) => fresh.current.get(id) === true;
}

/** 串流不逐字唸（`role="log"` 關掉 live），一則回覆講完時把全文丟進 polite 區唸一次（§8）。 */
function useFinishedReply(entries: readonly ConversationEntry[], isFresh: (id: string) => boolean) {
  const [announced, setAnnounced] = useState('');
  const done = useRef(new Set<string>());
  useEffect(() => {
    for (const entry of entries) {
      if (entry.kind !== 'ai' || entry.streaming || entry.text === '') continue;
      if (!isFresh(entry.id) || done.current.has(entry.id)) continue;
      done.current.add(entry.id);
      setAnnounced(entry.text);
    }
  }, [entries, isFresh]);
  return announced;
}

/** JS 的捲動不看 CSS 的 reduced-motion，要自己讀（§7）。 */
function scrollBehavior(): ScrollBehavior {
  const reduce =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return reduce ? 'auto' : 'smooth';
}

export function Transcript({
  state,
  isFresh,
  feedback,
  earlier,
  changes,
  deliverableDownload,
}: {
  state: ConversationState;
  /** 哪幾則是這一次看著它長出來的（`useFreshItems`，在常駐的元件裡算）。 */
  isFresh: (id: string) => boolean;
  feedback?: TranscriptFeedback;
  /** 往前翻（`earlier-pager.tsx`）。沒給就沒有按鈕、也不自動載入。 */
  earlier?: EarlierHistory;
  /** 改動的摘要與比較從哪裡讀（#443）。沒給就不畫改動卡。 */
  changes?: ChangesStores;
  /**
   * 交付檔的下載（#452 第三刀）。沒給就不畫下載鈕——**但交付卡照畫**，它其餘的部分（檔名、說明、複製路徑）
   * 不需要讀檔。預覽鈕看有沒有右側欄（#640）。這一點跟改動卡相反：那一張沒有摘要就整張沒有內容。
   */
  deliverableDownload?: DeliverableDownloader;
}) {
  // 執行中的邊框光同時最多一個（§7 效能）：給最後一顆還在跑的工具。
  const beamId = state.entries.findLast(
    (entry) => entry.kind === 'tool' && entry.status === 'running',
  )?.id;
  const answers = useMemo(() => pairAnswers(state.entries), [state.entries]);
  const items = transcriptItems(state.entries).flatMap((item) => {
    if (item.kind === 'changes') {
      return changes === undefined
        ? []
        : [{ id: item.id, node: <ChangesCard seq={item.seq} changes={changes} /> }];
    }
    if (item.kind === 'deliverables') {
      return {
        id: item.id,
        node: <DeliverablesCard files={item.files} download={deliverableDownload} />,
      };
    }
    const { entry } = item;
    const answer = answers.get(entry.id);
    return {
      id: entry.id,
      node: (
        <Entry
          entry={entry}
          beam={entry.id === beamId}
          {...(feedback === undefined ? {} : { feedback })}
          {...(answer === undefined ? {} : { answer })}
        />
      ),
    };
  });
  const announced = useFinishedReply(state.entries, isFresh);
  const autoLoad = useEarlierAutoLoad(earlier);

  return (
    <MessageScrollerProvider autoScroll>
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport aria-label="對話訊息" preserveScrollOnPrepend {...autoLoad}>
          {/* 在 content 外面，prepend 保位才動得了手（見 `earlier-pager.tsx`）。 */}
          {earlier?.hasMore === true && <EarlierPager earlier={earlier} />}
          <MessageScrollerContent
            aria-live="off"
            className="mx-auto w-full max-w-2xl gap-4 px-6 pt-4 pb-10"
          >
            {items.map((item) => (
              <MessageScrollerItem
                key={item.id}
                messageId={item.id}
                // 卡片可能什麼都不畫（改動摘要 404，#443）：空的那一格不佔列表的間距。
                className={isFresh(item.id) ? 'motion-rise-in empty:hidden' : 'empty:hidden'}
              >
                {item.node}
              </MessageScrollerItem>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton className="rounded-full" behavior={scrollBehavior()}>
          <ArrowDown />
          <span className="sr-only">捲到最新的訊息</span>
        </MessageScrollerButton>
      </MessageScroller>
      <p aria-live="polite" className="sr-only">
        {announced}
      </p>
      {/* 另一格：跟「回覆完成」那一句分開，互不蓋掉。按鈕翻到底收掉之後這一格還在，最後一頁也唸得到。 */}
      <p aria-live="polite" className="sr-only" data-testid="earlier-notice">
        {earlierLoadedNotice(earlier?.loaded)}
      </p>
    </MessageScrollerProvider>
  );
}
