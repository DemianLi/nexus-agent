import type { WireClient } from '@nexus/wire';
import { X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { AppSidebar } from '@/components/app-sidebar';
import { ApprovalCard } from '@/components/approval-card';
import { Composer } from '@/components/composer';
import { ContextMeter } from '@/components/context-meter';
import { EmptyHero } from '@/components/empty-hero';
import { FeedbackDialog } from '@/components/feedback-dialog';
import { PendingSwap } from '@/components/pending-swap';
import { QueueDock } from '@/components/queue-dock';
import { FEEDBACK_COMMAND_LINE } from '@/lib/feedback';
import { QuestionPanel } from '@/components/question-panel';
import {
  RightSidebarPanel,
  RightSidebarProvider,
  RightSidebarToggle,
} from '@/components/right-sidebar';
import { SessionUsage } from '@/components/session-usage';
import { StatusLine } from '@/components/status-line';
import { ThemeToggle } from '@/components/theme-toggle';
import { TodoPanel } from '@/components/todo-panel';
import { Transcript, useFreshItems } from '@/components/transcript';
import { Button } from '@/components/ui/button';
import { Toaster } from '@/components/ui/sonner';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useConversation } from '@/hooks/use-conversation';
import { useThemePreference } from '@/hooks/use-theme-preference';
import { agentBaseUrl, createAgentClient } from '@/lib/agent';
import { createChangesStores } from '@/lib/changes-diff';
import { createDeliverableDownloader } from '@/lib/deliverable-download';
import { createDeliverableFileStore } from '@/lib/deliverable-file';
import { newConversationTarget, readThreadListing } from '@/lib/new-conversation';
import { STOPPED_QUESTION_TEXT, stoppedOnQuestion } from '@/lib/question-view';
import { canRunSlash, canSendText } from '@/lib/queue-view';
import { recallThread, rememberThread } from '@/lib/remembered-thread';
import type { ThreadChoice } from '@/lib/remembered-thread';
import { documentTitle, headerTitle, PRODUCT_TITLE } from '@/lib/thread-title';

/**
 * 接回上一次那條 thread 時講的話。
 *
 * **條件句不是客氣**：這一端分不出伺服器是接回來還是新開的（見 `remembered-thread.ts`）。會話日誌預設落盤
 * （#607），但部署設定可以把清單上 `session-persistence` 那一列關掉（#613），那時日誌只在記憶體裡，重開過的
 * server 上同一個 id 就是一條新的，畫面與模型都從空的開始；落盤開著但換了 `NEXUS_AGENT_HOME` 或 cwd 再重開，
 * 也一樣找不到。沒重開過的話兩者都在（日誌與 `MemorySaver` 都還在記憶體裡）。
 * **條件講白話**（#620）：看這一句的人不一定知道部署設定長怎樣；要查的話，server 起動時印的那一行與列不出清單的
 * 錯誤都會點名那一列。之前說過的話畫在底下，是從日誌重播的
 * （[#306](https://github.com/DemianLi/nexus-agent/issues/306)）——所以「接得回來」看畫面就知道，不用這一句講。
 * **最後一句是出口**：不講的話，重新整理之後只會一直回到同一條 thread 上。
 *
 * **不講 todo**：待辦清單自己畫在輸入框上方（`TodoPanel`，#575），harness 從日誌的 `todo/write` 投影出來，回來了
 * 看得到；最後一輪之後又開了新的一輪就是沒有，照 dsh 的投影。模型則是從對話裡那幾次 `todo_write` 記得它的。
 */
export const RESUMED_THREAD_NOTICE =
  '接著上一次的 thread。伺服器有把會話存到磁碟（預設會存）、或還沒重開過的話，之前的對話重播在底下，模型也記得，' +
  '模式、目標與計劃模式跟著回來。不想接就按「新對話」。';

