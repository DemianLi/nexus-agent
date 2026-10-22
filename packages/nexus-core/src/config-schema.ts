/**
 * 一顆 plugin 的 `Config` → JSON Schema，並回報轉不出來的地方（[#741](https://github.com/DemianLi/nexus-agent/issues/741)）。
 *
 * 照 dsh 的 `--dump-config-schema`（`apps/cli/reference/README.zh.md:58-70`，`477b4f4`）：每顆 plugin 的欄位、預設值、說明
 * 從它自己的設定宣告轉出來；**回呼驗證這類轉不出來的限制標成不完整（partial），不靜靜丟掉**。
 *
 * ## 為什麼要自己偵測
 *
 * zod 4.4 的 `z.toJSONSchema` 對這幾種限制的處理都不會讓人發現（`io: 'input'`，實測）：
 *
 * - `refine`／`superRefine` 靜靜丟掉，不報錯——輸出的文件比真正的驗證寬，而看的人不會知道；
 * - `transform`／`preprocess`／`pipe` 投成輸入的型別、不報錯——轉換裡可以用 `addIssue` 或拋錯拒絕某些值，事前看不出來；
 * - `z.custom` 產出一個什麼都收的 `{}`。
 *
 * 所以這裡自己走一遍 schema 樹，這幾種**一律**標成不完整，不分帶不帶檢查（保守：看不出來就當有）。
 * dsh 否決了「只警告、回 0」，因為拿去給編輯器或 agent 用的人會把近似的文件當成權威
 * （dsh `.agents/notes/implemented/feature/2026-09-20-config-schema-dump-validation-policy.zh.md:21`）。
 *
 * `refine` 與 `superRefine` 在 zod 裡是同一種檢查，分不出來，一律叫 `refine`。
 *
 * ## pattern 的可攜檢查（[#1560](https://github.com/DemianLi/nexus-agent/issues/1560) N0043）
 *
 * `.regex()` 在 zod 裡是一顆 `string_format` 檢查，`z.toJSONSchema` 把它的 `source` 原樣寫成 `pattern`。**但同一個 source 在兩邊的
 * 語意不一樣**：JSON Schema 的 `pattern` 以 Unicode 語意比對，serve 用原生 `RegExp`（沒有 `u` 旗標時以 UTF-16 code unit 比對），
 * `.`、`\uD83D`、`i`／`s` 旗標一類的寫法兩邊對同一個值可能判得不一樣。所以照 dsh 的 `createPatternCheck`
 * （`packages/boot/app-boot/src/config-schema/pattern.ts`，`687f282e`）：只有確定可攜的才寫進 schema，其餘標 `pattern` 並**拿掉**那條
 * `pattern`（不產生會誤導人的約束）。
 *
 * ## 放在這裡的理由
 *
 * 轉換程式獨立成函式、放在套件裡（dsh 的轉換函式在 app-boot 套件，檢視工具是另一個套件）：命令列的規格表用它，
 * 原本打算 Creator 的唯讀檢視也用同一份、**只寫一份**（#741 的拍板）；Creator 於 2026-10-10 判過不做（#714），所以現在只有命令列的規格表用它。`Config` 的型別就在這個套件
 * （{@link NexusPlugin.Config}），也已經相依 zod。
 *
 * @module
 */

import { RegExpParser } from '@eslint-community/regexpp';
import type { AST } from '@eslint-community/regexpp';
import { z } from 'zod';

/** 一份 JSON Schema 2020-12 文件（或子文件）。這裡不替它定型別：消費者只是把它印出來或交給驗證器。 */
export type JsonSchemaDocument = Record<string, unknown>;

/**
 * 轉不出來的限制種類。
 *
 * - `refine`：`.refine` 或 `.superRefine`（zod 裡同一種檢查）。
 * - `custom`：`z.custom`。
 * - `transform`：輸出端是轉換（`.transform(fn)`）。
 * - `preprocess`：輸入端是轉換（`z.preprocess(fn, schema)`）。
 * - `pipe`：其餘的 `.pipe`。
 * - `unrepresentable`：JSON Schema 講不出來的型別（函式、`Date`、`Map`…），或整份轉換就拋了。
 * - `pattern`：`.regex()` 的正則在 JSON Schema（Unicode 語意）與原生 `RegExp` 之間語意可能不同，輸出的 schema 沒有帶那條 `pattern`。
 */
