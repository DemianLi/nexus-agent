/**
 * 會話日誌 header 的建置中繼資料（[#1025](https://github.com/DemianLi/nexus-agent/issues/1025)）。
 *
 * 卡上四條驗收各有一組：
 *
 * 1. **設定裡放一個長得像金鑰的值，header 與雜湊都不洩漏它**——量的是寫上磁碟的 header 原文（交付物），不是投影函式的
 *    回傳值；雜湊另外驗「不是無鍵的 sha256」與「換一把鍵就換一個值」。
 * 2. **續接後 header 的建置版本仍是最初那個**——把磁碟上的 header 換成一個這台機器不可能算出來的版本，續接之後讀原文。
 * 3. **`--dump-config` 與 header 的插件清單一致**——同一組 env 與 `--patch` 跑一次 `--dump-config`，YAML 讀回來投影後逐字比。
 * 4. **舊版 header 讀得出來，缺的欄位標「—」**——讀的一側（離線掃描）的投影與報表。
 *
 * **不靠跑測試的機器有沒有 `.git`**：產品路徑上的那兩條只驗建置版本那一格的形狀（字串或 `null`），值的取法與「取不到」的
 * 降級在 `eval/result-file.test.ts` 的 `readGitProvenance` 與下面注入建置版本的那幾條。
 *
 * **零憑證、零外部連線**：假 key、`.invalid` 主機或本機假端點。
 */

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { SESSION_LOG_FORMAT_VERSION } from '@nexus/core';
import type { StoredSessionHeader } from '@nexus/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { runCli } from './cli.js';
import { foldTurn, serveClient } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { projectKey } from './jsonl-session-store.js';
import { DEFAULT_LIVE_MODEL_ID, LIVE_API_KEY_ENV } from './live-model.js';
import type { ConfigEntry } from './plugin-config.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';
import {
  CONFIG_HASH_KEY_FILE,
  CONFIG_HASH_PREFIX,
  configHashOf,
  formatSessionHeaderMetadata,
  pluginRowsOf,
  readSessionHeaderMetadata,
  resolveSessionHeaderMetadata,
} from './session-header-metadata.js';
import { stableStringify } from './stable-stringify.js';

/** 長得像金鑰的值：`sk-` 開頭、夠長、夠亂。任何一處原文出現它就是漏了。 */
const CANARY = 'sk-nexus-canary-1025-9f8e7d6c5b4a39281706f5e4d3c2b1a0';

const temporary: string[] = [];
let running: RunningServe | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
  vi.unstubAllEnvs();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

function privateDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(root);
  chmodSync(root, 0o700);
  return root;
}

function writePatch(dir: string, content: string): string {
  const path = join(dir, `patch-${String(readdirSync(dir).length)}.yml`);
  writeFileSync(path, content);
  chmodSync(path, 0o600);
  return path;
}

/**
 * 把金鑰樣的值藏進 `live-model` 那一列的設定：型錄條目的 chat template 參數（任意字串都收），`baseUrl` 給呼叫端決定
 * （CLI 用一個帶著它的 `.invalid` 主機名，serve 用本機假端點）。
 */
function canaryPatch(baseUrl: string): string {
  return [
    '- id: live-model',
    '  config:',
    `    baseUrl: '${baseUrl}'`,
    `    modelId: '${DEFAULT_LIVE_MODEL_ID}'`,
    '    maxRetries: 0',
    '    models:',
    `      - id: '${DEFAULT_LIVE_MODEL_ID}'`,
    '        contextWindow: 700045',
    '        maxTokens: 16384',
    '        compat:',
    '          chatTemplateKwargs:',
    `            api_token: '${CANARY}'`,
    // 關掉一列可少掛的：清單一致要連 `disabled` 一起比，出貨清單上一列停用的都沒有。
    '- id: todo',
    '  disabled: true',
    '',
  ].join('\n');
}

