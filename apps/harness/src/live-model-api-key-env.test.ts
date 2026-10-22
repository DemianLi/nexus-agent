/**
 * **`live-model` 那一列的 `apiKeyEnv`：金鑰的名字由設定決定，一路走到每個建模型的地方**
 * （[#1604](https://github.com/DemianLi/nexus-agent/issues/1604)，N0200）。
 *
 * 把 `baseUrl` 指到公司內部閘道時，金鑰可以叫 `GATEWAY_KEY`，受管憑證檔的 `refs:`、啟動環境、`.env` 都照這個名字找，
 * 缺金鑰與格式錯誤的訊息講的也是它；沒寫就照舊是 `NVIDIA_API_KEY`。
 *
 * **接線的幾條從真的入口起量**（`runServe --live`、`runCli --live`；`apiKeyEnv` 經 `--patch` 進去，不在測試裡自己傳設定物件），
 * 對手方是 loopback 上的假端點，記每個請求帶的 `Authorization` 與 `model`。`createLiveModel` 在三個地方被呼叫（對話與換模型、標題、
 * 背景子代理），名字都從同一份 `LiveModelConfig` 帶下去，所以任何一處把名字寫回常數，這裡就有一條紅。
 *
 * **每一條都先證明走的是它要測的那條路**：受管檔裡只放 `GATEWAY_KEY`，環境裡放一把不同的 `NVIDIA_API_KEY` 當誘餌——
 * 端點收到的若是誘餌，就是名字被寫回了常數；若根本沒有請求，就是設定沒載入。
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

import { liveSubagentModelFor } from './assembly-root.js';
import { runCli } from './cli.js';
import { ambientCredentials, CREDENTIALS_FILE } from './credentials.js';
import { bodyLog, foldTurn, serveClient } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { DEFAULT_LIVE_MODEL_ENTRY, DEFAULT_LIVE_MODEL_ID, LIVE_API_KEY_ENV } from './live-model.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';
import { liveModelConfigSchema } from './settings/live-model.js';

const NAME = 'GATEWAY_KEY';
/** 前 6 個字元各自獨特，拿來斷言訊息與日誌不帶值的任何片段。 */
const GATEWAY_VALUE = 'zq9gate-managed-0123456789';
const DECOY_VALUE = 'zq9decoy-ambient-0123456789';
const A = 'model-a';
const B = 'model-b';

interface Seen {
  readonly auth: string;
  readonly model: string;
  readonly title: boolean;
}

const temporary: string[] = [];
let upstream: { baseUrl: string; seen: Seen[]; close(): Promise<void> } | undefined;
let running: RunningServe | undefined;

