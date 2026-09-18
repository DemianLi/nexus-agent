/**
 * `@nexus/wire`——`apps/web` 與 agent 之間那條線的協定層。
 *
 * 存在的唯一理由是它有兩個消費者：Node 那端的 pump 與 handler 在 `@nexus/harness`，
 * 瀏覽器那端在 `apps/web`，而封包、SSE 編解碼、route 與 channel 白名單兩邊必須是同一份。
 * 它沒有任何執行期相依（`@langchain/protocol` 只 `import type`），所以把它拉進
 * 瀏覽器不會順手把 Node 那半邊拖進去。
 *
 * 形狀與未採納清單見開發計劃第 7 節決策 6。
 */

export type {
  Channel,
  Command,
  CommandResponse,
  ErrorCode,
  ErrorResponse,
  Event,
  EventStreamRequest,
  FeedbackCommand,
  FeedbackDeleteCommand,
  FeedbackDeleteResult,
  FeedbackListCommand,
  FeedbackListResult,
  FeedbackMethod,
  FeedbackPutCommand,
  FeedbackPutResult,
  FeedbackRecordCommand,
  FeedbackRecordResult,
  FeedbackTargetNotFound,
  FeedbackVersionConflict,
  InputRespondOne,
  RpcMethod,
  RunCancelCommand,
  RunStartParams,
  SlashCommand,
  SlashDescriptor,
  SlashInputDescriptor,
  SlashListCommand,
  SlashListResult,
  SlashMethod,
  SlashRunCommand,
  SlashRunResult,
  ThreadHistoryQuery,
  ThreadHistoryResponse,
  ThreadHistoryResult,
  ThreadListResponse,
  ThreadListResult,
  ThreadSummary,
  UplinkMethod,
  WireChannel,
  WireFeedbackCategory,
  WireFeedbackItem,
  WireFeedbackRating,
} from './protocol.js';
export {
  FEEDBACK_METHODS,
  HISTORY_PAGE_MESSAGES,
  historyPath,
  isFeedbackMethod,
  RUN_CANCEL_METHOD,
  SLASH_METHODS,
  THREADS_PATH,
  UPLINK_METHODS,
  WIRE_CHANNELS,
  channelOfMethod,
  commandPath,
  errorResponse,
  eventId,
  isRpcMethod,
  isRunCancelMethod,
  isSlashMethod,
  isUplinkMethod,
  isWireChannel,
  streamPath,
  successResponse,
} from './protocol.js';

export { decodeSseStream, encodeSseFrame } from './sse.js';

export type {
  AiEntry,
  AnswerEntry,
  Attribution,
  ConversationEntry,
  ConversationState,
  ConversationStatus,
  DecisionEntry,
  HumanEntry,
  PendingApproval,
  PendingInput,
  PendingQuestion,
  QuestionItem,
  ToolEntry,
} from './conversation.js';
export {
  APPROVAL_PENDING_KIND,
  QUESTION_PENDING_KIND,
  UNFINISHED_TOOL_TEXT,
  answerResponse,
  appendAnswers,
  appendQuestionCancel,
  cancelResponse,
  appendDecision,
  appendHumanTurn,
  emptyConversation,
  isApprovalPending,
  isQuestionPending,
  prependEntries,
  reduceAll,
  reduceConversation,
  uniformDecisions,
} from './conversation.js';

export type {
  FeedbackOutcome,
  OpenEventsOptions,
  SlashListOutcome,
  SlashRunOutcome,
  ThreadHistoryOutcome,
  ThreadListOutcome,
  UplinkResult,
  WireClient,
  WireClientOptions,
} from './client.js';
export { createWireClient } from './client.js';
