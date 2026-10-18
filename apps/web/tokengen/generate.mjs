/* global console, URL */
/**
 * 設計 token 產生器（設計期工具，不進產品 bundle）。現行規則見 `.docs/web-ui-spec.md` §5。
 *
 * 用法：`pnpm --filter @nexus/web tokens:gen`。改色就改這裡（或 `sg-input.mjs`）的輸入，重跑，把兩個產物一起 commit；
 * 建置不跑這支，CI 由 `src/styles/tokens-contrast.test.ts` 與 `src/styles/tokens-generated.test.ts` 重算。
 *
 * #1512（#1468 Q10）起，外觀照 solid-glass（SG），這支只產出**要覆寫 SG 的 token**，SG 沒改的值不重複寫：
 * 1. **SG 不達標的顏色**：以 SG 的值為起點、Q5 的下限當約束，只動不達標的，只動到剛好達標（PM 定的讀法）。
 *    解法照 demian 選的 B 案（#1512，2026-10-17）：色相照 SG，彩度先夾進 sRGB 邊界，再以 0.001 為步長往對比變大的方向
 *    解明度，停在第一個達標的值。夾進 sRGB 是為了「畫的就是量的」：對比在 sRGB 上算，超出 sRGB 的顏色在 P3 螢幕上畫出來
 *    跟量到的不一樣。對比都疊到最差的那一疊底上算（SG 底色＋每個漸層停點；卡片是半透明的面再疊上去），同 gate。
 * 2. **SG 表面的亮暗鑑別度**：亮暗差 ≤ 0.05，只疊在 `--background` 上量；不達標時只調亮色、暗色不動（PM 定）。
 * 3. **nexus 獨有的 token**（留到 #1497 第 ⑥ 步再整理，Q11）：保留原本的目標，改成對 SG 的底色重解。
 * 4. `--ring`／`--sidebar-ring`＝字色（Q5：焦點外框用文字色）。
 *
 * 亮暗**一定成對**：只在一個主題調整的 token，另一個主題也寫一份（值照 SG）。`.dark` 掛在 `<html>` 上，跟 `:root`
 * 落在同一個元素、同 specificity，只寫 `:root` 的話暗色會吃到亮色的值。覆寫了 SG 在 reduced-transparency 底下也給值的
 * token，就照樣把那段重寫在後面（無條件的覆寫排在 SG 後面，會蓋掉它的不透明值）。
 *
 * 輸出：`src/styles/tokens.generated.css`（oklch）＋ `tokengen/token-table.md`（值與對比度表）。
 */

import Color from 'colorjs.io';
import { writeFileSync } from 'node:fs';

import { DESTRUCTIVE_HOVER, DESTRUCTIVE_REST } from './destructive-tint.mjs';
import { SG, SG_REDUCED_TRANSPARENCY } from './sg-input.mjs';

const out = (rel) => new URL(rel, import.meta.url);
const THEMES = ['light', 'dark'];

// ── 基本工具（同 `src/styles/color-math.ts`：sRGB 逐通道裁切、在 gamma 編碼上疊 alpha） ──

/** 任何 CSS 顏色 → sRGB 三通道（逐通道裁切）與 alpha。 */
function parse(css) {
  const c = new Color(css);
  return {
    rgb: c.to('srgb').coords.map((v) => (Number.isNaN(v) ? 0 : Math.min(1, Math.max(0, v)))),
    alpha: c.alpha ?? 1,
  };
}
const srgb = (css) => parse(css).rgb;
const hex = (rgb) => new Color('srgb', rgb).toString({ format: 'hex' });

/** 瀏覽器在 sRGB（gamma 編碼）上疊 alpha。 */
const over = (fgRgb, alpha, bgRgb) => fgRgb.map((f, i) => f * alpha + bgRgb[i] * (1 - alpha));
const composite = (css, underRgb) => {
  const { rgb, alpha } = parse(css);
  return over(rgb, alpha, underRgb);
};

const wcag = (a, b) => new Color('srgb', a).contrast(new Color('srgb', b), 'WCAG21');

/** 字（可能半透明）疊在每一個底上的對比，取最差的。 */
const worst = (css, unders) => Math.min(...unders.map((u) => wcag(composite(css, u), u)));

const inSrgb = (css) => new Color(css).inGamut('srgb');

