/* global console, process, URL */
/**
 * 量**建置出來的 CSS**（`dist/assets/*.css`），不是原始碼：Tailwind 只產出用得到的東西、registry 的 class
 * 少了套件就一筆都不產出也不報錯，原始碼看起來對不代表產物對。`pnpm build` 的最後一步，失敗就讓建置失敗。
 *
 * 對應 `.docs/web-ui-spec.md` §11：
 * - 第 3 條：reduced-motion 下 `--animate-in`／`--animate-out` 換成只有透明度的版本。
 * - 第 4 條：`@keyframes` 名稱都在允許清單上。
 * - 第 5 條：每個 `infinite` 動畫在 reduced-motion 下都有一條蓋得過它的 `animation: none`。
 * 另外兩條同一類的無聲失效：
 * - 宣告裡引用的 `motion-*` keyframes 都真的存在（§10：`@theme` 的 collapsible 引用 `styles/motion.css` 的 keyframes）。
 * - 沒有外部網址（完全內網：字型等資源一律打包）。
 */

import { readdirSync, readFileSync } from 'node:fs';

/**
 * `@keyframes` 允許清單。新增或刪掉 keyframes 時，同一個 PR 改這裡（§12）。
 * 只寫第一段的話第一次跑就紅：第三方的名字也會出現在產物裡。
 */
const KEYFRAMES_ALLOWED = new Set([
  // 我們的（`src/styles/motion.css`）
  'motion-fade-in',
  'motion-fade-out',
  'motion-rise-in',
  'motion-swap-in',
  'motion-swap-out',
  'motion-page-in',
  'motion-orb-spin',
  'motion-orb-breathe',
  'motion-beam-angle',
  'motion-beam-pulse',
  'motion-shimmer',
  'motion-caret',
  // 第三方：tw-animate-css（之後裝 accordion 會多 accordion-*）
  'enter',
  'exit',
  'collapsible-down',
  'collapsible-up',
  // 第三方：Tailwind
  'spin',
  'pulse',
  // 第三方：sonner
  'sonner-fade-in',
  'sonner-fade-out',
  'sonner-spin',
  'swipe-out-left',
  'swipe-out-right',
  'swipe-out-up',
  'swipe-out-down',
]);

const REDUCED_MOTION = /prefers-reduced-motion:\s*reduce/;

// ── 極小的 CSS 解析：只認得 minify 後的產物需要的形狀 ──

