/**
 * `@nexus/brand`：名義型別（branded string／number）的共用工具，**原碼照抄 dsh** `packages/util/brand/src/index.ts`
 * （MIT；`687f282e`），只改成這個 repo 的格式（分號、單引號）與註解，邏輯一行不動。
 * 為什麼是獨立套件：dsh 本身就是 `@deepseek-ai/dsh-brand` 一個零相依套件，核心的 id 都靠它帶品牌，我們的基礎建設也做得出來，
 * 所以照 dsh（[#1569](https://github.com/DemianLi/nexus-agent/issues/1569)）。
 *
 * 品牌只在編譯期存在：`Branded<B>` 是 `string & { readonly [BRAND]: B }`，執行期就是那串字，比較、記日誌、序列化都和裸字串一樣。
 * 這個套件不擁有任何具體的領域值、不留執行期身分或可變狀態，所以多份獨立安裝產生的值可以互換。
 *
 * @module
 */

declare const BRAND: unique symbol;

/** 帶編譯期品牌 `B` 的字串。 */
export type Branded<B extends string> = string & { readonly [BRAND]: B };

/** 帶編譯期品牌 `B` 的數字。 */
export type BrandedNumber<B extends string> = number & { readonly [BRAND]: B };

/**
 * 掛上字串品牌，值不變。
 *
 * @param value - 擁有目標品牌的領域所接受的字串。
 * @returns 同一串字，帶著要求的編譯期品牌。
 */
export function brandString<T extends Branded<string>>(value: string | T): T {
  return value as T;
}

/**
 * 掛上數字品牌，值不變。
 *
 * @param value - 擁有目標品牌的領域所接受的數字。
 * @returns 同一個數字，帶著要求的編譯期品牌。
 */
export function brandNumber<T extends BrandedNumber<string>>(value: number | T): T {
  return value as T;
}
