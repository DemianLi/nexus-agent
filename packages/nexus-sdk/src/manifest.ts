/**
 * 插件的 manifest：身分、提供什麼、需要什麼、設定的形狀、什麼時候生效、要什麼特權。
 *
 * 決議 §3-4 第 10 條：**必填，缺一個就不載入**。這支驗證只是函式庫——載入期的接線（`plugin-config.ts`）
 * 不在這一刀（#1416 PR 1），所以它今天不會擋任何出貨的列。
 *
 * ## 偏離 dsh
 *
 * dsh 的身分只有 `package.json` 的 `name`／`version` 加 Loader 的列 id；它的 `dsh` 欄位沒有 id、owner、provides、
 * consumes、capabilities、reload（`packages/util/package-manifest/src/types.ts:8-39`）。這裡的必填欄位是產品需求，
 * 超出 dsh 的射程；決議 §五登記。`config` 用 zod `strictObject` 是沿用既有偏離（`@nexus/core` 的 `plugin.ts` 檔頭）。
 *
 * ## `reload` 拆成兩軸（#1136）
 *
 * 一條 `即時／需重啟` 說不清「改程式碼」與「改設定」是兩回事：
 *
 * | 軸 | 值 | 意思 |
 * | --- | --- | --- |
 * | `code` | `coexist` | 新舊兩版能並存，舊版留給開著的對話，新對話走新版 |
 * | `code` | `restart` | 換程式碼要重啟行程 |
 * | `config` | `next-thread` | 設定一改，下一條 thread 看到新值，開著的不動 |
 * | `config` | `restart` | 設定一改要重啟行程 |
 *
 * **`code: 'coexist'` 今天被拒收**：兩版並存的案例要等版本路由那張卡落地才驗得到，先收下就是一個沒驗過的宣告
 * （demian 2026-10-13 拍板，Q4）。
 *
 * **插件只宣告自己知道的那一半。** 宿主那一半（這一列被宿主 import、自建、起動期讀）由宿主機械算出，今天是
 * `apps/harness/src/plugin-row-classes.ts`；{@link effectiveReload} 取兩邊較嚴的那個，不是只看 manifest。
 *
 * @module
 */

import semver from 'semver';
import { z } from 'zod';

/** `reload.code` 的值，由鬆到嚴。 */
export const CODE_RELOADS = ['coexist', 'restart'] as const;
/** `reload.config` 的值，由鬆到嚴。 */
export const CONFIG_RELOADS = ['next-thread', 'restart'] as const;

export type CodeReload = (typeof CODE_RELOADS)[number];
export type ConfigReload = (typeof CONFIG_RELOADS)[number];

/** 一條 `reload` 宣告：兩軸各一格。 */
export interface Reload {
  readonly code: CodeReload;
  readonly config: ConfigReload;
}

/** 提供出去的一個服務：token 名與它的契約版本。 */
export interface Provide {
  readonly token: string;
  readonly version: string;
}

/** 依賴進來的一個服務：token 名、可接受的 semver 範圍、是不是選配。 */
export interface Consume {
  readonly token: string;
  readonly range: string;
  /** 選配的服務不放進 `inject`，用 `ctx.get` 讀；省略即必要。 */
  readonly optional?: boolean;
}

/** 通過驗證的 manifest。 */
export interface Manifest {
  /** 插件的身分，跨版本不變。 */
  readonly id: string;
  /** 這一版的 semver。 */
  readonly version: string;
  /** 負責的團隊。出問題時後台插件頁要指得出找誰。 */
  readonly owner: string;
  readonly provides: readonly Provide[];
  readonly consumes: readonly Consume[];
  /** 設定的 schema，必須是 `strictObject`。 */
  readonly config: z.ZodObject;
  readonly reload: Reload;
  /** 子行程、網路、檔案系統等特權。這一刀只驗它在場，「不宣告就不給」的執行另開一張。 */
  readonly capabilities: readonly string[];
}

/** 必填的欄位，以巢狀路徑寫。缺任何一個都拒收。 */
export const REQUIRED_FIELDS = [
  'id',
  'version',
  'owner',
  'provides',
  'consumes',
  'config',
  'reload.code',
  'reload.config',
  'capabilities',
] as const;

/** 一個欄位的值不合格。 */
export interface ManifestIssue {
  readonly field: string;
  readonly reason: string;
}

/**
 * manifest 不合格。**指名那一列**（Loader 的列 id）、插件 id（讀得到的話），再分「缺」與「不合格」兩類，
 * 讓後台插件頁與啟動結算不用解析訊息。
 */
