/**
 * 組裝點把自己手上的協作者交進 registry 的那一個條目。
 *
 * **dsh 沒有「組裝點外掛一個物件」這種東西**：它的 root `ctx` 就在同一棵 context 樹上，
 * 每一個服務提供者都是 plugin（`ctx.provide('workspaceChanges', service)`，
 * `references/deepseek-harness/packages/deliverables/workspace-changes/src/index.ts:118`，
 * SHA `6b1808f`）。我們照它：組裝點**也貢獻一個條目**，不另開 `createNexusAgent` 的參數。
 * 一種機制，不是兩種。
 *
 * **放在清單最前面。** 載入是一趟到底的（見 `ServiceRegistrationPoint` 的偏離登記），
 * 而消費者讀取服務的時刻不一樣——`@nexus/plugin-submit-record` 與 harness 的
 * `sandbox-policy` 在自己的 `apply` 當下就讀，`@nexus/plugin-ask-user` 到工具被叫的時候
 * 才讀。排最前面三種都對；排在後面前兩種會拿不到。
 *
 * @module
 */

import type { NexusPlugin, PluginEntry } from './plugin.js';
import type { NexusServices } from './registry.js';

/**
 * 這個條目要提供的東西：已經宣告過型別的服務照型別收，其餘的照名字收。
 *
 * **`undefined` 的那一格當作「沒有」**，不是「提供一個 undefined」：組裝點手上好幾個
 * 協作者本來就是可有可無的（沒有 `--workspace` 就沒有 backend），讓呼叫端寫
 * `{ backend }` 而不是每一格都自己展開條件。
 */
export type HostServices = {
  [K in keyof NexusServices]?: NexusServices[K] | undefined;
} & {
  readonly [name: string]: unknown;
};

/**
 * 建一個「只提供服務」的條目。
 *
 * @param services - 服務名 → 物件。值是 `undefined` 的那幾格整個跳過。
 * @param name - plugin 名，省略即 `host-services`。一次組裝要交兩批時才會用到。
 * @returns 可以放進組裝點清單的條目，**放最前面**。
 */
export function createHostServicesPlugin(
  services: HostServices,
  name = 'host-services',
): PluginEntry {
  const plugin: NexusPlugin = {
    name,
    apply(registry) {
      for (const [serviceName, value] of Object.entries(services)) {
        if (value === undefined) continue;
        registry.services.provide(serviceName, value);
      }
    },
  };
  return { plugin };
}