/** 讀 home 底下那一把鍵。 */
async function readKey(home: string): Promise<Buffer> {
  const record = JSON.parse(await readFile(join(home, CONFIG_HASH_KEY_FILE), 'utf8')) as {
    secret: string;
  };
  return Buffer.from(record.secret, 'base64url');
}

/** 跑一次 `--dump-config`，印出來的 YAML 讀回成條目清單。 */
async function dumpEntries(home: string, patch: string): Promise<ConfigEntry[]> {
  const printed: string[] = [];
  await runCli({
    argv: ['--dump-config', '--patch', patch],
    env: { [HARNESS_HOME_ENV]: home },
    input: new PassThrough(),
    output: new PassThrough(),
    printer: { log: (line) => printed.push(line), error: () => undefined },
  });
  return parseYaml(printed.join('\n')) as ConfigEntry[];
}

/** 無鍵的雜湊：拿日誌的人自己算得出來的那一種。 */
function unkeyedHash(entries: readonly ConfigEntry[]): string {
  const digest = createHash('sha256').update(stableStringify(entries)).digest('hex');
  return `${CONFIG_HASH_PREFIX}${digest.slice(0, 16)}`;
}

/** 建置版本那一格的形狀：產品路徑上的值取決於跑測試的機器，只驗形狀。 */
function expectBuildShape(header: Record<string, unknown>): void {
  const build = header['build'] as { commit: unknown; dirty: unknown } | undefined;
  expect(build).toBeDefined();
  expect(build!.commit === null || typeof build!.commit === 'string').toBe(true);
  expect(build!.dirty === null || typeof build!.dirty === 'boolean').toBe(true);
}

describe('寫的一側：投影與雜湊', () => {
  const entries: ConfigEntry[] = [
    { id: 'live-model', name: '#settings/live-model', config: { token: CANARY } },
    { name: '@nexus/plugin-todo', disabled: true },
  ];

  it('插件清單只留 name、id、disabled，沒寫 id 的列沒有那一格', () => {
    expect(pluginRowsOf(entries)).toEqual([
      { name: '#settings/live-model', id: 'live-model', disabled: false },
      { name: '@nexus/plugin-todo', disabled: true },
    ]);
    expect('id' in pluginRowsOf(entries)[1]!).toBe(false);
    expect(JSON.stringify(pluginRowsOf(entries))).not.toContain(CANARY);
  });

  it('雜湊帶鍵：同一把鍵同一份設定同一個值，換一把鍵就換，也不是無鍵的 sha256', () => {
    const key = Buffer.alloc(32, 1);
    const hash = configHashOf(entries, key);
    expect(hash).toMatch(/^hmac-sha256:[0-9a-f]{16}$/u);
    expect(hash).not.toContain(CANARY);
    expect(configHashOf(structuredClone(entries), Buffer.alloc(32, 1))).toBe(hash);
    expect(configHashOf(entries, Buffer.alloc(32, 2))).not.toBe(hash);
    expect(hash).not.toBe(unkeyedHash(entries));
    // 設定裡任何一個值變了，雜湊就變——它描述的是整份設定，不只是清單。
    const changed = structuredClone(entries);
    changed[0]!.config = { token: `${CANARY}x` };
    expect(configHashOf(changed, key)).not.toBe(hash);
  });

  it('鍵檔第一次用時建在 home 底下、只有擁有者讀得到；第二次用同一把', async () => {
    const home = join(privateDir('nexus-hdr-home-'), 'home');
    const env = { [HARNESS_HOME_ENV]: home };
    const build = { commit: 'c'.repeat(40), dirty: false };
    const cwd = process.cwd();
    const first = await resolveSessionHeaderMetadata({
      entries,
      env,
      warn: () => undefined,
      build,
      cwd,
    });
    expect(statSync(join(home, CONFIG_HASH_KEY_FILE)).mode & 0o777).toBe(0o600);
    const second = await resolveSessionHeaderMetadata({
      entries,
      env,
      warn: () => undefined,
      build,
      cwd,
    });
    expect(second.configHash).toBe(first.configHash);
    expect(first.configHash).toBe(configHashOf(entries, await readKey(home)));
    expect(first.build).toEqual(build);
  });

  it('鍵檔權限過寬：講一聲、只少雜湊那一格，不擋', async () => {
    const home = privateDir('nexus-hdr-home-');
    const keyFile = join(home, CONFIG_HASH_KEY_FILE);
    writeFileSync(
      keyFile,
      `${JSON.stringify({ version: 1, secret: Buffer.alloc(32, 3).toString('base64url') })}\n`,
    );
    chmodSync(keyFile, 0o644);
    const warnings: string[] = [];
    const metadata = await resolveSessionHeaderMetadata({
      entries,
      env: { [HARNESS_HOME_ENV]: home },
      warn: (message) => warnings.push(message),
      build: { commit: null, dirty: null },
      cwd: process.cwd(),
    });
    expect(warnings.join('\n')).toContain('設定雜湊的鍵檔');
    expect('configHash' in metadata).toBe(false);
    expect(metadata.plugins).toHaveLength(2);
    expect(metadata.build).toEqual({ commit: null, dirty: null });
  });

  it('home 在 `--workspace` 底下：不建鍵檔、只少雜湊那一格（模型讀得到的鍵等於沒有鍵）', async () => {
    const workspace = privateDir('nexus-hdr-ws-');
    const home = join(workspace, 'home');
    const warnings: string[] = [];
    const metadata = await resolveSessionHeaderMetadata({
      entries,
      env: { [HARNESS_HOME_ENV]: home },
      warn: (message) => warnings.push(message),
      build: { commit: null, dirty: null },
      workspace,
      cwd: process.cwd(),
    });
    expect('configHash' in metadata).toBe(false);
    expect(warnings.join('\n')).toContain('--workspace');
    expect(readdirSync(workspace)).toEqual([]);
  });
});

