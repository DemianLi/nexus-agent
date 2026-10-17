// @vitest-environment node
import { describe, expect, test } from 'vitest';

import { surfaceContrast } from './color-math';
import { readCascade, type Query } from './css-cascade';

/**
 * `.docs/web-ui-spec.md` §11 第 2 條：用 colorjs.io 重算**實際生效**的顏色 token，確認達到 §5 的對比度目標。
 * 產生器（`tokengen/generate.mjs`）解的是目標，這裡驗的是 `index.css` 照 import 順序疊出來的結果（`css-cascade.ts`，#1498）：
 * 手改了產物、改了產生器輸入卻忘了重跑、oklch 四捨五入吃掉邊際、後面疊上來的樣式表蓋掉了產物，都在這裡紅。
 *
 * 目標（§5）：文字 ≥ 4.5、非文字 ≥ 3（SC 1.4.11）、狀態色對底色 5.2（產生器的解目標，讓暗色狀態色對卡片
 * 仍過 4.5）、brand 在亮色底色上 ≥ 4.5；亮暗鑑別度一樣＝表面這一層的每一對，亮暗差不超過 0.05（只疊在底色上）。
 *
 * 量的是 token，不是元素：元件實際的底色若是 `color-mix()` 之類現場合成的，這裡看不到，由瀏覽器那一層（`guard/`）量。
 *
 * 面有三種狀態，每一種都要達標（{@link MODES}）：平常的半透明、系統要求減少透明度（`prefers-reduced-transparency`）、
 * 頁面標了 `data-glass="opaque"`（#1468 Q7：效能不達標時退回的那條路）。後兩種的面換成 SG 的不透明值，跟半透明疊出來的不完全一樣。
 */

type Theme = 'light' | 'dark';

const cascade = readCascade();

/**
 * `.dark` 掛在 `<html>` 上（`index.html`、`lib/theme.ts`），所以暗色時 `:root` 與 `.dark` 落在同一個元素、specificity 相同，
 * 誰贏看 layer 與先後：後面一條只寫 `:root` 的覆寫，暗色也會被它蓋掉。
 */
const SELECTORS: Record<Theme, readonly string[]> = { light: [':root'], dark: [':root', '.dark'] };

interface Mode {
  readonly name: string;
  readonly selectors: Record<Theme, readonly string[]>;
  readonly query?: Query;
}

/** 量具只看 layer 與先後、不算 specificity；`data-glass` 掛在 `<html>` 上時，產物裡暗色那段排在後面，結果跟瀏覽器一樣。 */
const TRANSLUCENT: Mode = { name: '半透明', selectors: SELECTORS };

const MODES: Mode[] = [
  TRANSLUCENT,
  {
    name: 'reduced-transparency',
    selectors: SELECTORS,
    query: { conditions: ['@media (prefers-reduced-transparency: reduce)'] },
  },
  {
    name: 'data-glass="opaque"',
    selectors: {
      light: [':root', "[data-glass='opaque']"],
      dark: [':root', '.dark', "[data-glass='opaque']", ".dark[data-glass='opaque']"],
    },
  },
];

function token(mode: Mode, theme: Theme, name: string): string | undefined {
  return cascade.computed(mode.selectors[theme], `--${name}`, mode.query);
}

/**
 * 半透明的面疊在哪裡（#1512）：頁面底色，以及頁面漸層的每一個停點（`--light-N`，本身半透明、疊在底色上）。
 * 最差的那一疊要達標（`color-math.ts` 的 `surfaceContrast`）。
 */
function bases(theme: Theme, mode: Mode = TRANSLUCENT): string[][] {
  const stops = [...cascade.customProperties(mode.selectors[theme], mode.query).keys()]
    .map((property) => /^--(light-\d+)$/.exec(property)?.[1])
    .filter((name) => name !== undefined)
    .sort();
  return [['background'], ...stops.map((stop) => ['background', stop])];
}

const ONLY_BACKGROUND = [['background']];

function contrast(
  mode: Mode,
  theme: Theme,
  fg: string,
  bg: string,
  under = bases(theme, mode),
): number {
  return surfaceContrast((name) => token(mode, theme, name), fg, bg, under).ratio;
}

const THEMES: Theme[] = ['light', 'dark'];

const TEXT: [string, string][] = [
  ['foreground', 'background'],
  ['foreground', 'chip'],
  ['card-foreground', 'card'],
  ['popover-foreground', 'popover'],
  ['muted-foreground', 'background'],
  ['muted-foreground', 'card'],
  ['muted-foreground', 'stage'],
  ['muted-foreground', 'chip'],
  ['muted-foreground', 'chip-hover'],
  ['foreground', 'chip-hover'],
  ['foreground', 'chip-pressed'],
  ['primary-foreground', 'primary'],
  ['secondary-foreground', 'secondary'],
  ['accent-foreground', 'accent'],
  ['sidebar-foreground', 'sidebar'],
  ['sidebar-accent-foreground', 'sidebar-accent'],
  ['sidebar-primary-foreground', 'sidebar-primary'],
  ['brand', 'background'],
  ['brand', 'card'],
  ['destructive', 'card'],
  ['success', 'card'],
  ['warning', 'card'],
  ['info', 'card'],
  // 程式碼區塊（stage）上的語法色（`shiki.css`）。
  ['foreground', 'stage'],
  ['brand', 'stage'],
  ['destructive', 'stage'],
  ['success', 'stage'],
  ['warning', 'stage'],
];

