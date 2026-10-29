/**
 * CLI 的 `--resume` 也照 `thread-capacity` 的 `sessionLogBudgetMiB` 收日誌（[#2115](https://github.com/DemianLi/nexus-agent/issues/2115)）：
 * 拒收訊息叫人調的那個設定，CLI 讀得到。
 *
 * 判準只看 `stat` 的大小，所以把日誌尾巴灌到 1 MiB 以上就夠：額度 1 MiB 時在讀之前拒收；不寫那一格時照記憶體自動算
 * （遠大於 1 MiB），日誌照常被讀，結果是什麼都不會是「太大」。
 */

import { appendFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { PERMISSION_COMMAND_NAME } from '@nexus/permission-presets';
import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from './cli.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function cli(argv: readonly string[], lines = '/exit\n'): Promise<void> {
  const input = new PassThrough();
  input.end(lines);
  const ignore = (): void => undefined;
  await runCli({
    argv: [...argv],
    input,
    output: new PassThrough(),
    printer: { log: ignore, error: ignore },
  });
}

describe('CLI 的會話日誌額度', () => {
  it('寫了 sessionLogBudgetMiB 就照它拒收；不寫照記憶體自動算', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-cli-log-budget-'));
    roots.push(root);
    const logs = join(root, 'logs');
    await cli(['--session-log', logs], `/${PERMISSION_COMMAND_NAME} read-only\n/exit\n`);
    const [run] = await readdir(logs);
    const runDir = join(logs, run!);
    const log = (await readdir(runDir)).find((name) => name.endsWith('.jsonl'));
    await appendFile(join(runDir, log!), 'x'.repeat(1024 * 1024 + 1));

    const patch = join(root, 'budget.patch.yml');
    await writeFile(patch, '- id: thread-capacity\n  config:\n    sessionLogBudgetMiB: 1\n');
    await expect(cli(['--patch', patch, '--resume', runDir])).rejects.toThrow(
      /超過這個行程能收的 1\.0 MiB/u,
    );

    const unconfigured = await cli(['--resume', runDir]).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(String(unconfigured)).not.toContain('超過這個行程能收的');
  });
});
