/**
 * 手動驗證用的 plugin 清單：預設那組 ＋ 一個 OTel 遙測後端。
 *
 * ```
 * # 只看披露改口（不需要任何端點）：
 * pnpm --filter @nexus/harness run cli --plugins src/cli-telemetry.fixture.ts "回聲一下"
 *
 * # 真的送出去：起一個收 POST 的東西在 4318，然後
 * NEXUS_OTLP_LOGS_URL=http://127.0.0.1:4318/v1/logs \
 *   pnpm --filter @nexus/harness run cli --plugins src/cli-telemetry.fixture.ts "回聲一下"
 * ```
 *
 * 它要證明的是單元測試證明不了的那一件事：**披露那一行真的會改口。** 沒掛後端時印的是
 * 「遙測：未配置」，掛上之後印的是那個後端說的策略——而「掛了但關著」跟「根本沒掛」
 * 是兩回事，畫面上要分得出來。
 *
 * **端點從環境變數來，沒有預設值。** 這是 [`docs/standards.md`](../../../docs/standards.md)
 * 的規矩：秘密與外部端點不進程式碼、不留 fallback。沒設就是 `disabled` 模式，一個
 * SDK 狀態都不建。
 */

import type { NexusPlugin } from '@nexus/core';
import { createEchoPlugin } from '@nexus/plugin-echo';
import { createTelemetryOtelPlugin } from '@nexus/plugin-telemetry-otel';

const url = process.env['NEXUS_OTLP_LOGS_URL'];

export default [
  createEchoPlugin(),
  createTelemetryOtelPlugin(
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
] satisfies NexusPlugin[];
