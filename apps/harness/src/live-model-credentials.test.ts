/**
 * 模型的 key 是**每次請求前**才從憑證服務解析的（[#730](https://github.com/DemianLi/nexus-agent/issues/730) 的 B 段）。
 *
 * 問的是假端點**真的收到**的 `Authorization` 標頭，不是 client 上設了什麼：假的服務就算把函式接上，
 * 只要 SDK 在 `bindTools`／`withConfig` 之後把它換成字串，這裡就會紅。
 * 零憑證、零外部連線：loopback 上的假 OpenAI 端點。
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HumanMessage } from '@langchain/core/messages';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CREDENTIALS_FILE, createCredentialService } from './credentials.js';
import { loadLaunchEnv } from './launch-env.js';
import { LIVE_API_KEY_ENV, createLiveModel } from './live-model.js';
import { liveModelConfigSchema } from './settings/live-model.js';

const FILE_KEY = 'nvapi-only-in-the-managed-file';
const NEXT_KEY = 'nvapi-second-value-after-rotation';

let root: string;
let home: string;
let server: Server;
let seen: string[];
let baseUrl: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'live-credentials-'));
  home = join(root, 'home');
  mkdirSync(home);
  seen = [];
  // 不論外面有沒有設，這一組都不靠 `process.env`。
  vi.stubEnv(LIVE_API_KEY_ENV, undefined as unknown as string);
  delete process.env[LIVE_API_KEY_ENV];
  server = createServer((request, response) => {
    seen.push(String(request.headers.authorization));
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 1,
        model: 'm',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('沒拿到 loopback 埠');
  baseUrl = `http://127.0.0.1:${String(address.port)}/v1`;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((done) => server.close(() => done()));
  rmSync(root, { recursive: true, force: true });
});

function managed(key: string): void {
  const file = join(home, CREDENTIALS_FILE);
  writeFileSync(file, `version: 1\nrefs:\n  ${LIVE_API_KEY_ENV}: ${key}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

function credentials() {
  const launchEnv = loadLaunchEnv({
    cwd: root,
    home,
    target: {},
    warn: () => undefined,
  });
  return createCredentialService({ home, launchEnv, warn: () => undefined });
}

const config = () => liveModelConfigSchema.parse({ baseUrl, maxRetries: 0 });

describe('key 從受管檔來、每次請求前解析', () => {
  it('key 只在受管檔：請求帶著它，process.env 始終沒有', async () => {
    managed(FILE_KEY);
    const model = createLiveModel(config(), undefined, credentials());

    await model.invoke([new HumanMessage('hi')]);

    expect(seen).toEqual([`Bearer ${FILE_KEY}`]);
    expect(process.env[LIVE_API_KEY_ENV]).toBeUndefined();
  });

  it('經過 bindTools 與 withConfig 之後函式還在：每一顆衍生的 model 都帶著當下的 key', async () => {
    managed(FILE_KEY);
    const model = createLiveModel(config(), undefined, credentials());
    const derived = model
      .bindTools([{ type: 'function', function: { name: 't', parameters: { type: 'object' } } }])
      .withConfig({ tags: ['x'] });

    await derived.invoke([new HumanMessage('hi')]);

    expect(seen).toEqual([`Bearer ${FILE_KEY}`]);
  });

  it('換檔內容：下一個請求就用新的，不必重建 model', async () => {
    managed(FILE_KEY);
    const model = createLiveModel(config(), undefined, credentials());
    await model.invoke([new HumanMessage('one')]);

    managed(NEXT_KEY);
    await model.invoke([new HumanMessage('two')]);

    expect(seen).toEqual([`Bearer ${FILE_KEY}`, `Bearer ${NEXT_KEY}`]);
  });

  it('兩個請求之間 key 被拿掉：請求時的那一次也講缺哪一個，且不送出請求', async () => {
    managed(FILE_KEY);
    const model = createLiveModel(config(), undefined, credentials());
    await model.invoke([new HumanMessage('one')]);

    rmSync(join(home, CREDENTIALS_FILE));
    await expect(model.invoke([new HumanMessage('two')])).rejects.toThrow(LIVE_API_KEY_ENV);
    expect(seen).toHaveLength(1);
  });

  it('組裝當下就缺：建構就拋，訊息列出四處來源', () => {
    const attempt = () => createLiveModel(config(), undefined, credentials());
    expect(attempt).toThrow(LIVE_API_KEY_ENV);
    expect(attempt).toThrow(CREDENTIALS_FILE);
  });
});

describe('四層優先序走到假端點（不是只看 resolve 的回傳）', () => {
  it('啟動環境 > 受管檔 > 目前資料夾 .env > home .env：逐層拿掉，端點收到的跟著換', async () => {
    writeFileSync(join(home, '.env'), `${LIVE_API_KEY_ENV}=home-env\n`);
    writeFileSync(join(root, '.env'), `${LIVE_API_KEY_ENV}=project-env\n`);
    managed('managed-file');
    const build = (inherited: NodeJS.ProcessEnv) => {
      const launchEnv = loadLaunchEnv({
        cwd: root,
        home,
        target: { ...inherited },
        warn: () => undefined,
      });
      return createLiveModel(
        config(),
        undefined,
        createCredentialService({ home, launchEnv, warn: () => undefined }),
      );
    };

    await build({ [LIVE_API_KEY_ENV]: 'process' }).invoke([new HumanMessage('a')]);
    await build({}).invoke([new HumanMessage('b')]);
    rmSync(join(home, CREDENTIALS_FILE));
    await build({}).invoke([new HumanMessage('c')]);
    rmSync(join(root, '.env'));
    await build({}).invoke([new HumanMessage('d')]);

    expect(seen).toEqual([
      'Bearer process',
      'Bearer managed-file',
      'Bearer project-env',
      'Bearer home-env',
    ]);
  });
});
