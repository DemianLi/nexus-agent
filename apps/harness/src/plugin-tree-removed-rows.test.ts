/**
 * 清單少一列時，`PluginTree.sync` 回傳之前那一列已經收完（[#1636](https://github.com/DemianLi/nexus-agent/issues/1636)，Q1 (d)）。
 *
 * Loader 的 `EntryGroup.remove`（`vendor/loader/src/config/group.ts:44-45`）先把列從 store 刪掉、再 `entry.fiber?.dispose()` 而不等；
 * `loader.await()` 只看 store 裡還在的列（`tree.ts:50-54`）。所以不另外等的話，`sync` 回傳那一刻被刪的列可能還在收。
 *
 * | 驗收 | 在哪 |
 * | --- | --- |
 * | A 被刪的列收完才回傳 | 「被刪的列收完才回傳」 |
 * | B 同一個 id 刪掉馬上加回來，新的掛上時舊的已收完 | 「刪掉又加回來」 |
 * | C 收尾拋錯照常回傳並記下；FAILED 的列不卡住 | 「收尾拋錯」「起不來的列」 |
 *
 * 量具：一顆**遷出的函式插件**，`apply` 裡掛一個要等一下才 resolve 的 async disposer，進出都記在 `globalThis` 的一條清單上。
 * 出貨清單上沒有收尾帶 IO 的插件，所以只能用夾具。
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Message } from '@nexus/cordis';
import { afterEach, describe, expect, it } from 'vitest';

import { createCordisRoot } from './cordis-root.js';
import type { CordisRoot } from './cordis-root.js';
import { loadPluginConfig } from './plugin-config.js';

const temporary: string[] = [];
const roots: CordisRoot[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await root.dispose().catch(() => undefined);
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ECHO_MODULE = import.meta.resolve('@nexus/plugin-echo');

/** 一顆函式插件，`apply` 的本體由呼叫端給。 */
function functionPlugin(id: string, apply: string): string {
  return `import { z } from 'zod';
export const name = ${JSON.stringify(id)};
export const inject = { tools: { range: '^1.0.0' } };
export const Config = z.strictObject({});
export const manifest = {
  id: ${JSON.stringify(id)}, version: '1.0.0', owner: 't',
  provides: [], consumes: [{ token: 'tools', range: '^1.0.0' }],
  config: Config, reload: { code: 'restart', config: 'next-thread' }, capabilities: [],
};
export function apply(ctx, config) { ${apply} }
`;
}

let seed = 0;

interface Fixture {
  readonly root: CordisRoot;
  /** `apply` 與收尾留下的紀錄。 */
  readonly log: string[];
  /** 清單上有沒有那一列：有就疊一份 `insert` 它的 patch。 */
  load(withRow: boolean): ReturnType<typeof loadPluginConfig>;
}

/** 出貨清單只有 echo；要那一列時疊一份 `insert` 它的 patch，不要時不疊——清單少一列走的是 Include 的 `update`。 */
function fixture(apply: (log: string) => string): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-removed-rows-'));
  temporary.push(dir);
  chmodSync(dir, 0o700);
  seed += 1;
  const key = `__removedRows1636_${String(Date.now())}_${String(seed)}`;
  const log: string[] = [];
  (globalThis as Record<string, unknown>)[key] = log;
  const module = join(dir, 'slow.mjs');
  writeFileSync(module, functionPlugin('slow', apply(`globalThis[${JSON.stringify(key)}]`)), {
    mode: 0o600,
  });
  chmodSync(module, 0o600);
  const shipped = join(dir, 'cordis.yml');
  writeFileSync(shipped, `- id: echo\n  name: '${ECHO_MODULE}'\n`, { mode: 0o600 });
  chmodSync(shipped, 0o600);
  const overlay = join(dir, 'insert.yml');
  writeFileSync(overlay, `- insert:\n    - id: slow\n      name: 'file://${module}'\n`, {
    mode: 0o600,
  });
  chmodSync(overlay, 0o600);
  const root = createCordisRoot();
  roots.push(root);
  return {
    root,
    log,
    load: (withRow) =>
      loadPluginConfig(
        { shipped, overlays: withRow ? [overlay] : [], warn: () => undefined },
        { tree: root.tree },
      ),
  };
}

/** `apply` 記一筆，掛一個 300 ms 後才收完的 async disposer，收完記一筆。 */
const slowDisposer = (log: string): string =>
  `${log}.push('apply'); ctx.effect(() => () => new Promise((resolve) => setTimeout(() => { ${log}.push('disposed'); resolve(); }, 300)));`;

describe('清單少一列（#1636）', () => {
  it('被刪的列收完才回傳（驗收 A）', async () => {
    const { log, load } = fixture(slowDisposer);
    const first = await load(true);
    expect(first.dropped).toEqual([]);
    expect(log).toEqual(['apply']);
    await load(false);
    expect(log).toEqual(['apply', 'disposed']);
  }, 60000);

  it('刪掉又加回來：新的那一份掛上時，舊的已經收完（驗收 B）', async () => {
    const { log, load } = fixture(slowDisposer);
    await load(true);
    await load(false);
    await load(true);
    expect(log).toEqual(['apply', 'disposed', 'apply']);
  }, 60000);

  it('收尾拋錯：照常回傳，錯誤交給 logger（驗收 C）', async () => {
    const { root, log, load } = fixture(
      (log) =>
        `${log}.push('apply'); ctx.effect(() => async () => { await new Promise((resolve) => setTimeout(resolve, 100)); ${log}.push('threw'); throw new Error('收尾失敗-1636'); });`,
    );
    const logged: unknown[] = [];
    (await root.tree.context()).logger.exporter({
      export: (message: Message) => {
        if (message.type === 'error') logged.push(...message.args);
      },
    });
    await load(true);
    const after = await load(false);
    expect(log).toEqual(['apply', 'threw']);
    expect(after.dropped).toEqual([]);
    expect(after.plugins.map((plugin) => plugin.id)).toContain('echo');
    expect(
      logged.some((arg) => arg instanceof Error && arg.message.includes('收尾失敗-1636')),
    ).toBe(true);
  }, 60000);

  it('起不來的列（FAILED）被刪：照常回傳、不卡住（驗收 C）', async () => {
    const { log, load } = fixture((log) => `${log}.push('apply'); throw new Error('起不來-1636');`);
    const first = await load(true);
    expect(first.dropped.map((drop) => drop.id)).toEqual(['slow']);
    const after = await load(false);
    expect(log).toEqual(['apply']);
    expect(after.dropped).toEqual([]);
  }, 60000);
});
