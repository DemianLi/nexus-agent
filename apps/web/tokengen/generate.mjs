/* global console, URL */
/**
 * 設計 token 產生器（設計期工具，不進產品 bundle）。定稿理由見 #377 的結論留言，現行規則見
 * `.docs/web-ui-spec.md` §5；從原型 tag `proto-375-design-language` 的 `prototype-375/tokengen/` 搬來（#401）。
 *
 * 用法：`pnpm --filter @nexus/web tokens:gen`。改色就改這裡的輸入，重跑，把兩個產物一起 commit；
 * 建置不跑這支，CI 只由 `src/styles/tokens-contrast.test.ts` 重算對比度。
 *
 * 分工（demian 拍板 Q42／Q43，實作時發現表面層要拆開）：
 * - 文字、brand、狀態色：Leonardo（@adobe/leonardo-contrast-colors）對「底色」解目標對比度，亮暗共用同一組數字。
 * - 表面（卡片、sidebar、chip）：也用 Leonardo 對底色解，但亮色卡片比底色亮、暗色也比底色亮，
 *   在 Leonardo 的符號裡是一負一正，所以數字共用、符號分主題寫。
 * - 不是「對底色」的配對（stage 對卡片、細線環對卡片、分隔線 alpha）：Leonardo 表達不了，用 colorjs.io 逐對二分解。
 * - 起算點是原型修過、demian 認可的那一版（Q43），先量出來再當目標。
 *
 * 輸出：`src/styles/tokens.generated.css`（oklch）＋ `tokengen/token-table.md`（值與對比度表）。
 */

import { BackgroundColor, Color as LeoColor, Theme } from '@adobe/leonardo-contrast-colors';
import Color from 'colorjs.io';
import { writeFileSync } from 'node:fs';

const out = (rel) => new URL(rel, import.meta.url);

// ── 基本工具 ──

const srgb = (css) => new Color(css).to('srgb').coords.map((v) => Math.min(1, Math.max(0, v)));
const hex = (rgb) => new Color('srgb', rgb).toString({ format: 'hex' });

/** 瀏覽器在 sRGB（gamma 編碼）上疊 alpha。 */
const over = (fgRgb, alpha, bgRgb) => fgRgb.map((f, i) => f * alpha + bgRgb[i] * (1 - alpha));

const wcag = (a, b) => new Color('srgb', a).contrast(new Color('srgb', b), 'WCAG21');

function oklch(rgb, alpha = 1) {
  const [l, c, h] = new Color('srgb', rgb).to('oklch').coords;
  const L = Number(l.toFixed(4));
  const C = c < 0.0005 ? 0 : Number(c.toFixed(4));
  const H = C === 0 || Number.isNaN(h) ? 0 : Number(h.toFixed(2));
  return alpha === 1
    ? `oklch(${L} ${C} ${H})`
    : `oklch(${L} ${C} ${H} / ${Number(alpha.toFixed(3))})`;
}

/** 在 [lo,hi] 上二分，找讓 f(x) 最接近 target 的 x；f 必須單調。 */
function bisect(f, target, lo, hi) {
  const increasing = f(hi) > f(lo);
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < target === increasing) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** 中性灰：對 ref 的對比度等於 target，方向 lighter／darker。 */
function solveGray(refRgb, target, direction) {
  const [lo, hi] = direction === 'lighter' ? [refRgb[0], 1] : [0, refRgb[0]];
  const v = bisect((x) => wcag([x, x, x], refRgb), target, lo, hi);
  return [v, v, v];
}

/** alpha 細線：base 色以 alpha 疊在 on 上，對 on 的對比度等於 target。 */
function solveAlpha(baseRgb, onRgb, target) {
  const a = bisect((x) => wcag(over(baseRgb, x, onRgb), onRgb), target, 0, 1);
  return Math.round(a * 1000) / 1000;
}

// ── 起算點：原型修過、demian 認可的值（eb800a1 的 tokens.css） ──

