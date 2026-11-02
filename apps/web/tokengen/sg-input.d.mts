/** `sg-input.mjs` 的型別（`src/styles/sg-input.test.ts` 與 `tokens-generated.test.ts` 從 TS 讀它）。 */
type Theme = 'light' | 'dark';

export declare const SG: Record<Theme, Record<string, string>>;

export declare const SG_REDUCED_TRANSPARENCY: { condition: string } & Record<
  Theme,
  Record<string, string>
>;
