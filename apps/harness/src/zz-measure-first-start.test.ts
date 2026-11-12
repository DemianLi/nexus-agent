// 量測用，不合併（#2695）：只印第一次起 serve 的分段耗時。
import { cpus, loadavg } from 'node:os';
import { it } from 'vitest';

it('measure first start', async () => {
  const t0 = performance.now();
  process.stderr.write(
    `ENV cpus=${cpus().length} load=${loadavg()
      .map((n) => n.toFixed(1))
      .join(
        ',',
      )} pool=${process.env.VITEST_POOL_ID ?? '-'} worker=${process.env.VITEST_WORKER_ID ?? '-'}\n`,
  );
  const lap = (label: string): void => {
    process.stderr.write(`LAP ${label} ${Math.round(performance.now() - t0)}\n`);
  };
  const fx = await import('./serve-under-test.fixture.js');
  lap('import-fixture');
  const bv = await import('./build-version.js');
  bv.processBuildVersion();
  lap('processBuildVersion(git)');
  const a = await fx.startServeUnderTest({ argv: ['--port', '0'], log: () => undefined, env: {} });
  lap('first-start');
  await a?.close();
  const b = await fx.startServeUnderTest({ argv: ['--port', '0'], log: () => undefined, env: {} });
  lap('second-start');
  await b?.close();
}, 60_000);
