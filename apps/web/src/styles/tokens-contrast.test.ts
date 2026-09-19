// @vitest-environment node
import { readFileSync } from 'node:fs';
import Color from 'colorjs.io';
import { describe, expect, test } from 'vitest';

/**
 * `.docs/web-ui-spec.md` §11 第 2 條：用 colorjs.io 重算**產生出來的** token（`tokens.generated.css`），
 * 確認達到 §5 的對比度目標。產生器（`tokengen/generate.mjs`）解的是目標，這裡驗的是寫進版控的產物：
 * 手改了產物、改了產生器輸入卻忘了重跑、oklch 四捨五入吃掉邊際，都在這裡紅。
 *
 * 目標（§5）：文字 ≥ 4.5、非文字 ≥ 3（SC 1.4.11）、狀態色對底色 5.2（產生器的解目標，讓暗色狀態色對卡片
 * 仍過 4.5）、brand 在亮色底色上 ≥ 4.5；亮暗鑑別度一樣＝表面這一層的每一對，亮暗差不超過 0.05。
 */

type Theme = 'light' | 'dark';
type Rgb = [number, number, number];

const css = readFileSync(new URL('./tokens.generated.css', import.meta.url), 'utf8');

function block(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`tokens.generated.css 裡沒有 ${selector}`);
  const body = css.slice(start, css.indexOf('}', start));
  return new Map(
    [...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1] ?? '', (m[2] ?? '').trim()]),
  );
}

const tokens: Record<Theme, Map<string, string>> = { light: block(':root'), dark: block('.dark') };

function parse(value: string): { rgb: Rgb; alpha: number } {
  const color = new Color(value).to('srgb');
  const rgb = color.coords.map((v) => Math.min(1, Math.max(0, v ?? 0))) as Rgb;
  return { rgb, alpha: color.alpha ?? 1 };
}

/** 瀏覽器在 sRGB（gamma 編碼）上疊 alpha；半透明 token 要先疊在它實際所在的底上。 */
function resolve(theme: Theme, name: string, on?: Rgb): Rgb {
  const value = tokens[theme].get(name);
  if (value === undefined) throw new Error(`${theme} 沒有 --${name}`);
  const { rgb, alpha } = parse(value);
  if (alpha === 1) return rgb;
  if (on === undefined) throw new Error(`--${name} 是半透明的，要指定疊在什麼上面`);
  return rgb.map((c, i) => c * alpha + (on[i] ?? 0) * (1 - alpha)) as Rgb;
}

function contrast(theme: Theme, fg: string, bg: string): number {
  const under = resolve(theme, bg);
  const over = resolve(theme, fg, under);
  return new Color('srgb', over).contrast(new Color('srgb', under), 'WCAG21');
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

const STATUS = ['destructive', 'success', 'warning', 'info'];

/** 表面這一層：亮暗要一樣分得出來。 */
const SURFACES: [string, string][] = [
  ['card', 'background'],
  ['stage', 'card'],
  ['chip', 'background'],
  ['sidebar', 'background'],
  ['card-hairline', 'card'],
  ['border', 'background'],
];

/** oklch 寫到小數第四位，重算會比產生器的解少一點點；只容許這個量級。 */
const ROUNDING = 0.01;

describe('產生出來的 token 達到對比度目標', () => {
  for (const theme of THEMES) {
    test.each(TEXT)(`${theme}：文字 %s 對 %s ≥ 4.5`, (fg, bg) => {
      expect(contrast(theme, fg, bg)).toBeGreaterThanOrEqual(4.5);
    });

    test.each(NON_TEXT)(`${theme}：非文字 %s 對 %s ≥ 3`, (fg, bg) => {
      expect(contrast(theme, fg, bg)).toBeGreaterThanOrEqual(3);
    });

    test.each(STATUS)(`${theme}：狀態色 %s 對底色 ≥ 5.2`, (status) => {
      expect(contrast(theme, status, 'background')).toBeGreaterThanOrEqual(5.2 - ROUNDING);
    });
  }

  test.each(SURFACES)('亮暗鑑別度一樣：%s 對 %s 亮暗差 ≤ 0.05', (fg, bg) => {
    const light = contrast('light', fg, bg);
    const dark = contrast('dark', fg, bg);
    expect(Math.abs(light - dark)).toBeLessThanOrEqual(0.05);
  });
});
