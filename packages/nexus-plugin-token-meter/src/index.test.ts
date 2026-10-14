import { readFileSync } from 'node:fs';

import { Context } from '@nexus/cordis';
import Loader from '@nexus/cordis-plugin-loader';
import { createProjectionsProvider } from '@nexus/projections/provider';
import { checkConformance } from '@nexus/sdk';
import { describe, expect, it } from 'vitest';

import * as tokenMeter from './index.js';
import { tokenMeterUnit } from './index.js';

/**
 * 這個套件的驗收分三塊：一致性套件（#1421 驗收 D）、相依關係（驗收 G）、形狀。
 *
 * 組裝點那一側（出貨清單上的 token-meter 經樹進來、停用它下一條 thread 沒有它的投影、開著的照舊）在 `apps/harness` 的
 * `token-meter-on-tree.test.ts`；折疊本身在 `fold.test.ts`。這裡不重跑。
 */
describe('一致性套件（驗收 D）：真的提供者、真的 Loader', () => {
  it('token-meter 全格通過：manifest、匯出形式、載入→卸載後登記處回到掛載前、缺提供者停在 PENDING', async () => {
    let latest = createProjectionsProvider();
    const failures = await checkConformance({
      row: 'token-meter',
      module: tokenMeter,
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

  it('掛上之後登記處裡是用量這一個單元，登記者是那一列', async () => {
    // 不重複 `checkConformance` 內部的步驟，只量它不給的那一面：登記的東西對不對。
    const provider = createProjectionsProvider();
    const root = new Context();
    try {
      await root.plugin(Loader);
      Object.assign(root.loader.builtins, {
        projections: provider.Provider,
        'token-meter': tokenMeter,
      });
      await root.loader.create({ id: 'projections', name: 'cordis:projections' } as never, null);
      await root.loader.create(
        { id: 'row-meter', name: 'cordis:token-meter', config: {} } as never,
        null,
      );
      await root.loader.await();
      const entries = provider.entries();
      expect(entries.map((entry) => [entry.unit.key, entry.sources])).toEqual([
        [tokenMeterUnit.key, ['row-meter']],
      ]);
      // 登記處收的是凍過的複本（`normalizeProjectionUnit`），函式是同一組。
      expect(entries[0]?.unit.apply).toBe(tokenMeterUnit.apply);
      expect(entries[0]?.unit.view).toBe(tokenMeterUnit.view);
    } finally {
      await root.fiber.dispose();
    }
  });
});

describe('形狀', () => {
  it('沒有設定：未知欄位拒收', () => {
    expect(tokenMeter.Config.parse({})).toEqual({});
    expect(() => tokenMeter.Config.parse({ extra: 1 })).toThrow(/extra/);
  });

  it('沒有 default 匯出（Loader 的 unwrapExports 有 default 就取 default）', () => {
    expect('default' in tokenMeter).toBe(false);
  });

  it('單元宣告 children: true、key 與 wire 的投影名一致', () => {
    expect(tokenMeterUnit.children).toBe(true);
    expect(tokenMeterUnit.key).toBe('token-meter');
  });
});

describe('相依關係（#1421 驗收 G、PM 決策 3）', () => {
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
    ]);
    expect(pkg.dependencies).not.toHaveProperty('@nexus/core');
    expect(pkg.peerDependencies).not.toHaveProperty('@nexus/core');
    for (const name of Object.keys(pkg.peerDependencies)) {
      expect(pkg.devDependencies[name]).toBe('workspace:*');
    }
    for (const file of ['fold.ts', 'index.ts']) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      expect(source).not.toMatch(/from '@nexus\/core/u);
    }
  });
});
