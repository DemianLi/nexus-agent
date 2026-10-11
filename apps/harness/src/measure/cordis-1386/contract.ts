/**
 * [#1386](https://github.com/DemianLi/nexus-agent/issues/1386) 驗收 ⑤ 的素材：服務契約走 semver，載入時用 `provide` 的 `check` 擋下不相容的提供者。
 *
 * 用的是 Cordis 本來就有的一條路，不加任何東西：
 *
 * - 消費者宣告範圍的地方有兩個——插件自己的 `inject: { memory: { range } }`，或 Loader 列上的 `intercept: { memory: { range } }`。
 *   兩者都落進消費者 ctx 的 `Context.intercept`（vendor/cordis/src/fiber.ts 的建構子、vendor/loader/src/config/isolate.ts 的 patch-context）。
 * - 提供者是 `Service`：它的 `[Service.check]` 由**消費者的** fiber 呼叫（`Fiber._checkImpl`），`this` 是追蹤到消費者 ctx 的代理，
 *   所以 `this[Service.resolveConfig]()` 讀到的是消費者宣告的範圍，`this.ctx.fiber.entry` 是消費者那一列。
 *   Loader 自己的 `await` 檢查就是這樣用的（vendor/loader/src/index.ts 的 `[Service.check]`）。
 *
 * 不相容時 `check` 拋 {@link ContractError}；Cordis 把它交給**提供者**的 logger，消費者留在 PENDING。
 *
 * @module
 */

import { Context, Service } from '@nexus/cordis';
import type {} from '@nexus/cordis-plugin-loader';
import semver from 'semver';

/** 消費者對一個契約服務宣告的東西。 */
export interface ContractIntercept {
  /** semver 範圍，例如 `^2.0.0`。沒宣告就不檢查。 */
  range?: string;
}

/** 契約不相容：指名消費者與提供者那兩列、服務、兩邊的版本。 */
export class ContractError extends Error {
  constructor(
    readonly consumer: string,
    readonly provider: string,
    readonly service: string,
    readonly provided: string,
    readonly range: string,
  ) {
    super(`插件 ${consumer} 要的服務 ${service} 是 ${range}，${provider} 提供的是 ${provided}`);
    this.name = 'ContractError';
  }
}

/** 一個提供 `name` 服務、契約版本為 `version` 的 Cordis 插件。 */
export function contractProvider(name: string, version: string) {
  return class ContractProvider extends Service<ContractIntercept> {
    static readonly contractVersion = version;

    /** 提供者那一列的 id。在建構子記下：`check` 裡的 `this.ctx` 追蹤到的是消費者。 */
    readonly provider: string;

    constructor(ctx: Context) {
      super(ctx, name);
      this.provider = ctx.fiber.entry?.id ?? ctx.fiber.runtime?.name ?? '(未知)';
    }

    readonly version = version;

    [Service.check](): boolean {
      const { range } = this[Service.resolveConfig]();
      if (range === undefined || semver.satisfies(version, range)) return true;
      const consumer = this.ctx.fiber.entry?.id ?? this.ctx.fiber.runtime?.name ?? '(未知)';
      throw new ContractError(consumer, this.provider, name, version, range);
    }
  };
}
