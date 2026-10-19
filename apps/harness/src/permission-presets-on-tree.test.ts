/**
 * `permission-presets` 遷上樹（[#1491](https://github.com/DemianLi/nexus-agent/issues/1491)）**接縫本身**的驗收：會話參與者折進 thread
 * 的位置（三顆事件的相對順序）、冷復活不多寫一顆、目錄從折進來的服務拿（不是組裝點自己算）、行程級的工作區根沒交到樹上就起不來。
 *
 * 產品行為（`--sandbox`、續接、`/permission`、必掛名單、wire）在 `permission-presets.test.ts`，plugin 本身在
 * `@nexus/plugin-permission-presets` 的測試，serve 的紀錄在 `serve-plugin-failed-record.test.ts`；這一份只問「接在樹上之後」。
 */

import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionLog } from '@nexus/core';
import { PERMISSION_PRESETS_CONTRACT_VERSION } from '@nexus/permission-presets';
import type { SessionEvent } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCliAgent } from './assembly-root.js';
import { createCordisRoot, entryApprovalChannel } from './cordis-root.js';
import type { CordisRoot } from './cordis-root.js';
import {
  shippedPlugins,
  shippedPluginsWithConfig,
  shippedPluginsWithFullAccess,
} from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { isBridgeEntry, loadDefaultPlugins } from './plugin-config.js';
import { liveBindingsOf } from './plugin-live-versions.js';
import { buildPluginSnapshot } from './plugin-snapshot.js';
import { auditStartupEntries } from './startup-audit.js';

const shipped = await shippedPlugins();
const withFullAccess = await shippedPluginsWithFullAccess();

