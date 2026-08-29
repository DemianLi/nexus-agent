/**
 * 跨橫階跑基準任務，收集可比較的數字 —— 開發計劃第 5 節 Phase 5，
 * [#31](https://github.com/DemianLi/nexus-agent/issues/31) 的模型定案那一項。
 *
 * ## 唯一變動的是 model
 *
 * 三個橫階跑的是同一份 [`BENCHMARK`](./dataset.ts)、同一份 [`benchmarkPlugins()`](./assembly.ts)、
 * 同一個 [`runBenchmarkCase`](./runner.ts)、同一組評分器。`createModel` 是注進來的，
 * 所以測試餵得進假模型 —— 這個檔案本身**不需要任何憑證**，連外的只有呼叫端。
 *
 * ## 丟出例外不是零分
 *
 * 模型根本不收 `tools` 參數時端點回 4xx，`runBenchmarkCase` 當場拋；掛住時它永遠不回來。
 * **那兩件事都是「沒有資料」，不是「得零分」。** 把它們平均進通過率，「這個尺寸叫不出
 * 工具」與「這個 id 在這把 key 上叫不動」會收斂成同一個數字，而它們要做的事完全不同 ——
 * 一個是結果，一個是要換 id。這與 {@link BenchmarkRun.usage} 區分 `undefined` 與零、
 * `scoreMentions` 區分「沒要求」與「全對」是同一條規矩。
 *
 * 所以每次執行落在 {@link TierOutcome} 的兩支之一，彙總只對 `scored` 那些算，
 * 失敗的另外逐類計數。
 *
 * ## 取樣是隨機的
 *
 * `createLiveModel` 用 `temperature: 1` / `topP: 0.95`，同一題跑兩次可以得到不同結果。
 * {@link CompareOptions.samples} 因此收得下重複次數，彙總同時回報平均與**全距** ——
 * 單次取樣的一個數字讀起來像判決，但它不是。
 */

import type { AgentModel } from '@nexus/core';
import { BENCHMARK_SYSTEM_PROMPT, benchmarkPlugins } from './assembly.js';
import { isRetryableRateLimit } from '../live-model.js';
import { BENCHMARK, type BenchmarkCase } from './dataset.js';
import { runBenchmarkCase } from './runner.js';
import { scoreCase, type CaseScore } from './scorers.js';
import type { ModelUnderTest } from './model-under-test.js';

/** 一次執行失敗的分類。**分開列，因為要做的事不同。** */
export type FailureReason =
  /** 端點回了 HTTP 錯誤碼 —— 叫不動、不支援工具、參數形狀不合。 */
  | 'rejected'
  /**
   * **被端點限流，而且重試耗盡了。**
   *
   * 跟 `rejected` 分開，因為那兩件事要做的完全不同：`400` 是**模型行為**撞上供應商限制
   * （重跑一模一樣，要換 id 或改題目），限流是**我們打太快**（重跑不一定一樣，跟模型
   * 好壞無關）。混在一起讀，會把「我們超速」讀成「這個模型不行」——2026-08-28 就發生過
   * 一次，`gpt-oss-120b` 因此被記成「跑不完基準任務」，而它其實是六個裡最快的那個。
   *
   * 這一類**跟 `budget` 一樣是資料損失，不是低分**，但要做的事是「跑慢一點」或
   * 「把重試次數調高」，不是「這個模型不適合」。
   *
   * dsh 的 [`error.ts`](../../../../references/deepseek-harness/packages/llm/llm/src/error.ts)
   * 把 `RATE_LIMIT` 與 `QUOTA` 分成兩個碼，理由一樣：前者等一下就過，後者重試無效。
   * 配額耗盡的 429 因此**不算這一類**，它落在 `rejected`。
   */
  | 'throttled'
  /** 逾時，也就是 [#57](https://github.com/DemianLi/nexus-agent/issues/57) 那個永遠不回來。 */
  | 'timeout'
  /**
   * **我們自己把它切掉的** —— 迴圈跑太多輪，或整輪超過時間預算。
   *
   * 跟另外三類的差別在**是誰的問題**：`rejected` 與 `transport` 是端點那側，`timeout` 是
   * 端點不回話，而這一類是**模型的行為**（它一直叫工具、或一直叫不完）撞上我們設的上限。
   * 所以它既不是分數（模型沒把題目做完，我們不知道它做不做得完），也不該混進端點的失敗
   * 裡 —— 讀到它要做的事是「調高上限重跑」或「這個模型不適合」，不是「換 id」也不是
   * 「查網路」。報表因此把它單獨列一類。
   */
  | 'budget'
  /** 其餘（連線斷掉、回應解不開）。 */
  | 'transport';

