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
  Disposer,
  RegisterOptions,
  ScopeKey,
} from './registry.js';
export { createRegistry } from './registry.js';

export type { LoadResult } from './load.js';
export { loadPlugins } from './load.js';

export type { ApprovalPolicy, FoldOptions, FoldedAgentParams } from './fold.js';
export { foldRegistry, TOOL_ORDER_REST } from './fold.js';

export type {
  SessionEvent,
  SessionEventMap,
  SessionEventType,
  SessionLogListener,
  SessionLogOptions,
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

// 配套入口（`./invariant`）刻意**不從主入口再匯出**，形狀照 dsh：那邊每個 package 的
// 配套入口都只掛在 `<pkg>/invariant` 這個子路徑上，import 主入口不會把它拖進來。
