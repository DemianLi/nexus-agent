/**
 * 交接保真度評估的進入點 —— `pnpm --filter @nexus/harness eval:summary-fidelity`。
 * [#2774](https://github.com/DemianLi/nexus-agent/issues/2774)。
 *
 * 問的是「事實活不活得過摘要」：路徑、數值、被更正的決定、未完成的待辦埋在一段長對話裡，強制摘要之後逐題問，
 * 每個變體印一個得分。題庫與做法見 [`dataset.ts`](./dataset.ts) 與 [`runner.ts`](./runner.ts)。
 *
 * **不進 CI。** 需要 `NVIDIA_API_KEY`，會打真模型。每個變體是「段數 × 2 + 題數」個請求（每段的摘要兩次：索引條目、現況），
 * `--count` 只印不跑；不含傳輸重試、索引條目不成立或現況超過上限時多叫的那一次，也不含摘要後仍到門檻時摘要器的那一次重摘。
 * `--recall`（[#2777](https://github.com/DemianLi/nexus-agent/issues/2777)）帶著 `history_read`／`history_search` 答題：每題 1 到
 * `FIDELITY_RECALL_MAX_REQUESTS` 個請求，看模型叫不叫工具，`--count` 印的是下限與上限。
 * `--paired`（[#2908](https://github.com/DemianLi/nexus-agent/issues/2908)）每題另外不帶工具問一次，同一份摘要上比有沒有工具的差別。
 * 摘要與答題用同一顆模型（出貨預設那顆）；摘要器是出貨的那一顆，prompt、切點、重試都沒有另外寫。
 *
 * **這裡不設 `LANGSMITH_TRACING`，也不要在跑它的 shell 裡設。** 題庫的對話、摘要與答案會跟著 trace 出境。
 */

import type { AIMessage, BaseMessage } from '@langchain/core/messages';
import type { NexusTool } from '@nexus/tools';
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
import { ALL_FIDELITY_VARIANTS, DETAIL_VARIANTS, FIDELITY_VARIANTS } from './dataset.js';
import type { FidelityVariant } from './dataset.js';
import { formatFidelityReport } from './report.js';
import { FIDELITY_RECALL_MAX_REQUESTS, runFidelityVariant } from './runner.js';
import type { FidelityVariantResult } from './runner.js';

/** eval 的重試政策：跟出貨預設同一份（同 `../survey-cli.ts`）。 */
const EVAL_RETRY_POLICY = streamRetryOptionsOf(liveModelConfigSchema.parse({}).retryPolicy);

const USAGE = `用法：eval:summary-fidelity [--samples <n>] [--variants <id,...>] [--summary-call <template|replay>] [--recall [--paired]] [--answers] [--count]

  --samples <n>        每個變體重複幾次，預設 1。摘要是取樣出來的，每次不同。
  --variants <id,...>  只跑指定的變體。預設是量摘要保真度的五個：
                       ${FIDELITY_VARIANTS.map((variant) => `${variant.id}（${variant.title}）`).join(' / ')}
                       摘要留不住答案、要配 --recall 看的三個要點名才跑：
                       ${DETAIL_VARIANTS.map((variant) => `${variant.id}（${variant.title}）`).join(' / ')}
  --summary-call <形狀> 生摘要的請求形狀：template（預設，要摘的那段攤成一個字串）或 replay
                       （系統訊息、原訊息、最後接摘要指令，同 history-source: log 的出貨路徑）。
  --recall             帶著 history_read／history_search 答題：模型可以從日誌讀回被摘掉的原文，
                       每題最多 ${FIDELITY_RECALL_MAX_REQUESTS} 個請求。
  --paired             配 --recall：每題先不帶工具問一次（多一個請求），同一份摘要上比有沒有工具。
  --answers            報表之後逐題印出每一輪：摘要裡有沒有答案、叫了幾次讀回工具、得分與答案。
  --count              只印這一輪會送幾個模型請求，不跑、不需要金鑰。

需要環境變數 NVIDIA_API_KEY（見 .env.example）。`;

