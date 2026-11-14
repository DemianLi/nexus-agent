/**
 * 交接保真度評估的進入點 —— `pnpm --filter @nexus/harness eval:summary-fidelity`。
 * [#2774](https://github.com/DemianLi/nexus-agent/issues/2774)。
 *
 * 問的是「事實活不活得過摘要」：路徑、數值、被更正的決定、未完成的待辦埋在一段長對話裡，強制摘要之後逐題問，
 * 每個變體印一個得分。題庫與做法見 [`dataset.ts`](./dataset.ts) 與 [`runner.ts`](./runner.ts)。
 *
 * **不進 CI。** 需要 `NVIDIA_API_KEY`，會打真模型。請求數是定的：每個變體是「段數 + 題數」，`--count` 只印不跑。
 * 摘要與答題用同一顆模型（出貨預設那顆）；摘要器是出貨的那一顆，prompt、切點、重試都沒有另外寫。
 *
 * **這裡不設 `LANGSMITH_TRACING`，也不要在跑它的 shell 裡設。**
 */

import type { BaseMessage } from '@langchain/core/messages';
import { retryModelCall } from '@nexus/core';
import { installLaunchProxy } from '../../http-proxy-boot.js';
import {
  createLiveModel,
  DEFAULT_LIVE_MODEL_ID,
  LIVE_API_KEY_ENV,
  loadLiveLaunchEnv,
} from '../../live-model.js';
import {
  liveModelConfigForModel,
  liveModelConfigSchema,
  streamRetryOptionsOf,
} from '../../settings/live-model.js';
import { parseSamples } from '../cli-args.js';
import { FIDELITY_VARIANTS } from './dataset.js';
import type { FidelityVariant } from './dataset.js';
import { formatFidelityReport } from './report.js';
import { runFidelityVariant } from './runner.js';
import type { FidelityVariantResult } from './runner.js';

/** eval 的重試政策：跟出貨預設同一份（同 `../survey-cli.ts`）。 */
const EVAL_RETRY_POLICY = streamRetryOptionsOf(liveModelConfigSchema.parse({}).retryPolicy);

const USAGE = `用法：eval:summary-fidelity [--samples <n>] [--variants <id,...>] [--answers] [--count]

  --samples <n>        每個變體重複幾次，預設 1。摘要是取樣出來的，每次不同。
  --variants <id,...>  只跑指定的變體，預設全部：
                       ${FIDELITY_VARIANTS.map((variant) => `${variant.id}（${variant.title}）`).join(' / ')}
  --answers            報表之後逐題印出模型的答案。
  --count              只印這一輪會送幾個模型請求，不跑、不需要金鑰。

需要環境變數 NVIDIA_API_KEY（見 .env.example）。`;

function parseVariants(argv: readonly string[]): readonly FidelityVariant[] {
  const at = argv.indexOf('--variants');
  if (at < 0) return FIDELITY_VARIANTS;
  const wanted = (argv[at + 1] ?? '').split(',').filter((id) => id !== '');
  const unknown = wanted.filter((id) => !FIDELITY_VARIANTS.some((variant) => variant.id === id));
  if (wanted.length === 0 || unknown.length > 0) {
    throw new Error(
      `--variants 認不得 ${unknown.join(', ') || '（空的）'}；可用的是 ${FIDELITY_VARIANTS.map((variant) => variant.id).join(', ')}`,
    );
  }
  return FIDELITY_VARIANTS.filter((variant) => wanted.includes(variant.id));
}

/** 一個變體跑一次送幾個模型請求（不含重試）：每段一次摘要，每題一次。 */
function requestsOf(variant: FidelityVariant): number {
  return variant.segments.length + variant.questions.length;
}

async function main(argv: readonly string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return;
  }
  const samples = parseSamples(argv);
  const variants = parseVariants(argv);
  const requests = variants.reduce((sum, variant) => sum + requestsOf(variant), 0) * samples;
  console.log(
    `交接保真度評估：${variants.length}/${FIDELITY_VARIANTS.length} 個變體 × ${samples} 次，` +
      `共 ${requests} 個模型請求（不含重試；${variants.map((variant) => `${variant.id} ${requestsOf(variant)}`).join('、')}）。模型 ${DEFAULT_LIVE_MODEL_ID}。`,
  );
  if (argv.includes('--count')) return;

  const { credentials, launchEnv, keySourceOf, assertKeyLocated } = loadLiveLaunchEnv({
    store: false,
  });
  assertKeyLocated(LIVE_API_KEY_ENV);
  const keySource = keySourceOf(LIVE_API_KEY_ENV);
  if (keySource !== undefined) console.error(keySource);
  await installLaunchProxy(launchEnv, (message) => console.error(message));

  const model = createLiveModel(
    liveModelConfigForModel(DEFAULT_LIVE_MODEL_ID),
    undefined,
    credentials,
  );
  const ask = (messages: readonly BaseMessage[]) =>
    retryModelCall(EVAL_RETRY_POLICY, {}, async () => (await model.invoke([...messages])).text);

  const rounds: FidelityVariantResult[][] = [];
  let failed = 0;
  for (let sample = 0; sample < samples; sample += 1) {
    const round: FidelityVariantResult[] = [];
    for (const variant of variants) {
      try {
        const result = await runFidelityVariant(variant, {
          summaryModel: model,
          ask,
          retry: EVAL_RETRY_POLICY,
        });
        round.push(result);
        console.log(
          `  · 第 ${sample + 1} 次 ${variant.id} 得分 ${result.score?.toFixed(2) ?? '—'}` +
            ` 過時命中 ${result.staleHits}` +
            ` 摘要 ${result.summaries.map((summary) => `${(summary.summarizeMs / 1000).toFixed(1)}s／${summary.summaryChars} 字元`).join('、')}`,
        );
      } catch (error) {
        // 失敗不是零分：這一次沒有量到東西，不進報表的平均。
        failed += 1;
        console.log(
          `  · 第 ${sample + 1} 次 ${variant.id} 失敗：${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
        );
      }
    }
    rounds.push(round);
  }

  console.log(`\n${formatFidelityReport(rounds)}`);
  if (failed > 0) console.log(`\n失敗 ${failed} 次（沒量到，不進平均）。`);
  if (argv.includes('--answers')) {
    console.log('\n答案');
    for (const [sample, round] of rounds.entries()) {
      for (const result of round) {
        for (const question of result.questions) {
          console.log(
            `  第 ${sample + 1} 次 ${result.variantId}/${question.questionId} [${question.score.toFixed(2)}] ${question.answer.replaceAll('\n', ' ').slice(0, 300)}`,
          );
        }
      }
    }
  }
}

await main(process.argv.slice(2));
