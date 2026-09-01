import type { WireClient } from '@nexus/wire';
import { useState } from 'react';

import { ApprovalCard } from '@/components/approval-card';
import { StatusLine } from '@/components/status-line';
import { Transcript } from '@/components/transcript';
import { Button } from '@/components/ui/button';
import { useConversation } from '@/hooks/use-conversation';

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

  const pending = conversation.state.pending;
  // **`awaiting-input` 也算忙**。少了它，等核准時送得出下一句話——而基座那時會把
  // 中斷靜靜丟掉：那個工具既沒執行也沒被拒絕，也不會再問第二次（實測）。
  // 一顆按鈕都長不出來的核准請求（交集是空的）**不算忙**：那時卡片沒有出路，
  // 再把送出框鎖起來就是整條對話卡死。基座一定會發 `reviewConfigs`，但代價不對稱。
  const stuck = pending !== undefined && pending.allowedDecisions.length === 0;
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
        {pending !== undefined && (
          <ApprovalCard
            pending={pending}
            busy={!conversation.connected}
            onDecide={(decision) => void conversation.respond(decision)}
          />
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
          placeholder={
            conversation.state.status === 'awaiting-input' && !stuck
              ? '先回答上面那個核准請求…'
              : conversation.connected
                ? '說點什麼…'
                : '連線中…'
          }
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