export class ManifestError extends Error {
  constructor(
    /** 列 id。 */
    readonly row: string,
    /** manifest 自己宣告的 `id`；缺或不是字串時 `undefined`。 */
    readonly plugin: string | undefined,
    /** 缺的必填欄位（巢狀路徑，例如 `reload.config`）。 */
    readonly missing: readonly string[],
    /** 在場但不合格的欄位。 */
    readonly invalid: readonly ManifestIssue[],
  ) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`缺少必填欄位 ${missing.join('、')}`);
    for (const issue of invalid) parts.push(`${issue.field}：${issue.reason}`);
    super(
      `列 ${row}${plugin === undefined ? '' : `（插件 ${plugin}）`}的 manifest 不合格：${parts.join('；')}`,
    );
    this.name = 'ManifestError';
  }
}

const nonEmpty = z.string().min(1);
const version = z.string().refine((value) => semver.valid(value) !== null, '不是 semver 版本');
const range = z.string().refine((value) => semver.validRange(value) !== null, '不是 semver 範圍');

/** `config` 必須是 zod `strictObject`：未知鍵讓載入失敗是登記過的偏離。 */
export function isStrictObjectSchema(value: unknown): value is z.ZodObject {
  const def = (
    value as {
      _zod?: { def?: { type?: string; catchall?: { _zod?: { def?: { type?: string } } } } };
    }
  )?._zod?.def;
  return def?.type === 'object' && def.catchall?._zod?.def?.type === 'never';
}

const manifestShape = z.strictObject({
  id: nonEmpty,
  version,
  owner: nonEmpty,
  provides: z.array(z.strictObject({ token: nonEmpty, version })),
  consumes: z.array(z.strictObject({ token: nonEmpty, range, optional: z.boolean().optional() })),
  config: z.custom<z.ZodObject>(isStrictObjectSchema, 'config 必須是 zod strictObject'),
  reload: z.strictObject({ code: z.enum(CODE_RELOADS), config: z.enum(CONFIG_RELOADS) }),
  capabilities: z.array(nonEmpty),
});

function lookup(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * 載入期驗證一份 manifest。
 *
 * @param raw - 插件匯出的那份東西，沒驗過。
 * @param row - 這一列的 id，**錯誤要指名它**：manifest 自己缺 `id` 時也一樣。
 * @returns 驗過的 manifest。
 * @throws {@link ManifestError} 缺必填欄位、欄位不合格、有未知欄位，或宣告了尚未放行的 `code: 'coexist'`。
 */
export function validateManifest(raw: unknown, row: string): Manifest {
  const missing = REQUIRED_FIELDS.filter((path) => lookup(raw, path) === undefined);
  const plugin = lookup(raw, 'id');
  const pluginId = typeof plugin === 'string' && plugin !== '' ? plugin : undefined;
  const invalid: ManifestIssue[] = [];

  const parsed = manifestShape.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path.join('.');
      if (missing.includes(field as (typeof REQUIRED_FIELDS)[number])) continue;
      if (issue.code === 'unrecognized_keys') {
        for (const key of issue.keys) {
          invalid.push({ field: [field, key].filter(Boolean).join('.'), reason: '不認得的欄位' });
        }
        continue;
      }
      // 缺的欄位已經在 `missing`；它底下的子欄位不再重複報。
      if (missing.some((path) => field.startsWith(`${path}.`))) continue;
      invalid.push({ field: field === '' ? '(根)' : field, reason: issue.message });
    }
  } else if (parsed.data.reload.code === 'coexist') {
    invalid.push({
      field: 'reload.code',
      reason:
        "'coexist' 還不放行：兩版並存要等版本路由的案例驗過才收（#1416 Q4），先宣告就是沒驗過的承諾；請宣告 'restart'",
    });
  }

  if (missing.length > 0 || invalid.length > 0) {
    throw new ManifestError(row, pluginId, missing, invalid);
  }
  return parsed.data as Manifest;
}

/** 宣告一份 manifest：只為了讓型別推得出來，執行期原樣回傳。驗證在載入期做，不在這裡。 */
export function defineManifest(manifest: Manifest): Manifest {
  return manifest;
}

/** 較嚴的那一個：`order` 由鬆到嚴。 */
function stricter<T extends string>(order: readonly T[], a: T, b: T): T {
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

/**
 * 一次改動真正的生效時機：manifest 與宿主算出的那一半，**每一軸取較嚴的**。
 *
 * @param manifest - 插件宣告的。
 * @param host - 宿主機械算出的；宿主在某一軸上沒意見就省略那一格。
 */
export function effectiveReload(manifest: Reload, host: Partial<Reload> = {}): Reload {
  return {
    code: stricter(CODE_RELOADS, manifest.code, host.code ?? manifest.code),
    config: stricter(CONFIG_RELOADS, manifest.config, host.config ?? manifest.config),
  };
}
