/**
 * 注入源延後評估的進入點 —— `pnpm --filter @nexus/harness eval:injection-deferral`。
 * [#2929](https://github.com/DemianLi/nexus-agent/issues/2929)。
 *
 * 問的是「指示檔放不下、整份延後成一行指標之後，模型會不會去讀、讀了會不會照做」。同一份超過上限的 `AGENTS.md` 跑兩邊：
 * 出貨的上限（延後）與調高的上限（整份放進請求），規則在檔頭與檔尾各一格。題目與做法見 [`fixture.ts`](./fixture.ts) 與
 * [`runner.ts`](./runner.ts)。
 *
 * **不進 CI。** 需要 `NVIDIA_API_KEY`，會打真模型。每一次執行 1 到 `DEFERRAL_MAX_REQUESTS` 個請求（看模型叫幾次工具），
 * `--count` 只印下限與上限、不跑；不含傳輸重試。模型是出貨預設那顆，組裝是出貨清單拿掉 `thread-title-llm` 那一列（它另外送請求）。
 *
 * **這裡不設 `LANGSMITH_TRACING`，也不要在跑它的 shell 裡設。**
 */

import { installLaunchProxy } from '../../http-proxy-boot.js';
import { DEFAULT_LIVE_MODEL_ID, LIVE_API_KEY_ENV, loadLiveLaunchEnv } from '../../live-model.js';
import { parseSamples } from '../cli-args.js';
import { DEFERRAL_CASES } from './fixture.js';
import { DEFERRAL_MAX_REQUESTS, runDeferralCase } from './runner.js';
import type { DeferralRun } from './runner.js';

const ratio = (runs: readonly DeferralRun[], pick: (run: DeferralRun) => boolean): string =>
  `${runs.filter(pick).length}/${runs.length}`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const samples = parseSamples(argv);
  const runsPlanned = DEFERRAL_CASES.length * samples;
  console.log(
    `注入源延後評估：${DEFERRAL_CASES.length} 格 × ${samples} 次，共 ${runsPlanned} 到 ${runsPlanned * DEFERRAL_MAX_REQUESTS} 個模型請求` +
      `（每次 1 到 ${DEFERRAL_MAX_REQUESTS} 個；不含重試）。模型 ${DEFAULT_LIVE_MODEL_ID}。`,
  );
  if (argv.includes('--count')) return;

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
    for (const testCase of DEFERRAL_CASES) {
      const label = `第 ${sample + 1} 次 ${testCase.arm}/${testCase.position}`;
      try {
        const run = await runDeferralCase(testCase, {
          live: true,
          credentials,
          // 標題那一顆模型另外送請求，跟量的事無關；拿掉它，請求數才數得準。
          plugins: (shipped) => shipped.filter((entry) => entry.id !== 'thread-title-llm'),
        });
        runs.push(run);
        console.log(
          `  · ${label} 延後 ${run.deferred ? '是' : '否'} 讀 AGENTS.md ${run.readCalls} 次 ` +
            `讀到規則 ${run.ruleRead ? '是' : '否'} 照做 ${run.followed ? '是' : '否'} 請求 ${run.requests} 個` +
            (run.capped ? '（到上限中止）' : ''),
        );
        if (argv.includes('--answers')) console.log(`    ${JSON.stringify(run.finalText)}`);
      } catch (error) {
        failed += 1;
        console.log(`  · ${label} 失敗：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  console.log('\n格            次數  延後  去讀了  讀到規則  照做  請求（合計）');
  for (const testCase of DEFERRAL_CASES) {
    const cell = runs.filter(
      (run) => run.arm === testCase.arm && run.position === testCase.position,
    );
    console.log(
      `${`${testCase.arm}/${testCase.position}`.padEnd(14)}${String(cell.length).padEnd(6)}` +
        `${ratio(cell, (run) => run.deferred).padEnd(6)}${ratio(cell, (run) => run.readCalls > 0).padEnd(8)}` +
        `${ratio(cell, (run) => run.ruleRead).padEnd(10)}${ratio(cell, (run) => run.followed).padEnd(6)}` +
        `${cell.reduce((sum, run) => sum + run.requests, 0)}`,
    );
  }
  console.log(
    `合計 ${runs.reduce((sum, run) => sum + run.requests, 0)} 個有回覆的請求；${failed} 次執行失敗。`,
  );
  if (failed > 0) process.exitCode = 1;
}

await main();
