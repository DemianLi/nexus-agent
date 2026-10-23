/**
 * 帶型別的服務 token：定義套件匯出 token 與介面，消費方經 token 取得服務（決議 §3-4 第 14 條）。
 *
 * ## 偏離 dsh
 *
 * dsh 用 declaration merging（`declare module '@deepseek-ai/cordis' { interface Context { tools: ... } }`）
 * 加型錄生成器。幾百人並行開發下，全域命名空間只能靠人工登記表守，型別保證在執行期又不成立。token 是一個
 * 值：名字與型別綁在一起、由定義套件擁有，打錯名字或拿錯型別在 `tsc` 就停下（決議 §五）。
 *
 * 字串鍵只留給框架內部——Cordis 自己仍以字串為鍵，所以 {@link ServiceToken.name} 就是那個鍵。
 *
 * @module
 */

import type { Context } from '@nexus/cordis';

declare const phantom: unique symbol;

/**
 * 一個服務的 token。
 *
 * `T` 只活在型別層：執行期這就是 `{ name, version }`。
 */
export interface ServiceToken<T> {
  /** Cordis 的服務鍵。 */
  readonly name: string;
  /** 契約版本（semver）。提供者掛上時，消費者宣告的範圍要含它。 */
  readonly version: string;
  /** 只在型別層存在，讓 `ServiceToken<A>` 與 `ServiceToken<B>` 不能互換。 */
  readonly [phantom]?: T;
}

/** 定義一個 token。**定義套件**呼叫，消費者與提供者都只 import 它。 */
export function defineToken<T>(name: string, version: string): ServiceToken<T> {
  return Object.freeze({ name, version });
}

/** 消費者對一個 token 的需求：範圍寫在這裡，由 {@link injectOf} 變成 `inject`。 */
export interface Need<T = unknown> {
  readonly token: ServiceToken<T>;
  readonly range: string;
}

/** 對 `token` 要 `range` 範圍內的契約版本。 */
export function need<T>(token: ServiceToken<T>, range: string): Need<T> {
  return { token, range };
}

/**
 * 組出插件的 `inject`：`{ [token.name]: { range } }`。
 *
 * 範圍由提供者的 `[Service.check]` 經 `Service.resolveIntercept` 讀到（rc.12 起不再複製進 `Context.intercept`，上游 #206）
 * （探針 #1386 ⑤）。manifest 的 `consumes` 與它是同一份宣告的兩個面，一致性套件比對兩邊。
 */
export function injectOf(...needs: readonly Need[]): Record<string, { range: string }> {
  return Object.fromEntries(needs.map((n) => [n.token.name, { range: n.range }]));
}

/**
 * 讀一個**已宣告**在 `inject` 裡的服務。沒宣告就讀，Cordis 拋錯（「cannot get property without inject」），
 * 這是決議 §3-4 第 11 條要的行為。
 */
export function service<T>(ctx: Context, token: ServiceToken<T>): T {
  return (ctx as unknown as Record<string, T>)[token.name] as T;
}

/**
 * 讀一個**選配**服務：沒提供就是 `undefined`，不拋。選配的服務不放進 `inject`（dsh `packages/AGENTS.md:6`）。
 */
export function optionalService<T>(ctx: Context, token: ServiceToken<T>): T | undefined {
  return ctx.get(token.name) as T | undefined;
}
