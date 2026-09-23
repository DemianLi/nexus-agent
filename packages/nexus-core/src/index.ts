/**
 * `@nexus/core`——NexusPlugin 契約與 fold。
 *
 * 這裡是純轉換層：只產出參數，不呼叫 `createDeepAgent`。那一次呼叫住在
 * `apps/harness`，而且只有那一個地方。
 */

export type {
  EntryManifest,
  NexusPlugin,
  PluginEntry,
  PluginManifest,
  PluginOrigin,
  ResolvedPluginEntry,
} from './plugin.js';
export {
  entryManifestSchema,
  pluginManifestSchema,
  parseEntry,
  parseEntryConfig,
  resolveEntries,
  formatOrigin,
} from './plugin.js';

export type { AgentCheckpointer, AgentMiddleware, AgentModel, AgentStore } from './base-types.js';

export type {
  ToolExecution,
  PreToolDecision,
  PreToolListener,
  ApprovalChannel,
} from './approval.js';
export {
  APPROVAL_GATE_MIDDLEWARE_NAME,
  APPROVAL_GATE_PLUGIN_NAME,
  approvalGatePlugin,
  APPROVAL_INTERRUPT_KIND,
  QUESTION_INTERRUPT_KIND,
  createApprovalGateMiddleware,
  deriveApprovalChannel,
  runApprovalGate,
} from './approval.js';

export type {
  CommandDefinition,
  CommandDescriptor,
  CommandInputDescriptor,
  CommandInvocation,
  CommandResult,
} from './commands.js';
export { COMMAND_NAME_PATTERN, normalizeCommandDefinition } from './commands.js';

export type {
  GoalBlockReason,
  GoalChangeMeta,
  GoalClearChangeMeta,
  GoalId,
  GoalOperation,
  GoalPhase,
  GoalRef,
  GoalSnapshot,
  GoalSnapshotChangeMeta,
} from './goal.js';
export { GOAL_CHANGE_VERSION, goalId } from './goal.js';

export type { TodoItem, TodoStatus } from './todo.js';
export type { PresentedFile } from './deliverables.js';
export { TODO_STATUSES } from './todo.js';

export type {
  SandboxDenial,
  SandboxGrant,
  SandboxGrantLedger,
  SandboxMode,
  SandboxModeSource,
} from './sandbox.js';
export { isSandboxMode, SANDBOX_MODES, WORKSPACE_CAPABILITY } from './sandbox.js';

export type { NamedEntry, DuplicateErrorFactory } from './entries.js';
export { AnonymousEntries, NamedEntries, CapabilitySet } from './entries.js';

export type {
  PluginRegistry,
  InternalPluginRegistry,
  DisabledEntryView,
  ToolRegistrationPoint,
  SubAgentRegistrationPoint,
  CapabilityRegistrationPoint,
  ServiceRegistrationPoint,
  NexusServices,
  KnownServiceName,
  BackendRegistrationPoint,
  MiddlewareRegistrationPoint,
  MiddlewareRegistration,
  PermissionRegistrationPoint,
  DenyRule,
  ApprovalRegistrationPoint,
  SkillSourceRegistrationPoint,
  MemorySourceRegistrationPoint,
  LifecycleRegistrationPoint,
  InvariantRegistrationPoint,
  TelemetryRegistrationPoint,
  CommandRegistrationPoint,
  SessionRegistrationPoint,
  SessionLookup,
  Disposer,
  RegisterOptions,
  RootOnlyRefusal,
  ScopeKey,
} from './registry.js';
export { createRegistry } from './registry.js';
export type { HostServices } from './host-services.js';
export { createHostServicesPlugin } from './host-services.js';

export type { LoadResult } from './load.js';
export { loadPlugins } from './load.js';

export type { ToolEventSessions } from './containment.js';
export {
  classifyThrownToolError,
  CONTAINMENT_MIDDLEWARE_NAME,
  createContainmentMiddleware,
  declaredToolTimeoutMs,
  formatToolFailure,
  formatToolTimeout,
  isToolTimeout,
  resolveToolName,
} from './containment.js';

export type { OutputSchemaLookup } from './output-schema.js';
export {
  createOutputSchemaMiddleware,
  formatSchemaViolation,
  formatValidatorFailure,
  OUTPUT_SCHEMA_MIDDLEWARE_NAME,
} from './output-schema.js';

export type { LoggedMessage } from './logged-message.js';
export { fromLoggedMessage, toLoggedMessage } from './logged-message.js';

export type {
  ConversationReplay,
  ReplayOptions,
  UnreplayableReason,
} from './conversation-replay.js';
export {
  replayConversation,
  TOOL_NOT_STARTED_TEXT,
  TOOL_OUTCOME_UNKNOWN_TEXT,
} from './conversation-replay.js';

