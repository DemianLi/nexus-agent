/**
 * 尺寸比較的進入點 —— `pnpm --filter @nexus/harness eval:compare`。
 *
 * **不進 CI。** 它需要 `NVIDIA_API_KEY` 而且會花錢跟花時間（兩道階梯五階加一個判準對照
 * × 七題，跑滿是半小時級）。CI 那半是 [`eval.test.ts`](./eval.test.ts)：同一份資料、
 * 同一組評分器、零憑證。
 *
 * **成本是題數 × 階數 × 取樣數的乘積**，所以 `--cases` 存在 —— 只想看某幾題時不必把
 * 整份重跑一遍。單次執行另外有兩道上限（迴圈輪數與時鐘，見 `compare.ts`），
 * 觸發時那一次記成 `budget` 而不是分數。
 *
 * **這裡不設 `LANGSMITH_TRACING`，也不要在跑它的 shell 裡設。** 這支跑的是真的 agent，
 * 基準任務的題目與工具參數會跟著 trace 一起出境（見 `eval.test.ts` 檔頭量到的第二個寄件人）。
 *
 * 報表**按階梯分段印**，不併成一張表：「只有尺寸在變」是階梯內部的性質，跨階梯的那條線
 * 混著訓練配方（見 [`tiers.ts`](./tiers.ts) 檔頭）。判準對照另外印在最後，它不是一階。
 */

import { createLiveModel, loadLiveEnvIfNeeded, LIVE_MAX_RETRIES } from '../live-model.js';
import {
  compareTiers,
  summarize,
  EVAL_DEADLINE_MS,
  EVAL_RECURSION_LIMIT,
  type TierOutcome,
  type TierSummary,
} from './compare.js';
import { BENCHMARK, type BenchmarkCase } from './dataset.js';
import { MODEL_LADDERS, SCORER_CONTROL, type ModelLadder, type ModelTier } from './tiers.js';

const USAGE = `用法：eval:compare [--samples <n>] [--cases <id,id,...>]

  --samples <n>        每題重複幾次，預設 1。取樣是隨機的（temperature 1），
                       n=1 的數字是指示性的，不是定論。
  --cases <id,...>     只跑指定的題目，預設全部。id 見 src/eval/dataset.ts：
                       ${BENCHMARK.map((entry) => entry.id).join(' / ')}

需要環境變數 NVIDIA_API_KEY（見 .env.example）。`;

/**
 * `--cases` 解析。
 *
 * **認不得的 id 一律當場拋，不默默略過。** 打錯一個字就跑了個比預期少的子集，
 * 而報表上完全看不出來少了哪一題 —— 那與 #79 那個 `status === 'idle'` 是同一型的假綠。
 */
function parseCases(argv: readonly string[]): readonly BenchmarkCase[] {
  const at = argv.indexOf('--cases');
  if (at < 0) return BENCHMARK;
  const raw = argv[at + 1];
  if (raw === undefined || raw.startsWith('--')) throw new Error('--cases 要一串以逗號分隔的 id');

  const wanted = raw.split(',').map((id) => id.trim());
  const known = new Set(BENCHMARK.map((entry) => entry.id));
  const unknown = wanted.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `--cases 認不得這些 id：${unknown.join('、')}。可用的是 ${[...known].join('、')}`,
    );
  }
  // 依資料集的順序跑，不依命令列打字的順序 —— 報表的列順序才不會隨手打的參數而變。
  return BENCHMARK.filter((entry) => wanted.includes(entry.id));
}

function parseSamples(argv: readonly string[]): number {
  const at = argv.indexOf('--samples');
  if (at < 0) return 1;
  const raw = argv[at + 1];
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`--samples 要一個正整數，收到 ${raw ?? '（空的）'}`);
  }
  return value;
}

