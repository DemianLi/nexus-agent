/**
 * `@nexus/core`——NexusPlugin 契約。
 *
 * 這裡是純轉換層：只產出參數，不呼叫 `createDeepAgent`。那一次呼叫住在
 * `apps/harness`，而且只有那一個地方。
 */

export type { NexusPlugin, PluginManifest, PluginOrigin } from './plugin.js';
export { pluginManifestSchema, parsePluginManifest, formatOrigin } from './plugin.js';

export type { NamedEntry, DuplicateErrorFactory } from './entries.js';
export { NamedEntries, CapabilitySet } from './entries.js';

export type {
  PluginRegistry,
  InternalPluginRegistry,
  ToolRegistrationPoint,
  SubAgentRegistrationPoint,
  CapabilityRegistrationPoint,
  RegisterOptions,
  ScopeKey,
} from './registry.js';
export { createRegistry } from './registry.js';

export type { LoadResult } from './load.js';
export { loadPlugins } from './load.js';
