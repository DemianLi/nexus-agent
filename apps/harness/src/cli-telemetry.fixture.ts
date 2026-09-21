/**
 * 手動驗證用的 OTel 遙測後端 plugin。
 *
 * ```
 * # 只看披露改口（不需要任何端點）：
 * pnpm --filter @nexus/harness run cli --patch src/cli-telemetry.patch.yml "回聲一下"
 *
 * # 真的送出去：起一個收 POST 的東西在 4318，然後
 * NEXUS_OTLP_LOGS_URL=http://127.0.0.1:4318/v1/logs \
 *   pnpm --filter @nexus/harness run cli --patch src/cli-telemetry.patch.yml "回聲一下"
 * ```
 *
 * 它要證明的是單元測試證明不了的那一件事：**披露那一行真的會改口。** 沒掛後端時印的是
 * 「遙測：未配置」，掛上之後印的是那個後端說的策略——而「掛了但關著」跟「根本沒掛」
 * 是兩回事，畫面上要分得出來。
 *
 * **端點從環境變數來，沒有預設值。** 這是 [`docs/standards.md`](../../../docs/standards.md)
 * 的規矩：秘密與外部端點不進程式碼、不留 fallback。沒設就是 `disabled` 模式，一個
 * SDK 狀態都不建。
 *
 * 它是一顆 plugin，不是一份清單（[#455](https://github.com/DemianLi/nexus-agent/issues/455)）：
 * 旁邊那份 patch 檔把它 `insert` 到出貨清單上。echo 本來就在出貨清單裡，所以這裡不再自己
 * 列一份。
 */

import type { NexusPlugin } from '@nexus/core';
import { telemetryOtelConfigSchema, telemetryOtelPlugin } from '@nexus/plugin-telemetry-otel';

/**
 * 原封不動地委派給真的遙測 plugin，只是設定在這裡算。
 *
 * **`Config` 刻意不轉出去**：端點是執行期從環境變數讀的，patch 檔只寫得下字面值，而把端點
 * 寫進版控正是 [`docs/standards.md`](../../../docs/standards.md) 禁止的那件事。設定在這裡
 * `parse` 一次，走的是跟 `resolveEntries` 同一份 schema，所以預設值不會因為繞過組裝而不一樣。
 * 代價是這一顆的設定不會出現在 `--dump-config` 的樹上——手動 fixture 收得下這個代價。
 */
const telemetryFixture: NexusPlugin = {
  name: 'telemetry-otel-fixture',
  apply: async (registry) => {
    const url = process.env['NEXUS_OTLP_LOGS_URL'];
    await telemetryOtelPlugin.apply(
      registry,
      telemetryOtelConfigSchema.parse(
        url === undefined
          ? { mode: 'disabled' }
          : {
              mode: 'full',
              exporter: { url },
              serviceName: 'nexus-agent',
              // 手動驗證要看得到東西，所以批次節奏調快——正式部署不該抄這個值。
              processor: { scheduledDelayMillis: 500 },
            },
      ),
    );
  },
};

export default telemetryFixture;
