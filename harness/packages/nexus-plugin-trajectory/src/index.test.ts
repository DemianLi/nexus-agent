import { readdirSync, readFileSync } from 'node:fs';

import { Context } from '@nexus/cordis';
import Loader from '@nexus/cordis-plugin-loader';
import { createProjectionsProvider } from '@nexus/projections/provider';
import { checkConformance } from '@nexus/sdk';
import { describe, expect, it } from 'vitest';

import * as trajectory from './index.js';
import { requestSnapshotsUnit, trajectoryUnit } from './index.js';

/**
 * 這個套件的驗收分三塊：一致性套件（#1435 驗收 B）、相依關係（驗收 A）、形狀。
 *
 * 組裝點那一側（出貨清單上的 trajectory 經樹進來、停用它下一條 thread 沒有它的投影、開著的照舊）在 `apps/harness` 的
 * `trajectory-on-tree.test.ts`；折疊本身在 `trajectory.test.ts`、`snapshots.test.ts`。這裡不重跑。
 */
describe('一致性套件（驗收 B）：真的提供者、真的 Loader', () => {
  it('trajectory 全格通過：manifest、匯出形式、載入→卸載後登記處回到掛載前、缺提供者停在 PENDING', async () => {
    let latest = createProjectionsProvider();
    const failures = await checkConformance({
      row: 'trajectory',
      module: trajectory,
      config: {},
      providers: {
        projections: () => {
          latest = createProjectionsProvider();
          return latest.Provider;
        },
      },
      residue: () => latest.registrations(),
    });
    expect(failures).toEqual([]);
  });

  it('掛上之後登記處裡是軌跡與請求快照兩個單元，登記者是那一列', async () => {
    const provider = createProjectionsProvider();
    const root = new Context();
    try {
      await root.plugin(Loader);
      Object.assign(root.loader.builtins, {
        projections: provider.Provider,
        trajectory,
      });
      await root.loader.create({ id: 'projections', name: 'cordis:projections' } as never, null);
      await root.loader.create(
        { id: 'row-trajectory', name: 'cordis:trajectory', config: {} } as never,
        null,
      );
      await root.loader.await();
      const entries = provider.entries();
      expect(entries.map((entry) => [entry.unit.key, entry.sources])).toEqual([
        [trajectoryUnit.key, ['row-trajectory']],
        [requestSnapshotsUnit.key, ['row-trajectory']],
      ]);
      // 登記處收的是凍過的複本（`normalizeProjectionUnit`），函式是同一組。
      expect(entries[0]?.unit.apply).toBe(trajectoryUnit.apply);
      expect(entries[1]?.unit.apply).toBe(requestSnapshotsUnit.apply);
    } finally {
      await root.fiber.dispose();
    }
  });
});

describe('形狀', () => {
  it('沒有設定：未知欄位拒收', () => {
    expect(trajectory.Config.parse({})).toEqual({});
    expect(() => trajectory.Config.parse({ extra: 1 })).toThrow(/extra/);
  });

  it('沒有 default 匯出（Loader 的 unwrapExports 有 default 就取 default）', () => {
    expect('default' in trajectory).toBe(false);
  });

  it('兩個單元都宣告 children: true，key 與 wire 的投影名一致', () => {
    expect(trajectoryUnit.children).toBe(true);
    expect(requestSnapshotsUnit.children).toBe(true);
    expect(trajectoryUnit.key).toBe('trajectory');
    expect(requestSnapshotsUnit.key).toBe('request-snapshots');
  });
});

describe('相依關係（#1435 驗收 A）', () => {
  it('src 不 import @nexus/core；peer 只放定義套件、SDK 與 cordis 的型別；core 只在 devDependencies', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      dependencies: Record<string, string>;
      peerDependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@nexus/wire', 'zod']);
    expect(Object.keys(pkg.peerDependencies).sort()).toEqual([
      '@nexus/cordis',
      '@nexus/projections',
      '@nexus/sdk',
      '@nexus/session',
    ]);
    expect(pkg.dependencies).not.toHaveProperty('@nexus/core');
    expect(pkg.peerDependencies).not.toHaveProperty('@nexus/core');
    for (const name of Object.keys(pkg.peerDependencies)) {
      expect(pkg.devDependencies[name]).toBe('workspace:*');
    }
    // 掃 src 底下所有非測試檔（不只 index.ts）：靜態、動態、type import 都不准指到 @nexus/core。
    const sources = readdirSync(new URL('./', import.meta.url)).filter(
      (file) => file.endsWith('.ts') && !file.endsWith('.test.ts'),
    );
    expect(sources).toEqual(expect.arrayContaining(['index.ts', 'snapshots.ts', 'trajectory.ts']));
    for (const file of sources) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      expect(source, file).not.toMatch(/(?:from|import\()\s*['"]@nexus\/core/u);
    }
  });
});