function oklch(rgb, alpha = 1) {
  const [l, c, h] = new Color('srgb', rgb).to('oklch').coords;
  const L = Number(l.toFixed(4));
  const C = c < 0.0005 ? 0 : Number(c.toFixed(4));
  const H = C === 0 || Number.isNaN(h) ? 0 : Number(h.toFixed(2));
  return alpha === 1
    ? `oklch(${L} ${C} ${H})`
    : `oklch(${L} ${C} ${H} / ${Number(alpha.toFixed(3))})`;
}

/** `oklch(L C H[ / A])` 拆開；A 原樣保留（`60%`）。 */
function lch(css) {
  const m = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+%?))?\s*\)$/.exec(css);
  if (m === null) throw new Error(`不是 oklch(L C H[ / A])：${css}`);
  return { L: Number(m[1]), C: Number(m[2]), H: m[3], alpha: m[4] };
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

/** (L, H) 上 sRGB 內、不超過 `max` 的最大彩度（往下取到 0.001）。 */
function fitChroma(L, max, H) {
  if (inSrgb(`oklch(${L} ${max} ${H})`)) return max;
  let lo = 0;
  let hi = max;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (inSrgb(`oklch(${L} ${mid} ${H})`)) lo = mid;
    else hi = mid;
  }
  return Math.floor(lo * 1000) / 1000;
}

/** B 案：從明度 `start` 起每次推 `step`（0.001，彩度每一步重新夾進 sRGB），回傳第一個讓 `pass` 成立的值。 */
function solveB({ C, H }, start, step, pass) {
  for (
    let L = Math.round(start * 1000) / 1000;
    L >= 0 && L <= 1;
    L = Number((L + step).toFixed(3))
  ) {
    const css = `oklch(${L} ${fitChroma(L, C, H)} ${H})`;
    if (pass(css)) return css;
  }
  throw new Error(`解不出來：色相 ${H}、彩度 ${C}`);
}

// ── 底：SG 的頁面底色與漸層停點 ──

const BASE = {};
for (const theme of THEMES) {
  const s = SG[theme];
  const bg = srgb(s.background);
  const pages = [bg, ...['light-1', 'light-2', 'light-3'].map((stop) => composite(s[stop], bg))];
  BASE[theme] = { bg, pages };
}
/** 半透明的面疊在每一疊頁面底上。 */
const facesOn = (theme, face) => BASE[theme].pages.map((page) => composite(face, page));

// ── nexus 獨有的目標：原型修過、demian 認可的那一版（eb800a1 的 tokens.css）量出來的，亮暗取較強的那個 ──

const PROTO = {
  light: {
    bg: srgb('#f7f7f7'),
    card: srgb('#ffffff'),
    stage: srgb('#f9f9f9'),
    chip: srgb('#ececec'),
    hairline: [srgb('#000000'), 0.14],
  },
  dark: {
    bg: srgb('#121212'),
    card: srgb('#181818'),
    stage: srgb('#131313'),
    chip: over(srgb('#ffffff'), 0.07, srgb('#181818')),
    hairline: [srgb('#c4c4c4'), 0.08],
  },
};
const measured = {};
for (const theme of THEMES) {
  const p = PROTO[theme];
  measured[theme] = {
    'stage 對 卡片': wcag(p.stage, p.card),
    'chip 對 底色': wcag(p.chip, p.bg),
    '細線環 對 卡片': wcag(over(p.hairline[0], p.hairline[1], p.card), p.card),
  };
}
const round2 = (x) => Math.round(x * 100) / 100;
const both = (key) => round2(Math.max(measured.light[key], measured.dark[key]));
// chip 的 hover／pressed：照 Libraries.dev 亮色的階梯比例（#f4f4f4 → #f1f1f1 → #eae9e9 對白卡）往上加
const LIB_STEP = {
  hover: wcag(srgb('#f1f1f1'), [1, 1, 1]) / wcag(srgb('#f4f4f4'), [1, 1, 1]),
  pressed: wcag(srgb('#eae9e9'), [1, 1, 1]) / wcag(srgb('#f4f4f4'), [1, 1, 1]),
};
const T = {
  stage: both('stage 對 卡片'),
  chip: both('chip 對 底色'),
  hairline: both('細線環 對 卡片'),
  text: 4.5,
  status: 5.2,
  surfaceDiff: 0.05,
};
/**
 * chip 三階（chip／hover／pressed）上有次要文字（選單項、標籤、用量鈕），三階都要 ≥ 4.5（Q5 的文字下限是硬約束，
 * 原型的目標只是過渡期的偏好）。
 * chip 與 hover：hover 照 Libraries.dev 的階梯比例跟著 chip 走；目標被下面兩條約束壓住，取最嚴的那條（PM，#1512）。
 * 每條約束各換算成 chip 目標的上限，取最小的；再用四捨五入後的實際字串逐條驗一次，不過就往下推 0.0001。
 * pressed 是例外，見下面的 `PRESSED_STEP`。
 */
