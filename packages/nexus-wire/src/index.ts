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
  QueueSteerAction,
  QueueUpdateAction,
  QueueUpdateCommand,
  RpcMethod,
  RunCancelCommand,
  SubagentInterruptCommand,
  SubagentSendCommand,
  RunStartCommand,
  RunStartMode,
  RunStartParams,
  SlashCommand,
  SlashDescriptor,
  SlashInputDescriptor,
  SlashListCommand,
  SlashListResult,
  SlashMethod,
  SlashRunCommand,
  SlashRunResult,
  ThreadFeedFrame,
  ThreadHistoryQuery,
  ThreadHistoryResponse,
  TrajectoryTurnResponse,
  ThreadHistoryResult,
  ThreadListResponse,
  ThreadListResult,
  ThreadInputRequestedFrame,
  ThreadSearchItem,
  ThreadSearchRequest,
  ThreadSearchResponse,
  ThreadSearchResult,
  ThreadInputWithdrawnFrame,
  ThreadStatusFrame,
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
  BinaryAttachmentRef,
  DeliverableBytes,
  DeliverableCommand,
  DeliverableFilePage,
  DeliverableFileStat,
  DeliverableMethod,
  DeliverableReadBytesCommand,
  DeliverableReadBytesParams,
  DeliverableReadBytesResult,
  DeliverableReadCommand,
  DeliverableReadError,
  DeliverableReadParams,
  DeliverableReadResult,
  DeliverableRefusalCode,
  DeliverablesPresentedPayload,
  WirePresentedFile,
} from './deliverables.js';
export {
  DELIVERABLE_METHODS,
  DELIVERABLE_READ_BYTES_METHOD,
  DELIVERABLE_READ_METHOD,
  DELIVERABLES_PRESENTED,
  decodeBinaryResult,
  encodeBinaryResult,
  isBinaryResponse,
  isDeliverableMethod,
} from './deliverables.js';
export type { CustomFrameData, CustomFrameName, CustomFramePayloads } from './custom-frame.js';
export type {
  ImageMediaType,
  PromptAttachment,
  UploadReceipt,
  UploadResponse,
} from './attachments.js';
export {
  IMAGE_MEDIA_TYPES,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  MODEL_DOES_NOT_SUPPORT_IMAGES,
  UPLOAD_NAME_PARAM,
  uploadPath,
} from './attachments.js';
export type {
  ModelCatalog,
  ModelCatalogCommand,
  ModelCatalogModel,
  ModelCatalogResult,
  ModelCommand,
  ModelMethod,
  ModelReasoning,
  ModelReasoningEffort,
  ModelSelectCommand,
  ModelSelection,
  ModelSelectionState,
  ModelSelectResult,
  ModelUnavailable,
} from './model-selection.js';
export { isModelMethod, MODEL_METHODS, MODEL_SELECTION_PROJECTION_KEY } from './model-selection.js';
export type {
  ThreadArchiveCommand,
  ThreadArchiveError,
  ThreadArchiveResult,
  ThreadListSets,
  ThreadManagementCommand,
  ThreadManagementMethod,
  ThreadNotFound,
  ThreadPinCommand,
  ThreadPinError,
  ThreadPinResult,
  ThreadRenameCommand,
  ThreadRenameError,
  ThreadRenameResult,
  ThreadUnarchiveCommand,
  ThreadUnarchiveResult,
  ThreadUnpinCommand,
  ThreadUnpinResult,
} from './thread-management.js';
export { isThreadManagementMethod, THREAD_MANAGEMENT_METHODS } from './thread-management.js';
export type {
  SubagentKind,
  SubagentListCommand,
  SubagentListResult,
  SubagentMention,
} from './subagent-list.js';
export { isSubagentListMethod, SUBAGENT_LIST_METHOD } from './subagent-list.js';
export type { MessageDiscardPayload } from './message-discard.js';
export { MESSAGE_DISCARD } from './message-discard.js';
export type {
  PermissionCatalog,
  PermissionCatalogCommand,
  PermissionCatalogResult,
  PermissionCommand,
  PermissionMethod,
  PermissionSelection,
  PresetOption,
} from './permission-presets.js';
export {
  CUSTOM_PRESET,
  isPermissionMethod,
  PERMISSION_METHODS,
  PERMISSIONS_PROJECTION_KEY,
} from './permission-presets.js';
export type {
  DeliverableClient,
  DeliverableClientOptions,
  DeliverableOutcome,
} from './deliverable-client.js';
export { createDeliverableClient } from './deliverable-client.js';
export type {
  WorkspaceChangedFile,
  WorkspaceChangesPayload,
  WorkspaceChangesSummary,
  WorkspaceDiffHunk,
  WorkspaceFileDiff,
} from './workspace-changes.js';
export {
  changesDiffPath,
  changesDiffUrl,
  changesSummaryPath,
  changesSummaryUrl,
  isChangesDiff,
  isChangesSummary,
  WORKSPACE_CHANGES,
} from './workspace-changes.js';
export type {
  FileReferenceCandidate,
  FileReferenceListResponse,
  FileReferenceListResult,
} from './file-references.js';
export { fileReferencesPath } from './file-references.js';
export type {
  ParsedSessionReferenceText,
  SessionReferenceCandidate,
  SessionReferenceErrorCode,
  SessionReferenceInput,
  SessionReferenceListResponse,
  SessionReferenceListResult,
} from './session-references.js';
export {
  DEFAULT_SESSION_REFERENCE_CANDIDATE_LIMIT,
  decodeSessionReferenceUri,
  encodeSessionReferenceUri,
  formatSessionReferenceMention,
  MAX_SESSION_REFERENCES,
  parseSessionReferenceText,
  SESSION_REFERENCE_SCHEME,
  SessionReferenceError,
  sessionReferencesPath,
} from './session-references.js';
export type {
  ModelUsagePayload,
  WireContextMeasure,
  WireContextPressure,
  WireSummaryThreshold,
} from './context-pressure.js';
export { CONTEXT_MEASURE, MODEL_USAGE } from './context-pressure.js';
export type { CompactionPayload } from './compaction.js';
export type { GoalPayload, WireGoal, WireGoalBlockedReason, WireGoalPhase } from './goal.js';
export type { PlanModePayload } from './plan-mode.js';
export type { ProjectionPayload, WireProjection } from './projection.js';
export type { TodosPayload, WireTodoItem } from './todos.js';
export type {
  AgentMessagePayload,
  InboxPayload,
  SettleNoticePayload,
  WireClaimedInput,
  WireClaimedSource,
  WireQueuedInput,
  WireQueuedInputSource,
  WireSessionReference,
  WireSettleReason,
} from './inbox.js';
export { AGENT_MESSAGE, INBOX, SETTLE_NOTICE, SETTLE_REASONS, isSettleReason } from './inbox.js';
export type { TitlePayload } from './title.js';
export { SUBAGENT_STATUS } from './subagent-status.js';
export { SUBAGENT_CATALOG } from './subagent-catalog.js';
export type { SubagentCatalogPayload } from './subagent-catalog.js';
export type { SubagentRunStatus, SubagentStatusPayload } from './subagent-status.js';
export { COMPACTION } from './compaction.js';
export { GOAL, GOAL_PHASES } from './goal.js';
export { PLAN_MODE } from './plan-mode.js';
export { PROJECTION, PROJECTION_KEY_PATTERN } from './projection.js';
export { TITLE } from './title.js';
export { TODOS } from './todos.js';
export type { WireSessionStats, WireTokenUsage } from './session-totals.js';
export { SESSION_STATS, TOKEN_USAGE } from './session-totals.js';
export {
  FEEDBACK_METHODS,
  HISTORY_PAGE_MAX_BYTES,
  HISTORY_PAGE_MESSAGES,
  historyPath,
  subagentHistoryPath,
  trajectoryTurnPath,
  isFeedbackMethod,
  isQueueUpdateMethod,
  isSubagentMethod,
  QUEUE_ITEM_NOT_FOUND,
  QUEUE_UPDATE_METHOD,
  RUN_CANCEL_METHOD,
  RUN_START_MODES,
  SLASH_METHODS,
  STEER_UNAVAILABLE,
  SUBAGENT_AT_CAPACITY,
  SUBAGENT_CLOSED,
  SUBAGENT_INTERRUPT_METHOD,
  SUBAGENT_NOT_FOUND,
  TURN_NOT_FOUND,
  SUBAGENT_SEND_METHOD,
  THREAD_FEED_PATH,
  THREAD_SEARCH_PATH,
  THREAD_SEARCH_QUERY_MAX_LENGTH,
  THREAD_SEARCH_RESULT_LIMIT,
  THREAD_SEARCH_SNIPPET_MAX_CODE_POINTS,
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
  isThreadFeedFrame,
  isUplinkMethod,
  isWireChannel,
  streamPath,
  successResponse,
} from './protocol.js';

