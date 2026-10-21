/**
 * `glob` 的 `pattern` 的大括號上限：交給 backend 之前先量長度、巢狀深度與展開數，超過就回固定的工具錯誤，
 * backend 一次都不叫。
 *
 * ## 為什麼要量
 *
 * 基座的工作區 `glob` 走 `fast-glob`（`deepagents@1.13.1`，`dist/src-C9o7b5C6.js:1035-1083`），比對之前會先做
 * 大括號展開，展開出幾個 pattern 由 pattern 本身決定。所以交給 backend 之前，用一次線性、非遞迴的掃描算出深度與
 * 展開數的上界。
 *
 * ## 上界怎麼算（對 `braces@3.0.3` 的 `lib/parse.js` 與 `lib/expand.js`）
 *
 * 照 `braces` 的切法掃一遍：`\` 跳過下一個字元，`[…]` 與引號內是字面，`U+FEFF`／`U+00A0` 直接略過；`{` 與 `(`
 * 各開一層，`}` 只收大括號、`)` 只收小括號，對不上的是字面；逗號只在大括號那一層切分。
 *
 * - 串接：同一段裡各組相乘。
 * - 有逗號的組：各段相加。
 * - 沒有逗號、帶 `..` 的組是範圍：只認 `{整數..整數[..整數]}` 與 `{字母..字母[..整數]}`，個數照 `fill-range` 算；
 *   其餘寫法一律當成超過上限。`braces` 對範圍的切法跟字面很近卻不全一樣，不認得的就不放，寧可多拒。
 * - 沒有逗號也不是範圍的組是字面，展開數是裡面各組相乘。
 * - 掃到結尾還沒關的組，`braces` 會把它攤回外層、逗號變字面，所以取各段相乘（跟相加取大的那個）。
 *
 * 算出來的是上界：引號、`$` 前綴這些 `braces` 會當字面的，這裡照算，只會多不會少。深度算的是大括號與小括號
 * 一起的巢狀層數，一超過上限就停、不再往下掃。長度上限對齊 `braces` 的 `MAX_LENGTH`（10000）。
 *
 * ## 掛在哪
 *
 * {@link limitGlobPatterns} 包 backend，掛在 `foldRegistry` 交給基座的那一份最內層、不看任何設定（同
 * `recordBackendOutcomes`）：基座的 `glob` 工具、root 與子代理都經過它。拒絕時替這一次工具呼叫記下
 * `SEARCH_INVALID_PATTERN`（{@link noteSearchError}），由 `fs-tool-errors.ts` 標成錯誤。`grep` 的 `glob` 不經過
 * 這一層：工作區那一路交給 ripgrep 的 `--glob`，同 dsh。
 *
 * ## 偏離 dsh：#1605 落地前的暫時防線（理由 1：基座表達不出來）
 *
 * dsh 的 `glob` 把 pattern 原樣交給 `rg --files --glob=`（`packages/fs/tool-fs-search/src/glob.ts:89-92`，`687f282e`），
 * 沒有這一步。我們的 `glob` 是基座的，走 `fast-glob`。退到：交給 backend 之前先量、超過就拒。撤除條件：
 * [#1605](https://github.com/DemianLi/nexus-agent/issues/1605) 合併、`glob` 不再經 `fast-glob`。
 *
 * @module
 */

import { noteSearchError, SEARCH_INVALID_PATTERN } from './fs-tool-errors.js';

/** 大括號（含小括號）最多巢狀幾層。 */
export const GLOB_PATTERN_MAX_DEPTH = 8;

/** 一個 pattern 最多展開成幾個。 */
export const GLOB_PATTERN_MAX_EXPANSIONS = 256;

/** pattern 最長幾個字元，同 `braces` 的 `MAX_LENGTH`。 */
export const GLOB_PATTERN_MAX_LENGTH = 10_000;

/** 量出來的兩個數。`expansions` 是上界，可能是 `Infinity`。 */
export interface GlobPatternMeasure {
  readonly depth: number;
  readonly expansions: number;
}

/** 掃描時的一層。 */
interface Frame {
  readonly kind: 'root' | 'brace' | 'paren';
  /** 這一組在原字串裡的內容從哪裡開始（`{` 的下一個字元）。 */
  readonly start: number;
  /** 已經收完的各段展開數相加。 */
  sum: number;
  /** 已經收完的各段展開數相乘（沒關的組用）。 */
  all: number;
  /** 目前這一段的展開數。 */
  prod: number;
  /** 這一層出現過逗號。 */
  comma: boolean;
  /** 這一層出現過 `..`（逗號之前）。 */
  dots: boolean;
}

/** `braces` 直接略過的兩個字元（`lib/parse.js` 的 Invalid chars）：`U+FEFF` 與 `U+00A0`。 */
const SKIPPED = new Set([String.fromCharCode(0xfeff), String.fromCharCode(0xa0)]);

const NUMERIC_RANGE = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/u;
const LETTER_RANGE = /^([A-Za-z])\.\.([A-Za-z])(?:\.\.(-?\d+))?$/u;

/**
 * 範圍組的個數，照 `fill-range@7.1.1`：`floor(|b - a| / max(|step|, 1)) + 1`。不認得的寫法回 `Infinity`。
 *
 * @param raw - 大括號裡的原文（不含大括號）。
 * @returns 個數或 `Infinity`。
 */
