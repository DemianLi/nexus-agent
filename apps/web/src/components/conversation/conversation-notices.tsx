/**
 * 對話區最上面那一塊（狀態列與換線、舊格式、歷史拿不回來的那幾句），從 `App.tsx` 的會話畫面拆出來，獨立頁面與嵌入版
 * 共用（#2366）。`LEGACY_THREAD_NOTICE` 由 `App.tsx` 再匯出，原本從那裡讀它的測試照舊。
 */

import { StatusLine } from '@/components/status-line';
import type { Conversation } from '@/hooks/use-conversation';
import { threadCapacityText } from '@/lib/thread-capacity';
import { threadHistoryTooDeepText } from '@/lib/thread-history-too-deep';
import { threadLogBudgetText } from '@/lib/thread-log-budget';
import { threadRootMismatchText } from '@/lib/thread-root-mismatch';
import { threadWriterHeldText } from '@/lib/thread-writer-held';

/**
 * 舊格式的會話（格式 9 以前寫的，#306）：日誌不記模型的回覆，畫面重播得出來的只有人打的字與工具卡，模型也
 * 從空的開始——推不出完整的歷史就不灌半截。伺服器照整份日誌判一次（`ThreadHistoryResult.legacy`）。
 */
export const LEGACY_THREAD_NOTICE =
  '這條會話是舊格式：模型的回覆沒有保存，底下只有你打的字與工具卡；模型也不記得之前的對話，從空的開始。';

/**
 * 對話區最上面那一塊：狀態列，加上這條 thread 從哪來、歷史拿不拿得回來的那幾句。
 *
 * @param notice - 換到這條時要講的那一句（接著上一次、切過來、分叉）；沒有就不講。
 */
export function ConversationNotices({
  conversation,
  notice,
}: {
  readonly conversation: Conversation;
  readonly notice: string | undefined;
}) {
  return (
    <div className="space-y-1">
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
        {...(conversation.slashNotice === undefined
          ? {}
          : { slashNotice: conversation.slashNotice })}
        {...(conversation.reconnecting === undefined
          ? {}
          : { reconnecting: conversation.reconnecting })}
        recovered={conversation.recovered}
        onReconnect={conversation.reconnectNow}
      />
      {/* 不掛 `role="status"`：那一格歸 `StatusLine`，這一句是背景，不是現況。
          伺服器不收這條下行時（thread 數滿了）不講「接著上一次／之前的對話回來了」：跟狀態列的「打不開」矛盾（#1483）。 */}
      {notice !== undefined && conversation.refusal === undefined && (
        <p className="text-muted-foreground text-tip">{notice}</p>
      )}
      {conversation.history?.legacy === true && (
        <p className="text-muted-foreground text-tip">{LEGACY_THREAD_NOTICE}</p>
      )}
      {conversation.historyError !== undefined && (
        <p className="text-destructive text-tip">
          {/* thread 數滿了、歷史太深、日誌超過額度、被別處握著、開在別的 home 或工作區都不是歷史掉了：換成那一句，不加這個前綴（#1478、#1753、#2203、#2214、#2222）。 */}
          {threadCapacityText(conversation.historyError.code) ??
            threadHistoryTooDeepText(conversation.historyError.code) ??
            threadLogBudgetText(conversation.historyError.code) ??
            threadWriterHeldText(conversation.historyError.code) ??
            threadRootMismatchText(conversation.historyError.code) ??
            `之前說過的話拿不回來：${conversation.historyError.message}`}
        </p>
      )}
    </div>
  );
}