/**
 * 基準任務的迴圈上限，比組裝點的預設緊。
 *
 * 換算是 `2 × 模型輪數 + 2`，所以 40 約等於 19 輪模型呼叫。取這個值的理由是實測：
 * 正常的執行裡最多的一次是 `oss-20b` 在 `edit-after-read` 上多叫 8 次（共 11 次工具呼叫
 * ≈ 24 個 super-step），而跑掉的那次是 25 次多叫（共 28 次 ≈ 58 個）——40 落在兩者中間。
 */
export const EVAL_RECURSION_LIMIT = 40;

/**
 * 一次執行的時間預算。
 *
 * **迴圈上限管不到的那一半**：`ultra` 在 `edit-after-read` 上跑過 420.9 秒與 247.3 秒，
 * 而它並沒有多叫幾次工具。5 分鐘這條線是刻意畫在兩者中間 —— 247.3 秒那次活得下來，
 * 420.9 秒那次會被切掉。**切掉是資料損失**，所以這個值調高比調低安全，
 * 而它會不會太緊要看報表上 `budget` 那一類出現得多不多。
 */
export const EVAL_DEADLINE_MS = 300_000;

/** 一次執行的結果。 */
export type TierOutcome =
  | { readonly kind: 'scored'; readonly score: CaseScore; readonly seconds: number }
  | {
      readonly kind: 'failed';
      readonly caseId: string;
      readonly reason: FailureReason;
      /** HTTP 錯誤碼；`reason` 不是 `rejected` 時是 `undefined`。 */
      readonly status?: number;
      readonly message: string;
      readonly seconds: number;
    };

/**
 * 一個橫階跑完之後留下的東西。
 *
 * **泛型是為了讓尺寸留在呼叫端。** 這一層只需要 {@link ModelUnderTest}（名字加 id），
 * 但尺寸比較的報表要印參數量、選型調查刻意沒有參數量 —— 參數化之後兩邊各自拿回
 * 自己那個型別，runner 一格都不必知道。
 */
export interface TierReport<T extends ModelUnderTest = ModelUnderTest> {
  readonly tier: T;
  readonly outcomes: readonly TierOutcome[];
}

export interface CompareOptions<T extends ModelUnderTest = ModelUnderTest> {
  /** 拿 model id 換一個 model。真的比較時是 `createLiveModel`，測試時是假模型。 */
  readonly createModel: (modelId: string) => AgentModel;
  /** 每題重複幾次。預設 1。 */
  readonly samples?: number;
  /** 每跑完一次就回報一次，讓呼叫端邊跑邊印 —— 一輪比較是分鐘級的。 */
  readonly onOutcome?: (tier: T, outcome: TierOutcome) => void;
  /** 要跑的題目。預設整份 {@link BENCHMARK}。 */
  readonly cases?: readonly BenchmarkCase[];
  /** 迴圈上限。預設 {@link EVAL_RECURSION_LIMIT}。 */
  readonly recursionLimit?: number;
  /** 一次執行的時間預算，毫秒。預設 {@link EVAL_DEADLINE_MS}；給 `0` 表示不設。 */
  readonly deadlineMs?: number;
}

/**
 * 跑一個橫階。
 *
 * @param tier - 這一階的 id 與參數量。
 * @param options - 模型工廠與重複次數。
 * @returns 這一階每次執行的結果，依「題目 × 取樣」的順序。
 */
export async function runTier<T extends ModelUnderTest>(
  tier: T,
  options: CompareOptions<T>,
): Promise<TierReport<T>> {
  const cases = options.cases ?? BENCHMARK;
  const samples = options.samples ?? 1;
  const outcomes: TierOutcome[] = [];

  for (const testCase of cases) {
    for (let sample = 0; sample < samples; sample += 1) {
      const outcome = await runOnce(tier, testCase, options);
      outcomes.push(outcome);
      options.onOutcome?.(tier, outcome);
    }
  }

  return { tier, outcomes };
}