function formatSpread(spread: { mean: number; min: number; max: number } | undefined): string {
  if (spread === undefined) return '—';
  const mean = spread.mean.toFixed(2);
  // 全距塌成一點時不印它，省得每一行都拖一段沒有資訊的括號。
  if (spread.min === spread.max) return mean;
  return `${mean} (${spread.min.toFixed(2)}–${spread.max.toFixed(2)})`;
}

/**
 * 尺寸那一行。
 *
 * 活化沒有值時印「不詳」而不是省略也不是 0 —— id 沒編碼就是我們不知道，
 * 那與「它是密集模型所以等於總量」是兩件事（見 {@link ModelTier.activeBillions}）。
 */
function formatSize(tier: ModelTier): string {
  const active =
    tier.activeBillions === undefined ? '不詳（id 沒編碼）' : `${tier.activeBillions}B`;
  return `總量 ${tier.totalBillions}B ／ 活化 ${active}`;
}

function printSummary(summary: TierSummary): void {
  const { tier } = summary;
  const failed = Object.entries(summary.failures)
    .map(([reason, count]) => `${reason}×${count}`)
    .join(' ');

  console.log(`\n${tier.label}  ${tier.modelId}`);
  console.log(`  尺寸        ${formatSize(tier)}`);
  console.log(`  評到分      ${summary.scored} 次${failed === '' ? '' : `，失敗 ${failed}`}`);
  // 前兩欄的 count 不一定等於「評到分」的次數：期望零筆呼叫的題目在這兩欄是
  // 「沒有可判的」，被濾掉了（見 `compare.ts` 的 TierSummary）。所以少於總數時印出來。
  console.log(
    `  工具成功率  ${formatSpread(summary.toolCallSuccess)}${judged(summary, summary.toolCallSuccess)}`,
  );
  console.log(
    `  參數正確性  ${formatSpread(summary.argumentCorrectness)}${judged(summary, summary.argumentCorrectness)}`,
  );
  console.log(`  多叫次數    ${formatSpread(summary.extraToolCalls)}`);
  console.log(
    `  回覆提到    ${formatSpread(summary.mentions)}${judged(summary, summary.mentions)}`,
  );
  // 成本與分數分開講：沒回報 usage 是「不知道」，印成 0 會讀成「免費」。
  console.log(
    `  總 token    ${formatSpread(summary.totalTokens)}` +
      `${summary.costed === summary.scored ? '' : `（只有 ${summary.costed}/${summary.scored} 次有回報 usage）`}`,
  );
}

/** 被上限切掉的執行數。**它是資料損失，不是分數**，所以跑完要單獨提一句。 */
let budgetHits = 0;

/**
 * 重試耗盡後仍被限流的執行數。**同樣是資料損失，但要做的事跟 `budget` 不同。**
 *
 * 看到它就表示這一輪跑得比端點的配額快 —— 那不是模型的問題，讀成模型的問題會出事
 * （2026-08-28 出過一次）。
 */
let throttledHits = 0;

/** 這一欄實際判了幾次。等於評到分的次數時不印 —— 每行都拖一段沒有資訊的括號很吵。 */
function judged(summary: TierSummary, spread: { count: number } | undefined): string {
  if (spread === undefined || spread.count === summary.scored) return '';
  return `（判了 ${spread.count}/${summary.scored} 次）`;
}

/** 沒有可判的那一格印 `—`，不印 `0.00`。理由同 `formatSpread`。 */
function formatScore(value: number | undefined): string {
  return value === undefined ? '—' : value.toFixed(2);
}

