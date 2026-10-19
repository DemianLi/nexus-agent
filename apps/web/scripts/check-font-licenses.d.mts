/** `check-font-licenses.mjs` 的型別（#1713）：實作與註解在 `.mjs`，`pnpm build`（Node 直接跑）與 `src/font-licenses.test.ts` 共用。 */
export declare const EXPECTED: readonly { readonly fileName: string; readonly marker: string }[];
export declare function checkFontLicenses(dist: URL): string[];
