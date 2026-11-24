/** 測試共用的樹：只有 Loader 的根，插件放在 builtins，列用 `cordis:<名字>` 引用。 */

import { Context } from '@nexus/cordis';
import type { Message } from '@nexus/cordis';
import Loader from '@nexus/cordis-plugin-loader';
import type { EntryOptions } from '@nexus/cordis-plugin-loader';

export async function boot(builtins: Record<string, unknown> = {}) {
  const root = new Context();
  const errors: Message[] = [];
  root.logger.exporter({
    export: (message) => void (message.type === 'error' && errors.push(message)),
  });
  await root.plugin(Loader);
  Object.assign(root.loader.builtins, builtins);
  const loader: Loader = root.loader;
  /** 用自己決定的 id 建一列。`EntryTree.create` 的型別不收 id，但執行期照用（探針 tree.ts 同一處）。 */
  const create = (options: EntryOptions) =>
    loader.create(options as Omit<EntryOptions, 'id'>, null);
  const state = (id: string) => loader.resolve(id).fiber?.ctx.fiber.state;
  return { root, loader, errors, create, state };
}
