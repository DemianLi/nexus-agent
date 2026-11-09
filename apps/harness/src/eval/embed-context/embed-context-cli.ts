/**
 * 畫面情境量測的進入點 —— `pnpm --filter @nexus/harness eval:embed-context`。
 * [#2367](https://github.com/DemianLi/nexus-agent/issues/2367)，地圖 #2365 第 8 點。
 *
 * 量嵌入的對話框附上「畫面上目前選取 X」之後，模型拿錯對象的比例。題目在 [`fixture.ts`](./fixture.ts)，判準在 [`rubric.ts`](./rubric.ts)。
 * 每題開一條新的 thread，經 `/embed` 前綴的 wire 送 `run.start` 帶 `context`，跟嵌入的頁面走同一條路。
 *
 * 上游、請求數上限、金鑰與離線驗量具的做法見 [`../embed-serve.ts`](../embed-serve.ts)。
 *
 * 輸出在 `--out` 底下：`runs.jsonl`（一題一次一行，見 {@link RunRecord}）、`summary.md`（{@link renderSummary}）、`requests.jsonl`（轉接器記下的每個請求）。
 *
 * 離線重判：`--rejudge <runs.jsonl>` 拿今天的判準重判一份舊紀錄、列出判決變了的與有外露的題，不起 serve、不打端點（#2380）。
 *
 * **不進 CI。** 會花錢也會花時間。
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { WireClient } from '@nexus/wire';

import { formatProportion, wilson } from '../citation/proportion.js';
import { foldTurn } from '../../fixtures.js';
import { startCountingProxy } from '../../smoke/counting-proxy.js';
import {
  parseEmbedEvalArgs,
  requestLines,
  startEmbedServe,
  stoppedBy,
  withTimeout,
} from '../embed-serve.js';
import { CATEGORIES, QUESTIONS } from './fixture.js';
import type { Category, Question } from './fixture.js';
import { judge, leaksOf } from './rubric.js';
import type { Leak, Verdict } from './rubric.js';

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
  /** 回答讓使用者看到的情境區塊內容（#2380）；執行失敗的紀錄沒有這一格，#2380 之前寫的 runs.jsonl 也沒有。 */
  readonly leaks?: readonly Leak[];
  readonly error?: string;
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

/** 每一類的 `wrong` 比例（主指標）、`miss` 數與兩種外露的次數。執行失敗的不進分母，另列。 */
export function renderSummary(records: readonly RunRecord[]): string {
  const lines = [
    '| 類 | 判了幾次 | 拿錯對象 | 沒照規則（miss） | 照抄原文 | 講出規則 | 失敗 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
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
    const leaked = (leak: Leak) => rows.filter((record) => record.leaks?.includes(leak)).length;
    lines.push(
      `| ${category} | ${String(rows.length)} | ${formatProportion(wilson(wrong, rows.length))} | ${String(miss)} | ${String(leaked('verbatim'))} | ${String(leaked('rules'))} | ${String(failed)} |`,
    );
  }
  return lines.join('\n');
}

async function readRecords(path: string): Promise<RunRecord[]> {
  return (await readFile(path, 'utf8'))
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as RunRecord);
}

/**
 * 拿今天的判準重判一份 `runs.jsonl`（#2380）：不打端點。執行失敗的照舊不判。
 *
 * @returns 重判後的紀錄，與判決變了的那幾題（原判 → 新判）。
 */
function rejudge(records: readonly RunRecord[]): {
  readonly records: RunRecord[];
  readonly changed: string[];
} {
  const changed: string[] = [];
  const rejudged = records.map((record) => {
    if (record.error !== undefined) return record;
    const question = QUESTIONS.find((candidate) => candidate.id === record.question);
    if (question === undefined)
      throw new Error(`紀錄 ${record.id} 的題目 ${record.question} 不在題庫裡`);
    const verdict = judge(question, record);
    if (verdict !== record.verdict) {
      changed.push(`${record.id}：${record.verdict ?? '（沒判）'} → ${verdict}`);
    }
    return { ...record, verdict, leaks: leaksOf(record.answer) };
  });
  return { records: rejudged, changed };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--summarize')) {
    console.log(renderSummary(await readRecords(argv[argv.indexOf('--summarize') + 1] ?? '')));
    return;
  }
  if (argv.includes('--rejudge')) {
    const { records, changed } = rejudge(
      await readRecords(argv[argv.indexOf('--rejudge') + 1] ?? ''),
    );
    console.log(renderSummary(records));
    console.log(`\n判決變了的 ${String(changed.length)} 題：`);
    for (const line of changed) console.log(`- ${line}`);
    const leaked = records.filter((record) => (record.leaks ?? []).length > 0);
    console.log(`\n有外露的 ${String(leaked.length)} 題：`);
    for (const record of leaked) console.log(`- ${record.id}：${(record.leaks ?? []).join('、')}`);
    return;
  }
  const options = parseEmbedEvalArgs(argv);
  await mkdir(options.out, { recursive: true });
  // session-file-exempt: 畫面情境量測每次執行的結果紀錄，不是會話日誌。
  const runsFile = join(options.out, 'runs.jsonl');
  await writeFile(runsFile, '');
  const proxy = await startCountingProxy({ upstream: options.upstream, cap: options.maxRequests });
  const serve = await startEmbedServe(options, proxy.baseUrl);
  const records: RunRecord[] = [];
  try {
    for (let rep = 1; rep <= options.reps; rep += 1) {
      for (const question of QUESTIONS) {
        if (stoppedBy(proxy) !== undefined) break;
        const before = proxy.forwardedPosts();
        const started = Date.now();
        let record: RunRecord;
        try {
          const observed = await runOne(serve.embed, question, rep, options.timeoutMs);
          record = {
            ...observed,
            requests: proxy.forwardedPosts() - before,
            durationMs: Date.now() - started,
            ...(observed.error === undefined && {
              verdict: judge(question, observed),
              leaks: leaksOf(observed.answer),
            }),
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
            requests: proxy.forwardedPosts() - before,
            durationMs: Date.now() - started,
            error: error instanceof Error ? error.message : String(error),
          };
        }
        records.push(record);
        await appendFile(runsFile, `${JSON.stringify(record)}\n`);
        console.log(
          `${record.id} ${record.verdict ?? `失敗：${record.error ?? ''}`}（請求 ${String(record.requests)}，累計 ${String(proxy.forwardedPosts())}）`,
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
    `請求共 ${String(proxy.forwardedPosts())} 個（上限 ${String(options.maxRequests)}）。${stoppedBy(proxy) === undefined ? '' : `停下：${stoppedBy(proxy) ?? ''}`}`,
  ].join('\n');
  await writeFile(join(options.out, 'summary.md'), `${summary}\n`);
  // session-file-exempt: 轉接器記下的每個請求（欄位見 `ProxiedRequest`），依記錄順序；核對請求數與哪一個不是 200 用，不是會話日誌（#2380）。
  const requestsFile = join(options.out, 'requests.jsonl');
  await writeFile(requestsFile, requestLines(proxy));
  console.log(`\n${summary}`);
}

await main();
process.exit(0);
