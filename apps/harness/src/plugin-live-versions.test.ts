/**
 * 「活著的設定版本 → thread」那張表的單元測試（[#1442](https://github.com/DemianLi/nexus-agent/issues/1442)）。
 *
 * 清單不手搭：同 `plugin-snapshot.test.ts`，兩份清單都是 `loadDefaultPlugins` 真的讀出來的。產品路徑（serve 開兩條 thread、
 * 改設定、讀快照檔）在 `serve-live-versions.test.ts`。
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { HARNESS_HOME_ENV } from './harness-home.js';
import { loadDefaultPlugins } from './plugin-config.js';
import type { LoadedPluginConfig } from './plugin-config.js';
import { createLiveVersionTable, liveBindingsOf } from './plugin-live-versions.js';
import { buildPluginSnapshot } from './plugin-snapshot.js';
import type { SnapshotSource } from './plugin-snapshot.js';
import { declarationSignature } from './plugin-row-state.js';
import { hmacHashOf } from './session-header-metadata.js';

const temporary: string[] = [];
const AT = new Date('2026-10-15T00:00:00.000Z');
const KEY = Buffer.from('k'.repeat(32));

afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function load(patch?: string): Promise<LoadedPluginConfig> {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-live-versions-'));
  temporary.push(dir);
  chmodSync(dir, 0o700);
  if (patch !== undefined) {
    const file = join(dir, 'cordis.patch.yml');
    writeFileSync(file, patch);
    chmodSync(file, 0o600);
  }
  return loadDefaultPlugins({ serve: true, env: { [HARNESS_HOME_ENV]: dir }, warn: () => {} });
}

function sourceOf(loaded: LoadedPluginConfig): SnapshotSource {
  return {
    entries: loaded.entries,
    ids: loaded.ids,
    plugins: loaded.plugins,
    rows: loaded.rows,
    drops: loaded.dropped.map(({ id, stage }) => ({ id, stage })),
  };
}

const idsOf = (bindings: readonly { readonly id: string }[]): string[] =>
  bindings.map((binding) => binding.id);

describe('declarationSignature：判「同一份宣告」的那一把尺', () => {
  it('undefined 與 {} 是同一份；鍵順序不影響', () => {
    expect(declarationSignature('r', 'm', undefined)).toBe(declarationSignature('r', 'm', {}));
    expect(declarationSignature('r', 'm', { a: 1, b: 2 })).toBe(
      declarationSignature('r', 'm', { b: 2, a: 1 }),
    );
  });

  it('列 id、模組名、設定任何一格不同就是另一份', () => {
    const base = declarationSignature('r', 'm', { a: 1 });
    expect(declarationSignature('s', 'm', { a: 1 })).not.toBe(base);
    expect(declarationSignature('r', 'n', { a: 1 })).not.toBe(base);
    expect(declarationSignature('r', 'm', { a: 2 })).not.toBe(base);
  });
});

describe('liveBindingsOf：只綁實際掛上的列', () => {
  it('掛上的列都在，簽章就是 declarationSignature(id, 宣告的模組名, 宣告的設定)', async () => {
    const loaded = await load();
    const bindings = liveBindingsOf({ loaded, plugins: loaded.plugins }, []);
    const todo = bindings.find((binding) => binding.id === 'todo');
    const declared = loaded.entries[loaded.ids.indexOf('todo')];
    expect(declared).toBeDefined();
    expect(todo?.signature).toBe(declarationSignature('todo', declared!.name, declared!.config));
    // 樹上的列（echo）與相容層的列（todo）一視同仁。
    expect(idsOf(bindings)).toEqual(expect.arrayContaining(['echo', 'todo', 'goal']));
  });

  it('起動期讀的 13 列不進表', async () => {
    const loaded = await load();
    const ids = idsOf(liveBindingsOf({ loaded, plugins: loaded.plugins }, []));
    for (const startupRead of ['thread-title', 'live-model', 'browser-session', 'spill-policy']) {
      expect(ids, startupRead).not.toContain(startupRead);
    }
  });

  it('停用的列不綁', async () => {
    const loaded = await load('- id: todo\n  disabled: true\n');
    const ids = idsOf(liveBindingsOf({ loaded, plugins: loaded.plugins }, []));
    expect(ids).not.toContain('todo');
    expect(ids).toContain('goal');
  });

  it('這條 thread 組裝時掉的列不綁（用掉的來源那一列，沒有就用條目自己那一列）', async () => {
    const loaded = await load();
    const entry = loaded.plugins.find((candidate) => loaded.rows.get(candidate)?.id === 'todo')!;
    const byEntry = idsOf(liveBindingsOf({ loaded, plugins: loaded.plugins }, [{ entry }]));
    expect(byEntry).not.toContain('todo');
    const goal = loaded.plugins.find((candidate) => loaded.rows.get(candidate)?.id === 'goal')!;
    const byOrigin = idsOf(
      liveBindingsOf({ loaded, plugins: loaded.plugins }, [
        { entry: goal, drop: { origin: { id: 'todo' } } },
      ]),
    );
    // 掉的來源是 todo：todo 不綁，goal 照綁。
    expect(byOrigin).not.toContain('todo');
    expect(byOrigin).toContain('goal');
  });

  it('交給組裝的清單上沒有那一顆（模組那一步就掉了）：不綁', async () => {
    const loaded = await load();
    const without = loaded.plugins.filter((entry) => loaded.rows.get(entry)?.id !== 'todo');
    const ids = idsOf(liveBindingsOf({ loaded, plugins: without }, []));
    expect(ids).not.toContain('todo');
  });

  it('同一份宣告、設定改回原值：簽章相同；改成別的值：簽章不同', async () => {
    const original = await load();
    const changed = await load('- id: todo\n  config:\n    allowParallelInProgress: false\n');
    const again = await load('- id: todo\n  config:\n    allowParallelInProgress: true\n');
    const sig = async (loaded: LoadedPluginConfig) =>
      liveBindingsOf({ loaded, plugins: loaded.plugins }, []).find((b) => b.id === 'todo')
        ?.signature;
    expect(await sig(changed)).not.toBe(await sig(original));
    // 出貨值就是 `allowParallelInProgress: true`：明寫一遍宣告字串變了，（模組名＋設定）的簽章沒變。
    expect(await sig(again)).toBe(await sig(original));
  });
});

describe('createLiveVersionTable', () => {
  const binding = (id: string, signature: string) => ({ id, signature });

  it('同一列同一版的 thread 歸在一起，不同版分開，順序是第一次出現的順序', () => {
    const table = createLiveVersionTable();
    table.bind('t1', [binding('todo', 'v1')]);
    table.bind('t2', [binding('todo', 'v1')]);
    table.bind('t3', [binding('todo', 'v2')]);
    const versions = table.rows().get('todo');
    expect([...(versions?.keys() ?? [])]).toEqual(['v1', 'v2']);
    expect([...(versions?.get('v1') ?? [])]).toEqual(['t1', 't2']);
    expect([...(versions?.get('v2') ?? [])]).toEqual(['t3']);
  });

  it('放掉只拿掉自己：最後一個放掉，那一版與那一列都不再出現', () => {
    const table = createLiveVersionTable();
    const release1 = table.bind('t1', [binding('todo', 'v1')]);
    const release2 = table.bind('t2', [binding('todo', 'v1'), binding('goal', 'g1')]);
    release1();
    expect([...(table.rows().get('todo')?.get('v1') ?? [])]).toEqual(['t2']);
    release2();
    expect(table.rows().size).toBe(0);
  });

  it('放掉兩次是空操作；同一個 thread id 再綁一次，先放掉上一次的', () => {
    const table = createLiveVersionTable();
    const first = table.bind('t1', [binding('todo', 'v1')]);
    const second = table.bind('t1', [binding('todo', 'v2')]);
    // 第一次的放掉已經被第二次的綁定換掉：什麼也不放。
    first();
    expect([...(table.rows().get('todo')?.keys() ?? [])]).toEqual(['v2']);
    second();
    second();
    expect(table.rows().size).toBe(0);
  });

  it('rows() 回的是一份拷貝：之後的綁定不改已經拿到的', () => {
    const table = createLiveVersionTable();
    table.bind('t1', [binding('todo', 'v1')]);
    const before = table.rows();
    table.bind('t2', [binding('todo', 'v1')]);
    expect([...(before.get('todo')?.get('v1') ?? [])]).toEqual(['t1']);
  });
});

describe('buildPluginSnapshot 的 live', () => {
  const sign = (signature: string): string => hmacHashOf(signature, KEY);

  it('每一版一項：version 是帶鍵雜湊、current 以 saved 那份清單為準、threads 排序', async () => {
    const [running, saved] = [
      await load(),
      await load('- id: todo\n  config:\n    allowParallelInProgress: false\n'),
    ];
    const oldSignature = liveBindingsOf({ loaded: running, plugins: running.plugins }, []).find(
      (b) => b.id === 'todo',
    )!.signature;
    const newSignature = liveBindingsOf({ loaded: saved, plugins: saved.plugins }, []).find(
      (b) => b.id === 'todo',
    )!.signature;
    const table = createLiveVersionTable();
    table.bind('b', [{ id: 'todo', signature: oldSignature }]);
    table.bind('a', [{ id: 'todo', signature: oldSignature }]);
    table.bind('c', [{ id: 'todo', signature: newSignature }]);
    const snapshot = buildPluginSnapshot({
      running: sourceOf(running),
      saved: sourceOf(saved),
      generatedAt: AT,
      live: { rows: table.rows(), sign },
    });
    const row = snapshot.rows.find((candidate) => candidate.id === 'todo');
    expect(row?.live).toEqual([
      { version: sign(oldSignature), current: false, threads: ['a', 'b'] },
      { version: sign(newSignature), current: true, threads: ['c'] },
    ]);
    expect(row?.live?.[0]?.version).toMatch(/^hmac-sha256:[0-9a-f]{16}$/u);
  });

  it('沒有 thread 綁著的列整格省略；沒給 live 就一列都沒有（開機後的樣子與以前逐位元組相同）', async () => {
    const loaded = await load();
    const without = buildPluginSnapshot({
      running: sourceOf(loaded),
      saved: sourceOf(loaded),
      generatedAt: AT,
    });
    const emptyTable = buildPluginSnapshot({
      running: sourceOf(loaded),
      saved: sourceOf(loaded),
      generatedAt: AT,
      live: { rows: createLiveVersionTable().rows(), sign },
    });
    expect(JSON.stringify(emptyTable)).toBe(JSON.stringify(without));
    expect(without.rows.some((row) => 'live' in row)).toBe(false);

    const table = createLiveVersionTable();
    table.bind('t1', [{ id: 'todo', signature: 'x' }]);
    const one = buildPluginSnapshot({
      running: sourceOf(loaded),
      saved: sourceOf(loaded),
      generatedAt: AT,
      live: { rows: table.rows(), sign },
    });
    expect(one.rows.filter((row) => 'live' in row).map((row) => row.id)).toEqual(['todo']);
  });

  it('設定明文不進檔：快照序列化之後找不到簽章裡的秘密', async () => {
    const secret = 'secret-token-1442';
    const loaded = await load(`- id: todo\n  config:\n    allowParallelInProgress: '${secret}'\n`);
    const signature = declarationSignature('todo', 'x', { allowParallelInProgress: secret });
    expect(signature).toContain(secret);
    const table = createLiveVersionTable();
    table.bind('t1', [{ id: 'todo', signature }]);
    const snapshot = buildPluginSnapshot({
      running: sourceOf(loaded),
      saved: sourceOf(loaded),
      generatedAt: AT,
      live: { rows: table.rows(), sign },
    });
    expect(JSON.stringify(snapshot)).not.toContain(secret);
  });
});
