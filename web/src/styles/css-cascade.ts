import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 讀 CSS 的護欄共用的量具（#1498，#1468 Q2）：從 `index.css` 照 `@import` 的順序展開本地檔，算出每個宣告**實際生效**的值。
 *
 * 護欄原本各讀一個固定檔名（`tokens.generated.css`、`theme.css`、`index.css`），疊在後面的樣式表量不到。
 * solid-glass 的做法是「vendor 原檔＋後載入、layer 外的覆寫檔」（#1468 Q9），本身就是疊樣式表，所以護欄改讀這裡。
 *
 * 勝負照 cascade：**layer 外贏過任何 layer 裡的**，不管誰先誰後；layer 之間照宣告順序，後宣告的贏；同一層才比先後。
 *
 * 量不到的（用的時候要知道）：
 * - **不算 specificity，也不比對元素。** 只在呼叫端給的那幾段選擇器文字之間比勝負，呼叫端要自己保證它們的 specificity 相同、
 *   落在同一個元素上（例如 `<html>` 同時符合 `:root` 與 `.dark`，兩者都是 (0,1,0)）。選擇器文字不同、specificity 更高的規則
 *   （例如 `.focus-visible\:ring-3:focus-visible`）蓋過同一個屬性時，這裡看不到。
 * - `@media`、`@supports`、`@container` 裡的宣告帶著條件記下來，查詢時預設不算；要算的話用 `conditions` 指定。
 * - `@theme` 的宣告記在選擇器 `@theme` 底下、`theme` 這一層（Tailwind 把它們產在 `@layer theme`），只跟別的 `@theme` 比先後。
 * - 刻意略過的 at 規則只有 {@link SKIPPED_STATEMENTS} 與 {@link SKIPPED_BLOCKS} 列的那幾種：裡面不是元素上的宣告。
 *   **`@apply` 也在略過之列，它的效果量不到**：`@apply` 展開成哪些宣告要 Tailwind 才算得出來（`index.css` 與 solid-glass 的
 *   base layer 都有），這裡只當它不存在。
 * - 其餘一律直接拋錯，不靜默算錯：不在清單上的 at 規則（`@variant`、`@scope`、`@starting-style`……）、`!important`、
 *   巢狀 `@layer`、匿名 `@layer`、`@import … layer()`／帶條件的 `@import`。新的寫法要量，先在這裡決定怎麼算。
 */

/** 不帶區塊、刻意略過的 at 規則：不影響元素上的值，或（`@apply`）影響了也量不到，見檔頭。 */
export const SKIPPED_STATEMENTS: readonly string[] = [
  'source',
  'plugin',
  'charset',
  'custom-variant',
  'apply',
];

/** 帶區塊、整塊略過的 at 規則：裡面不是元素上的宣告。 */
export const SKIPPED_BLOCKS: readonly string[] = [
  'keyframes',
  'font-face',
  'utility',
  'property',
  'custom-variant',
];

/** 不展開的套件。展開它們量不到我們寫的值，只會多出 Tailwind 產生的 preflight 與 utility；它們宣告的 layer 順序照實記下。 */
export const PACKAGES: readonly {
  match: (specifier: string) => boolean;
  layers: readonly string[];
  why: string;
}[] = [
  {
    match: (s) => s === 'tailwindcss',
    layers: ['theme', 'base', 'components', 'utilities'],
    why: 'Tailwind 的 preflight 與 utility 由它在建置時產生，不是我們寫的值。它第一行宣告 `@layer theme, base, components, utilities;`，base 與 components 的先後靠這行定，所以照抄進來。',
  },
  {
    match: (s) => s === 'tw-animate-css',
    layers: [],
    why: '只有 `@keyframes`、`@property` 與 `@utility`，沒有元素上的宣告，也不宣告 layer。',
  },
  {
    match: (s) => s.startsWith('@fontsource-variable/'),
    layers: [],
    why: '只有 `@font-face`。',
  },
];

