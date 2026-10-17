/**
 * 產生器的 SG 輸入表（#1512，#1468 Q10）：`src/vendor/solid-glass/solid-glass.css` 裡產生器會讀到的值，照抄。
 * `src/styles/sg-input.test.ts` 用 `readCascade` 直接讀 vendor 檔逐值比對，SG 升版改了值、這裡沒跟上就紅。
 *
 * 只列產生器用得到的：底色與漸層停點（量對比要疊）、字色、面（量鑑別度、算 stage 與細線）、要約束的顏色。
 */

/** `:root`／`.dark` 底下沒有條件的值。 */
export const SG = {
  light: {
    background: 'oklch(0.925 0.007 265)',
    foreground: 'oklch(0.16 0 0)',
    'muted-foreground': 'oklch(0.47 0 0)',
    card: 'oklch(0.98 0.004 265 / 60%)',
    border: 'oklch(0.3 0.02 265 / 13%)',
    sidebar: 'oklch(0.975 0.004 265 / 44%)',
    'light-1': 'oklch(0.68 0.13 165 / 7%)',
    'light-2': 'oklch(0.75 0.08 240 / 11%)',
    'light-3': 'oklch(0.68 0.13 165 / 4%)',
    brand: 'oklch(0.68 0.13 165)',
    destructive: 'oklch(0.577 0.245 27.325)',
    success: 'oklch(0.58 0.15 152)',
    'status-done': 'oklch(0.56 0.16 248)',
    'status-interrupted': 'oklch(0.66 0.16 58)',
    'status-running': 'oklch(0.52 0 0)',
    link: 'oklch(0.5 0.17 255)',
  },
  dark: {
    background: 'oklch(0.16 0 0)',
    foreground: 'oklch(0.985 0 0)',
    'muted-foreground': 'oklch(0.72 0 0)',
    card: 'oklch(0.31 0 0 / 46%)',
    border: 'oklch(1 0 0 / 11%)',
    sidebar: 'oklch(0.11 0 0 / 50%)',
    'light-1': 'transparent',
    'light-2': 'transparent',
    'light-3': 'transparent',
    brand: 'oklch(0.78 0.13 166)',
    destructive: 'oklch(0.704 0.191 22.216)',
    success: 'oklch(0.74 0.16 152)',
    'status-done': 'oklch(0.68 0.15 250)',
    'status-interrupted': 'oklch(0.77 0.15 62)',
    'status-running': 'oklch(0.72 0 0)',
    link: 'oklch(0.76 0.12 250)',
  },
};

/**
 * SG 在 `@media (prefers-reduced-transparency: reduce)` 底下給的不透明面。產物覆寫了其中哪一個，
 * 就要在後面照樣重寫這段：無條件的 `:root { --card }` 排在 SG 後面，會把這裡的不透明值蓋掉。
 */
export const SG_REDUCED_TRANSPARENCY = {
  condition: '@media (prefers-reduced-transparency: reduce)',
  light: {
    panel: 'oklch(0.947 0.006 265)',
    card: 'oklch(0.958 0.005 265)',
    popover: 'oklch(0.98 0.003 265)',
    sidebar: 'oklch(0.985 0 0)',
  },
  dark: {
    panel: 'oklch(0.19 0 0)',
    card: 'oklch(0.225 0 0)',
    popover: 'oklch(0.22 0 0)',
    sidebar: 'oklch(0.13 0 0)',
  },
};
