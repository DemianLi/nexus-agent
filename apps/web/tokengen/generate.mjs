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
 * 3. **stage**：面是 SG 的 `--hover-faint`（#1689），不產出值。自檢它疊在卡片上的鑑別度不低於原型的 stage；畫在 stage 上的顏色，
 *    對它疊在每一疊頁面、每一疊卡片上的那幾面解。
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

/** `oklch(L C H[ / A])` 拆開；A 原樣保留（`60%`）。 */
function lch(css) {
  const m = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+%?))?\s*\)$/.exec(css);
  if (m === null) throw new Error(`不是 oklch(L C H[ / A])：${css}`);
  return { L: Number(m[1]), C: Number(m[2]), H: m[3], alpha: m[4] };
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
    card: srgb('#ffffff'),
    stage: srgb('#f9f9f9'),
  },
  dark: {
    card: srgb('#181818'),
    stage: srgb('#131313'),
  },
};
const measured = {};
for (const theme of THEMES) {
  const p = PROTO[theme];
  measured[theme] = {
    'stage 對 卡片': wcag(p.stage, p.card),
  };
}
const round2 = (x) => Math.round(x * 100) / 100;
const both = (key) => round2(Math.max(measured.light[key], measured.dark[key]));
const T = {
  stage: both('stage 對 卡片'),
  text: 4.5,
  status: 5.2,
  surfaceDiff: 0.05,
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

// ── 2. stage：SG 的 --hover-faint 疊在頁面與卡片上（#1689） ──

/** stage 的面：hover-faint 疊在每一疊頁面上，也疊在每一疊頁面上的卡片上。 */
const stageFaces = (theme) =>
  [...BASE[theme].pages, ...facesOn(theme, SURFACE[theme].card)].map((under) =>
    composite(SG[theme]['hover-faint'], under),
  );
/** 跟表面鑑別度同一種量法：只疊在底色上的卡片。 */
const stageOnCard = (theme) => {
  const card = composite(SURFACE[theme].card, BASE[theme].bg);
  return wcag(composite(SG[theme]['hover-faint'], card), card);
};
for (const theme of THEMES) {
  if (stageOnCard(theme) < T.stage)
    throw new Error(
      `${theme} --hover-faint 疊在卡片上 ${stageOnCard(theme).toFixed(3)}，不到 ${T.stage}`,
    );
}

// ── 3. 顏色：SG 不達標的照 B 案解 ──

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
  'status-interrupted': { page: T.status, card: T.text, stage: T.text },
  'status-running': { page: T.status, card: T.text },
  link: { page: T.text, card: T.text, stage: T.text },
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

function passes(theme, name, css) {
  const rule = RULES[name];
  return (
    (rule.tints ?? []).every((tint) => worst(css, tintFaces(theme, css, tint[theme])) >= T.text) &&
    (rule.page === undefined || worst(css, BASE[theme].pages) >= rule.page) &&
    (rule.card === undefined || worst(css, facesOn(theme, SURFACE[theme].card)) >= rule.card) &&
    (rule.stage === undefined || worst(css, stageFaces(theme)) >= rule.stage)
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
md += `| stage（\`--hover-faint\`）對 卡片 | ${f(T.stage)} | 原型 eb800a1，亮暗取強 |\n`;
md += `\n顏色的對比疊在最差的那一疊底上算：SG 底色＋每個漸層停點；卡片是半透明的面再疊上去；stage 是 \`--hover-faint\` 再疊在頁面與卡片上。表面鑑別度只疊在底色上。\n`;
md += `\n## 顏色（取最差的一疊）\n\n| token | 主題 | SG | 產物 | 對頁面 | 對卡片 | 對 stage |\n| --- | --- | --- | --- | --- | --- | --- |\n`;
for (const name of Object.keys(RULES)) {
  for (const theme of THEMES) {
    const css = COLOR[theme][name];
    md += `| \`--${name}\` | ${theme2(theme)} | ${name in SG[theme] ? `\`${SG[theme][name]}\`` : '—'} | \`${css}\` | ${f(worst(css, BASE[theme].pages))} | ${f(worst(css, facesOn(theme, SURFACE[theme].card)))} | ${f(worst(css, stageFaces(theme)))} |\n`;
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
md += `\nstage（\`--hover-faint\` 疊在卡片上）：亮 ${stageOnCard('light').toFixed(4)}、暗 ${stageOnCard('dark').toFixed(4)}、差 ${Math.abs(stageOnCard('light') - stageOnCard('dark')).toFixed(4)}。\n`;
md += `\n不透明的退路（reduced-transparency、data-glass="opaque"）：\n\n| token | 亮 | 暗 | 亮對底色 | 暗對底色 | 差 |\n| --- | --- | --- | --- | --- | --- |\n`;
for (const name of ['card', 'sidebar'])
  md += surfaceRow(name, OPAQUE.light[name], OPAQUE.dark[name]);
md += `\nSG 底色：亮 ${hex(BASE.light.bg)}、暗 ${hex(BASE.dark.bg)}。\n`;
md += `\n## 產物（oklch）\n\n| token | 亮 | 暗 |\n| --- | --- | --- |\n`;
for (const k of Object.keys(tokens.light))
  md += `| \`--${k}\` | \`${tokens.light[k]}\` | \`${tokens.dark[k]}\` |\n`;
writeFileSync(out('token-table.md'), md);
console.log(md);
