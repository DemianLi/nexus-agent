/**
 * `serve-session-wiring.test.ts` 的探針：一顆 plugin 同時當**不變量的回音**與**遙測的收件匣**
 * （[#668](https://github.com/DemianLi/nexus-agent/issues/668)）。
 *
 * 它是一個 patch 條目載進來的（`serve-session-wiring.patch.yml`），所以走的是 `runServe` 真正的組裝，
 * 而不是手搭的 `ThreadAgent`——手搭的測試沒走 `serve.ts` 的閉包，少轉交任何一個接線口都量不到。
 *
 * - 不變量：看到 `turn/start` 就報一筆違規。serve 不傳 `onInvariantViolation`，違規走 runner 預設的
 *   `console.error`，測試攔那一行。
 * - 遙測：把後端提供成服務，記錄收進模組層的 {@link probeSink}。測試與載入器讀的是同一個模組實例。
 */

import type { NexusPlugin, SessionTelemetryRecord, SessionTelemetryService } from '@nexus/core';
import { SESSION_TELEMETRY_SERVICE } from '@nexus/core';

/** 這份探針認領的假 package 名。 */
export const WIRING_PROBE_PACKAGE = '@nexus/wiring-probe';

/** 遙測收到的東西。每個測試開頭 {@link resetProbeSink}。 */
export const probeSink: SessionTelemetryService & {
  records: SessionTelemetryRecord[];
  shutdowns: number;
} = {
  records: [],
  shutdowns: 0,
  sharing: 'full',
  emit(record) {
    probeSink.records.push(record);
  },
  shutdown() {
    probeSink.shutdowns += 1;
    return Promise.resolve();
  },
};

export function resetProbeSink(): void {
  probeSink.records.length = 0;
  probeSink.shutdowns = 0;
}

const probe: NexusPlugin = {
  name: 'wiring-probe',
  apply(registry) {
    registry.services.provide(SESSION_TELEMETRY_SERVICE, probeSink);
    registry.invariants.register(WIRING_PROBE_PACKAGE, (subject, fail) => {
      subject.observe((event) => {
        if (event.type === 'turn/start') fail(`看到 ${event.type}`);
      });
    });
  },
};

export default probe;
