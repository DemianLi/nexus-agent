/**
 * 探針與指標，**從 `runServe` 起量**（[#1535](https://github.com/DemianLi/nexus-agent/issues/1535) 驗收 1、2、5、6、8）。
 *
 * `ops-endpoints.test.ts` 量端點自己；這一檔量**接線**：設定列 → `startupSetting` → token 檔 → 路由的第三個面 → 請求計數 →
 * `onTurnFailed` → 啟動披露。拿掉 `serve.ts` 的任何一條線，這一檔紅。
 *
 * **零憑證、零外部連線**：模型是腳本，或指到 loopback 上的假端點（回 429）。
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bodyLog, exchangeServeToken, foldTurn, serveClient } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { LIVE_API_KEY_ENV } from './live-model.js';
import { METRICS_TOKEN_FILE } from './metrics-token.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';

const serveEntry = fileURLToPath(new URL('./serve.ts', import.meta.url));
const harnessDir = fileURLToPath(new URL('../', import.meta.url));

const temporary: string[] = [];
let running: RunningServe | undefined;
let child: ChildProcess | undefined;
let upstream: { baseUrl: string; close(): Promise<void> } | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
  if (child !== undefined && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
  child = undefined;
  await upstream?.close();
  upstream = undefined;
  vi.unstubAllEnvs();
  delete process.env[LIVE_API_KEY_ENV];
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 一個 home 與一份 patch；`rows` 是附加的 patch 列。 */
function layout(rows: string[] = []) {
  const base = mkdtempSync(join(tmpdir(), 'nexus-ops-'));
  chmodSync(base, 0o700);
  temporary.push(base);
  const home = join(base, 'home');
  const cwd = join(base, 'project');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(cwd);
  const patch = join(base, 'patch.yml');
  writeFileSync(patch, rows.length === 0 ? '[]\n' : `${rows.join('\n')}\n`);
  return { home, cwd, patch, base };
}

const METRICS_ON = ['- id: ops-endpoints', '  config:', '    metrics:', '      enabled: true'];

async function start(
  where: ReturnType<typeof layout>,
  lines: string[] = [],
  extraArgs: string[] = [],
): Promise<RunningServe> {
  running = (await runServe({
    argv: ['--port', '0', '--patch', where.patch, ...extraArgs],
    log: bodyLog(lines),
    env: { [HARNESS_HOME_ENV]: where.home },
    cwd: where.cwd,
  })) as RunningServe;
  return running;
}

