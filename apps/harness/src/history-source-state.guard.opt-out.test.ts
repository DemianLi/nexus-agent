/**
 * 守門：要跑 `log` 的測試檔自己 `vi.unmock`，明寫的 `log` 就真的是 `log`（[#2362](https://github.com/DemianLi/nexus-agent/issues/2362)）。
 *
 * `log-derived-history.log.test.ts` 與 `log-derived-history.agents.log.test.ts` 靠同一個辦法量到 `log`；這一檔走它們那條路
 * （出貨清單＋`--patch` 疊 `source: log`、經 cordis 根），沒 opt out 就會是 `state` 而紅。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('./assembly-root.js');
vi.unmock('./agent-factory.js');

import { createCordisRoot } from './cordis-root.js';
import { loadPluginConfig } from './plugin-config.js';

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'nexus-history-source-guard-'));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/**
 * 出貨清單疊一份 `--patch`（`history-source` 那一列寫 `source: log`），不帶 `--history-source`，經 cordis 根的相容層進
 * `createCliAgent`：跟 `log-derived-history.fixture.ts` 的 `runShippedCli` 同一條路，回組裝實際生效的來源。
 */
async function effectiveSource(): Promise<string> {
  const patch = join(scratch, 'patch.yml');
  await writeFile(patch, JSON.stringify([{ id: 'history-source', config: { source: 'log' } }]));
  const loaded = await loadPluginConfig({ overlays: [patch] });
  const root = createCordisRoot();
  try {
    const assembly = await root.boot('cli', { plugins: loaded.plugins, cwd: scratch });
    const built = await assembly.create({ live: false });
    const source = built.historySource;
    await built.dispose();
    return source;
  } finally {
    await root.dispose();
  }
}

describe('opt out 的測試檔', () => {
  it('patch 明寫 source: log、不帶 --history-source：實際生效的是 log', async () => {
    expect(await effectiveSource()).toBe('log');
  });
});
