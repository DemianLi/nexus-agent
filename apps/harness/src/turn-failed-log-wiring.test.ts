/**
 * 一輪失敗在伺服器日誌的那一行，**從 `runServe` 起量**（[#1536](https://github.com/DemianLi/nexus-agent/issues/1536)）。
 *
 * `provider-request-id.test.ts` 量的是請求編號進得了失敗紀錄；這一檔量的是**接線**：真的 serve、真的 wire、假端點回 502＋
 * `x-request-id`，伺服器日誌要剛好多一行 `[回合]`，帶 thread、run、失敗碼、請求編號，而且 `日誌第 N 筆` 回頭去讀會話日誌，
 * 第 N 筆就是 `turn/failed`。拿掉 `serve.ts` 的 `onTurnFailed`，或把 seq 算錯，這一檔紅。
 *
 * **失敗訊息本文不進伺服器日誌**：端點回的訊息帶 `SECRET-PROBE`，它只該出現在會話日誌。
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
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

const temporary: string[] = [];
let upstream: { baseUrl: string; hits: () => number; close(): Promise<void> } | undefined;
let running: RunningServe | undefined;

async function endpoint() {
  let hits = 0;
  const server: Server = createServer((request, response) => {
    hits += 1;
    request.resume();
    response.writeHead(502, { 'content-type': 'application/json', 'x-request-id': 'gw-123' });
    response.end(JSON.stringify({ error: { message: 'Bad gateway SECRET-PROBE', code: 502 } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    hits: () => hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** 一個 home、一個專案資料夾、一份指到假端點的 patch（不重試，標題模型關掉）。`extra` 是附加的 patch 列。 */
function layout(extra: string[] = []) {
  const base = mkdtempSync(join(tmpdir(), 'nexus-turn-failed-log-'));
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
      `    baseUrl: '${upstream!.baseUrl}'`,
      '    retryPolicy:',
      '      mode: normal',
      '      maxRetries: 0',
      '- id: thread-title-llm',
      '  disabled: true',
      ...extra,
      '',
    ].join('\n'),
  );
  return { home, cwd, patch };
}

/** 跑一輪會失敗的對話，回伺服器日誌（原樣）與會話日誌的事件。 */
async function failingTurn(where: ReturnType<typeof layout>) {
  const raw: string[] = [];
  const lines: string[] = [];
  vi.stubEnv(LIVE_API_KEY_ENV, 'fake-key-for-loopback');
  running = (await runServe({
    argv: ['--port', '0', '--live', '--patch', where.patch],
    log: bodyLog(lines, raw),
    env: { [HARNESS_HOME_ENV]: where.home },
    cwd: where.cwd,
  })) as RunningServe;
  const client = await serveClient(running);
  const events = await client.openEvents('t1');
  const started = (await client.runStart('t1', '嗨')) as { result: { run_id: string } };
  await foldTurn(events);
  await events.return?.(undefined);
  // 收線會排空並關檔——落盤的驗收只有在 `close()` 之後才成立。
  await running.close();
  running = undefined;

  const sessions = join(where.home, 'sessions');
  const [projectDir] = await readdir(sessions);
  const text = await readFile(join(sessions, projectDir!, 't1.jsonl'), 'utf8');
  const session = text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SessionEvent);
  return { raw, lines, session, sessionText: text, runId: started.result.run_id };
}

beforeEach(async () => {
  upstream = await endpoint();
});
afterEach(async () => {
  await running?.close();
  running = undefined;
  await upstream?.close();
  upstream = undefined;
  vi.unstubAllEnvs();
  delete process.env[LIVE_API_KEY_ENV];
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('一輪失敗在伺服器日誌的那一行（文字模式）', () => {
  it('剛好一行 [回合]：帶 thread、run、SERVER、請求編號，日誌第 N 筆就是會話日誌的 turn/failed', async () => {
    const { raw, lines, session, runId } = await failingTurn(layout());

    const failedLines = lines.filter((line) => line.startsWith('[回合]'));
    expect(failedLines).toHaveLength(1);
    const line = failedLines[0]!;
    // run id 就是 `run.start` 回給呼叫端的那一個（不是隨便一個非空字串）。
    expect(line).toMatch(
      new RegExp(
        `^\\[回合\\] thread "t1" run "${runId}" 失敗（日誌第 (\\d+) 筆）：SERVER status=502 request_id=gw-123$`,
        'u',
      ),
    );
    const seq = Number(/日誌第 (\d+) 筆/u.exec(line)![1]);
    expect(session[seq]?.type).toBe('turn/failed');
    expect(session[seq]?.seq).toBe(seq);
    // 同一輪只有這一筆 turn/failed：行數與會話日誌對得上。
    expect(session.filter((event) => event.type === 'turn/failed')).toHaveLength(1);
    // 等級是 warn，名字是 serve。
    expect(raw.find((entry) => entry.includes('[回合]'))).toMatch(/\[W\] serve \[回合\]/u);
  }, 60000);

  it('失敗訊息本文只在會話日誌，不進伺服器日誌', async () => {
    const { raw, sessionText } = await failingTurn(layout());

    expect(sessionText).toContain('SECRET-PROBE');
    for (const line of raw) expect(line).not.toContain('SECRET-PROBE');
  }, 60000);
});

describe('JSON 模式', () => {
  it('thread_id／run_id／seq／code／status／provider_request_id 各成一個鍵，本文沒有失敗訊息', async () => {
    const where = layout(['- id: logger-console', '  config:', '    format: json']);
    const { raw, session, sessionText, runId } = await failingTurn(where);

    const entries = raw
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const failed = entries.filter((entry) => String(entry.msg).startsWith('[回合]'));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      level: 'warn',
      logger: 'serve',
      thread_id: 't1',
      run_id: runId,
      code: 'SERVER',
      status: 502,
      provider_request_id: 'gw-123',
    });
    expect(session[failed[0]!.seq as number]?.type).toBe('turn/failed');
    expect(sessionText).toContain('SECRET-PROBE');
    for (const line of raw) expect(line).not.toContain('SECRET-PROBE');
  }, 60000);
});