let workspace: string;
const roots: CordisRoot[] = [];
const temporary: string[] = [];
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'nexus-presets-tree-'));
});
afterEach(async () => {
  for (const root of roots.splice(0)) await root.dispose().catch(() => {});
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

function home(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-presets-tree-home-'));
  chmodSync(dir, 0o700);
  temporary.push(dir);
  return { [HARNESS_HOME_ENV]: dir };
}

const typesOf = (events: readonly SessionEvent[], wanted: readonly string[]): string[] =>
  events.map((event) => event.type).filter((type) => wanted.includes(type));

const dataOf = (events: readonly SessionEvent[], type: string): unknown[] =>
  events.filter((event) => event.type === type).map((event) => event.data);

describe('三顆事件在日誌上的相對順序', () => {
  it('新會話：approval/policy → sandbox/mode → permission/preset（參與者折在橋接列的位置，承重）', async () => {
    const built = await createCliAgent({ live: false, workspace }, shipped, workspace);
    const detach = built.attachSession(built.sessions);
    try {
      expect(
        typesOf(built.sessionLog.events, ['approval/policy', 'sandbox/mode', 'permission/preset']),
      ).toEqual(['approval/policy', 'sandbox/mode', 'permission/preset']);
    } finally {
      detach();
      await built.dispose();
    }
  });

  it('切換的順序也不變：permission/preset → sandbox/mode → approval/policy', async () => {
    const built = await createCliAgent({ live: false, workspace }, withFullAccess, workspace);
    const detach = built.attachSession(built.sessions);
    try {
      const before = built.sessionLog.events.length;
      await built.commands.find('permission')?.handler({
        commandId: 'c',
        rawInput: 'danger-full-access',
        signal: new AbortController().signal,
        sessionLog: built.sessionLog,
        attachments: [],
        steer: () => undefined,
      });
      expect(
        typesOf(built.sessionLog.events.slice(before), [
          'permission/preset',
          'sandbox/mode',
          'approval/policy',
        ]),
      ).toEqual(['permission/preset', 'sandbox/mode', 'approval/policy']);
    } finally {
      detach();
      await built.dispose();
    }
  });
});

describe('冷復活（R2）：重啟之後叫醒的背景子代理不多寫一顆 permission/preset', () => {
  it('父代理是全開、子代理日誌是上一個行程留下的（內有那一次委派的 sandbox/mode）：接上之後一顆都沒新增', async () => {
    const built = await createCliAgent(
      { live: false, workspace, sandbox: 'danger-full-access' },
      withFullAccess,
      workspace,
    );
    const detach = built.attachSession(built.sessions);
    try {
      // 前提：父代理真的是全開——一位不看 seed 邊界的參與者在這裡會把全開那一組帶下去。
      expect(dataOf(built.sessionLog.events, 'permission/preset')).toEqual([
        { preset: 'danger-full-access' },
      ]);
      const previous = new SessionLog('previous-process');
      previous.append('sandbox/mode', { mode: 'danger-full-access', source: 'delegation' });
      const seed = [...previous.events];

      const child = built.sessions.open(
        { kind: 'subagent', runId: 'cold-1' },
        { events: seed, stored: {} as never },
      );

      expect(child.events.map((event) => event.type)).toEqual(['sandbox/mode', 'session/end-seed']);
      expect(dataOf(child.events, 'permission/preset')).toEqual([]);
      // 父代理那一份不動。
      expect(dataOf(built.sessionLog.events, 'permission/preset')).toHaveLength(1);
    } finally {
      detach();
      await built.dispose();
    }
  });
});

describe('目錄從折進這條 thread 的服務拿', () => {
  it('部署方改了組合表：目錄的選項、名字與預設組都是 plugin 那一列算的，組裝點沒有自己的一份', async () => {
    const plugins = await shippedPluginsWithConfig('permission-presets', {
      presets: {
        safe: { sandbox: 'workspace-write', approval: 'ask', name: '安全', description: '預設' },
        strict: { sandbox: 'read-only', approval: 'ask' },
      },
    });
    const built = await createCliAgent({ live: false, workspace }, plugins, workspace);
    try {
      expect(built.permissionPresets?.catalog()).toEqual({
        options: [
          { value: 'safe', name: '安全', description: '預設' },
          { value: 'strict', name: 'strict' },
        ],
        defaultOptions: [
          { value: 'safe', name: '安全', description: '預設' },
          { value: 'strict', name: 'strict' },
        ],
        defaultPreset: 'safe',
      });
    } finally {
      await built.dispose();
    }
  });

  it('同一棵樹上兩條 thread：預設組各算各的（偏離登記：逐條 thread 的目錄）', async () => {
    const root = createCordisRoot({
      channel: entryApprovalChannel(undefined),
      workspaceRoot: workspace,
    });
    const loaded = await loadDefaultPlugins(
      { env: {}, warn: () => undefined },
      { tree: root.tree },
    );
    const assembly = await root.boot('serve', { plugins: loaded.plugins });
    const open = (sandbox: 'read-only' | 'workspace-write') =>
      assembly.create({ live: false, workspace, sandbox }, { plugins: loaded.plugins });
    const first = await open('read-only');
    const second = await open('workspace-write');
    try {
      expect(first.permissionPresets?.catalog().defaultPreset).toBe('read-only');
      expect(second.permissionPresets?.catalog().defaultPreset).toBe('workspace-write');
    } finally {
      await first.dispose();
      await second.dispose();
      await root.dispose();
    }
  });
});

describe('行程級的工作區根沒交到樹上', () => {
  it('有 --workspace 而根沒拿到工作區根：這條 thread 建不起來，訊息指名 permission-presets', async () => {
    const root = createCordisRoot({ channel: entryApprovalChannel(undefined) });
    const loaded = await loadDefaultPlugins(
      { env: {}, warn: () => undefined },
      { tree: root.tree },
    );
    const assembly = await root.boot('serve', { plugins: loaded.plugins });
    try {
      await expect(
        assembly.create(
          { live: false, workspace, sandbox: 'workspace-write' },
          { plugins: loaded.plugins },
        ),
      ).rejects.toThrow(/permission-presets/u);
    } finally {
      await root.dispose();
    }
  });
});

describe('B：出貨清單上的 permission-presets 經樹進來，提供 permissionPresets 服務', () => {
  const ID = 'permission-presets';

  /** 入口的順序：建根（有工作區就交工作區根）→ 讀清單（帶樹）。 */
  async function load(withWorkspace: boolean) {
    const root = createCordisRoot({
      channel: entryApprovalChannel(undefined),
      ...(withWorkspace && { workspaceRoot: workspace }),
    });
    roots.push(root);
    const loaded = await loadDefaultPlugins(
      { env: home(), warn: () => undefined },
      { tree: root.tree },
    );
    return { root, loaded };
  }

  it('有工作區：是橋接列、沒有掉列；啟動稽核過；樹上 include 列 ACTIVE；快照 running／saved 都是 mounted；liveBindingsOf 含這一列', async () => {
    const { root, loaded } = await load(true);
    const entry = loaded.plugins.find((candidate) => loaded.rows.get(candidate)?.id === ID);
    expect(entry).toBeDefined();
    expect(entry !== undefined && isBridgeEntry(entry)).toBe(true);
    expect(entry?.plugin.name).toBe(ID);
    expect(loaded.dropped).toEqual([]);
    expect(loaded.rows.get(entry as never)).toEqual({
      id: ID,
      module: '@nexus/plugin-permission-presets',
    });
    expect(() => auditStartupEntries(loaded, { live: false })).not.toThrow();

    const tree = await root.tree.context();
    expect(tree.loader.resolve(`include:${ID}`).fiber?.ctx.fiber.state).toBe(2);

    const source = {
      entries: loaded.entries,
      ids: loaded.ids,
      plugins: loaded.plugins,
      rows: loaded.rows,
      drops: loaded.dropped.map(({ id, stage }) => ({ id, stage })),
    };
    const snapshot = buildPluginSnapshot({
      running: source,
      saved: source,
      generatedAt: new Date(0),
    });
    expect(snapshot.rows.find((row) => row.id === ID)).toMatchObject({
      module: '@nexus/plugin-permission-presets',
      running: { state: 'mounted' },
      saved: { state: 'mounted' },
      sync: 'same',
    });
    expect(
      liveBindingsOf({ loaded, plugins: loaded.plugins }, []).map((binding) => binding.id),
    ).toContain(ID);
  }, 60000);

  it('樹上的 permissionPresets 服務：歸屬是 permission-presets 那一列、契約版本是定義套件的常數', async () => {
    const { root } = await load(true);
    const tree = await root.tree.context();
    const service = tree.get('permissionPresets') as
      { provider?: string; contractVersion?: string } | undefined;
    expect(service?.provider).toBe(`include:${ID}`);
    expect(service?.contractVersion).toBe(PERMISSION_PRESETS_CONTRACT_VERSION);
  }, 60000);

  it('沒給工作區根：樹上沒有這個服務（偏離 4：沒有圍堵就沒有東西可以捆），也沒有掉列', async () => {
    const { root, loaded } = await load(false);
    const tree = await root.tree.context();
    expect(tree.get('permissionPresets')).toBeUndefined();
    expect(loaded.dropped).toEqual([]);
  }, 60000);
});