/** 從 `start`（指向 `{` 之後）找到對應的 `}`，略過字串。 */
function matchBrace(css, start) {
  let depth = 1;
  for (let i = start; i < css.length; i++) {
    const c = css[i];
    if (c === '"' || c === "'") {
      i = css.indexOf(c, i + 1);
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  throw new Error('大括號不成對');
}

const GROUPING = /^@(media|supports|layer|container|scope|starting-style)\b/;

/**
 * 回傳平的節點列表：`{ kind: 'rule', selector, body, media, order }`、`{ kind: 'keyframes', name }`。
 * `media` 是外層所有條件接起來的字串，用來判斷是不是在 reduced-motion 裡。
 */
function parse(css, media = '', out = { nodes: [], order: 0 }) {
  let i = 0;
  while (i < css.length) {
    const brace = css.indexOf('{', i);
    const semi = css.indexOf(';', i);
    if (brace === -1) break;
    if (semi !== -1 && semi < brace) {
      i = semi + 1; // `@layer a, b;`、`@charset` 這類沒有區塊的
      continue;
    }
    const prelude = css.slice(i, brace).trim();
    const end = matchBrace(css, brace + 1);
    const inner = css.slice(brace + 1, end);
    if (GROUPING.test(prelude)) parse(inner, `${media} ${prelude}`, out);
    else if (/^@(-webkit-)?keyframes\s/.test(prelude))
      out.nodes.push({ kind: 'keyframes', name: prelude.replace(/^@\S+\s+/, '').trim() });
    else if (!prelude.startsWith('@'))
      out.nodes.push({ kind: 'rule', selector: prelude, body: inner, media, order: out.order++ });
    i = end + 1;
  }
  return out.nodes;
}

/** 以頂層逗號切開（略過括號裡的）。 */
function splitTop(text, sep) {
  const parts = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === '"' || c === "'") i = text.indexOf(c, i + 1);
    else if (c === sep && depth === 0) {
      parts.push(text.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(text.slice(from));
  return parts.map((p) => p.trim()).filter(Boolean);
}

function declarations(body) {
  const map = new Map();
  for (const d of splitTop(body, ';')) {
    const colon = d.indexOf(':');
    if (colon > 0) map.set(d.slice(0, colon).trim(), d.slice(colon + 1).trim());
  }
  return map;
}

// ── specificity 與「蓋不蓋得過」 ──

const LEGACY_PSEUDO_ELEMENTS = /^:(before|after|first-line|first-letter)$/;

/** 把一個 compound 切成簡單選擇器：`.a[x='1']:not(:disabled)::before` → 四段。 */
function simples(compound) {
  const out = [];
  let i = 0;
  while (i < compound.length) {
    let j = i + 1;
    if (compound[i] === '[') j = compound.indexOf(']', i) + 1;
    else {
      if (compound[i] === ':' && compound[j] === ':') j++;
      while (j < compound.length && !/[.#[:]/.test(compound[j])) {
        if (compound[j] === '(') {
          let depth = 1;
          j++;
          while (depth > 0) {
            if (compound[j] === '(') depth++;
            if (compound[j] === ')') depth--;
            j++;
          }
          break;
        }
        j++;
      }
    }
    out.push(normalize(compound.slice(i, j)));
    i = j;
  }
  return out;
}

/** 產物會把 `::before` 寫成 `:before`、把屬性值的引號拿掉；比對前統一。 */
function normalize(simple) {
  if (LEGACY_PSEUDO_ELEMENTS.test(simple)) return `:${simple}`;
  if (simple.startsWith('[')) return simple.replace(/["']/g, '');
  return simple;
}

/** 以後代／子代組合子切開成 compound 列表（只處理本專案會出現的空白與 `>`）。 */
function compounds(selector) {
  return splitTop(selector.replace(/\s*>\s*/g, ' '), ' ');
}

function specificity(selector) {
  const s = [0, 0, 0];
  for (const compound of compounds(selector))
    for (const simple of simples(compound)) {
      if (simple.startsWith('#')) s[0]++;
      else if (simple.startsWith('::')) s[2]++;
      else if (/^:(where)\(/.test(simple)) continue;
      else if (/^:(is|not|has)\(/.test(simple)) {
        const args = splitTop(simple.slice(simple.indexOf('(') + 1, -1), ',');
        const max = args.map(specificity).sort(compare).at(-1) ?? [0, 0, 0];
        s[0] += max[0];
        s[1] += max[1];
        s[2] += max[2];
      } else if (/^[.[:]/.test(simple)) s[1]++;
      else if (simple !== '*') s[2]++;
    }
  return s;
}

function compare(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * `reducer` 這條是否一定作用在 `target` 選到的每個元素上、而且蓋得過它：
 * 最後一個 compound 的簡單選擇器是 target 的子集，前面只能是 `:root`（不加額外的祖先條件），
 * specificity 比較大，或一樣大但在產物裡排在後面。
 */
function overrides(reducer, target) {
  const r = compounds(reducer.selector);
  const t = compounds(target.selector);
  const ancestorsOk = r.slice(0, -1).every((c) => /^(:root)+$/.test(c));
  const subjectOk = simples(r.at(-1)).every((simple) => simples(t.at(-1)).includes(simple));
  const order = compare(specificity(reducer.selector), specificity(target.selector));
  return ancestorsOk && subjectOk && (order > 0 || (order === 0 && reducer.order > target.order));
}

// ── 檢查 ──

const dir = new URL('../dist/assets/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.css'));
if (files.length === 0) {
  console.error('check-built-css：dist/assets 裡沒有 CSS，先跑 vite build');
  process.exit(1);
}

const failures = [];
const all = files.flatMap((f) => parse(readFileSync(new URL(f, dir), 'utf8')));
const keyframes = new Set(all.filter((n) => n.kind === 'keyframes').map((n) => n.name));
const rules = all
  .filter((n) => n.kind === 'rule')
  .flatMap((n) => splitTop(n.selector, ',').map((selector) => ({ ...n, selector })));
const reduced = rules.filter((r) => REDUCED_MOTION.test(r.media));

// 第 3 條
for (const [name, fade, forbidden] of [
  ['--animate-in', 'motion-fade-in', /\benter\b/],
  ['--animate-out', 'motion-fade-out', /\bexit\b/],
]) {
  const values = reduced.map((r) => declarations(r.body).get(name)).filter(Boolean);
  if (values.length === 0) failures.push(`第 3 條：reduced-motion 裡沒有覆寫 ${name}`);
  for (const v of values)
    if (!v.includes(fade) || forbidden.test(v))
      failures.push(`第 3 條：reduced-motion 的 ${name} 不是只有透明度：${v}`);
}

// 第 4 條
for (const name of keyframes)
  if (!KEYFRAMES_ALLOWED.has(name)) failures.push(`第 4 條：@keyframes ${name} 不在允許清單上`);

// 第 5 條：Tailwind 的 `.animate-spin` 寫成 `animation: var(--animate-spin)`，infinite 藏在變數裡，要先展開
const customProperties = new Map();
for (const rule of rules)
  for (const [name, value] of declarations(rule.body))
    if (name.startsWith('--') && !REDUCED_MOTION.test(rule.media))
      customProperties.set(name, value);
function expand(value, depth = 0) {
  if (depth > 10) return value;
  return value.replace(/var\((--[\w-]+)(?:,([^()]*))?\)/g, (_, name, fallback) =>
    expand(customProperties.get(name) ?? fallback ?? '', depth + 1),
  );
}
const stoppers = reduced.filter((r) => declarations(r.body).get('animation') === 'none');
for (const rule of rules) {
  if (REDUCED_MOTION.test(rule.media)) continue;
  const d = declarations(rule.body);
  const infinite = /\binfinite\b/.test(
    expand(d.get('animation') ?? d.get('animation-iteration-count') ?? ''),
  );
  if (infinite && !stoppers.some((s) => overrides(s, rule)))
    failures.push(`第 5 條：${rule.selector} 的 infinite 動畫在 reduced-motion 下沒有被蓋掉`);
}

// 引用到的 motion-* keyframes 要存在
for (const rule of rules)
  for (const [, value] of declarations(rule.body))
    for (const [name] of value.matchAll(/\bmotion-[a-z-]+\b/g))
      if (!keyframes.has(name)) failures.push(`${rule.selector} 引用了不存在的 @keyframes ${name}`);

// 外部網址
for (const f of files)
  for (const [match] of readFileSync(new URL(f, dir), 'utf8').matchAll(
    /(url\(\s*["']?|@import\s+["'])(https?:)?\/\/[^)"']+/g,
  ))
    failures.push(`${f}：外部網址 ${match}`);

if (failures.length > 0) {
  console.error(`check-built-css：${failures.length} 條失敗`);
  for (const f of [...new Set(failures)]) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  `check-built-css：通過（${files.length} 個 CSS、${keyframes.size} 個 keyframes、` +
    `${stoppers.length} 條 reduced-motion 停止規則）`,
);