export type ConfigSchemaLossKind =
  'refine' | 'custom' | 'transform' | 'preprocess' | 'pipe' | 'unrepresentable' | 'pattern';

/** 一處轉不出來的地方：種類，加上它在設定裡的位置（空陣列即根）。 */
export interface ConfigSchemaLoss {
  readonly kind: ConfigSchemaLossKind;
  /** 欄位路徑：物件的鍵照名字，陣列與集合是 `[]`，紀錄的值是 `{}`。 */
  readonly path: readonly string[];
}

/**
 * - `complete`：輸出的 schema 表達了 `Config` 的全部限制。
 * - `partial`：輸出的 schema 可用，但比 `Config` 真正的驗證寬；`losses` 列出差在哪。
 * - `absent`：這顆 plugin 沒有 `Config`。**欄位未知，不是禁止設定**（dsh 的 `absent`，
 *   `packages/boot/app-boot/src/config-schema/collect.ts:192`）：它不算不完整，`schema` 也是 `undefined`。
 */
export type ConfigSchemaStatus = 'complete' | 'partial' | 'absent';

export interface ConfigSchemaResult {
  readonly status: ConfigSchemaStatus;
  /** `absent` 時是 `undefined`。不帶 `$schema`：一份文件裡只在根上宣告一次。 */
  readonly schema: JsonSchemaDocument | undefined;
  /** `complete` 與 `absent` 時是空的。 */
  readonly losses: readonly ConfigSchemaLoss[];
}

interface Def {
  readonly type: string;
  readonly checks?: readonly { readonly _zod: { readonly def: { readonly check: string } } }[];
  readonly [key: string]: unknown;
}

function defOf(schema: unknown): Def {
  return (schema as { _zod: { def: Def } })._zod.def;
}

/** JSON Schema 講不出來的型別。`custom` 與 `pipe`／`transform` 另外處理。 */
const UNREPRESENTABLE_TYPES: ReadonlySet<string> = new Set([
  'bigint',
  'date',
  'function',
  'map',
  'nan',
  'promise',
  'set',
  'symbol',
  'undefined',
  'void',
]);

/** 把 `def` 的孩子與各自的路徑段列出來。不認得的型別沒有孩子。 */
function children(def: Def): readonly (readonly [string | undefined, unknown])[] {
  switch (def.type) {
    case 'object':
      return [
        ...Object.entries(def['shape'] as Record<string, unknown>).map(
          ([key, child]) => [key, child] as const,
        ),
        ...(def['catchall'] === undefined ? [] : [[undefined, def['catchall']] as const]),
      ];
    case 'array':
      return [['[]', def['element']]];
    case 'set':
      return [['[]', def['valueType']]];
    case 'tuple':
      return [
        ...(def['items'] as readonly unknown[]).map((child) => ['[]', child] as const),
        ...(def['rest'] === null || def['rest'] === undefined
          ? []
          : [['[]', def['rest']] as const]),
      ];
    case 'union':
      return (def['options'] as readonly unknown[]).map((child) => [undefined, child] as const);
    case 'intersection':
      return [
        [undefined, def['left']],
        [undefined, def['right']],
      ];
    case 'record':
    case 'map':
      return [
        [undefined, def['keyType']],
        ['{}', def['valueType']],
      ];
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'nonoptional':
    case 'readonly':
    case 'catch':
    case 'promise':
      return [[undefined, def['innerType']]];
    case 'pipe':
      return [
        [undefined, def['in']],
        [undefined, def['out']],
      ];
    case 'lazy':
      return [[undefined, (def['getter'] as () => unknown)()]];
    default:
      return [];
  }
}