const chipAway = (theme) => (theme === 'light' ? 'darker' : 'lighter'); // chip：亮色比底色暗、暗色比底色亮
const CHIP_RULES = THEMES.flatMap((theme) => [
  { theme, step: 'chip', factor: 1, min: T.text, why: '次要文字對 chip ≥ 4.5' },
  {
    theme,
    step: 'chip-hover',
    factor: LIB_STEP.hover,
    min: T.text,
    why: '次要文字對 chip-hover ≥ 4.5',
  },
]);
/** 這條約束換算成 chip 目標的上限：次要文字對它剛好等於門檻的那個灰，對底色的對比，除以階梯比例。 */
function chipCap(rule) {
  const bg = srgb(SG[rule.theme].background);
  const muted = srgb(SG[rule.theme]['muted-foreground']);
  const gray = solveGray(muted, rule.min, rule.theme === 'light' ? 'lighter' : 'darker');
  return wcag(gray, bg) / rule.factor;
}
function chipSteps(theme, target, pressedStep = LIB_STEP.pressed) {
  const bg = srgb(SG[theme].background);
  return {
    chip: oklch(solveGray(bg, target, chipAway(theme))),
    'chip-hover': oklch(solveGray(bg, target * LIB_STEP.hover, chipAway(theme))),
    'chip-pressed': oklch(solveGray(bg, target * pressedStep, chipAway(theme))),
  };
}
const chipOk = (target) =>
  CHIP_RULES.every(
    (rule) =>
      wcag(
        srgb(SG[rule.theme]['muted-foreground']),
        srgb(chipSteps(rule.theme, target)[rule.step]),
      ) >= rule.min,
  );
/**
 * chip 目標的上限釘在 ② 出貨的值（PM 裁決，#1515 PR #1721 issuecomment-6255648703）：chip 與 hover 逐值留在
 * develop，全站的「面對面」不動。出處：② 出貨值，#1512 PR-B（2ad91a61，#1521）。
 * 這個值當時是被「次要字對 chip-pressed ≥ develop 舊值」那條壓出來的；那條拿掉之後不釘的話，chip 目標會改由
 * hover 那條綁住，pressed 的比例就沒有空間，按下去跟 hover 一樣。
 * 撤除條件：⑥ 把 chip 三階換成 SG 的面時。守它的斷言在 `src/styles/tokens-contrast.test.ts`（chip 與 hover 逐字等於 ② 出貨值）。
 */
const SHIPPED_CHIP = 1.1459;
const caps = CHIP_RULES.map((rule) => ({ ...rule, cap: chipCap(rule) }));
const binding = caps.reduce((a, b) => (b.cap < a.cap ? b : a));
T.chipFromProto = T.chip;
T.chip = Math.min(T.chip, Math.floor(binding.cap * 10000) / 10000, SHIPPED_CHIP);
while (!chipOk(T.chip)) T.chip = Number((T.chip - 0.0001).toFixed(4));
T.chipBinding =
  T.chip < T.chipFromProto
    ? T.chip === SHIPPED_CHIP
      ? '釘在 ② 出貨的值（PM 裁決，PR #1721）'
      : `${binding.theme === 'light' ? '亮' : '暗'}色${binding.why}`
    : '原型目標';
/**
 * pressed 的比例例外（PM 裁決，#1515 PR #1721 issuecomment-6255622861、6255648703）：取 min（次要字對它剛好 ≥ 4.5 的比例，
 * Libraries.dev 的比例），不跟著 Libraries.dev 的比例走，也不回頭壓 chip 目標——chip 與 hover 因此逐值留在原型目標，
 * 有字疊在 pressed 上的（用量鈕）照樣 ≥ 4.5。#1512 的階梯比例是過渡期的偏好，不是無障礙門檻。
 * 撤除條件：⑥ 把 chip 三階換成 SG 的面時，這個例外跟著拿掉。
 */
