/**
 * **受管憑證檔的優先序，走真的入口**（[#1540](https://github.com/DemianLi/nexus-agent/issues/1540)，照 dsh 分兩邊）。
 *
 * `credentials.test.ts` 與 `live-model-credentials.test.ts` 都是自己建 `createCredentialService`、自己傳 `store`，
 * 所以把入口那一處傳 `store` 的值換掉，它們不會紅——產品只是**靜靜換了一邊的優先序**。這一檔從 `runServe --live` 與 `runCli --live`
 * 起量，對手方是 loopback 上的假端點，記每個請求帶的 `Authorization`：
 *
 * | 入口 | 對應 dsh | 受管檔（`fake-from-file`）與啟動環境（`fake-from-env`）同時有 | 拿掉哪一處會紅 |
 * | --- | --- | --- | --- |
 * | `runServe --live` | Web profile | 端點收到 `Bearer fake-from-file`；起動訊息講來自受管檔 | `serve.ts` 的 `store: true`、`credentials.ts` 的 `resolve` 順序 |
 * | `runCli --live` | headless profile | 端點收到 `Bearer fake-from-env`；受管檔 0644 也照樣起得來（不讀它），serve 則起不來 | `cli.ts` 的 `store: false` |
 *
 * **零憑證、零外部連線**：key 是假值，端點在 loopback。
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runCli } from './cli.js';
import { CREDENTIALS_FILE } from './credentials.js';
import { foldTurn, serveClient } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { LIVE_API_KEY_ENV } from './live-model.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';

/** 兩把假 key：前 6 個字元各自獨特，拿來斷言「來源那一行不帶值的任何片段」。 */
const FROM_FILE = 'zq9file-managed-0123456789';
const FROM_ENV = 'zq9envr-process-0123456789';

const temporary: string[] = [];
let upstream: { baseUrl: string; auth: string[]; close(): Promise<void> } | undefined;
let running: RunningServe | undefined;

