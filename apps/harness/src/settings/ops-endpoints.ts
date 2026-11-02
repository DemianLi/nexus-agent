/**
 * serve 的**探針與指標端點的設定條目**（[#1535](https://github.com/DemianLi/nexus-agent/issues/1535)）。端點本體見 `../ops-endpoints.ts`。
 *
 * **這一顆不裝功能，只講設定**，`apply` 是空的，同 `thread-capacity`、`memory-gauge`：值由 `startupSetting` 在起動期讀出來，
 * 交給 `serve.ts` 組路由。**改了要重啟 serve**（分類 `startup-read`，`plugin-row-classes.ts`）。
 *
 * - **探針**（`/livez`、`/readyz`）預設開、免登入，本文只有狀態字（Q1 (a)）。
 * - **指標**（`/metrics`）預設關；打開後要 `Authorization: Bearer <token>`，token 在 `tokenFile`（預設 `<home>/metrics-token`，`0600`，沒有就建）。
 * - **收尾時間窗**（`probes.drainMs`，#1777）：`close()` 立旗後先讓 listener 照常在聽一小段時間，`/readyz` 才有機會回 `503 closing`；
 *   見 `serve.ts` 的 `close`。
 *
 * 關掉這一列（`disabled: true`）等於沒有這一列、值回到預設：探針開、指標關。要連探針也關，把 `probes.enabled` 設成 `false`。
 *
 * ## 偏離 dsh：產品需求超出 dsh
 *
 * dsh 沒有探針端點，也沒有指標出口（`687f282e`：唯一相關的是 OTel 的 `selfObsMeterProvider` 被刻意排除），所以這一列沒有對照。判準取公開的慣例：
 * 探針語意取 Kubernetes 的 `livez`／`readyz` 分法，指標格式取 Prometheus 文字格式 0.0.4（手寫，不加相依）。
 *
 * @module
 */

import { isAbsolute } from 'node:path';

import { z } from 'zod';

import type { NexusPlugin, PluginRegistry } from '@nexus/core';

/** 這一列在訊息裡叫什麼。 */
export const OPS_ENDPOINTS_PLUGIN_NAME = 'ops-endpoints';

/** `strictObject`：多寫一個欄位是打錯字，同其他幾列。 */
export const opsEndpointsConfigSchema = z.strictObject({
  /** 探針。 */
  probes: z
    .strictObject({
      /** `false` 時 `/livez`、`/readyz` 回 404。預設開。 */
      enabled: z.boolean().default(true),
      /**
       * 收尾開始後、關掉 listener 之前，讓 `/readyz` 回 `503 closing` 的時間窗（毫秒）。**只有收尾前 `/readyz` 被抓過才等**：
       * 沒有監控在看，等了也沒人聽。`0` 關掉時間窗（收尾一開始就關 listener，監控看到的是連不上）。
       * 上限 2000：行程收尾整體有 5 秒（#599），時間窗之外 thread 的收尾還要時間。
       */
      drainMs: z.number().int().min(0).max(2000).default(500),
    })
    .default({ enabled: true, drainMs: 500 }),
  /** 指標。 */
  metrics: z
    .strictObject({
      /** `true` 才有 `/metrics`；關著（預設）回 404。 */
      enabled: z.boolean().default(false),
      /** token 檔的絕對路徑（相對路徑在設定驗證時就拒絕，不跟著 serve 的工作目錄走）；缺席是 `<home>/metrics-token`。只在 `enabled` 時讀。 */
      tokenFile: z
        .string()
        .min(1)
        .refine((path) => isAbsolute(path), { message: 'tokenFile 要是絕對路徑' })
        .optional(),
    })
    .default({ enabled: false }),
});

/** 驗過的設定。 */
export type OpsEndpointsConfig = z.infer<typeof opsEndpointsConfigSchema>;

/** 只講設定的那一顆，見檔頭。 */
export const opsEndpointsPlugin: NexusPlugin<OpsEndpointsConfig> = {
  name: OPS_ENDPOINTS_PLUGIN_NAME,
  Config: opsEndpointsConfigSchema,
  apply: (_registry: PluginRegistry, _config: OpsEndpointsConfig): void => {
    // 空的：組裝期沒有消費者。
  },
};

export default opsEndpointsPlugin;
