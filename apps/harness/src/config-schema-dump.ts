/**
 * `--dump-config-schema`：把疊完的 plugin 清單攤成一份 JSON Schema 2020-12 文件（[#741](https://github.com/DemianLi/nexus-agent/issues/741)）。
 *
 * 照 dsh 的 `--dump-config-schema`（`apps/cli/src/dump-config-schema.ts`、`packages/boot/app-boot/src/config-schema/document.ts`，
 * `477b4f4`）：用跟 `--dump-config` 同樣的幾層與 `--patch`，根描述疊完之後的條目清單，`$defs.patchList` 另外描述覆寫檔的格式；
 * 每顆 plugin 的欄位、預設值、說明從它自己的 `Config` 轉出來（{@link configToJsonSchema}）。
 *
 * ## 逐條對照 dsh
 *
 * - **每一列都 import**，**包括停用的**：停用的列正是使用者可能重新打開的那一列，編輯的人正需要它的規格。
 *   停用的列可以省略必填的 `config`，但**有寫的值仍然要驗**（dsh `README.zh.md:62`）。這比載入器嚴
 *   （載入器對停用的列完全不驗設定，`packages/nexus-core/src/plugin.ts` 的 `resolveEntries`），是 dsh 自己就有的落差。
 * - **轉不出來的標成不完整，不靜靜丟掉**；只要有一列不完整、或有一列載不起來，結束碼就是 1，即使輸出的文件照樣可用。
 *   退出碼回答的是「這份文件能不能取代原本的驗證」。
 * - **沒有 `Config` 的列是「欄位未知」**（`absent`），不是「禁止設定」，不算不完整、不影響結束碼。
 * - **import 期間模組寫進 `process.stdout.write` 的東西轉到標準錯誤**，標準輸出只有那一份 JSON。直接寫檔案描述子的攔不到（同 dsh）。
 * - **指到檔案的列（`file:`）先過私有檔檢查**（{@link resolveEntryModule}）：別人寫得動的模組不 import，這一列標成錯誤。
 *
 * ## 與 dsh 的差異（都是我們的載入器本來的形狀）
 *
 * 1. **`disabled` 只收字面布林**，沒有 `!!js` 運算式（#104 的偏離標註），所以沒有 `loaderExpression`。
 * 2. **條目沒有 `group`／`inject`／`intercept`／`isolate`**，`strictObject` 擋掉，規格表也一樣不收。
 * 3. **沒有 include／group 這種載體列**，沒有 `includeConfig`。
 * 4. **根上的註記叫 `x-nexus`**，不沿用 `x-cordis`：這份文件描述的是我們的清單，不是 cordis 的 loader；欄位照 dsh 的
 *    `complete`、`entries`、`diagnostics`、`patchSchema`，`profile` 不存在（我們沒有 profile）。
 *
 * 輸出是隨版本重新產生的參考，不是穩定的格式（dsh `README.zh.md:70`）。
 *
 * @module
 */

import { configToJsonSchema } from '@nexus/core';
import type { ConfigSchemaLoss, JsonSchemaDocument } from '@nexus/core';

import { resolveEntryModule, type ConfigEntry } from './plugin-config.js';

/** 一列在規格表裡的狀態。`schema`＝完整轉出來；`absent`＝沒有 `Config`（欄位未知）；`failed`＝這一列載不起來。 */
export type ConfigSchemaEntryStatus = 'schema' | 'partial' | 'absent' | 'failed';

export interface ConfigSchemaEntryReport {
  /** 在疊完的清單裡的位置（0 起算）。 */
  readonly index: number;
  readonly id?: string;
  readonly name: string;
  readonly disabled: boolean;
  readonly status: ConfigSchemaEntryStatus;
  /** 這一列 `config` 對到的定義，`absent` 與 `error` 沒有。 */
  readonly configRef?: string;
  /** `partial` 時轉不出來的每一處。 */
  readonly losses: readonly ConfigSchemaLoss[];
}

export interface ConfigSchemaDiagnostic {
  readonly level: 'warning' | 'error';
  /** 哪一列（`<id>（<name>）` 的寫法），跟列無關的診斷沒有。 */
  readonly entry?: string;
  readonly message: string;
}

/** 根上的 `x-nexus` 註記。 */
export interface ConfigSchemaAnnotation {
  /**
   * 這份文件能不能取代原本的驗證。有任何一列 `partial` 或 `error`，或有任何 `error` 診斷就是 `false`。
   * 包括停用的列。
   */
  readonly complete: boolean;
  readonly entries: readonly ConfigSchemaEntryReport[];
  readonly diagnostics: readonly ConfigSchemaDiagnostic[];
  /** 覆寫檔的格式在 `$defs` 的哪裡。 */
  readonly patchSchema: '#/$defs/patchList';
}

export interface ConfigSchemaDump extends JsonSchemaDocument {
  readonly $schema: 'https://json-schema.org/draft/2020-12/schema';
  readonly $defs: Record<string, unknown>;
  readonly 'x-nexus': ConfigSchemaAnnotation;
}

