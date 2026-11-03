/**
 * 宿主頁工具量測的進入點 —— `pnpm --filter @nexus/harness eval:host-tools`。
 * [#2398](https://github.com/DemianLi/nexus-agent/issues/2398)，設計 `.docs/host-page-tools-2374-design-2026-11-03.md` Q8。
 *
 * 量嵌入的對話框宣告宿主頁工具之後，模型叫錯工具或叫錯對象的比例。題目在 [`fixture.ts`](./fixture.ts)，判準在 [`rubric.ts`](./rubric.ts)。
 * 每題開一條新的 thread，經 `/embed` 前綴的 wire 送 `run.start` 帶 `context` 與 `hostTools`，這支扮宿主頁：收到宿主頁工具的
 * `input.requested` 就記下呼叫、用 `input.respond` 交回成功的結果，等這一輪收尾。
 *
 * serve 的 `host-tools` 列把兩支工具列進免核准名單：這裡量的是叫不叫得對，核准卡會讓這一輪停在叫之前。
 *
 * 上游、請求數上限、金鑰與離線驗量具的做法見 [`../embed-serve.ts`](../embed-serve.ts)。
 *
 * 輸出在 `--out` 底下：`runs.jsonl`（一題一次一行，見 {@link RunRecord}）、`summary.md`（{@link renderSummary}）、`requests.jsonl`（轉接器記下的每個請求）。
 *
 * **不進 CI。** 會花錢也會花時間。
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { emptyConversation, reduceConversation } from '@nexus/wire';
import type { ConversationState, Event, WireClient } from '@nexus/wire';

import { formatProportion, wilson } from '../citation/proportion.js';
import { startCountingProxy } from '../../smoke/counting-proxy.js';
import {
  parseEmbedEvalArgs,
  requestLines,
  startEmbedServe,
  stoppedBy,
  withTimeout,
} from '../embed-serve.js';
import { CATEGORIES, HOST_TOOLS, QUESTIONS } from './fixture.js';
import type { Category, Question } from './fixture.js';
import { judge, leaksOf } from './rubric.js';
import type { HostCall, Leak, Verdict } from './rubric.js';

/** 一題一次，寫進 `runs.jsonl` 的一行。 */
export interface RunRecord {
  readonly id: string;
  readonly question: string;
  readonly category: Category;
  readonly rep: number;
  /** 宿主頁收到的呼叫，依收到的順序。 */
  readonly calls: readonly HostCall[];
  readonly answer: string;
  /** 這一輪的工具列，含宿主頁工具（`page__` 開頭）以外的。 */
  readonly toolCalls: readonly string[];
  readonly status: string;
  /** 這一題轉出去幾個請求。 */
  readonly requests: number;
  readonly durationMs: number;
  readonly verdict?: Verdict;
  readonly leaks?: readonly Leak[];
  readonly error?: string;
}

/** 宿主頁交回的結果：照實說做了什麼。 */
function hostResult(call: HostCall): { readonly ok: true; readonly result: unknown } {
  return { ok: true, result: { done: call.name, id: call.args['id'] ?? null } };
}

/** root 的 `lifecycle` 事件名（`running`、`completed`、`failed`）；不是 root 的 `lifecycle` 就是 `undefined`。 */
function rootLifecycle(event: Event): unknown {
  const data = event.params.data as { event?: unknown; graph_name?: unknown } | null;
  return event.method === 'lifecycle' &&
    event.params.namespace.length === 0 &&
    data?.graph_name === 'root'
    ? data.event
    : undefined;
}

/**
 * 折一輪到 root 收尾；途中每一顆新的宿主頁工具呼叫都記下、交回成功的結果。
 *
 * 停在宿主頁工具時 root 照樣發 `completed`，交回結果之後才再發 `running` 接著跑。所以交回之後、看到下一顆 `running` 之前的收尾不算。
 * 依賴同一次停下的 `input.requested` 比 root 的 `completed` 先到（真 serve 上逐顆印出來是這個順序）。
 *
 * @returns 收尾時的狀態與宿主頁收到的呼叫。
 */
