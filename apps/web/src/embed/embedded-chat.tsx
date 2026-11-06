/**
 * 嵌入版的對話畫面（#2366）：`<nexus-chat>` 在 shadow root 裡畫的就是這個。跟獨立頁面共用 `components/conversation/` 那幾塊，
 * 功能照地圖 #2365 第 12 點收窄：
 *
 * - 有：對話紀錄（工具呼叫列、思考摘要都在裡面）、狀態列、輸入框與停止、核准卡與反問面板、情境標籤、「新對話」、回覆底下的回饋鈕、
 *   宿主頁工具（#2374，轉交見 {@link useHostCalls}）；
 * - 沒有：`/` 與 `@` 選單、模型與權限座、計劃模式、目標列、待辦、送出佇列、分叉、側欄與歷史清單、成本、附件上傳、改動卡（差異檢視）。
 *
 * 輸入框送出的一律是一句話（`route: 'sentence'`）：開頭是 `/` 也不認成命令。一輪在跑時不收下一句，因為沒有畫送出佇列，排進去的
 * 那一句會看不見；要插話先按停止。
 *
 * @module
 */
import type {
  ConversationEntry,
  HostToolDeclaration,
  HostToolResponse,
  WireClient,
} from '@nexus/wire';
import { EMBED_PATH_PREFIX } from '@nexus/wire';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Composer } from '@/components/composer';
import { ConversationBody } from '@/components/conversation/conversation-body';
import { ConversationFeedbackDialog } from '@/components/conversation/conversation-feedback-dialog';
import { ConversationNotices } from '@/components/conversation/conversation-notices';
import { inputPlaceholder } from '@/components/conversation/input-placeholder';
import { renderPendingActions, renderPendingPanel } from '@/components/conversation/pending-panels';
import { PendingSwap } from '@/components/pending-swap';
import { useSubagentControl } from '@/components/tool/subagent-control';
import { Entry as TranscriptEntry, useFreshItems } from '@/components/transcript';
import { Button } from '@/components/ui/button';
import { useConversation } from '@/hooks/use-conversation';
import type { Conversation } from '@/hooks/use-conversation';
import { pendingAsker } from '@/lib/approval-asker';
import { createAttachmentImageSource } from '@/lib/attachment-image';
import { connectionStall } from '@/lib/connection-stall';
import { createDeliverableDownloader } from '@/lib/deliverable-download';
import { canSendText } from '@/lib/queue-view';
import { stoppedOnQuestion } from '@/lib/question-view';
import { recallThread, rememberThread } from '@/lib/remembered-thread';
import { requestIdFor } from '@/lib/request-id';
import type { PendingRequest, Sentence } from '@/lib/request-id';
import { pendingSteers } from '@/lib/steer-view';
import { randomUuid } from '@/lib/uuid';

import type { NexusChatContext } from './context';
import { HOST_TOOL_MISSING_ERROR, hostToolSuccess } from './host-tools';
import type { NexusHostToolDetail } from './host-tools';

/** 嵌入版記住上一條 thread 的鍵，跟獨立頁面的 `nexus.threads.current` 分開：同一個網域上兩邊各接各的。 */
export const EMBED_THREAD_KEY = 'nexus.embed.threads.current';

export const NEW_CONVERSATION_LABEL = '新對話';

/** 情境標籤前面那幾個字。 */
export const CONTEXT_LABEL_PREFIX = '目前選取：';

const NO_NAMES: ReadonlyMap<string, string> = new Map();

function renderSubagentEntry(entry: ConversationEntry) {
  return <TranscriptEntry entry={entry} subagentNames={NO_NAMES} />;
}

/** 換過登入票（`el.signIn()`，#2370）之後接哪一條：`seq` 換了人才換，換了就整個重來；同一個人續期不換。 */
export interface EmbedSignIn {
  readonly seq: number;
  /** serve 說的「這一次登入最新開的那一條」，沒有就是這一端新生的。 */
  readonly threadId: string;
}

interface ChatProps {
  readonly agentBaseUrl: string;
  readonly client: WireClient;
  readonly context: NexusChatContext | undefined;
  readonly hostTools: readonly HostToolDeclaration[] | undefined;
  readonly onHostCall: (detail: NexusHostToolDetail) => void;
}