/** 疊完之後條目 id 的限制：不能有前後空白（`packages/nexus-core/src/plugin.ts` 的 `entryManifestSchema`，那是一條 `refine`，這裡用等價的 pattern 寫進去）。 */
const ID_PATTERN = '^\\S([\\s\\S]*\\S)?$';

const LOSS_LABEL: Readonly<Record<ConfigSchemaLoss['kind'], string>> = {
  refine: '有 refine／superRefine 檢查',
  custom: '是 z.custom',
  transform: '有 transform',
  preprocess: '有 preprocess',
  pipe: '有 pipe',
  unrepresentable: '是 JSON Schema 表達不了的型別',
};

function describeEntry(entry: ConfigEntry): string {
  return entry.id === undefined ? JSON.stringify(entry.name) : `${entry.id}（${entry.name}）`;
}

function ref(name: string): { readonly $ref: string } {
  return { $ref: `#/$defs/${name}` };
}

/** 條目與 patch 共用的那四格：`id`、`name`、`config`（在規則裡換成各 plugin 的定義）、`disabled`。 */
function metadata(): Record<string, unknown> {
  return {
    id: {
      type: 'string',
      minLength: 1,
      pattern: ID_PATTERN,
      description:
        '這一次掛載的識別；外面的 patch 靠它指到這一列，所以名字是承重的。不能有前後空白。',
    },
    name: {
      type: 'string',
      minLength: 1,
      description: '模組 specifier，用動態 import 載進來再取 default export。',
    },
    config: {
      type: 'object',
      description: '交給那顆 plugin 的設定，整份替換，不是深層合併。',
    },
    disabled: {
      type: 'boolean',
      description: '這一次掛載不跑。只收字面布林，沒有 `!!js` 運算式。',
    },
  };
}

/**
 * 把疊完的清單收成規格表文件。**每一列都 import**（包括停用的），但不套用任何一顆 plugin。
 *
 * @param entries - 疊完並驗過形狀的條目（`composeDefaultEntries` 或 `composeEntries`）。
 * @returns 一份 JSON Schema 文件，附 `x-nexus` 註記。
 */
