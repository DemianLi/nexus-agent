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
import { installServeProcessLifecycle, runServe } from './serve.js';
import type { RunningServe, ServeProcess } from './serve.js';

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

describe('收尾時間窗：close() 開始後 listener 還在聽，/readyz 回 503（#1777）', () => {
  const DRAIN = (drainMs: number) => [
    '- id: ops-endpoints',
    '  config:',
    '    probes:',
    `      drainMs: ${String(drainMs)}`,
  ];

  it('抓過 /readyz → close() 一開始立刻看得到 503 closing；時間窗過了 listener 才關', async () => {
    const where = layout(DRAIN(400));
    const server = await start(where);
    expect((await fetch(`${server.url}/readyz`)).status).toBe(200);

    const startedAt = Date.now();
    const closing = server.close();
    // 真的新連線（不是 keep-alive 的舊連線），在時間窗裡打。
    const during = await fetch(`${server.url}/readyz`, { headers: { connection: 'close' } });
    expect(during.status).toBe(503);
    expect(await during.text()).toBe('closing');
    // /livez 不受影響：活著就是活著。
    expect((await fetch(`${server.url}/livez`, { headers: { connection: 'close' } })).status).toBe(
      200,
    );

    await closing;
    // 下限：時間窗真的等過了（拿掉等待，這裡紅）。
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(380);
    // 時間窗過了，listener 關了。
    await expect(fetch(`${server.url}/readyz`)).rejects.toThrow();
    running = undefined;
  });

  it('窗內 run.start 回 server_closing（#1787）：close() 一開始就停准入，窗前與沒收尾時照常', async () => {
    const where = layout(DRAIN(600));
    const server = await start(where);
    const client = await serveClient(server);
    expect((await fetch(`${server.url}/readyz`)).status).toBe(200);
    // 對照組：還沒收尾，run.start 成功。
    const events = await client.openEvents('closing-before');
    expect(await client.runStart('closing-before', '窗前')).toMatchObject({ type: 'success' });
    await foldTurn(events);

    const closing = server.close();
    const refused = await client.runStart('closing-window', '窗內');
    expect(refused).toMatchObject({ type: 'error', error: 'server_closing' });
    await closing;
    running = undefined;
  });

  it('沒有人抓過 /readyz → 不等：關得比時間窗快很多', async () => {
    const where = layout(DRAIN(2000));
    const server = await start(where);
    const startedAt = Date.now();
    await server.close();
    running = undefined;
    expect(Date.now() - startedAt).toBeLessThan(1500);
  });

  it('時間窗長度跟著 drainMs 走，不是寫死的數字', async () => {
    const where = layout(DRAIN(1200));
    const server = await start(where);
    expect((await fetch(`${server.url}/readyz`)).status).toBe(200);
    const startedAt = Date.now();
    await server.close();
    running = undefined;
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1150);
  });
});

describe('致命例外的收尾不走時間窗，不吃掉 fail-loud 的 2 秒預算（#1787）', () => {
  const DRAIN_2000 = ['- id: ops-endpoints', '  config:', '    probes:', '      drainMs: 2000'];

  /** 假行程：記下 `exit` 的時間與碼；`fire` 觸發註冊過的 handler。 */
  function fakeProcess() {
    const handlers = new Map<string, ((arg?: unknown) => void)[]>();
    const exits: { code: number; at: number }[] = [];
    const proc = {
      exitCode: undefined as number | string | null | undefined,
      on(event: string, handler: (arg?: unknown) => void) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      off() {},
      stderr: { write: () => true },
      exit: (code: number) => {
        exits.push({ code, at: Date.now() });
      },
    } as unknown as ServeProcess;
    const fire = (event: string, arg?: unknown): void => {
      for (const handler of handlers.get(event) ?? []) handler(arg);
    };
    return { proc, exits, fire };
  }

  /** 真的 `runServe`＋假行程；`close` 外面包一層記下收到的選項與完成時間。 */
  async function wired() {
    const where = layout(DRAIN_2000);
    const server = await start(where);
    // 先抓一次 /readyz：沒抓過的話時間窗本來就不等，這一格就量不到東西。
    expect((await fetch(`${server.url}/readyz`)).status).toBe(200);
    const calls: { options: unknown; at: number }[] = [];
    const wrapped: RunningServe = {
      ...server,
      close: async (options) => {
        try {
          await server.close(options);
        } finally {
          calls.push({ options, at: Date.now() });
        }
      },
    };
    const { proc, exits, fire } = fakeProcess();
    installServeProcessLifecycle(proc).attach(wrapped);
    return { server, calls, exits, fire };
  }

  it('致命例外：dispose 在 fail-loud 的 2 秒上限內完成，exit(1) 在 dispose 完成之後', async () => {
    const { calls, exits, fire } = await wired();
    const startedAt = Date.now();
    fire('uncaughtException', new Error('fatal probe'));
    await vi.waitFor(() => expect(exits).toHaveLength(1), { timeout: 5000 });
    running = undefined;

    expect(exits[0]!.code).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options).toEqual({ drain: false });
    // 順序：收尾做完才退出（時間窗若吃掉預算，`exit(1)` 會先到、thread 收尾被切掉）。
    expect(calls[0]!.at).toBeLessThanOrEqual(exits[0]!.at);
    // 上界：沒有等 2000 毫秒的時間窗（時間窗若被等，退出落在 2000 毫秒上下）。
    expect(exits[0]!.at - startedAt).toBeLessThan(1200);
  }, 15000);

  it('SIGTERM 照舊等時間窗：窗內抓得到 503，收尾要等過 drainMs', async () => {
    const { server, calls, exits, fire } = await wired();
    const startedAt = Date.now();
    fire('SIGTERM');
    const during = await fetch(`${server.url}/readyz`, { headers: { connection: 'close' } });
    expect(during.status).toBe(503);
    await vi.waitFor(() => expect(exits).toHaveLength(1), { timeout: 8000 });
    running = undefined;

    expect(exits[0]!.code).toBe(0);
    expect(calls[0]!.options).toEqual({ drain: true });
    expect(exits[0]!.at - startedAt).toBeGreaterThanOrEqual(1900);
  }, 15000);
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
