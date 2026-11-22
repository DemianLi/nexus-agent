/**
 * 測試專用的接縫：一個「小零件登記處」的定義、提供者與消費者。**不匯出**——真正的接縫是 `@nexus/tools`，
 * 它的提供者在 #1416 PR 2。這裡的提供者與消費者只為了在不依賴任何出貨插件的情況下驗 SDK（探針 ⑤ 的寫法）。
 */

import type { Context } from '@nexus/cordis';
import { z } from 'zod';

import { ContractService } from '../contract.js';
import { defineManifest } from '../manifest.js';
import type { Manifest } from '../manifest.js';
import { defineToken, injectOf, need, service } from '../token.js';

/** 接縫的介面。 */
export interface WidgetRegistry {
  register(name: string): () => void;
  list(): string[];
}

export const widgetsToken = defineToken<WidgetRegistry>('widgets', '1.2.0');

export interface ProviderOptions {
  /** `true`：`register` 回的 disposer 什麼都不撤——驗一致性套件抓得到「卸載後留下東西」。 */
  readonly leak?: boolean;
  /** `false`：`register` 不包 `ctx.effect`，只回一個會撤的 disposer——靠呼叫者自己記得呼叫。 */
  readonly viaEffect?: boolean;
  /** 提供者宣告的契約版本；省略即 token 的版本。 */
  readonly version?: string;
}

/** 造一個提供者；`items` 是它的活資源，測試直接讀。每次呼叫狀態都是新的。 */
export function createRegistryProvider(options: ProviderOptions = {}): {
  Provider: new (ctx: Context) => ContractService<WidgetRegistry> & WidgetRegistry;
  items: string[];
} {
  const items: string[] = [];
  const token =
    options.version === undefined
      ? widgetsToken
      : defineToken<WidgetRegistry>(widgetsToken.name, options.version);

  class RegistryService extends ContractService<WidgetRegistry> implements WidgetRegistry {
    constructor(ctx: Context) {
      super(ctx, token);
    }

    register(name: string): () => void {
      const add = () => {
        if (items.includes(name)) throw new Error(`重名：${name}`);
        items.push(name);
        return () => {
          if (options.leak === true) return;
          const index = items.indexOf(name);
          if (index >= 0) items.splice(index, 1);
        };
      };
      if (options.viaEffect === false) return add();
      return this.ctx.effect(add, 'widgets.register()');
    }

    list(): string[] {
      return [...items];
    }
  }
  return { Provider: RegistryService, items };
}

/** 一份合格的 manifest；`overrides` 蓋掉其中幾格。 */
export function widgetManifest(overrides: Partial<Manifest> = {}): Manifest {
  return defineManifest({
    id: 'widget-consumer',
    version: '1.0.0',
    owner: '平台團隊',
    provides: [],
    consumes: [{ token: widgetsToken.name, range: '^1.0.0' }],
    config: widgetConfig,
    reload: { code: 'restart', config: 'next-thread' },
    capabilities: [],
    ...overrides,
  });
}

export const widgetConfig = z.strictObject({ label: z.string().default('w') });

export const widgetInject = injectOf(need(widgetsToken, '^1.0.0'));

/** 一顆合格的消費者，以命名空間物件的形式（跟 `import * as` 得到的一樣）。 */
export function widgetConsumer(label?: string) {
  return {
    name: 'widget-consumer',
    inject: widgetInject,
    Config: widgetConfig,
    manifest: widgetManifest(),
    apply(ctx: Context, config: z.infer<typeof widgetConfig>) {
      service(ctx, widgetsToken).register(label ?? config.label);
    },
  };
}
