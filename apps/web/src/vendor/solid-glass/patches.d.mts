/** `patches.mjs` 的型別（#1583）：實作與註解在 `.mjs`，`sync.mjs`（Node 直接跑）與 `vendor.test.ts` 共用。 */
export declare const PATCH_NAME: RegExp;
export declare function applyAll(source: string, patches: readonly [string, string][]): string;
export declare function revertAll(patched: string, patches: readonly [string, string][]): string;
export declare function createOne(file: string, before: string, after: string): string;
