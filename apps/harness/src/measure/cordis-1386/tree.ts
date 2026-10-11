/**
 * [#1386](https://github.com/DemianLi/nexus-agent/issues/1386) 探針共用的 Cordis 樹：一顆只有 Loader 的根，插件放在 builtins，列用 `cordis:<名字>` 引用。
 *
 * 這裡繞過了兩個 vendor 的型別缺口，報告的 ① 有列：
 *
 * - `FiberState` 是 `const enum`，nexus 開了 `verbatimModuleSyntax`，從宣告檔讀它會 TS2748。這裡照上游的值抄一份。
 * - `EntryTree.create` 的參數型別是 `Omit<EntryOptions, 'id'>`，但執行期 `ensureId` 照用傳進來的 id。
 *   變更紀錄要重播出同一棵樹，id 必須由紀錄決定，所以 {@link createEntry} 用完整的 `EntryOptions`。
 *
 * @module
 */

import { Context } from 'cordis';
import type { Fiber, Message } from 'cordis';
import Loader from '@cordisjs/plugin-loader';
import type { EntryOptions } from '@cordisjs/plugin-loader';

/** 上游 `FiberState` 的值（vendor/cordis/src/fiber.ts）。 */
export const STATE = { PENDING: 0, LOADING: 1, ACTIVE: 2, UNLOADING: 3, DISPOSED: 4 } as const;

/** 用自己決定的 id 建一列，回傳完整 id。 */
export function createEntry(loader: Loader, options: EntryOptions, parent: string | null = null) {
  return loader.create(options as Omit<EntryOptions, 'id'>, parent);
}

/**
 * 那一列真正的 Fiber。上游 `Entry.fiber` 存的是 `registry.plugin()` 回的 PromiseLike 包裝，不是 Fiber 本身
 * （dsh 本地修改第 20 條修的就是這個）；要比身分得取 `.ctx.fiber`。
 */
export function fiberOf(loader: Loader, id: string): Fiber | undefined {
  return loader.resolve(id).fiber?.ctx.fiber;
}

/** 開一棵樹，收集所有 error 層級的 log。 */
export async function boot(builtins: Record<string, unknown> = {}) {
  const root = new Context();
  const errors: Message[] = [];
  root.logger.exporter({
    export: (message) => void (message.type === 'error' && errors.push(message)),
  });
  await root.plugin(Loader);
  Object.assign(root.loader.builtins, builtins);
  const state = (id: string) => root.loader.resolve(id).fiber?.state;
  return { root, loader: root.loader, errors, state };
}