function printOutcome(tier: ModelTier, outcome: TierOutcome): void {
  if (outcome.kind === 'scored') {
    const { score } = outcome;
    console.log(
      `  · ${tier.label} ${score.caseId} ${outcome.seconds}s` +
        ` 工具=${formatScore(score.toolCallSuccess)} 參數=${formatScore(score.argumentCorrectness)}` +
        ` 多叫=${score.extraToolCalls} 提到=${formatScore(score.mentions)}` +
        ` token=${score.cost?.totalTokens ?? '—'}`,
    );
    return;
  }
  if (outcome.reason === 'budget') budgetHits += 1;
  if (outcome.reason === 'throttled') throttledHits += 1;
  const status = outcome.status === undefined ? '' : ` ${outcome.status}`;
  console.log(
    `  · ${tier.label} ${outcome.caseId} ${outcome.seconds}s` +
      ` 失敗：${outcome.reason}${status} — ${outcome.message.slice(0, 100)}`,
  );
}

async function runSection(
  title: string,
  note: string,
  tiers: readonly ModelTier[],
  samples: number,
  cases: readonly BenchmarkCase[],
): Promise<void> {
  console.log(`\n───── ${title} ─────`);
  console.log(`  ${note}`);
  const reports = await compareTiers(tiers, {
    createModel: (modelId) => createLiveModel(modelId),
    samples,
    cases,
    onOutcome: printOutcome,
  });
  for (const report of reports) printSummary(summarize(report));
}

async function main(argv: readonly string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return;
  }

  const samples = parseSamples(argv);
  const cases = parseCases(argv);
  loadLiveEnvIfNeeded();

  const rungs = MODEL_LADDERS.reduce((sum, ladder) => sum + ladder.tiers.length, 0);
  const scope = cases.length === BENCHMARK.length ? '' : `（${cases.map((c) => c.id).join('、')}）`;
  console.log(
    `尺寸比較：${MODEL_LADDERS.length} 道階梯共 ${rungs} 階，加一個判準對照，` +
      `${cases.length}/${BENCHMARK.length} 題${scope}，每題 ${samples} 次取樣，循序跑。` +
      `共 ${(rungs + 1) * cases.length * samples} 次執行。`,
  );
  console.log(
    `單次執行的上限：迴圈 ${EVAL_RECURSION_LIMIT} 個 super-step（約 ${(EVAL_RECURSION_LIMIT - 2) / 2} 輪模型呼叫）、` +
      `時鐘 ${EVAL_DEADLINE_MS / 1000} 秒。超過就記成 budget，不是分數。`,
  );

  for (const ladder of MODEL_LADDERS) {
    await runLadder(ladder, samples, cases);
  }

  await runSection(
    '判準對照（不是一階）',
    '只回答「判準量不量得出 1.00 以下」。沒有同家族對照，分數不准讀成尺寸效應。',
    [SCORER_CONTROL],
    samples,
    cases,
  );

  if (samples === 1) {
    console.log('\n注意：每題只取樣一次，取樣是隨機的 —— 這組數字是指示性的，不是定論。');
  }
  if (budgetHits > 0) {
    console.log(
      `\n注意：有 ${budgetHits} 次執行被上限切掉（budget）。**那是資料損失，不是低分** ——` +
        `模型有沒有做完這題我們不知道。要嘛調高上限重跑，要嘛就把它讀成「這個模型在這題上跑不完」。`,
    );
  }
  if (throttledHits > 0) {
    console.log(
      `\n注意：有 ${throttledHits} 次執行在重試 ${LIVE_MAX_RETRIES} 次之後仍然被限流（throttled）。` +
        `**那是我們打太快，不是模型的問題** —— 它跟端點的 4xx 一樣不進平均，但要做的事是` +
        `跑慢一點或調高重試次數，不是換 id。實測這個端點約 120k 的每分鐘 token 配額，` +
        `觸發後十幾秒就恢復。`,
    );
  }
  console.log('\n注意：跨階梯的差異混著訓練配方，只有同一道階梯內部才是「只有尺寸在變」。');
}

async function runLadder(
  ladder: ModelLadder,
  samples: number,
  cases: readonly BenchmarkCase[],
): Promise<void> {
  await runSection(`階梯 ${ladder.name}`, ladder.note, ladder.tiers, samples, cases);
}

await main(process.argv.slice(2));