export interface Declaration {
  /** 單一選擇器：選擇器清單拆開、空白收成一格。`@theme` 的宣告是 `@theme`。 */
  readonly selector: string;
  readonly property: string;
  readonly value: string;
  /** `null`＝layer 外。 */
  readonly layer: string | null;
  /** 外層的 `@media …`／`@supports …`／`@container …`，由外而內；空的＝沒有條件。 */
  readonly conditions: readonly string[];
  /** 出處，相對入口檔所在目錄。 */
  readonly file: string;
  /** 在整份展開結果裡的先後。 */
  readonly order: number;
}

export interface Query {
  /** 也算進這些條件底下的宣告（每一層條件都要在清單裡）。預設只算沒有條件的。 */
  readonly conditions?: readonly string[];
}

export interface Cascade {
  /** 展開過的本地檔，依 `@import` 的順序；相對入口檔所在目錄。 */
  readonly files: readonly string[];
  readonly declarations: readonly Declaration[];
  /** layer 的先後，越後面越贏；layer 外不在這裡，比誰都贏。 */
  readonly layerOrder: readonly string[];
  /** 同時符合 `selectors` 的元素上，`property` 勝出的那一條宣告。 */
  winner(selectors: readonly string[], property: string, query?: Query): Declaration | undefined;
  /** 勝出的值，`var()` 不代換。 */
  value(selectors: readonly string[], property: string, query?: Query): string | undefined;
  /** 勝出的值，`var(--x)` 依同一組選擇器代換到底；代換不了又沒有後備值就拋錯。 */
  computed(selectors: readonly string[], property: string, query?: Query): string | undefined;
  /** 每個自訂屬性（`--*`）勝出的值，`var()` 不代換。 */
  customProperties(selectors: readonly string[], query?: Query): Map<string, string>;
}

type Read = (path: string) => string;

const ENTRY = fileURLToPath(new URL('../index.css', import.meta.url));

