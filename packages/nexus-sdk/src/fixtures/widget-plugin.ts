/** 一顆合格的函式插件，寫成真的 ES 模組：`import * as` 得到的命名空間就是 Loader 會看到的東西。 */

import type { Context } from '@nexus/cordis';

import { service } from '../token.js';
import { widgetConfig, widgetInject, widgetManifest, widgetsToken } from './registry.js';

export const name = 'widget-consumer';
export const inject = widgetInject;
export const Config = widgetConfig;
export const manifest = widgetManifest();

export function apply(ctx: Context, config: { label: string }): void {
  service(ctx, widgetsToken).register(config.label);
}
