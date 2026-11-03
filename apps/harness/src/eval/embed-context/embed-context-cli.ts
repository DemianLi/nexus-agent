/**
 * 畫面情境量測的進入點 —— `pnpm --filter @nexus/harness eval:embed-context`。
 * [#2367](https://github.com/DemianLi/nexus-agent/issues/2367)，地圖 #2365 第 8 點。
 *
 * 量嵌入的對話框附上「畫面上目前選取 X」之後，模型拿錯對象的比例。題目在 [`fixture.ts`](./fixture.ts)，判準在 [`rubric.ts`](./rubric.ts)。
 * 每題開一條新的 thread，經 `/embed` 前綴的 wire 送 `run.start` 帶 `context`，跟嵌入的頁面走同一條路。
 *
 * ## 上游與請求數
 *
 * serve 的 `live-model` 指到本機的計數轉接器（[`counting-proxy.ts`](./counting-proxy.ts)），轉接器再轉給 `--upstream`。
 * 到 `--max-requests` 或上游回了不是 200 就停，這支不再開新題。重試關成 0、模型產生的標題關掉，一題的請求數只來自這一輪本身。
 *
 * ## 金鑰
 *
 * serve 是子行程，`cwd` 是 `--serve-cwd`（金鑰在那一層的 `.env`，由 serve 自己讀）。這支行程的環境裡的 `*_API_KEY` 不傳給子行程，
 * 也不讀、不印；serve 印出的網址帶登入用的 token，只在記憶體裡用，不寫進輸出。
 *
 * 離線驗量具：`--upstream` 指本機的假端點，`--fake-key` 給子行程一把假的 key（上游不是 127.0.0.1 就拒絕這個旗標）。
 *
 * **不進 CI。** 會花錢也會花時間。
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createWireClient, EMBED_PATH_PREFIX } from '@nexus/wire';
import type { WireClient } from '@nexus/wire';
import { stringify } from 'yaml';

import { formatProportion, wilson } from '../citation/proportion.js';
import { exchangeServeToken, fetchWithCookie, foldTurn } from '../../fixtures.js';
import { shippedLiveModelConfig } from '../../log-derived-history.fixture.js';
import { startCountingProxy } from './counting-proxy.js';
import { CATEGORIES, QUESTIONS } from './fixture.js';
import type { Category, Question } from './fixture.js';
import { judge } from './rubric.js';
import type { Verdict } from './rubric.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS = join(HERE, '..', '..', '..');
const ROOT = join(HARNESS, '..', '..');

interface Options {
  readonly upstream: string;
  readonly maxRequests: number;
  readonly reps: number;
  readonly out: string;
  readonly serveCwd: string;
  readonly fakeKey: boolean;
  readonly timeoutMs: number;
}

function parseArgs(argv: readonly string[]): Options {
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

/** 一題一次，寫進 `runs.jsonl` 的一行。 */
export interface RunRecord {
  readonly id: string;
  readonly question: string;
  readonly category: Category;
  readonly rep: number;
  readonly answer: string;
  readonly askText: string;
  readonly toolCalls: readonly string[];
  readonly status: string;
  /** 這一題轉出去幾個請求。 */
  readonly requests: number;
  readonly durationMs: number;
  readonly verdict?: Verdict;
  readonly error?: string;
}

function patchOf(proxy: string): string {
  const shipped = shippedLiveModelConfig();
  const retryPolicy = { ...(shipped['retryPolicy'] as Record<string, unknown>), maxRetries: 0 };
  return `${stringify([{ id: 'live-model', config: { ...shipped, baseUrl: proxy, retryPolicy } }])}- id: thread-title-llm\n  disabled: true\n`;
}

interface Serve {
  readonly child: ChildProcess;
  readonly embed: WireClient;
}

