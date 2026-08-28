/**
 * 尺寸比較的進入點 —— `pnpm --filter @nexus/harness eval:compare`。
 *
 * **不進 CI。** 它需要 `NVIDIA_API_KEY` 而且會花錢跟花時間（三階 × 三題，分鐘級）。
 * CI 那半是 [`eval.test.ts`](./eval.test.ts)：同一份資料、同一組評分器、零憑證。
 *
 * **這裡不設 `LANGSMITH_TRACING`，也不要在跑它的 shell 裡設。** 這支跑的是真的 agent，
 * 基準任務的題目與工具參數會跟著 trace 一起出境（見 `eval.test.ts` 檔頭量到的第二個寄件人）。
 */

import { createLiveModel, loadLiveEnvIfNeeded } from '../live-model.js';
import { compareTiers, summarize, type TierOutcome, type TierSummary } from './compare.js';
import { MODEL_TIERS, type ModelTier } from './tiers.js';

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

function printSummary(summary: TierSummary): void {
  const { tier } = summary;
  const failed = Object.entries(summary.failures)
    .map(([reason, count]) => `${reason}×${count}`)
    .join(' ');

  console.log(`\n${tier.label}  ${tier.modelId}`);
  console.log(`  尺寸        總量 ${tier.totalBillions}B ／ 活化 ${tier.activeBillions}B`);
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

async function main(argv: readonly string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return;
  }

  const samples = parseSamples(argv);
  loadLiveEnvIfNeeded();

  console.log(`尺寸比較：${MODEL_TIERS.length} 階 × ${samples} 次取樣，循序跑。`);
  const reports = await compareTiers(MODEL_TIERS, {
    createModel: (modelId) => createLiveModel(modelId),
    samples,
    onOutcome: printOutcome,
  });

  console.log('\n===== 彙總 =====');
  for (const report of reports) printSummary(summarize(report));

  if (samples === 1) {
    console.log('\n注意：每題只取樣一次，取樣是隨機的 —— 這組數字是指示性的，不是定論。');
  }
}

await main(process.argv.slice(2));
