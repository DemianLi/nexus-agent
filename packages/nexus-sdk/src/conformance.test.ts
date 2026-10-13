import { describe, expect, it } from 'vitest';

import { checkConformance } from './conformance.js';
import type { ConformanceTarget } from './conformance.js';
import { createRegistryProvider, widgetConsumer, widgetManifest } from './fixtures/registry.js';
import type { ProviderOptions } from './fixtures/registry.js';
import * as widgetPlugin from './fixtures/widget-plugin.js';
import * as widgetPluginWithDefault from './fixtures/widget-plugin-with-default.js';
import { injectOf, need } from './token.js';
import { widgetsToken } from './fixtures/registry.js';

/** 一個合格的目標；`provider` 與 `module` 可以換成有缺陷的。 */
function target(
  overrides: Partial<ConformanceTarget> & { provider?: ProviderOptions } = {},
): ConformanceTarget {
  // 兩次 boot 各要一份新的登記處，所以提供者用工廠；residue 讀「最近一次造出來」的那份。
  let latest = createRegistryProvider(overrides.provider);
  return {
    row: 'row-widget',
    module: widgetPlugin,
    providers: {
      widgets: () => {
        latest = createRegistryProvider(overrides.provider);
        return latest.Provider;
      },
    },
    residue: () => latest.items.length,
    ...overrides,
  };
}

const checksOf = async (t: ConformanceTarget) => (await checkConformance(t)).map((f) => f.check);

describe('一致性套件（驗收 G）', () => {
  it('合格的插件：全過', async () => {
    expect(await checkConformance(target())).toEqual([]);
  });

  it('命名空間物件的寫法（不經 import * as）也過', async () => {
    expect(await checkConformance(target({ module: widgetConsumer() }))).toEqual([]);
  });

  it('manifest 缺欄位：manifest 一格紅，訊息指名列與欄位', async () => {
    const { owner: _owner, ...rest } = widgetManifest();
    const failures = await checkConformance(
      target({ module: { ...widgetConsumer(), manifest: rest } }),
    );
    expect(failures.map((f) => f.check)).toEqual(['manifest']);
    expect(failures[0]?.message).toContain('列 row-widget');
    expect(failures[0]?.message).toContain('owner');
  });

  it('有 default 匯出：export-form 紅（Loader 會只取 default，丟掉 inject 與 Config）', async () => {
    const failures = await checkConformance(target({ module: widgetPluginWithDefault }));
    expect(failures.map((f) => f.check)).toContain('export-form');
    expect(failures.find((f) => f.check === 'export-form')?.message).toContain('default');
  });

  it('Config 與 manifest.config 不是同一份：export-form 紅', async () => {
    const other = widgetConsumer();
    const failures = await checkConformance(
      target({ module: { ...other, Config: widgetManifest().config.partial() } }),
    );
    expect(failures.map((f) => f.check)).toEqual(['export-form']);
  });

  it('inject 的範圍與 manifest.consumes 不一致：export-form 紅', async () => {
    const drifted = { ...widgetConsumer(), inject: injectOf(need(widgetsToken, '^1.1.0')) };
    const failures = await checkConformance(target({ module: drifted }));
    expect(failures.map((f) => f.check)).toEqual(['export-form']);
    expect(failures[0]?.message).toContain('範圍兩邊不一致');
  });

  it('卸載後登記處不是空的（disposer 不撤）：unload 紅', async () => {
    const failures = await checkConformance(target({ provider: { leak: true } }));
    expect(failures.map((f) => f.check)).toEqual(['unload']);
    expect(failures[0]?.message).toContain('沒有回到掛載前');
  });

  it('register 沒包進 ctx.effect、只回一個會撤的 disposer：經 fiber 卸載看得到，unload 紅', async () => {
    expect(await checksOf(target({ provider: { viaEffect: false } }))).toEqual(['unload']);
  });

  it('掛上後什麼都沒貢獻：量不到卸載，同樣不合格（不讓它因為「沒東西可留」而過）', async () => {
    const silent = { ...widgetConsumer(), apply() {} };
    const failures = await checkConformance(target({ module: silent }));
    expect(failures.map((f) => f.check)).toEqual(['unload']);
    expect(failures[0]?.message).toContain('量不到卸載');
  });

  it('缺件：停在 PENDING，等的服務正好是 manifest 的必要依賴', async () => {
    expect(await checksOf(target())).toEqual([]);
    // inject 多要了 manifest 沒宣告的 widgets2：export-form 與 missing 都該報
    const extra = {
      ...widgetConsumer(),
      inject: { ...injectOf(need(widgetsToken, '^1.0.0')), widgets2: { range: '^1.0.0' } },
    };
    const checks = await checksOf(target({ module: extra }));
    expect(checks).toContain('export-form');
    expect(checks).toContain('missing');
  });

  it('選配的依賴放進 inject：export-form 紅', async () => {
    const optional = widgetManifest({
      consumes: [{ token: 'widgets', range: '^1.0.0', optional: true }],
    });
    const failures = await checkConformance(
      target({ module: { ...widgetConsumer(), manifest: optional } }),
    );
    expect(failures[0]?.message).toContain('選配');
  });
});