function bmpOnly(node: AST.Node): boolean {
  switch (node.type) {
    case 'Character':
      return node.value <= 0xffff && (node.value < 0xd800 || node.value > 0xdfff);
    case 'CharacterClassRange':
      return (
        bmpOnly(node.min) &&
        bmpOnly(node.max) &&
        (node.max.value < 0xd800 || node.min.value > 0xdfff)
      );
    case 'CharacterClass':
      return !node.negate && node.elements.every(bmpOnly);
    case 'CharacterSet':
      return (
        (node.kind === 'digit' || node.kind === 'space' || node.kind === 'word') && !node.negate
      );
    case 'Quantifier':
      return bmpOnly(node.element);
    case 'Assertion':
      return node.kind === 'start' || node.kind === 'end' || node.kind === 'word';
    default:
      return false;
  }
}

function broadSet(node: AST.Node): boolean {
  return (
    node.type === 'CharacterSet' &&
    (node.kind === 'any' ||
      ((node.kind === 'digit' || node.kind === 'space' || node.kind === 'word') && node.negate))
  );
}

function portableAlternative(alternative: AST.Alternative): boolean {
  // 單獨一個沒有錨點的「寬」集合，只問「有沒有一個字元符合」，兩種語意答案一樣。
  if (alternative.elements.length === 1 && alternative.elements.some(broadSet)) return true;
  let broadRepetitions = 0;
  const wordAssertion = alternative.elements.some(
    (element) => element.type === 'Assertion' && element.kind === 'word',
  );
  return alternative.elements.every((element) => {
    if (
      element.type === 'Quantifier' &&
      element.max === Infinity &&
      element.min <= 1 &&
      broadSet(element.element)
    ) {
      // 字界斷言與多組「寬」的重複，都看得到代理對的中點。
      return !wordAssertion && ++broadRepetitions === 1;
    }
    return bmpOnly(element);
  });
}

function signature(pattern: AST.Pattern): string {
  const incidental = new Set(['parent', 'start', 'end', 'raw', 'references', 'resolved']);
  return JSON.stringify(pattern, (key: string, value: unknown) =>
    incidental.has(key) ? undefined : value,
  );
}

const patternParser = new RegExpParser();

/**
 * 這條正則寫成 JSON Schema 的 `pattern` 之後，是不是仍然和原生 `RegExp` 判得一樣。逐行照 dsh 的 `createPatternCheck`：
 * 用 regexpp 各以 Unicode 與非 Unicode 模式解析，兩棵 AST 要一樣，而且每個選項只能有基本多文種平面的字元、非否定的字元類、
 * `\d\s\w`、`^$\b`，「寬」的集合（`.`、`\D` 等）最多一組無上限重複。旗標只收空或 `u`；語法錯就當不可攜。
 *
 * dsh 的版本是 async（動態 import regexpp）；這裡 `configToJsonSchema` 是同步的，所以頂層 import，其餘不變。
 *
 * @param source - `RegExp.source`。
 * @param flags - `RegExp.flags`。
 * @returns 可攜為 `true`。
 */