const pressedOk = (step) =>
  THEMES.every(
    (theme) =>
      wcag(
        srgb(SG[theme]['muted-foreground']),
        srgb(chipSteps(theme, T.chip, step)['chip-pressed']),
      ) >= T.text,
  );
const pressedCap = Math.min(
  ...THEMES.map((theme) => chipCap({ theme, min: T.text, factor: T.chip })),
);
const PRESSED_STEP = Math.min(LIB_STEP.pressed, Math.floor(pressedCap * 10000) / 10000);
T.pressedStep = PRESSED_STEP;
while (!pressedOk(T.pressedStep)) T.pressedStep = Number((T.pressedStep - 0.0001).toFixed(4));

/** warning／info 的色相與彩度：沿用上一版產生器（Leonardo 對舊底色解出來的）的值，明度對 SG 底色重解。 */
const NEXUS_HUE = {
  light: {
    warning: { C: 0.1458, H: '47.41' },
    info: { C: 0.2414, H: '263.16' },
  },
  dark: {
    warning: { C: 0.1635, H: '52.25' },
    info: { C: 0.1995, H: '258.86' },
  },
};

/** 不是對比目標、照舊保留的值（留到第 ⑥ 步）。 */
const KEEP = {
  light: { 'primary-hover': 'oklch(0.285 0 0)', 'primary-active': 'oklch(0 0 0)' },
  dark: { 'primary-hover': 'oklch(0.931 0 0)', 'primary-active': 'oklch(0.8822 0 0)' },
};

// ── 1. SG 表面：亮暗鑑別度（只疊在 --background 上量，只調亮色） ──

const surfaceOnBg = (theme, css) => wcag(composite(css, BASE[theme].bg), BASE[theme].bg);

/** 亮色的面要跟暗色一樣分得出來：達標就原樣；不然明度以 0.001 往兩邊交替找，停在第一個達標的值。 */
function solveLightSurface(name, lightCss, darkCss) {
  const dark = surfaceOnBg('dark', darkCss);
  const ok = (css) => Math.abs(surfaceOnBg('light', css) - dark) <= T.surfaceDiff;
  if (ok(lightCss)) return lightCss;
  const { L, C, H, alpha } = lch(lightCss);
  const at = (x) => `oklch(${x} ${C} ${H}${alpha ? ` / ${alpha}` : ''})`;
  for (let k = 1; k <= 300; k++) {
    for (const dir of [1, -1]) {
      const x = Number((L + dir * k * 0.001).toFixed(3));
      if (x >= 0 && x <= 1 && ok(at(x))) return at(x);
    }
  }
  throw new Error(`--${name} 的亮暗差解不出來`);
}

const SURFACE = { light: {}, dark: {} };
for (const name of ['card', 'border', 'sidebar']) {
  SURFACE.light[name] = solveLightSurface(name, SG.light[name], SG.dark[name]);
  SURFACE.dark[name] = SG.dark[name];
}

// ── 1b. 不透明的退路（reduced-transparency、data-glass="opaque"）：SG 給的不透明面也要過亮暗鑑別度 ──
// 會開不透明的正是需要無障礙的使用者，這條退路不做成例外（PM，#1512）：同一條規則、只調亮色。

const OPAQUE = {
  light: { ...SG_REDUCED_TRANSPARENCY.light },
  dark: { ...SG_REDUCED_TRANSPARENCY.dark },
};
for (const name of ['card', 'sidebar'])
  OPAQUE.light[name] = solveLightSurface(
    `${name}（不透明）`,
    SG_REDUCED_TRANSPARENCY.light[name],
    SG_REDUCED_TRANSPARENCY.dark[name],
  );

// ── 2. nexus 獨有的表面：對 SG 的底色（stage、細線對「卡片疊在底色上」）重解 ──

