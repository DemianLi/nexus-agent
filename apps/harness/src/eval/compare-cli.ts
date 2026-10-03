/**
 * 跑基準任務的進入點 —— `pnpm --filter @nexus/harness eval:compare`。
 *
 * **不進 CI。** 它需要 `NVIDIA_API_KEY` 而且會花錢跟花時間（五個模型 × 七題，跑滿是
 * 半小時級）。CI 那半是 [`eval.test.ts`](./eval.test.ts)：同一份資料、同一組評分器、零憑證。
 *
 * **2026-09-05：它原本叫「尺寸比較」、按階梯分段印，而階梯收掉了**
 * （[#167](https://github.com/DemianLi/nexus-agent/issues/167)，理由見
 * [`tiers.ts`](./tiers.ts) 檔頭）。現在它跑 {@link MEASURED_MODELS} —— 走完整基準任務
 * 量過的那份清單 —— 一段印完。[#165](https://github.com/DemianLi/nexus-agent/issues/165)
 * 選預設模型時要的正是這件事，而當時 repo 裡沒有這條路，只能在外面拿一份臨時清單跑。
 * **這份清單跨四個家族，所以照參數量排出來的任何一條線都讀不成尺寸效應**；尺寸那條線
 * 在 2026-08-28 就結案了（「沒有效應」，三輪確認）。
 *
 * **成本是題數 × 模型數 × 取樣數的乘積**，所以 `--cases` 與 `--models` 都在 —— 只想看
 * 某幾題或某幾個模型時不必把整份重跑一遍。單次執行另外有兩道上限（迴圈輪數與時鐘，
 * 見 `compare.ts`），觸發時那一次記成 `budget` 而不是分數。
 *
 * **這裡不設 `LANGSMITH_TRACING`，也不要在跑它的 shell 裡設。** 這支跑的是真的 agent，
 * 基準任務的題目與工具參數會跟著 trace 一起出境（見 `eval.test.ts` 檔頭量到的第二個寄件人）。
 */
import type { CredentialService } from '../credentials.js';
import { installLaunchProxy } from '../http-proxy-boot.js';
import { createLiveModel, loadLiveLaunchEnv, DEFAULT_LIVE_MAX_RETRIES } from '../live-model.js';
import { liveModelConfigForModel } from '../settings/live-model.js';
import {
  compareTiers,
  evalModelRounds,
  summarize,
  EVAL_DEADLINE_MS,
  EVAL_RECURSION_LIMIT,
  type TierOutcome,
  type TierSummary,
} from './compare.js';
import { parseCases, parseModels, parseOut, parseSamples } from './cli-args.js';
import { BENCHMARK, type BenchmarkCase } from './dataset.js';
import { floorHolds, formatFloor, summarizeFloor } from './floor.js';
import { startResultFile, type ResultWriter } from './result-file.js';
import { MEASURED_MODELS, type MeasuredModel } from './tiers.js';

const USAGE = `用法：eval:compare [--samples <n>] [--cases <id,id,...>] [--models <label,...>] [--out <dir>] [--floor-only]

  --samples <n>        每題重複幾次，預設 1。取樣是隨機的（temperature 1），
                       n=1 的數字是指示性的，不是定論。
  --cases <id,...>     只跑指定的題目，預設全部。id 見 src/eval/dataset.ts：
                       ${BENCHMARK.map((entry) => entry.id).join(' / ')}
  --models <label,...> 只跑指定的模型，預設全部。短名見 src/eval/tiers.ts：
                       ${MEASURED_MODELS.map((model) => model.label).join(' / ')}
  --floor-only         只印平凡地板（三個不需要模型的 agent 在這份題目上的成功題數），
                       不連外、不需要憑證、不寫結果檔。
  --out <dir>          結果檔放哪個目錄，預設 apps/harness/eval-results/（不進版控）。
                       每次執行逐筆寫進一份 .jsonl，開頭記 commit、題庫與評分程式版本、
                       取樣設定；沒有最後一行 footer 的檔是沒跑完的。

需要環境變數 NVIDIA_API_KEY（見 .env.example）。`;

function formatSpread(spread: { mean: number; min: number; max: number } | undefined): string {
  if (spread === undefined) return '—';
  const mean = spread.mean.toFixed(2);
  // 全距塌成一點時不印它，省得每一行都拖一段沒有資訊的括號。
  if (spread.min === spread.max) return mean;
  return `${mean} (${spread.min.toFixed(2)}–${spread.max.toFixed(2)})`;
}

