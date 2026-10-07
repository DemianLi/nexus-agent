/**
 * 量同一個 plugin 的兩個版本並存與記憶體累積（見 `plugin-coexist.ts`，[#1139](https://github.com/DemianLi/nexus-agent/issues/1139)）。不進 CI。
 *
 * ```bash
 * # 並存、各被不同 thread 使用、舊版不再被呼叫（四種組合）
 * pnpm --filter @nexus/harness exec tsx src/measure/plugin-coexist-cli.ts verify
 * # 記憶體累積：一種組合，輸出原始取樣（JSON Lines）與擬合斜率
 * pnpm --filter @nexus/harness exec tsx src/measure/plugin-coexist-cli.ts memory --mode dir --ext ts --ballast-kb 300 --private-zod --updates 50
 * # 全部組合各開一個乾淨的行程跑
 * pnpm --filter @nexus/harness exec tsx src/measure/plugin-coexist-cli.ts matrix --updates 50
 * ```
 */

import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fitSlope, measureAccumulation, verifyCoexistence } from './plugin-coexist.js';
import type { Ext, LoadMode } from './plugin-coexist.js';

const command = process.argv[2];
const { values } = parseArgs({
  args: process.argv.slice(3),
  options: {
    mode: { type: 'string', default: 'dir' },
    ext: { type: 'string', default: 'ts' },
    'ballast-kb': { type: 'string', default: '300' },
    'private-zod': { type: 'boolean', default: false },
    updates: { type: 'string', default: '50' },
    'sample-every': { type: 'string', default: '5' },
    control: { type: 'boolean', default: false },
  },
});

if (command === 'verify') {
  for (const mode of ['dir', 'query'] as const) {
    for (const ext of ['ts', 'mjs'] as const) {
      const report = await verifyCoexistence({ mode, ext, ballastKb: 5, privateZod: false });
      console.log(JSON.stringify(report));
    }
  }
} else if (command === 'memory') {
  const options = {
    mode: values.mode as LoadMode,
    ext: values.ext as Ext,
    ballastKb: Number(values['ballast-kb']),
    privateZod: values['private-zod'],
    updates: Number(values.updates),
    sampleEvery: Number(values['sample-every']),
    sameUrlControl: values.control,
  };
  const samples = await measureAccumulation(options);
  for (const sample of samples)
    console.log(JSON.stringify({ kind: 'sample', ...options, ...sample }));
  console.log(
    JSON.stringify({
      kind: 'fit',
      ...options,
      heapPerUpdateMb: fitSlope(samples, (s) => s.heapUsedMb),
      rssPerUpdateMb: fitSlope(samples, (s) => s.rssMb),
      codePerUpdateMb: fitSlope(samples, (s) => s.codeSpaceMb),
    }),
  );
} else if (command === 'matrix') {
  const runs: string[][] = [];
  for (const mode of ['dir', 'query']) {
    for (const ext of ['ts', 'mjs']) {
      for (const ballast of ['5', '300']) {
        runs.push(['--mode', mode, '--ext', ext, '--ballast-kb', ballast]);
        if (mode === 'dir')
          runs.push(['--mode', mode, '--ext', ext, '--ballast-kb', ballast, '--private-zod']);
      }
    }
  }
  runs.push(['--mode', 'dir', '--ext', 'ts', '--ballast-kb', '300', '--control']);
  for (const run of runs) {
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        import.meta.filename,
        'memory',
        ...run,
        '--updates',
        values.updates!,
        '--sample-every',
        values['sample-every']!,
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    process.stdout.write(child.stdout);
    if (child.status !== 0) process.stderr.write(child.stderr);
  }
} else {
  console.error('用法：verify | memory [...] | matrix [--updates N]');
  process.exitCode = 2;
}