export async function generateConfigSchema(
  entries: readonly ConfigEntry[],
): Promise<ConfigSchemaDump> {
  const definitions: Record<string, unknown> = {};
  const diagnostics: ConfigSchemaDiagnostic[] = [];
  const reports: ConfigSchemaEntryReport[] = [];
  const configRefs = new Map<unknown, { reference: string; required: boolean }>();
  /** plugin 名 → 它的 `config` 定義。 */
  const byName = new Map<string, string>();
  /** 條目 id → { 名字，定義 }，patch 的規則要用。 */
  const byId = new Map<string, { name: string; reference: string }>();
  const requiredRefs = new Set<string>();

  for (const [index, entry] of entries.entries()) {
    const label = describeEntry(entry);
    const disabled = entry.disabled === true;
    const base = {
      index,
      ...(entry.id !== undefined && { id: entry.id }),
      name: entry.name,
      disabled,
    };
    let plugin;
    try {
      plugin = (await resolveEntryModule(entry)).plugin;
    } catch (error) {
      reports.push({ ...base, status: 'failed', losses: [] });
      diagnostics.push({
        level: 'error',
        entry: label,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const config = plugin.Config;
    const converted = configToJsonSchema(config);
    if (config === undefined || converted.status === 'absent' || converted.schema === undefined) {
      reports.push({
        ...base,
        status: converted.status === 'absent' ? 'absent' : 'partial',
        losses: converted.losses,
      });
      if (converted.status !== 'absent') {
        diagnostics.push({
          level: 'warning',
          entry: label,
          message: 'config 整份轉不出來，這一列的設定欄位未知。',
        });
      }
      continue;
    }
    let known = configRefs.get(config);
    if (known === undefined) {
      const reference = `config${String(configRefs.size)}`;
      definitions[reference] = converted.schema;
      // 載入器拿 `config ?? {}` 去驗：空的過不了，才代表沒寫 `config` 是錯的。
      known = { reference, required: !config.safeParse({}).success };
      configRefs.set(config, known);
      if (known.required) requiredRefs.add(reference);
    }
    byName.set(entry.name, known.reference);
    if (entry.id !== undefined)
      byId.set(entry.id, { name: entry.name, reference: known.reference });
    reports.push({
      ...base,
      status: converted.status === 'complete' ? 'schema' : 'partial',
      configRef: `#/$defs/${known.reference}`,
      losses: converted.losses,
    });
    for (const loss of converted.losses) {
      diagnostics.push({
        level: 'warning',
        entry: label,
        message:
          `config 的 ${loss.path.length === 0 ? '(根)' : loss.path.join('.')} ${LOSS_LABEL[loss.kind]}，` +
          '轉不出來——這份規格比實際的驗證寬。',
      });
    }
  }

  // 條目：`name` 對到的 plugin 有規格，就把它的 `config` 定義套上去。沒有規格的名字（`absent`、載不起來、不認得）
  // 維持開放——那是「欄位未知」，不是「禁止設定」。
  const entryRules = [...byName].map(([name, reference]) => {
    const validated = { properties: { config: ref(reference) } };
    return {
      if: { properties: { name: { const: name } }, required: ['name'] },
      // 停用的列可以省略必填的 `config`，有寫的值仍然要驗。
      then: requiredRefs.has(reference)
        ? {
            ...validated,
            if: { properties: { disabled: { const: true } }, required: ['disabled'] },
            else: { required: ['config'] },
          }
        : validated,
    };
  });
  definitions['entry'] = {
    type: 'object',
    required: ['name'],
    properties: metadata(),
    additionalProperties: false,
    allOf: entryRules,
    description:
      '一列條目。有規格的 plugin 名（見 x-nexus.entries）會驗它的 config；沒有規格的名字維持開放，那是「欄位未知」，不是「禁止設定」。',
  };
  definitions['entryList'] = { type: 'array', items: ref('entry') };

  // patch：指到已知 id 的（不是 insert 的）那一條，config 套上那一列的定義。名字可以省略，寫了要嘛是空字串要嘛對得上。
  const patchRules = [...byId].map(([id, target]) => ({
    if: {
      required: ['id'],
      properties: { id: { const: id } },
      allOf: [
        { not: { required: ['insert'] } },
        {
          anyOf: [
            { not: { required: ['name'] } },
            { properties: { name: { enum: ['', target.name] } } },
          ],
        },
      ],
    },
    then: { properties: { config: ref(target.reference) } },
  }));
  definitions['patch'] = {
    type: 'object',
    properties: { ...metadata(), insert: { type: 'array', items: ref('entry') } },
    additionalProperties: false,
    allOf: patchRules,
    description:
      'insert 把條目附加在清單尾端；其餘的 patch 按 id 把給的欄位淺層蓋上去，config 是整份替換，不是深層合併。' +
      '給了 name 只是一句斷言（對不上就跳過整條），不會改名。指到不存在的 id 的 patch 只警告、跳過。',
  };
  definitions['patchList'] = { type: 'array', items: ref('patch') };

  const complete =
    !diagnostics.some((item) => item.level === 'error') &&
    !reports.some((report) => report.status === 'partial' || report.status === 'failed');
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'nexus-agent 的 plugin 設定',
    description:
      '描述 `--dump-config` 印出的清單（疊完之後的條目）。覆寫檔（`cordis.patch.yml`、`--patch`）的格式用 $defs.patchList。' +
      '要在啟動時才知道的事（模組是否載得起來、apply 裡才驗的值）仍然要靠執行期驗證。',
    $comment:
      '三層依序疊：出貨的 cordis.yml、harness home 底下的 cordis.patch.yml、--patch。JSON Schema 的 default 只是註解。' +
      '停用的列也收，也 import 它的模組；停用的列可以省略必填的 config，有寫的值仍然要驗。',
    type: 'array',
    items: ref('entry'),
    $defs: definitions,
    'x-nexus': {
      complete,
      entries: reports,
      diagnostics,
      patchSchema: '#/$defs/patchList',
    },
  };
}

/** 規格表不完整：文件已經印完了，這個錯誤讓行程以 1 結束。 */
export class ConfigSchemaIncompleteError extends Error {
  constructor(count: number) {
    super(
      `規格表不完整：${String(count)} 個問題（見上面的診斷）。輸出的文件可用，但不能取代原本的驗證。`,
    );
    this.name = 'ConfigSchemaIncompleteError';
  }
}

/**
 * 印出那一份規格表。標準輸出只放那份 JSON，診斷一律走標準錯誤；有任何一列不完整就拋
 * {@link ConfigSchemaIncompleteError}（文件照樣已經印完了）。
 *
 * **收集期間 `process.stdout.write` 轉到標準錯誤**：模組 import 時寫的東西不能排在 JSON 前面。
 *
 * @param compose - 疊那幾層（產品路徑是 `composeDefaultEntries`）。**在轉向之內呼叫**，疊層時的輸出也不會排在 JSON 前面。
 * @throws {PluginConfigError} `compose` 拋的：任何一層讀不了、形狀不合，或疊完之後有壞掉的列——同 `--dump-config`。
 * @param sink - 標準輸出／標準錯誤的寫出口，測試可以換掉。
 */
export async function runDumpConfigSchema(
  compose: () => readonly ConfigEntry[],
  sink: {
    readonly out: (text: string) => void;
    readonly err: (text: string) => void;
  },
): Promise<void> {
  const original = process.stdout.write;
  let dump: ConfigSchemaDump;
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) =>
    (process.stderr.write as (...args: unknown[]) => boolean)(
      chunk,
      ...rest,
    )) as typeof process.stdout.write;
  try {
    dump = await generateConfigSchema(compose());
  } finally {
    process.stdout.write = original;
  }
  sink.out(`${JSON.stringify(dump, null, 2)}\n`);
  for (const diagnostic of dump['x-nexus'].diagnostics) {
    const where = diagnostic.entry === undefined ? '' : ` [${diagnostic.entry}]`;
    sink.err(`${diagnostic.level}:${where} ${diagnostic.message}\n`);
  }
  if (!dump['x-nexus'].complete) {
    throw new ConfigSchemaIncompleteError(dump['x-nexus'].diagnostics.length);
  }
}