function printSummary(summary: TierSummary<MeasuredModel>, floor: readonly TierSummary[]): void {
  const { tier } = summary;
  const failed = Object.entries(summary.failures)
    .map(([reason, count]) => `${reason}×${count}`)
    .join(' ');

  console.log(`\n${tier.label}  ${tier.modelId}`);
  console.log(`  上次量它    ${tier.measuredOn} —— ${tier.note}`);
  console.log(`  評到分      ${summary.scored} 次${failed === '' ? '' : `，失敗 ${failed}`}`);
  // **「這題成功」不是下面「工具成功率」那一欄**：後者只問該叫的叫了沒；這一項要三欄全滿、
  // 多叫沒超過容許值（見 `scorers.ts` 的 isCaseSuccess）。分母是評到分的次數。
  console.log(`  這題成功    ${summary.successes}/${summary.scored}`);
  console.log(`    地板      ${formatFloor(floor)}（每題一次，同一份題目）`);
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
function judged(
  summary: TierSummary<MeasuredModel>,
  spread: { count: number } | undefined,
): string {
  if (spread === undefined || spread.count === summary.scored) return '';
  return `（判了 ${spread.count}/${summary.scored} 次）`;
}

/** 沒有可判的那一格印 `—`，不印 `0.00`。理由同 `formatSpread`。 */
function formatScore(value: number | undefined): string {
  return value === undefined ? '—' : value.toFixed(2);
}

function printOutcome(tier: MeasuredModel, outcome: TierOutcome): void {
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

async function runAll(
  models: readonly MeasuredModel[],
  samples: number,
  cases: readonly BenchmarkCase[],
  credentials: CredentialService,
  writer: ResultWriter,
  floor: readonly TierSummary[],
): Promise<void> {
  const reports = await compareTiers(models, {
    // **只換模型 id**（#545）：其餘四格是 schema 預設，不跟任何一台部署的設定走——量的是出貨
    // 那一組設定底下的模型。見 `settings/live-model.ts` 的「eval 不跟這一列走」。
    createModel: (modelId) =>
      createLiveModel(liveModelConfigForModel(modelId), undefined, credentials),
    samples,
    cases,
    onOutcome: (tier, outcome) => {
      writer.append(tier, outcome);
      printOutcome(tier, outcome);
    },
  });
  for (const report of reports) printSummary(summarize(report), floor);
}

async function main(argv: readonly string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return;
  }

  const samples = parseSamples(argv);
  const cases = parseCases(argv);

  if (argv.includes('--floor-only')) {
    const floor = await summarizeFloor(cases);
    console.log(`地板（這題成功，${cases.length} 題）：${formatFloor(floor)}`);
    if (!floorHolds(floor, cases.length)) {
      console.log('**地板不是全 0/題數** —— 有平凡 agent 被判成功，或有執行沒跑完。');
      process.exitCode = 1;
    }
    return;
  }
  const models = parseModels(argv, MEASURED_MODELS);
  const out = parseOut(argv);
  const { credentials, launchEnv } = loadLiveLaunchEnv();
  // 對外代理（#746）：跟 CLI／serve 同一個時間點，載完環境之後、連模型之前。這支腳本跑到行程結束，不另收尾。
  await installLaunchProxy(launchEnv, (message) => console.error(message));

  const scope = cases.length === BENCHMARK.length ? '' : `（${cases.map((c) => c.id).join('、')}）`;
  const who =
    models.length === MEASURED_MODELS.length ? '' : `（${models.map((m) => m.label).join('、')}）`;
  console.log(
    `基準任務：${models.length}/${MEASURED_MODELS.length} 個量過的模型${who}，` +
      `${cases.length}/${BENCHMARK.length} 題${scope}，每題 ${samples} 次取樣，循序跑。` +
      `共 ${models.length * cases.length * samples} 次執行。`,
  );
  console.log(
    `單次執行的上限：迴圈 ${EVAL_RECURSION_LIMIT} 個 super-step（約 ${evalModelRounds(EVAL_RECURSION_LIMIT)} 輪模型呼叫）、` +
      `時鐘 ${EVAL_DEADLINE_MS / 1000} 秒。超過就記成 budget，不是分數。`,
  );

  // 取樣設定從模型實例讀（建構不連外），不在這裡再抄一份字面值。先建檔：建不起來就在花錢之前拋。
  const first = models[0];
  if (first === undefined) throw new Error('沒有要跑的模型');
  const probe = createLiveModel(liveModelConfigForModel(first.modelId), undefined, credentials);
  const writer = startResultFile({
    tool: 'eval:compare',
    argv,
    cases,
    models,
    samples,
    sampling: { temperature: probe.temperature, topP: probe.topP },
    dir: out,
  });
  console.log(`結果檔：${writer.path}（逐筆寫入）`);

  // 地板先跑：零憑證、不連外，幾十毫秒。跑在花錢之前，地板被破了（有平凡 agent 被判成功）
  // 就在這裡看得到，不必等一輪真模型跑完。
  const floor = await summarizeFloor(cases);
  console.log(`地板（三個不需要模型的平凡 agent，這題成功）：${formatFloor(floor)}`);
  if (!floorHolds(floor, cases.length)) {
    console.log(
      '**注意：地板不是全 0/題數 —— 有平凡 agent 被判成功，或有執行沒跑完。** ' +
        '這一輪的「這題成功」不可信，先查評分器（floor.test.ts 在 CI 應該已經紅了）。',
    );
  }

  await runAll(models, samples, cases, credentials, writer, floor);

  const saved = writer.finish();
  console.log(
    `\n結果檔：${writer.path}（${saved.outcomes} 筆）` +
      `${saved.writeFailed ? '。**中途有寫入失敗，檔案不完整**' : ''}`,
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
      `\n注意：有 ${throttledHits} 次執行在重試 ${DEFAULT_LIVE_MAX_RETRIES} 次之後仍然被限流（throttled）。` +
        `**那是我們打太快，不是模型的問題** —— 它跟端點的 4xx 一樣不進平均，但要做的事是` +
        `跑慢一點或調高重試次數，不是換 id。實測這個端點約 120k 的每分鐘 token 配額，` +
        `觸發後十幾秒就恢復。`,
    );
  }
  console.log(
    '\n注意：這份清單跨四個家族，照參數量排出來的線讀不成尺寸效應 —— 那條線在 2026-08-28 結案' +
      '（「沒有效應」，三輪確認），裝置在 #167 收掉。這裡比的是「這幾個模型在同一份題目上表現如何」。',
  );
}

await main(process.argv.slice(2));
