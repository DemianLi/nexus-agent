/**
 * [#1386](https://github.com/DemianLi/nexus-agent/issues/1386) 驗收 ④：Loader 的樹由 append-only 的變更紀錄導出，不 fork Include，Loader 不寫回任何 YAML。
 *
 * 範圍：這裡每一列都是 `cordis:` 開頭的內建插件。按套件名（裸 specifier）載入的列會經過 `createResolve`，
 * 在設定目錄寫出 `.cordis/{.gitignore,resolve.mjs}`——那不是樹的狀態，但確實是寫檔；最後一條正對照就是量它。
 *
 * 有牙的三件事：
 *
 * 1. Loader **自己發起**的變更也落進紀錄——插件 `ctx.fiber.dispose()` 自我停用（上游 index.ts 裡處理自我停用的那一格寫 `disabled: true`）、
 *    插件 `ctx.fiber.update()` 改自己的設定（`internal/commit`）。
 * 2. 同一份紀錄導出的樹與現場的樹逐欄相同：逐筆重播一次、冷啟動折成列表交給 `root.update()` 一次。
 * 3. （內建插件的列）寫檔次數為零靠 spy `node:fs` 與 `node:fs/promises` 的寫入函式證明；另有一條正對照，證明 spy 抓得到 vendor 裡真的寫檔的那條路。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Context } from '@nexus/cordis';
import { Group } from '@nexus/cordis-plugin-loader';
import type { EntryGroup, Loader } from '@nexus/cordis-plugin-loader';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChangeJournal, JournaledLoader, fold } from './journal.js';
import type { ChangeRecord } from './journal.js';
import { STATE, boot } from './tree.js';

const writes = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  const spy =
    <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
    (...args: A): R => {
      writes.calls.push(`${name} ${String(args[0])}`);
      return fn(...args);
    };
  const patched = {
    ...original,
    writeFile: spy('writeFile', original.writeFile),
    appendFile: spy('appendFile', original.appendFile),
    rename: spy('rename', original.rename),
    mkdir: spy('mkdir', original.mkdir),
  };
  return { ...patched, default: patched };
});

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  const spy =
    <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
    (...args: A): R => {
      writes.calls.push(`${name} ${String(args[0])}`);
      return fn(...args);
    };
  const patched = {
    ...original,
    writeFileSync: spy('writeFileSync', original.writeFileSync),
    appendFileSync: spy('appendFileSync', original.appendFileSync),
    renameSync: spy('renameSync', original.renameSync),
    mkdirSync: spy('mkdirSync', original.mkdirSync),
  };
  return { ...patched, default: patched };
});

beforeEach(() => {
  writes.calls.length = 0;
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 一列設定不變、什麼都不做的插件。 */
const plain = { name: 'plain', apply() {} };
/** 啟動後自己 `ctx.fiber.dispose()`。 */
const quitter = {
  name: 'quitter',
  apply(ctx: Context) {
    void Promise.resolve().then(() => ctx.fiber.dispose());
  },
};
/** 啟動後把自己的設定改成 `{ level: 2 }`。 */
const tuner = {
  name: 'tuner',
  apply(ctx: Context, config: { level?: number } | undefined) {
    if (config?.level !== 2) void Promise.resolve().then(() => ctx.fiber.update({ level: 2 }));
  },
};
const BUILTINS = { plain, quitter, tuner, group: Group };

/**
 * 樹的逐欄快照：每一列的選項、有沒有在跑、group 的子列，鍵排序後序列化。
 * 比「有沒有在跑」而不是 fiber 狀態：停用的列在現場留著一個已卸載的 fiber（DISPOSED），冷啟動時根本沒建 fiber——那是歷史，不是樹。
 */
function snapshot(loader: Loader): string {
  const walk = (group: EntryGroup): unknown[] =>
    group.data.map((options) => {
      const entry = loader.store[options.id];
      const { config, ...rest } = options;
      return {
        ...rest,
        ...(options.group ? { children: walk(entry!.subgroup!) } : { config }),
        active: entry?.fiber?.state === STATE.ACTIVE,
      };
    });
  return JSON.stringify(walk(loader.root), (_key, value: unknown) =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  );
}

/** 後台的一串操作。 */
const ADMIN: ChangeRecord[] = [
  {
    op: 'create',
    parent: null,
    options: { id: 'tools', name: 'cordis:group', group: true, config: [] },
  },
  {
    op: 'create',
    parent: null,
    options: { id: 'echo', name: 'cordis:plain', config: { greeting: 'hi' } },
  },
  { op: 'create', parent: 'tools', options: { id: 'todo', name: 'cordis:plain', config: {} } },
  { op: 'create', parent: 'tools', options: { id: 'memory', name: 'cordis:plain' } },
  { op: 'update', id: 'echo', options: { config: { greeting: 'hello' } } },
  { op: 'update', id: 'memory', options: {}, parent: null, position: 0 },
  { op: 'update', id: 'todo', options: { disabled: true } },
  { op: 'create', parent: 'tools', options: { id: 'quitter', name: 'cordis:quitter' } },
  {
    op: 'create',
    parent: null,
    options: { id: 'tuner', name: 'cordis:tuner', config: { level: 1 } },
  },
  { op: 'remove', id: 'echo' },
];