/** 真的 HTTP 請求，Host 可自訂（`fetch` 不給改）。 */
function rawGet(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = httpRequest(
      { host: target.hostname, port: target.port, path: target.pathname, headers },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (body += chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function tokenOf(where: ReturnType<typeof layout>): Promise<string> {
  return (await readFile(join(where.home, METRICS_TOKEN_FILE), 'utf8')).trim();
}

/** 抓一次指標，回 `name{labels}` → 值。 */
async function scrape(server: RunningServe, token: string): Promise<Map<string, number>> {
  const response = await fetch(`${server.url}/metrics`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  const values = new Map<string, number>();
  for (const line of (await response.text()).split('\n')) {
    const match = /^(\S+) (\S+)$/u.exec(line);
    if (match && !line.startsWith('#')) values.set(match[1]!, Number(match[2]));
  }
  return values;
}

describe('出廠（指標預設關）', () => {
  it('探針免登入回 200 ok；/metrics 是 404；home 底下沒有 token 檔；啟動披露講清楚', async () => {
    const where = layout();
    const lines: string[] = [];
    const server = await start(where, lines);

    expect(await (await fetch(`${server.url}/livez`)).text()).toBe('ok');
    const readyz = await fetch(`${server.url}/readyz`);
    expect(readyz.status).toBe(200);
    expect(await readyz.text()).toBe('ok');
    expect((await fetch(`${server.url}/metrics`)).status).toBe(404);
    // 帶什麼都一樣：指標沒打開。
    expect(
      (await fetch(`${server.url}/metrics`, { headers: { authorization: 'Bearer x' } })).status,
    ).toBe(404);
    await expect(stat(join(where.home, METRICS_TOKEN_FILE))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(lines).toContain('探針：/livez、/readyz（免登入、只回狀態字）；指標：關');
  });

  it('三個路徑在真的 socket 上帶 Host: evil.example → 403（驗收 1）', async () => {
    const where = layout(METRICS_ON);
    const server = await start(where);
    const token = await tokenOf(where);
    for (const path of ['/livez', '/readyz', '/metrics']) {
      const response = await rawGet(`${server.url}${path}`, {
        host: 'evil.example:80',
        authorization: `Bearer ${token}`,
      });
      expect(response.status).toBe(403);
      expect(response.body).toBe('forbidden');
    }
  });
});

describe('指標打開（驗收 5、6）', () => {
  it('token 檔在 home 底下 0600；披露印路徑、不印 token；bearer 200、cookie 401', async () => {
    const where = layout(METRICS_ON);
    const lines: string[] = [];
    const server = await start(where, lines);
    const token = await tokenOf(where);

    expect((await stat(join(where.home, METRICS_TOKEN_FILE))).mode & 0o777).toBe(0o600);
    const disclosure = lines.find((line) => line.startsWith('探針：'));
    expect(disclosure).toContain(join(where.home, METRICS_TOKEN_FILE));
    expect(disclosure).toContain('指標：開');
    expect(lines.join('\n')).not.toContain(token);

    expect((await fetch(`${server.url}/metrics`)).status).toBe(401);
    // 會話 cookie 換不到指標。
    const cookie = await exchangeServeToken(server.authenticatedUrl);
    expect((await fetch(`${server.url}/metrics`, { headers: { cookie } })).status).toBe(401);
    const ok = await fetch(`${server.url}/metrics`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
    // 反過來：指標的 token 換不到 wire。
    const wire = await fetch(`${server.url}/threads/t1/history`, {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    });
    expect(wire.status).toBe(401);
  });

  it('tokenFile 可以指到別的地方', async () => {
    const where = layout();
    const file = join(where.base, 'elsewhere', 'tok');
    writeFileSync(where.patch, [...METRICS_ON, `      tokenFile: '${file}'`, ''].join('\n'));
    await start(where);
    const token = (await readFile(file, 'utf8')).trim();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    await expect(stat(join(where.home, METRICS_TOKEN_FILE))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('token 檔權限是 0644 → 啟動失敗，訊息指名檔案，檔案不動', async () => {
    const where = layout(METRICS_ON);
    const file = join(where.home, METRICS_TOKEN_FILE);
    const token = 'z'.repeat(43);
    writeFileSync(file, `${token}\n`);
    chmodSync(file, 0o644);
    const failure = await runServe({
      argv: ['--port', '0', '--patch', where.patch],
      log: () => undefined,
      env: { [HARNESS_HOME_ENV]: where.home },
      cwd: where.cwd,
    }).then(
      (server) => {
        running = server as RunningServe;
        return undefined;
      },
      (error: unknown) => error as Error,
    );
    expect(failure?.message).toContain(file);
    expect(await readFile(file, 'utf8')).toBe(`${token}\n`);
  });

  it('請求計數是真的：兩次 401 讓 wire 4xx 加 2；抓取本身算在 ops', async () => {
    const where = layout(METRICS_ON);
    const server = await start(where);
    const token = await tokenOf(where);
    const before = await scrape(server, token);
    const key = 'nexus_http_requests_total{surface="wire",code_class="4xx"}';
    for (let i = 0; i < 2; i += 1) {
      const response = await fetch(`${server.url}/threads/x/history`, {
        headers: { 'content-type': 'application/json' },
      });
      expect(response.status).toBe(401);
    }
    const after = await scrape(server, token);
    expect((after.get(key) ?? 0) - (before.get(key) ?? 0)).toBe(2);
    // 第一次抓取（200）在第二次抓取時已經算進 ops。
    expect(
      after.get('nexus_http_requests_total{surface="ops",code_class="2xx"}') ?? 0,
    ).toBeGreaterThanOrEqual(1);
    // 網頁那一面的 404 也算（不存在的檔）。
    await fetch(`${server.url}/no-such-file.js`);
    const web = await scrape(server, token);
    expect(
      web.get('nexus_http_requests_total{surface="web",code_class="4xx"}') ?? 0,
    ).toBeGreaterThanOrEqual(1);
  });

  it('thread 數與上限（出廠 500）跟著開 thread 變', async () => {
    const where = layout(METRICS_ON);
    const server = await start(where);
    const token = await tokenOf(where);
    expect((await scrape(server, token)).get('nexus_threads')).toBe(0);
    const client = await serveClient(server);
    const events = await client.openEvents('t1');
    await client.runStart('t1', '嗨');
    await foldTurn(events);
    await events.return?.(undefined);
    const after = await scrape(server, token);
    expect(after.get('nexus_threads')).toBe(1);
    expect(after.get('nexus_threads_max')).toBe(500);
    expect(after.get('nexus_threads_closing')).toBe(0);
  });
});

describe('回合失敗計數（驗收 6）', () => {
  beforeEach(async () => {
    let hits = 0;
    const server: Server = createServer((request, response) => {
      hits += 1;
      request.resume();
      response.writeHead(429, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'slow down', code: 429 } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    upstream = {
      baseUrl: `http://127.0.0.1:${String(port)}/v1`,
      close: () =>
        new Promise<void>((resolve) => {
          void hits;
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    };
  });

  it('一輪以供應商 429 收場 → nexus_turn_failures_total{code="RATE_LIMIT"} 加 1', async () => {
    const where = layout([
      ...METRICS_ON,
      '- id: live-model',
      '  config:',
      `    baseUrl: '${upstream!.baseUrl}'`,
      '    retryPolicy:',
      '      mode: normal',
      '      maxRetries: 0',
      '- id: thread-title-llm',
      '  disabled: true',
    ]);
    vi.stubEnv(LIVE_API_KEY_ENV, 'fake-key-for-loopback');
    const server = await start(where, [], ['--live']);
    const token = await tokenOf(where);
    const key = 'nexus_turn_failures_total{code="RATE_LIMIT"}';
    expect((await scrape(server, token)).get(key)).toBeUndefined();

    const client = await serveClient(server);
    const events = await client.openEvents('t1');
    await client.runStart('t1', '嗨');
    await foldTurn(events);
    await events.return?.(undefined);

    expect((await scrape(server, token)).get(key)).toBe(1);
  });
});

describe('驗收 8：子行程起真的 serve，接線拿掉就紅', () => {
  it('--patch 打開指標，讀 token 檔、帶 bearer 抓 /metrics 拿到 200；不帶是 401；/livez 免登入', async () => {
    const where = layout(METRICS_ON);
    const spawned = spawn(
      process.execPath,
      ['--import', 'tsx', serveEntry, '--port', '0', '--patch', where.patch],
      {
        cwd: harnessDir,
        env: { ...process.env, [HARNESS_HOME_ENV]: where.home },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child = spawned;
    let stdout = '';
    const authenticatedUrl = await new Promise<string>((resolve, reject) => {
      spawned.stdout.setEncoding('utf8');
      spawned.stdout.on('data', (chunk: string) => {
        stdout += chunk;
        const match = /nexus-agent 在 (\S+)/u.exec(stdout);
        if (match !== null) resolve(match[1]!);
      });
      spawned.once('exit', () => reject(new Error(`serve 沒有起來就結束了：${stdout}`)));
    });
    const origin = new URL(authenticatedUrl).origin;
    const token = await tokenOf(where);

    expect((await fetch(`${origin}/livez`)).status).toBe(200);
    expect((await fetch(`${origin}/metrics`)).status).toBe(401);
    const response = await fetch(`${origin}/metrics`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('# TYPE nexus_threads gauge');
  }, 60000);
});
