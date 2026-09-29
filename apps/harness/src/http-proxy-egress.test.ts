/**
 * 對外代理走真的入口（[#746](https://github.com/DemianLi/nexus-agent/issues/746)）。
 *
 * 政策與安裝本身的單元測試在 `@nexus/core` 的 `http-proxy/`；這裡量的是**產品路徑**：`runCli`、`runServe` 真的把
 * 代理裝上去，模型的請求真的到得了假代理。全部零憑證、零外部連線：目標是 `.invalid` 主機（永遠解析不到，
 * 只有假代理答得出來），假代理在 loopback。
 *
 * **以「假代理有沒有收到」為準**，不是「有沒有呼叫設定函式」。
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { runCli } from './cli.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { LIVE_API_KEY_ENV } from './live-model.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';

const PROXY_NAMES = [
  'http_proxy',
  'HTTP_PROXY',
  'https_proxy',
  'HTTPS_PROXY',
  'no_proxy',
  'NO_PROXY',
  'all_proxy',
  'ALL_PROXY',
];

/** 假代理收到的請求（`方法 絕對形式目標`）。有東西就證明請求走了隧道。 */
let seen: string[] = [];
let proxy: Server;
let proxyUrl: string;

const completion = JSON.stringify({
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 1,
  model: 'm',
  choices: [{ index: 0, message: { role: 'assistant', content: '好' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

/** 串流形狀的同一個回答，CLI 與 serve 各自可能要哪一種。 */
const completionStream = [
  {
    id: 'c1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'm',
    choices: [{ index: 0, delta: { role: 'assistant', content: '好' }, finish_reason: null }],
  },
  {
    id: 'c1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'm',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  },
]
  .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
  .join('')
  .concat('data: [DONE]\n\n');

beforeAll(async () => {
  proxy = createServer((request, response) => {
    seen.push(`${request.method ?? ''} ${request.url ?? ''}`);
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const streaming = Buffer.concat(chunks).toString('utf8').includes('"stream":true');
      response.writeHead(200, {
        'content-type': streaming ? 'text/event-stream' : 'application/json',
      });
      response.end(streaming ? completionStream : completion);
    });
  });
  proxy.on('connect', (request, socket) => {
    seen.push(`CONNECT ${request.url ?? ''}`);
    socket.end();
  });
  const address = await new Promise<AddressInfo>((resolve) => {
    proxy.listen(0, '127.0.0.1', () => {
      resolve(proxy.address() as AddressInfo);
    });
  });
  proxyUrl = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    proxy.close(() => {
      resolve();
    });
  });
});

const temporary: string[] = [];
let running: RunningServe | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
  seen = [];
  vi.unstubAllEnvs();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * 現在打一個 `.invalid` 主機，看假代理收不收得到。**用行為量，不比派送器的身分**：undici 8 的
 * `setGlobalDispatcher` 每次都把派送器包一層新的，還原之後拿到的是新包裝，身分比對永遠不等。
 */
async function proxyIsRouting(): Promise<boolean> {
  seen = [];
  await fetch('http://probe.invalid/', { signal: AbortSignal.timeout(1500) }).catch(
    () => undefined,
  );
  const routed = seen.length > 0;
  seen = [];
  return routed;
}

function privateDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'nexus-proxy-'));
  temporary.push(root);
  chmodSync(root, 0o700);
  return root;
}

/** 讓這條測試從空的代理環境開始；結束時 `vi.unstubAllEnvs` 還原這台機器原有的。 */
function cleanProxyEnv(): void {
  for (const name of PROXY_NAMES) vi.stubEnv(name, undefined as unknown as string);
  for (const name of PROXY_NAMES) delete process.env[name];
}

function writePatch(dir: string, baseUrl: string): string {
  const path = join(dir, `patch-${String(temporary.length)}.yml`);
  writeFileSync(
    path,
    ['- id: live-model', '  config:', `    baseUrl: '${baseUrl}'`, '    maxRetries: 0', ''].join(
      '\n',
    ),
  );
  chmodSync(path, 0o600);
  return path;
}

/** 跑一次 `--live` 的一次性 CLI。 */
async function liveCli(home: string, cwd: string, patch: string): Promise<string[]> {
  const errors: string[] = [];
  const output = new PassThrough();
  await runCli({
    argv: ['--live', '--patch', patch, '嗨'],
    input: new PassThrough(),
    output,
    cwd,
    env: { [HARNESS_HOME_ENV]: home },
    printer: { log: () => undefined, error: (line) => errors.push(line) },
  });
  return errors;
}

