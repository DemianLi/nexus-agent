/**
 * 真的 serve 聽 `--unix-socket`（#2369）：代理會走的每一個面都經 socket 通——登入、網頁、探針、wire、WebSocket；
 * 目錄權限不合就起不來，而且一個檔都沒寫；上一次被砍掉留下的 socket 檔不擋重啟。
 */

import { access, chmod, chown, lstat, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { THREADS_PATH, WIRE_MUX_PATH } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';
import { bodyLog } from './fixtures.js';
import { staleSocketAt } from './proxy-socket.fixture.js';
import { OWNER_PRINCIPAL } from './wire-principal.js';

const POSIX = process.platform !== 'win32';
const GID = process.getgid?.() ?? 0;
const INDEX = '<!doctype html><title>nexus web</title>';
const PROXIED = { host: 'app.example' };

let running: RunningServe | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function builtDist(): Promise<string> {
  const dist = join(await mkdtemp(join(tmpdir(), 'nexus-serve-dist-')), 'dist');
  await mkdir(join(dist, 'assets'), { recursive: true });
  await writeFile(join(dist, 'index.html'), INDEX);
  return dist;
}

/** 權限 `mode`、群組是這個行程的群組的目錄，回 socket 放在裡面的路徑。路徑要短：macOS 的 socket 路徑上限是 104 個位元組。 */
async function socketIn(mode: number): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'nx-'));
  await chown(directory, process.getuid?.() ?? 0, GID);
  await chmod(directory, mode);
  return join(directory, 's');
}

async function start(
  socketPath: string,
  home: string,
  lines: string[] = [],
  extra: readonly string[] = [],
): Promise<RunningServe> {
  running = await runServe({
    argv: [
      '--unix-socket',
      socketPath,
      '--socket-group',
      String(GID),
      '--trusted-host',
      'app.example',
      '--public-url',
      'https://app.example/nexus',
      ...extra,
    ],
    log: bodyLog(lines),
    env: { [HARNESS_HOME_ENV]: home },
    webDist: await builtDist(),
  });
  return running as RunningServe;
}

/** 經 socket 打一個 GET；Host 等標頭由呼叫方給。 */
function socketGet(
  socketPath: string,
  path: string,
  headers: Record<string, string>,
): Promise<{
  readonly status: number;
  readonly body: string;
  readonly headers: Record<string, string | string[] | undefined>;
}> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ socketPath, path, method: 'GET', headers }, (incoming) => {
      let body = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk: string) => {
        body += chunk;
      });
      incoming.on('end', () =>
        resolve({ status: incoming.statusCode ?? 0, body, headers: incoming.headers }),
      );
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