const NON_TEXT: [string, string][] = [
  ['ring', 'background'],
  ['ring', 'card'],
  ['brand', 'card'],
];

/** SG 自己的 `status-*` 也算狀態色、套 5.2（demian，#1512，2026-10-17）。 */
const STATUS = [
  'destructive',
  'success',
  'warning',
  'info',
  'status-done',
  'status-interrupted',
  'status-running',
];

/**
 * 表面這一層：亮暗要一樣分得出來。**只疊在 `--background` 上量**，不算漸層停點（PM，#1512）：鑑別度問的是「這一片面跟頁面分不分得開」，
 * 面是一整片，停點只是頁面上幾處很淡的光暈（亮色 4–11%、暗色沒有）；算進去的話，亮色多了幾疊、暗色沒有，比的就不是同一件事。
 */
const SURFACES: [string, string][] = [
  ['card', 'background'],
  ['stage', 'card'],
  ['chip', 'background'],
  ['sidebar', 'background'],
  ['card-hairline', 'card'],
  ['border', 'background'],
];

/**
 * 按下去的 chip 與 warning 膠囊：develop 就沒到 4.5（既有缺口 #1515，⑥ 處理）。這裡只守「不比 develop 差」，
 * 數字是 develop（c9b957b6）產物照同一套算法重算、截到小數第四位（PM，#1512）。
 */
const NOT_WORSE_THAN_DEVELOP: Record<Theme, [string, string, number][]> = {
  light: [
    ['muted-foreground', 'chip-pressed', 4.3325],
    ['warning', 'chip', 4.0858],
    ['warning', 'chip-hover', 4.0084],
    ['warning', 'chip-pressed', 3.7081],
  ],
  dark: [
    ['muted-foreground', 'chip-pressed', 4.2964],
    ['warning', 'chip', 4.074],
    ['warning', 'chip-hover', 3.9642],
    ['warning', 'chip-pressed', 3.6952],
  ],
};

/** oklch 寫到小數第四位，重算會比產生器的解少一點點；只容許這個量級。 */
const ROUNDING = 0.01;

describe.each(MODES)('產生出來的 token 達到對比度目標：$name', (mode) => {
  for (const theme of THEMES) {
    test.each(TEXT)(`${theme}：文字 %s 對 %s ≥ 4.5`, (fg, bg) => {
      expect(contrast(mode, theme, fg, bg)).toBeGreaterThanOrEqual(4.5);
    });

    test.each(NON_TEXT)(`${theme}：非文字 %s 對 %s ≥ 3`, (fg, bg) => {
      expect(contrast(mode, theme, fg, bg)).toBeGreaterThanOrEqual(3);
    });

    test.each(NOT_WORSE_THAN_DEVELOP[theme])(
      `${theme}：%s 對 %s 不比 develop 的 %s 差（既有缺口 #1515）`,
      (fg, bg, floor) => {
        expect(contrast(mode, theme, fg, bg)).toBeGreaterThanOrEqual(floor);
      },
    );

    test.each(STATUS)(`${theme}：狀態色 %s 對底色 ≥ 5.2`, (status) => {
      expect(contrast(mode, theme, status, 'background')).toBeGreaterThanOrEqual(5.2 - ROUNDING);
    });
  }

  test.each(SURFACES)('亮暗鑑別度一樣：%s 對 %s 亮暗差 ≤ 0.05（只疊在底色上）', (fg, bg) => {
    const light = contrast(mode, 'light', fg, bg, ONLY_BACKGROUND);
    const dark = contrast(mode, 'dark', fg, bg, ONLY_BACKGROUND);
    expect(Math.abs(light - dark)).toBeLessThanOrEqual(0.05);
  });
});

describe('量具自檢', () => {
  test('每一疊底都有疊到——SG 的三個漸層停點都在（少了就只量平的底色，偏寬）', () => {
    for (const theme of THEMES) {
      expect(bases(theme)).toEqual([
        ['background'],
        ['background', 'light-1'],
        ['background', 'light-2'],
        ['background', 'light-3'],
      ]);
    }
  });

  test('不透明的兩種狀態真的換了面：--card 不透明、跟半透明那一套不同', () => {
    for (const mode of MODES.slice(1)) {
      for (const theme of THEMES) {
        const card = token(mode, theme, 'card') ?? '';
        expect(card, `${mode.name} ${theme}`).not.toMatch(/\//);
        expect(card).not.toBe(token(TRANSLUCENT, theme, 'card'));
      }
    }
  });
});
