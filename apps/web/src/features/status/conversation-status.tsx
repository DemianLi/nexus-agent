import { StatusLine } from '@/features/status/line';
import type { Conversation, ConversationLink } from '@/shared/connection/use-conversation';

/**
 * 對話的狀態列：把 `Conversation` 接到 `StatusLine`，獨立頁面與嵌入版共用。呼叫端把它放在 `PendingSwap` 正上方、換手區外面
 * （#3035）。
 */
export function ConversationStatus({
  conversation,
}: {
  readonly conversation: ConversationLink &
    Pick<Conversation, 'state' | 'commandError' | 'slashError' | 'slashNotice'>;
}) {
  return (
    <StatusLine
      state={conversation.state}
      connected={conversation.connected}
      slowConnect={conversation.slowConnect}
      opening={conversation.opening}
      {...(conversation.connectionError === undefined
        ? {}
        : { connectionError: conversation.connectionError })}
      {...(conversation.refusal === undefined ? {} : { refusal: conversation.refusal })}
      {...(conversation.commandError === undefined
        ? {}
        : { commandError: conversation.commandError })}
      {...(conversation.slashError === undefined ? {} : { slashError: conversation.slashError })}
      {...(conversation.slashNotice === undefined ? {} : { slashNotice: conversation.slashNotice })}
      {...(conversation.reconnecting === undefined
        ? {}
        : { reconnecting: conversation.reconnecting })}
      recovered={conversation.recovered}
      onReconnect={conversation.reconnectNow}
    />
  );
}
