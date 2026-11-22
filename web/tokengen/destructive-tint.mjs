/**
 * destructive 的淡紅底 alpha（#1523）。SG 的 destructive 按鈕、badge、泡泡是淡紅底配 `text-destructive`，字疊在淡紅底上也要過 4.5（Q5）。
 *
 * - `DESTRUCTIVE_REST`：平常那一格，vendor 原值（`bg-destructive/10`、暗 `dark:bg-destructive/20`），`solid-glass-overrides.test.ts`
 *   比對 vendor 原文仍是這兩個值。
 * - `DESTRUCTIVE_HOVER`：按鈕 hover 那一格（PM 定格 2）。vendor 是亮 `/20`、暗 `/30`，字在上面到不了 4.5；要它到 4.5，`--destructive`
 *   得解到暗色變粉（格 1）。所以 hover 底調淡、`--destructive` 照常解：取 hover 與平常的明度差亮暗都 ≥ 0.03 的格子裡，`--destructive`
 *   離 SG 原值最近的那一格。`src/styles/solid-glass.overrides.css` 用同樣的百分比蓋掉 vendor 的 hover 底（README 本地修改第 17 條）；
 *   CSS 寫不了 import，所以覆寫檔寫字面值，`solid-glass-overrides.test.ts` 比對兩邊一致。
 *
 * 用到的：`generate.mjs` 拿兩格當 `--destructive` 的約束；`src/styles/tokens-contrast.test.ts` 照兩格重算產物的對比。
 */
export const DESTRUCTIVE_REST = { light: 0.1, dark: 0.2 };
export const DESTRUCTIVE_HOVER = { light: 0.17, dark: 0.26 };