const PROTO = {
  light: {
    bg: srgb('#f7f7f7'),
    card: srgb('#ffffff'),
    stage: srgb('#f9f9f9'),
    chip: srgb('#ececec'),
    sidebar: srgb('#f2f2f2'),
    fg: srgb('#1a1a1a'),
    mutedFg: srgb('#6c6c6c'),
    hairline: [srgb('#000000'), 0.14],
    border: [srgb('#000000'), 0.07],
  },
  dark: {
    bg: srgb('#121212'),
    card: srgb('#181818'),
    stage: srgb('#131313'),
    chip: over(srgb('#ffffff'), 0.07, srgb('#181818')),
    sidebar: srgb('#121212'),
    fg: srgb('#ededed'),
    mutedFg: over(srgb('#cacaca'), 0.7, srgb('#121212')),
    hairline: [srgb('#c4c4c4'), 0.08],
    border: [srgb('#ffffff'), 0.06],
  },
};

const measured = {};
for (const theme of ['light', 'dark']) {
  const p = PROTO[theme];
  measured[theme] = {
    'card 對 底色': wcag(p.card, p.bg),
    'stage 對 卡片': wcag(p.stage, p.card),
    'chip 對 底色': wcag(p.chip, p.bg),
    'sidebar 對 底色': wcag(p.sidebar, p.bg),
    '細線環 對 卡片': wcag(over(p.hairline[0], p.hairline[1], p.card), p.card),
    '分隔線 對 底色': wcag(over(p.border[0], p.border[1], p.bg), p.bg),
    '文字 對 底色': wcag(p.fg, p.bg),
    '次要文字 對 底色': wcag(p.mutedFg, p.bg),
  };
}

// ── 目標：亮暗共用。邊界類取兩主題中較強的那個（兩邊 demian 都看過，取弱的會讓另一邊退步），文字同理 ──

const round2 = (x) => Math.round(x * 100) / 100;
const both = (key) => round2(Math.max(measured.light[key], measured.dark[key]));
const T = {
  card: both('card 對 底色'),
  stage: both('stage 對 卡片'),
  chip: both('chip 對 底色'),
  sidebar: both('sidebar 對 底色'),
  hairline: both('細線環 對 卡片'),
  border: both('分隔線 對 底色'),
  fg: both('文字 對 底色'),
  mutedFg: both('次要文字 對 底色'),
  brandMin: 4.5,
  status: 5.2,
};
// chip 的 hover／pressed：照 Libraries.dev 亮色的階梯比例（#f4f4f4 → #f1f1f1 → #eae9e9 對白卡）往上加
const LIB_STEP = {
  hover: wcag(srgb('#f1f1f1'), [1, 1, 1]) / wcag(srgb('#f4f4f4'), [1, 1, 1]),
  pressed: wcag(srgb('#eae9e9'), [1, 1, 1]) / wcag(srgb('#f4f4f4'), [1, 1, 1]),
};
T.chipHover = round2(T.chip * LIB_STEP.hover);
T.chipPressed = round2(T.chip * LIB_STEP.pressed);

// ── Leonardo：挑底色 lightness，讓底色最接近原型 ──

const NEUTRAL_KEYS = ['#000000', '#ffffff'];
const tw = (css) => hex(srgb(css));
const STATUS_KEYS = {
  destructive: [
    tw('oklch(80.8% 0.114 19.571)'),
    tw('oklch(63.7% 0.237 25.331)'),
    tw('oklch(44.4% 0.177 26.899)'),
  ],
  success: [
    tw('oklch(87.1% 0.15 154.449)'),
    tw('oklch(62.7% 0.194 149.214)'),
    tw('oklch(44.8% 0.119 151.328)'),
  ],
  warning: [
    tw('oklch(87.9% 0.169 91.605)'),
    tw('oklch(66.6% 0.179 58.318)'),
    tw('oklch(47.3% 0.137 46.201)'),
  ],
  info: [
    tw('oklch(80.9% 0.105 251.813)'),
    tw('oklch(54.6% 0.245 262.881)'),
    tw('oklch(42.4% 0.199 265.638)'),
  ],
};