export function portablePattern(source: string, flags = ''): boolean {
  if (flags !== '' && flags !== 'u') return false;
  try {
    const unicode = patternParser.parsePattern(source, 0, source.length, { unicode: true });
    if (flags === 'u') return true;
    const native = patternParser.parsePattern(source, 0, source.length, { unicode: false });
    return (
      signature(native) === signature(unicode) && native.alternatives.every(portableAlternative)
    );
  } catch (error) {
    // 不合 Unicode 語法的寫不成標準的 pattern。
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

/** 這個節點上 `.regex()` 帶的、不可攜的正則。 */
function nonPortableRegexes(schema: unknown): RegExp[] {
  const found: RegExp[] = [];
  for (const check of defOf(schema).checks ?? []) {
    const def = check._zod.def as { check: string; format?: unknown; pattern?: unknown };
    if (
      def.check === 'string_format' &&
      def.format === 'regex' &&
      def.pattern instanceof RegExp &&
      !portablePattern(def.pattern.source, def.pattern.flags)
    ) {
      found.push(def.pattern);
    }
  }
  return found;
}

/** `z.toJSONSchema` 的 `override`：把不可攜的那幾條 `pattern` 從這個節點的輸出拿掉（單一條在 `pattern`，多條在 `allOf`）。 */
function dropNonPortablePatterns(ctx: {
  readonly zodSchema: unknown;
  readonly jsonSchema: Record<string, unknown>;
}): void {
  const sources = new Set(nonPortableRegexes(ctx.zodSchema).map((regex) => regex.source));
  if (sources.size === 0) return;
  const json = ctx.jsonSchema;
  if (typeof json['pattern'] === 'string' && sources.has(json['pattern'])) delete json['pattern'];
  const allOf = json['allOf'];
  if (Array.isArray(allOf)) {
    const kept = allOf.filter(
      (entry: unknown) =>
        !(
          typeof entry === 'object' &&
          entry !== null &&
          sources.has((entry as { pattern?: unknown }).pattern as string)
        ),
    );
    if (kept.length === 0) delete json['allOf'];
    else json['allOf'] = kept;
  }
}

function findLosses(root: z.ZodType): ConfigSchemaLoss[] {
  const losses: ConfigSchemaLoss[] = [];
  // 同一個節點走兩次（`lazy` 的自我參照、共用的子 schema）只報一次，也不會無窮遞迴。
  const seen = new Set<unknown>();
  const walk = (schema: unknown, path: readonly string[], parent: string | undefined): void => {
    const def = defOf(schema);
    if (seen.has(def)) return;
    seen.add(def);
    for (const check of def.checks ?? []) {
      if (check._zod.def.check === 'custom') losses.push({ kind: 'refine', path });
    }
    if (nonPortableRegexes(schema).length > 0) losses.push({ kind: 'pattern', path });
    if (def.type === 'custom') losses.push({ kind: 'custom', path });
    else if (UNREPRESENTABLE_TYPES.has(def.type)) losses.push({ kind: 'unrepresentable', path });
    else if (def.type === 'transform' && parent !== 'pipe')
      losses.push({ kind: 'transform', path });
    else if (def.type === 'pipe') {
      const inType = defOf(def['in']).type;
      const outType = defOf(def['out']).type;
      losses.push({
        kind:
          outType === 'transform' ? 'transform' : inType === 'transform' ? 'preprocess' : 'pipe',
        path,
      });
    }
    for (const [segment, child] of children(def)) {
      walk(child, segment === undefined ? path : [...path, segment], def.type);
    }
  };
  walk(root, [], undefined);
  return losses;
}

/**
 * 把一顆 plugin 的 `Config` 轉成 JSON Schema，並回報轉不出來的限制。
 *
 * **輸入的形狀**（`io: 'input'`）：覆寫檔寫的是使用者打的那一份，不是驗完的結果——有預設值的欄位因此不是必填，
 * 預設值出現在 `default`。`z.strictObject` 轉成 `additionalProperties: false`。
 *
 * @param config - `NexusPlugin.Config`；沒有的 plugin 傳 `undefined`。
 * @returns 狀態、schema 與每一處轉不出來的地方。
 */
export function configToJsonSchema(config: z.ZodType | undefined): ConfigSchemaResult {
  if (config === undefined) return { status: 'absent', schema: undefined, losses: [] };
  const losses = findLosses(config);
  let schema: JsonSchemaDocument;
  try {
    schema = z.toJSONSchema(config, {
      target: 'draft-2020-12',
      io: 'input',
      // 轉不出來的當成「什麼都收」，配上上面的 `losses` 講清楚；不讓 zod 為了一處就整份丟掉。
      unrepresentable: 'any',
      // 不可攜的 `pattern` 不寫進去（`findLosses` 已記一筆 `pattern`）：寫了就是一條兩邊判得不一樣的約束。
      override: dropNonPortablePatterns,
    }) as JsonSchemaDocument;
  } catch {
    return {
      status: 'partial',
      schema: undefined,
      losses: [...losses, { kind: 'unrepresentable', path: [] }],
    };
  }
  delete schema['$schema'];
  return { status: losses.length === 0 ? 'complete' : 'partial', schema, losses };
}
