/**
 * 服務契約走 semver：提供者掛上時，消費者宣告的範圍不含它的契約版本，就不讓消費者起來（決議 §3-4 第 15 條）。
 *
 * 用的是 Cordis 本來就有的一條路，不加任何東西（探針 [#1386](https://github.com/DemianLi/nexus-agent/issues/1386) ⑤，
 * 原型在 `apps/harness/src/measure/cordis-1386/contract.ts`，這裡是它搬進 SDK 的正式版）：
 *
 * - 消費者宣告範圍的地方有兩個——插件自己的 `inject: { tools: { range } }`（{@link injectOf} 組的就是這個），或
 *   Loader 列上的 `intercept`。兩者都落進消費者 ctx 的 `Context.intercept`。
 * - 提供者必須是 `Service`：它的 `[Service.check]` 由**消費者的** fiber 呼叫，`this` 是追蹤到消費者 ctx 的代理，
 *   所以讀得到消費者的範圍與列 id。plain object 提供者的 `check` 讀不到，不相容也會放行（探針 ⑤ 的負對照）——
 *   所以契約服務一律繼承 {@link ContractService}。
 * - 不相容時 `check` 拋 {@link ContractError}；Cordis 把它交給**提供者**的 logger，消費者留在 PENDING。
 *   要把錯誤對回消費者那一列，靠的是 {@link ContractError} 上的結構化欄位。
 *
 * ## 偏離 dsh
 *
 * dsh 一處都沒用 `check`（`Service.check` 在 `packages`、`apps` 為 0）；它的版本相容檢查在套件層，比的是整個
 * runtime 的版本（`packages/boot/app-boot/src/plugin-compatibility.ts:61-88`）。服務層級的 semver 是產品需求超出
 * dsh（決議 §五）。
 *
 * @module
 */

import { Context, Service } from '@nexus/cordis';
import type {} from '@nexus/cordis-plugin-loader';
import semver from 'semver';

import type { ServiceToken } from './token.js';

/** 消費者對一個契約服務宣告的東西。 */
export interface ContractIntercept {
  /** semver 範圍，例如 `^1.0.0`。沒宣告就不檢查。 */
  range?: string;
}

/** 契約不相容：指名消費者與提供者那兩列、服務、兩邊的版本與範圍。 */
export class ContractError extends Error {
  constructor(
    /** 消費者那一列的 id。 */
    readonly consumer: string,
    /** 提供者那一列的 id。 */
    readonly provider: string,
    /** 服務名（token 名）。 */
    readonly service: string,
    /** 提供者的契約版本。 */
    readonly provided: string,
    /** 消費者要的範圍。 */
    readonly range: string,
  ) {
    super(`插件 ${consumer} 要的服務 ${service} 是 ${range}，${provider} 提供的是 ${provided}`);
    this.name = 'ContractError';
  }
}

/**
 * 契約服務的基底：提供者繼承它，建構時給 token，服務名與契約版本都取自 token。
 *
 * `T` 把子類別綁到定義套件的介面：`class Registry extends ContractService<ToolRegistry> implements ToolRegistry`。
 */
export abstract class ContractService<T = unknown> extends Service<ContractIntercept> {
  /** 提供者那一列的 id。在建構子記下：`check` 裡的 `this.ctx` 追蹤到的是消費者。 */
  readonly provider: string;
  /** 這個服務的契約版本。 */
  readonly contractVersion: string;
  /** 只在型別層用：把子類別綁到 token 的介面。 */
  declare readonly token?: ServiceToken<T>;

  constructor(ctx: Context, token: ServiceToken<T>) {
    super(ctx, token.name);
    this.provider = ctx.fiber.entry?.id ?? ctx.fiber.runtime?.name ?? '(未知)';
    this.contractVersion = token.version;
  }

  [Service.check](): boolean {
    const { range } = this[Service.resolveConfig]();
    if (range === undefined || semver.satisfies(this.contractVersion, range)) return true;
    const consumer = this.ctx.fiber.entry?.id ?? this.ctx.fiber.runtime?.name ?? '(未知)';
    throw new ContractError(consumer, this.provider, this.name, this.contractVersion, range);
  }
}