export { decodeSseData, decodeSseStream, encodeSseData, encodeSseFrame } from './sse.js';

export type {
  AiEntry,
  AnswerEntry,
  Attribution,
  BackgroundSubagentMeta,
  AgentMessageEntry,
  CompactionEntry,
  ConversationEntry,
  DeliverablesEntry,
  ConversationState,
  ConversationStatus,
  DecisionEntry,
  HumanEntry,
  NoticeEntry,
  PendingApproval,
  PendingInput,
  PendingQuestion,
  QuestionOrigin,
  PlanReviewIntent,
  QuestionItem,
  ToolEntry,
  WorkspaceChangesEntry,
} from './conversation.js';
export {
  APPROVAL_PENDING_KIND,
  DELEGATION_TOOL_NAMES,
  isBackgroundSubagentMeta,
  QUESTION_PENDING_KIND,
  UNFINISHED_TOOL_CODE,
  UNFINISHED_TOOL_TEXT,
  answerResponse,
  appendAnswers,
  appendQuestionCancel,
  appendQuestionDecline,
  cancelResponse,
  declineResponse,
  appendDecision,
  emptyConversation,
  isApprovalPending,
  isQuestionPending,
  prependEntries,
  reduceAll,
  reduceConversation,
  uniformDecisions,
} from './conversation.js';

