/**
 * 評分器 —— 對「跑完的結果」的**純函式**。
 *
 * 刻意**不寫成 LangSmith 的 evaluator 簽章**（`({ run, example }) => ...`）。反過來寫的話，
 * CI 這半要呼叫它就得先偽造 `Run` 與 `Example` 兩個物件，而那正是資料集形狀會靜靜漂走
 * 的地方：偽造的那份跟真的送出去的那份沒有任何東西保證一致。要接上 `evaluate()` 時，
 * 在外面包一層薄的轉接即可 —— 那一層的存在條件是「真的有一個跑得起來的供應商」，
 * 見開發計劃 Phase 5 的封鎖說明。
 *
 * 三個指標對應計劃裡的三項：工具呼叫成功率、參數正確性、token 成本。**成本不是分數**，
 * 見 {@link readCost}。
 *
 * ## 「沒有可判的」一律是 `undefined`，不是 1 也不是 0
 *
 * 這條規矩在這個檔案裡出現三次（{@link scoreToolCallSuccess}、
 * {@link scoreArgumentCorrectness}、{@link scoreMentions}），理由都一樣：一個被填成
 * `1` 的空格會被平均進去，而它稀釋掉的正是這一欄的鑑別力。這與 `runner.ts` 區分
 * `usage` 的 `undefined` 與零、`compare.ts` 區分「失敗」與「零分」是同一條。
 */

import type { BenchmarkCase, ExpectedToolCall } from './dataset.js';
import type { BenchmarkRun, ObservedToolCall, TokenUsage } from './runner.js';

/** 期望的呼叫對到了觀測裡的第幾筆；`-1` 表示沒對到。 */
type Alignment = readonly number[];

/**
 * 把期望的呼叫序列對到觀測的呼叫序列上。
 *
 * 用**子序列**比對而不是逐位相等：模型在中間多叫一次無關的工具，不該讓後面每一筆都
 * 判成沒叫。順序仍然承重 —— 先寫檔再讀回來與反過來不是同一件事。
 */
function align(
  expected: readonly ExpectedToolCall[],
  observed: readonly ObservedToolCall[],
): Alignment {
  const result: number[] = [];
  let cursor = 0;
  for (const want of expected) {
    const index = observed.findIndex((call, at) => at >= cursor && call.name === want.name);
    result.push(index);
    if (index >= 0) cursor = index + 1;
  }
  return result;
}

/**
 * 工具呼叫成功率：該叫的都叫了嗎，順序對嗎。
 *
 * @returns `0` 到 `1`；**期望零筆呼叫時回 `undefined`——不是 1**。
 *
 * 這裡跟 {@link scoreMentions} 是同一條規矩：「這條沒有可判的」與「這條全對」在彙總時
 * 是兩件事。`no-tool-needed` 那種克制題期望零筆呼叫，回 `1` 的話等於替每一個模型的
 * 平均無條件送一分滿分進去 —— 加了那條題目之後，這一欄的**鑑別力反而下降**，
 * 而它下降的方式看起來完全像是模型變好了。克制題真正的訊號在
 * {@link countExtraToolCalls}。
 */
export function scoreToolCallSuccess(
  testCase: BenchmarkCase,
  run: BenchmarkRun,
): number | undefined {
  const expected = testCase.expected.toolCalls;
  if (expected.length === 0) return undefined;
  const matched = align(expected, run.toolCalls).filter((index) => index >= 0).length;
  return matched / expected.length;
}

/**
 * 多叫了幾次工具。
 *
 * **這不算進成功率**：兩件事混成一個數字之後，「少叫一次」與「多叫一次」在分數上分不開，
 * 而它們要修的東西完全不同。供應商比較時它自己是一欄。
 */
export function countExtraToolCalls(testCase: BenchmarkCase, run: BenchmarkRun): number {
  return Math.max(0, run.toolCalls.length - testCase.expected.toolCalls.length);
}

