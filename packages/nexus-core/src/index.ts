/**
 * `@nexus/core`——NexusPlugin 契約與 fold。
 *
 * 這裡是純轉換層：只產出參數，不呼叫 `createDeepAgent`。那一次呼叫住在
 * `apps/harness`，而且只有那一個地方。
 */

export type { NexusPlugin, PluginEntry, PluginManifest, PluginOrigin } from './plugin.js';
export {
  pluginManifestSchema,
  parsePluginManifest,
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
  createApprovalGateMiddleware,
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
export { TODO_STATUSES } from './todo.js';

export type { NamedEntry, DuplicateErrorFactory } from './entries.js';
export { AnonymousEntries, NamedEntries, CapabilitySet } from './entries.js';

export type {
  PluginRegistry,
  InternalPluginRegistry,
  ToolRegistrationPoint,
  SubAgentRegistrationPoint,
  CapabilityRegistrationPoint,
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
  ScopeKey,
} from './registry.js';
export { createRegistry } from './registry.js';

export type { LoadResult } from './load.js';
export { loadPlugins } from './load.js';

export {
  CONTAINMENT_MIDDLEWARE_NAME,
  createContainmentMiddleware,
  formatToolFailure,
  resolveToolName,
} from './containment.js';

export {
  createObservationPolicy,
  OBSERVATION_POLICY_MIDDLEWARE_NAME,
  OBSERVATION_POLICY_NOTICE,
  OBSERVED_EDIT_TOOL,
  OBSERVED_READ_TOOL,
  OBSERVED_WRITE_TOOL,
} from './observation.js';

export type { ApprovalPolicy, FoldOptions, FoldedAgentParams } from './fold.js';
export { foldRegistry, ROOT_ONLY_NOTICE, rootOnlyRefusal, TOOL_ORDER_REST } from './fold.js';
export type { ModelUsage } from './model-usage.js';
export {
  createModelUsageRecorder,
  MODEL_USAGE_MIDDLEWARE_NAME,
  readModelUsage,
} from './model-usage.js';
export type { RepeatReminderMark, RepeatReminderSettings } from './repeat-reminder.js';
export {
  createRepeatReminder,
  DEFAULT_REPEAT_REMINDER,
  REPEAT_REMINDER_MARKER,
  REPEAT_REMINDER_MIDDLEWARE_NAME,
  resolveRepeatReminderSettings,
} from './repeat-reminder.js';
export type {
  SummarizationArgTruncation,
  SummarizationSettings,
  SummarizationThreshold,
} from './summarization.js';
export {
  createSummarizer,
  DEFAULT_SUMMARIZATION,
  resolveSummarizationSettings,
  SUMMARIZATION_MIDDLEWARE_NAME,
} from './summarization.js';
export type {
  ToolResultPruneConfig,
  ToolResultPruneResult,
} from './tool-result-pruner.js';
export {
  assertToolResultPruneConfig,
  codePointLength,
  DEFAULT_TOOL_RESULT_PRUNE,
  measureToolResultContent,
  pruneToolResultContent,
  pruneToolResults,
  TOOL_RESULT_PRUNE_MARKER,
} from './tool-result-pruner.js';

export type {
  SessionEvent,
  SessionEventMap,
  SessionEventType,
  SessionLogListener,
  SessionLogOptions,
  SessionLogView,
} from './session-log.js';
export { SessionLog } from './session-log.js';

export type {
  SessionTelemetryRecord,
  SessionTelemetryRedactRule,
  SessionTelemetryService,
  SessionTelemetrySeverity,
  SessionTelemetrySharingStatus,
  SessionTelemetrySink,
} from './session-telemetry.js';

export type {
  SessionTelemetryCapture,
  SessionTelemetryCoordinatorOptions,
} from './session-telemetry-coordinator.js';
export { SessionTelemetryCoordinator } from './session-telemetry-coordinator.js';

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
