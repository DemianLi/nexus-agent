/**
 * 注入源預算評估的進入點 —— `pnpm --filter @nexus/harness eval:injection-deferral`。
 * [#2929](https://github.com/DemianLi/nexus-agent/issues/2929)。
 *
 * 問的是「指示檔放不下、`agent-instructions` 把它截到預算上限並通知其餘用 `read_file` 讀之後，模型看得到多少、會不會去讀其餘的、
 * 讀了會不會照做」。同一份 `AGENTS.md` 跑放不下與放得下兩邊：大檔四格（規則在檔頭或檔尾），小檔三格（放得下一格，放不下兩格，
 * 規則在檔頭或檔尾），`--only large|small` 只跑其中一種。報表的「規則已在請求」是截斷後模型第一個請求就看得到規則的比例，
 * 「去讀了」是模型自己去讀的比例；兩欄分開，才看得出照做是因為看到了還是因為讀了。題目見 [`fixture.ts`](./fixture.ts)，
 * 判定見 [`runner.ts`](./runner.ts)。
 *
 * **不進 CI。** 需要 `NVIDIA_API_KEY`，會打真模型。每一次執行 1 到 `DEFERRAL_MAX_REQUESTS + 1` 個請求（看模型叫幾次工具；
 * 重試的每一次嘗試也算，超過上限的那一個可能已經送出）。`--samples N` 每格跑幾次（省略即 1），`--count` 只印下限與上限、不跑，
 * `--answers` 連每一次最後的回覆一起印。模型是出貨預設那顆，組裝是出貨清單拿掉 `thread-title-llm` 那一列（它另外送請求）。
 *
 * **`LANGSMITH_TRACING` 有值就不跑。** 這裡跑的是真的 agent，題目、工具參數與回覆會跟著 trace 出境。
 */

import { installLaunchProxy } from '../../http-proxy-boot.js';
import { DEFAULT_LIVE_MODEL_ID, LIVE_API_KEY_ENV, loadLiveLaunchEnv } from '../../live-model.js';
import { parseSamples } from '../cli-args.js';
import { DEFERRAL_CASES, deferralCaseId } from './fixture.js';
import type { DeferralCase } from './fixture.js';
import { DEFERRAL_MAX_REQUESTS, runDeferralCase } from './runner.js';
import type { DeferralRun } from './runner.js';

const ratio = (runs: readonly DeferralRun[], pick: (run: DeferralRun) => boolean): string =>
  `${runs.filter(pick).length}/${runs.length}`;

/** `--only large|small`：只跑那一種檔的格子；省略即全部。 */
function parseOnly(argv: readonly string[]): readonly DeferralCase[] {
  const at = argv.indexOf('--only');
  if (at < 0) return DEFERRAL_CASES;
  const file = argv[at + 1];
  if (file !== 'large' && file !== 'small') {
    throw new Error(`--only 要 large 或 small，收到 ${file ?? '（空的）'}`);
  }
  return DEFERRAL_CASES.filter((testCase) => testCase.file === file);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const samples = parseSamples(argv);
  const cases = parseOnly(argv);
  const runsPlanned = cases.length * samples;
  console.log(
    `注入源預算評估：${cases.length}/${DEFERRAL_CASES.length} 格 × ${samples} 次，共 ${runsPlanned} 到 ${runsPlanned * (DEFERRAL_MAX_REQUESTS + 1)} 個模型請求` +
      `（每次 1 到 ${DEFERRAL_MAX_REQUESTS + 1} 個，重試也算）。模型 ${DEFAULT_LIVE_MODEL_ID}。`,
  );
  if (argv.includes('--count')) return;
  if ((process.env.LANGSMITH_TRACING ?? '') !== '') {
    throw new Error('LANGSMITH_TRACING 有值：題目與回覆會跟著 trace 出境，請先 unset 再跑');
  }

  const { credentials, launchEnv, keySourceOf, assertKeyLocated } = loadLiveLaunchEnv({
    store: false,
  });
  assertKeyLocated(LIVE_API_KEY_ENV);
  const keySource = keySourceOf(LIVE_API_KEY_ENV);
  if (keySource !== undefined) console.error(keySource);
  await installLaunchProxy(launchEnv, (message) => console.error(message));

  const runs: DeferralRun[] = [];
  let failed = 0;
  for (let sample = 0; sample < samples; sample += 1) {
    for (const testCase of cases) {
      const label = `第 ${sample + 1} 次 ${deferralCaseId(testCase)}`;
      try {
        const run = await runDeferralCase(testCase, {
          live: true,
          credentials,
          // 標題那一顆另外送一個請求，不經這一輪的 callbacks、不算進上限；拿掉它，開頭印的請求數才是實際打到端點的數。
          plugins: (shipped) => shipped.filter((entry) => entry.id !== 'thread-title-llm'),
        });
        runs.push(run);
        console.log(
          `  · ${label} 延後 ${run.deferred ? '是' : '否'} 讀 AGENTS.md ${run.readCalls} 次 ` +
            `規則已在請求 ${run.ruleInjected ? '是' : '否'} 讀到規則 ${run.ruleRead ? '是' : '否'} 照做 ${run.followed ? '是' : '否'} 請求 ${run.requests} 個` +
            (run.capped ? '（到上限中止）' : ''),
        );
        if (argv.includes('--answers')) console.log(`    ${JSON.stringify(run.finalText)}`);
      } catch (error) {
        failed += 1;
        console.log(`  · ${label} 失敗：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  console.log(
    '\n格                    次數  延後  去讀了  規則已在請求  讀到規則  照做  請求（合計）',
  );
  for (const testCase of cases) {
    const all = runs.filter((run) => run.testCase === testCase);
    // 被中止的那幾次拿不到訊息串，不算進比例；請求數照算。
    const cell = all.filter((run) => !run.capped);
    console.log(
      `${deferralCaseId(testCase).padEnd(22)}${String(cell.length).padEnd(6)}` +
        `${ratio(cell, (run) => run.deferred).padEnd(6)}${ratio(cell, (run) => run.readCalls > 0).padEnd(8)}` +
        `${ratio(cell, (run) => run.ruleInjected).padEnd(14)}${ratio(cell, (run) => run.ruleRead).padEnd(10)}${ratio(cell, (run) => run.followed).padEnd(6)}` +
        `${all.reduce((sum, run) => sum + run.requests, 0)}` +
        (all.length > cell.length
          ? `（另有 ${all.length - cell.length} 次到上限中止，不在比例裡）`
          : ''),
    );
  }
  console.log(
    `合計 ${runs.reduce((sum, run) => sum + run.requests, 0)} 個有回覆的請求；${failed} 次執行失敗。`,
  );
  if (failed > 0) process.exitCode = 1;
}

await main();