/**
 * 參數正確性：對上的那些呼叫，參數逐鍵比對。
 *
 * **只比資料集列出來的鍵**（見 {@link ExpectedToolCall.args}）。沒對上的呼叫，它期望的
 * 那幾個鍵全部計為錯 —— 工具根本沒叫，參數當然不可能對。
 *
 * @returns `0` 到 `1`；資料集一個鍵都沒列時回 `undefined`，理由同
 *   {@link scoreToolCallSuccess}。
 */
export function scoreArgumentCorrectness(
  testCase: BenchmarkCase,
  run: BenchmarkRun,
): number | undefined {
  const expected = testCase.expected.toolCalls;
  const alignment = align(expected, run.toolCalls);

  let total = 0;
  let correct = 0;
  expected.forEach((want, position) => {
    const keys = Object.keys(want.args);
    total += keys.length;
    const index = alignment[position];
    if (index === undefined || index < 0) return;
    const actual = run.toolCalls[index]?.args ?? {};
    for (const key of keys) {
      if (sameValue(actual[key], want.args[key])) correct += 1;
    }
  });

  if (total === 0) return undefined;
  return correct / total;
}

/**
 * 最終回覆有沒有提到該提的。
 *
 * @returns `0` 到 `1`；資料集沒列 `mentions` 時回 `undefined`——**不是 1**。
 *   「這條沒有要求」與「這條全對」在彙總時是兩件事。
 */
export function scoreMentions(testCase: BenchmarkCase, run: BenchmarkRun): number | undefined {
  const mentions = testCase.expected.mentions;
  if (mentions === undefined || mentions.length === 0) return undefined;
  const hits = mentions.filter((needle) => run.finalText.includes(needle)).length;
  return hits / mentions.length;
}

/**
 * 這一輪的 token 成本。
 *
 * **刻意不是 0 到 1 的分數。** 成本要比的是絕對數字，硬壓成分數就得先選一個預算基準，
 * 而那個基準是憑空捏的；供應商比較要的是「A 花了幾個 token、B 花了幾個」。
 *
 * @returns 模型回報的用量；沒回報就是 `undefined`（見 {@link BenchmarkRun.usage}）。
 */
export function readCost(run: BenchmarkRun): TokenUsage | undefined {
  return run.usage;
}

/**
 * 一條任務的完整成績單。
 *
 * 三個指標是選擇性的，而且各自的缺席理由不同：前兩個是「這條題目沒有可判的」，
 * `mentions` 是「這條題目沒要求」，`cost` 是「模型沒回報」。**四種缺席都不是零。**
 */
export interface CaseScore {
  readonly caseId: string;
  readonly toolCallSuccess?: number;
  readonly argumentCorrectness?: number;
  readonly extraToolCalls: number;
  readonly mentions?: number;
  readonly cost?: TokenUsage;
}

/**
 * 一條任務的三個指標一次算完。
 *
 * @param testCase - 題目。
 * @param run - 跑完的結果。
 * @returns 成績單。
 */
export function scoreCase(testCase: BenchmarkCase, run: BenchmarkRun): CaseScore {
  const toolCallSuccess = scoreToolCallSuccess(testCase, run);
  const argumentCorrectness = scoreArgumentCorrectness(testCase, run);
  const mentions = scoreMentions(testCase, run);
  const cost = readCost(run);
  return {
    caseId: testCase.id,
    ...(toolCallSuccess === undefined ? {} : { toolCallSuccess }),
    ...(argumentCorrectness === undefined ? {} : { argumentCorrectness }),
    extraToolCalls: countExtraToolCalls(testCase, run),
    ...(mentions === undefined ? {} : { mentions }),
    ...(cost === undefined ? {} : { cost }),
  };
}

/** 值相等。物件與陣列比結構，其餘比值。 */
function sameValue(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true;
  if (typeof actual !== 'object' || typeof expected !== 'object') return false;
  if (actual === null || expected === null) return false;
  return JSON.stringify(actual) === JSON.stringify(expected);
}
