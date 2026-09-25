/**
 * 全 web 唯一的語法高亮器（規格 §4.2 列 14，#406）。照 dsh `packages/client/ui-primitives/src/markdown/highlight.ts`
 * （本機 clone `ddefc45`，MIT）：同步的 `shiki/core`＋JavaScript regex 引擎（不用 oniguruma WASM）＋明列的文法
 * allowlist＋css-variables 主題。顏色不寫在這裡，全部走 `--shiki-*`（`src/styles/shiki.css`）。
 *
 * - **開機就載**：TypeScript、shell、JSON 三套——markdown fence 與工具卡的參數（js／bash／json）天天用得到。
 * - **用到才載**：其他語言各自 `import()`，第一次要畫時先顯示純文字，文法載完用 {@link subscribeGrammarLoaded}
 *   通知重畫。
 * - 不認得的語言：純文字（仍是等寬），不報錯。
 *
 * - **帶行號的檔案檢視**（讀檔卡，#625）：{@link highlightLines} 整段一起高亮、按行交回，跨行的註解與字串才不會斷。
 *
 * @module
 */

import langJson from '@shikijs/langs/json';
import langBash from '@shikijs/langs/shellscript';
import langTs from '@shikijs/langs/typescript';
import type { CSSProperties } from 'react';
import { createCssVariablesTheme, createHighlighterCoreSync } from 'shiki/core';
import type { GrammarState, HighlighterCore, ThemedToken } from 'shiki/core';
import {
  createJavaScriptRegexEngine,
  defaultJavaScriptRegexConstructor,
} from 'shiki/engine/javascript';

/** 文法模組的 default export（`LanguageRegistration[]`），借開機文法的型別，不直接依賴 `@shikijs/types`。 */
type LangModule = { default: typeof langTs };

/**
 * 開機就載的文法；各自的 `name` 就是 `codeToTokens`／`codeToHtml` 認的 id。js／jsx／ts／tsx 都走 TypeScript
 * 文法：純 TS／JS 精確，JSX 只是近似（跟 dsh 同一個取捨，換開機只載一套 JS 家族的文法）。
 */
const LANGS = [langTs, langBash, langJson];

/** 用到才載的文法，以文法 id 為鍵；各自在 `import()` 後面，不進主 chunk。 */
const LAZY_GRAMMARS = new Map<string, () => Promise<LangModule>>([
  ['python', () => import('@shikijs/langs/python')],
  ['ruby', () => import('@shikijs/langs/ruby')],
  ['go', () => import('@shikijs/langs/go')],
  ['rust', () => import('@shikijs/langs/rust')],
  ['java', () => import('@shikijs/langs/java')],
  ['c', () => import('@shikijs/langs/c')],
  ['cpp', () => import('@shikijs/langs/cpp')],
  ['csharp', () => import('@shikijs/langs/csharp')],
  ['kotlin', () => import('@shikijs/langs/kotlin')],
  ['swift', () => import('@shikijs/langs/swift')],
  ['php', () => import('@shikijs/langs/php')],
  ['yaml', () => import('@shikijs/langs/yaml')],
  ['toml', () => import('@shikijs/langs/toml')],
  ['ini', () => import('@shikijs/langs/ini')],
  ['markdown', () => import('@shikijs/langs/markdown')],
  ['mdx', () => import('@shikijs/langs/mdx')],
  ['html', () => import('@shikijs/langs/html')],
  ['css', () => import('@shikijs/langs/css')],
  ['scss', () => import('@shikijs/langs/scss')],
  ['less', () => import('@shikijs/langs/less')],
  ['sql', () => import('@shikijs/langs/sql')],
  ['xml', () => import('@shikijs/langs/xml')],
  ['lua', () => import('@shikijs/langs/lua')],
]);

/**
 * 認得的語言 id 與別名；其他一律純文字。用 Map 不用物件：fence 的 info string 是模型寫的，`constructor`、
 * `__proto__` 這種字要查不到，不能查到繼承來的屬性、在 shiki 裡炸掉。值不在 {@link LANGS} 裡的，是
 * {@link LAZY_GRAMMARS} 的鍵。
 */
