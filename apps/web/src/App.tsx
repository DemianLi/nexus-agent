import type { ConversationStatus, PendingInput, WireClient } from '@nexus/wire';
import { isApprovalPending, isQuestionPending } from '@nexus/wire';
import { useEffect, useMemo, useRef, useState } from 'react';

import { AppSidebar } from '@/components/app-sidebar';
import { ApprovalCard } from '@/components/approval-card';
import { Composer } from '@/components/composer';
import { EmptyHero } from '@/components/empty-hero';
import { FeedbackDialog } from '@/components/feedback-dialog';
import { FEEDBACK_COMMAND_LINE } from '@/lib/feedback';
import { QuestionCard } from '@/components/question-card';
import { StatusLine } from '@/components/status-line';
import { ThemeToggle } from '@/components/theme-toggle';
import { Transcript, useFreshItems } from '@/components/transcript';
import { Button } from '@/components/ui/button';
import { Toaster } from '@/components/ui/sonner';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { useConversation } from '@/hooks/use-conversation';
import { useThemePreference } from '@/hooks/use-theme-preference';
import { createAgentClient } from '@/lib/agent';
import { newConversationTarget, readThreadListing } from '@/lib/new-conversation';
import { recallThread, rememberThread } from '@/lib/remembered-thread';
import type { ThreadChoice } from '@/lib/remembered-thread';

/**
 * 接回上一次那條 thread 時講的話。
 *
 * **條件句不是客氣**：這一端分不出伺服器是接回來還是新開的（見 `remembered-thread.ts`）——
 * serve 沒開 `--session-log` 時，重開過的 server 上同一個 id 就是一條新的，畫面與模型都從空的開始；沒重開過的話
 * 兩者都在（日誌與 `MemorySaver` 都還在記憶體裡）。之前說過的話畫在底下，是從日誌重播的
 * （[#306](https://github.com/DemianLi/nexus-agent/issues/306)）——所以「接得回來」看畫面就知道，不用這一句講。
 * **最後一句是出口**：不講的話，重新整理之後只會一直回到同一條 thread 上。
 *
 * **不講 todo**：沒有人讀 `todo/write` 重建它（`@nexus/plugin-todo` 沒有投影），模型是從對話裡那幾次
 * `todo_write` 記得它的——對話回來了它就在，不是另外回來的一樣東西。
 */
export const RESUMED_THREAD_NOTICE =
  '接著上一次的 thread。伺服器開著 --session-log、或還沒重開過的話，之前的對話重播在底下，模型也記得，' +
  '模式、目標與計劃模式跟著回來。不想接就按「新對話」。';