function leonardo(theme, lightness) {
  const cardSign = theme === 'light' ? -1 : 1; // 亮色卡片比底色亮＝負方向；暗色卡片也比底色亮＝正方向
  const neutral = new BackgroundColor({
    name: 'neutral',
    colorKeys: NEUTRAL_KEYS,
    colorSpace: 'RGB',
    ratios: {
      card: cardSign * T.card,
      sidebar: T.sidebar,
      chip: T.chip,
      chipHover: T.chipHover,
      chipPressed: T.chipPressed,
      foreground: T.fg,
      mutedForeground: T.mutedFg,
    },
  });
  const colors = [neutral];
  if (theme === 'light') {
    colors.push(
      new LeoColor({
        name: 'brand',
        colorKeys: ['#0073e5'],
        colorSpace: 'OKLCH',
        ratios: { brand: 4.6 },
      }),
    );
  }
  for (const [name, keys] of Object.entries(STATUS_KEYS)) {
    colors.push(
      new LeoColor({ name, colorKeys: keys, colorSpace: 'OKLCH', ratios: { [name]: T.status } }),
    );
  }
  const out = new Theme({ colors, backgroundColor: neutral, lightness, output: 'HEX' })
    .contrastColors;
  const map = { background: srgb(out[0].background) };
  for (const group of out.slice(1)) for (const v of group.values) map[v.name] = srgb(v.value);
  return map;
}

function pickLightness(theme) {
  const want = PROTO[theme].bg;
  let best;
  for (let l = 0; l <= 100; l++) {
    const bg = leonardo(theme, l).background;
    const d = Math.abs(bg[0] - want[0]);
    if (best === undefined || d < best.d) best = { l, d };
  }
  return best.l;
}

const silence = console.warn;
console.warn = () => {};
const L = { light: pickLightness('light'), dark: pickLightness('dark') };
const leo = { light: leonardo('light', L.light), dark: leonardo('dark', L.dark) };
console.warn = silence;

// ── 組 token ──

const WHITE = [1, 1, 1];
const tokens = {};
const pairs = {};

for (const theme of ['light', 'dark']) {
  const g = leo[theme];
  const bg = g.background;
  const card = g.card;
  const stage = solveGray(card, T.stage, 'darker');
  const hairBase = theme === 'light' ? [0, 0, 0] : srgb('#c4c4c4');
  const hairAlpha = solveAlpha(hairBase, card, T.hairline);
  const borderBase = theme === 'light' ? [0, 0, 0] : WHITE;
  const borderAlpha = solveAlpha(borderBase, bg, T.border);
  const brand = theme === 'light' ? g.brand : srgb('#55cfff');
  const brandSoftAlpha = theme === 'light' ? 0.09 : 0.12; // Libraries.dev --accent-soft
  const primary = theme === 'light' ? srgb('#171717') : WHITE; // Libraries.dev .skill-btn--primary 是 #17181c，帶一點藍；Q25 定 primary 無彩，取同亮度的灰
  const primaryHover = theme === 'light' ? srgb('#2a2a2a') : srgb('#e8e8e8');
  const primaryActive = theme === 'light' ? [0, 0, 0] : srgb('#d8d8d8');
  const primaryFg = theme === 'light' ? WHITE : srgb('#0d0d0d');
  const hairOnCard = over(hairBase, hairAlpha, card);

  const t = {
    background: oklch(bg),
    foreground: oklch(g.foreground),
    card: oklch(card),
    'card-foreground': oklch(g.foreground),
    popover: oklch(card),
    'popover-foreground': oklch(g.foreground),
    primary: oklch(primary),
    'primary-foreground': oklch(primaryFg),
    'primary-hover': oklch(primaryHover),
    'primary-active': oklch(primaryActive),
    secondary: oklch(g.chip),
    'secondary-foreground': oklch(g.foreground),
    muted: oklch(g.chip),
    'muted-foreground': oklch(g.mutedForeground),
    accent: oklch(g.chipHover),
    'accent-foreground': oklch(g.foreground),
    destructive: oklch(g.destructive),
    success: oklch(g.success),
    warning: oklch(g.warning),
    info: oklch(g.info),
    border: oklch(borderBase, borderAlpha),
    input: oklch(hairBase, hairAlpha),
    ring: oklch(g.foreground),
    brand: oklch(brand),
    'brand-soft': oklch(brand, brandSoftAlpha),
    stage: oklch(stage),
    chip: oklch(g.chip),
    'chip-hover': oklch(g.chipHover),
    'chip-pressed': oklch(g.chipPressed),
    'card-hairline': oklch(hairBase, hairAlpha),
    sidebar: oklch(g.sidebar),
    'sidebar-foreground': oklch(g.foreground),
    'sidebar-primary': oklch(primary),
    'sidebar-primary-foreground': oklch(primaryFg),
    'sidebar-accent': oklch(g.chip),
    'sidebar-accent-foreground': oklch(g.foreground),
    'sidebar-border': oklch(borderBase, borderAlpha),
    'sidebar-ring': oklch(g.foreground),
  };
  tokens[theme] = t;

  const fgOn = (fg, name, on) => [name, wcag(fg, on)];
  pairs[theme] = {
    邊界: [
      ['卡片填色 對 底色', wcag(card, bg)],
      ['卡片細線環 對 卡片', wcag(hairOnCard, card)],
      ['卡片細線環 對 底色', wcag(over(hairBase, hairAlpha, bg), bg)],
      ['stage 對 卡片', wcag(stage, card)],
      ['chip 對 底色', wcag(g.chip, bg)],
      ['chip 對 卡片', wcag(g.chip, card)],
      ['sidebar 對 底色', wcag(g.sidebar, bg)],
      ['分隔線 對 底色', wcag(over(borderBase, borderAlpha, bg), bg)],
    ],
    文字: [
      fgOn(g.foreground, '文字 對 底色', bg),
      fgOn(g.foreground, '文字 對 chip', g.chip),
      fgOn(g.mutedForeground, '次要文字 對 底色', bg),
      fgOn(g.mutedForeground, '次要文字 對 卡片', card),
      fgOn(g.mutedForeground, '次要文字 對 stage', stage),
      fgOn(g.mutedForeground, '次要文字 對 chip', g.chip),
      fgOn(brand, 'brand 對 底色', bg),
      fgOn(brand, 'brand 對 卡片', card),
      fgOn(g.destructive, 'destructive 對 卡片', card),
      fgOn(g.success, 'success 對 卡片', card),
      fgOn(g.warning, 'warning 對 卡片', card),
      fgOn(g.info, 'info 對 卡片', card),
      fgOn(primaryFg, '主按鈕文字 對 主按鈕', primary),
    ],
    非文字: [
      ['焦點外框（文字色）對 底色', wcag(g.foreground, bg)],
      ['焦點外框（文字色）對 卡片', wcag(g.foreground, card)],
      ['brand 邊框光 對 卡片', wcag(brand, card)],
      ['destructive 對 底色', wcag(g.destructive, bg)],
      ['warning 對 底色', wcag(g.warning, bg)],
    ],
  };
}