/**
 * 從「以前的會話」點過去時講的話（[#302](https://github.com/DemianLi/nexus-agent/issues/302)）。
 *
 * **跟上一句不同，這一句不用條件句**：清單只在會話日誌落盤的 server 上有（預設就落盤，#607；清單上 `session-persistence` 那一列關掉時列不出來，#613），而且只列切得過去的，所以
 * 「日誌上的東西回來了」是確定的。畫面照日誌重播、模型照日誌推回（[#306](https://github.com/DemianLi/nexus-agent/issues/306)）；
 * 舊格式那一種推不回模型，畫面上另有一句 {@link LEGACY_THREAD_NOTICE} 講，所以這一句不再帶例外。todo 不另外講，
 * 理由同上一句。
 */
export const SWITCHED_THREAD_NOTICE =
  '切到以前的一條 thread。之前的對話重播在底下，模型也記得，目標、沙箱模式與計劃模式跟著回來。';

/**
 * 舊格式的會話（格式 9 以前寫的，#306 拍板 2）：日誌不記模型的回覆，畫面重播得出來的只有人打的字與工具卡，模型也
 * 從空的開始——推不出完整的歷史就不灌半截。伺服器照整份日誌判一次（`ThreadHistoryResult.legacy`）。
 */
export const LEGACY_THREAD_NOTICE =
  '這條會話是舊格式：模型的回覆沒有保存，底下只有你打的字與工具卡；模型也不記得之前的對話，從空的開始。';

const ORIGIN_NOTICE: Readonly<Record<ThreadChoice['origin'], string | undefined>> = {
  fresh: undefined,
  recalled: RESUMED_THREAD_NOTICE,
  listed: SWITCHED_THREAD_NOTICE,
};

/** 光打名字就另有動作的命令（`/feedback` 開回饋框，見 `use-conversation` 的 `send`）。 */
const DECORATED_COMMANDS: ReadonlySet<string> = new Set([FEEDBACK_COMMAND_LINE.slice(1)]);

/**
 * 送出框裡那句灰字。
 *
 * **等人回答時它看不見**：核准與提問面板換掉輸入框（#408、#409，規格 §4.3），面板名稱與狀態列講現在該做什麼，所以這裡
 * 不再分「先回答上面那個核准請求」與「那組問題」——那幾格是 [#239](https://github.com/DemianLi/nexus-agent/issues/239)
 * 在卡片疊在輸入框上方時的補丁。
 *
 * **停在提問時按了停止**（❌，§4.3）：跟那張展開的提問工具卡講同一句，請人直接打字回覆（#376 第 9 條）。
 */
export function inputPlaceholder({
  connected,
  stoppedOnQuestion,
}: {
  readonly connected: boolean;
  readonly stoppedOnQuestion: boolean;
}): string {
  if (!connected) return '連線中…';
  return stoppedOnQuestion ? STOPPED_QUESTION_TEXT : '說點什麼…';
}

/** 提問面板名稱列右邊的 ❌：停止這一輪、不回答這些問題（§4.3、§8）。名稱與 tooltip 同一句，不加確認。 */
export const STOP_QUESTIONS_LABEL = '停止這一輪，不回答這些問題';

/**
 * 對話介面。
 *
 * agent 跑在 Node 那一端，中間是 `@nexus/wire` 那條線（上行 HTTP POST、下行 SSE）。
 * 起 agent 的方式：`pnpm --filter @nexus/harness run serve`，dev server 的
 * `/threads` 會轉過去（見 `vite.config.ts`）。
 */