async function playHost(
  embed: WireClient,
  thread: string,
  events: AsyncIterator<Event>,
): Promise<{ readonly state: ConversationState; readonly calls: HostCall[] }> {
  let state = emptyConversation();
  const calls: HostCall[] = [];
  const answered = new Set<string>();
  let resumed = true;
  for (;;) {
    const next = await events.next();
    if (next.done === true) throw new Error('下行在 root 收尾之前就斷了');
    state = reduceConversation(state, next.value);
    for (const pending of state.hostCalls) {
      if (answered.has(pending.interruptId)) continue;
      answered.add(pending.interruptId);
      const call: HostCall = { name: pending.name, args: pending.args };
      calls.push(call);
      const reply = await embed.inputRespond(thread, {
        namespace: [...pending.namespace],
        interrupt_id: pending.interruptId,
        response: hostResult(call),
      });
      if ('error' in reply) throw new Error(`input.respond 被拒：${JSON.stringify(reply)}`);
      resumed = false;
    }
    const lifecycle = rootLifecycle(next.value);
    if (lifecycle === 'running') resumed = true;
    if (lifecycle === 'failed' || (lifecycle === 'completed' && resumed)) return { state, calls };
  }
}

async function runOne(
  embed: WireClient,
  question: Question,
  rep: number,
  timeoutMs: number,
): Promise<Omit<RunRecord, 'requests' | 'durationMs'>> {
  const id = `${question.id}-r${String(rep)}`;
  const base = { id, question: question.id, category: question.category, rep };
  const thread = `host-tools-eval-${id}`;
  const events = await embed.openEvents(thread);
  try {
    const sent = await embed.runStart(thread, question.text, {
      context: { label: question.selected },
      hostTools: HOST_TOOLS,
    });
    if ('error' in sent) throw new Error(`run.start 被拒：${JSON.stringify(sent)}`);
    const { state, calls } = await withTimeout(playHost(embed, thread, events), timeoutMs, id);
    const toolCalls = state.entries.flatMap((entry) => (entry.kind === 'tool' ? [entry.name] : []));
    if (state.status === 'failed') {
      return {
        ...base,
        calls,
        answer: '',
        toolCalls,
        status: 'failed',
        error: state.error ?? '這一輪失敗，沒有原因',
      };
    }
    const ai = [...state.entries].reverse().find((e) => e.kind === 'ai' && e.text.trim() !== '');
    return {
      ...base,
      calls,
      answer: ai?.kind === 'ai' ? ai.text : '',
      toolCalls,
      status: state.status,
    };
  } finally {
    await events.return?.(undefined);
  }
}

/** 每一類的 `ok` 比例、`wrong` 比例（主指標）、`miss` 數與兩種外露的次數。執行失敗的不進分母，另列。 */
export function renderSummary(records: readonly RunRecord[]): string {
  const lines = [
    '| 類 | 判了幾次 | 叫對（ok） | 叫錯（wrong） | 沒叫齊（miss） | 照抄固定的字 | 講出工具名 | 失敗 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  const judged = records.filter((record) => record.error === undefined);
  for (const category of [...CATEGORIES, 'all'] as const) {
    const rows = judged.filter((record) => category === 'all' || record.category === category);
    const failed = records.filter(
      (record) =>
        record.error !== undefined && (category === 'all' || record.category === category),
    ).length;
    const count = (verdict: Verdict) => rows.filter((record) => record.verdict === verdict).length;
    const leaked = (leak: Leak) => rows.filter((record) => record.leaks?.includes(leak)).length;
    lines.push(
      `| ${category} | ${String(rows.length)} | ${formatProportion(wilson(count('ok'), rows.length))} | ${formatProportion(wilson(count('wrong'), rows.length))} | ${String(count('miss'))} | ${String(leaked('wording'))} | ${String(leaked('tool-name'))} | ${String(failed)} |`,
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

/** serve 的 `host-tools` 列：兩支工具都免核准。 */
const EXEMPT_ROW = `- id: host-tools\n  config: ${JSON.stringify({
  approval: { exempt: HOST_TOOLS.map((tool) => tool.name) },
})}\n`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--summarize')) {
    console.log(renderSummary(await readRecords(argv[argv.indexOf('--summarize') + 1] ?? '')));
    return;
  }
  const options = parseEmbedEvalArgs(argv);
  await mkdir(options.out, { recursive: true });
  // session-file-exempt: 宿主頁工具量測每次執行的結果紀錄，不是會話日誌。
  const runsFile = join(options.out, 'runs.jsonl');
  await writeFile(runsFile, '');
  const proxy = await startCountingProxy({ upstream: options.upstream, cap: options.maxRequests });
  const serve = await startEmbedServe(options, proxy.baseUrl, EXEMPT_ROW);
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
            calls: [],
            answer: '',
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
  // session-file-exempt: 轉接器記下的每個請求（欄位見 `ProxiedRequest`），依記錄順序；核對請求數與哪一個不是 200 用，不是會話日誌。
  await writeFile(join(options.out, 'requests.jsonl'), requestLines(proxy));
  console.log(`\n${summary}`);
}

await main();
process.exit(0);