async function startServe(options: Options, proxy: string): Promise<Serve> {
  const home = await mkdtemp('/var/tmp/nexus-embed-eval-home-');
  const ws = await mkdtemp('/var/tmp/nexus-embed-eval-ws-');
  const patch = join(home, 'eval.patch.yml');
  await writeFile(patch, patchOf(proxy));
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

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} 逾時（${String(ms)} ms）`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runOne(
  embed: WireClient,
  question: Question,
  rep: number,
  timeoutMs: number,
): Promise<Omit<RunRecord, 'requests' | 'durationMs'>> {
  const id = `${question.id}-r${String(rep)}`;
  const base = { id, question: question.id, category: question.category, rep };
  const thread = `embed-eval-${id}`;
  const events = await embed.openEvents(thread);
  try {
    const sent = await embed.runStart(thread, question.text, {
      context: { label: question.selected },
    });
    if ('error' in sent) throw new Error(`run.start 被拒：${JSON.stringify(sent)}`);
    // 停在核准卡或反問也會收尾（`foldTurn` 認 root 的 completed），不會等到逾時。
    const state = await withTimeout(foldTurn(events), timeoutMs, id);
    const tools = state.entries.filter((entry) => entry.kind === 'tool');
    if (state.status === 'failed') {
      return {
        ...base,
        answer: '',
        askText: '',
        toolCalls: tools.map((entry) => entry.name),
        status: 'failed',
        error: state.error ?? '這一輪失敗，沒有原因',
      };
    }
    const ai = [...state.entries].reverse().find((e) => e.kind === 'ai' && e.text.trim() !== '');
    const ask = tools.find((entry) => entry.name === 'ask_user_question');
    return {
      ...base,
      answer: ai?.kind === 'ai' ? ai.text : '',
      askText: ask === undefined ? '' : ask.input,
      toolCalls: tools.map((entry) => entry.name),
      status: state.status,
    };
  } finally {
    await events.return?.(undefined);
  }
}

/** 每一類的 `wrong` 比例（主指標）與 `miss` 數。執行失敗的不進分母，另列。 */
export function renderSummary(records: readonly RunRecord[]): string {
  const lines = [
    '| 類 | 判了幾次 | 拿錯對象 | 沒照規則（miss） | 失敗 |',
    '| --- | --- | --- | --- | --- |',
  ];
  const judged = records.filter((record) => record.error === undefined);
  for (const category of [...CATEGORIES, 'all'] as const) {
    const rows = judged.filter((record) => category === 'all' || record.category === category);
    const failed = records.filter(
      (record) =>
        record.error !== undefined && (category === 'all' || record.category === category),
    ).length;
    const wrong = rows.filter((record) => record.verdict === 'wrong').length;
    const miss = rows.filter((record) => record.verdict === 'miss').length;
    lines.push(
      `| ${category} | ${String(rows.length)} | ${formatProportion(wilson(wrong, rows.length))} | ${String(miss)} | ${String(failed)} |`,
    );
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--summarize')) {
    const path = argv[argv.indexOf('--summarize') + 1] ?? '';
    const records = (await readFile(path, 'utf8'))
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as RunRecord);
    console.log(renderSummary(records));
    return;
  }
  const options = parseArgs(argv);
  await mkdir(options.out, { recursive: true });
  // session-file-exempt: 畫面情境量測每次執行的結果紀錄，不是會話日誌。
  const runsFile = join(options.out, 'runs.jsonl');
  await writeFile(runsFile, '');
  const proxy = await startCountingProxy(options.upstream, options.maxRequests);
  const serve = await startServe(options, proxy.baseUrl);
  const records: RunRecord[] = [];
  try {
    for (let rep = 1; rep <= options.reps; rep += 1) {
      for (const question of QUESTIONS) {
        if (proxy.stopped() !== undefined) break;
        const before = proxy.count();
        const started = Date.now();
        let record: RunRecord;
        try {
          const observed = await runOne(serve.embed, question, rep, options.timeoutMs);
          record = {
            ...observed,
            requests: proxy.count() - before,
            durationMs: Date.now() - started,
            ...(observed.error === undefined && { verdict: judge(question, observed) }),
          };
        } catch (error) {
          record = {
            id: `${question.id}-r${String(rep)}`,
            question: question.id,
            category: question.category,
            rep,
            answer: '',
            askText: '',
            toolCalls: [],
            status: 'run-failed',
            requests: proxy.count() - before,
            durationMs: Date.now() - started,
            error: error instanceof Error ? error.message : String(error),
          };
        }
        records.push(record);
        await appendFile(runsFile, `${JSON.stringify(record)}\n`);
        console.log(
          `${record.id} ${record.verdict ?? `失敗：${record.error ?? ''}`}（請求 ${String(record.requests)}，累計 ${String(proxy.count())}）`,
        );
      }
    }
  } finally {
    serve.child.kill('SIGTERM');
    await proxy.close();
  }
  const summary = [
    renderSummary(records),
    '',
    `請求共 ${String(proxy.count())} 個（上限 ${String(options.maxRequests)}）。${proxy.stopped() === undefined ? '' : `轉接器停下：${proxy.stopped() ?? ''}`}`,
  ].join('\n');
  await writeFile(join(options.out, 'summary.md'), `${summary}\n`);
  console.log(`\n${summary}`);
}

await main();
process.exit(0);