const LANG_ALIASES = new Map<string, string>([
  ['typescript', 'typescript'],
  ['ts', 'typescript'],
  ['tsx', 'typescript'],
  ['javascript', 'typescript'],
  ['js', 'typescript'],
  ['jsx', 'typescript'],
  ['shellscript', 'shellscript'],
  ['bash', 'shellscript'],
  ['sh', 'shellscript'],
  ['shell', 'shellscript'],
  ['zsh', 'shellscript'],
  ['json', 'json'],
  ['jsonc', 'json'],
  ['py', 'python'],
  ['python', 'python'],
  ['rb', 'ruby'],
  ['ruby', 'ruby'],
  ['go', 'go'],
  ['rs', 'rust'],
  ['rust', 'rust'],
  ['java', 'java'],
  ['c', 'c'],
  ['cpp', 'cpp'],
  ['cs', 'csharp'],
  ['csharp', 'csharp'],
  ['kotlin', 'kotlin'],
  ['swift', 'swift'],
  ['php', 'php'],
  ['yaml', 'yaml'],
  ['yml', 'yaml'],
  ['toml', 'toml'],
  ['ini', 'ini'],
  ['md', 'markdown'],
  ['markdown', 'markdown'],
  ['mdx', 'mdx'],
  ['html', 'html'],
  ['css', 'css'],
  ['scss', 'scss'],
  ['less', 'less'],
  ['sql', 'sql'],
  ['xml', 'xml'],
  ['lua', 'lua'],
]);

function resolveLang(lang: string | undefined): string | undefined {
  return lang === undefined ? undefined : LANG_ALIASES.get(lang.toLowerCase());
}

/** 這個語言提示能不能高亮。 */
export function supportsHighlighting(lang: string | undefined): boolean {
  return resolveLang(lang) !== undefined;
}

/** 每個 token 的顏色都走 `--shiki-*`。 */
const cssVariablesTheme = createCssVariablesTheme({
  name: 'css-variables',
  variablePrefix: '--shiki-',
  fontStyle: true,
});

/**
 * JavaScript regex 引擎在建 scanner 時就編譯每條 TextMate pattern。shiki 預設把超過 3,000 字的 pattern 延到第一次
 * 比對才編，那段時間會算進它每行 500 ms 的預算、忙的時候吐出不完整的 token；提早編譯讓預算只花在使用者的內容上。
 */
const regexEngine = createJavaScriptRegexEngine({
  forgiving: true,
  regexConstructor: (pattern) =>
    defaultJavaScriptRegexConstructor(pattern, {
      lazyCompileLength: Number.POSITIVE_INFINITY,
    }),
});

let singleton: HighlighterCore | undefined;

/** 每套開機文法走一遍的樣本，在計時使用者內容之前先編好。 */
const BOOT_GRAMMAR_WARMUPS = [
  { lang: 'typescript', code: 'const answer: number = 42' },
  { lang: 'shellscript', code: 'printf \'%s\\n\' "$HOME"' },
  { lang: 'json', code: '{"ready":true}' },
] as const;

function createHighlighter(): HighlighterCore {
  const instance = createHighlighterCoreSync({
    themes: [cssVariablesTheme],
    langs: LANGS,
    engine: regexEngine,
  });
  for (const sample of BOOT_GRAMMAR_WARMUPS) {
    instance.codeToTokens(sample.code, {
      lang: sample.lang,
      theme: 'css-variables',
      tokenizeTimeLimit: 0,
    });
  }
  return instance;
}

function highlighter(): HighlighterCore {
  singleton ??= createHighlighter();
  return singleton;
}

/** 已經發出 import 的文法，每套只要一次。 */
const requested = new Set<string>();
const listeners = new Set<() => void>();
/** 每載完一套 lazy 文法加一；`useSyncExternalStore` 的 snapshot。 */
let loadCount = 0;

