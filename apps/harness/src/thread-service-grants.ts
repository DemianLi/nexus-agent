/**
 * 樹上的插件經 `tools.threadSource` 能讀哪幾個宿主服務（#2533）。
 *
 * 鍵是那一列的模組 specifier（`cordis.yml` 的 `name`），值是允許它讀的服務名。不在表上的模組一個都不能讀：樹上的插件不一定是
 * 我們自己寫的，而這些服務裡有憑證、連線池與答題管道。宣告了沒授權的服務，登記當下就拋，那一列起不來。
 *
 * @module
 */

import { CHANNEL_SERVICE } from '@nexus/core';
import {
  MCP_CREDENTIALS_SERVICE,
  MCP_GUARD_SERVICE,
  MCP_POOL_SERVICE,
  MCP_SANDBOX_SERVICE,
} from '@nexus/plugin-mcp';

/** 模組 specifier → 允許它讀的宿主服務名。 */
export type ThreadServiceGrants = ReadonlyMap<string, readonly string[]>;

/** 出廠的授權表：只有 mcp。 */
export const DEFAULT_THREAD_SERVICE_GRANTS: ThreadServiceGrants = new Map([
  [
    '@nexus/plugin-mcp',
    [
      CHANNEL_SERVICE,
      MCP_POOL_SERVICE,
      MCP_CREDENTIALS_SERVICE,
      MCP_SANDBOX_SERVICE,
      MCP_GUARD_SERVICE,
    ],
  ],
]);

/**
 * 宣告的服務裡沒授權給這個模組的那幾個。
 *
 * @param grants - 授權表。
 * @param module - 那一列的模組 specifier；認不出來是 `undefined`，一個都不授權。
 * @param services - 宣告要讀的服務名。
 * @returns 沒授權的服務名，照宣告的順序；全部授權是空陣列。
 */
export function deniedThreadServices(
  grants: ThreadServiceGrants,
  module: string | undefined,
  services: readonly string[],
): readonly string[] {
  const allowed = module === undefined ? undefined : grants.get(module);
  return services.filter((name) => allowed?.includes(name) !== true);
}
