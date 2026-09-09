import type { ConversationStatus, PendingInput, WireClient } from '@nexus/wire';
import { isApprovalPending, isQuestionPending } from '@nexus/wire';
import { useState } from 'react';

import { ApprovalCard } from '@/components/approval-card';
import { QuestionCard } from '@/components/question-card';
import { StatusLine } from '@/components/status-line';
import { Transcript } from '@/components/transcript';
import { Button } from '@/components/ui/button';
import { useConversation } from '@/hooks/use-conversation';

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
  const conversation = useConversation(client === undefined ? {} : { client });
  const [draft, setDraft] = useState('');

  // **一顆中斷一張卡**（[#232](https://github.com/DemianLi/nexus-agent/issues/232)）。
  // 同一輪兩個工具都要核准時閘門逐次呼叫各自 `interrupt()`，折疊器逐 `interruptId`
  // 並存——每一顆各自帶著回答自己要用的那把鑰匙，所以每一張卡按下去落在自己那顆上。
  const pendings = conversation.state.pendings;
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
  const canSend = conversation.connected && !busy && draft.trim() !== '';

  return (
    <main className="mx-auto flex min-h-svh max-w-2xl flex-col gap-6 px-6 py-10">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">nexus-agent</h1>
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
      </header>

      <section className="flex flex-1 flex-col gap-4">
        <Transcript state={conversation.state} />
        {/*
          **按 `kind` 分派到兩個元件，不是一個元件內部分支**（#231 第 4 項）：送出的形狀
          完全不同（`{decisions:[…]}` 對 `{answers:[…]}`），而認不得的 `kind` 根本到不了
          這裡——折疊器那一層就把它翻成 `failed` 了，理由見 `reduceInputRequested`。
        */}
        {pendings.map((pending) =>
          pending.kind === 'question' ? (
            <QuestionCard
              key={pending.interruptId}
              pending={pending}
              busy={!conversation.connected}
              onAnswer={(answers) => void conversation.answer(pending.interruptId, answers)}
              onCancel={() => void conversation.cancelQuestions(pending.interruptId)}
            />
          ) : (
            <ApprovalCard
              key={pending.interruptId}
              pending={pending}
              busy={!conversation.connected}
              onDecide={(decision) => void conversation.respond(pending.interruptId, decision)}
            />
          ),
        )}
      </section>

      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSend) {
            return;
          }
          const text = draft;
          setDraft('');
          void conversation.send(text);
        }}
      >
        <label className="sr-only" htmlFor="prompt">
          要說的話
        </label>
        <input
          id="prompt"
          className="border-input bg-background flex-1 rounded-md border px-3 py-2 text-sm"
          value={draft}
          placeholder={inputPlaceholder({
            status: conversation.state.status,
            connected: conversation.connected,
            pendings,
            stuck,
          })}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button type="submit" disabled={!canSend}>
          送出
        </Button>
      </form>

      {conversation.slashCommands.length > 0 && (
        // **扁平清單，不是選單。** 打 `/` 不會跳候選、不補全——那一套（dsh 的
        // `CommandDirectory`）是另一張卡。這裡只讓人知道打得出什麼
        // （[#123](https://github.com/DemianLi/nexus-agent/issues/123)）。
        <p className="text-muted-foreground text-xs">
          命令：
          {conversation.slashCommands.map((command, index) => (
            <span key={command.name}>
              {index === 0 ? '' : '、'}
              <code title={command.description}>
                /{command.name}
                {command.input === undefined ? '' : ` ${command.input.hint}`}
              </code>
            </span>
          ))}
        </p>
      )}
    </main>
  );
}