/**
 * 依序跑完所有橫階。
 *
 * **刻意是循序的。** 併發跑會撞上端點的節流，量到的逾時就分不出是模型掛住還是我們自己
 * 塞太快 —— 這在盤點候選時實測過：18 路併發時 `deepseek-v4-pro-0813` 60 秒逾時，
 * 降到 4 路之後同一個 id 29 秒回得出東西。
 *
 * @param tiers - 由小到大的橫階。
 * @param options - 模型工廠與重複次數。
 * @returns 每一階的報告，順序與 `tiers` 相同。
 */
export async function compareTiers<T extends ModelUnderTest>(
  tiers: readonly T[],
  options: CompareOptions<T>,
): Promise<readonly TierReport<T>[]> {
  const reports: TierReport<T>[] = [];
  for (const tier of tiers) {
    reports.push(await runTier(tier, options));
  }
  return reports;
}

/**
 * 一次執行真正需要的設定。
 *
 * **刻意把 `onOutcome` 排除在外**：只有那一格帶著呼叫端的模型型別，而函式參數是逆變的
 * —— 留著它，`CompareOptions<T>` 就傳不進這個吃 `ModelUnderTest` 的函式。
 */
type RunOnceOptions = Omit<CompareOptions, 'onOutcome'>;

async function runOnce(
  tier: ModelUnderTest,
  testCase: BenchmarkCase,
  options: RunOnceOptions,
): Promise<TierOutcome> {
  const started = Date.now();
  const deadlineMs = options.deadlineMs ?? EVAL_DEADLINE_MS;
  // 留著這個訊號的參照，才能在 catch 裡**直接問它有沒有觸發**，而不是去猜錯誤長什麼樣。
  // 中止丟出來的是 `DOMException` 且 `name` 是 `TimeoutError` —— 那個名字會被下面的逾時
  // 掃描認成「端點不回話」，跟我們自己切掉的完全混在一起。問訊號是確定的，猜名字不是。
  const deadline = deadlineMs > 0 ? AbortSignal.timeout(deadlineMs) : undefined;

  try {
    const run = await runBenchmarkCase(testCase, {
      model: options.createModel(tier.modelId),
      plugins: benchmarkPlugins(),
      systemPrompt: BENCHMARK_SYSTEM_PROMPT,
      recursionLimit: options.recursionLimit ?? EVAL_RECURSION_LIMIT,
      ...(deadline === undefined ? {} : { signal: deadline }),
    });
    return { kind: 'scored', score: scoreCase(testCase, run), seconds: elapsed(started) };
  } catch (error) {
    if (deadline?.aborted === true) {
      return {
        kind: 'failed',
        caseId: testCase.id,
        reason: 'budget',
        message: `超過單次執行的時間預算 ${deadlineMs / 1000} 秒`,
        seconds: elapsed(started),
      };
    }
    const { reason, status } = classify(error);
    return {
      kind: 'failed',
      caseId: testCase.id,
      reason,
      ...(status === undefined ? {} : { status }),
      message: error instanceof Error ? error.message : String(error),
      seconds: elapsed(started),
    };
  }
}

function elapsed(started: number): number {
  return Number(((Date.now() - started) / 1000).toFixed(1));
}