/** 經 socket 開一條 WebSocket：開得起來回 `open`，被拒回那個狀態碼。 */
function muxOver(socketPath: string, headers: Record<string, string>): Promise<'open' | number> {
  return new Promise((resolve, reject) => {
    const websocket = new WebSocket(`ws+unix://${socketPath}:${WIRE_MUX_PATH}`, { headers });
    websocket.once('open', () => {
      websocket.close();
      resolve('open');
    });
    websocket.once('unexpected-response', (_request, response) => {
      resolve(response.statusCode ?? 0);
    });
    websocket.once('error', reject);
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe.runIf(POSIX)('serve 聽 --unix-socket', () => {
  it('代理會走的面都經 socket 通：登入、網頁、探針、wire、WebSocket；socket 檔是 666', async () => {
    const socketPath = await socketIn(0o750);
    const lines: string[] = [];
    const server = await start(
      socketPath,
      await mkdtemp(join(tmpdir(), 'nexus-serve-home-')),
      lines,
    );

    const launch = new URL(server.authenticatedUrl);
    expect(`${launch.origin}${launch.pathname}`).toBe('https://app.example/nexus/');
    expect(lines[0]).toBe(`nexus-agent 在 ${server.authenticatedUrl}`);
    expect((await lstat(socketPath)).mode & 0o777).toBe(0o666);

    const login = await socketGet(socketPath, `/${launch.search}`, PROXIED);
    expect(login.status).toBe(303);
    expect(login.headers['location']).toBe('./');
    const cookie = String(login.headers['set-cookie']).split(';', 1)[0]!;

    const page = await socketGet(socketPath, '/', { ...PROXIED, cookie });
    expect({ status: page.status, body: page.body }).toEqual({ status: 200, body: INDEX });
    expect((await socketGet(socketPath, '/livez', PROXIED)).status).toBe(200);
    // 營運者在主機上直接打探針：`curl --unix-socket … http://localhost/livez` 的 Host 是 localhost。
    expect((await socketGet(socketPath, '/livez', { host: 'localhost' })).status).toBe(200);
    const sameOrigin = {
      ...PROXIED,
      cookie,
      origin: 'https://app.example',
      'content-type': 'application/json',
    };
    expect((await socketGet(socketPath, THREADS_PATH, sameOrigin)).status).toBe(200);
    expect(
      (await socketGet(socketPath, THREADS_PATH, { ...sameOrigin, host: 'evil.example' })).status,
    ).toBe(403);

    expect(await muxOver(socketPath, sameOrigin)).toBe('open');
    expect(await muxOver(socketPath, { ...sameOrigin, origin: 'https://evil.example' })).toBe(403);
    expect(await muxOver(socketPath, { ...PROXIED, origin: 'https://app.example' })).toBe(401);
  });

  it('目錄權限不合就起不來，home 一個檔都沒寫', async () => {
    for (const [mode, gid] of [
      [0o755, GID],
      [0o770, GID],
      [0o750, GID + 1],
    ] as const) {
      const socketPath = await socketIn(mode);
      const home = join(await mkdtemp(join(tmpdir(), 'nexus-serve-home-')), 'home');
      await expect(
        runServe({
          argv: [
            '--unix-socket',
            socketPath,
            '--socket-group',
            String(gid),
            '--public-url',
            'https://app.example/nexus',
          ],
          log: () => undefined,
          env: { [HARNESS_HOME_ENV]: home },
        }),
        `${mode.toString(8)} gid ${String(gid)}`,
      ).rejects.toThrow(/socket 目錄/);
      expect(await exists(home)).toBe(false);
      expect(await exists(socketPath)).toBe(false);
    }
  });

  it('對話行程不收 --unix-socket：它的 socket 由監督行程給', async () => {
    const socketPath = await socketIn(0o750);
    await expect(
      runServe({
        argv: [
          '--unix-socket',
          socketPath,
          '--socket-group',
          String(GID),
          '--public-url',
          'https://app.example/nexus',
        ],
        log: () => undefined,
        env: { [HARNESS_HOME_ENV]: await mkdtemp(join(tmpdir(), 'nexus-serve-home-')) },
        conversation: {
          socketPath: `${socketPath}-peer`,
          auth: { authenticate: () => OWNER_PRINCIPAL },
          boundThread: () => undefined,
          onTurn: () => undefined,
        },
      }),
    ).rejects.toThrow(/對話行程不收 --unix-socket/);
  });

  it('上一次被 SIGKILL 留下的 socket 檔不擋重啟；正常收尾會把檔清掉', async () => {
    const socketPath = await socketIn(0o750);
    await staleSocketAt(socketPath);
    expect((await lstat(socketPath)).isSocket()).toBe(true);

    await start(socketPath, await mkdtemp(join(tmpdir(), 'nexus-serve-home-')));
    expect((await socketGet(socketPath, '/livez', PROXIED)).status).toBe(200);
    await running?.close();
    running = undefined;
    expect(await exists(socketPath)).toBe(false);
  });

  it('另一個 serve 還在聽同一個 socket：第二個起不來，第一個照跑', async () => {
    const socketPath = await socketIn(0o750);
    await start(socketPath, await mkdtemp(join(tmpdir(), 'nexus-serve-home-')));
    await expect(
      runServe({
        argv: [
          '--unix-socket',
          socketPath,
          '--socket-group',
          String(GID),
          '--public-url',
          'https://app.example/nexus',
        ],
        log: () => undefined,
        env: { [HARNESS_HOME_ENV]: await mkdtemp(join(tmpdir(), 'nexus-serve-home-')) },
        webDist: await builtDist(),
      }),
    ).rejects.toThrow(/已經有行程在聽/);
    expect((await socketGet(socketPath, '/livez', PROXIED)).status).toBe(200);
  });
});
