/**
 * serve 的**探針與指標端點的設定條目**（[#1535](https://github.com/DemianLi/nexus-agent/issues/1535)）。端點本體見 `../ops-endpoints.ts`。
 *
 * **這一顆不裝功能，只講設定**，`apply` 是空的，同 `thread-capacity`、`memory-gauge`：值由 `startupSetting` 在起動期讀出來，
 * 交給 `serve.ts` 組路由。**改了要重啟 serve**（分類 `startup-read`，`plugin-row-classes.ts`）。
 *
 * - **探針**（`/livez`、`/readyz`）預設開、免登入，本文只有狀態字（Q1 (a)）。
 * - **指標**（`/metrics`）預設關；打開後要 `Authorization: Bearer <token>`，token 在 `tokenFile`（預設 `<home>/metrics-token`，`0600`，沒有就建）。
 *
 * 關掉這一列（`disabled: true`）等於沒有這一列、值回到預設：探針開、指標關。要連探針也關，把 `probes.enabled` 設成 `false`。
 *
 * ## 偏離 dsh：產品需求超出 dsh
 *
 * dsh 沒有探針端點，也沒有指標出口（`1517a4db`：唯一相關的是 OTel 的 `selfObsMeterProvider` 被刻意排除），所以這一列沒有對照。判準取公開的慣例：
 * 探針語意取 Kubernetes 的 `livez`／`readyz` 分法，指標格式取 Prometheus 文字格式 0.0.4（手寫，不加相依）。
 *
 * @module
 */

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
    })
    .default({ enabled: true }),
  /** 指標。 */
  metrics: z
    .strictObject({
      /** `true` 才有 `/metrics`；關著（預設）回 404。 */
      enabled: z.boolean().default(false),
      /** token 檔的絕對路徑；缺席是 `<home>/metrics-token`。只在 `enabled` 時讀。 */
      tokenFile: z.string().min(1).optional(),
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