/**
 * 把例外分類。
 *
 * 讀的是 OpenAI SDK 掛在錯誤上的 `status`，不是訊息字串 —— 訊息會隨版本改，`status`
 * 是協定的一部分。認不出來的一律歸 `transport` 而不是猜，寧可少說。
 *
 * **`status` 不在最外層那顆錯誤上，所以要往 `cause` 裡找。** 實測（`llama-3.2-11b`
 * 對 `write-then-read` 回 `400 "This model only supports single tool-calls at once!"`）：
 * 丟出來的是 `MiddlewareError`，`status` 是 `undefined`，真正帶 `status: 400` 的
 * `BadRequestError` 包在 **`cause` 底下第三層**。只看最外層的話，一個貨真價實的 4xx 會被
 * 記成 `transport` —— 而那兩件事要做的完全不同：一個要換 id 或改題目，一個是線路問題。
 *
 * 三趟掃，順序有意義：
 *
 * 1. **`status`**：外層訊息裡出現 `aborted` 之類的字眼很常見，讓它壓過內層一顆明確的
 *    400 就是拿字串壓過協定。
 * 2. **迴圈上限**：`GraphRecursionError` 的訊息是 `Recursion limit of N reached without
 *    hitting a stop condition`，裡面沒有任何逾時字眼，所以放在第三趟後面的話它會掉進
 *    `transport` —— 一個「模型一直叫工具」的結果會被記成線路問題。
 * 3. **逾時**：其餘認得出來的。
 *
 * 時間預算那一半**不在這裡認**：它由 {@link runOnce} 直接問中止訊號，因為那個
 * `DOMException` 的 `name` 就是 `TimeoutError`，靠字串分不開「我們切的」與「端點不回話」。
 */
function classify(error: unknown): { reason: FailureReason; status?: number } {
  const chain = [...causeChain(error)];

  // 限流要先於一般的 status 掃描 —— 它自己也帶 429，晚一步就會被記成 `rejected`，
  // 而那正是把「我們打太快」讀成「這個模型不行」的那條路。配額耗盡的 429 不在這裡面
  // （`isRetryableRateLimit` 排掉了），它該落到下面的 `rejected`。
  if (isRetryableRateLimit(error)) return { reason: 'throttled', status: 429 };

  for (const link of chain) {
    const status = (link as { status?: unknown }).status;
    if (typeof status === 'number') return { reason: 'rejected', status };
  }

  for (const link of chain) {
    const name = (link as { name?: unknown }).name;
    if (name === 'GraphRecursionError') return { reason: 'budget' };
    const message = link instanceof Error ? link.message : '';
    if (/Recursion limit of \d+ reached/i.test(message)) return { reason: 'budget' };
  }

  for (const link of chain) {
    const name = (link as { name?: unknown }).name;
    if (typeof name === 'string' && /timeout/i.test(name)) return { reason: 'timeout' };

    const message = link instanceof Error ? link.message : '';
    if (/timed out|timeout|aborted/i.test(message)) return { reason: 'timeout' };
  }

  return { reason: 'transport' };
}

/** 展開 `cause` 鏈。有深度上限也認得出環，因為包裝層數是別人家的實作細節。 */
function* causeChain(error: unknown): Generator<object> {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 10; depth += 1) {
    if (typeof current !== 'object' || current === null || seen.has(current)) return;
    seen.add(current);
    yield current;
    current = (current as { cause?: unknown }).cause;
  }
}

/** 一個橫階的彙總。**只對 `scored` 那些算。** */
export interface TierSummary<T extends ModelUnderTest = ModelUnderTest> {
  readonly tier: T;
  /** 真的評到分的次數。 */
  readonly scored: number;
  /** 各類失敗的次數。沒有的類別不會出現。 */
  readonly failures: Readonly<Partial<Record<FailureReason, number>>>;
  /**
   * 工具呼叫成功率的平均與全距。
   *
   * **只算真的有分數的那些執行。** 期望零筆工具呼叫的題目（`no-tool-needed`）在
   * `scoreCase` 裡是 `undefined` 而不是 1，這裡照樣把它濾掉 —— 讓它以 1 混進平均，
   * 這一欄的鑑別力會被無條件的滿分稀釋（見 `scorers.ts` 的
   * {@link scoreToolCallSuccess}）。`Spread.count` 因此**不一定等於** {@link scored}。
   */
  readonly toolCallSuccess?: Spread;
  readonly argumentCorrectness?: Spread;
  readonly extraToolCalls?: Spread;
  /**
   * 最終回覆有沒有提到該提的。
   *
   * `scoreCase` 從第一天就算了它，但這裡以前沒印 —— 一欄算完就丟掉的品質指標。
   * 它跟前兩欄問的不是同一件事：那兩欄問「有沒有做」，這一欄問「有沒有把結果講出來」，
   * 而工具全叫對了卻答非所問是真的會發生。只算資料集有列 `mentions` 的題目。
   */
  readonly mentions?: Spread;
  /**
   * 總 token 的平均與全距。
   *
   * 只算**有回報 `usage` 的**那些執行。一次都沒回報就是 `undefined` —— 不是零，
   * 那是「這條路免費」與「我們不知道」的差別（見 {@link BenchmarkRun.usage}）。
   */
  readonly totalTokens?: Spread;
  /**
   * 單次執行的秒數，平均與全距。**只算評到分的那些。**
   *
   * 失敗的執行不進來是刻意的：逾時那一筆恆等於上限、限流那一筆量的是我們自己的退避，
   * 兩個都不是「這個模型跑一題要多久」。
   *
   * 這一欄同時是**限流的風險指標** —— 快的那幾個每秒燒掉的 token 最多，最先撞上端點的
   * 每分鐘配額（#85 第 4 條）。看到某一階又快又滿是 `throttled`，先懷疑跑法。
   */
  readonly seconds?: Spread;
  /** 有回報 `usage` 的執行次數。跟 {@link scored} 不一定相等。 */
  readonly costed: number;
}