async function endpoint() {
  const seen: Seen[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        model: string;
        stream?: boolean;
        messages?: { role: string; content: unknown }[];
      };
      const first = body.messages?.[0];
      seen.push({
        auth: String(request.headers.authorization),
        model: body.model,
        title:
          first?.role === 'system' &&
          typeof first.content === 'string' &&
          first.content.startsWith('Create a concise title'),
      });
      const id = `chatcmpl-${String(seen.length)}`;
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
    seen,
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

/**
 * 一個 home、一個專案資料夾、一份指到假端點的 patch：`live-model` 的 `config` 整份取代（patch 是淺層覆寫），
 * 寫了 `apiKeyEnv`、兩顆模型 A 與 B（`models` 沒有給的話只有出廠那一顆）。
 */
function layout(options: { readonly apiKeyEnv?: string } = {}) {
  const base = scratch('nexus-api-key-env-');
  const home = join(base, 'home');
  const cwd = join(base, 'project');
  const root = join(base, 'log');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(cwd);
  mkdirSync(root);
  const entry = (id: string, extra: Record<string, unknown> = {}) => ({
    ...structuredClone(DEFAULT_LIVE_MODEL_ENTRY),
    id,
    ...extra,
  });
  const patch = join(base, 'patch.yml');
  // JSON 是合法的 YAML。
  writeFileSync(
    patch,
    JSON.stringify([
      {
        id: 'live-model',
        config: {
          baseUrl: upstream!.baseUrl,
          ...(options.apiKeyEnv !== undefined && { apiKeyEnv: options.apiKeyEnv }),
          retryPolicy: { mode: 'normal', maxRetries: 0 },
          modelId: A,
          models: [entry(A), entry(B, { reasoningEfforts: false })],
        },
      },
    ]),
  );
  return { home, cwd, root, patch, env: { [HARNESS_HOME_ENV]: home } };
}

function managedFile(home: string, name: string, value: string): string {
  const file = join(home, CREDENTIALS_FILE);
  writeFileSync(file, `version: 1\nrefs:\n  ${name}: ${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

async function serve(where: ReturnType<typeof layout>, lines: string[]): Promise<RunningServe> {
  return (await runServe({
    argv: ['--port', '0', '--live', '--session-log', where.root, '--patch', where.patch],
    log: bodyLog(lines),
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

/** 在一條 thread 上送一句，等標題請求出現（標題沒關的話它會跟著送）。 */
async function oneTurn(server: RunningServe, select?: string): Promise<void> {
  const client = await serveClient(server);
  const events = await client.openEvents('t');
  if (select !== undefined) await client.selectModel('t', { modelId: select });
  await client.runStart('t', '你好');
  await foldTurn(events);
  for (let tries = 0; tries < 400 && !upstream!.seen.some((entry) => entry.title); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await events.return?.(undefined);
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
  delete process.env[NAME];
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('apiKeyEnv 的值與形狀', () => {
  it('不寫就是 NVIDIA_API_KEY（出廠行為不變）', () => {
    expect(liveModelConfigSchema.parse({}).apiKeyEnv).toBe('NVIDIA_API_KEY');
    expect(LIVE_API_KEY_ENV).toBe('NVIDIA_API_KEY');
  });

  it.each([NAME, '_PRIVATE', 'key2', 'a'])('收環境變數形狀的名字：%s', (name) => {
    expect(liveModelConfigSchema.parse({ apiKeyEnv: name }).apiKeyEnv).toBe(name);
  });

  it.each([
    ['空字串', ''],
    ['含空白', 'MY KEY'],
    ['含 =', 'A=B'],
    ['數字開頭', '1KEY'],
    ['含連字號', 'MY-KEY'],
    ['含換行', 'A\nB'],
    ['不是字串', 5],
  ])('拒收：%s', (_label, value) => {
    expect(liveModelConfigSchema.safeParse({ apiKeyEnv: value }).success).toBe(false);
  });
});

describe('serve：金鑰名跟著設定走', () => {
  it('受管檔只有 GATEWAY_KEY、環境裡是誘餌 NVIDIA_API_KEY：端點收到的是 GATEWAY_KEY 那把；起動那一行講 GATEWAY_KEY', async () => {
    const where = layout({ apiKeyEnv: NAME });
    const file = managedFile(where.home, NAME, GATEWAY_VALUE);
    vi.stubEnv(LIVE_API_KEY_ENV, DECOY_VALUE);
    const lines: string[] = [];
    running = await serve(where, lines);
    await oneTurn(running);

    // 先證明設定載入、請求真的出去了（不然下面的斷言對著空集合也會過）。
    expect(upstream!.seen.length).toBeGreaterThan(0);
    expect(new Set(upstream!.seen.map((entry) => entry.auth))).toEqual(
      new Set([`Bearer ${GATEWAY_VALUE}`]),
    );
    expect(lines).toContain(`${NAME}：來自受管檔 ${file}`);
    for (const line of lines) {
      expect(line).not.toContain(LIVE_API_KEY_ENV);
      expect(line).not.toContain(GATEWAY_VALUE.slice(0, 6));
      expect(line).not.toContain(DECOY_VALUE.slice(0, 6));
    }
  }, 60000);

  it('換模型與標題：選第二顆送一句，主請求與標題請求帶的都是 GATEWAY_KEY 那把', async () => {
    const where = layout({ apiKeyEnv: NAME });
    managedFile(where.home, NAME, GATEWAY_VALUE);
    vi.stubEnv(LIVE_API_KEY_ENV, DECOY_VALUE);
    running = await serve(where, []);
    await oneTurn(running, B);

    // 走的是換過去的那顆、標題也在（標題沿用主請求走的模型，#723）。
    const main = upstream!.seen.filter((entry) => !entry.title);
    const title = upstream!.seen.filter((entry) => entry.title);
    expect(main.map((entry) => entry.model)).toEqual([B]);
    expect(title.map((entry) => entry.model)).toEqual([B]);
    for (const entry of [...main, ...title]) expect(entry.auth).toBe(`Bearer ${GATEWAY_VALUE}`);
  }, 60000);

  it('受管檔裡沒有 GATEWAY_KEY、只有 NVIDIA_API_KEY：起不來，訊息講 GATEWAY_KEY，不講 NVIDIA_API_KEY、不帶值', async () => {
    const where = layout({ apiKeyEnv: NAME });
    managedFile(where.home, LIVE_API_KEY_ENV, DECOY_VALUE);
    const failure = await serve(where, []).then(
      (started) => {
        running = started;
        return undefined;
      },
      (error: unknown) => error as Error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure!.message).toContain(`缺少環境變數 ${NAME}`);
    expect(failure!.message).not.toContain(LIVE_API_KEY_ENV);
    expect(failure!.message).not.toContain(DECOY_VALUE.slice(0, 6));
    expect(upstream!.seen).toEqual([]);
  }, 60000);

  it('GATEWAY_KEY 的值中間有換行：INVALID_CREDENTIAL，訊息指名 GATEWAY_KEY 與受管檔，不講 NVIDIA_API_KEY、不帶值', async () => {
    const where = layout({ apiKeyEnv: NAME });
    const file = managedFile(where.home, NAME, 'zq9bad-line1\nzq9bad-line2');
    const failure = await serve(where, []).then(
      (started) => {
        running = started;
        return undefined;
      },
      (error: unknown) => error as Error,
    );

    expect(failure?.name).toBe('InvalidCredentialError');
    expect(failure!.message).toContain(NAME);
    expect(failure!.message).toContain(file);
    expect(failure!.message).not.toContain(LIVE_API_KEY_ENV);
    expect(failure!.message).not.toContain('zq9bad');
    expect(upstream!.seen).toEqual([]);
  }, 60000);

  it('沒寫 apiKeyEnv：照舊是 NVIDIA_API_KEY（出廠行為不變），GATEWAY_KEY 放在受管檔裡也不被讀', async () => {
    const where = layout();
    const file = join(where.home, CREDENTIALS_FILE);
    writeFileSync(
      file,
      `version: 1\nrefs:\n  ${LIVE_API_KEY_ENV}: ${GATEWAY_VALUE}\n  ${NAME}: ${DECOY_VALUE}\n`,
      { mode: 0o600 },
    );
    chmodSync(file, 0o600);
    const lines: string[] = [];
    running = await serve(where, lines);
    await oneTurn(running);

    expect(upstream!.seen.length).toBeGreaterThan(0);
    expect(new Set(upstream!.seen.map((entry) => entry.auth))).toEqual(
      new Set([`Bearer ${GATEWAY_VALUE}`]),
    );
    expect(lines).toContain(`${LIVE_API_KEY_ENV}：來自受管檔 ${file}`);
  }, 60000);
});

describe('一次性入口：金鑰名跟著設定走', () => {
  it('啟動環境有 GATEWAY_KEY（誘餌 NVIDIA_API_KEY 也有）：端點收到 GATEWAY_KEY 那把；stderr 那一行講 GATEWAY_KEY 並寫明此入口不讀受管檔', async () => {
    const where = layout({ apiKeyEnv: NAME });
    vi.stubEnv(NAME, GATEWAY_VALUE);
    vi.stubEnv(LIVE_API_KEY_ENV, DECOY_VALUE);
    const errors: string[] = [];
    await cli(where, errors);

    expect(upstream!.seen.length).toBeGreaterThan(0);
    expect(new Set(upstream!.seen.map((entry) => entry.auth))).toEqual(
      new Set([`Bearer ${GATEWAY_VALUE}`]),
    );
    expect(errors).toContain(`${NAME}：來自啟動環境（此入口不讀受管檔）`);
    for (const line of errors) {
      expect(line).not.toContain(GATEWAY_VALUE.slice(0, 6));
      expect(line).not.toContain(DECOY_VALUE.slice(0, 6));
    }
  }, 60000);

  it('只有 NVIDIA_API_KEY、沒有 GATEWAY_KEY：失敗，訊息講 GATEWAY_KEY（此入口不讀受管檔那一種），不講 NVIDIA_API_KEY', async () => {
    const where = layout({ apiKeyEnv: NAME });
    managedFile(where.home, NAME, GATEWAY_VALUE);
    vi.stubEnv(LIVE_API_KEY_ENV, DECOY_VALUE);
    const failure = await cli(where, []).then(
      () => undefined,
      (error: unknown) => error as Error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure!.message).toContain(`缺少環境變數 ${NAME}`);
    expect(failure!.message).toContain('此入口不讀受管檔');
    expect(failure!.message).not.toContain(LIVE_API_KEY_ENV);
    expect(upstream!.seen).toEqual([]);
  }, 60000);
});

describe('背景子代理被指定模型時建的那一顆（`liveSubagentModelFor`，#876）', () => {
  it('憑證服務裡只有 GATEWAY_KEY：建得起來；只有預設名字那把就建不起來，訊息指名 GATEWAY_KEY', () => {
    const config = liveModelConfigSchema.parse({ apiKeyEnv: NAME });
    const choice = { model: DEFAULT_LIVE_MODEL_ID };
    expect(() =>
      liveSubagentModelFor(
        config,
        ambientCredentials({ [NAME]: GATEWAY_VALUE }),
        undefined,
      )(choice),
    ).not.toThrow();
    expect(() =>
      liveSubagentModelFor(
        config,
        ambientCredentials({ [LIVE_API_KEY_ENV]: DECOY_VALUE }),
        undefined,
      )(choice),
    ).toThrow(`缺少環境變數 ${NAME}`);
  });
});
