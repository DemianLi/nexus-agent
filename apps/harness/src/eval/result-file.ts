/**
 * 評估結果檔 —— `eval:compare` 與 `eval:survey` 跑完留下的東西。
 * [#1000](https://github.com/DemianLi/nexus-agent/issues/1000)。
 *
 * ## 為什麼要有它
 *
 * 之前結果只印在終端。事後重算不了，也分不出兩次跑的是不是同一份題庫、同一個評分程式：
 * 題庫從三題變七題之後，同名的「參數正確性」前後指的是不同題組，只能靠人記。這個檔把
 * 「這個數字是在什麼條件下量的」跟數字一起存下來（藍圖規則 4：固定並記錄設定，自己重算）。
 *
 * ## 形狀：JSON Lines，逐筆 append
 *
 * 一輪是分鐘到小時級，結尾才寫的話半路被砍就全沒了。所以第一行是 {@link EvalResultHeader}
 * （這一輪的設定與版本），之後每跑完一次執行就 append 一行，最後一行是 footer。**沒有
 * footer 的檔是沒跑完的**（{@link ParsedEvalResult.complete}）。
 *
 * ## 版本識別：改了就會變
 *
 * - 題庫：對 {@link BENCHMARK} 的穩定序列化取雜湊（{@link datasetVersion}）。
 * - 評分程式：對 `scorers.ts` 與 `runner.ts` 的原始碼取雜湊（{@link scorerVersion}）。
 *   `runner.ts` 也算，因為它的 `summarize` 決定評分器看到什麼。
 *
 * 刻意不用手動版號：改了程式它不會自己變，而且沒有測試擋得到「忘了升」。
 *
 * ## 存原始觀測，不只存分數
 *
 * scored 那一筆帶著評分器當時看到的 {@link BenchmarkRun}。只存分數的話，評分程式一改，
 * 舊結果就沒辦法用新的判準重新評分。**拿新題庫去評舊觀測是錯的**，所以重新評分的人必須先
 * 比 header 的版本識別，對不上就拒絕。這個模組目前只做「用存下來的分數重算彙總」，
 * 那一條不需要比。
 *
 * ## 什麼不會進檔案
 *
 * 沒有環境變數、沒有憑證、沒有 base URL。失敗的錯誤訊息會先過 {@link redactMessage}：
 * 對外代理（#746）的 URL 可能帶帳密，錯誤訊息會把它夾帶出來。
 *
 * 預設目錄 {@link defaultResultDir} 在 `.gitignore` 裡；結果檔不進版控。
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BENCHMARK_SYSTEM_PROMPT } from './assembly.js';
import {
  EVAL_DEADLINE_MS,
  EVAL_RECURSION_LIMIT,
  evalModelRounds,
  type TierOutcome,
  type TierReport,
} from './compare.js';
import { BENCHMARK, EASY_CASE_COUNT, type BenchmarkCase } from './dataset.js';
import type { ModelUnderTest } from './model-under-test.js';

/**
 * 結果檔的格式版號。欄位改了就升，讀檔的人認不得的版號當場拋。
 *
 * 2：每筆 scored 的 `score` 多了 `success`（「這題成功」）。舊檔沒有那一欄，照讀的話
 * `summarize` 會把成功題數靜靜算成 0，所以拋比讀得通好。
 */
export const EVAL_RESULT_FORMAT_VERSION = 2;

/** 哪一支進入點產生的。 */
export type EvalTool = 'eval:compare' | 'eval:survey';

/** 跑的時候 repo 是什麼狀態。拿不到（不在 git 底下、沒有 git）就是 `null`，不猜。 */
export interface EvalProvenance {
  readonly commit: string | null;
  /** 工作樹有沒有未提交的改動（含未追蹤的檔）。本機跑 eval 多半有，只記 SHA 會說謊。 */
  readonly dirty: boolean | null;
}

/** 這一輪的設定。**這些值任何一個不同，數字就不是同一把尺量的。** */
export interface EvalRunSettings {
  readonly samples: number;
  readonly recursionLimit: number;
  /** 由 {@link evalModelRounds} 換算，跟 CLI 印給人看的是同一個數字。 */
  readonly modelRounds: number;
  readonly deadlineMs: number;
  /** 模型實例上讀到的取樣溫度；讀不到是 `null`。 */
  readonly temperature: number | null;
  readonly topP: number | null;
  /** `BENCHMARK_SYSTEM_PROMPT` 的雜湊。提示詞也是受測條件的一部分。 */
  readonly systemPromptVersion: string;
}

