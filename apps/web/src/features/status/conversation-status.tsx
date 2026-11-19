/** 狀態列接上對話（#3035 結論 D 搬到輸入框或待決面板的上緣），獨立頁面與嵌入版共用。 */

import { StatusLine } from '@/features/status/line';
import type { Conversation, ConversationLink } from '@/shared/connection/use-conversation';

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