describe('讀的一側：舊版讀得出來，缺的標「—」', () => {
  it('29 以前的 header 一格都沒有：投影是空的，報表四格都是「—」', () => {
    const old = { version: 27, id: 'cli', createdAt: 1 } as StoredSessionHeader;
    expect(readSessionHeaderMetadata(old)).toEqual({});
    expect(formatSessionHeaderMetadata(readSessionHeaderMetadata(old))).toBe(
      '建置 — ｜模型 — ｜插件 — ｜設定雜湊 —',
    );
  });

  it('記了但取不到（寫的時候沒有 git）是「取不到」，不是「—」', () => {
    expect(
      formatSessionHeaderMetadata({
        build: { commit: null, dirty: null },
        plugins: [{ name: 'a', disabled: false }],
      }),
    ).toBe('建置 取不到（未提交的改動：取不到） ｜模型 — ｜插件 1 列（停用 0） ｜設定雜湊 —');
  });

  it('記全了：短 SHA、模型型錄 id、列數與停用數、雜湊', () => {
    expect(
      formatSessionHeaderMetadata({
        build: { commit: '0123456789abcdef0123', dirty: true },
        plugins: [
          { name: 'a', disabled: false },
          { name: 'b', id: 'b', disabled: true },
        ],
        configHash: 'hmac-sha256:00112233aabbccdd',
        modelEntryId: 'vendor/model',
      }),
    ).toBe(
      '建置 0123456789ab（未提交的改動：有） ｜模型 vendor/model ｜插件 2 列（停用 1） ｜' +
        '設定雜湊 hmac-sha256:00112233aabbccdd',
    );
  });

  it('形狀不對的那一格當成沒記，其餘照讀', () => {
    const header = {
      version: SESSION_LOG_FORMAT_VERSION,
      id: 'x',
      createdAt: 1,
      build: { commit: 42, dirty: false },
      plugins: [{ name: 'a', disabled: 'no' }],
      configHash: 'hmac-sha256:00112233aabbccdd',
      modelEntryId: 7,
    } as unknown as StoredSessionHeader;
    expect(readSessionHeaderMetadata(header)).toEqual({
      configHash: 'hmac-sha256:00112233aabbccdd',
    });
  });
});

