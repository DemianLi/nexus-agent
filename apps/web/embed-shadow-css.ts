import type { Plugin } from 'vite';

/**
 * 嵌入版 `<nexus-chat>`（#2366）的樣式放進 Shadow DOM 之前要改寫的幾處，在 embed 的建置時做（`vite.embed.config.ts`），
 * 執行期不碰 CSS 字串。
 *
 * - `@font-face` 與 `@property` 拿出來放 document 層：shadow root 裡的這兩種規則 Chrome 不認（字型載不到、`--tw-*` 沒有
 *   初始值，陰影與 ring 整個不見）。
 * - `:root`、`html`、`body` 換成元素裡最外層那個 wrapper（{@link SHADOW_ROOT_CLASS}）：shadow root 裡沒有這三個元素，token 與
 *   底色字色要落在 wrapper 上。`:root:root` 照樣是兩次，specificity 不變。
 * - 只看寬度的 `@media` 換成 `@container`：元素填滿父容器，斷點跟著元素自己的寬度走，不跟視窗。`prefers-*`、`hover` 這類不換。
 */

/** shadow root 裡最外層那個元素的 class，同時是 container query 的容器。 */
export const SHADOW_ROOT_CLASS = 'nexus-root';

/** container query 的容器名。 */
export const SHADOW_CONTAINER_NAME = 'nexus';

/** 改寫後的樣式：`shadow` 放進 shadow root，`document` 放進宿主頁的 `<head>`。 */
export interface ShadowCss {
  readonly shadow: string;
  readonly document: string;
}

// 這兩種規則的區塊裡沒有巢狀大括號，一個正規式就切得乾淨。
const DOCUMENT_RULE = /@(?:font-face|property)\b[^{}]*\{[^{}]*\}/gu;
const ROOT = /:root(?![\w-])/gu;
// 選擇器開頭（或組合子之後）的 `html`、`body` 型別選擇器；`.markdown tbody` 這種前面是字母，不會中。
const ROOT_ELEMENT = /(^|[{};,>+~(\s])(?:html|body)(?=[\s,{.:[>+~)])/gu;
const MEDIA = /@media\s*([^{;]+)\{/gu;
// 一個 `(…width…)` 條件，`and` 串起來的也算；寬度以外的條件只要出現一個就整條不換。
const WIDTH_FEATURE = String.raw`\(\s*(?:(?:min|max)-)?width\s*[:<>=][^()]*\)`;
const WIDTH_ONLY = new RegExp(String.raw`^${WIDTH_FEATURE}(?:\s+and\s+${WIDTH_FEATURE})*$`, 'u');

/** 把一份 CSS 改寫成 shadow root 用的與 document 層用的兩份。 */
export function toShadowCss(css: string): ShadowCss {
  const hoisted: string[] = [];
  const rest = css.replace(DOCUMENT_RULE, (rule) => {
    hoisted.push(rule);
    return '';
  });
  const shadow = rest
    .replace(ROOT, `.${SHADOW_ROOT_CLASS}`)
    .replace(ROOT_ELEMENT, (_match, before: string) => `${before}.${SHADOW_ROOT_CLASS}`)
    .replace(MEDIA, (match, condition: string) =>
      WIDTH_ONLY.test(condition.trim())
        ? `@container ${SHADOW_CONTAINER_NAME} ${condition.trim()}{`
        : match,
    );
  return { shadow, document: hoisted.join('\n') };
}

/** `?inline` 的 CSS 模組長這樣：Vite 的 css 外掛把整份 CSS 編成一個字串字面量。 */
const INLINE_MODULE = /^export default (".*");?\s*$/su;

/**
 * embed 建置用的外掛：
 *
 * - 每個 `?inline` 的 CSS 模組改寫成 {@link ShadowCss}，預設匯出 `shadow`、另外匯出 `documentCss`；
 * - 元件裡直接 `import` 的 CSS（`markdown-text.tsx` 的 KaTeX）換成空模組：那種 import 只會產出一個沒人載入的 `.css` 檔，
 *   embed 的入口另外用 `?inline` 收它；
 * - 產物裡出現任何 `.css` 檔就讓建置失敗：那表示有一份樣式沒進到 shadow root。
 */
export function embedShadowCss(): Plugin[] {
  const EMPTY = '\0nexus-embed-empty-css';
  // 換成空模組要搶在 Vite 自己的解析之前；改寫 `?inline` 要等 Vite 的 css 外掛把它編成字串之後。
  return [
    {
      name: 'nexus-embed-drop-direct-css',
      enforce: 'pre',
      resolveId(source) {
        return /\.css$/u.test(source) && source.startsWith('katex/') ? EMPTY : undefined;
      },
      load(id) {
        return id === EMPTY ? 'export {};' : undefined;
      },
    },
    {
      name: 'nexus-embed-shadow-css',
      enforce: 'post',
      transform(code, id) {
        if (!/\.css\?inline$/u.test(id)) return undefined;
        const literal = INLINE_MODULE.exec(code)?.[1];
        if (literal === undefined) throw new Error(`認不得 ${id} 的 ?inline 模組形狀`);
        const { shadow, document } = toShadowCss(JSON.parse(literal) as string);
        return {
          code: `export default ${JSON.stringify(shadow)};\nexport const documentCss = ${JSON.stringify(document)};\n`,
          map: null,
        };
      },
      generateBundle(_options, bundle) {
        const css = Object.keys(bundle).filter((name) => name.endsWith('.css'));
        if (css.length > 0) {
          this.error(`embed 的產物不該有 .css 檔（樣式要進 shadow root）：${css.join('、')}`);
        }
      },
    },
  ];
}
