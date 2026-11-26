import type { Context } from '@nexus/cordis';
import { describe, expect, it } from 'vitest';

import { boot } from './fixtures/boot.js';
import { createRegistryProvider, widgetsToken } from './fixtures/registry.js';
import type { WidgetRegistry } from './fixtures/registry.js';
import { defineToken, injectOf, need, optionalService, service } from './token.js';
import type { ServiceToken } from './token.js';

describe('帶型別的 token', () => {
  it('injectOf 由 token 組出 inject：鍵是 token 名，範圍進 intercept', () => {
    expect(injectOf(need(widgetsToken, '^1.0.0'))).toEqual({ widgets: { range: '^1.0.0' } });
    expect(injectOf()).toEqual({});
  });

  it('消費者經 token 取得服務；沒宣告就讀，Cordis 拋錯', async () => {
    const provider = createRegistryProvider();
    const seen: unknown[] = [];
    const t = await boot({
      provider: provider.Provider,
      declared: {
        name: 'declared',
        inject: injectOf(need(widgetsToken, '^1.0.0')),
        apply(ctx: Context) {
          seen.push(service(ctx, widgetsToken).list());
        },
      },
      undeclared: {
        name: 'undeclared',
        inject: {},
        apply(ctx: Context) {
          try {
            service(ctx, widgetsToken);
          } catch (error) {
            seen.push((error as Error).message);
          }
        },
      },
    });
    await t.loader.create({ name: 'cordis:provider' });
    await t.loader.create({ name: 'cordis:declared' });
    await t.loader.create({ name: 'cordis:undeclared' });
    await t.loader.await();
    expect(seen).toEqual([[], 'cannot get property "widgets" without inject']);
  });

  it('optionalService：沒提供是 undefined，不拋', async () => {
    const seen: unknown[] = [];
    const t = await boot({
      reader: {
        name: 'reader',
        apply(ctx: Context) {
          seen.push(optionalService(ctx, widgetsToken));
        },
      },
    });
    await t.loader.create({ name: 'cordis:reader' });
    await t.loader.await();
    expect(seen).toEqual([undefined]);
  });
});

/**
 * 驗收 B 的型別釘：**只有 `tsc` 看得到**（vitest 不做型別檢查）。這個函式不會被呼叫，但整份檔在
 * `pnpm --filter @nexus/sdk typecheck` 裡編譯；任何一條 `@ts-expect-error` 底下的錯誤消失，
 * `tsc` 就會報 TS2578（未使用的指令）而變紅。
 */
export function typePins(ctx: Context): void {
  const registry: WidgetRegistry = service(ctx, widgetsToken);
  void registry;

  // 拿錯型別：服務是 WidgetRegistry，不是 number。
  // @ts-expect-error TS2322
  const wrong: number = service(ctx, widgetsToken);
  void wrong;

  // 打錯 token：傳字串，不是 token。
  // @ts-expect-error TS2345
  service(ctx, 'widgets');

  // 兩個不同型別的 token 不能互換。
  const other = defineToken<{ other: true }>('other', '1.0.0');
  // @ts-expect-error TS2322
  const swapped: ServiceToken<WidgetRegistry> = other;
  void swapped;

  // 範圍是 need 的必填參數。
  // @ts-expect-error TS2554
  need(widgetsToken);
}
