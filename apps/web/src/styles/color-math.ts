import Color from 'colorjs.io';

/**
 * 量顏色的共用算法：靜態那一層（token，`tokens-contrast`、`shadow-alpha`）與瀏覽器那一層（`guard/`，量 build 產物上元素的計算值）
 * 用同一份，兩層算出來的對比與透明度才比得起來（#1512）。只給測試用，不進出貨的程式。
 */

export type Rgb = [number, number, number];

export interface Rgba {
  rgb: Rgb;
  alpha: number;
}

/** 任何 CSS 顏色（`oklch(… / 28%)`、`rgba(…)`、`color(srgb …)`、`transparent`）轉成 sRGB 與透明度；超出色域的夾回 0–1。 */
export function parseColor(value: string): Rgba {
  const color = new Color(value);
  const rgb = color.to('srgb').coords.map((v) => Math.min(1, Math.max(0, v ?? 0))) as Rgb;
  return { rgb, alpha: color.alpha ?? 1 };
}

/** 瀏覽器在 sRGB（gamma 編碼）上疊 alpha：把 `top` 疊在不透明的 `under` 上。 */
export function composite(top: Rgba, under: Rgb): Rgb {
  return top.rgb.map((c, i) => c * top.alpha + (under[i] ?? 0) * (1 - top.alpha)) as Rgb;
}

/** WCAG 2.1 對比度，兩邊都要是不透明的。 */
export function contrastRatio(a: Rgb, b: Rgb): number {
  return new Color('srgb', a).contrast(new Color('srgb', b), 'WCAG21');
}

export interface SurfaceContrast {
  ratio: number;
  /** 最差的那一疊底（由下往上，`background+light-1`）；面本身不透明、也不是底的最底層時不用疊，是 undefined。 */
  on: string | undefined;
}

/**
 * 文字（或非文字）`fg` 疊在面 `bg` 上的對比，`lookup` 給 token 的值（已代換 `var()`）。
 *
 * 面是半透明的（玻璃），實際看到的顏色看它疊在什麼上面：`bases` 每一項是一疊底、由下往上（`['background']`、
 * `['background', 'light-1']`：頁面漸層的停點本身也是半透明，疊在底色上），各算一次，**取最差的那一個**。
 * 每一疊最底下那層要不透明，不然沒有答案，直接拋錯，不猜。
 *
 * `bg` 本身就是某疊底的最底層時（`brand` 對 `background`：字直接寫在頁面上），看到的是那一疊合成的結果，不是平的底色——
 * 以 `bg` 開頭的每一疊各算一次。只看平的底色會偏寬（#1512：SG 的亮色 brand 平底 2.17、最差的停點 2.05）。
 */
export function surfaceContrast(
  lookup: (name: string) => string | undefined,
  fg: string,
  bg: string,
  bases: readonly (readonly string[])[],
): SurfaceContrast {
  const color = (name: string): Rgba => {
    const value = lookup(name);
    if (value === undefined) throw new Error(`沒有 --${name}`);
    return parseColor(value);
  };
  const face = color(bg);
  const text = color(fg);
  // 面本身就是那疊底的最底層（字直接寫在頁面上）：看到的是底色疊上漸層停點，每一疊各算一次。
  const own = bases.filter((stack) => stack[0] === bg);
  const unders: { on: string | undefined; rgb: Rgb }[] =
    own.length > 0
      ? own.map((stack) => ({ on: stack.join('+'), rgb: flatten(stack, color) }))
      : face.alpha === 1
        ? [{ on: undefined, rgb: face.rgb }]
        : bases.map((stack) => ({
            on: stack.join('+'),
            rgb: composite(face, flatten(stack, color)),
          }));
  if (unders.length === 0) throw new Error(`--${bg} 是半透明的，要指定疊在什麼上面`);
  return unders
    .map(({ on, rgb }) => ({ on, ratio: contrastRatio(composite(text, rgb), rgb) }))
    .reduce((worst, next) => (next.ratio < worst.ratio ? next : worst));
}

/** 一疊顏色由下往上合成；最底下那層要不透明。 */
function flatten(stack: readonly string[], color: (name: string) => Rgba): Rgb {
  const [bottom, ...rest] = stack;
  if (bottom === undefined) throw new Error('空的一疊底');
  const base = color(bottom);
  if (base.alpha !== 1) throw new Error(`--${bottom} 是半透明的，不能當最底下的底`);
  return rest.reduce((under, name) => composite(color(name), under), base.rgb);
}