export type {
  CommandOutcome,
  FeedbackOutcome,
  FileReferenceListOutcome,
  OpenEventsOptions,
  SessionReferenceListOutcome,
  SlashListOutcome,
  SlashRunOutcome,
  ThreadHistoryOutcome,
  TrajectoryTurnOutcome,
  ThreadListOutcome,
  ThreadSearchOutcome,
  UploadOutcome,
  UploadProgress,
  UploadProgressEvent,
  UploadXhr,
  UplinkResult,
  WireClient,
  WireClientOptions,
} from './client.js';
export { createWireClient } from './client.js';
export type {
  RequestHeaderSnapshot,
  RequestSnapshotsView,
  RequestSystemSnapshot,
  TrajectoryCall,
  TrajectoryApproval,
  TrajectoryApprovalOutcome,
  TrajectoryDecision,
  TrajectoryDigest,
  TrajectoryElided,
  TrajectoryEnd,
  TrajectoryInput,
  TrajectoryReply,
  TrajectoryRetry,
  TrajectorySubagentLink,
  TrajectoryTool,
  TrajectoryTurn,
  TrajectoryTurnDetail,
  TrajectoryTurnKind,
  TrajectoryTurnQuery,
  TrajectoryView,
} from './trajectory.js';
export {
  REQUEST_SNAPSHOTS_KEEP,
  REQUEST_SNAPSHOTS_PROJECTION,
  REQUEST_SNAPSHOTS_VERSION,
  REQUEST_SYSTEM_MAX_CHARS,
  TRAJECTORY_CALL_TOOLS_CAP,
  TRAJECTORY_DETAIL_TURNS,
  TRAJECTORY_DIGEST_CAP,
  TRAJECTORY_PREVIEW_CHARS,
  TRAJECTORY_PROJECTION,
  TRAJECTORY_TURN_CALLS_CAP,
  TRAJECTORY_TURN_LIST_CAP,
  TRAJECTORY_VERSION,
} from './trajectory.js';
export type {
  TokenMeterEarlier,
  TokenMeterEnd,
  TokenMeterLink,
  TokenMeterModelRow,
  TokenMeterModelsOther,
  TokenMeterSpan,
  TokenMeterToolRow,
  TokenMeterToolsOther,
  TokenMeterTurn,
  TokenMeterView,
} from './token-meter.js';
export {
  TOKEN_METER_CALIBER,
  TOKEN_METER_LINKS_CAP,
  TOKEN_METER_MODELS_CAP,
  TOKEN_METER_PROJECTION,
  TOKEN_METER_TOOL_NAMES_CAP,
  TOKEN_METER_TURNS_KEEP,
  TOKEN_METER_VERSION,
} from './token-meter.js';
