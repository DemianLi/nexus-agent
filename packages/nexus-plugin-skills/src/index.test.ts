import { readFileSync } from 'node:fs';

import { Context } from '@nexus/cordis';
import Loader from '@nexus/cordis-plugin-loader';
import { checkConformance } from '@nexus/sdk';
import { createSkillSourcesProvider } from '@nexus/skills/provider';
import { describe, expect, it } from 'vitest';

import * as skills from './index.js';
import { DEFAULT_SKILLS_SOURCE } from './index.js';

/**
 * 薄測試：設定的形狀、一致性套件、登記進去的東西與相依關係。
 *
 * skill **真的有沒有進到 prompt**、以及「看得到讀不到」那條，驗收在組裝點（`apps/harness` 的 `skills.test.ts`）——那裡看的是
 * 模型收到的 system prompt 與工具回傳，這裡看的是登記處的內容。兩件事。樹上那一列怎麼折進 thread 在
 * `apps/harness` 的 `skills-on-tree.test.ts`。
 */
describe('設定', () => {
  it('省略 sources 時用慣例路徑；多來源照給的順序', () => {
    expect(skills.Config.parse({})).toEqual({ sources: [DEFAULT_SKILLS_SOURCE] });
    expect(skills.Config.parse({ sources: ['/a/', '/b/'] })).toEqual({ sources: ['/a/', '/b/'] });
  });

  // 空清單與沒掛 plugin 在 fold 之後完全同形，所以差別必須在載入時就吵出來。
  it('空的 sources 讓載入失敗，不會靜默變成「沒有 skill」', () => {
    expect(() => skills.Config.parse({ sources: [] })).toThrow('空的來源清單');
  });

  it('未知欄位拒收（登記的偏離：dsh 放行）', () => {
    expect(() => skills.Config.parse({ source: ['/skills/'] })).toThrow(/source\b/);
  });
});

describe('一致性套件：真的提供者、真的 Loader', () => {
  it('skills 全格通過：manifest、匯出形式、載入→卸載後登記處回到掛載前、缺提供者停在 PENDING', async () => {
    let latest = createSkillSourcesProvider();
    const failures = await checkConformance({
      row: 'skills',
      module: skills,
      config: {},
      providers: {
        skillSources: () => {
          latest = createSkillSourcesProvider();
          return latest.Provider;
        },
      },
      residue: () => latest.registrations(),
    });
    expect(failures).toEqual([]);
  });

  it('掛上之後登記處裡是設定的來源，依序，登記者是那一列', async () => {
    const provider = createSkillSourcesProvider();
    const root = new Context();
    try {
      await root.plugin(Loader);
      Object.assign(root.loader.builtins, {
        'skill-sources': provider.Provider,
        skills,
      });
      await root.loader.create(
        { id: 'skill-sources', name: 'cordis:skill-sources' } as never,
        null,
      );
      await root.loader.create(
        {
          id: 'skills-row',
          name: 'cordis:skills',
          config: { sources: ['/skills/內建/', '/skills/專案/'] },
        } as never,
        null,
      );
      await root.loader.await();
      expect(provider.entries()).toEqual([
        { path: '/skills/內建/', source: 'skills-row' },
        { path: '/skills/專案/', source: 'skills-row' },
      ]);
    } finally {
      await root.fiber.dispose();
    }
  });
});

describe('相依關係', () => {
  it('src 不 import @nexus/core；相依只有 SDK、cordis 與 @nexus/skills，沒有 default 匯出', () => {
    const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
    expect(read('./index.ts')).not.toMatch(/from '@nexus\/core'/u);
    expect('default' in skills).toBe(false);
    const pkg = JSON.parse(read('../package.json')) as {
      dependencies?: Record<string, string>;
      peerDependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(['zod']);
    expect(Object.keys(pkg.peerDependencies).sort()).toEqual(
      ['@nexus/cordis', '@nexus/sdk', '@nexus/skills'].sort(),
    );
  });
});