/**
 * 從「以前的會話」點過去時講的話（[#302](https://github.com/DemianLi/nexus-agent/issues/302)）。
 *
 * **跟上一句不同，這一句不用條件句**：清單只在開了 --session-log 的 server 上有，而且只列切得過去的，所以
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

/** 往前翻那顆按鈕。 */
export const LOAD_EARLIER_LABEL = '載入更早的對話';

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
 * 它要說的是**「現在該先做什麼」**，所以掛著什麼就講什麼。原本一律寫「先回答上面那個核准
 * 請求…」，連掛著的是問答時也照講——那是 [#239](https://github.com/DemianLi/nexus-agent/issues/239)
 * 在真瀏覽器裡量到的三處說謊之一。分得出來的東西一直都在：`pendings` 每一顆都帶 `kind`，
 * 只是沒去讀。
 *
 * **兩種混著掛的時候兩種都講**（這一格卡上留給落地時定，這是定的結果）。驗收句寫的是
 * 「問答掛著時不出現『核准』兩個字」，那句話防的是**把問答叫成核准**；兩顆真的都掛著時
 * 只講一種，就是往另一個方向說謊。所以判準不是「有沒有出現『核准』」，是**「講的跟掛著的
 * 對不對得上」**。
 *
 * **`stuck` 是核准卡專屬的解鎖**（理由見 {@link App} 裡那段註解）：一顆按鈕都長不出來的
 * 核准請求會讓對話永遠清不掉，所以把送出框放開，讓人至少講得出原因。**但問答卡永遠按得
 * 動**——兩者同時掛著時只說「說點什麼…」會把還答得掉的那組問題吞掉，所以那一格兩件事
 * 都講。核准卡自己卡死、旁邊沒有問答時，照舊只邀請說話。
 */
export function inputPlaceholder({
  status,
  connected,
  pendings,
  stuck,
}: {
  readonly status: ConversationStatus;
  readonly connected: boolean;
  readonly pendings: readonly PendingInput[];
  readonly stuck: boolean;
}): string {
  const idle = (): string => (connected ? '說點什麼…' : '連線中…');
  if (status !== 'awaiting-input') {
    return idle();
  }
  const question = pendings.some(isQuestionPending);
  const approval = pendings.some(isApprovalPending);
  if (stuck) {
    return question ? '先回答上面那組問題，或直接說點什麼…' : idle();
  }
  if (question && approval) {
    return '上面的核准請求與那組問題都還等著…';
  }
  if (question) {
    return '先回答上面那組問題…';
  }
  if (approval) {
    return '先回答上面那個核准請求…';
  }
  // `awaiting-input` 而一顆都不剩：折疊器答完最後一顆就翻成 `running`，所以這是
  // 到不了的一格。不拋——placeholder 說錯話不值得換來一個白畫面。
  return idle();
}

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
      {/* 還沒有人呼叫 `toast()`：第一個用的是 ⑧（#408）的「已停止這一輪」。先掛好，主題跟著切換鈕走。 */}
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
  // **這個分頁在這條上講過話沒有**，決定「新對話」要不要留在原地（#313）。照 dsh `Session.handleBlank` 的鏡像：
  // 畫面上有東西（自己送出的話、重播回來的歷史、目標排的輪次）就不是空白，斜線命令不算——它不起一輪。
  // **判準看自己的畫面，不看清單**：清單是冷讀磁碟，還沒落盤的這一條根本不在上面。
  // **歷史還沒折完（`connected` 還沒翻）就當成講過**：那時分不出來，而這顆按鈕是停在核准點、連不上的 thread
  // 唯一的出口——寧可多開一條，也不能把人留在原地。
  const engaged = !conversation.connected || conversation.state.entries.length > 0;
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

  // **一顆中斷一張卡**（[#232](https://github.com/DemianLi/nexus-agent/issues/232)）。
  // 同一輪兩個工具都要核准時閘門逐次呼叫各自 `interrupt()`，折疊器逐 `interruptId`
  // 並存——每一顆各自帶著回答自己要用的那把鑰匙，所以每一張卡按下去落在自己那顆上。
  const pendings = conversation.state.pendings;
  const isFresh = useFreshItems(
    [
      ...conversation.state.entries.map((entry) => entry.id),
      ...pendings.map((pending) => pending.interruptId),
    ],
    conversation.connected,
  );
  // **`awaiting-input` 也算忙**。少了它，等核准時送得出下一句話——而基座那時會把
  // 中斷靜靜丟掉：那個工具既沒執行也沒被拒絕，也不會再問第二次（實測）。
  //
  // 一顆按鈕都長不出來的核准請求（交集是空的）**不算忙**：那張卡永遠清不掉，再把送出
  // 框鎖起來就是整條對話卡死。基座一定會發 `reviewConfigs`，但代價不對稱。
  //
  // **多張卡之下用 `some` 不是 `every`**：照上面那個理由，只要有**一張**沒有出路，
  // 這條 thread 就已經清不乾淨了，別的卡片按得動也救不回來。解鎖之後送出去仍會撞上
  // 伺服器那句「停在核准點」——**出路是「講得出原因」，不是「真的能說話」**。
  //
  // **只有核准卡會卡死。** 問答卡永遠按得動——它的出路是「送出答案」或「放棄整組」，
  // 兩條都不依賴伺服器發了什麼清單，所以它不進這個判準。
  const stuck = pendings.some(
    (pending) => isApprovalPending(pending) && pending.allowedDecisions.length === 0,
  );
  const busy =
    conversation.state.status === 'running' ||
    (conversation.state.status === 'awaiting-input' && !stuck);
  // **只打 `/feedback` 跑著也送得出去**：它不起一輪，只開回饋對話框，而那個框送的 `feedback.record`
  // 任何時候都收（#267 的 Q10）。
  const canSendLine = (line: string) =>
    conversation.connected &&
    line.trim() !== '' &&
    (!busy || line.trim() === FEEDBACK_COMMAND_LINE);
  const canSend = canSendLine(draft);

  return (
    <>
      <AppSidebar
        client={client}
        currentThreadId={threadId}
        onNewConversation={() => onNewConversation(engaged)}
        onPick={onSwitch}
      />
      {/* `SidebarInset` 就是 `<main>`。 */}
      <SidebarInset className="flex h-svh min-w-0 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-2">
          {/* 觸控目標 44px，1024 以上回到 36（§9）。 */}
          <SidebarTrigger className="size-11 rounded-full lg:size-9" />
          <h1 className="min-w-0 flex-1 truncate text-sm font-medium">nexus-agent</h1>
          <ThemeToggle className="size-11 rounded-full lg:size-9" />
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

        {conversation.state.entries.length === 0 && pendings.length === 0 ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6">
            <EmptyHero />
          </div>
        ) : (
          <Transcript
            state={conversation.state}
            isFresh={isFresh}
            feedback={{
              ratings: conversation.ratings,
              busy: !conversation.connected,
              loadFailed: conversation.ratingsLoadFailed,
              onSeed: conversation.seedRatings,
              onRate: (messageId, rating) => void conversation.rate(messageId, rating),
            }}
            before={
              conversation.history?.hasMore === true && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="self-center"
                  disabled={conversation.history.loading}
                  onClick={() => void conversation.loadEarlier()}
                >
                  {LOAD_EARLIER_LABEL}
                </Button>
              )
            }
            // **按 `kind` 分派到兩個元件，不是一個元件內部分支**（#231 第 4 項）：送出的形狀
            // 完全不同（`{decisions:[…]}` 對 `{answers:[…]}`），而認不得的 `kind` 根本到不了
            // 這裡——折疊器那一層就把它翻成 `failed` 了，理由見 `reduceInputRequested`。
            // 卡片先接在對話後面；換掉輸入框的換手層是 ⑧（#408）的事。
            after={pendings.map((pending) => ({
              id: pending.interruptId,
              node:
                pending.kind === 'question' ? (
                  <QuestionCard
                    pending={pending}
                    busy={!conversation.connected}
                    onAnswer={(answers) => void conversation.answer(pending.interruptId, answers)}
                    onCancel={() => void conversation.cancelQuestions(pending.interruptId)}
                  />
                ) : (
                  <ApprovalCard
                    pending={pending}
                    busy={!conversation.connected}
                    onDecide={(decision) =>
                      void conversation.respond(pending.interruptId, decision)
                    }
                  />
                ),
            }))}
          />
        )}

        <div className="mx-auto w-full max-w-2xl shrink-0 px-6 pt-2 pb-6">
          <Composer
            draft={draft}
            onDraftChange={setDraft}
            placeholder={inputPlaceholder({
              status: conversation.state.status,
              connected: conversation.connected,
              pendings,
              stuck,
            })}
            canSend={canSend}
            onSubmit={() => {
              if (!canSend) {
                return;
              }
              const text = draft;
              setDraft('');
              void conversation.send(text);
            }}
            commands={conversation.slashCommands}
            decorated={DECORATED_COMMANDS}
            // 從 `/` 選單直接執行不帶參數的命令：跟送出同一道閘（跑著時只有 `/feedback` 過得去）。
            onRunCommand={(line) => {
              if (!canSendLine(line)) {
                return false;
              }
              void conversation.send(line);
              return true;
            }}
            // **有東西可停時才出現**：一輪在跑，或停在核准點——那時按它就是收回那幾張卡
            // （[#265](https://github.com/DemianLi/nexus-agent/issues/265) 的 Q7）。伺服器只回受理，停下來的
            // 事實走下行，所以按下去不自己改狀態。任何分頁都按得動，不查是誰起的這一輪（Q3）。
            stoppable={
              conversation.state.status === 'running' ||
              conversation.state.status === 'awaiting-input'
            }
            stopDisabled={!conversation.connected}
            onStop={() => void conversation.cancel()}
          />
        </div>
      </SidebarInset>

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
    </>
  );
}