describe('CLI：寫上磁碟的 header', () => {
  /** 跑一次 CLI，日誌落在 `logs` 底下；回唯一那個 run 目錄。 */
  async function cliRun(
    home: string,
    logs: string,
    argv: readonly string[],
    lines = '/exit\n',
  ): Promise<string> {
    const input = new PassThrough();
    input.end(lines);
    await runCli({
      argv: [...argv],
      env: { [HARNESS_HOME_ENV]: home },
      input,
      output: new PassThrough(),
      printer: { log: () => undefined, error: () => undefined },
    }).catch(() => undefined);
    const entries = readdirSync(logs);
    expect(entries).toHaveLength(1);
    return join(logs, entries[0]!);
  }

  it('不漏金鑰樣的值；插件清單與 `--dump-config` 一致；雜湊是這台的鍵算的、不是無鍵的；假模型沒有型錄 id', async () => {
    const home = privateDir('nexus-hdr-home-');
    const logs = privateDir('nexus-hdr-logs-');
    const patch = writePatch(home, canaryPatch(`https://${CANARY}.invalid/v1`));

    const runDir = await cliRun(home, logs, ['--session-log', logs, '--patch', patch]);
    const raw = await readFile(join(runDir, 'cli.header.json'), 'utf8');
    // 量的是交付物：寫上磁碟的那一行原文。
    expect(raw).not.toContain(CANARY);
    expect(raw).not.toContain('canary');
    const header = JSON.parse(raw) as Record<string, unknown>;

    expect(header['version']).toBe(SESSION_LOG_FORMAT_VERSION);
    expectBuildShape(header);
    const dumped = await dumpEntries(home, patch);
    // 前提：金鑰樣的值真的在設定裡（驗得過、印得出來），不然上面那句「沒漏」證不了什麼。
    expect(JSON.stringify(dumped)).toContain(CANARY);
    expect(header['plugins']).toEqual(pluginRowsOf(dumped));
    // 前提：清單上真的有一列停用的，上面那句才連 `disabled` 一起比到。
    expect(header['plugins']).toContainEqual(
      expect.objectContaining({ id: 'todo', disabled: true }),
    );
    expect(header['configHash']).toBe(configHashOf(dumped, await readKey(home)));
    expect(header['configHash']).not.toBe(unkeyedHash(dumped));
    expect('modelEntryId' in header).toBe(false);
  });

  it('帶 `--live`：root 的 header 記模型型錄 id，同樣不漏', async () => {
    vi.stubEnv(LIVE_API_KEY_ENV, 'nvapi-fake-key-for-header-tests');
    const home = privateDir('nexus-hdr-home-');
    const cwd = privateDir('nexus-hdr-cwd-');
    const logs = privateDir('nexus-hdr-logs-');
    const patch = writePatch(home, canaryPatch(`http://${CANARY}.invalid/v1`));

    const input = new PassThrough();
    input.end('');
    // 一次性：端點連不上，那一輪失敗，header 照樣在第一次寫入時落地。
    await runCli({
      argv: ['--live', '--session-log', logs, '--patch', patch, '嗨'],
      cwd,
      env: { [HARNESS_HOME_ENV]: home },
      input,
      output: new PassThrough(),
      printer: { log: () => undefined, error: () => undefined },
    }).catch(() => undefined);
    const [runDir] = readdirSync(logs);
    const raw = await readFile(join(logs, runDir!, 'cli.header.json'), 'utf8');
    expect(raw).not.toContain(CANARY);
    expect(JSON.parse(raw)).toMatchObject({ modelEntryId: DEFAULT_LIVE_MODEL_ID });
  });

  it('續接：header 的建置版本、插件清單、雜湊都還是最初那一份，版本升到這一版', async () => {
    const home = privateDir('nexus-hdr-home-');
    const logs = privateDir('nexus-hdr-logs-');
    const runDir = await cliRun(home, logs, ['--session-log', logs]);
    const headerPath = join(runDir, 'cli.header.json');
    const written = JSON.parse(await readFile(headerPath, 'utf8')) as Record<string, unknown>;
    // 前提：第一次跑真的寫了這幾格。
    expectBuildShape(written);
    expect(written['configHash']).toMatch(/^hmac-sha256:/u);

    // 換成這個行程不可能算出來的值，假裝是更早一版的程式寫的：續接要是重算了，就會蓋掉它們。
    const original = {
      ...written,
      version: SESSION_LOG_FORMAT_VERSION - 1,
      build: { commit: 'f'.repeat(40), dirty: false },
      plugins: [{ name: '@nexus/最初那一列', id: 'first', disabled: false }],
      configHash: 'hmac-sha256:feedfacefeedface',
    };
    await writeFile(headerPath, JSON.stringify(original));

    await cliRun(home, logs, ['--resume', runDir]);

    const after = JSON.parse(await readFile(headerPath, 'utf8')) as Record<string, unknown>;
    expect(after).toEqual({ ...original, version: SESSION_LOG_FORMAT_VERSION });
  });
});