/** 結果檔第一行。 */
export interface EvalResultHeader {
  readonly type: 'header';
  readonly formatVersion: typeof EVAL_RESULT_FORMAT_VERSION;
  readonly tool: EvalTool;
  readonly startedAt: string;
  readonly argv: readonly string[];
  readonly provenance: EvalProvenance;
  readonly dataset: { readonly version: string; readonly caseIds: readonly string[] };
  readonly scorer: { readonly version: string; readonly files: readonly string[] };
  readonly settings: EvalRunSettings;
  /** 這一輪的受測模型；清單項目自己帶的欄位（`measuredOn`、`note`）原樣留著。 */
  readonly models: readonly ModelUnderTest[];
}

interface OutcomeLine {
  readonly type: 'outcome';
  /** 對到 header 裡某個模型的 `label`。 */
  readonly model: string;
  /** 同一個模型同一題的第幾次取樣，從 0 起。 */
  readonly sample: number;
  readonly outcome: TierOutcome;
}

interface FooterLine {
  readonly type: 'footer';
  readonly finishedAt: string;
  /** 寫了幾筆 outcome。讀檔時對一下，少了就是中途有 append 失敗。 */
  readonly outcomes: number;
}

// ───────────────────────── 版本識別 ─────────────────────────

/** 欄位順序固定的序列化，雜湊才不隨鍵的寫法而變。 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** 取前 12 個十六進位字元，跟 git 的短 SHA 一樣長；夠人眼比對，不拿來防偽。 */
export function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/**
 * 題庫版本。題目的 id、題面、期望、順序，以及易題／難題的分界，任何一項變了識別就變。
 *
 * 分界也算，因為 `eval:survey` 的「難題」那組數字是照它切的。
 */
export function datasetVersion(
  cases: readonly BenchmarkCase[] = BENCHMARK,
  easyCaseCount: number = EASY_CASE_COUNT,
): string {
  return shortHash(stableStringify({ cases, easyCaseCount }));
}

/** 評分程式涵蓋的檔案，相對於這個目錄。 */
export const SCORER_SOURCE_FILES: readonly string[] = ['scorers.ts', 'runner.ts'];

/** 讀這個目錄下一個檔的原始碼。 */
function readOwnSource(name: string): string {
  return readFileSync(new URL(name, import.meta.url), 'utf8');
}

/**
 * 評分程式版本：對 {@link SCORER_SOURCE_FILES} 的內容取雜湊。
 *
 * `readSource` 可注入，測試才餵得進改過的文字去驗「改了就變」。**讀不到原始碼就拋**，
 * 不回 `unknown`：一份寫著「評分程式版本不明」的結果檔，等於沒有這個欄位。
 */
export function scorerVersion(readSource: (name: string) => string = readOwnSource): string {
  const parts = SCORER_SOURCE_FILES.map((name) => `${name}\0${readSource(name)}`);
  return shortHash(parts.join('\0\0'));
}

/** `BENCHMARK_SYSTEM_PROMPT` 的雜湊。 */
export function systemPromptVersion(prompt: string = BENCHMARK_SYSTEM_PROMPT): string {
  return shortHash(prompt);
}

// ───────────────────────── 這一輪的設定與來源 ─────────────────────────

export interface DescribeSettingsInput {
  readonly samples: number;
  readonly recursionLimit: number;
  readonly deadlineMs: number;
  /** 從模型實例讀到的取樣設定；`undefined` 記成 `null`，不補預設值。 */
  readonly temperature?: number | undefined;
  readonly topP?: number | undefined;
}

export function describeSettings(input: DescribeSettingsInput): EvalRunSettings {
  return {
    samples: input.samples,
    recursionLimit: input.recursionLimit,
    modelRounds: evalModelRounds(input.recursionLimit),
    deadlineMs: input.deadlineMs,
    temperature: input.temperature ?? null,
    topP: input.topP ?? null,
    systemPromptVersion: systemPromptVersion(),
  };
}

/** 跑一個 git 指令；失敗（沒有 git、不在 repo 裡）回 `undefined`。 */
export type GitProbe = (args: readonly string[]) => string | undefined;

