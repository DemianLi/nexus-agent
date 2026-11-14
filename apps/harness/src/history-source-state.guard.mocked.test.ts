/**
 * 守門的另一半：**沒** `vi.unmock` 時，`history-source-state.setup.ts` 把清單上寫 `log` 的列補成 `state`（[#2362](https://github.com/DemianLi/nexus-agent/issues/2362)）。
 *
 * 這是釘住的債務，不是想要的行為：忘了 unmock 的新 `log` 測試檔會無聲地改跑 `state`。
 * 這一檔紅了代表 mock 變了（例如撤掉了），照 `history-source-state.setup.ts` 檔頭的撤除條件更新它與 opt out 那一半。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
 * `createCliAgent`：`--patch` 變 overlay、再經 cordis 根的相容層進 `createCliAgent` 這一段，與 `log-derived-history.fixture.ts` 的 `runShippedCli` 相同，回組裝實際生效的來源。
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

describe('沒 opt out 的測試檔', () => {
  it('patch 明寫 source: log、不帶 --history-source：被 mock 補成 state', async () => {
    expect(await effectiveSource()).toBe('state');
  });
});