export function App({ client }: { client?: WireClient } = {}) {
  // 初始化器只讀不寫——StrictMode 會跑它兩次（見 `recallThread`）。寫在 effect 裡，存的就是
  // 真的留下來的那一個。
  const [choice, setChoice] = useState(recallThread);
  useEffect(() => {
    rememberThread(choice.threadId);
  }, [choice.threadId]);
  // 一個 App 一個 client：清單與對話走同一條線。放在這裡而不是 hook 裡，是因為清單不屬於任何一條 thread。
  const wire = useMemo(() => client ?? createAgentClient(), [client]);
  const [theme] = useThemePreference();
  // 換 thread 有兩條路（「新對話」與從清單點一條），**後按的那一下贏**：「新對話」要先讀清單，讀回來之前人已經從清單
  // 點了別條的話，晚到的結果不能把人拉回去。讀清單期間再按一次「新對話」不另開一次（dsh `connectWorkspace` 的
  // `connecting`）——兩次讀到的是同一份清單，只會換一次。
  const navigation = useRef(0);
  const connecting = useRef(false);

  /**
   * 「新對話」（[#313](https://github.com/DemianLi/nexus-agent/issues/313)）：目前這條還是空白就留在原地，否則
   * 拿清單上一條空白會話，都沒有才開新的。重用的那一條也是 `fresh`——它是空的，沒有「之前的對話」可講。
   *
   * @param engaged - 這個分頁在目前這條上講過話了（判準見 `ConversationView`）。
   */
  const newConversation = (engaged: boolean): void => {
    if (!engaged || connecting.current) return;
    connecting.current = true;
    navigation.current += 1;
    const ticket = navigation.current;
    const current = choice.threadId;
    void readThreadListing(wire)
      .then((listing) => {
        if (navigation.current !== ticket) return;
        const target = newConversationTarget(listing, current);
        setChoice({
          threadId: target.kind === 'reuse' ? target.threadId : crypto.randomUUID(),
          origin: 'fresh',
        });
      })
      .finally(() => {
        connecting.current = false;
      });
  };

  // **換 thread 就整個重掛。** 只換 `threadId` 的話 hook 會重開下行，但上一條的 transcript、
  // 錯誤與命令清單都還留在它的 state 裡——畫面會把兩條 thread 混成一條。從清單切過去也走這一條（#261 的重掛）。
  // 側欄的開關放在 thread 外面：換一條不會把收起來的側欄又打開。
  return (
    <SidebarProvider className="h-svh">
      <ConversationView
        key={choice.threadId}
        client={wire}
        threadId={choice.threadId}
        notice={ORIGIN_NOTICE[choice.origin]}
        onNewConversation={newConversation}
        onSwitch={(threadId) => {
          navigation.current += 1;
          setChoice({ threadId, origin: 'listed' });
        }}
      />
      {/* 核准面板沒有出路時的「停止這一輪」（#408）講一聲。主題跟著切換鈕走。 */}
      <Toaster theme={theme} position="top-center" />
    </SidebarProvider>
  );
}