// ── 輸出 CSS ──

const css = (sel, t) =>
  `${sel} {\n${Object.entries(t)
    .map(([k, v]) => `  --${k}: ${v};`)
    .join('\n')}\n}\n`;
writeFileSync(
  out('../src/styles/tokens.generated.css'),
  `/* 由 tokengen/generate.mjs 產生（Leonardo 底色 lightness：亮 ${L.light}、暗 ${L.dark}），不要手改。 */\n\n` +
    css(':root', tokens.light) +
    '\n' +
    css('.dark', tokens.dark),
);

// ── 輸出表格 ──

const f = (x) => x.toFixed(2);
let md = `## 起算點：原型（eb800a1）量到的對比度\n\n| 配對 | 亮 | 暗 |\n| --- | --- | --- |\n`;
for (const k of Object.keys(measured.light))
  md += `| ${k} | ${f(measured.light[k])} | ${f(measured.dark[k])} |\n`;
md += `\n## 共用目標（亮暗同一組）\n\n| 目標 | 值 |\n| --- | --- |\n`;
for (const [k, v] of Object.entries(T)) md += `| ${k} | ${typeof v === 'number' ? f(v) : v} |\n`;
md += `\nLeonardo 底色 lightness：亮 ${L.light}（${hex(leo.light.background)}）、暗 ${L.dark}（${hex(leo.dark.background)}）；卡片 亮 ${hex(leo.light.card)}、暗 ${hex(leo.dark.card)}。\n`;
for (const group of ['邊界', '文字', '非文字']) {
  md += `\n## ${group}\n\n| 配對 | 亮 | 暗 | 差 |\n| --- | --- | --- | --- |\n`;
  pairs.light[group].forEach(([name, v], i) => {
    const d = pairs.dark[group][i][1];
    md += `| ${name} | ${f(v)} | ${f(d)} | ${f(Math.abs(v - d))} |\n`;
  });
}
md += `\n## token 值（oklch）\n\n| token | 亮 | 暗 |\n| --- | --- | --- |\n`;
for (const k of Object.keys(tokens.light))
  md += `| \`--${k}\` | \`${tokens.light[k]}\` | \`${tokens.dark[k]}\` |\n`;
writeFileSync(out('token-table.md'), md);
console.log(md);
