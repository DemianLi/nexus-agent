/**
 * 選型調查的進入點 —— `pnpm --filter @nexus/harness eval:survey`。
 * [#85](https://github.com/DemianLi/nexus-agent/issues/85)。
 *
 * **跟 `eval:compare` 是兩支，因為問的不是同一件事。** compare 問「同家族內只有尺寸在變
 * 時分數怎麼動」，報表按階梯分段、每段印參數量；這一支問「這把 key 上叫得動的模型，同題
 * 表現如何」，報表是一張平坦的表、**一格參數量都不印**（清單本身就沒有那兩欄，見
 * [`survey.ts`](./survey.ts)）。合成一支的話，那條「不是在比尺寸」的界線遲早會被某次
 * 順手的重構抹掉。
 *
 * **不進 CI。** 需要 `NVIDIA_API_KEY`，會花錢也會花時間 —— 十六個候選 × 七題 × 三次取樣
 * 是 336 次執行。**開跑前先用 `--models` 加 `--cases` 冒煙**：整輪的上限我們沒有，
 * 只有單次執行的（見 `compare.ts` 的兩個常數），所以「跑多久」要自己先算。
 *
 * **這裡不設 `LANGSMITH_TRACING`，也不要在跑它的 shell 裡設。** 跑的是真的 agent，
 * 題目與工具參數會跟著 trace 出境。
 */

import { createLiveModel, loadLiveEnvIfNeeded, LIVE_MAX_RETRIES } from '../live-model.js';
import { parseCases, parseModels, parseSamples } from './cli-args.js';
import {
  compareTiers,
  restrictTo,
  summarize,
  EVAL_DEADLINE_MS,
  EVAL_RECURSION_LIMIT,
  type TierOutcome,
  type TierReport,
  type TierSummary,
} from './compare.js';
import { BENCHMARK, HARD_CASES } from './dataset.js';
import { SURVEY_INVENTORY_DATE, SURVEY_MODELS, type SurveyModel } from './survey.js';

const USAGE = `用法：eval:survey [--samples <n>] [--cases <id,...>] [--models <label,...>]

  --samples <n>        每題重複幾次，預設 1。取樣是隨機的（temperature 1）。
  --cases <id,...>     只跑指定的題目，預設全部。id 見 src/eval/dataset.ts：
                       ${BENCHMARK.map((entry) => entry.id).join(' / ')}
  --models <label,...> 只跑指定的候選，預設全部 ${SURVEY_MODELS.length} 個。短名見 src/eval/survey.ts：
                       ${SURVEY_MODELS.map((model) => model.label).join(' / ')}

冒煙（先量一次每題要跑多久，再決定整輪跑不跑得起）：
  pnpm --filter @nexus/harness eval:survey --cases reverse-round-trip

需要環境變數 NVIDIA_API_KEY（見 .env.example）。`;

/** 被上限切掉的執行數。**資料損失，不是分數。** */
let budgetHits = 0;
/** 重試耗盡後仍被限流的執行數。**是我們打太快，不是模型的問題。** */
let throttledHits = 0;

function formatSpread(spread: { mean: number; min: number; max: number } | undefined): string {
  if (spread === undefined) return '—';
  const mean = spread.mean.toFixed(2);
  if (spread.min === spread.max) return mean;
  return `${mean} (${spread.min.toFixed(2)}–${spread.max.toFixed(2)})`;
}

function formatScore(value: number | undefined): string {
  return value === undefined ? '—' : value.toFixed(2);
}