/** 讀 `index.css` 展開出來的 cascade。`entry`／`read` 給單元測試用。 */
export function readCascade(
  entry: string = ENTRY,
  read: Read = (path) => readFileSync(path, 'utf8'),
): Cascade {
  const root = dirname(entry);
  const files: string[] = [];
  const declarations: Declaration[] = [];
  const layerOrder: string[] = [];
  const declareLayer = (name: string) => {
    if (!layerOrder.includes(name)) layerOrder.push(name);
  };

  const visit = (path: string) => {
    const file = relativeTo(root, path);
    if (files.includes(file)) throw new Error(`${file} 被 @import 了兩次`);
    files.push(file);
    const source = stripComments(read(path));
    walk(source, { layer: null, conditions: [], selectors: null, file, topLevel: true });

    function walk(text: string, at: Context) {
      for (const statement of statements(text)) {
        if (statement.kind === 'declaration') {
          if (at.selectors === null)
            throw new Error(`${file}：規則外面有宣告「${statement.text}」`);
          const colon = statement.text.indexOf(':');
          if (colon < 0) throw new Error(`${file}：讀不懂的宣告「${statement.text}」`);
          const property = statement.text.slice(0, colon).trim();
          const value = statement.text.slice(colon + 1).trim();
          if (/!\s*important\s*$/i.test(value))
            throw new Error(`${file}：不支援 !important（${property}）`);
          for (const selector of at.selectors) {
            declarations.push({
              selector,
              property,
              value,
              layer: at.layer,
              conditions: at.conditions,
              file,
              order: declarations.length,
            });
          }
          continue;
        }
        if (statement.kind === 'at-statement') {
          const [, name = '', prelude = ''] =
            /^@([\w-]+)\s*([\s\S]*)$/.exec(statement.prelude) ?? [];
          if (name === 'import') {
            if (!at.topLevel) throw new Error(`${file}：@import 只能寫在最外層`);
            const specifier = /^(['"])(.+?)\1$/.exec(prelude.trim())?.[2];
            if (specifier === undefined)
              throw new Error(`${file}：不支援這種 @import（${prelude.trim()}），只認單純的字串`);
            if (specifier.startsWith('.') || specifier.startsWith('/')) {
              visit(resolve(dirname(path), specifier));
            } else {
              const known = PACKAGES.find((p) => p.match(specifier));
              if (known === undefined)
                throw new Error(
                  `${file}：不認得的套件 ${specifier}，要展開還是排除，在 PACKAGES 寫明`,
                );
              known.layers.forEach(declareLayer);
            }
          } else if (name === 'layer') {
            for (const layer of prelude.split(',')) declareLayer(qualify(at, layer.trim()));
          } else if (!SKIPPED_STATEMENTS.includes(name)) {
            throw new Error(`${file}：不支援 @${name}，要量的話先在 css-cascade.ts 決定怎麼算`);
          }
          continue;
        }
        if (statement.kind === 'at-block') {
          const [, name = '', prelude = ''] =
            /^@([\w-]+)\s*([\s\S]*)$/.exec(statement.prelude) ?? [];
          if (name === 'layer') {
            const layer = qualify(at, prelude.trim());
            declareLayer(layer);
            walk(statement.body, { ...at, layer, topLevel: false });
          } else if (name === 'media' || name === 'supports' || name === 'container') {
            walk(statement.body, {
              ...at,
              conditions: [...at.conditions, `@${name} ${prelude.trim()}`],
              topLevel: false,
            });
          } else if (name === 'theme') {
            declareLayer('theme');
            walk(statement.body, { ...at, layer: 'theme', selectors: ['@theme'], topLevel: false });
          } else if (!SKIPPED_BLOCKS.includes(name)) {
            throw new Error(
              `${file}：不支援 @${name} { … }，要量的話先在 css-cascade.ts 決定怎麼算`,
            );
          }
          continue;
        }
        const selectors = splitTopLevel(statement.prelude, ',').map((s) =>
          s.replace(/\s+/g, ' ').trim(),
        );
        const nested =
          at.selectors === null
            ? selectors
            : at.selectors.flatMap((parent) =>
                selectors.map((child) =>
                  child.includes('&') ? child.replaceAll('&', parent) : `${parent} ${child}`,
                ),
              );
        walk(statement.body, { ...at, selectors: nested, topLevel: false });
      }
    }
  };

  visit(entry);

  const rank = (layer: string | null) =>
    layer === null ? Number.POSITIVE_INFINITY : layerOrder.indexOf(layer);
  const eligible = (d: Declaration, query: Query | undefined) =>
    d.conditions.every((c) => (query?.conditions ?? []).includes(c));

  const winner = (selectors: readonly string[], property: string, query?: Query) => {
    let best: Declaration | undefined;
    for (const d of declarations) {
      if (d.property !== property || !selectors.includes(d.selector) || !eligible(d, query))
        continue;
      if (
        best === undefined ||
        rank(d.layer) > rank(best.layer) ||
        (rank(d.layer) === rank(best.layer) && d.order > best.order)
      )
        best = d;
    }
    return best;
  };

  const computed = (
    selectors: readonly string[],
    property: string,
    query?: Query,
    seen: readonly string[] = [],
  ): string | undefined => {
    if (seen.includes(property)) throw new Error(`var() 循環：${[...seen, property].join(' → ')}`);
    const raw = winner(selectors, property, query)?.value;
    if (raw === undefined) return undefined;
    return substituteVars(raw, (name, fallback) => {
      const found = computed(selectors, name, query, [...seen, property]);
      if (found !== undefined) return found;
      if (fallback !== undefined) return fallback;
      throw new Error(`${property} 引用的 ${name} 在 ${selectors.join('、')} 上沒有值`);
    });
  };

  return {
    files,
    declarations,
    layerOrder,
    winner,
    value: (selectors, property, query) => winner(selectors, property, query)?.value,
    computed: (selectors, property, query) => computed(selectors, property, query),
    customProperties(selectors, query) {
      const names = new Set(
        declarations
          .filter((d) => d.property.startsWith('--') && selectors.includes(d.selector))
          .map((d) => d.property),
      );
      const out = new Map<string, string>();
      for (const name of names) {
        const value = winner(selectors, name, query)?.value;
        if (value !== undefined) out.set(name, value);
      }
      return out;
    },
  };
}

interface Context {
  readonly layer: string | null;
  readonly conditions: readonly string[];
  readonly selectors: readonly string[] | null;
  readonly file: string;
  readonly topLevel: boolean;
}

function qualify(at: Context, name: string): string {
  if (name === '') throw new Error(`${at.file}：不支援匿名 @layer`);
  if (at.layer !== null)
    throw new Error(`${at.file}：不支援巢狀 @layer（${at.layer} 裡的 ${name}）`);
  return name;
}

function relativeTo(root: string, path: string): string {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

type Statement =
  | { kind: 'declaration'; text: string }
  | { kind: 'at-statement'; prelude: string }
  | { kind: 'at-block'; prelude: string; body: string }
  | { kind: 'rule'; prelude: string; body: string };

/** 一段區塊內容拆成宣告、at 規則與樣式規則。字串與括號裡的 `;`、`{`、`}` 不算。 */
function statements(text: string): Statement[] {
  const out: Statement[] = [];
  let start = 0;
  let i = 0;
  let parens = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") {
      i = skipString(text, i);
      continue;
    }
    if (c === '(') parens++;
    else if (c === ')') parens--;
    else if (parens === 0 && c === ';') {
      const piece = text.slice(start, i).trim();
      if (piece !== '')
        out.push(
          piece.startsWith('@')
            ? { kind: 'at-statement', prelude: piece }
            : { kind: 'declaration', text: piece },
        );
      start = i + 1;
    } else if (parens === 0 && c === '{') {
      const prelude = text.slice(start, i).trim();
      const end = matchingBrace(text, i);
      const body = text.slice(i + 1, end);
      out.push(
        prelude.startsWith('@')
          ? { kind: 'at-block', prelude, body }
          : { kind: 'rule', prelude, body },
      );
      i = end + 1;
      start = i;
      continue;
    } else if (parens === 0 && c === '}') {
      throw new Error(`多出來的 }：${text.slice(Math.max(0, i - 40), i + 1)}`);
    }
    i++;
  }
  const rest = text.slice(start).trim();
  if (rest !== '')
    out.push(
      rest.startsWith('@')
        ? { kind: 'at-statement', prelude: rest }
        : { kind: 'declaration', text: rest },
    );
  return out;
}

function matchingBrace(text: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") {
      i = skipString(text, i);
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
    i++;
  }
  throw new Error(`{ 沒有對應的 }：${text.slice(open, open + 40)}`);
}