function defaultGitProbe(args: readonly string[]): string | undefined {
  try {
    return execFileSync('git', [...args], {
      cwd: fileURLToPath(new URL('.', import.meta.url)),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
}

/**
 * 這一輪跑在哪個 commit、工作樹乾不乾淨。
 *
 * `probe` 可注入，測試不打真的 git。**拿不到就記 `null`**，不填 `'unknown'` 字串：
 * 字串會被當成一個 SHA 比對，`null` 不會。
 */
export function readGitProvenance(probe: GitProbe = defaultGitProbe): EvalProvenance {
  const head = probe(['rev-parse', 'HEAD'])?.trim();
  const porcelain = probe(['status', '--porcelain']);
  return {
    commit: head === undefined || head === '' ? null : head,
    dirty: porcelain === undefined ? null : porcelain.trim() !== '',
  };
}

// ───────────────────────── 失敗訊息的遮罩 ─────────────────────────

/** 失敗訊息落檔的字數上限。終端那邊本來就只印 100 字，這裡留寬一點。 */
const MESSAGE_LIMIT = 200;

/**
 * 失敗的錯誤訊息落檔前先過這一關：遮掉看起來像憑證的東西，再截斷。
 *
 * 遮的是三種形狀：URL 裡的帳密（`://user:pass@`）、`Bearer` 之後的字串、`nvapi-`／`sk-`
 * 開頭的金鑰。**這是盡力而為的過濾，不是保證**；結果檔不進版控才是底線。
 */
export function redactMessage(message: string): string {
  const redacted = message
    .replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, '//***@')
    .replace(/\bBearer\s+\S+/gi, 'Bearer ***')
    .replace(/\b(?:nvapi|sk)-[A-Za-z0-9_-]+/g, '***');
  return redacted.length > MESSAGE_LIMIT ? `${redacted.slice(0, MESSAGE_LIMIT)}…` : redacted;
}

// ───────────────────────── 寫檔 ─────────────────────────

/** 預設的結果目錄：`apps/harness/eval-results/`。不依 cwd，而且在 `.gitignore` 裡。 */
export function defaultResultDir(): string {
  return fileURLToPath(new URL('../../eval-results/', import.meta.url));
}

export interface BuildHeaderInput {
  readonly tool: EvalTool;
  readonly startedAt: Date;
  readonly argv: readonly string[];
  readonly provenance: EvalProvenance;
  readonly cases: readonly BenchmarkCase[];
  readonly settings: EvalRunSettings;
  readonly models: readonly ModelUnderTest[];
}

export function buildHeader(input: BuildHeaderInput): EvalResultHeader {
  return {
    type: 'header',
    formatVersion: EVAL_RESULT_FORMAT_VERSION,
    tool: input.tool,
    startedAt: input.startedAt.toISOString(),
    argv: input.argv,
    provenance: input.provenance,
    // 版本識別對的是**整份題庫**；`caseIds` 才是這一輪實際跑的子集（`--cases`）。
    dataset: { version: datasetVersion(), caseIds: input.cases.map((entry) => entry.id) },
    scorer: { version: scorerVersion(), files: SCORER_SOURCE_FILES },
    settings: input.settings,
    models: input.models,
  };
}

export interface StartResultFileInput {
  readonly tool: EvalTool;
  readonly argv: readonly string[];
  readonly cases: readonly BenchmarkCase[];
  readonly models: readonly ModelUnderTest[];
  readonly samples: number;
  /** 模型實例上讀到的取樣設定。由呼叫端讀，這個模組不去猜、也不抄一份字面值。 */
  readonly sampling: {
    readonly temperature?: number | undefined;
    readonly topP?: number | undefined;
  };
  /** 預設 {@link defaultResultDir}；`--out` 傳進來的覆寫它。 */
  readonly dir?: string | undefined;
}

/**
 * 兩支 CLI 共用的開檔流程：讀來源、組 header、建檔。
 *
 * 單次執行的兩個上限讀的是 `compare.ts` 的常數，也就是 {@link runTier} 實際用的那兩個值，
 * 不是 CLI 另外記一份。
 */
export function startResultFile(input: StartResultFileInput): ResultWriter {
  const startedAt = new Date();
  const header = buildHeader({
    tool: input.tool,
    startedAt,
    argv: input.argv,
    provenance: readGitProvenance(),
    cases: input.cases,
    settings: describeSettings({
      samples: input.samples,
      recursionLimit: EVAL_RECURSION_LIMIT,
      deadlineMs: EVAL_DEADLINE_MS,
      ...input.sampling,
    }),
    models: input.models,
  });
  return openResultFile({ dir: input.dir ?? defaultResultDir(), header });
}

export interface ResultWriter {
  /** 結果檔的完整路徑。 */
  readonly path: string;
  /** 一次執行跑完就記一筆。 */
  append(tier: ModelUnderTest, outcome: TierOutcome): void;
  /** 寫 footer。回傳寫了幾筆，以及中途有沒有 append 失敗。 */
  finish(): { readonly outcomes: number; readonly writeFailed: boolean };
}

export interface OpenResultFileOptions {
  readonly dir: string;
  readonly header: EvalResultHeader;
  readonly now?: () => Date;
  /** 中途 append 失敗時呼叫。預設印到 stderr。 */
  readonly onWriteError?: (error: unknown) => void;
}

function stamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

function fileName(header: EvalResultHeader): string {
  const { commit, dirty } = header.provenance;
  const where = commit === null ? 'nogit' : commit.slice(0, 7);
  const tool = header.tool.replace(':', '-');
  return `${tool}-${stamp(new Date(header.startedAt))}-${where}${dirty === true ? '-dirty' : ''}.jsonl`;
}

/**
 * 建檔並寫下 header。
 *
 * **建檔失敗就拋**，讓呼叫端在花錢之前就知道。之後某一筆 append 失敗不拋：那一輪可能已經
 * 跑了半小時，為了一次寫檔失敗把它整個殺掉不划算；改成警告一次，`finish()` 回報
 * `writeFailed`，footer 的 `outcomes` 也會對不上實際行數。
 */
export function openResultFile(options: OpenResultFileOptions): ResultWriter {
  const now = options.now ?? (() => new Date());
  const onWriteError =
    options.onWriteError ??
    ((error: unknown) =>
      console.error(
        `警告：結果檔寫入失敗，這一筆沒有落檔：${error instanceof Error ? error.message : String(error)}`,
      ));

  mkdirSync(options.dir, { recursive: true });
  const path = join(options.dir, fileName(options.header));
  // `wx`：檔案已經存在就拋，絕不覆蓋一份舊結果。
  writeFileSync(path, `${JSON.stringify(options.header)}\n`, { flag: 'wx' });

  const samples = new Map<string, number>();
  let outcomes = 0;
  let writeFailed = false;

  const write = (line: OutcomeLine | FooterLine): boolean => {
    try {
      appendFileSync(path, `${JSON.stringify(line)}\n`);
      return true;
    } catch (error) {
      if (!writeFailed) onWriteError(error);
      writeFailed = true;
      return false;
    }
  };

  return {
    path,
    append(tier, outcome) {
      const caseId = outcome.kind === 'scored' ? outcome.score.caseId : outcome.caseId;
      const key = `${tier.label}\0${caseId}`;
      const sample = samples.get(key) ?? 0;
      samples.set(key, sample + 1);
      const safe: TierOutcome =
        outcome.kind === 'failed'
          ? { ...outcome, message: redactMessage(outcome.message) }
          : outcome;
      if (write({ type: 'outcome', model: tier.label, sample, outcome: safe })) outcomes += 1;
    },
    finish() {
      write({ type: 'footer', finishedAt: now().toISOString(), outcomes });
      return { outcomes, writeFailed };
    },
  };
}

// ───────────────────────── 讀檔與重算 ─────────────────────────

export interface ParsedEvalResult {
  readonly header: EvalResultHeader;
  readonly outcomes: readonly {
    readonly model: string;
    readonly sample: number;
    readonly outcome: TierOutcome;
  }[];
  /** 有 footer，而且 footer 記的筆數等於實際讀到的筆數。 */
  readonly complete: boolean;
}

/** 解析結果檔。第一行不是認得的 header，或格式版號不同，就當場拋。 */
export function parseResultFile(text: string): ParsedEvalResult {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  const [first, ...rest] = lines;
  if (first === undefined) throw new Error('結果檔是空的');

  const header = JSON.parse(first) as Partial<EvalResultHeader>;
  if (header.type !== 'header') throw new Error('結果檔第一行不是 header');
  if (header.formatVersion !== EVAL_RESULT_FORMAT_VERSION) {
    throw new Error(
      `結果檔格式版號是 ${String(header.formatVersion)}，這份程式只認得 ${EVAL_RESULT_FORMAT_VERSION}`,
    );
  }

  const outcomes: ParsedEvalResult['outcomes'][number][] = [];
  let footer: FooterLine | undefined;
  for (const line of rest) {
    const parsed = JSON.parse(line) as OutcomeLine | FooterLine;
    if (parsed.type === 'outcome') {
      outcomes.push({ model: parsed.model, sample: parsed.sample, outcome: parsed.outcome });
    } else if (parsed.type === 'footer') {
      footer = parsed;
    } else {
      throw new Error(`結果檔有認不得的一行：${line.slice(0, 60)}`);
    }
  }

  return {
    header: header as EvalResultHeader,
    outcomes,
    complete: footer !== undefined && footer.outcomes === outcomes.length,
  };
}

/** 把解析好的結果還原成 {@link TierReport}，可以直接餵 `summarize`。順序照 header 的模型清單。 */
export function reportsFromResult(result: ParsedEvalResult): readonly TierReport[] {
  const known = new Set(result.header.models.map((model) => model.label));
  const stray = result.outcomes.find((entry) => !known.has(entry.model));
  if (stray !== undefined) throw new Error(`結果檔有不在 header 清單裡的模型：${stray.model}`);

  return result.header.models.map((tier) => ({
    tier,
    outcomes: result.outcomes.filter((entry) => entry.model === tier.label).map((e) => e.outcome),
  }));
}
