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
  QueueUpdateAction,
  QueueUpdateCommand,
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
  WireErrorCode,
  WireErrorResponse,
} from './protocol.js';
export type {
  DeliverableFileBytes,
  DeliverableFilePage,
  DeliverableFileStat,
  DeliverablesPresentedPayload,
  WirePresentedFile,
} from './deliverables.js';
export {
  deliverableBytesPath,
  deliverableDownloadPath,
  deliverableFilePath,
  DELIVERABLES_PRESENTED,
} from './deliverables.js';
export type {
  WorkspaceChangedFile,
  WorkspaceChangesPayload,
  WorkspaceChangesSummary,
  WorkspaceDiffHunk,
  WorkspaceFileDiff,
} from './workspace-changes.js';
export { changesDiffPath, changesSummaryPath, WORKSPACE_CHANGES } from './workspace-changes.js';
export type {
  FileReferenceCandidate,
  FileReferenceListResponse,
  FileReferenceListResult,
} from './file-references.js';
export { fileReferencesPath } from './file-references.js';
export type {
  ModelUsagePayload,
  WireContextMeasure,
  WireContextPressure,
  WireSummaryThreshold,
} from './context-pressure.js';
export { CONTEXT_MEASURE, MODEL_USAGE } from './context-pressure.js';
export type { TodosPayload, WireTodoItem } from './todos.js';
export type { InboxPayload, WireQueuedInput } from './inbox.js';
export { INBOX } from './inbox.js';
export type { TitlePayload } from './title.js';
export { TITLE } from './title.js';
export { TODOS } from './todos.js';
export type { WireSessionStats, WireTokenUsage } from './session-totals.js';
export { SESSION_STATS, TOKEN_USAGE } from './session-totals.js';
export {
  FEEDBACK_METHODS,
  HISTORY_PAGE_MAX_BYTES,
  HISTORY_PAGE_MESSAGES,
  historyPath,
  isFeedbackMethod,
  isQueueUpdateMethod,
  QUEUE_ITEM_NOT_FOUND,
  QUEUE_UPDATE_METHOD,
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
  DeliverablesEntry,
  ConversationState,
  ConversationStatus,
  DecisionEntry,
  HumanEntry,
  PendingApproval,
  PendingInput,
  PendingQuestion,
  QuestionItem,
  ToolEntry,
  WorkspaceChangesEntry,
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
  FileReferenceListOutcome,
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