/** 以最外層的逗號切開，括號裡的不切：`box-shadow` 的各層、漸層的各個停點。 */
export function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = value.slice(start).trim();
  if (last !== '') parts.push(last);
  return parts;
}

const COLOR_FUNCTION = /\b(?:rgba?|hsla?|hwb|oklch|oklab|lch|lab|color)\([^()]*\)/g;

/** 一段值裡寫死的顏色（函式寫法），照出現順序。`var()`、`color-mix()` 不算：它們要先代換或合成才有顏色。 */
export function colorsIn(value: string): string[] {
  return [...value.matchAll(COLOR_FUNCTION)].map((m) => m[0]);
}

export interface ShadowLayer {
  text: string;
  inset: boolean;
  /** offset 與 blur 都是 0、只有 spread：畫的是一圈邊緣（邊緣畫在陰影裡，或 Tailwind 的 ring），不是投影。 */
  edge: boolean;
  /** 這一層寫死的顏色；整層只有 `var()` 時是 undefined。 */
  color: string | undefined;
}

/**
 * `box-shadow` 的值拆成各層。宣告值（`0 1px 2px rgb(0 0 0 / 0.06)`）與瀏覽器的計算值（`rgba(0, 0, 0, 0.06) 0px 1px 2px 0px`）都認得。
 * `none` 回空陣列。
 */
export function shadowLayers(value: string): ShadowLayer[] {
  if (value.trim() === 'none') return [];
  return splitTopLevel(value).map((text) => {
    const color = colorsIn(text)[0];
    const rest = (color === undefined ? text : text.replace(color, ' ')).replace(
      /var\([^()]*\)/g,
      ' ',
    );
    const inset = /\binset\b/.test(rest);
    const lengths = rest
      .replace(/\binset\b/, ' ')
      .trim()
      .split(/\s+/)
      .filter((t) => t !== '')
      .map((t) => Number.parseFloat(t));
    const [x = 0, y = 0, blur = 0, spread = 0] = lengths;
    return { text, inset, edge: x === 0 && y === 0 && blur === 0 && spread !== 0, color };
  });
}

/** 元素自己與每個祖先的底：`getComputedStyle` 的 `background-color` 與 `background-image`，由元素往上排到 `<html>`。 */
export interface BackgroundLayer {
  backgroundColor: string;
  backgroundImage: string;
}

export interface Backdrop {
  /** 這個候選是怎麼疊出來的：用到漸層停點時寫出是哪一層的哪一個停點，例如 `2:stop1`。 */
  label: string;
  rgb: Rgb;
}

/**
 * 元素實際的底色（瀏覽器那一層，#1512）：從元素往上找到第一個不透明的 `background-color`，再把中間半透明的各層由下往上疊回來。
 *
 * - 有漸層（`background-image` 裡寫死的顏色）的那一層，漸層畫在它的底色上面，**每個停點各是一個候選**，不畫漸層的地方也是一個候選；
 *   回傳全部候選，由呼叫端取最差的。
 * - 一路往上都沒有不透明的底就拋錯，不拿畫布的顏色猜。
 */
export function backdrops(chain: readonly BackgroundLayer[]): Backdrop[] {
  const baseIndex = chain.findIndex((layer) => parseColor(layer.backgroundColor).alpha === 1);
  if (baseIndex === -1) throw new Error('一路往上都沒有不透明的底色');
  let candidates: Backdrop[] = [
    { label: 'base', rgb: parseColor(chain[baseIndex]!.backgroundColor).rgb },
  ];
  for (let i = baseIndex; i >= 0; i--) {
    const layer = chain[i]!;
    const color = parseColor(layer.backgroundColor);
    const filled =
      i === baseIndex
        ? candidates
        : candidates.map((c) => ({ ...c, rgb: composite(color, c.rgb) }));
    const stops = layer.backgroundImage === 'none' ? [] : colorsIn(layer.backgroundImage);
    candidates = [
      ...filled,
      ...stops.flatMap((stop, s) =>
        filled.map((c) => ({
          label: c.label === 'base' ? `${i}:stop${s}` : `${c.label},${i}:stop${s}`,
          rgb: composite(parseColor(stop), c.rgb),
        })),
      ),
    ];
  }
  return candidates;
}
