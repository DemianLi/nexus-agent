/**
 * 嵌入版量測共用的量具：參數、起 serve、計數轉接器的停點。畫面情境（[`embed-context/`](./embed-context/embed-context-cli.ts)）與
 * 宿主頁工具（[`host-tools/`](./host-tools/host-tools-cli.ts)）兩支量測都用這一份。
 *
 * ## 上游與請求數
 *
 * serve 的 `live-model` 指到本機的計數轉接器（[`smoke/counting-proxy.ts`](../smoke/counting-proxy.ts)），轉接器再轉給 `--upstream`。
 * 轉接器到 `--max-requests` 就不再轉出去；有任何一個請求不是 200，量測就不再開新題（{@link stoppedBy}）。重試關成 0、模型產生的標題關掉，
 * 一題的請求數只來自這一輪本身。
 *
 * ## 金鑰
 *
 * serve 是子行程，`cwd` 是 `--serve-cwd`（金鑰在那一層的 `.env`，由 serve 自己讀）。量測行程（呼叫 {@link startEmbedServe} 的那一支）環境裡的 `*_API_KEY` 不傳給子行程，
 * 也不讀、不印；serve 印出的網址帶登入用的 token，只在記憶體裡用，不寫進輸出。
 *
 * 離線驗量具：`--upstream` 指本機的假端點，`--fake-key` 給子行程一把假的 key（上游不是 127.0.0.1 就拒絕這個旗標）。
 *
 * @module
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createWireClient, EMBED_PATH_PREFIX } from '@nexus/wire';
import type { WireClient } from '@nexus/wire';
import { stringify } from 'yaml';

import { exchangeServeToken, fetchWithCookie } from '../fixtures.js';
import { shippedLiveModelConfig } from '../log-derived-history.fixture.js';
import type { CountingProxy } from '../smoke/counting-proxy.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS = join(HERE, '..', '..');
const ROOT = join(HARNESS, '..', '..');

/** 量測的命令列參數。`timeoutMs` 是每一題的期限。 */
export interface EmbedEvalOptions {
  readonly upstream: string;
  readonly maxRequests: number;
  readonly reps: number;
  readonly out: string;
  readonly serveCwd: string;
  readonly fakeKey: boolean;
  readonly timeoutMs: number;
}

/**
 * 解析量測的命令列參數。缺必填的旗標、值不是正整數，或 `--fake-key` 配上不是 127.0.0.1 的 `--upstream`，都拋；`--reps` 預設 1，
 * `--timeout-ms` 預設 300000。
 */
export function parseEmbedEvalArgs(argv: readonly string[]): EmbedEvalOptions {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const need = (flag: string): string => {
    const value = get(flag);
    if (value === undefined) throw new Error(`需要 ${flag}`);
    return value;
  };
  const positive = (flag: string, fallback?: number): number => {
    const raw = get(flag);
    if (raw === undefined) {
      if (fallback === undefined) throw new Error(`需要 ${flag}`);
      return fallback;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) throw new Error(`${flag} 要正整數，拿到 ${raw}`);
    return value;
  };
  const upstream = need('--upstream');
  const fakeKey = argv.includes('--fake-key');
  if (fakeKey && new URL(upstream).hostname !== '127.0.0.1') {
    throw new Error('--fake-key 只能配本機的 --upstream：假 key 也會被送出去');
  }
  return {
    upstream,
    maxRequests: positive('--max-requests'),
    reps: positive('--reps', 1),
    out: need('--out'),
    serveCwd: need('--serve-cwd'),
    fakeKey,
    timeoutMs: positive('--timeout-ms', 300_000),
  };
}

/** `--patch` 的內容：`live-model` 指到轉接器、重試 0、關掉模型產生的標題，再接上 `extraRows`。 */
function patchOf(proxy: string, extraRows: string): string {
  const shipped = shippedLiveModelConfig();
  const retryPolicy = { ...(shipped['retryPolicy'] as Record<string, unknown>), maxRetries: 0 };
  return `${stringify([{ id: 'live-model', config: { ...shipped, baseUrl: proxy, retryPolicy } }])}- id: thread-title-llm\n  disabled: true\n${extraRows}`;
}

export interface EmbedServe {
  readonly child: ChildProcess;
  /** 走 `/embed` 前綴的 wire 客戶端，跟嵌入的頁面同一條路。 */
  readonly embed: WireClient;
}

/**
 * 起一個 `--live` 的 serve，home 與工作區都是 `/var/tmp` 底下新的暫存目錄，這裡不清。回傳的 `child` 由呼叫方收掉。
 * serve 還沒印出網址就結束時 reject，錯誤訊息裡的 token 已遮掉。
 *
 * @param extraRows - 接在 patch 後面的列（YAML 文字，每列以換行結尾）。
 */
export async function startEmbedServe(
  options: EmbedEvalOptions,
  proxy: string,
  extraRows = '',
): Promise<EmbedServe> {
  const home = await mkdtemp('/var/tmp/nexus-embed-eval-home-');
  const ws = await mkdtemp('/var/tmp/nexus-embed-eval-ws-');
  const patch = join(home, 'eval.patch.yml');
  await writeFile(patch, patchOf(proxy, extraRows));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'],
    LANG: process.env['LANG'] ?? 'C.UTF-8',
    HOME: home,
    NEXUS_AGENT_HOME: home,
    ...(options.fakeKey && { NVIDIA_API_KEY: 'fake-local-test' }),
  };
  const child = spawn(
    join(HARNESS, 'node_modules', '.bin', 'tsx'),
    [
      '--tsconfig',
      join(ROOT, 'tsconfig.runtime.json'),
      join(HARNESS, 'src', 'serve.ts'),
      '--live',
      '--port',
      '0',
      '--workspace',
      ws,
      '--patch',
      patch,
    ],
    { cwd: options.serveCwd, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const authenticated = await new Promise<string>((resolve, reject) => {
    let seen = '';
    const onData = (chunk: Buffer): void => {
      seen += chunk.toString();
      const match = /nexus-agent 在 (http\S+)/u.exec(seen);
      if (match?.[1] !== undefined) resolve(match[1]);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('exit', (code) => {
      // 輸出可能帶網址上的 token：只印最後幾行、遮掉 token。
      const tail = seen
        .split('\n')
        .slice(-15)
        .join('\n')
        .replace(/token=\S+/gu, 'token=…');
      reject(new Error(`serve 沒起來就結束了（${String(code)}）：\n${tail}`));
    });
  });
  const cookie = await exchangeServeToken(authenticated);
  const origin = new URL(authenticated).origin;
  return {
    child,
    embed: createWireClient({
      baseUrl: `${origin}${EMBED_PATH_PREFIX}`,
      fetch: fetchWithCookie(cookie),
    }),
  };
}

/** `promise` 過了 `ms` 還沒結束就 reject。只是不再等，不會取消 `promise` 本身。 */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} 逾時（${String(ms)} ms）`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** 轉接器看到不是 200 的請求（含超過上限被擋下的 429）：回第一個的描述，沒有就是 `undefined`。 */
export function stoppedBy(proxy: CountingProxy): string | undefined {
  const bad = proxy.requests().find((request) => request.status !== 200);
  if (bad === undefined) return undefined;
  return bad.blocked ? '到請求上限' : `上游回 ${String(bad.status)}`;
}

/** 轉接器記下的每個請求，一行一筆 JSON（欄位見 `ProxiedRequest`），依記錄順序。 */
export function requestLines(proxy: CountingProxy): string {
  return proxy
    .requests()
    .map((request) => `${JSON.stringify(request)}\n`)
    .join('');
}