function printOutcome(model: SurveyModel, outcome: TierOutcome): void {
  if (outcome.kind === 'scored') {
    const { score } = outcome;
    console.log(
      `  · ${model.label} ${score.caseId} ${outcome.seconds}s` +
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
    `  · ${model.label} ${outcome.caseId} ${outcome.seconds}s` +
      ` 失敗：${outcome.reason}${status} — ${outcome.message.slice(0, 100)}`,
  );
}

/**
 * 一個候選的兩組數字。
 *
 * **兩組必須都印。** 只印全部的話，三條已經飽和的簡單題會把階間差異壓掉一半，看起來
 * 像判準又飽和了；只印難題的話，「連簡單的都做不到」這個資訊會不見。
 */
function printModel(all: TierSummary<SurveyModel>, hard: TierSummary<SurveyModel>): void {
  const { tier } = all;
  const failed = Object.entries(all.failures)
    .map(([reason, count]) => `${reason}×${count}`)
    .join(' ');

  console.log(`\n${tier.label}  ${tier.modelId}`);
  console.log(`  評到分      ${all.scored} 次${failed === '' ? '' : `，失敗 ${failed}`}`);
  console.log(
    `  工具成功率  全部 ${formatSpread(all.toolCallSuccess)}` +
      `  ｜ 難題 ${formatSpread(hard.toolCallSuccess)}`,
  );
  console.log(
    `  參數正確性  全部 ${formatSpread(all.argumentCorrectness)}` +
      `  ｜ 難題 ${formatSpread(hard.argumentCorrectness)}`,
  );
  console.log(
    `  多叫次數    全部 ${formatSpread(all.extraToolCalls)}` +
      `  ｜ 難題 ${formatSpread(hard.extraToolCalls)}`,
  );
  console.log(
    `  回覆提到    全部 ${formatSpread(all.mentions)}  ｜ 難題 ${formatSpread(hard.mentions)}`,
  );
  console.log(
    `  總 token    ${formatSpread(all.totalTokens)}` +
      `${all.costed === all.scored ? '' : `（只有 ${all.costed}/${all.scored} 次有回報 usage）`}`,
  );
  console.log(`  單次秒數    ${formatSpread(all.seconds)}`);
}

async function main(argv: readonly string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return;
  }

  const samples = parseSamples(argv);
  const cases = parseCases(argv);
  const models = parseModels(argv, SURVEY_MODELS);
  loadLiveEnvIfNeeded();

  // 「難題」是題目的性質不是這一輪的性質，所以先跟這一輪實際要跑的取交集 ——
  // `--cases` 只點了簡單題時，難題那一欄整欄是 `—`，而那是對的。
  const hardIds = new Set(
    HARD_CASES.filter((entry) => cases.some((c) => c.id === entry.id)).map((entry) => entry.id),
  );

  console.log(
    `選型調查：${models.length}/${SURVEY_MODELS.length} 個候選，` +
      `${cases.length}/${BENCHMARK.length} 題（其中難題 ${hardIds.size} 條），` +
      `每題 ${samples} 次取樣，循序跑。共 ${models.length * cases.length * samples} 次執行。`,
  );
  console.log(
    `候選來自 ${SURVEY_INVENTORY_DATE} 的盤點。**這個集合會變** —— 同一把 key 前一天量到的` +
      `是 14 個而且成員不同，所以報表上的每個數字都綁在這個日期上。`,
  );
  console.log(
    `單次執行的上限：迴圈 ${EVAL_RECURSION_LIMIT} 個 super-step、時鐘 ${EVAL_DEADLINE_MS / 1000} 秒。` +
      `超過記成 budget，不是分數。**整輪沒有上限**，開跑前自己算好要跑多久。`,
  );
  console.log('\n───── 逐次執行 ─────');

  const reports = await compareTiers<SurveyModel>(models, {
    createModel: (modelId) => createLiveModel(modelId),
    samples,
    cases,
    onOutcome: printOutcome,
  });

  console.log('\n───── 各候選彙總 ─────');
  console.log('  平坦的一張表，沒有尺寸那一欄 —— 十六個候選跨八家廠商，那條線讀不成尺寸效應。');
  for (const report of reports) printReport(report, hardIds);

  if (samples === 1) {
    console.log('\n注意：每題只取樣一次，取樣是隨機的 —— 這組數字是指示性的，不是定論。');
  }
  if (budgetHits > 0) {
    console.log(
      `\n注意：有 ${budgetHits} 次執行被上限切掉（budget）。**那是資料損失，不是低分** ——` +
        `模型有沒有做完這題我們不知道。`,
    );
  }
  if (throttledHits > 0) {
    console.log(
      `\n注意：有 ${throttledHits} 次執行在重試 ${LIVE_MAX_RETRIES} 次之後仍然被限流（throttled）。` +
        `**那是我們打太快，不是模型的問題** —— 對照「單次秒數」那一欄看，快的那幾個最先撞牆。` +
        `實測這個端點約 120k 的每分鐘 token 配額，觸發後十幾秒就恢復。`,
    );
  }
  console.log(
    '\n注意：這張表回答的是選型，不是尺寸。候選來自不同廠商與訓練配方，' +
      '任何「越大越好」的讀法在這裡都沒有根據 —— 尺寸那條線只在 eval:compare 的階梯內部成立。',
  );
}

function printReport(report: TierReport<SurveyModel>, hardIds: ReadonlySet<string>): void {
  printModel(summarize(report), summarize(restrictTo(report, hardIds)));
}

await main(process.argv.slice(2));