describe('模型的請求走代理', () => {
  it('環境變數指到假代理：模型往 .invalid 主機的請求被假代理收到', async () => {
    cleanProxyEnv();
    vi.stubEnv(LIVE_API_KEY_ENV, 'nvapi-fake-key-for-tests');
    vi.stubEnv('HTTP_PROXY', proxyUrl);
    const home = privateDir();
    const cwd = privateDir();

    await liveCli(home, cwd, writePatch(home, 'http://model-one.invalid/v1'));

    expect(seen.some((line) => line.includes('model-one.invalid/v1/chat/completions'))).toBe(true);
  });

  it('換一家供應商不用改程式：只用 patch 把端點換成第二個 .invalid 主機，請求照樣到假代理', async () => {
    cleanProxyEnv();
    vi.stubEnv(LIVE_API_KEY_ENV, 'nvapi-fake-key-for-tests');
    vi.stubEnv('HTTP_PROXY', proxyUrl);
    const home = privateDir();
    const cwd = privateDir();

    await liveCli(home, cwd, writePatch(home, 'http://model-one.invalid/v1'));
    await liveCli(home, cwd, writePatch(home, 'http://model-two.invalid/v1'));

    expect(seen.some((line) => line.includes('model-one.invalid'))).toBe(true);
    expect(seen.some((line) => line.includes('model-two.invalid'))).toBe(true);
  });

  it('代理只寫在 harness home 的 .env 也生效', async () => {
    cleanProxyEnv();
    vi.stubEnv(LIVE_API_KEY_ENV, 'nvapi-fake-key-for-tests');
    const home = privateDir();
    const cwd = privateDir();
    writeFileSync(join(home, '.env'), `HTTP_PROXY=${proxyUrl}\n`);

    await liveCli(home, cwd, writePatch(home, 'http://model-home-env.invalid/v1'));

    expect(seen.some((line) => line.includes('model-home-env.invalid'))).toBe(true);
  });

  it('對照組：沒設任何代理，請求不會到假代理', async () => {
    cleanProxyEnv();
    vi.stubEnv(LIVE_API_KEY_ENV, 'nvapi-fake-key-for-tests');
    const home = privateDir();
    const cwd = privateDir();

    // 沒有代理，`.invalid` 解析不到，這一輪失敗是預期的；要看的是假代理什麼都沒收到。
    await liveCli(home, cwd, writePatch(home, 'http://model-direct.invalid/v1')).catch(
      () => undefined,
    );

    expect(seen).toEqual([]);
  });
});

describe('每一條啟動路徑都裝，收尾一定還原', () => {
  it('CLI 沒帶 --live 也裝（網路上的 MCP 一樣連外）；跑完派送器與環境都回到原樣', async () => {
    cleanProxyEnv();
    // 用 HTTP_PROXY：量收尾的探針打的是 http 目標，HTTPS_PROXY 蓋不到它，沒收尾也會誤判成乾淨。
    vi.stubEnv('HTTP_PROXY', proxyUrl);
    const home = privateDir();
    // 這一條量收尾：跑完之後不能還有派送器留著。「有沒有裝」由 --live 那組（請求真的到假代理）與下一條（警告）證明。
    expect(await proxyIsRouting()).toBe(false);

    await runCli({
      argv: ['嗨'],
      input: new PassThrough(),
      output: new PassThrough(),
      cwd: home,
      env: { [HARNESS_HOME_ENV]: home },
      printer: { log: () => undefined, error: () => undefined },
    });

    expect(await proxyIsRouting()).toBe(false);
    expect(process.env.HTTP_PROXY).toBe(proxyUrl);
    // 政策安裝時會替 HTTPS 退回 HTTP 的代理並寫進環境；收尾要把它拿掉。
    expect(process.env.https_proxy).toBeUndefined();
  });

  it('CLI 沒帶 --live 也裝：用不了的代理值被報出來（只有走過安裝才會有這一行）', async () => {
    cleanProxyEnv();
    vi.stubEnv('HTTPS_PROXY', 'socks5://user:secret@127.0.0.1:1080');
    const home = privateDir();
    const errors: string[] = [];

    await runCli({
      argv: ['嗨'],
      input: new PassThrough(),
      output: new PassThrough(),
      cwd: home,
      env: { [HARNESS_HOME_ENV]: home },
      printer: { log: () => undefined, error: (line) => errors.push(line) },
    });

    const warning = errors.find((line) => line.startsWith('代理：'));
    expect(warning).toContain('HTTPS_PROXY');
    expect(errors.join('\n')).not.toContain('secret');
  });

  it('serve 沒帶 --live 也裝；close 之後派送器與環境回到原樣', async () => {
    cleanProxyEnv();
    vi.stubEnv('HTTP_PROXY', proxyUrl);
    const home = privateDir();
    expect(await proxyIsRouting()).toBe(false);

    const server = await runServe({
      argv: ['--port', '0'],
      log: () => undefined,
      env: { [HARNESS_HOME_ENV]: home },
      cwd: home,
    });
    running = server;
    expect(await proxyIsRouting()).toBe(true);
    // 政策寫回環境：HTTPS 沒指名，退回 HTTP 的代理，兩種大小寫都有。
    expect(process.env.https_proxy).toBe(proxyUrl);

    await server?.close();
    running = undefined;
    expect(await proxyIsRouting()).toBe(false);
    expect(process.env.https_proxy).toBeUndefined();
    expect(process.env.HTTP_PROXY).toBe(proxyUrl);
  });

  it('serve 起不來：當場還原，不留派送器給後面的啟動', async () => {
    cleanProxyEnv();
    vi.stubEnv('HTTP_PROXY', proxyUrl);
    vi.stubEnv(LIVE_API_KEY_ENV, undefined as unknown as string);
    delete process.env[LIVE_API_KEY_ENV];
    const home = privateDir();

    // `--live` 而沒有金鑰：在代理裝上之前就拋（載環境那一步）。壞在裝代理之後的，見下一條。
    await expect(
      runServe({
        argv: ['--port', '0', '--live'],
        log: () => undefined,
        env: { [HARNESS_HOME_ENV]: home },
        cwd: home,
      }),
    ).rejects.toThrow(LIVE_API_KEY_ENV);
    expect(await proxyIsRouting()).toBe(false);
  });

  it('用不了的代理值：啟動不失敗，訊息點名變數、不含值，該協定直連', async () => {
    cleanProxyEnv();
    vi.stubEnv('HTTPS_PROXY', 'socks5://user:secret@127.0.0.1:1080');
    const home = privateDir();
    const lines: string[] = [];

    running = await runServe({
      argv: ['--port', '0'],
      log: (line) => lines.push(line),
      env: { [HARNESS_HOME_ENV]: home },
      cwd: home,
    });

    const warning = lines.find((line) => line.startsWith('代理：'));
    expect(warning).toContain('HTTPS_PROXY');
    expect(warning).not.toContain('secret');
    expect(lines.join('\n')).not.toContain('secret');
  });
});