const NEXUS_SURFACE = { light: {}, dark: {} };
for (const theme of THEMES) {
  const bg = BASE[theme].bg;
  const cardOnBg = composite(SURFACE[theme].card, bg);
  const hairBase = theme === 'light' ? [0, 0, 0] : srgb('#c4c4c4');
  NEXUS_SURFACE[theme] = {
    stage: oklch(solveGray(cardOnBg, T.stage, 'darker')),
    ...chipSteps(theme, T.chip, T.pressedStep),
    'card-hairline': oklch(hairBase, solveAlpha(hairBase, cardOnBg, T.hairline)),
  };
}

// ── 3. 顏色：SG 不達標的照 B 案解；nexus 獨有的照原目標重解 ──

/** 每個顏色的約束：對頁面（每一疊）、對卡片（每一疊）、對 stage。沒寫的那一面不約束。 */
const RULES = {
  brand: { page: T.text, card: T.text, stage: T.text },
  // `tints`：自己的淡色底上的字，淡色底疊在每一疊頁面與卡片上（#1523）：平常那一格與按鈕 hover 那一格，見 `destructive-tint.mjs`。
  destructive: {
    page: T.status,
    card: T.text,
    stage: T.text,
    tints: [DESTRUCTIVE_REST, DESTRUCTIVE_HOVER],
  },
  success: { page: T.status, card: T.text, stage: T.text },
  // SG 自己的狀態色也套 5.2（demian，#1512，2026-10-17）。
  'status-done': { page: T.status, card: T.text },
  'status-interrupted': { page: T.status, card: T.text },
  'status-running': { page: T.status, card: T.text },
  link: { page: T.text, card: T.text },
  // `chips`：疊在 chip 三階上。chip 是不透明的灰，不用疊頁面。
  warning: { page: T.status, card: T.text, stage: T.text, chips: T.text },
  info: { page: T.status, card: T.text, stage: T.text },
};
const SG_COLORS = [
  'brand',
  'destructive',
  'success',
  'status-done',
  'status-interrupted',
  'status-running',
  'link',
];

/** 顏色自己的淡色底（`bg-<色>/<alpha>`）疊在每一疊頁面、每一疊卡片上。 */
function tintFaces(theme, css, alpha) {
  const { L, C, H } = lch(css);
  const tint = `oklch(${L} ${C} ${H} / ${alpha})`;
  const under = [...BASE[theme].pages, ...facesOn(theme, SURFACE[theme].card)];
  return under.map((face) => composite(tint, face));
}

/** chip 三階的底（不透明）。 */
const chipFaces = (theme) =>
  ['chip', 'chip-hover', 'chip-pressed'].map((step) => srgb(NEXUS_SURFACE[theme][step]));

function passes(theme, name, css) {
  const rule = RULES[name];
  const stage = srgb(NEXUS_SURFACE[theme].stage);
  return (
    (rule.tints ?? []).every((tint) => worst(css, tintFaces(theme, css, tint[theme])) >= T.text) &&
    (rule.page === undefined || worst(css, BASE[theme].pages) >= rule.page) &&
    (rule.card === undefined || worst(css, facesOn(theme, SURFACE[theme].card)) >= rule.card) &&
    (rule.stage === undefined || worst(css, [stage]) >= rule.stage) &&
    (rule.chips === undefined || worst(css, chipFaces(theme)) >= rule.chips)
  );
}

/** 往對比變大的方向：亮色往暗、暗色往亮。 */
const toward = (theme) => (theme === 'light' ? -0.001 : 0.001);

const COLOR = { light: {}, dark: {} };
for (const theme of THEMES) {
  for (const name of SG_COLORS) {
    const sg = SG[theme][name];
    COLOR[theme][name] = passes(theme, name, sg)
      ? sg
      : solveB(lch(sg), lch(sg).L, toward(theme), (css) => passes(theme, name, css));
  }
  for (const name of ['warning', 'info']) {
    // 原目標重解：從對比最小的那一端（亮色從最亮、暗色從最暗）往回推，停在第一個達標的值，也就是最接近目標的那個。
    COLOR[theme][name] = solveB(
      NEXUS_HUE[theme][name],
      theme === 'light' ? 1 : 0,
      toward(theme),
      (css) => passes(theme, name, css),
    );
  }
}

// ── 組產物：跟 SG 不一樣的才寫，亮暗成對 ──

const solved = (theme, name) => COLOR[theme][name] ?? SURFACE[theme][name];
const overridden = [...SG_COLORS, 'card', 'border', 'sidebar'].filter((name) =>
  THEMES.some((theme) => solved(theme, name) !== SG[theme][name]),
);

