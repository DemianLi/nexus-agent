/**
 * 出處量測的進入點 —— `pnpm --filter @nexus/harness eval:citation`。
 * [#1329](https://github.com/DemianLi/nexus-agent/issues/1329)。
 *
 * 量模型用 MCP 結果答題時的三個行為：說不說得出資料來自哪個系統、先反問還是直接答、從只有標題的連結編不編出內容。
 * 三組夾具（A 有正文、B 只有連結、C 查無資料）、四種中立問法，每組每問法跑 `--runs-per-question` 次。
 * 判準在 [`rubric.ts`](./rubric.ts)，夾具在 [`fixture.ts`](./fixture.ts)。**只量測，不改任何提示詞與 persona。**
 *
 * ## 為什麼不走 `../runner.ts`
 *
 * eval 框架的 `runBenchmarkCase` 用 `createNexusAgent` 加一份指定的 plugin 清單，沒有 persona、沒有 `ask_user_question`、
 * 沒有產品的工具組，也沒有「停在 awaiting-input」這個結果；它的區間以題目為單位（見 [`proportion.ts`](./proportion.ts)）。
 * 這次要量的是**產品組裝**下模型的行為（#1319 的三個訊號都是在 `serve --live` 底下看到的），所以這裡直接起一台
 * `runServe`，每組夾具一台、同一個 live 模型，經 wire 說話，同 #1319 的實跑。
 *
 * **不進 CI。** 需要環境裡有 `NVIDIA_API_KEY`（`set -a; source <主 checkout>/.env; set +a`），會花錢也會花時間。
 * key 只從環境來，不寫進任何檔案；輸出裡沒有 key。**開跑前先用 `--runs-per-question 1` 冒煙。**
 */

import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveClient, foldTurn } from '../../fixtures.js';
import { runServe } from '../../serve.js';
import { packBlind, unpackLabels } from './blind.js';
import type { BlindKey } from './blind.js';
import { GROUPS, MODE_ENV, QUESTIONS, SERVER_NAME } from './fixture.js';
import type { Group } from './fixture.js';
import { disagreements, renderByQuestion, renderSummary } from './report.js';
import type { Label, Labels, RunRecord } from './report.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_FILE = join(HERE, 'fixture-server.ts');
const HARNESS_DIR = join(HERE, '..', '..', '..');

interface Options {
  readonly runsPerQuestion: number;
  readonly groups: readonly Group[];
  readonly out: string;
  readonly concurrency: number;
  readonly timeoutMs: number;
  /** 讀 `--out` 裡已有的 `runs.jsonl`，已經有記錄的 id（含失敗的）不重跑——行程中途被收掉時接著跑。 */
  readonly resume: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const out = get('--out');
  if (out === undefined)
    throw new Error('需要 --out <目錄>：原始答案與彙總寫在那裡（放在版控之外）');
  const groups = (get('--groups') ?? 'A,B,C').split(',').map((g) => g.trim());
  for (const group of groups) {
    if (!(GROUPS as readonly string[]).includes(group))
      throw new Error(`--groups 只認 A、B、C，拿到 ${group}`);
  }
  const positive = (flag: string, fallback: number): number => {
    const raw = get(flag);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) throw new Error(`${flag} 要正整數，拿到 ${raw}`);
    return value;
  };
  return {
    runsPerQuestion: positive('--runs-per-question', 6),
    groups: groups as Group[],
    out,
    concurrency: positive('--concurrency', 3),
    timeoutMs: positive('--timeout-ms', 300_000),
    resume: argv.includes('--resume'),
  };
}

/** 每組一個 patch：把夾具 server 以 `kb` 掛上去。 */
async function writePatch(group: Group): Promise<string> {
  const dir = await mkdtemp('/var/tmp/nexus-citation-patch-');
  const file = join(dir, 'kb.patch.yml');
  await writeFile(
    file,
    `- insert:
    - id: mcp-kb
      name: '@nexus/plugin-mcp'
      config:
        serverName: ${SERVER_NAME}
        connection:
          transport: stdio
          command: ${process.execPath}
          args: ['--import', 'tsx', '${SERVER_FILE}']
          cwd: ${HARNESS_DIR}
          env:
            ${MODE_ENV}: '${group}'
`,
  );
  return file;
}

