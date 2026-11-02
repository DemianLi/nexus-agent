/**
 * 測試用：註冊表裡**不含共用資源工具**的工具名（[`hub.ts`](./hub.ts)）。
 *
 * 資源工具三支在任何一列走到登記那一步時就在，連起不來的那一列也一樣（照 dsh），所以「這台 server 的工具」
 * 要先把它們扣掉才數得對。不進 `index.ts` 的匯出。
 */

import type { PluginRegistry } from '@nexus/core';
import { RESOURCE_TOOL_NAMES } from './hub.js';

/** 註冊表裡扣掉三支資源工具之後的工具名，依註冊順序。 */
export function modelToolNames(registry: PluginRegistry): string[] {
  const shared: readonly string[] = RESOURCE_TOOL_NAMES;
  return [...registry.tools.effective().keys()].filter((name) => !shared.includes(name));
}