/** 回傳字串結尾引號的下一格。 */
function skipString(text: string, open: number): number {
  const quote = text[open];
  let i = open + 1;
  while (i < text.length && text[i] !== quote) i += text[i] === '\\' ? 2 : 1;
  return i + 1;
}

function stripComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const end = skipString(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw new Error('註解沒有收尾');
      i = end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** 依最外層的 `separator` 切開；括號與字串裡的不算。 */
function splitTopLevel(text: string, separator: string): string[] {
  const out: string[] = [];
  let start = 0;
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") {
      i = skipString(text, i);
      continue;
    }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (depth === 0 && c === separator) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  out.push(text.slice(start));
  return out;
}

/** 把 `var(--x)`、`var(--x, 後備)` 換成 `lookup` 給的值。 */
function substituteVars(
  value: string,
  lookup: (name: string, fallback: string | undefined) => string,
): string {
  let out = '';
  let i = 0;
  while (i < value.length) {
    const at = value.indexOf('var(', i);
    if (at < 0) return out + value.slice(i);
    out += value.slice(i, at);
    let depth = 1;
    let j = at + 4;
    while (j < value.length && depth > 0) {
      if (value[j] === '(') depth++;
      else if (value[j] === ')') depth--;
      j++;
    }
    const inner = value.slice(at + 4, j - 1);
    const [name = '', ...rest] = splitTopLevel(inner, ',');
    const fallback = rest.length > 0 ? rest.join(',').trim() : undefined;
    out += lookup(
      name.trim(),
      fallback === undefined ? undefined : substituteVars(fallback, lookup),
    );
    i = j;
  }
  return out;
}