function rangeSize(raw: string): number {
  const content = [...raw].filter((char) => !SKIPPED.has(char)).join('');
  const numeric = NUMERIC_RANGE.exec(content);
  const letters = numeric === null ? LETTER_RANGE.exec(content) : null;
  const match = numeric ?? letters;
  if (match === null) return Infinity;
  const [, from = '', to = '', step] = match;
  const a = numeric === null ? from.charCodeAt(0) : Number(from);
  const b = numeric === null ? to.charCodeAt(0) : Number(to);
  const stride = step === undefined ? 1 : Math.max(Math.abs(Number(step)), 1);
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isFinite(stride)) {
    return Infinity;
  }
  return Math.floor(Math.abs(b - a) / stride) + 1;
}

/**
 * 一次線性掃描量出 pattern 的巢狀深度與展開數上界。不遞迴、不展開。深度一超過 {@link GLOB_PATTERN_MAX_DEPTH}
 * 就停，回那一層的深度與 `Infinity`。
 *
 * @param pattern - 模型給的 glob pattern。
 * @returns 深度與展開數上界。
 */
export function measureGlobPattern(pattern: string): GlobPatternMeasure {
  const root: Frame = {
    kind: 'root',
    start: 0,
    sum: 0,
    all: 1,
    prod: 1,
    comma: false,
    dots: false,
  };
  const stack: Frame[] = [root];
  let depth = 0;
  let lastDot = false;
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index] ?? '';
    index += 1;
    if (SKIPPED.has(char)) continue;
    const top = stack[stack.length - 1] ?? root;
    if (char === '.') {
      if (lastDot && top.kind === 'brace' && !top.comma) top.dots = true;
      lastDot = true;
      continue;
    }
    lastDot = false;
    if (char === '\\') {
      index += 1;
    } else if (char === '[') {
      // 同 `braces`：吃到對應的 `]`（可巢狀、可跳脫），沒有就吃到結尾。
      let brackets = 1;
      while (index < pattern.length) {
        const next = pattern[index];
        index += 1;
        if (next === '[') brackets += 1;
        else if (next === '\\') index += 1;
        else if (next === ']') {
          brackets -= 1;
          if (brackets === 0) break;
        }
      }
    } else if (char === '"' || char === "'" || char === '`') {
      while (index < pattern.length) {
        const next = pattern[index];
        index += 1;
        if (next === '\\') index += 1;
        else if (next === char) break;
      }
    } else if (char === '{' || char === '(') {
      stack.push({
        kind: char === '{' ? 'brace' : 'paren',
        start: index,
        sum: 0,
        all: 1,
        prod: 1,
        comma: false,
        dots: false,
      });
      depth = Math.max(depth, stack.length - 1);
      // 超過就停：後面不必再看，範圍組的切片也不會疊成平方。
      if (depth > GLOB_PATTERN_MAX_DEPTH) return { depth, expansions: Infinity };
    } else if ((char === '}' && top.kind === 'brace') || (char === ')' && top.kind === 'paren')) {
      stack.pop();
      const parent = stack[stack.length - 1] ?? root;
      const size =
        top.kind === 'paren'
          ? top.prod
          : top.comma
            ? top.sum + top.prod
            : top.dots
              ? rangeSize(pattern.slice(top.start, index - 1))
              : top.prod;
      parent.prod *= size;
    } else if (char === ',' && top.kind === 'brace') {
      top.sum += top.prod;
      top.all *= top.prod;
      top.prod = 1;
      top.comma = true;
    }
  }
  // 沒關的組攤回外層。
  while (stack.length > 1) {
    const open = stack.pop() ?? root;
    const parent = stack[stack.length - 1] ?? root;
    parent.prod *= Math.max(open.all * open.prod, open.sum + open.prod);
  }
  return { depth, expansions: root.prod };
}

/**
 * pattern 在三個上限之內。長度先看，超過就不掃。
 *
 * @param pattern - 模型給的 glob pattern。
 * @returns 長度、深度、展開數都不超過上限時是 `true`。
 */
export function globPatternWithinLimits(pattern: string): boolean {
  if (pattern.length > GLOB_PATTERN_MAX_LENGTH) return false;
  // 深度超過時 `measureGlobPattern` 回的展開數是 `Infinity`，所以只比展開數。
  return measureGlobPattern(pattern).expansions <= GLOB_PATTERN_MAX_EXPANSIONS;
}

/** `glob` 被拒時的錯誤。基座在前面加 `Error finding files: `。 */
export const GLOB_PATTERN_TOO_COMPLEX =
  `glob pattern is too complex: at most ${GLOB_PATTERN_MAX_LENGTH} characters, brace groups nested at most ` +
  `${GLOB_PATTERN_MAX_DEPTH} levels and expanding to at most ${GLOB_PATTERN_MAX_EXPANSIONS} patterns. ` +
  'Split it into simpler patterns.';

/**
 * 把 backend 包一層：`glob(pattern, …)` 的 `pattern` 超過上限就直接回 `{ error }`，不叫 backend。其餘原樣轉交。
 *
 * **轉交的是同一個實例**，同 `recordBackendOutcomes`：方法以原物件為 `this` 呼叫，非方法的屬性原樣讀出，
 * `CompositeBackend.isInstance` 與 `instanceof` 照樣成立。
 *
 * @param backend - fold 折出來的那個。
 * @returns 交給基座的那一份。
 */
export function limitGlobPatterns<T extends object>(backend: T): T {
  return new Proxy(backend, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      const method = value as (...args: unknown[]) => unknown;
      if (property !== 'glob') return method.bind(target);
      return (...args: unknown[]): unknown => {
        if (typeof args[0] === 'string' && !globPatternWithinLimits(args[0])) {
          noteSearchError(SEARCH_INVALID_PATTERN);
          return { error: GLOB_PATTERN_TOO_COMPLEX };
        }
        return method.apply(target, args);
      };
    },
  });
}