const tokens = { light: {}, dark: {} };
for (const theme of THEMES) {
  const t = tokens[theme];
  for (const name of overridden) t[name] = solved(theme, name);
  Object.assign(t, KEEP[theme]);
  t.warning = COLOR[theme].warning;
  t.info = COLOR[theme].info;
  const brand = lch(solved(theme, 'brand'));
  t['brand-soft'] = `oklch(${brand.L} ${brand.C} ${brand.H} / ${theme === 'light' ? 0.09 : 0.12})`; // Libraries.dev --accent-soft
  Object.assign(t, NEXUS_SURFACE[theme]);
  t.ring = SG[theme].foreground;
  t['sidebar-ring'] = SG[theme].foreground;
}

// ── 自檢：解出來的值都在 sRGB 內（SG 原樣搬來的不算，由 `tokens-generated.test.ts` 的具名例外管） ──

for (const theme of THEMES) {
  for (const [name, css] of Object.entries(tokens[theme])) {
    if (css !== SG[theme][name] && !inSrgb(css))
      throw new Error(`${theme} --${name} 超出 sRGB：${css}`);
  }
}

// ── 輸出 CSS ──

const block = (sel, t, indent = '') =>
  `${indent}${sel} {\n${Object.entries(t)
    .map(([k, v]) => `${indent}  --${k}: ${v};`)
    .join('\n')}\n${indent}}\n`;
// 要重寫的：上面無條件覆寫了的（不重寫的話會蓋掉 SG 的不透明值），以及不透明的值跟 SG 不同的（1b 解出來的）。
const reduced = Object.keys(SG_REDUCED_TRANSPARENCY.light).filter(
  (name) =>
    name in tokens.light ||
    THEMES.some((theme) => OPAQUE[theme][name] !== SG_REDUCED_TRANSPARENCY[theme][name]),
);
const pick = (theme) => Object.fromEntries(reduced.map((n) => [n, OPAQUE[theme][n]]));
const reducedBlock =
  reduced.length === 0
    ? ''
    : `\n/* reduced-transparency：上面覆寫了的照樣重寫（不然無條件的值會蓋掉不透明值），亮暗鑑別度不夠的照 1b 解過。 */\n` +
      `${SG_REDUCED_TRANSPARENCY.condition} {\n${block(':root', pick('light'), '  ')}${block('.dark', pick('dark'), '  ')}}\n`;
// `data-glass="opaque"`（#1468 Q7）：SG 在那裡只拿掉 blur（`solid-glass.css` 的 [data-glass="opaque"] 那條），面還是半透明的；
// 照 reduced-transparency 那條路換成同一組不透明值（1b）。暗色要高一階 specificity，不然 `.dark` 的值會蓋回來或吃到亮色。
const opaqueBlock =
  `\n/* data-glass="opaque"：面換成不透明，跟 reduced-transparency 同一組值（#1468 Q7；本地修改，見 vendor/solid-glass/README.md）。 */\n` +
  block("[data-glass='opaque']", OPAQUE.light) +
  block(".dark[data-glass='opaque'],\n.dark [data-glass='opaque']", OPAQUE.dark);
writeFileSync(
  out('../src/styles/tokens.generated.css'),
  `/* 由 tokengen/generate.mjs 產生，不要手改。只放要覆寫 solid-glass 的 token，亮暗成對（#1512）。 */\n\n` +
    block(':root', tokens.light) +
    '\n' +
    block('.dark', tokens.dark) +
    reducedBlock +
    opaqueBlock,
);

// ── 輸出表格 ──