async function endpoint() {
  const auth: string[] = [];
  const server: Server = createServer((request, response) => {
    auth.push(String(request.headers.authorization));
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { stream?: boolean };
      const id = `chatcmpl-${String(auth.length)}`;
      if (body.stream !== true) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            id,
            object: 'chat.completion',
            created: 0,
            model: 'fake',
            choices: [
              { index: 0, message: { role: 'assistant', content: '好' }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
        return;
      }
      const piece = (delta: Record<string, unknown>, reason: string | null): string =>
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created: 0,
          model: 'fake',
          choices: [{ index: 0, delta, finish_reason: reason }],
        })}\n\n`;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(piece({ role: 'assistant', content: '好' }, null));
      response.write(piece({}, 'stop'));
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    auth,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(dir, 0o700);
  temporary.push(dir);
  return dir;
}

/** 一個 home、一個專案資料夾、一份指到假端點的 patch（標題模型關掉，免得多一個帶同一把 key 的請求）。 */
function layout() {
  const base = scratch('nexus-credentials-precedence-');
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
      '- id: thread-title-llm',
      '  disabled: true',
      '',
    ].join('\n'),
  );
  return { home, cwd, patch, env: { [HARNESS_HOME_ENV]: home } };
}

function managedFile(home: string, key: string, mode = 0o600): string {
  const file = join(home, CREDENTIALS_FILE);
  writeFileSync(file, `version: 1\nrefs:\n  ${LIVE_API_KEY_ENV}: ${key}\n`, { mode });
  chmodSync(file, mode);
  return file;
}

async function serve(where: ReturnType<typeof layout>, lines: string[]): Promise<RunningServe> {
  return (await runServe({
    argv: ['--port', '0', '--live', '--patch', where.patch],
    log: (line) => void lines.push(line),
    env: where.env,
    cwd: where.cwd,
  })) as RunningServe;
}

async function cli(where: ReturnType<typeof layout>, errors: string[]): Promise<void> {
  await runCli({
    argv: ['--live', '--patch', where.patch, '說點什麼'],
    input: new PassThrough(),
    output: new PassThrough(),
    printer: { log: () => undefined, error: (line) => void errors.push(line) },
    env: where.env,
    cwd: where.cwd,
  });
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

describe('serve（Web profile）：受管檔最優先', () => {
  it('受管檔與啟動環境同時有：端點收到受管檔那把；起動訊息講來自受管檔，不帶值的片段', async () => {
    const where = layout();
    const file = managedFile(where.home, FROM_FILE);
    vi.stubEnv(LIVE_API_KEY_ENV, FROM_ENV);
    const lines: string[] = [];
    running = await serve(where, lines);

    const client = await serveClient(running);
    const events = await client.openEvents('t1');
    await client.runStart('t1', '嗨');
    await foldTurn(events);
    await events.return?.(undefined);

    expect(upstream!.auth.length).toBeGreaterThan(0);
    expect(new Set(upstream!.auth)).toEqual(new Set([`Bearer ${FROM_FILE}`]));
    expect(lines).toContain(`${LIVE_API_KEY_ENV}：來自受管檔 ${file}`);
    for (const line of lines) {
      expect(line).not.toContain(FROM_FILE.slice(0, 6));
      expect(line).not.toContain(FROM_ENV.slice(0, 6));
    }
  }, 60000);

  it('受管檔裡沒有這一把：才輪到啟動環境，起動訊息講「啟動環境」', async () => {
    const where = layout();
    writeFileSync(join(where.home, CREDENTIALS_FILE), 'version: 1\nrefs:\n  OTHER_KEY: x\n', {
      mode: 0o600,
    });
    chmodSync(join(where.home, CREDENTIALS_FILE), 0o600);
    vi.stubEnv(LIVE_API_KEY_ENV, FROM_ENV);
    const lines: string[] = [];
    running = await serve(where, lines);

    expect(lines).toContain(`${LIVE_API_KEY_ENV}：來自啟動環境`);
  }, 60000);

  it('受管檔 0644：serve 起不來，講 chmod 600', async () => {
    const where = layout();
    const file = managedFile(where.home, FROM_FILE, 0o644);
    vi.stubEnv(LIVE_API_KEY_ENV, FROM_ENV);
    await expect(serve(where, [])).rejects.toThrow(`chmod 600 ${file}`);
  }, 60000);
});

describe('一次性入口（headless profile）：不掛受管檔', () => {
  it('受管檔與啟動環境同時有：端點收到啟動環境那把；stderr 那一行講「啟動環境」並寫明此入口不讀受管檔', async () => {
    const where = layout();
    managedFile(where.home, FROM_FILE);
    vi.stubEnv(LIVE_API_KEY_ENV, FROM_ENV);
    const errors: string[] = [];
    await cli(where, errors);

    expect(upstream!.auth.length).toBeGreaterThan(0);
    expect(new Set(upstream!.auth)).toEqual(new Set([`Bearer ${FROM_ENV}`]));
    expect(errors).toContain(`${LIVE_API_KEY_ENV}：來自啟動環境（此入口不讀受管檔）`);
    for (const line of errors) {
      expect(line).not.toContain(FROM_FILE.slice(0, 6));
      expect(line).not.toContain(FROM_ENV.slice(0, 6));
    }
  }, 60000);

  it('受管檔 0644：CLI 照樣起得來、不讀它（serve 在同一個 home 上起不來）', async () => {
    const where = layout();
    const file = managedFile(where.home, FROM_FILE, 0o644);
    vi.stubEnv(LIVE_API_KEY_ENV, FROM_ENV);
    await cli(where, []);
    expect(new Set(upstream!.auth)).toEqual(new Set([`Bearer ${FROM_ENV}`]));

    await expect(serve(where, [])).rejects.toThrow(`chmod 600 ${file}`);
  }, 60000);

  it('只有受管檔有 key：serve 用它；CLI 失敗，指名缺哪一個並說「此入口不讀受管檔」', async () => {
    const where = layout();
    managedFile(where.home, FROM_FILE);
    delete process.env[LIVE_API_KEY_ENV];
    const lines: string[] = [];
    running = await serve(where, lines);
    expect(lines.some((line) => line.startsWith(`${LIVE_API_KEY_ENV}：來自受管檔`))).toBe(true);
    await running.close();
    running = undefined;

    const failure = await cli(where, []).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(failure?.message).toContain(LIVE_API_KEY_ENV);
    expect(failure?.message).toContain('此入口不讀受管檔');
  }, 60000);
});
