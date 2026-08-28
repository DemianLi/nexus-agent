/**
 * `@nexus/core`——NexusPlugin 契約與 fold。
 *
 * 這裡是純轉換層：只產出參數，不呼叫 `createDeepAgent`。那一次呼叫住在
 * `apps/harness`，而且只有那一個地方。
 */

export type { NexusPlugin, PluginManifest, PluginOrigin } from './plugin.js';
export { pluginManifestSchema, parsePluginManifest, formatOrigin } from './plugin.js';

export type {
  AgentCheckpointer,
  AgentMiddleware,
  AgentModel,
  AgentStore,
  InterruptOnConfig,
  WhenPredicate,
} from './base-types.js';

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
  InterruptRegistrationPoint,
  InterruptRequirement,
  SkillSourceRegistrationPoint,
  MemorySourceRegistrationPoint,
  LifecycleRegistrationPoint,
  Disposer,
  RegisterOptions,
  ScopeKey,
} from './registry.js';
export { createRegistry } from './registry.js';

export type { LoadResult } from './load.js';
export { loadPlugins } from './load.js';

export type { ApprovalPolicy, FoldOptions, FoldedAgentParams } from './fold.js';
export { foldRegistry, TOOL_ORDER_REST } from './fold.js';
