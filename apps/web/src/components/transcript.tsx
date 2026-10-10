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

import { Activity, ArrowDown, ThumbsDown, ThumbsUp } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import type {
  AnswerEntry,
  ConversationEntry,
  ConversationState,
  SubagentMention,
  WireAttachmentRef,
  WireFeedbackItem,
  WireFeedbackRating,
} from '@nexus/wire';

import { DelegatedChip } from '@/components/delegated-chip';
import { SentAttachments } from '@/components/sent-attachments';
import { ReferencedText } from '@/components/session-reference';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { ChatBubble } from '@/components/chat-bubble';
import { ChangesCard } from '@/components/changes/card';
import { CopyButton } from '@/components/copy-button';
import { CompactionRow } from '@/components/compaction-row';
import { DeliverablesCard } from '@/components/deliverable/card';
import { EarlierPager, earlierLoadedNotice, useEarlierAutoLoad } from '@/components/earlier-pager';
import type { EarlierHistory } from '@/components/earlier-pager';
import { MarkdownText } from '@/components/markdown-text';
import { PlanToolCard } from '@/components/plan/review';
import { ReasoningRow } from '@/components/reasoning-row';
import { useRightSidebar } from '@/components/sidebar/right-sidebar-context';
import { AttributionBadge, ToolCard } from '@/components/tool/card';
import { Button } from '@/components/ui/button';
import { Message, MessageContent, MessageFooter, MessageHeader } from '@/components/ui/message';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from '@/components/ui/message-scroller';
import { mentionDisplayText } from '@/lib/session-mention';
import type { ChangesStores } from '@/lib/changes-diff';
import type { DeliverableDownloader } from '@/lib/deliverable-download';
import { decisionText } from '@/lib/decision-view';
import { transcriptItems } from '@/lib/deliverables-view';
import { registerTranscriptScroller } from '@/lib/transcript-locate';
import { FEEDBACK_COPY, isRatable } from '@/lib/feedback';
import { RetryNotice } from '@/components/retry-notice';
import { useScrollButtonClearance } from '@/hooks/use-scroll-button-clearance';
import { MAX_TOKENS_NOTICE } from '@/lib/max-tokens-view';
import { EXIT_PLAN_MODE } from '@/lib/plan-review';
import { BLOCKED_HINT_TEXT } from '@/lib/archived-view';
import { settledNoticeText } from '@/lib/queue-view';
import { pairAnswers } from '@/lib/question-view';
import { agentMessageCaption, subagentLabel, subagentNames as namesOf } from '@/lib/subagent-view';
import { reasoningRunning, visibleReasoning } from '@/lib/reasoning-view';
import { pendingAgentText, pendingSteers, pendingSteerText } from '@/lib/steer-view';

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
 *
 * 旁邊的「這一輪的過程」（#1031，#1017 Q3 ③）打開右側欄的觀測分頁、捲到這一則回覆所在的那一輪並標示（#1034，`revealReply`；
 * 那一輪不在軌跡窗口裡時分頁會講明白）。對每一則評得了的回覆都一樣，不只倒讚的。它跟著讚踩列
 * 一起出現，所以沒有評分外掛的部署、以及講到一半被停下來的那一輪（`isRatable` 為否）都看不到；沒有右側欄時不畫。
 */
function RatingButtons({
  messageId,
  feedback,
}: {
  messageId: string;
  feedback: TranscriptFeedback;
}) {
  const sidebar = useRightSidebar();
  const rating = feedback.ratings.get(messageId)?.rating;
  const likeLabel = rating === 'positive' ? FEEDBACK_COPY.likeActive : FEEDBACK_COPY.like;
  const dislikeLabel = rating === 'negative' ? FEEDBACK_COPY.dislikeActive : FEEDBACK_COPY.dislike;
  // 載入失敗那句掛在兩顆鈕的描述上（同 `plan/chip`），不開 live region（#1290）：它是背景載入失敗，不是人剛做的事的結果。
  const loadFailedId = useId();
  const describedBy = feedback.loadFailed ? loadFailedId : undefined;
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
        aria-describedby={describedBy}
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
        aria-describedby={describedBy}
        disabled={feedback.busy}
        onPointerEnter={feedback.onSeed}
        onFocus={feedback.onSeed}
        onClick={() => feedback.onRate(messageId, 'negative')}
      >
        <ThumbsDown className={rating === 'negative' ? 'fill-current' : undefined} />
      </Button>
      {sidebar !== undefined && (
        <Button
          type="button"
          variant="ghost"
          className="text-muted-foreground h-7 gap-1.5 px-2 text-ui"
          data-testid="turn-trace"
          onClick={(event) => sidebar.revealReply(messageId, event.currentTarget)}
        >
          <Activity aria-hidden className="size-3.5" />
          這一輪的過程
        </Button>
      )}
      {feedback.loadFailed && (
        <span id={loadFailedId} className="text-muted-foreground text-tip">
          {FEEDBACK_COPY.load}
        </span>
      )}
    </div>
  );
}

