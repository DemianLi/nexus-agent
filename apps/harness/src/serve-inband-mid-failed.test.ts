/**
 * 串流**中段**才送錯誤信封，一輪最後的 `turn/failed` 與 `llm/retry` 要分成同一類（[#1763](https://github.com/DemianLi/nexus-agent/issues/1763)）。
 *
 * 從 `runServe` 起量：真的 serve、真的 wire、假端點先回 200 送一則內容、再送 `data: {"error":{…,"code":503}}`。
 * `provider-request-id.test.ts` 直接呼叫 `model.stream`，錯誤不經過圖裡的 `wrapModelCall`，量不到真路徑。
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from '@nexus/core';

import { bodyLog, foldTurn, serveClient } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { LIVE_API_KEY_ENV } from './live-model.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';
import { sessionEventsOf } from './session-files.fixture.js';

const temporary: string[] = [];
let server: Server | undefined;
let baseUrl = '';
let running: RunningServe | undefined;
/** 串流中段送出去的信封；每條測試自己設。 */
let envelope: Record<string, unknown> = { message: 'mid in-band failure', type: 'x', code: 503 };
let hits = 0;

beforeEach(async () => {
  envelope = { message: 'mid in-band failure', type: 'x', code: 503 };
  hits = 0;
  server = createServer((request, response) => {
    hits += 1;
    request.resume();
    response.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'gw-mid' });
    response.write(
      `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] })}\n\n`,
    );
    response.write(`data: ${JSON.stringify({ error: envelope })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1`;
});

afterEach(async () => {
  await running?.close();
  running = undefined;
  await new Promise<void>((resolve) => {
    server!.closeAllConnections();
    server!.close(() => resolve());
  });
  vi.unstubAllEnvs();
  delete process.env[LIVE_API_KEY_ENV];
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function failingTurn(): Promise<SessionEvent[]> {
  const base = mkdtempSync(join(tmpdir(), 'nexus-inband-mid-'));
  chmodSync(base, 0o700);
  temporary.push(base);
  const home = join(base, 'home');
  const cwd = join(base, 'project');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(cwd);
  const patch = join(base, 'patch.yml');
  writeFileSync(
    patch,
    [
      '- id: live-model',
      '  config:',
      `    baseUrl: '${baseUrl}'`,
      '    retryPolicy:',
      '      mode: normal',
      '      maxRetries: 2',
      '      backoff: { initialDelayMs: 20, maxDelayMs: 200, jitterRatio: 0 }',
      '- id: thread-title-llm',
      '  disabled: true',
      '',
    ].join('\n'),
  );
  vi.stubEnv(LIVE_API_KEY_ENV, 'fake-key-for-loopback');
  running = (await runServe({
    argv: ['--port', '0', '--live', '--patch', patch],
    log: bodyLog([], []),
    env: { [HARNESS_HOME_ENV]: home },
    cwd,
  })) as RunningServe;
  const client = await serveClient(running);
  const events = await client.openEvents('t1');
  await client.runStart('t1', '嗨');
  await foldTurn(events);
  await events.return?.(undefined);
  await running.close();
  running = undefined;

  const sessions = join(home, 'sessions');
  const [projectDir] = await readdir(sessions);
  return sessionEventsOf(join(sessions, projectDir!), 't1');
}

describe('串流中段的 in-band 錯誤（#1763）', () => {
  it('turn/failed 的碼與狀態等於 llm/retry 最後一筆：SERVER、503', async () => {
    const session = await failingTurn();
    const retries = session.filter((event) => event.type === 'llm/retry');
    const failed = session.filter((event) => event.type === 'turn/failed');
    expect(retries.length).toBeGreaterThan(0);
    expect(failed).toHaveLength(1);
    const last = (retries.at(-1)!.data as unknown as { failure: Record<string, unknown> }).failure;
    const error = (failed[0]!.data as unknown as { error: Record<string, unknown> }).error;
    expect(last).toMatchObject({ code: 'SERVER', status: 503 });
    expect(error).toMatchObject({ code: last.code, status: last.status });
  }, 60000);

  // #1805：只有 `type`、沒有數字碼、訊息也不含額度／超窗字樣的信封，照 dsh 的 `providerError` 記 `AUTH`（不是 `SERVER`）。
  // 突變：拿掉 `classifyInbandError` 讀 `type` 的那一階，這條就紅（`SERVER`、被重打 3 次）。
  it('只有 type: authentication_error 的信封 → turn/failed 是 AUTH，不重打（#1805）', async () => {
    envelope = { message: '金鑰不對', type: 'authentication_error' };
    const session = await failingTurn();
    const retries = session.filter((event) => event.type === 'llm/retry');
    const failed = session.filter((event) => event.type === 'turn/failed');
    expect(failed).toHaveLength(1);
    const error = (failed[0]!.data as unknown as { error: Record<string, unknown> }).error;
    expect(error).toMatchObject({ code: 'AUTH' });
    expect(hits).toBe(1);
    expect(retries).toHaveLength(0);
  }, 60000);
});
