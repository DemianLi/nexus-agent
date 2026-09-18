/**
 * 對話的呈現。
 *
 * 四種東西：使用者說的、模型說的、工具跑的、人在核准點上按的。**最後那一種只有
 * 本地記得**——下行不回聲決定。被拒的那顆呼叫線上有一張失敗的卡，但「是人按了拒絕」
 * 只有這一則說得出來，所以兩則並存（見 `@nexus/wire` 的 `DecisionEntry`）。
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
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type {
  AnswerEntry,
  ConversationEntry,
  ConversationState,
  WireFeedbackItem,
  WireFeedbackRating,
} from '@nexus/wire';

import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { MarkdownText } from '@/components/markdown-text';
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
import { FEEDBACK_COPY, isRatable } from '@/lib/feedback';

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

/**
 * 一則問答紀錄在畫面上的那一行。
 *
 * **三格，不是「已回答：」加一個 join。** 原本一律寫「已回答：」再把 `answers` 攤開接起來，
 * 於是「放棄整組」——它的 `answers` 是空的——長出「已回答：」後面一片空白
 * （[#239](https://github.com/DemianLi/nexus-agent/issues/239) 在真瀏覽器裡量到的三處說謊
 * 之一）。而**放棄不是一種回答**：全跳過仍然是一份答案、工具正常回傳，放棄則讓工具收到
 * 錯誤，模型知道人不打算走這條路（見 `@nexus/wire` 的 `AnswerEntry.cancelled`）。畫成同
 * 一句話，就是把這兩件事在畫面上抹平。
 *
 * **第三格是防它從別的入口長回來。** 空的 `answers` 而且沒有 `cancelled` today 走不到
 * UI（問答卡送得出去的只有「逐題有交代」與「放棄整組」兩種），但 `appendAnswers` 收任何
 * 一份 `answers`、包含空陣列，型別上那條路開著。留一句說得出口的話，比留一片空白誠實。
 */
function answerSummary(entry: AnswerEntry): string {
  if (entry.cancelled === true) {
    return '放棄了這組問題——一題都沒有回答。';
  }
  if (entry.answers.length === 0) {
    return '已回答：（這一則沒有帶任何一題）';
  }
  const body = entry.answers
    .map((answer) => {
      const picked = [...answer.selected, ...(answer.custom === undefined ? [] : [answer.custom])];
      // 空的 `selected` 且沒有 `custom` ＝ 那一題被跳過（照抄 dsh 的編碼）。
      return `${answer.id}＝${picked.length === 0 ? '（跳過）' : picked.join('、')}`;
    })
    .join('，');
  return `已回答：${body}`;
}

/** 決定與問答紀錄（列 22）：置中的一顆 chip，不是對話的一則。 */
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
}: {
  entry: ConversationEntry;
  feedback?: TranscriptFeedback;
  /** 這顆工具卡帶執行中的邊框光（同時最多一個）。 */
  beam: boolean;
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
    return <Marker testId="answer-entry">{answerSummary(entry)}</Marker>;
  }

  if (entry.kind === 'tool') {
    return <ToolCard entry={entry} beam={beam} />;
  }

  const indented = entry.attribution.kind !== 'root';
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
        <Bubble variant="ghost">
          <BubbleContent className="text-body">
            <MarkdownText
              text={entry.text}
              streaming={entry.streaming}
              // 串流中只有游標在閃；狀態由狀態列講，這裡不唸（§8）。
              {...(entry.streaming ? { caret: <span className="stream-caret" aria-hidden /> } : {})}
            />
          </BubbleContent>
        </Bubble>
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
  before,
  after = [],
}: {
  state: ConversationState;
  /** 哪幾則是這一次看著它長出來的（`useFreshItems`，在常駐的元件裡算）。 */
  isFresh: (id: string) => boolean;
  feedback?: TranscriptFeedback;
  /** 列表最上面的東西（「載入更早的訊息」）。 */
  before?: ReactNode;
  /** 接在最後一則後面的（等人處理的卡片），各自帶一個 id。 */
  after?: ReadonlyArray<{ readonly id: string; readonly node: ReactNode }>;
}) {
  // 執行中的邊框光同時最多一個（§7 效能）：給最後一顆還在跑的工具。
  const beamId = state.entries.findLast(
    (entry) => entry.kind === 'tool' && entry.status === 'running',
  )?.id;
  const items = [
    ...state.entries.map((entry) => ({
      id: entry.id,
      node: (
        <Entry
          entry={entry}
          beam={entry.id === beamId}
          {...(feedback === undefined ? {} : { feedback })}
        />
      ),
    })),
    ...after,
  ];
  const announced = useFinishedReply(state.entries, isFresh);

  return (
    <MessageScrollerProvider autoScroll>
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport aria-label="對話訊息" preserveScrollOnPrepend>
          <MessageScrollerContent
            aria-live="off"
            className="mx-auto w-full max-w-2xl gap-4 px-6 pt-4 pb-10"
          >
            {before}
            {items.map((item) => (
              <MessageScrollerItem
                key={item.id}
                messageId={item.id}
                className={isFresh(item.id) ? 'motion-rise-in' : undefined}
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
    </MessageScrollerProvider>
  );
}