export type { ToolErrorInfo, ToolOutcome } from './tool-events.js';
export {
  INVALID_ARGS,
  INVALID_TOOL_OUTPUT,
  markToolError,
  readToolOutcome,
  TOOL_ABORTED,
  TOOL_ABORTED_BEFORE_DISPATCH,
  TOOL_ERROR_PREFIX,
  TOOL_NOT_STARTED,
  TOOL_OUTCOME_UNKNOWN,
  TOOL_TIMEOUT,
  toolCallIdOf,
  toolErrorOf,
  toolFeedback,
  toolRefusal,
  UNKNOWN_TOOL,
} from './tool-events.js';

export {
  createObservationPolicy,
  OBSERVATION_POLICY_MIDDLEWARE_NAME,
  OBSERVATION_POLICY_NOTICE,
  OBSERVATION_POLICY_PLUGIN_NAME,
  observationPolicyPlugin,
  OBSERVED_EDIT_TOOL,
  OBSERVED_READ_TOOL,
  OBSERVED_WRITE_TOOL,
} from './observation.js';

export {
  createFsToolErrorsMiddleware,
  FS_SANDBOX_DENIED,
  FS_TOOL_ERRORS_MIDDLEWARE_NAME,
  FS_TOOL_PRIMARY_METHOD,
  noteSandboxDenial,
  recordBackendOutcomes,
} from './fs-tool-errors.js';

export type { InvalidArgumentsCarrier } from './invalid-tool-args.js';
export {
  createInvalidArgumentsCarrier,
  createInvalidToolArgsMiddleware,
  INVALID_ARGUMENTS_REFUSAL,
  INVALID_TOOL_ARGS_MIDDLEWARE_NAME,
  repairInvalidToolCalls,
} from './invalid-tool-args.js';

export type { ApprovalPolicy, FoldOptions, FoldedAgentParams } from './fold.js';
export { foldRegistry, ROOT_ONLY_NOTICE, rootOnlyRefusal, TOOL_ORDER_REST } from './fold.js';
export { createModelCallRecorder, MODEL_CALL_EVENTS_MIDDLEWARE_NAME } from './model-calls.js';
export {
  createSubagentDelegationMiddleware,
  SUBAGENT_DELEGATION_CONTEXT,
  SUBAGENT_DELEGATION_MIDDLEWARE_NAME,
} from './subagent-delegation.js';
export {
  createTurnCancelGuard,
  createTurnCancelModelSignal,
  INTERRUPTED_REPLY_MARKER,
  isTurnCancelled,
  TOOL_ABORTED_BEFORE_DISPATCH_REASON,
  TOOL_ABORTED_BEFORE_DISPATCH_TEXT,
  TOOL_ABORTED_REASON,
  TOOL_ABORTED_TEXT,
  TURN_CANCEL_CONFIG_KEY,
  TURN_CANCEL_MIDDLEWARE_NAME,
  TURN_CANCEL_MODEL_SIGNAL_MIDDLEWARE_NAME,
  TurnCancelledError,
  turnCancelSignalOf,
} from './turn-cancel.js';
export type { SessionStats, SessionStatsState } from './session-stats.js';
export { deriveSessionStats, sessionStatsUnit } from './session-stats.js';
export type { ModelUsage } from './model-usage.js';
export {
  createModelUsageRecorder,
  MODEL_USAGE_MIDDLEWARE_NAME,
  MODEL_USAGE_PLUGIN_NAME,
  modelUsagePlugin,
  readModelUsage,
} from './model-usage.js';
export type {
  RepeatReminderConfig,
  RepeatReminderMark,
  RepeatReminderSettings,
} from './repeat-reminder.js';
export {
  createRepeatReminder,
  DEFAULT_REPEAT_REMINDER,
  GOAL_WRAPUP_MARKER,
  REPEAT_REMINDER_MARKER,
  REPEAT_REMINDER_MIDDLEWARE_NAME,
  REPEAT_REMINDER_PLUGIN_NAME,
  REPEAT_REMINDER_SERVICE,
  repeatCallKey,
  repeatReminderConfigSchema,
  repeatReminderPlugin,
  repeatReminderTracks,
  resolveRepeatReminderSettings,
} from './repeat-reminder.js';
export type {
  SummarizationArgTruncation,
  SummarizationConfig,
  SummarizationSettings,
  SummarizationThreshold,
} from './summarization.js';
export {
  createSummarizer,
  DEFAULT_SUMMARIZATION,
  effectiveMessages,
  isUnderCompactionPressure,
  readSummarizationEvent,
  resolveSummarizationSettings,
  SUMMARIZATION_MIDDLEWARE_NAME,
  SUMMARIZATION_PLUGIN_NAME,
  SUMMARIZATION_SERVICE,
  summarizationConfigSchema,
  summarizationPlugin,
} from './summarization.js';
export type {
  ToolResultPruneConfig,
  ToolResultPruneResult,
  ToolResultPrunerConfig,
} from './tool-result-pruner.js';
export {
  assertToolResultPruneConfig,
  codePointLength,
  DEFAULT_TOOL_RESULT_PRUNE,
  measureToolResultContent,
  pruneToolResultContent,
  pruneToolResults,
  TOOL_RESULT_PRUNE_MARKER,
  TOOL_RESULT_PRUNE_SERVICE,
  TOOL_RESULT_PRUNER_PLUGIN_NAME,
  toolResultPrunerConfigSchema,
  toolResultPrunerPlugin,
} from './tool-result-pruner.js';

