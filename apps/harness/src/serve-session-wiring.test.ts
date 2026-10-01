/**
 * **serve 的每條 thread 真的接上了不變量與遙測**——[#668](https://github.com/DemianLi/nexus-agent/issues/668)
 * 的突變驗收。
 *
 * 以前 `ThreadAgent` 上的接線口全是選配，`serve.ts` 少轉交 `attachInvariants` 或 `attachTelemetry`
 * 既不報型別錯誤、`wire-handler.ts` 用 `?.()` 也不報執行期錯誤，而且沒有任何測試會紅：這個檔以前不存在，
 * web 路徑上的測試全是手搭 `ThreadAgent`。現在口只有一個而且必填（`AttachSessions`），這個檔補上**行為**那一半：
 * 走 `runServe`，插一顆探針，跑一輪，看探針的回音真的出來。
 *
 * 突變（量過）：拿掉 `session-attach.ts` 的 `attachInvariants(sessions)` 或 `attachTelemetry(sessions)` 其中一行，
 * 對應那一條紅。
 *
 * **零憑證、零外部連線**：模型是出貨的假腳本。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { foldTurn, serveClient } from './fixtures.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';
import { probeSink, resetProbeSink, WIRING_PROBE_PACKAGE } from './serve-session-wiring.fixture.js';

const PATCH = new URL('./serve-session-wiring.patch.yml', import.meta.url).pathname;

let running: RunningServe | undefined;

beforeEach(() => {
  resetProbeSink();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await running?.close();
  running = undefined;
});

async function oneTurn(threadId: string) {
  running = await runServe({
    argv: ['--port', '0', '--patch', PATCH],
    log: () => undefined,
    env: {},
  });
  const client = await serveClient(running as RunningServe);
  const events = await client.openEvents(threadId);
  await client.runStart(threadId, '嗨');
  await foldTurn(events);
}

describe('serve 的 thread 接上了會話消費者', () => {
  it('不變量：探針看到 turn/start 就報，違規走 runner 預設的 console.error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await oneTurn('wiring-invariant');
    expect(spy.mock.calls.map((call) => String(call[0]))).toContain(
      `invariant violated by "${WIRING_PROBE_PACKAGE}": 看到 turn/start`,
    );
  });

  it('遙測：這條 thread 的記錄進了後端，號是 threadId', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await oneTurn('wiring-telemetry');
    const ledger = probeSink.records.filter((record) => record.channel === 'ledger');
    // 前提：真的有記錄，下面的「全是這條 thread」才有東西可量。
    expect(ledger.length).toBeGreaterThan(0);
    expect(new Set(ledger.map((record) => record.attributes['session.id']))).toEqual(
      new Set(['wiring-telemetry']),
    );
    expect(ledger.map((record) => record.attributes['event.type'])).toContain('turn/start');
  });
});