/** 訂閱 lazy 文法載完（`useSyncExternalStore` 的 subscribe 形狀，配 {@link grammarLoadCount}）。 */
export function subscribeGrammarLoaded(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function grammarLoadCount(): number {
  return loadCount;
}

/**
 * 確保文法已註冊。開機文法與已載的 lazy 文法同步回 true；還沒載的 lazy 文法發一次 import、回 false，
 * 呼叫端先畫純文字，等 {@link subscribeGrammarLoaded} 通知。
 */
function ensureGrammar(resolved: string): boolean {
  const load = LAZY_GRAMMARS.get(resolved);
  if (load === undefined) return true;
  if (highlighter().getLoadedLanguages().includes(resolved)) return true;
  if (!requested.has(resolved)) {
    requested.add(resolved);
    void load().then((mod) => {
      highlighter().loadLanguageSync(mod.default);
      loadCount += 1;
      for (const listener of listeners) listener();
    });
  }
  return false;
}

// 建引擎與文法是一個長任務（dsh 量過約 120–175 ms）；放在第一個講完的 fence 的 render 裡做，會剛好在串流結束
// 那一刻卡一下。模組載入時丟一個延後的 task 先暖好；上面的 lazy 路徑留著當 timer 還沒跑時的保險。
// `unref`（只有 Node 有）讓非瀏覽器環境 import 時不會拖住 event loop。
const warmupTimer = setTimeout(() => {
  highlighter();
}, 0);
(warmupTimer as { unref?: () => void }).unref?.();

/**
 * 高亮成 shiki 的 HTML（一棵 `<pre class="shiki">`）；`undefined` 表示呼叫端畫純文字（不認得的語言，或 lazy
 * 文法還在載）。
 */
export function highlightToHtml(code: string, lang: string | undefined): string | undefined {
  const resolved = resolveLang(lang);
  if (resolved === undefined) return undefined;
  if (!ensureGrammar(resolved)) return undefined;
  return highlighter().codeToHtml(code, { lang: resolved, theme: 'css-variables' });
}

/** 一行裡的一段：字與 shiki 給它的 inline style（css-variables 主題下 `color` 一定有）。 */
export interface HighlightSpan {
  readonly text: string;
  readonly style: CSSProperties;
}

/** vscode-textmate 的 FontStyle 位元裡，shiki 折成 `text-decoration` 的那些。 */
const DECORATION_BITS: readonly (readonly [number, string])[] = [
  [4, 'underline'],
  [8, 'line-through'],
];

/** shiki HTML 那一臂給單一 token 的 style（`getTokenStyleObject` 換成 React 的鍵）。 */
function spanStyle(token: ThemedToken): CSSProperties {
  const style: CSSProperties = { color: token.color };
  const bits = token.fontStyle ?? 0;
  if ((bits & 1) !== 0) style.fontStyle = 'italic';
  if ((bits & 2) !== 0) style.fontWeight = 'bold';
  const decorations = DECORATION_BITS.filter(([bit]) => (bits & bit) !== 0);
  if (decorations.length > 0)
    style.textDecoration = decorations.map(([, value]) => value).join(' ');
  return style;
}

/**
 * 一行的 token 收成要畫的段：純空白的段併進下一段（shiki HTML 預設的 `mergeWhitespaces`），所以串流那一臂與講完
 * 換上的 `codeToHtml` 是同一棵 span 樹。行尾的純空白沒有下一段可併，自己留一段，跟 shiki 一樣。
 */
function lineSpans(line: ThemedToken[]): HighlightSpan[] {
  const spans: HighlightSpan[] = [];
  let pendingWhitespace = '';
  for (const [index, token] of line.entries()) {
    if (/^\s+$/.test(token.content) && index + 1 < line.length) {
      pendingWhitespace += token.content;
      continue;
    }
    spans.push({ text: pendingWhitespace + token.content, style: spanStyle(token) });
    pendingWhitespace = '';
  }
  return spans;
}

/**
 * 整段一起高亮，一行一筆交回（dsh `highlightLines`，`477b4f4` 的 `markdown/highlight.ts:585`）：帶行號的檔案檢視每行
 * 自己一列，拿不到 {@link highlightToHtml} 那一整棵 `<pre>`。`undefined` 表示畫純文字（不認得的語言，或 lazy 文法還在載）。
 *
 * 跟 dsh 的差別：段照 {@link lineSpans} 收（空白併進下一段、保留粗斜體），跟 fence 那一臂畫出來的一樣；dsh 只留顏色。
 * 結尾的換行 shiki 會多切出一行空行，那一行丟掉，行數才跟呼叫端自己的陣列對得上。
 */
export function highlightLines(
  code: string,
  lang: string | undefined,
): HighlightSpan[][] | undefined {
  const resolved = resolveLang(lang);
  if (resolved === undefined) return undefined;
  if (!ensureGrammar(resolved)) return undefined;
  const tokens = highlighter().codeToTokensBase(code, { lang: resolved, theme: 'css-variables' });
  const last = tokens.at(-1);
  const lines =
    tokens.length > 1 && last !== undefined && last.length === 0 ? tokens.slice(0, -1) : tokens;
  return lines.map(lineSpans);
}

/** {@link StreamingHighlightSession.updateFrame} 交給保留式 renderer 的一次更新。 */
export interface StreamingHighlightFrame {
  /** 前面完成的行要整批丟掉時才會變。 */
  readonly generation: number;
  /** 這一代裡，比上一格新完成的行。 */
  readonly appended: readonly HighlightSpan[][];
  /** 還在長的最後一行（或幾行），下一格會整個換掉。 */
  readonly tail: readonly HighlightSpan[][];
}

/**
 * 一個正在長的 fence 的增量高亮。TextMate 逐行、只往前：一行的 token 只取決於它自己的字與進到這一行時的文法狀態，
 * 所以接在後面的字不會改變已完成的行。快取每一條已完成行的段，連同它們之後的文法狀態；每次只重算新完成的行＋
 * 還在長的最後一行。結果跟從頭高亮同一段字一模一樣。不是接在後面的輸入、或換了文法，就清掉重來。
 */
export class StreamingHighlightSession {
  private resolved: string | undefined;
  /** {@link spans} 涵蓋的、以換行結尾的前綴。 */
  private prefix = '';
  /** 快取的段，{@link prefix} 的每一條完成行一筆。 */
  private spans: HighlightSpan[][] = [];
  /** {@link prefix} 之後的文法狀態；undefined＝文法的初始狀態。 */
  private state: GrammarState | undefined;
  private lastCode: string | undefined;
  private lastLang: string | undefined;
  private lastResult: HighlightSpan[][] | undefined;
  private generation = 0;
  private lastFrame: StreamingHighlightFrame | undefined;

  private reset(resolved: string | undefined): void {
    this.resolved = resolved;
    this.prefix = '';
    this.spans = [];
    this.state = undefined;
    this.generation += 1;
    this.lastFrame = undefined;
  }

  private tokenize(resolved: string, text: string): ThemedToken[][] {
    return highlighter().codeToTokensBase(text, {
      lang: resolved,
      theme: 'css-variables',
      ...(this.state === undefined ? {} : { grammarState: this.state }),
    });
  }

  /** 算出這一次的差量；`undefined` 表示畫純文字。 */
  updateFrame(code: string, lang: string | undefined): StreamingHighlightFrame | undefined {
    if (code === this.lastCode && lang === this.lastLang && this.lastFrame !== undefined) {
      return this.lastFrame;
    }
    this.lastCode = code;
    this.lastLang = lang;
    this.lastResult = undefined;
    const resolved = resolveLang(lang);
    if (resolved === undefined || !ensureGrammar(resolved)) {
      this.reset(undefined);
      return undefined;
    }
    if (resolved !== this.resolved || !code.startsWith(this.prefix)) this.reset(resolved);
    const firstNewLine = this.spans.length;
    const rest = code.slice(this.prefix.length);
    const lastNewline = rest.lastIndexOf('\n');
    if (lastNewline >= 0) {
      const grownEnd = rest[lastNewline - 1] === '\r' ? lastNewline - 1 : lastNewline;
      const tokens = this.tokenize(resolved, rest.slice(0, grownEnd));
      for (const line of tokens) this.spans.push(lineSpans(line));
      this.state = highlighter().getLastGrammarState(tokens);
      this.prefix = code.slice(0, this.prefix.length + lastNewline + 1);
    }
    this.lastFrame = {
      generation: this.generation,
      appended: this.spans.slice(firstNewLine),
      tail: this.tokenize(resolved, rest.slice(lastNewline + 1)).map(lineSpans),
    };
    return this.lastFrame;
  }

  /**
   * 整段目前的字，一行一筆；`undefined` 表示畫純文字。同一份輸入回同一個陣列，保留下來的行維持同一個陣列身分。
   */
  update(code: string, lang: string | undefined): readonly HighlightSpan[][] | undefined {
    if (code === this.lastCode && lang === this.lastLang && this.lastResult !== undefined) {
      return this.lastResult;
    }
    const frame = this.updateFrame(code, lang);
    if (frame === undefined) return undefined;
    this.lastResult = [...this.spans, ...frame.tail];
    return this.lastResult;
  }
}