/**
 * 打開時接著上一條（#2365 第 6 點）；「新對話」開一條新的。換 thread 整個重掛，理由同獨立頁面（`App.tsx`）。
 *
 * 上一條從哪裡來看有沒有換過登入票：沒換過（這個元素還沒呼叫 `signIn`）讀寫 {@link EMBED_THREAD_KEY}；換過就只認 `signIn` 帶來的那一條，
 * 這個鍵不讀也不寫。換票的是不同的人，記在瀏覽器上的那一條可能是上一個人的。
 *
 * @param agentBaseUrl - agent 的位置，從 `embed.js` 算（#2426）。`/livez` 在它底下，thread 那一族在它加上 `/embed` 底下（#2382）。
 * @param context - 宿主頁給的情境（#2365 第 7 點）：畫成標籤，每一句送出時附上當下的值（#2382）；沒有就不送。
 * @param hostTools - 宿主頁宣告的工具（#2374）：每一句送出時附上當下的值，同 `context`；沒有就不送。
 * @param onHostCall - 模型叫了 `hostTools` 裡的一支時呼叫，交給宿主頁執行。
 * @param signIn - 最近一次換票的結果；沒換過是 `undefined`。
 */
export function EmbeddedChat({ signIn, ...props }: ChatProps & { readonly signIn?: EmbedSignIn }) {
  return signIn === undefined ? (
    <RememberedChat {...props} />
  ) : (
    <SignedInChat key={signIn.seq} threadId={signIn.threadId} {...props} />
  );
}

function RememberedChat(props: ChatProps) {
  const [threadId, setThreadId] = useState(() => recallThread(EMBED_THREAD_KEY).threadId);
  useEffect(() => {
    rememberThread(threadId, EMBED_THREAD_KEY);
  }, [threadId]);
  return (
    <EmbeddedConversation
      key={threadId}
      {...props}
      threadId={threadId}
      onNewConversation={() => setThreadId(randomUuid())}
    />
  );
}

function SignedInChat({ threadId: first, ...props }: ChatProps & { readonly threadId: string }) {
  const [threadId, setThreadId] = useState(first);
  return (
    <EmbeddedConversation
      key={threadId}
      {...props}
      threadId={threadId}
      onNewConversation={() => setThreadId(randomUuid())}
    />
  );
}

/**
 * 把 `hostCalls` 裡新來的那幾支轉交宿主頁，每顆中斷一次。同一顆因為重連補送或再度中斷又出現時不再轉交；重新整理（整個重掛）之後補送的
 * 那幾支照常轉交（設計 `.docs/host-page-tools-2374-design-2026-11-03.md` §四 Q6）。名字不在**目前**的宣告裡的，不轉交、當場交回 {@link HOST_TOOL_MISSING_ERROR}。宿主頁一直不回的由 server 的逾時收。
 */
function useHostCalls(
  conversation: Conversation,
  hostTools: readonly HostToolDeclaration[] | undefined,
  onHostCall: (detail: NexusHostToolDetail) => void,
) {
  const handed = useRef(new Set<string>());
  const latest = useRef({ conversation, hostTools, onHostCall });
  latest.current = { conversation, hostTools, onHostCall };
  const calls = conversation.state.hostCalls;
  useEffect(() => {
    for (const call of calls) {
      if (handed.current.has(call.interruptId)) continue;
      handed.current.add(call.interruptId);
      const { conversation: current, hostTools: declared, onHostCall: hand } = latest.current;
      if (declared?.some((tool) => tool.name === call.name) !== true) {
        void current.respondHostCall(call, { ok: false, error: HOST_TOOL_MISSING_ERROR });
        continue;
      }
      let settled = false;
      const settle = (response: HostToolResponse) => {
        if (settled) return;
        settled = true;
        void latest.current.conversation.respondHostCall(call, response);
      };
      hand({
        id: call.interruptId,
        name: call.name,
        args: call.args,
        respond: (result) => settle(hostToolSuccess(result)),
        fail: (error) => settle({ ok: false, error: String(error) }),
      });
    }
  }, [calls]);
}