/** 一則回覆的「複製回覆」（#1305）：複製的是 markdown 原文，貼進信件或文件時格式還在。 */
function ReplyCopyButton({ text }: { text: string }) {
  return (
    <CopyButton
      text={text}
      label="複製回覆"
      copied={{ title: '已複製回覆' }}
      failed={{
        title: '沒辦法複製回覆',
        description: '瀏覽器不讓這個頁面寫剪貼簿，請手動選取文字。',
      }}
      className="size-7"
    />
  );
}

/** 決定紀錄（列 22）：置中的一顆 chip，不是對話的一則。 */
function Marker({ children, testId }: { children: string; testId: string }) {
  return (
    <div className="flex justify-center">
      <p
        className="text-muted-foreground bg-chip rounded-full px-3 py-1 text-tip"
        data-testid={testId}
      >
        {children}
      </p>
    </div>
  );
}

/** 單則項目的畫法。背景子代理自己的對話（`subagent-control.tsx`）也用它，所以兩邊長得一樣。 */
export function Entry({
  entry,
  feedback,
  beam,
  answer,
  subagentNames,
}: {
  entry: ConversationEntry;
  feedback?: TranscriptFeedback;
  /** 這顆工具卡帶執行中的邊框光（同時最多一個）。 */
  beam: boolean;
  /** 配到這張提問卡的答案。 */
  answer?: AnswerEntry;
  /** 背景子代理的編號 → 名字（`lib/subagent-view.ts`）。 */
  subagentNames: ReadonlyMap<string, string>;
}) {
  if (entry.kind === 'human') {
    return (
      <Message align="end">
        <MessageContent>
          {/* 這一句帶的附件（#732）：標籤排在泡泡上方；只有附件、沒有字的那一句不畫空泡泡。模型已看不到的那幾件另有標記（#1270）。 */}
          <SentAttachments attachments={entry.attachments} omitted={entry.omittedAttachments} />
          {/* 這一句點名派的子代理（#328 第 2 項）：chip 在泡泡上方；`text` 不含點名字樣，標記從 `mention` 畫。 */}
          {entry.mention !== undefined && <DelegatedChip name={entry.mention.name} />}
          {entry.text.trim() !== '' && (
            <ChatBubble>
              <ReferencedText text={entry.text} references={entry.references} />
            </ChatBubble>
          )}
          {/* 被準入閘門擋下的那一句（封存的會話，#633）：泡泡照畫，底下一句中性的提示（不是錯誤、不畫紅）：話沒有送給模型。 */}
          {entry.blocked === true && (
            <MessageFooter className="px-0" data-testid="blocked-hint">
              {BLOCKED_HINT_TEXT}
            </MessageFooter>
          )}
        </MessageContent>
      </Message>
    );
  }

  if (entry.kind === 'decision') {
    return <Marker testId="decision-entry">{decisionText(entry)}</Marker>;
  }

  if (entry.kind === 'answer') {
    // 不自己畫：答案列在配到的那張提問卡上（`pairAnswers`，§4.3）。列表也不給它一格。
    return null;
  }

  if (entry.kind === 'deliverables' || entry.kind === 'workspace-changes') {
    // 不在原位畫：改動與交付收到這一輪尾端（`transcriptItems`，#441、#443）。
    return null;
  }

  if (entry.kind === 'notice') {
    // 折疊器長出來的「這一輪是被什麼叫醒的」（#851）：背景子代理結算的通知，不是人的話。id 跟排著時那一行同一個
    // （`inbox:<件 id>`），同一格換成正式的；歷史重播長出來的（`history-<seq>`）畫成同一個樣子。
    return <SettledNotice caption={settledNoticeText(entry.reason)} />;
  }

  if (entry.kind === 'agent-message') {
    // 背景子代理寫來的話（#863、#861）：不是人的泡泡，也不是模型的回覆。寄件人從委派卡對回名字。
    return (
      <AgentMessageCard
        caption={agentMessageCaption(subagentLabel(subagentNames, entry.runId))}
        text={entry.text}
      />
    );
  }

  if (entry.kind === 'tool') {
    // 交出計劃的那一顆畫成計劃卡（#654）。
    if (entry.name === EXIT_PLAN_MODE) return <PlanToolCard entry={entry} beam={beam} />;
    return (
      <ToolCard
        entry={entry}
        beam={beam}
        subagentNames={subagentNames}
        {...(answer === undefined ? {} : { answer })}
      />
    );
  }

  if (entry.kind === 'compaction') {
    // 模型的歷史在這裡換成了摘要（#944）：落在觸發它的那則回覆之後，不取代被蓋掉的列。
    return <CompactionRow entry={entry} />;
  }

  // 到這裡只剩模型的回覆：線上的項目種類以後還會長，不認得的不畫，免得往下讀 `entry.text` 炸掉。
  if (entry.kind !== 'ai') return null;

  const reasoning = visibleReasoning(entry);
  // 正文只有空白也算空：模型呼叫工具前常先吐一段 `"\n\n"`，畫出來是一顆空泡泡（#527 驗收時量到）。
  const hasText = entry.text.trim() !== '';
  if (
    !hasText &&
    reasoning === undefined &&
    !entry.streaming &&
    entry.stopped !== true &&
    entry.maxTokens !== true &&
    entry.error === undefined
  ) {
    // 講完了、沒正文、沒推理、沒被打斷、沒出錯，沒有東西可畫；畫出來是一顆空泡泡（#565）。
    return null;
  }

  const indented = entry.attribution.kind !== 'root';
  // **有推理時，正文空就不畫泡泡**（#527）：只想、只呼叫工具的那幾步只剩推理列；串流中也一樣，推理列在長，
  // 就是模型在動的訊號，不必再疊一顆帶游標的空泡泡。沒有推理的照舊。
  // 撞到輸出上限而沒字的那則（只在寫工具參數時被切斷）只畫底下那行提示，不畫空泡泡（#608）。
  const bubble = hasText || (reasoning === undefined && entry.maxTokens !== true);
  // 複製鈕講完才有（#1305）：串流中不畫，不是畫成透明——鍵盤會按得到。跟評分脫鉤，沒有評分外掛也在。
  const copyable = hasText && !entry.streaming;
  const ratable = feedback !== undefined && isRatable(entry);
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
        {/* 這一輪寫到輸出上限被切斷（#608）。同「已停止」：不是失敗，不用紅字。 */}
        {entry.maxTokens === true && (
          <MessageFooter className="px-0">{MAX_TOKENS_NOTICE}</MessageFooter>
        )}
        {entry.error !== undefined && <p className="text-destructive text-tip">{entry.error}</p>}
        {(copyable || ratable) && (
          <div className="flex items-center gap-1">
            {copyable && <ReplyCopyButton text={entry.text} />}
            {ratable && <RatingButtons messageId={entry.messageId} feedback={feedback} />}
          </div>
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

/**
 * 還沒被領走的插話（#710）：跟人的泡泡同一個樣子，淡一階，底下一句什麼時候送進模型（`pendingSteerText`）。被領走時
 * 同一格換成正式的泡泡，那一句跟著消失。
 */
function PendingSteerBubble({
  text,
  attachments,
  mention,
  caption,
}: {
  text: string;
  attachments: readonly WireAttachmentRef[] | undefined;
  mention: SubagentMention | undefined;
  caption: string;
}) {
  return (
    <Message align="end" data-pending-steer="">
      <MessageContent>
        {/* 帶的附件（#710）：跟領走後那則人的話同一個位置（泡泡上方），換成正式的時不跳位。 */}
        <SentAttachments attachments={attachments} />
        {mention !== undefined && <DelegatedChip name={mention.name} />}
        {text.trim() !== '' && (
          <ChatBubble className="opacity-70">{mentionDisplayText(text)}</ChatBubble>
        )}
        <MessageFooter className="px-0">{caption}</MessageFooter>
      </MessageContent>
    </Message>
  );
}

/**
 * 背景子代理結算通知那一行（#851）：**不是人的泡泡**（那是執行期的記帳，文字是給模型的英文），只有一行小字。
 * 排著的時候（`pending`）說什麼時候送進模型；被領走後折疊器長出 `notice`，同一格換成依原因（`reason`，#884）配的那一句，模型的回覆接在後面。
 */
function SettledNotice({ caption, pending }: { caption: string; pending?: boolean }) {
  return (
    <Message
      align="start"
      data-settled-notice=""
      {...(pending === true ? { 'data-pending-settled': '' } : {})}
    >
      <MessageContent>
        <MessageFooter className="px-0">{caption}</MessageFooter>
      </MessageContent>
    </Message>
  );
}

/**
 * 背景子代理寄來的話（#861）：一則引言式的小卡，上面一行「某某 說」，下面是它寫的話。**不是人的泡泡**（同一種泡泡但靠左，
 * 人的話靠右），也不是模型的回覆；文字是子代理寫的，原樣照畫，不解析。
 */
function AgentMessageCard({ caption, text }: { caption: string; text: string }) {
  return (
    <Message align="start" data-agent-message="">
      <MessageContent>
        <p className="text-muted-foreground px-1 pb-1 text-tip">{caption}</p>
        <ChatBubble align="start">{text}</ChatBubble>
      </MessageContent>
    </Message>
  );
}

/** JS 的捲動不看 CSS 的 reduced-motion，要自己讀（§7）。 */
function scrollBehavior(): ScrollBehavior {
  const reduce =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return reduce ? 'auto' : 'smooth';
}

/**
 * 把這個對話區的 `scrollToMessage` 登記給觀測分頁的「定位」（`lib/transcript-locate.ts`）：右側欄不在
 * `MessageScrollerProvider` 裡，串流中直接捲會被自動捲到底拉回去。不畫任何東西。
 */
function ScrollerRegistration() {
  const { scrollToMessage } = useMessageScroller();
  useEffect(
    () =>
      registerTranscriptScroller((id) =>
        scrollToMessage(id, { align: 'center', behavior: 'auto' }),
      ),
    [scrollToMessage],
  );
  return null;
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
  const names = useMemo(() => namesOf(state.entries), [state.entries]);
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
          subagentNames={names}
          {...(feedback === undefined ? {} : { feedback })}
          {...(answer === undefined ? {} : { answer })}
        />
      ),
    };
  });
  // 串流中段出錯、正在等著整次重打（#520）：接在這一輪的最後，下一則回覆一開始就收掉（折疊器清成 `null`）。
  if (state.retry !== null) {
    items.push({ id: 'llm-retry', node: <RetryNotice retry={state.retry} /> });
  }
  // 還沒被領走的插話接在最後（#710）：鍵跟領走後那則人的話同一個，換成正式的是同一格換內容。
  for (const steer of pendingSteers(state)) {
    items.push({
      id: steer.key,
      node:
        steer.agentText !== undefined ? (
          <SettledNotice pending caption={pendingAgentText(steer.agentText, state.status)} />
        ) : (
          <PendingSteerBubble
            text={steer.text}
            attachments={steer.attachments}
            mention={steer.mention}
            caption={pendingSteerText(state.status)}
          />
        ),
    });
  }
  const announced = useFinishedReply(state.entries, isFresh);
  const autoLoad = useEarlierAutoLoad(earlier);
  const viewport = useRef<HTMLDivElement>(null);
  useScrollButtonClearance(viewport);

  return (
    <MessageScrollerProvider autoScroll>
      <ScrollerRegistration />
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport
          ref={viewport}
          aria-label="對話訊息"
          preserveScrollOnPrepend
          {...autoLoad}
        >
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
        {/* 壓到對話裡的輸入區（子代理面板）就藏起來（#1295，`use-scroll-button-clearance.ts`）。 */}
        <MessageScrollerButton
          className="rounded-full data-[obscuring]:invisible"
          behavior={scrollBehavior()}
        >
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