function parseVariants(argv: readonly string[]): readonly FidelityVariant[] {
  const at = argv.indexOf('--variants');
  if (at < 0) return FIDELITY_VARIANTS;
  const wanted = (argv[at + 1] ?? '').split(',').filter((id) => id !== '');
  const unknown = wanted.filter(
    (id) => !ALL_FIDELITY_VARIANTS.some((variant) => variant.id === id),
  );
  if (wanted.length === 0 || unknown.length > 0) {
    throw new Error(
      `--variants 認不得 ${unknown.join(', ') || '（空的）'}；可用的是 ${ALL_FIDELITY_VARIANTS.map((variant) => variant.id).join(', ')}`,
    );
  }
  return ALL_FIDELITY_VARIANTS.filter((variant) => wanted.includes(variant.id));
}

function parseSummaryCall(argv: readonly string[]): 'template' | 'replay' {
  const at = argv.indexOf('--summary-call');
  if (at < 0) return 'template';
  const value = argv[at + 1];
  if (value !== 'template' && value !== 'replay') {
    throw new Error(`--summary-call 認不得 ${value ?? '（空的）'}；可用的是 template、replay`);
  }
  return value;
}

/**
 * 一個變體跑一次送幾個模型請求：每段兩次摘要（索引條目、現況），每題一次（帶 `--recall` 時這是下限）。不含重試、索引條目不成立或現況超過上限時多叫的那一次，
 * 也不含摘要器的重摘。
 */
function requestsOf(variant: FidelityVariant): number {
  return variant.segments.length * 2 + variant.questions.length;
}

async function main(argv: readonly string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return;
  }
  const samples = parseSamples(argv);
  const variants = parseVariants(argv);
  const summaryCall = parseSummaryCall(argv);
  const recall = argv.includes('--recall');
  const paired = argv.includes('--paired');
  if (paired && !recall) throw new Error('--paired 要配 --recall');
  const questions = variants.reduce((sum, variant) => sum + variant.questions.length, 0) * samples;
  const requests =
    variants.reduce((sum, variant) => sum + requestsOf(variant), 0) * samples +
    (paired ? questions : 0);
  const total = recall
    ? `${requests} 到 ${requests + questions * (FIDELITY_RECALL_MAX_REQUESTS - 1)} 個模型請求（帶讀回工具，每題 1 到 ${FIDELITY_RECALL_MAX_REQUESTS} 個${paired ? '，另加不帶工具的一個' : ''}；`
    : `${requests} 個模型請求（`;
  console.log(
    `交接保真度評估：${variants.length}/${ALL_FIDELITY_VARIANTS.length} 個變體 × ${samples} 次，` +
      `共 ${total}不含重試；${variants.map((variant) => `${variant.id} ${requestsOf(variant)}`).join('、')}）。模型 ${DEFAULT_LIVE_MODEL_ID}，生摘要的請求形狀 ${summaryCall}。`,
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
  const answerStep = (messages: readonly BaseMessage[], tools: readonly NexusTool[]) =>
    retryModelCall(
      EVAL_RETRY_POLICY,
      {},
      async () =>
        (await model
          .bindTools(
            tools.map((tool) => ({
              type: 'function' as const,
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
          )
          .invoke([...messages])) as AIMessage,
    );

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
          summaryCall,
          ...(recall && { answerStep, paired }),
        });
        round.push(result);
        console.log(
          `  · 第 ${sample + 1} 次 ${variant.id} 得分 ${result.score?.toFixed(2) ?? '—'}` +
            (result.scoreWithoutTools === undefined
              ? ''
              : `（不帶工具 ${result.scoreWithoutTools.toFixed(2)}）`) +
            ` 過時命中 ${result.staleHits}` +
            (recall
              ? ` 讀回工具 ${result.questions.reduce((sum, question) => sum + question.recallCalls, 0)} 次／答題請求 ${result.questions.reduce((sum, question) => sum + question.requests, 0)} 個`
              : '') +
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
          const flat = (text: string) => text.replaceAll('\n', ' ').slice(0, 300);
          console.log(
            `  第 ${sample + 1} 次 ${result.variantId}/${question.questionId} [${question.score.toFixed(2)}]` +
              ` 摘要裡${question.inSummary ? '有' : '沒有'}` +
              (recall ? ` 讀回工具 ${question.recallCalls} 次` : '') +
              (question.leaked ? ' 落在尾巴' : '') +
              ` ${flat(question.answer)}`,
          );
          if (question.withoutTools !== undefined) {
            console.log(
              `      不帶工具 [${question.withoutTools.score.toFixed(2)}] ${flat(question.withoutTools.answer)}`,
            );
          }
        }
      }
    }
  }
}

await main(process.argv.slice(2));