function EmbeddedConversation({
  agentBaseUrl,
  client,
  threadId,
  context,
  hostTools,
  onHostCall,
  onNewConversation,
}: {
  readonly agentBaseUrl: string;
  readonly client: WireClient;
  readonly threadId: string;
  readonly context: NexusChatContext | undefined;
  readonly hostTools: readonly HostToolDeclaration[] | undefined;
  readonly onHostCall: (detail: NexusHostToolDetail) => void;
  readonly onNewConversation: () => void;
}) {
  const conversation = useConversation({ client, threadId, agentBaseUrl });
  useHostCalls(conversation, hostTools, onHostCall);
  const deliverableDownload = useMemo(
    () => createDeliverableDownloader({ threadId, baseUrl: `${agentBaseUrl}${EMBED_PATH_PREFIX}` }),
    [threadId, agentBaseUrl],
  );
  const imageSource = useMemo(
    () => createAttachmentImageSource(client, threadId),
    [client, threadId],
  );
  useEffect(() => () => imageSource.dispose(), [imageSource]);
  const subagentControl = useSubagentControl({
    client,
    threadId,
    status: conversation.state.subagentStatus,
    connected: conversation.connected,
    stall: connectionStall(conversation),
    renderEntry: renderSubagentEntry,
  });
  // 嵌入版沒有清單可切：會話引用一律只顯示。
  const sessionLinks = useMemo(() => ({ openable: () => false, open: () => {} }), []);
  const steers = pendingSteers(conversation.state);
  const isFresh = useFreshItems(
    [...conversation.state.entries.map((entry) => entry.id), ...steers.map((steer) => steer.key)],
    conversation.connected,
  );
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState('');
  // 沒送出去的原因：嵌入版不掛 toast（sonner 的樣式進不了 shadow root），講在輸入框底下。
  const [sendError, setSendError] = useState<string | undefined>(undefined);
  // 上次沒送出去的那一句與它的請求編號（#1335），原樣重送時沿用。
  const pendingRequest = useRef<PendingRequest | undefined>(undefined);
  const status = conversation.state.status;
  const canSend = canSendText(conversation.connected, status, draft) && status !== 'running';
  // 判準同獨立頁面的「新對話」（`App.tsx` 的 `engaged`）：還沒講過話就留在原地。
  const engaged =
    !conversation.connected || conversation.attempted || conversation.state.entries.length > 0;

  const submit = () => {
    if (!canSend) return;
    const text = draft;
    const sentence: Sentence = { text, mention: undefined, attachmentIds: [] };
    const requestId = requestIdFor(pendingRequest.current, sentence);
    pendingRequest.current = undefined;
    setDraft('');
    setSendError(undefined);
    void conversation
      .send(text, 'queue', undefined, undefined, requestId, 'sentence', context, hostTools)
      .then((rejected) => {
        if (rejected === undefined) return;
        pendingRequest.current = { id: requestId, sentence };
        setDraft((current) => (current === '' ? text : current));
        setSendError(
          rejected.uncertain === true
            ? `不確定這一句有沒有送到，原樣再按一次送出不會重複。（${rejected.message}）`
            : `這一句沒送出去：${rejected.message}`,
        );
      });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-end gap-2 px-3 pt-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!engaged}
          onClick={onNewConversation}
        >
          {NEW_CONVERSATION_LABEL}
        </Button>
      </header>
      <div className="mx-auto w-full max-w-2xl shrink-0 px-4">
        <ConversationNotices conversation={conversation} notice={undefined} />
      </div>
      <ConversationBody
        conversation={conversation}
        isFresh={isFresh}
        hasSteers={steers.length > 0}
        sessionLinks={sessionLinks}
        imageSource={imageSource}
        subagentControl={subagentControl}
        deliverableDownload={deliverableDownload}
        fileDrop={false}
      />
      <div className="mx-auto w-full max-w-2xl shrink-0 px-4 pt-2 pb-4">
        {context !== undefined && (
          <p className="text-muted-foreground mb-2 truncate text-tip" title={context.label}>
            {CONTEXT_LABEL_PREFIX}
            {context.label}
          </p>
        )}
        <PendingSwap
          pendings={conversation.state.pendings}
          askerOf={(pending) => pendingAsker(conversation.state, pending)?.label}
          composerRef={composerRef}
          renderPanel={(pending) => renderPendingPanel(conversation, pending)}
          renderActions={(pending) => renderPendingActions(conversation, pending)}
          composer={
            <Composer
              textareaRef={composerRef}
              draft={draft}
              onDraftChange={setDraft}
              placeholder={inputPlaceholder({
                connected: conversation.connected,
                stall: connectionStall(conversation),
                stoppedOnQuestion: stoppedOnQuestion(conversation.state),
              })}
              canSend={canSend}
              onSubmit={submit}
              commands={[]}
              onRunCommand={() => false}
              stoppable={status === 'running'}
              stopDisabled={!conversation.connected}
              onStop={() => void conversation.cancel()}
            />
          }
        />
        {sendError !== undefined && (
          <p role="alert" className="text-destructive mt-2 text-tip">
            {sendError}
          </p>
        )}
      </div>
      <ConversationFeedbackDialog conversation={conversation} />
    </div>
  );
}