/** 照 ADMIN 跑一棵現場的樹，回傳樹與紀錄。 */
async function live() {
  const t = await boot(BUILTINS);
  const journal = new ChangeJournal();
  const journaled = new JournaledLoader(t.loader, journal);
  for (const record of ADMIN) {
    await journaled.apply(record);
    await t.loader.await();
    await tick();
  }
  await t.loader.await();
  await tick();
  return { ...t, journal };
}

describe('Loader 的樹由變更紀錄導出（#1386 ④）', () => {
  it('Loader 自己發起的變更落進紀錄：自我停用與插件改自己的設定', async () => {
    const t = await live();
    const records = t.journal.records;
    // 管理動作原樣在裡面，順序不變。
    const admin = records.filter((record) =>
      ADMIN.some((a) => JSON.stringify(a) === JSON.stringify(record)),
    );
    expect(admin).toHaveLength(ADMIN.length);
    // 額外的兩筆是 Loader 回報的。
    const extra = records.filter((record) => !admin.includes(record));
    expect(extra).toEqual([
      { op: 'update', id: 'quitter', options: { disabled: true } },
      { op: 'update', id: 'tuner', options: { config: { level: 2 } } },
    ]);
    expect(t.state('quitter')).toBe(STATE.DISPOSED);
    expect(t.loader.resolve('tuner').options.config).toEqual({ level: 2 });
    // 紀錄是凍結的：只能往後加。
    expect(Object.isFrozen(records[0])).toBe(true);
  });

  it('逐筆重播到一顆全新的 Loader：樹逐欄相同', async () => {
    const t = await live();
    const fresh = await boot(BUILTINS);
    const replayed = new JournaledLoader(fresh.loader, new ChangeJournal());
    for (const record of t.journal.records) {
      await replayed.apply(record);
      await fresh.loader.await();
      await tick();
    }
    expect(snapshot(fresh.loader)).toBe(snapshot(t.loader));
  });

  it('冷啟動：紀錄折成列表交給 root.update()（Include 讀完 YAML 後走的那個呼叫），樹逐欄相同', async () => {
    const t = await live();
    const fresh = await boot(BUILTINS);
    new JournaledLoader(fresh.loader, new ChangeJournal());
    await fresh.loader.root.update(fold(t.journal.records));
    await fresh.loader.await();
    await tick();
    expect(snapshot(fresh.loader)).toBe(snapshot(t.loader));
  });

  it('負對照：紀錄少一筆（搬家那一筆），導出的樹就不同——快照比對有牙', async () => {
    const t = await live();
    const missing = t.journal.records.filter(
      (record) => !(record.op === 'update' && record.id === 'memory'),
    );
    expect(missing).toHaveLength(t.journal.records.length - 1);
    const fresh = await boot(BUILTINS);
    new JournaledLoader(fresh.loader, new ChangeJournal());
    await fresh.loader.root.update(fold(missing));
    await fresh.loader.await();
    await tick();
    expect(snapshot(fresh.loader)).not.toBe(snapshot(t.loader));
  });

  it('內建插件的列：整個過程沒有任何寫檔', async () => {
    const t = await live();
    const fresh = await boot(BUILTINS);
    await fresh.loader.root.update(fold(t.journal.records));
    await fresh.loader.await();
    expect(writes.calls).toEqual([]);
  });

  it('正對照：spy 抓得到 vendor Loader 唯一寫檔的那條路（裸 specifier 的解析輔助檔）', async () => {
    // 放 harness 的 node_modules 底下：掃整棵樹的測試都略過那裡。
    const dir = await mkdtemp(join(import.meta.dirname, '../../../node_modules/.resolve-probe-'));
    try {
      writeFileSync(join(dir, 'package.json'), '{}');
      writes.calls.length = 0;
      // 深路徑用字串變數 import：寫成字面值的話 tsc 會把 vendor 原始碼拉進 harness 的型別檢查（見 ① 的 (c)）。
      const specifier = '@nexus/cordis-plugin-loader/src/resolve.ts';
      const { createResolve } = (await import(specifier)) as {
        createResolve: (baseUrl: string) => Promise<unknown>;
      };
      await createResolve(pathToFileURL(join(dir, 'cordis.yml')).href);
      expect(writes.calls.some((call) => call.startsWith('writeFile '))).toBe(true);
      expect(writes.calls.some((call) => call.startsWith('rename '))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