interface Task {
  readonly id: string;
  readonly question: string;
  readonly rep: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} 逾時（${ms} ms）`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** 從工具卡的參數取出 `ask_user_question` 問的話。 */
function askTextOf(input: string): string {
  try {
    const parsed = JSON.parse(input) as unknown;
    const texts: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === 'string') return;
      if (Array.isArray(value)) value.forEach(walk);
      else if (typeof value === 'object' && value !== null) {
        for (const [key, inner] of Object.entries(value)) {
          if (
            typeof inner === 'string' &&
            ['question', 'header', 'label', 'description'].includes(key)
          )
            texts.push(inner);
          else walk(inner);
        }
      }
    };
    walk(parsed);
    return texts.join('\n');
  } catch {
    return input;
  }
}

class TurnFailed extends Error {
  constructor(
    message: string,
    readonly toolCalls: string[],
  ) {
    super(message);
  }
}

async function runGroup(
  group: Group,
  options: Options,
  log: (line: string) => void,
  done: ReadonlySet<string>,
  onRecord: (record: RunRecord) => Promise<void>,
): Promise<RunRecord[]> {
  const home = await mkdtemp('/var/tmp/nexus-citation-home-');
  const ws = await mkdtemp('/var/tmp/nexus-citation-ws-');
  const patch = await writePatch(group);
  const running = await runServe({
    argv: ['--live', '--port', '0', '--workspace', ws, '--patch', patch],
    log: (line: string) => {
      if (/警告|失敗|error/i.test(line)) log(`  [serve ${group}] ${line.slice(0, 200)}`);
    },
    env: { ...process.env, NEXUS_AGENT_HOME: home },
  });
  if (running === undefined) throw new Error('runServe 沒有起來');
  const client = await serveClient(running);

  const tasks: Task[] = [];
  for (let rep = 0; rep < options.runsPerQuestion; rep += 1) {
    QUESTIONS.forEach((question, q) => {
      const id = `${group}-q${q + 1}-r${rep + 1}`;
      if (!done.has(id)) tasks.push({ id, question, rep });
    });
  }
  const records: RunRecord[] = [];
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const task = tasks[next];
      next += 1;
      if (task === undefined) return;
      const started = Date.now();
      const base = { id: task.id, group, question: task.question, rep: task.rep };
      try {
        const thread = `citation-${task.id}`;
        const events = await client.openEvents(thread);
        await client.runStart(thread, task.question);
        const state = await withTimeout(foldTurn(events), options.timeoutMs, task.id);
        await events.return?.(undefined);
        const toolEntries = state.entries.filter((e) => e.kind === 'tool');
        // **這一輪沒跑完（root 收尾是 failed）不是模型的行為**：端點卡住、閒置逾時、被限流都長這樣。
        // 記成執行失敗、不進任何比例；若記成「空手收工」，端點的問題會被讀成模型的行為（第一次跑就這樣誤判過）。
        if (state.status === 'failed') {
          throw new TurnFailed(
            state.error ?? '沒有失敗原因',
            toolEntries.map((e) => e.name),
          );
        }
        const ai = [...state.entries]
          .reverse()
          .find((e) => e.kind === 'ai' && e.text.trim() !== '');
        const ask = toolEntries.find((e) => e.name === 'ask_user_question');
        records.push({
          ...base,
          durationMs: Date.now() - started,
          toolCalls: toolEntries.map((e) => e.name),
          status: state.status,
          answer: ai?.kind === 'ai' ? ai.text : '',
          askText: ask === undefined ? '' : askTextOf(ask.input),
        });
      } catch (error) {
        records.push({
          ...base,
          durationMs: Date.now() - started,
          toolCalls: error instanceof TurnFailed ? error.toolCalls : [],
          status: 'run-failed',
          answer: '',
          askText: '',
          error:
            error instanceof TurnFailed
              ? `這一輪失敗：${error.message}`
              : error instanceof Error
                ? error.message
                : String(error),
        });
      }
      const last = records.at(-1);
      if (last !== undefined) await onRecord(last);
      log(`  ${task.id} ${last?.error === undefined ? 'ok' : `失敗：${last.error}`}`);
    }
  }

  try {
    await Promise.all(Array.from({ length: options.concurrency }, worker));
  } finally {
    await running.close();
  }
  return records;
}

/**
 * `--summarize <runs.jsonl> [--labels <labels.json>]`：不跑模型，只把已有的記錄重新彙總。
 * 人工標完 `labels.json`（`{ "<id>": { "fabricated": true, "hedged": false, "note": "…" } }`）之後用它出最終報表，
 * 並列出自動判與人工判不一致的記錄 id。
 */
async function summarizeOnly(argv: readonly string[]): Promise<void> {
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  const runsPath = flag('--summarize');
  if (runsPath === undefined) throw new Error('--summarize 需要 runs.jsonl 的路徑');
  const records = (await readFile(runsPath, 'utf8'))
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as RunRecord);
  const labelsPath = flag('--labels');
  const labels: Labels =
    labelsPath === undefined ? {} : (JSON.parse(await readFile(labelsPath, 'utf8')) as Labels);
  console.log(renderSummary(records, labels));
  console.log('');
  console.log(renderByQuestion(records));
  if (labelsPath !== undefined) {
    console.log('');
    console.log(`自動判與人工判不一致：${disagreements(records, labels).join('、') || '無'}`);
  }
}

/**
 * `--blind-pack --baseline <runs.jsonl> --new <runs.jsonl> --out <目錄> [--seed N]`：兩批混在一起洗牌，
 * 寫出 `blind-items.json`（給標的人，沒有版本、id、耗時）與 `blind-key.json`（對照表，標完才用）。
 * `--blind-unpack --labels <blind-labels.json> --key <blind-key.json> --out <目錄>`：依版本拆成 `labels.<版本>.json`。
 */
async function blindMode(argv: readonly string[]): Promise<void> {
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  const need = (name: string): string => {
    const value = flag(name);
    if (value === undefined) throw new Error(`${name} 需要一個值`);
    return value;
  };
  const out = need('--out');
  await mkdir(out, { recursive: true });
  if (argv.includes('--blind-pack')) {
    const sets = [
      { version: 'baseline', records: await readRuns(need('--baseline')) },
      { version: 'new', records: await readRuns(need('--new')) },
    ];
    const { items, key } = packBlind(sets, Number(flag('--seed') ?? '1345'));
    await writeFile(join(out, 'blind-items.json'), JSON.stringify(items, null, 1));
    await writeFile(join(out, 'blind-key.json'), JSON.stringify(key, null, 1));
    console.log(
      `已打包 ${items.length} 筆：${join(out, 'blind-items.json')}（對照表另存 blind-key.json，標完前別看）`,
    );
    return;
  }
  const labels = JSON.parse(await readFile(need('--labels'), 'utf8')) as Record<string, Label>;
  const key = JSON.parse(await readFile(need('--key'), 'utf8')) as BlindKey;
  for (const [version, byId] of Object.entries(unpackLabels(labels, key))) {
    await writeFile(join(out, `labels.${version}.json`), JSON.stringify(byId, null, 1));
    console.log(`labels.${version}.json：${Object.keys(byId).length} 筆`);
  }
}

async function readRuns(path: string): Promise<RunRecord[]> {
  try {
    return (await readFile(path, 'utf8'))
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as RunRecord);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--summarize')) return summarizeOnly(process.argv.slice(2));
  if (process.argv.includes('--blind-pack') || process.argv.includes('--blind-unpack')) {
    return blindMode(process.argv.slice(2));
  }
  const options = parseArgs(process.argv.slice(2));
  if (process.env['NVIDIA_API_KEY'] === undefined) {
    throw new Error('環境裡沒有 NVIDIA_API_KEY：先 `set -a; source <主 checkout>/.env; set +a`');
  }
  await mkdir(options.out, { recursive: true });
  const log = (line: string): void => console.log(line);
  const runsFile = join(options.out, 'runs.jsonl');
  const previous = options.resume ? await readRuns(runsFile) : [];
  // 重跑失敗的：失敗記錄不刪，移到 failed-attempts.jsonl（PR 與報告要列失敗了幾次），runs.jsonl 只留成功的。
  const all = previous.filter((record) => record.error === undefined);
  const retried = previous.filter((record) => record.error !== undefined);
  await writeFile(runsFile, all.map((record) => JSON.stringify(record) + '\n').join(''));
  if (retried.length > 0) {
    await appendFile(
      join(options.out, 'failed-attempts.jsonl'),
      retried.map((record) => JSON.stringify(record) + '\n').join(''),
    );
  }
  const done = new Set(all.map((record) => record.id));
  for (const group of options.groups) {
    log(
      `# ${group} 組開跑（${QUESTIONS.length} 問法 × ${options.runsPerQuestion} 次，並行 ${options.concurrency}；已有 ${[...done].filter((id) => id.startsWith(`${group}-`)).length} 筆）`,
    );
    await runGroup(group, options, log, done, async (record) => {
      all.push(record);
      await appendFile(runsFile, JSON.stringify(record) + '\n');
    });
  }
  const report = [renderSummary(all, {}, options.groups), '', renderByQuestion(all)].join('\n');
  await writeFile(join(options.out, 'summary.md'), report + '\n');
  log('\n' + report);
}

await main();
process.exit(0);
