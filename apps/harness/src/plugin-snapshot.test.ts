/**
 * 「已儲存 vs 執行中」對照的單元測試（[#1406](https://github.com/DemianLi/nexus-agent/issues/1406)）。
 *
 * 清單不手搭：兩份都是 `loadDefaultPlugins` 真的讀出來的（一份是啟動那一刻，一份是改了 home 層 patch 之後），這樣
 * 量到的是產品路徑上的 `entries`／`ids`／`rows`，不是一份跟實際長得不一樣的假清單。
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { HARNESS_HOME_ENV } from './harness-home.js';
import { loadDefaultPlugins } from './plugin-config.js';
import type { LoadedPluginConfig } from './plugin-config.js';
import {
  buildPluginSnapshot,
  createPluginSnapshotWriter,
  PLUGIN_SNAPSHOT_FILE_NAME,
} from './plugin-snapshot.js';
import type { PluginSnapshot, SnapshotSource } from './plugin-snapshot.js';

const temporary: string[] = [];
const AT = new Date('2026-10-12T00:00:00.000Z');

afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-plugin-snapshot-'));
  temporary.push(dir);
  chmodSync(dir, 0o700);
  return dir;
}

/** 在一個空的 harness home 底下，用這份 patch 讀一次出貨清單。 */
async function load(patch?: string): Promise<LoadedPluginConfig> {
  const dir = tmp();
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

async function compare(
  running: string | undefined,
  saved: string | undefined,
  classify?: Parameters<typeof buildPluginSnapshot>[0]['classify'],
): Promise<{ snapshot: PluginSnapshot; byId: (id: string) => PluginSnapshot['rows'][number] }> {
  const [a, b] = [await load(running), await load(saved)];
  const snapshot = buildPluginSnapshot({
    running: sourceOf(a),
    saved: sourceOf(b),
    generatedAt: AT,
    ...(classify !== undefined && { classify }),
  });
  return {
    snapshot,
    byId(id) {
      const row = snapshot.rows.find((candidate) => candidate.id === id);
      if (row === undefined) throw new Error(`快照上沒有 ${id}`);
      return row;
    },
  };
}

describe('buildPluginSnapshot', () => {
  it('沒有改任何東西：每一列都是 same，列數同出貨清單', async () => {
    const loaded = await load();
    const { snapshot } = await compare(undefined, undefined);
    expect(snapshot.rows).toHaveLength(loaded.ids.length);
    expect(snapshot.rows.map((row) => row.id)).toEqual([...loaded.ids]);
    expect(snapshot.summary).toEqual({ same: loaded.ids.length, 'next-thread': 0, restart: 0 });
    expect(snapshot.rows.every((row) => row.running.state === row.saved.state)).toBe(true);
    expect(snapshot.generatedAt).toBe('2026-10-12T00:00:00.000Z');
  });

  it('起動期讀的列改了值：restart；其他列不動', async () => {
    const { byId, snapshot } = await compare(
      undefined,
      '- id: thread-title\n  config:\n    maxWords: 3\n    maxBytes: 40\n',
    );
    expect(byId('thread-title').sync).toBe('restart');
    expect(snapshot.summary.restart).toBe(1);
    expect(snapshot.summary['next-thread']).toBe(0);
  });

  it('起動期讀的列明寫一個等於預設的值：宣告變了、值沒變，判 same（不是 restart）', async () => {
    // maxWords 的預設是 5。拿掉 `snapshotsDiffer` 改比宣告字串，這一條會紅。
    const { byId, snapshot } = await compare(
      undefined,
      '- id: thread-title\n  config:\n    maxWords: 5\n',
    );
    expect(byId('thread-title').sync).toBe('same');
    expect(snapshot.summary).toMatchObject({ restart: 0, 'next-thread': 0 });
  });

  it('組裝期讀的列關掉：next-thread，running 是 mounted、saved 是 disabled', async () => {
    const { byId } = await compare(undefined, '- id: todo\n  disabled: true\n');
    const row = byId('todo');
    expect(row.sync).toBe('next-thread');
    expect(row.running).toEqual({ state: 'mounted' });
    expect(row.saved).toEqual({ state: 'disabled' });
  });

  it('組裝期讀的列設定改了：next-thread（出貨值是 true，改成 false）', async () => {
    const { byId } = await compare(
      undefined,
      '- id: todo\n  config:\n    allowParallelInProgress: false\n',
    );
    expect(byId('todo').sync).toBe('next-thread');
  });

  it('goal、sandbox-policy、workspace-changes：關掉是 next-thread，不是 restart', async () => {
    const { byId } = await compare(
      undefined,
      '- id: goal\n  disabled: true\n- id: sandbox-policy\n  disabled: true\n- id: workspace-changes\n  disabled: true\n',
    );
    expect(byId('goal').sync).toBe('next-thread');
    expect(byId('sandbox-policy').sync).toBe('next-thread');
    expect(byId('workspace-changes').sync).toBe('next-thread');
  });

  it('mount-restart 的機制：掛沒掛變了是 restart，只有設定變是 next-thread', async () => {
    const asMountRestart = (id: string) =>
      id === 'todo' ? ('mount-restart' as const) : ('next-thread' as const);
    const off = await compare(undefined, '- id: todo\n  disabled: true\n', asMountRestart);
    expect(off.byId('todo').sync).toBe('restart');
    const config = await compare(
      undefined,
      '- id: todo\n  config:\n    allowParallelInProgress: false\n',
      asMountRestart,
    );
    expect(config.byId('todo').sync).toBe('next-thread');
    const same = await compare(undefined, undefined, asMountRestart);
    expect(same.byId('todo').sync).toBe('same');
  });

  it('磁碟上新插進來的列：running 是 absent，saved 是 mounted，next-thread', async () => {
    const { byId, snapshot } = await compare(
      undefined,
      "- insert:\n    - id: extra-echo\n      name: '@nexus/plugin-echo'\n",
    );
    const row = byId('extra-echo');
    expect(row.module).toBe('@nexus/plugin-echo');
    expect(row.running).toEqual({ state: 'absent' });
    expect(row.saved).toEqual({ state: 'mounted' });
    expect(row.sync).toBe('next-thread');
    // 新列接在最後，啟動那份的順序不動。
    expect(snapshot.rows.at(-1)?.id).toBe('extra-echo');
  });

  it('設定驗不過的列：saved 是 dropped，帶掉在哪一步，沒有原文', async () => {
    const { byId, snapshot } = await compare(
      undefined,
      "- id: todo\n  config:\n    allowParallelInProgress: '不是布林'\n",
    );
    const row = byId('todo');
    expect(row.saved).toEqual({ state: 'dropped', dropStage: 'config' });
    expect(row.running).toEqual({ state: 'mounted' });
    expect(row.sync).toBe('next-thread');
    expect(JSON.stringify(snapshot)).not.toContain('不是布林');
  });

  it('列的全集從 entries 走：啟動時 patch 寫壞而掉的列也在，列數同 --dump-config 的列', async () => {
    const broken = "- id: todo\n  config:\n    allowParallelInProgress: '不是布林'\n";
    const loaded = await load(broken);
    const { snapshot } = await compare(broken, broken);
    expect(snapshot.rows).toHaveLength(loaded.entries.length);
    expect(snapshot.rows.map((row) => row.id)).toEqual([...loaded.ids]);
    expect(snapshot.rows.find((row) => row.id === 'todo')?.running).toEqual({
      state: 'dropped',
      dropStage: 'config',
    });
  });

  it('沒寫 id 的列（insert 進來的）設定改了：next-thread，不是 same', async () => {
    // 這種列的宣告上沒有 id，載入器補了號；用宣告上的 id 去找宣告會找不到，鍵退化成只剩 id，設定怎麼改都「沒變」。
    const insert = (value: boolean): string =>
      `- insert:\n    - name: '@nexus/plugin-todo'\n      config:\n        allowParallelInProgress: ${String(value)}\n`;
    const { snapshot } = await compare(insert(true), insert(false));
    const extra = snapshot.rows.filter(
      (row) => row.module === '@nexus/plugin-todo' && row.id !== 'todo',
    );
    expect(extra).toHaveLength(1);
    expect(extra[0]?.running).toEqual({ state: 'mounted' });
    expect(extra[0]?.sync).toBe('next-thread');
    const same = await compare(insert(true), insert(true));
    expect(same.snapshot.summary).toMatchObject({ 'next-thread': 0, restart: 0 });
  });

  it('模組載不進來的列、停用而且模組載不進來的列：不在 rows 與 plugins 裡，仍在快照上', async () => {
    // 列的全集從 `rows` 或 `plugins` 走的話，這兩列會憑空消失，列數對不上 `--dump-config`。
    const patch = [
      '- insert:',
      '    - id: ghost',
      "      name: '@nexus/plugin-does-not-exist'",
      '    - id: ghost-off',
      "      name: '@nexus/plugin-does-not-exist-either'",
      '      disabled: true',
      '',
    ].join('\n');
    const loaded = await load(patch);
    expect(loaded.rows.size).toBeLessThan(loaded.ids.length);
    const { snapshot, byId } = await compare(undefined, patch);
    expect(snapshot.rows.map((row) => row.id)).toEqual([...loaded.ids]);
    expect(byId('ghost').saved).toEqual({ state: 'dropped', dropStage: 'module' });
    expect(byId('ghost-off').saved).toEqual({ state: 'disabled' });
    expect(byId('ghost').module).toBe('@nexus/plugin-does-not-exist');
  });

  it('不帶設定值、不帶 drop 原文：每列的鍵固定，秘密字串不進檔', async () => {
    const secret = 'secret-token-9f3a';
    const { snapshot } = await compare(
      undefined,
      [
        '- id: live-model',
        '  config:',
        `    baseUrl: 'https://${secret}.example.invalid/v1'`,
        '- id: todo',
        '  config:',
        `    allowParallelInProgress: '${secret}'`,
        '',
      ].join('\n'),
    );
    const text = JSON.stringify(snapshot);
    expect(text).not.toContain(secret);
    // live-model 是起動期讀的一列：值變了，這一列是 restart，但值不在檔裡。
    expect(snapshot.rows.find((row) => row.id === 'live-model')?.sync).toBe('restart');
    // 鍵白名單：多一個欄位（例如 declared、config、message）這裡就紅。
    for (const row of snapshot.rows) {
      expect(Object.keys(row).sort()).toEqual(['id', 'module', 'running', 'saved', 'sync']);
      for (const side of [row.running, row.saved]) {
        expect(Object.keys(side).every((key) => key === 'state' || key === 'dropStage')).toBe(true);
      }
    }
    expect(Object.keys(snapshot).sort()).toEqual(['generatedAt', 'rows', 'summary', 'version']);
  });
});

describe('createPluginSnapshotWriter', () => {
  function snapshotOf(sync: 'same' | 'restart', at: string): PluginSnapshot {
    return {
      version: 1,
      generatedAt: at,
      summary: {
        same: sync === 'same' ? 1 : 0,
        'next-thread': 0,
        restart: sync === 'restart' ? 1 : 0,
      },
      rows: [
        {
          id: 'thread-title',
          module: 'thread-title',
          running: { state: 'mounted' },
          saved: { state: 'mounted' },
          sync,
        },
      ],
    };
  }

  it('寫成完整的 JSON、模式 0600，不留暫存檔', async () => {
    const dir = tmp();
    const path = join(dir, PLUGIN_SNAPSHOT_FILE_NAME);
    const lines: string[] = [];
    const writer = createPluginSnapshotWriter({ path, log: (line) => lines.push(line) });
    await writer.publish(snapshotOf('same', '2026-10-12T00:00:00.000Z'));
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      version: 1,
      rows: [{ id: 'thread-title' }],
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual([PLUGIN_SNAPSHOT_FILE_NAME]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[對照快照]');
    expect(lines[0]).toContain(path);
  });

  it('同時 publish 兩份：檔裡留下的是最後那一份，沒有暫存檔殘留', async () => {
    const dir = tmp();
    const path = join(dir, PLUGIN_SNAPSHOT_FILE_NAME);
    const writer = createPluginSnapshotWriter({ path, log: () => {} });
    const all = Array.from({ length: 8 }, (_, index) =>
      writer.publish(
        snapshotOf(index === 7 ? 'restart' : 'same', `2026-10-12T00:00:0${String(index)}.000Z`),
      ),
    );
    await Promise.all(all);
    const text = JSON.parse(readFileSync(path, 'utf8')) as PluginSnapshot;
    expect(text.generatedAt).toBe('2026-10-12T00:00:07.000Z');
    expect(text.rows[0]?.sync).toBe('restart');
    expect(readdirSync(dir)).toEqual([PLUGIN_SNAPSHOT_FILE_NAME]);
  });

  it('日誌那一行：第一次記，沒有 sync 變化就不再記，變了才記', async () => {
    const dir = tmp();
    const lines: string[] = [];
    const writer = createPluginSnapshotWriter({
      path: join(dir, PLUGIN_SNAPSHOT_FILE_NAME),
      log: (line) => lines.push(line),
    });
    await writer.publish(snapshotOf('same', '2026-10-12T00:00:00.000Z'));
    await writer.publish(snapshotOf('same', '2026-10-12T00:00:01.000Z'));
    expect(lines).toHaveLength(1);
    await writer.publish(snapshotOf('restart', '2026-10-12T00:00:02.000Z'));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('待重啟 1');
  });

  it('announce: false：這一次不記摘要，也算講過了；之後只在 sync 變了才記', async () => {
    const dir = tmp();
    const lines: string[] = [];
    const writer = createPluginSnapshotWriter({
      path: join(dir, PLUGIN_SNAPSHOT_FILE_NAME),
      log: (line) => lines.push(line),
    });
    expect(
      await writer.publish(snapshotOf('same', '2026-10-12T00:00:00.000Z'), { announce: false }),
    ).toBe(true);
    expect(lines).toEqual([]);
    await writer.publish(snapshotOf('same', '2026-10-12T00:00:01.000Z'));
    expect(lines).toEqual([]);
    await writer.publish(snapshotOf('restart', '2026-10-12T00:00:02.000Z'));
    expect(lines).toHaveLength(1);
  });

  it('寫不進去：不拋、記一次警告，之後寫得進去就照常', async () => {
    const dir = tmp();
    // 讓目標路徑的上一層是一個檔案：mkdir 與 open 都會失敗。
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x');
    const lines: string[] = [];
    const path = join(blocker, PLUGIN_SNAPSHOT_FILE_NAME);
    const writer = createPluginSnapshotWriter({ path, log: (line) => lines.push(line) });
    await expect(writer.publish(snapshotOf('same', '2026-10-12T00:00:00.000Z'))).resolves.toBe(
      false,
    );
    await expect(writer.publish(snapshotOf('same', '2026-10-12T00:00:01.000Z'))).resolves.toBe(
      false,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('寫不進');
    expect(existsSync(path)).toBe(false);
    // 目錄補上之後同一支 writer 就寫得進去。
    rmSync(blocker);
    mkdirSync(blocker);
    await writer.publish(snapshotOf('same', '2026-10-12T00:00:02.000Z'));
    expect(existsSync(path)).toBe(true);
  });
});
