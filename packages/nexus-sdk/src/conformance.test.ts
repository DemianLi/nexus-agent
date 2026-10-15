import type { Context } from '@nexus/cordis';
import { describe, expect, it } from 'vitest';

import { checkConformance } from './conformance.js';
import type { ConformanceTarget } from './conformance.js';
import { createRegistryProvider, widgetConsumer, widgetManifest } from './fixtures/registry.js';
import type { ProviderOptions } from './fixtures/registry.js';
import * as widgetPlugin from './fixtures/widget-plugin.js';
import * as widgetPluginWithDefault from './fixtures/widget-plugin-with-default.js';
import { ContractService } from './contract.js';
import { defineToken, injectOf, need, service } from './token.js';
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

/** 插件自己**提供**服務的那一類（#1456）：服務名 `gadget`，插件同時消費 `widgets` 登記一筆，讓 `residue` 有東西量。 */
describe('一致性套件：插件提供的服務（#1456）', () => {
  interface Gadget {
    ping(): string;
  }
  const gadgetToken = defineToken<Gadget>('gadget', '2.0.0');

  class GadgetService extends ContractService<Gadget> implements Gadget {
    constructor(ctx: Context, token = gadgetToken) {
      super(ctx, token);
    }
    ping(): string {
      return 'pong';
    }
  }

  const provider = (apply: (ctx: Context) => void, version = gadgetToken.version) => ({
    ...widgetConsumer(),
    manifest: widgetManifest({ provides: [{ token: gadgetToken.name, version }] }),
    apply(ctx: Context) {
      service(ctx, widgetsToken).register('g');
      apply(ctx);
    },
  });

  it('`new` 繼承 ContractService 的類別提供：全過（掛上後讀得到、卸載後讀不到）', async () => {
    const good = provider((ctx) => void new GadgetService(ctx));
    expect(await checkConformance(target({ module: good }))).toEqual([]);
  });

  it('宣告提供卻沒有提供：unload 紅，訊息指名服務', async () => {
    const failures = await checkConformance(target({ module: provider(() => {}) }));
    expect(failures.map((f) => f.check)).toEqual(['unload']);
    expect(failures[0]?.message).toContain('宣告提供 gadget');
  });

  it('契約版本與 manifest 宣告的不一致：unload 紅', async () => {
    const failures = await checkConformance(
      target({ module: provider((ctx) => void new GadgetService(ctx), '3.0.0') }),
    );
    expect(failures.map((f) => f.check)).toEqual(['unload']);
    expect(failures[0]?.message).toContain('契約版本');
  });

  // 突變：提供者掛在 root 上、歸屬卻寫成這一列——撤除時不刪服務。列卸載之後 `root.get` 仍取得到一份孤兒。
  it('撤除時不刪服務（服務掛在 root、不隨那一列走）：unload 紅，訊息指名「還留在 root 上」', async () => {
    const leaky = provider((ctx) => {
      class Leaky extends GadgetService {}
      const leaked = new Leaky(ctx.root as Context);
      (leaked as { provider: string }).provider = 'row-widget';
    });
    const failures = await checkConformance(target({ module: leaky }));
    expect(failures.map((f) => f.check)).toEqual(['unload']);
    expect(failures[0]?.message).toContain('還留在 root 上');
  });
});