const f = (x) => x.toFixed(2);
const theme2 = (theme) => (theme === 'light' ? '亮' : '暗');
let md = `## 目標\n\n| 目標 | 值 | 出處 |\n| --- | --- | --- |\n`;
md += `| 文字 | ${f(T.text)} | Q5 |\n| 狀態色對頁面 | ${f(T.status)} | Q5；SG 的 status-* 也套（#1512） |\n| 表面亮暗差 | ≤ ${T.surfaceDiff} | Q5 |\n`;
md += `| stage 對 卡片 | ${f(T.stage)} | 原型 eb800a1，亮暗取強 |\n| chip 對 底色 | ${T.chip.toFixed(4)} | 原型 ${f(T.chipFromProto)}；綁住的約束：${T.chipBinding}（#1512） |\n`;
md += `| chip-hover 對 底色 | ${(T.chip * LIB_STEP.hover).toFixed(4)} | Libraries.dev 的階梯比例 |\n`;
md += `| chip-pressed 對 底色 | ${(T.chip * T.pressedStep).toFixed(4)} | 比例 ${T.pressedStep.toFixed(4)}：取 min（次要字剛好 ≥ 4.5，Libraries.dev 的 ${LIB_STEP.pressed.toFixed(4)}），例外見產生器 |\n| 細線環 對 卡片 | ${f(T.hairline)} | 原型 eb800a1，亮暗取強 |\n`;
md += `\nchip 三階上的次要文字（約束見產生器）：\n\n| 約束 | 上限換算成 chip 目標 | 產物上的實際值 |\n| --- | --- | --- |\n`;
for (const c of caps)
  md += `| ${c.theme === 'light' ? '亮' : '暗'}：${c.why} | ${c.cap.toFixed(4)} | ${wcag(srgb(SG[c.theme]['muted-foreground']), srgb(chipSteps(c.theme, T.chip)[c.step])).toFixed(4)} |\n`;
for (const theme of THEMES)
  md += `| ${theme2(theme)}：次要文字對 chip-pressed ≥ 4.5（壓 pressed 比例，不壓 chip） | — | ${wcag(srgb(SG[theme]['muted-foreground']), srgb(NEXUS_SURFACE[theme]['chip-pressed'])).toFixed(4)} |\n`;
md += `\n顏色的對比疊在最差的那一疊底上算：SG 底色＋每個漸層停點；卡片是半透明的面再疊上去。表面鑑別度只疊在底色上。\n`;
md += `\n## 顏色（取最差的一疊）\n\n| token | 主題 | SG | 產物 | 對頁面 | 對卡片 | 對 stage |\n| --- | --- | --- | --- | --- | --- | --- |\n`;
for (const name of Object.keys(RULES)) {
  for (const theme of THEMES) {
    const css = COLOR[theme][name];
    const stage = srgb(NEXUS_SURFACE[theme].stage);
    md += `| \`--${name}\` | ${theme2(theme)} | ${name in SG[theme] ? `\`${SG[theme][name]}\`` : '—'} | \`${css}\` | ${f(worst(css, BASE[theme].pages))} | ${f(worst(css, facesOn(theme, SURFACE[theme].card)))} | ${f(worst(css, [stage]))} |\n`;
  }
}
md += `\n## 表面鑑別度（只疊在底色上）\n\n| token | 亮 | 暗 | 亮對底色 | 暗對底色 | 差 |\n| --- | --- | --- | --- | --- | --- |\n`;
const surfaceRow = (name, l, d) => {
  const a = surfaceOnBg('light', l);
  const b = surfaceOnBg('dark', d);
  return `| \`--${name}\` | \`${l}\` | \`${d}\` | ${a.toFixed(4)} | ${b.toFixed(4)} | ${Math.abs(a - b).toFixed(4)} |\n`;
};
for (const name of ['card', 'border', 'sidebar'])
  md += surfaceRow(name, SURFACE.light[name], SURFACE.dark[name]);
for (const name of ['chip', 'chip-hover', 'chip-pressed'])
  md += surfaceRow(name, NEXUS_SURFACE.light[name], NEXUS_SURFACE.dark[name]);
md += `\n不透明的退路（reduced-transparency、data-glass="opaque"）：\n\n| token | 亮 | 暗 | 亮對底色 | 暗對底色 | 差 |\n| --- | --- | --- | --- | --- | --- |\n`;
for (const name of ['card', 'sidebar'])
  md += surfaceRow(name, OPAQUE.light[name], OPAQUE.dark[name]);
md += `\nSG 底色：亮 ${hex(BASE.light.bg)}、暗 ${hex(BASE.dark.bg)}。\n`;
md += `\n## 產物（oklch）\n\n| token | 亮 | 暗 |\n| --- | --- | --- |\n`;
for (const k of Object.keys(tokens.light))
  md += `| \`--${k}\` | \`${tokens.light[k]}\` | \`${tokens.dark[k]}\` |\n`;
writeFileSync(out('token-table.md'), md);
console.log(md);
