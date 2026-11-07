/**
 * 起一台給測試打的 serve：平常在測試行程裡（`runServe`）；設了 `NEXUS_E2E_PROCESS_MODEL=per-thread` 就照產品的樣子起
 * ——`serve.ts` 是子行程，`process-model` 那一列換成 per-thread，監督行程（`NEXUS_SUPERVISOR_BIN`）起前台與每條
 * thread 的對話行程，測試從前台的 port 打（[#2341](https://github.com/DemianLi/nexus-agent/issues/2341)）。
 *
 * per-thread 底下只有 {@link RunningServe} 的 `url`、`authenticatedUrl`、`close`；伺服器日誌照行交給 `log`。
 * 行程內的接縫（`createAgent`、`workspaceRootOf` 等 {@link RunServeOptions} 的測試鉤子）跨不了行程，給了就拋。
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runServe } from './serve.js';
import type { RunningServe, RunServeOptions } from './serve.js';

/** 這一輪跑哪一種：`per-thread` 要同時設 `NEXUS_SUPERVISOR_BIN`。 */
export const PROCESS_MODEL_UNDER_TEST: 'single' | 'per-thread' =
  process.env.NEXUS_E2E_PROCESS_MODEL === 'per-thread' ? 'per-thread' : 'single';

/** per-thread 底下 fixture 自己那一層 `--patch`（切 `process-model`）放在這個前綴的暫存目錄；日誌裡提到它的行是 fixture 的，不是產品的。 */
export const FIXTURE_PATCH_DIR_PREFIX = 'nexus-serve-under-test-';

const SERVE = fileURLToPath(new URL('./serve.ts', import.meta.url));
const AUTHENTICATED_URL = /http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/u;
/** 起動披露裡「探針：」那一行（`serve.ts` 的起動披露；它之後到 `runServe` 回傳之間沒有 await）。 */
const STARTUP_DISCLOSED = /(^| serve )探針：/u;
/** 跨得了行程的選項；其餘的是行程內的接縫。 */
const PORTABLE = new Set(['argv', 'cwd', 'log', 'env']);

/** per-thread 底下拿得到的那幾樣。 */
export type ServeUnderTest = Pick<RunningServe, 'url' | 'authenticatedUrl' | 'close'> &
  Partial<RunningServe>;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        resolve(typeof address === 'object' && address !== null ? address.port : 0),
      );
    });
  });
}

/** `--port 0` 換成一個空著的 port：子行程印的網址才對得上。 */
function withPort(argv: readonly string[], port: number): string[] {
  const out = [...argv];
  const at = out.indexOf('--port');
  if (at === -1) return [...out, '--port', String(port)];
  if (out[at + 1] === '0') out[at + 1] = String(port);
  return out;
}

async function startPerThread(options: RunServeOptions): Promise<ServeUnderTest | undefined> {
  const supervisor = process.env.NEXUS_SUPERVISOR_BIN;
  if (supervisor === undefined) throw new Error('per-thread 要設 NEXUS_SUPERVISOR_BIN');
  const seams = Object.keys(options).filter((key) => !PORTABLE.has(key));
  if (seams.length > 0) {
    throw new Error(`per-thread 底下跨不了行程的選項：${seams.join('、')}`);
  }
  const dir = await mkdtemp(join(tmpdir(), FIXTURE_PATCH_DIR_PREFIX));
  const patch = join(dir, 'process-model.patch.yml');
  await writeFile(
    patch,
    `- id: process-model\n  config:\n    mode: per-thread\n    supervisorBinary: ${supervisor}\n`,
    'utf8',
  );
  const port = await freePort();
  const argv = [...withPort(options.argv, port), '--patch', patch];
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), SERVE, ...argv], {
    cwd: options.cwd ?? process.cwd(),
    env: {
      PATH: process.env.PATH ?? '',
      // 家目錄同測試行程（`test-home.setup.ts` 換過的那個），同 `runServe` 在行程內讀到的。
      ...(process.env.HOME !== undefined && { HOME: process.env.HOME }),
      ...(process.env.TSX_TSCONFIG_PATH !== undefined && {
        TSX_TSCONFIG_PATH: process.env.TSX_TSCONFIG_PATH,
      }),
      ...options.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = options.log ?? (() => undefined);
  let pending = '';
  let all = '';
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  const authenticatedUrl = await new Promise<string | undefined>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`60 秒內沒起好：\n${all}`));
    }, 60_000);
    let found: string | undefined;
    let disclosed = false;
    let quiet: NodeJS.Timeout | undefined;
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      all += text;
      pending += text;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        log(line);
        found ??= AUTHENTICATED_URL.exec(line)?.[0];
        if (found !== undefined && STARTUP_DISCLOSED.test(line)) disclosed = true;
      }
      // 網址印在起動披露之前；`runServe` 是披露印完才回。等網址之後的「探針：」那一行（它之後到回傳都是同步印的），
      // 再等輸出靜下來，測試讀到的日誌才同 `runServe` 回傳那一刻。
      if (!disclosed || found === undefined) return;
      clearTimeout(quiet);
      const url = found;
      quiet = setTimeout(() => {
        clearTimeout(timer);
        resolve(url);
      }, 200);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    void exited.then((code) => {
      clearTimeout(timer);
      // `--help`、`--dump-config` 這類印完就走的：同 `runServe` 回 undefined；起不來的同 `runServe` 拋。
      if (code === 0) resolve(undefined);
      else reject(new Error(`serve 起不來（exit ${String(code)}）：\n${all}`));
    });
  });
  if (authenticatedUrl === undefined) {
    await rm(dir, { recursive: true, force: true });
    return undefined;
  }
  let closing: Promise<void> | undefined;
  return {
    url: new URL(authenticatedUrl).origin,
    authenticatedUrl,
    close: () =>
      (closing ??= (async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        await exited;
        if (pending !== '') log(pending);
        await rm(dir, { recursive: true, force: true });
      })()),
  };
}

/**
 * 同 `runServe`，照 {@link PROCESS_MODEL_UNDER_TEST} 起在測試行程裡或經監督行程。
 *
 * @returns 跑著的 serve；只印東西就走的旗標回 `undefined`。
 */
export async function startServeUnderTest(
  options: RunServeOptions,
): Promise<ServeUnderTest | undefined> {
  return PROCESS_MODEL_UNDER_TEST === 'per-thread' ? startPerThread(options) : runServe(options);
}
