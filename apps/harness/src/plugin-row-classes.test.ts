/**
 * 分類表的守衛（[#1406](https://github.com/DemianLi/nexus-agent/issues/1406)）。
 *
 * 判準是「出貨清單每一列都有歸類」：新增一列、卻沒決定它改了之後什麼時候生效，這裡是紅的，而不是一列靜靜落到預設值。
 * 不寫黃金檔：列的清單是從 `cordis.yml`、`cordis.serve.yml` 實際讀出來的。
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { HARNESS_HOME_ENV } from './harness-home.js';
import { loadDefaultPlugins } from './plugin-config.js';
import { classOfRow, ROW_CLASSES, STARTUP_READ_PLUGINS } from './plugin-row-classes.js';

const temporary: string[] = [];

afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 出貨清單（serve 載入的全部：`cordis.yml` 加 `cordis.serve.yml`）每一列的 id 與插件名。 */
async function shippedRows(): Promise<{ id: string; pluginName: string | undefined }[]> {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-row-classes-'));
  temporary.push(dir);
  chmodSync(dir, 0o700);
  const loaded = await loadDefaultPlugins({ serve: true, env: { [HARNESS_HOME_ENV]: dir } });
  const nameOf = new Map<string, string>();
  for (const entry of loaded.plugins) {
    const row = loaded.rows.get(entry);
    if (row !== undefined) nameOf.set(row.id, entry.plugin.name);
  }
  return loaded.ids.map((id) => ({ id, pluginName: nameOf.get(id) }));
}

describe('列的分類表', () => {
  it('出貨清單的每一列恰好歸在一邊：起動期名單，或分類表', async () => {
    const rows = await shippedRows();
    // 清單不是空的：沒讀到列，下面的每一條都會空轉成綠。
    expect(rows.length).toBeGreaterThan(40);
    const startupNames = new Set(STARTUP_READ_PLUGINS.map((plugin) => plugin.name));
    const unclassified: string[] = [];
    const both: string[] = [];
    for (const { id, pluginName } of rows) {
      const startup = pluginName !== undefined && startupNames.has(pluginName);
      const tabled = ROW_CLASSES.has(id);
      if (!startup && !tabled) unclassified.push(id);
      if (startup && tabled) both.push(id);
    }
    expect(unclassified, '這幾列沒有歸類：到 plugin-row-classes.ts 的 ROW_CLASSES 補上').toEqual(
      [],
    );
    expect(both, '這幾列同時在起動期名單與分類表上，兩份真相').toEqual([]);
  });

  it('分類表上沒有出貨清單裡不存在的列（改名、刪列後留下的殘影）', async () => {
    const ids = new Set((await shippedRows()).map((row) => row.id));
    const stale = [...ROW_CLASSES.keys()].filter((id) => !ids.has(id));
    expect(stale).toEqual([]);
  });

  it('起動期讀的每一顆都對得上出貨的一列，名字不重複', async () => {
    const rows = await shippedRows();
    const names = STARTUP_READ_PLUGINS.map((plugin) => plugin.name);
    expect(names).toHaveLength(20);
    expect(new Set(names).size).toBe(names.length);
    const shipped = new Set(rows.map((row) => row.pluginName));
    expect(names.filter((name) => !shipped.has(name))).toEqual([]);
  });

  it('serve.ts 起動期讀的設定列就是 `STARTUP_READ_PLUGINS` 那幾顆：多讀一顆而名單沒加，這裡是紅的', () => {
    const source = readFileSync(join(import.meta.dirname, 'serve.ts'), 'utf8');
    const read = new Set<string>();
    for (const match of source.matchAll(/startup(?:Setting|EntryMounted)\(plugins, (\w+)\)/gu)) {
      if (match[1] !== undefined) read.add(match[1]);
    }
    // 只比數量：識別字與插件名不是同一個字串。一顆不多一顆不少。
    expect(read.size).toBe(STARTUP_READ_PLUGINS.length);
  });

  it('mount-restart 的列一律寫了理由；目前這一類是空的', () => {
    const mountRestart = [...ROW_CLASSES.entries()].filter(
      ([, entry]) => entry.class === 'mount-restart',
    );
    for (const [id, entry] of mountRestart) {
      expect(entry.note, `${id} 歸 mount-restart 卻沒寫理由`).toBeTruthy();
    }
    // goal、sandbox-policy、workspace-changes 逐顆核過都是 next-thread（見 plugin-row-classes.ts 檔頭）。
    expect(mountRestart.map(([id]) => id)).toEqual([]);
  });

  it.each(['sandbox-policy', 'permission-presets'])(
    '%s 的分類表上寫著「關掉之後新 thread 都建不起來」（有 --workspace 時組裝會拋）',
    (id) => {
      const entry = ROW_CLASSES.get(id);
      expect(entry?.class).toBe('next-thread');
      expect(entry?.note).toContain('建不起來');
    },
  );

  it('classOfRow：起動期名單優先；表上沒有的列（使用者 insert 進來的）當 next-thread', () => {
    expect(classOfRow('thread-title', 'thread-title')).toBe('startup-read');
    expect(classOfRow('todo', 'todo')).toBe('next-thread');
    expect(classOfRow('my-own-row', 'my-own-plugin')).toBe('next-thread');
    expect(classOfRow('my-own-row', undefined)).toBe('next-thread');
  });
});
