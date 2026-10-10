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
 * ## 放在這裡的理由
 *
 * 轉換程式獨立成函式、放在套件裡（dsh 的轉換函式在 app-boot 套件，檢視工具是另一個套件）：命令列的規格表用它，
 * 原本打算 Creator 的唯讀檢視也用同一份、**只寫一份**（#741 的拍板）；Creator 於 2026-10-10 判過不做（#714），所以現在只有命令列的規格表用它。`Config` 的型別就在這個套件
 * （{@link NexusPlugin.Config}），也已經相依 zod。
 *
 * @module
 */

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
 */
export type ConfigSchemaLossKind =
  'refine' | 'custom' | 'transform' | 'preprocess' | 'pipe' | 'unrepresentable';

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