describe('serve：每條 thread 新建的 header', () => {
  let fake: { server: Server; baseUrl: string } | undefined;

  afterEach(async () => {
    const server = fake?.server;
    fake = undefined;
    if (server !== undefined) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** 本機假端點：回一句話就收。每次的 id 都不同（同 id 的 AI 訊息會被 reducer 取代）。 */
  async function startEndpoint(): Promise<{ server: Server; baseUrl: string }> {
    let next = 0;
    const server = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        next += 1;
        const frame = (payload: Record<string, unknown>): string =>
          `data: ${JSON.stringify({
            id: `chatcmpl-header-${String(next)}`,
            object: 'chat.completion.chunk',
            created: 1_790_000_000,
            model: DEFAULT_LIVE_MODEL_ID,
            ...payload,
          })}\n\n`;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(
          frame({ choices: [{ index: 0, delta: { role: 'assistant', content: '好' } }] }),
        );
        response.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
        response.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return { server, baseUrl: `http://127.0.0.1:${String(port)}/v1` };
  }

  it('帶 `--live`：記建置、插件清單（同 `--dump-config`）、雜湊與模型型錄 id，不漏金鑰樣的值', async () => {
    vi.stubEnv(LIVE_API_KEY_ENV, 'nvapi-fake-key-for-header-tests');
    fake = await startEndpoint();
    const home = privateDir('nexus-hdr-home-');
    const root = privateDir('nexus-hdr-logs-');
    const patch = writePatch(home, canaryPatch(fake.baseUrl));
    running = (await runServe({
      argv: ['--port', '0', '--live', '--session-log', root, '--patch', patch],
      log: () => undefined,
      env: { [HARNESS_HOME_ENV]: home },
    })) as RunningServe;
    const client = await serveClient(running);
    const events = await client.openEvents('alpha');
    await client.runStart('alpha', '說一句話。');
    await foldTurn(events);
    await events.return?.(undefined);
    await running.close();
    running = undefined;

    const raw = await readFile(join(root, projectKey(process.cwd()), 'alpha.header.json'), 'utf8');
    expect(raw).not.toContain(CANARY);
    const header = JSON.parse(raw) as Record<string, unknown>;
    expectBuildShape(header);
    const dumped = await dumpEntries(home, patch);
    expect(JSON.stringify(dumped)).toContain(CANARY);
    expect(header['plugins']).toEqual(pluginRowsOf(dumped));
    expect(header['configHash']).toBe(configHashOf(dumped, await readKey(home)));
    expect(header['modelEntryId']).toBe(DEFAULT_LIVE_MODEL_ID);
  }, 60_000);
});
