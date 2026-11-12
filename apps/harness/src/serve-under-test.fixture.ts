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

import { expect, onTestFailed, onTestFinished } from 'vitest';

import { runServe } from './serve-run.js';
import type { RunningServe, RunServeOptions } from './serve-run.js';

/** 這一輪跑哪一種：`per-thread` 要同時設 `NEXUS_SUPERVISOR_BIN`。 */
export const PROCESS_MODEL_UNDER_TEST: 'single' | 'per-thread' =
  process.env.NEXUS_E2E_PROCESS_MODEL === 'per-thread' ? 'per-thread' : 'single';

/** per-thread 底下 fixture 自己那一層 `--patch`（切 `process-model`）放在這個前綴的暫存目錄；日誌裡提到它的行是 fixture 的，不是產品的。 */
export const FIXTURE_PATCH_DIR_PREFIX = 'nexus-serve-under-test-';

const SERVE = fileURLToPath(new URL('./serve.ts', import.meta.url));
const AUTHENTICATED_URL = /http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/u;
/** 起動披露裡「探針：」那一行（`serve-run.ts` 的起動披露；它之後到 `runServe` 回傳之間沒有 await）。 */
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
 * 一支 `it` 裡 fixture 看得到的幾步（起 serve、收 serve）各花了多久。
 *
 * CI 上 serve 測試偶爾貼著 5 秒逾時線紅（[#2695](https://github.com/DemianLi/nexus-agent/issues/2695)），vitest 只在測試結束時印
 * 一行名稱與總耗時，看不出逾時當下停在哪一步。這裡只記時間，不改任何等待；`it` 失敗或逾時時才印（見
 * {@link startServeUnderTest}），平常的日誌不多一行。
 * 時間從這支 `it` 第一次呼叫 fixture 起算，所以 `it` 自己在 fixture 之外花的時間（`driveTurn`、改名、列表）不在其中。
 */
export class StepLaps {
  readonly #now: () => number;
  readonly #t0: number;
  readonly #events: string[] = [];
  readonly #open = new Map<number, { readonly step: string; readonly at: number }>();
  #next = 0;

  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
    this.#t0 = now();
  }

  /** 開始一步；回傳的函式在這一步回來（含拋出）時叫。 */
  begin(step: string): () => void {
    const id = this.#next++;
    const at = this.#now() - this.#t0;
    this.#open.set(id, { step, at });
    this.#events.push(`${step} 開始 +${String(Math.round(at))}`);
    return () => {
      this.#open.delete(id);
      this.#events.push(`${step} 回來 +${String(Math.round(this.#now() - this.#t0))}`);
    };
  }

  /** 步驟名與毫秒數；還沒回來的步驟另列，標出它已經等了多久。 */
  render(): string {
    const now = this.#now() - this.#t0;
    const pending = [...this.#open.values()].map(
      ({ step, at }) => `${step}（開始後已 ${String(Math.round(now - at))} ms 沒回來）`,
    );
    return [
      `serve 步驟耗時（毫秒，自這支測試第一次呼叫 fixture 起算；現在 +${String(Math.round(now))}）：${this.#events.join('、')}`,
      ...(pending.length > 0 ? [`還沒回來：${pending.join('、')}`] : []),
    ].join('\n');
  }
}

const lapsByTest = new Map<string, StepLaps>();

/** 目前這支 `it` 的計時；不在 `it` 裡（`beforeAll` 之類）就不記。 */
function lapsOfCurrentTest(): StepLaps | undefined {
  const name = expect.getState().currentTestName;
  if (name === undefined) return undefined;
  const known = lapsByTest.get(name);
  if (known !== undefined) return known;
  const laps = new StepLaps();
  try {
    onTestFailed(() => {
      console.error(laps.render());
    });
    onTestFinished(() => {
      lapsByTest.delete(name);
    });
  } catch {
    return undefined;
  }
  lapsByTest.set(name, laps);
  return laps;
}

/**
 * 同 `runServe`，照 {@link PROCESS_MODEL_UNDER_TEST} 起在測試行程裡或經監督行程。
 *
 * 在 `it` 裡呼叫時順手記起、收兩步的耗時（{@link StepLaps}），那支 `it` 失敗或逾時才印；回傳的物件行為不變。
 *
 * @returns 跑著的 serve；只印東西就走的旗標回 `undefined`。
 */
export async function startServeUnderTest(
  options: RunServeOptions,
): Promise<ServeUnderTest | undefined> {
  const laps = lapsOfCurrentTest();
  const done = laps?.begin('start');
  let server: ServeUnderTest | undefined;
  try {
    server =
      PROCESS_MODEL_UNDER_TEST === 'per-thread'
        ? await startPerThread(options)
        : await runServe(options);
  } finally {
    done?.();
  }
  if (laps === undefined || server === undefined) return server;
  const timedClose = async (...args: Parameters<ServeUnderTest['close']>): Promise<void> => {
    const closed = laps.begin('close');
    try {
      await server.close(...args);
    } finally {
      closed();
    }
  };
  return new Proxy(server, {
    get: (target, key) => (key === 'close' ? timedClose : Reflect.get(target, key, target)),
  });
}
