/**
 * 尺寸比較的進入點 —— `pnpm --filter @nexus/harness eval:compare`。
 *
 * **不進 CI。** 它需要 `NVIDIA_API_KEY` 而且會花錢跟花時間（兩道階梯五階加一個判準對照
 * × 三題，十分鐘級）。CI 那半是 [`eval.test.ts`](./eval.test.ts)：同一份資料、同一組評分器、
 * 零憑證。
 *
 * **這裡不設 `LANGSMITH_TRACING`，也不要在跑它的 shell 裡設。** 這支跑的是真的 agent，
 * 基準任務的題目與工具參數會跟著 trace 一起出境（見 `eval.test.ts` 檔頭量到的第二個寄件人）。
 *
 * 報表**按階梯分段印**，不併成一張表：「只有尺寸在變」是階梯內部的性質，跨階梯的那條線
 * 混著訓練配方（見 [`tiers.ts`](./tiers.ts) 檔頭）。判準對照另外印在最後，它不是一階。
 */

import { createLiveModel, loadLiveEnvIfNeeded } from '../live-model.js';
import { compareTiers, summarize, type TierOutcome, type TierSummary } from './compare.js';
import { MODEL_LADDERS, SCORER_CONTROL, type ModelLadder, type ModelTier } from './tiers.js';

const USAGE = `用法：eval:compare [--samples <n>]

  --samples <n>   每題重複幾次，預設 1。取樣是隨機的（temperature 1），
                  n=1 的數字是指示性的，不是定論。

需要環境變數 NVIDIA_API_KEY（見 .env.example）。`;

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
  console.log(`  工具成功率  ${formatSpread(summary.toolCallSuccess)}`);
  console.log(`  參數正確性  ${formatSpread(summary.argumentCorrectness)}`);
  console.log(`  多叫次數    ${formatSpread(summary.extraToolCalls)}`);
  // 成本與分數分開講：沒回報 usage 是「不知道」，印成 0 會讀成「免費」。
  console.log(
    `  總 token    ${formatSpread(summary.totalTokens)}` +
      `${summary.costed === summary.scored ? '' : `（只有 ${summary.costed}/${summary.scored} 次有回報 usage）`}`,
  );
}

function printOutcome(tier: ModelTier, outcome: TierOutcome): void {
  if (outcome.kind === 'scored') {
    const { score } = outcome;
    console.log(
      `  · ${tier.label} ${score.caseId} ${outcome.seconds}s` +
        ` 工具=${score.toolCallSuccess.toFixed(2)} 參數=${score.argumentCorrectness.toFixed(2)}` +
        ` 多叫=${score.extraToolCalls} token=${score.cost?.totalTokens ?? '—'}`,
    );
    return;
  }
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
): Promise<void> {
  console.log(`\n───── ${title} ─────`);
  console.log(`  ${note}`);
  const reports = await compareTiers(tiers, {
    createModel: (modelId) => createLiveModel(modelId),
    samples,
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
  loadLiveEnvIfNeeded();

  const rungs = MODEL_LADDERS.reduce((sum, ladder) => sum + ladder.tiers.length, 0);
  console.log(
    `尺寸比較：${MODEL_LADDERS.length} 道階梯共 ${rungs} 階，加一個判準對照，` +
      `每題 ${samples} 次取樣，循序跑。`,
  );

  for (const ladder of MODEL_LADDERS) {
    await runLadder(ladder, samples);
  }

  await runSection(
    '判準對照（不是一階）',
    '只回答「判準量不量得出 1.00 以下」。沒有同家族對照，分數不准讀成尺寸效應。',
    [SCORER_CONTROL],
    samples,
  );

  if (samples === 1) {
    console.log('\n注意：每題只取樣一次，取樣是隨機的 —— 這組數字是指示性的，不是定論。');
  }
  console.log('\n注意：跨階梯的差異混著訓練配方，只有同一道階梯內部才是「只有尺寸在變」。');
}

async function runLadder(ladder: ModelLadder, samples: number): Promise<void> {
  await runSection(`階梯 ${ladder.name}`, ladder.note, ladder.tiers, samples);
}

await main(process.argv.slice(2));
