/** 反例：同一顆插件多了一個 default 匯出。Loader 的 unwrapExports 會只取 default，具名的 inject／Config 就沒了。 */

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

export default { apply };