export type {
  CurrentMessageFeedback,
  FeedbackCategory,
  FeedbackRecord,
  FeedbackRecordResult,
  FeedbackRejected,
  FeedbackService,
  FeedbackSuccess,
  MessageFeedbackDelete,
  MessageFeedbackDeleteRequest,
  MessageFeedbackDeleteResult,
  MessageFeedbackFailure,
  MessageFeedbackItem,
  LegacyTurnFeedbackItem,
  MessageFeedbackListResult,
  MessageFeedbackNoteBlank,
  MessageFeedbackNoteTooLarge,
  MessageFeedbackPut,
  MessageFeedbackPutRequest,
  MessageFeedbackPutResult,
  MessageFeedbackRating,
  MessageFeedbackTargetNotFound,
  MessageFeedbackVersionConflict,
} from './feedback.js';
export {
  currentMessageFeedback,
  FEEDBACK_CATEGORIES,
  loggedMessageId,
  MESSAGE_FEEDBACK_SERVICE,
} from './feedback.js';

export type {
  SessionEvent,
  SessionEventMap,
  SessionEventType,
  SessionLogListener,
  SessionLogOptions,
  SessionLogView,
  TurnEndReason,
} from './session-log.js';
export { currentTurnStart, hasUnansweredInterrupt, SessionLog } from './session-log.js';

export type {
  SessionTelemetryRecord,
  SessionTelemetryRedactRule,
  SessionTelemetryService,
  SessionTelemetrySeverity,
  SessionTelemetrySharingStatus,
  SessionTelemetrySink,
} from './session-telemetry.js';
export { isFeedbackEvent, SESSION_TELEMETRY_SERVICE } from './session-telemetry.js';

export type {
  SessionTelemetryCapture,
  SessionTelemetryCoordinatorOptions,
} from './session-telemetry-coordinator.js';
export { SessionTelemetryCoordinator } from './session-telemetry-coordinator.js';

export type {
  ResumedStoredSession,
  SessionStore,
  StoredSession,
  StoredSessionHeader,
} from './session-store.js';
export {
  SESSION_LOG_FORMAT_VERSION,
  SessionAlreadyOwnedError,
  SessionNotFoundError,
  SessionCorruptionError,
  SessionFormatUnsupportedError,
} from './session-store.js';

export type {
  SessionPersistenceConfig,
  SessionPersistenceCoordinatorOptions,
} from './session-persistence.js';
export {
  attachSessionPersistence,
  DEFAULT_PERSISTENCE_WINDOW_MS,
  MAX_PERSISTENCE_WINDOW_MS,
  SESSION_PERSISTENCE_PLUGIN_NAME,
  sessionPersistenceConfigSchema,
  sessionPersistencePlugin,
  SessionPersistenceCoordinator,
} from './session-persistence.js';

export type {
  InvariantCompanion,
  InvariantInstaller,
  InvariantRunnerOptions,
  InvariantSelection,
  InvariantSubject,
} from './invariants.js';
export type { InvariantFailure } from './invariants.js';
export { assertInvariantSelection, createInvariantRunner, InvariantError } from './invariants.js';

export type { SessionInstaller, SessionRunnerOptions, SessionSubject } from './sessions.js';
export { createSessionRunner } from './sessions.js';
export type { SessionAddress } from './session-address.js';
export { sessionAddressKey, toolCallSessionAddress } from './session-address.js';
export type { SessionEntry, SessionObserver, SessionRegistryOptions } from './session-registry.js';
export { SessionRegistry } from './session-registry.js';

// 配套入口（`./invariant`）刻意**不從主入口再匯出**，形狀照 dsh：那邊每個 package 的
// 配套入口都只掛在 `<pkg>/invariant` 這個子路徑上，import 主入口不會把它拖進來。