/** 一組數字的平均與全距。 */
export interface Spread {
  readonly mean: number;
  readonly min: number;
  readonly max: number;
  readonly count: number;
}

/**
 * 把一份報告收窄到某幾題。
 *
 * **報表要能同時印「全部」與「只有難題」兩組數字**，而那兩組必須來自同一次執行 ——
 * 分兩輪跑的話取樣不同，差異就分不出是題目造成的還是抽樣造成的。所以是跑一次、切兩次。
 *
 * 失敗的執行一起帶過來（它們也有 `caseId`），這樣「這個模型是在難題上掛的」讀得出來。
 *
 * @param report - {@link runTier} 的產物。
 * @param caseIds - 要留下的題目 id。
 */
export function restrictTo<T extends ModelUnderTest>(
  report: TierReport<T>,
  caseIds: ReadonlySet<string>,
): TierReport<T> {
  return {
    tier: report.tier,
    outcomes: report.outcomes.filter((outcome) =>
      caseIds.has(outcome.kind === 'scored' ? outcome.score.caseId : outcome.caseId),
    ),
  };
}

/**
 * 把一階的執行結果收成一行報表。
 *
 * @param report - {@link runTier} 的產物。
 * @returns 彙總。失敗的執行**不會**被當成零分平均進去。
 */
export function summarize<T extends ModelUnderTest>(report: TierReport<T>): TierSummary<T> {
  const scored = report.outcomes.filter(
    (outcome): outcome is Extract<TierOutcome, { kind: 'scored' }> => outcome.kind === 'scored',
  );

  const failures: Partial<Record<FailureReason, number>> = {};
  for (const outcome of report.outcomes) {
    if (outcome.kind !== 'failed') continue;
    failures[outcome.reason] = (failures[outcome.reason] ?? 0) + 1;
  }

  const costs = present(scored.map((outcome) => outcome.score.cost?.totalTokens));

  return {
    tier: report.tier,
    scored: scored.length,
    failures,
    ...spreadOf('toolCallSuccess', present(scored.map((o) => o.score.toolCallSuccess))),
    ...spreadOf('argumentCorrectness', present(scored.map((o) => o.score.argumentCorrectness))),
    ...spreadOf(
      'extraToolCalls',
      scored.map((o) => o.score.extraToolCalls),
    ),
    ...spreadOf('mentions', present(scored.map((o) => o.score.mentions))),
    ...spreadOf('totalTokens', costs),
    ...spreadOf(
      'seconds',
      scored.map((o) => o.seconds),
    ),
    costed: costs.length,
  };
}

/** 丟掉 `undefined`。**它們是「沒有可判的」，不是零**，所以不能進平均。 */
function present(values: readonly (number | undefined)[]): readonly number[] {
  return values.filter((value): value is number => value !== undefined);
}

function spreadOf<K extends string>(key: K, values: readonly number[]): Partial<Record<K, Spread>> {
  if (values.length === 0) return {};
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    [key]: {
      mean: total / values.length,
      min: Math.min(...values),
      max: Math.max(...values),
      count: values.length,
    },
  } as Partial<Record<K, Spread>>;
}
