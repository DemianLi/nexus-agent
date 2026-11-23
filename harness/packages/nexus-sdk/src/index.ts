/**
 * `@nexus/sdk`：插件規範的最小切片（決議 §3-4 第 10、12、14、15 條；#1416）。
 *
 * 外部插件只相依這個套件與服務定義套件（例如 `@nexus/tools`），不相依 `@nexus/core`（第 17 條）。
 * 規範全文見 [`docs/plugin-contract.md`](../../../docs/plugin-contract.md)。
 *
 * @module
 */

export {
  CODE_RELOADS,
  CONFIG_RELOADS,
  REQUIRED_FIELDS,
  ManifestError,
  defineManifest,
  effectiveReload,
  isStrictObjectSchema,
  validateManifest,
} from './manifest.js';
export type {
  CodeReload,
  ConfigReload,
  Consume,
  Manifest,
  ManifestIssue,
  Provide,
  Reload,
} from './manifest.js';

export { defineToken, injectOf, need, optionalService, service } from './token.js';
export type { Need, ServiceToken } from './token.js';

export { ContractError, ContractService } from './contract.js';
export type { ContractIntercept } from './contract.js';

export { FIBER_STATE, checkConformance, fiberOf, missingServices } from './conformance.js';
export type { ConformanceCheck, ConformanceFailure, ConformanceTarget } from './conformance.js';

export { checkSharedAcrossThreads } from './shared-across-threads.js';
export type {
  SharedAcrossThreadsCheck,
  SharedAcrossThreadsFailure,
  SharedAcrossThreadsTarget,
  ThreadStep,
} from './shared-across-threads.js';