function ConversationView({
  client,
  threadId,
  notice,
  onNewConversation,
  onSwitch,
}: {
  readonly client: WireClient;
  readonly threadId: string;
  readonly notice: string | undefined;
  readonly onNewConversation: (engaged: boolean) => void;
  readonly onSwitch: (threadId: string) => void;
}) {
  const conversation = useConversation({ client, threadId });
  // 改動的摘要與比較都快取到這條 thread 的畫面卸掉（換 thread 整個重掛，#443）。
  const changes = useMemo(
    () => createChangesStores({ threadId, baseUrl: agentBaseUrl() }),
    [threadId],
  );
  // 交付檔的頁同理快取到畫面卸掉為止（#452 第二刀）。
  const deliverableFiles = useMemo(
    () => createDeliverableFileStore({ threadId, baseUrl: agentBaseUrl() }),
    [threadId],
  );
  // 下載沒有快取（#452 第三刀）——它是一次性的副作用，留著等於把整份檔擱在記憶體裡。
  // 仍然綁 `threadId`：座標只在自己那條 thread 上有意義。
  const deliverableDownload = useMemo(
    () => createDeliverableDownloader({ threadId, baseUrl: agentBaseUrl() }),
    [threadId],
  );
  // **這個分頁在這條上講過話沒有**，決定「新對話」要不要留在原地（#313）。照 dsh `Session.handleBlank` 的鏡像：
  // 畫面上有東西（自己送出的話、重播回來的歷史、目標排的輪次）就不是空白，斜線命令不算——它不起一輪。
  // **判準看自己的畫面，不看清單**：清單是冷讀磁碟，還沒落盤的這一條根本不在上面。
  // **歷史還沒折完（`connected` 還沒翻）就當成講過**：那時分不出來，而這顆按鈕是停在核准點、連不上的 thread
  // 唯一的出口——寧可多開一條，也不能把人留在原地。
  const engaged = !conversation.connected || conversation.state.entries.length > 0;
  const title = conversation.state.title;
  const heading = headerTitle(
    title,
    conversation.state.entries.length === 0,
    conversation.connected,
  );
  // 瀏覽器分頁標題（Q2）：照 dsh `DocumentTitle`，卸掉時還原成產品名。
  useEffect(() => {
    document.title = documentTitle(title);
    return () => {
      document.title = PRODUCT_TITLE;
    };
  }, [title]);
  const [draft, setDraft] = useState('');
  // 關掉之後留著最後那一份：退場動效那 150ms 裡框裡的字不能先消失。
  const lastDialog = useRef(conversation.feedbackDialog);
  // **每打開一次就是一張新表單**（跟以前關掉就卸掉一樣）：同一則關掉再開，草稿不留。
  const dialogWasOpen = useRef(false);
  const dialogOpens = useRef(0);
  const dialogOpen = conversation.feedbackDialog !== undefined;
  if (dialogOpen && !dialogWasOpen.current) dialogOpens.current += 1;
  dialogWasOpen.current = dialogOpen;
  if (dialogOpen) lastDialog.current = conversation.feedbackDialog;
  const feedbackDialog = lastDialog.current;

  // **一顆中斷一個面板**（[#232](https://github.com/DemianLi/nexus-agent/issues/232)）。
  // 同一輪兩個工具都要核准時閘門逐次呼叫各自 `interrupt()`，折疊器逐 `interruptId`
  // 並存——每一顆各自帶著回答自己要用的那把鑰匙，所以每一個面板按下去落在自己那顆上。
  // 面板換掉輸入框、一次一個、先來先處理（#408，`PendingSwap`）。
  const pendings = conversation.state.pendings;
  const isFresh = useFreshItems(
    conversation.state.entries.map((entry) => entry.id),
    conversation.connected,
  );
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // **送出分兩道閘**（#645 Q2）。純文字跑著也送得出去：伺服器收下就排進送出佇列，開跑時才畫人的話。停在核准點時
  // 輸入框被面板換掉（Q3、§4.3），那道閘照樣擋。斜線命令一輪沒收尾時照舊擋——伺服器那側也擋——只打 `/feedback`
  // 例外：它不起一輪，只開回饋對話框，而那個框送的 `feedback.record` 任何時候都收（#267 的 Q10）。
  const status = conversation.state.status;
  const canSendLine = (line: string) =>
    line.trim().startsWith('/')
      ? canRunSlash(conversation.connected, status, line, FEEDBACK_COMMAND_LINE)
      : canSendText(conversation.connected, status, line);
  const canSend = canSendLine(draft);
  // 佇列裡焦點要去的那一列不在了：輸入框看得到就交給它，被面板換掉時交給面板（同 `PendingSwap` 的落點）。
  const focusBelowQueue = useCallback(() => {
    const composer = composerRef.current;
    if (composer !== null && composer.closest('[inert]') === null) {
      composer.focus();
      return;
    }
    const panel = document.querySelector<HTMLElement>('[data-slot="pending-panel"]');
    (panel?.querySelector<HTMLElement>('[data-pending-focus]') ?? panel)?.focus();
  }, []);
  // 右側欄讀的跟卡片同一批 store（#640）：分頁與卡片看到的是同一份快取。
  const sidebarSources = useMemo(
    () => ({ changes, deliverableFiles, deliverableDownload }),
    [changes, deliverableFiles, deliverableDownload],
  );

  return (
    <RightSidebarProvider threadId={threadId} sources={sidebarSources}>
      <AppSidebar
        client={client}
        currentThreadId={threadId}
        currentTitle={title}
        onNewConversation={() => onNewConversation(engaged)}
        onPick={onSwitch}
      />
      {/* `SidebarInset` 就是 `<main>`。 */}
      {/* 基準寬 480：右側欄打開時會話區至少留這麼多，視窗再窄才輪到它讓（#640，見 `right-sidebar.tsx`）。 */}
      <SidebarInset className="flex h-svh min-w-0 flex-col" style={{ flexBasis: 480 }}>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-2">
          {/* 觸控目標 44px，1024 以上回到 36（§9）。 */}
          <SidebarTrigger className="size-11 rounded-full lg:size-9" />
          {/* 換字不做動效（Q4）；截斷時 `title` 帶全文。 */}
          <h1 className="min-w-0 flex-1 truncate text-sm font-medium" title={heading}>
            {heading}
          </h1>
          {/* #574：這條對話累計燒了多少（root 日誌的總帳，不是畫面加總）。 */}
          <SessionUsage
            tokenUsage={conversation.state.tokenUsage}
            sessionStats={conversation.state.sessionStats}
          />
          <ThemeToggle className="size-11 rounded-full lg:size-9" />
          {/* 會話標頭那一列的右端（#640 決定 2；#655 確認不用再搬）。 */}
          <RightSidebarToggle className="size-11 rounded-full lg:size-9" />
        </header>

        <div className="mx-auto w-full max-w-2xl shrink-0 px-6 pt-4">
          <div className="space-y-1">
            <StatusLine
              state={conversation.state}
              connected={conversation.connected}
              {...(conversation.connectionError === undefined
                ? {}
                : { connectionError: conversation.connectionError })}
              {...(conversation.commandError === undefined
                ? {}
                : { commandError: conversation.commandError })}
              {...(conversation.slashError === undefined
                ? {}
                : { slashError: conversation.slashError })}
              {...(conversation.slashNotice === undefined
                ? {}
                : { slashNotice: conversation.slashNotice })}
              {...(conversation.reconnecting === undefined
                ? {}
                : { reconnecting: conversation.reconnecting })}
              recovered={conversation.recovered}
              onReconnect={conversation.reconnectNow}
            />
            {/* 不掛 `role="status"`：那一格歸 `StatusLine`，這一句是背景，不是現況。 */}
            {notice !== undefined && <p className="text-muted-foreground text-xs">{notice}</p>}
            {conversation.history?.legacy === true && (
              <p className="text-muted-foreground text-xs">{LEGACY_THREAD_NOTICE}</p>
            )}
            {conversation.historyError !== undefined && (
              <p className="text-destructive text-xs">
                之前說過的話拿不回來：{conversation.historyError}
              </p>
            )}
          </div>
        </div>

        {conversation.state.entries.length === 0 ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6">
            <EmptyHero />
          </div>
        ) : (
          <Transcript
            state={conversation.state}
            isFresh={isFresh}
            changes={changes}
            deliverableDownload={deliverableDownload}
            feedback={{
              ratings: conversation.ratings,
              busy: !conversation.connected,
              loadFailed: conversation.ratingsLoadFailed,
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
        )}

        <div className="mx-auto w-full max-w-2xl shrink-0 px-6 pt-2 pb-6">
          {/* 換手區外面：底下換成核准或提問面板時照樣看得到，焦點搬移也不算它（#575 Q1）。 */}
          <TodoPanel todos={conversation.state.todos} status={conversation.state.status} />
          {/* 也在換手區外面：停在核准點時排著的照樣看得到、改得到（#645 Q3、Q7）。 */}
          <QueueDock
            items={conversation.state.inbox}
            status={conversation.state.status}
            connected={conversation.connected}
            onUpdate={conversation.updateQueue}
            onFocusFallback={focusBelowQueue}
          />
          <PendingSwap
            pendings={pendings}
            composerRef={composerRef}
            // **按 `kind` 分派到兩個元件，不是一個元件內部分支**（#231 第 4 項）：送出的形狀
            // 完全不同（`{decisions:[…]}` 對 `{answers:[…]}`），而認不得的 `kind` 根本到不了
            // 這裡——折疊器那一層就把它翻成 `failed` 了，理由見 `reduceInputRequested`。
            renderPanel={(pending) =>
              pending.kind === 'question' ? (
                <QuestionPanel
                  pending={pending}
                  busy={!conversation.connected}
                  onAnswer={(answers) => void conversation.answer(pending.interruptId, answers)}
                />
              ) : (
                <ApprovalCard
                  pending={pending}
                  busy={!conversation.connected}
                  onDecide={(decision) => void conversation.respond(pending.interruptId, decision)}
                  onStop={() => {
                    void conversation.cancel();
                    toast('已停止這一輪');
                  }}
                />
              )
            }
            // 提問的 ❌＝停止這一輪（§4.3 寫明的例外：dsh 是放棄後這一輪繼續，demian 選擇不讓模型接著猜）。
            // 停下來之後那張提問工具卡展開、列出題目，輸入框提示字同一句。
            renderActions={(pending) =>
              pending.kind === 'question' && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-11 shrink-0 rounded-full lg:size-8"
                        aria-label={STOP_QUESTIONS_LABEL}
                        disabled={!conversation.connected}
                        onClick={() => {
                          void conversation.cancel();
                          toast('已停止這一輪', { description: STOPPED_QUESTION_TEXT });
                        }}
                      >
                        <X />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{STOP_QUESTIONS_LABEL}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )
            }
            composer={
              <Composer
                textareaRef={composerRef}
                draft={draft}
                onDraftChange={setDraft}
                placeholder={inputPlaceholder({
                  connected: conversation.connected,
                  stoppedOnQuestion: stoppedOnQuestion(conversation.state),
                })}
                canSend={canSend}
                onSubmit={() => {
                  if (!canSend) {
                    return;
                  }
                  const text = draft;
                  setDraft('');
                  void conversation.send(text).then((rejected) => {
                    if (rejected === undefined) return;
                    // 沒收下（#645 Q4）：草稿放回去——人已經開始打下一句的話不蓋掉——並說出原因。
                    setDraft((current) => (current === '' ? text : current));
                    toast.error('這一句沒送出去', { description: rejected.message });
                  });
                }}
                commands={conversation.slashCommands}
                decorated={DECORATED_COMMANDS}
                // 從 `/` 選單直接執行不帶參數的命令：走斜線那一道閘（跑著時只有 `/feedback` 過得去）。
                onRunCommand={(line) => {
                  if (!canSendLine(line)) {
                    return false;
                  }
                  void conversation.send(line);
                  return true;
                }}
                // **一輪在跑時才出現**。停在等人時輸入框被面板換掉了（§4.3）：核准面板沒有停止（#376 第 10、11 條），
                // 提問面板的停止是它自己的 ❌。伺服器只回受理，停下來的事實走下行，所以按下去不自己改狀態。任何分頁
                // 都按得動，不查是誰起的這一輪（#265 的 Q3）。
                stoppable={conversation.state.status === 'running'}
                stopDisabled={!conversation.connected}
                onStop={() => void conversation.cancel()}
                meter={
                  // 有待決時輸入框被面板換掉（藏起來、不卸載），點開的明細要跟著關（#528）。
                  <ContextMeter
                    pressure={conversation.state.contextPressure}
                    hidden={pendings.length > 0}
                  />
                }
              />
            }
          />
        </div>
      </SidebarInset>
      <RightSidebarPanel />

      {feedbackDialog !== undefined && (
        <FeedbackDialog
          // 每打開一次、或換了目標，就是一張新的表單：草稿不帶過去。
          key={`${dialogOpens.current}:${JSON.stringify(feedbackDialog.target)}`}
          open={dialogOpen}
          submitting={feedbackDialog.submitting}
          {...(feedbackDialog.failure === undefined ? {} : { failure: feedbackDialog.failure })}
          onSubmit={(draft) => void conversation.submitFeedback(draft)}
          onDismiss={conversation.dismissFeedback}
        />
      )}
    </RightSidebarProvider>
  );
}
