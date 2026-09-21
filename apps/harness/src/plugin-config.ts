/**
 * 從 YAML 組裝 plugin 清單：出貨的預設 ＋ 使用者的 patch 層。
 *
 * **這一刀只做組裝，不接線。** `cli.ts` 與 `serve.ts` 還是走 `DEFAULT_PLUGINS`；把它們改成
 * 走這裡是下一刀的事（[#454](https://github.com/DemianLi/nexus-agent/issues/454) 的第三刀）。
 * 分開的理由是失敗的形狀不同：解析錯了是這個檔案的問題，組裝錯了是接線的問題，混在一張
 * diff 裡沒有人分得出來哪一半該回滾。
 *
 * ## 兩種方言，照 dsh
 *
 * 出貨檔（`cordis.yml`）是**條目清單**，使用者的檔（`cordis.patch.yml`、`--patch`）是
 * **patch 清單**。dsh 的 `renderConfigDump(binName, absoluteConfigPath, layers, warn)` 就是
 * 這個形狀：一個 base 設定檔加上若干層 patch（`packages/boot/app-boot/src/index.ts:403`）。
 *
 * ## 疊加順序
 *
 * 出貨預設 → `$NEXUS_AGENT_HOME/cordis.patch.yml` → 任意個 `--patch`，照命令列順序。
 * **不從目前目錄讀**——那一份會跟著 clone 一起到來，而它能停用核准。
 *
 * ## 驗證排在疊加之後
 *
 * 條目的形狀（{@link entrySchema}）**在 patch 全部疊完之後才驗**。先驗再疊的話，一個 patch
 * 就能把不合法的欄位塞進一列已經驗過的條目裡，而那列不會再被看第二眼。代價是出貨檔自己的
 * 錯誤也要等到疊完才報——可以接受，因為錯誤訊息指得出是第幾列。
 *
 * plugin 自己的 `config` **不在這裡驗**：那是 `resolveEntries` 的事
 * （[#453](https://github.com/DemianLi/nexus-agent/issues/453)），而且要等 id 發完才有東西
 * 可以指名。這裡只驗「這一列長得像不像一個條目」。
 *
 * ## 這個模組住在 `apps/harness/src/` 是承重的
 *
 * `name` 用動態 import 解析，而**裸 specifier 的解析錨點是做 import 的那個模組的位置**，
 * 不是 `process.cwd()`。實測：同一支探針放在 repo 外就 `Cannot find package '@nexus/...'`，
 * 放進 `apps/harness/src/` 才解析得到（`@nexus/*` 全部是 `@nexus/harness` 的相依）。所以
 * 這裡不能改寫成一個吃路徑參數的泛用工具搬去別的地方。
 *
 * @module
 */

import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';

import type { PluginEntry } from '@nexus/core';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/** 出貨的預設清單，放在 `apps/harness/` 底下。 */
export const SHIPPED_CONFIG_FILENAME = 'cordis.yml';

/** 使用者那一層的檔名，放在 harness home 底下。 */
export const USER_PATCH_FILENAME = 'cordis.patch.yml';

/** 這個模組所有的失敗都是這個型別。訊息一律指得出是哪個檔、哪一列。 */
export class PluginConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginConfigError';
  }
}

/**
 * 一列條目。
 *
 * `name` 是模組 specifier（套件名或子路徑），`config` 原封不動交給 `resolveEntries` 去驗。
 * **`strictObject`**：多寫一個欄位是打錯字，不是擴充點——dsh 的條目還有 `inject`／
 * `intercept`／`isolate`，我們一個都沒有，安靜吃掉會讓人以為設定生效了。
 */
export const entrySchema = z.strictObject({
  id: z.string().min(1, 'id 不能是空字串').optional(),
  name: z.string().min(1, 'name 要給一個模組 specifier'),
  // `config` 只在這裡確認它是一張表；內容歸 plugin 自己的 `Config` schema。`config: null`
  // （YAML 裡寫了 `config:` 卻沒給值）會落在這條，訊息指得出是哪一列。
  config: z.record(z.string(), z.unknown()).optional(),
  disabled: z.boolean().optional(),
});

/** 一列條目，`entrySchema` 的輸出。 */
export type ConfigEntry = z.infer<typeof entrySchema>;

/**
 * 一列 patch。
 *
 * 形狀照 dsh 的 `PatchOptions`（`vendor/include/src/index.ts:130`）砍掉我們沒有的欄位。
 *
 * **`looseObject` 而不是 `object`，這一格是實測改出來的。** patch 的語意是「其餘欄位淺層
 * 覆寫上去」（dsh 的 `for (const [key, value] of Object.entries(overrides)) target[key] = value`），
 * 所以未知欄位必須**活著走到疊完**，再由 {@link entrySchema} 的 `strictObject` 去擋——那時候
 * 才知道它蓋到了哪一列。zod 的 `z.object()` 會把未知鍵**安靜剝掉**，配上去的結果是一條
 * 寫錯欄位的 patch 完全沒有作用也完全沒有訊息。這個缺陷是「整條路上也是疊完才驗」那條測試
 * 抓出來的。
 */
export const patchSchema = z.looseObject({
  id: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  insert: z.array(z.record(z.string(), z.unknown())).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  disabled: z.boolean().optional(),
});

/** 一列 patch。 */
export type ConfigPatch = z.infer<typeof patchSchema>;

/** 疊加時跳過某一條 patch 的說明，預設印到 stderr。 */
export type PluginConfigWarn = (message: string) => void;

const warnToStderr: PluginConfigWarn = (message) => {
  process.stderr.write(`${message}\n`);
};

/**
 * 把一份 YAML 讀成「頂層是一個陣列，每個元素是一張表」。
 *
 * 兩種方言共用這一段，因為它們的檔案層級規則一樣：**不是頂層陣列就是設定錯了，一律拋**。
 * 空檔與只有註解的檔會 parse 成 `null`，落在同一條——要停用某一層請寫 `[]`，照 dsh
 * （`packages/boot/app-boot/README.zh.md` 的「本机偏好」一節）。
 *
 * @param source - 檔案全文。
 * @param label - 錯誤訊息裡怎麼稱呼這個檔（路徑）。
 * @returns 頂層的每一列，還沒驗過形狀。
 * @throws {PluginConfigError} YAML 壞了、不是陣列，或某一列不是一張表。
 */
export function parseRows(source: string, label: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = parseYaml(source) as unknown;
  } catch (error) {
    throw new PluginConfigError(`${label} 不是合法的 YAML：${String(error)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new PluginConfigError(
      `${label} 的頂層必須是一個陣列。空的檔案與只有註解的檔案都不算——` + '要停用這一層請寫 `[]`。',
    );
  }
  return parsed.map((row, index) => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      throw new PluginConfigError(
        `${label} 第 ${String(index + 1)} 列必須是一張表，實際是 ${describe(row)}。`,
      );
    }
    return row as Record<string, unknown>;
  });
}

/** 解析出貨那一份：頂層陣列，每一列之後會被當成條目驗。 */
export function parseEntryList(source: string, label: string): Record<string, unknown>[] {
  return parseRows(source, label);
}

/**
 * 解析使用者那一層。
 *
 * patch 的欄位在這裡就驗，因為它們**不會**被後面的疊加改變；條目的形狀才要等疊完。
 *
 * @param source - 檔案全文。
 * @param label - 路徑，寫進錯誤訊息。
 * @returns 這一層的 patch。
 * @throws {PluginConfigError} 形狀不合。
 */
export function parsePatchList(source: string, label: string): ConfigPatch[] {
  return parseRows(source, label).map((row, index) => {
    const result = patchSchema.safeParse(row);
    if (!result.success) {
      throw new PluginConfigError(
        `${label} 第 ${String(index + 1)} 列不是一條合法的 patch — ${formatIssues(result.error)}`,
      );
    }
    return result.data;
  });
}

/**
 * 把 patch 疊到條目清單上。
 *
 * **逐條照 dsh 的 `applyEntryPatches`**（`vendor/include/src/index.ts:57`）：
 *
 * - 輸入不被改（深拷貝），所以同一份清單可以重放——重載時舊 patch 的值不會被烤進去。
 * - `insert` 不帶 `id` 就接在尾巴；**插進去的列當場進索引**，所以同一串裡後面的 patch
 *   指得到前面插的列。dsh 是 `buildMap(insert)`，理由在它的註解裡：一層要能設定或停用
 *   前一層插進來的列，否則插進來的東西悄悄變成不可 patch 的。
 * - 非 `insert` 的 patch 沒有 `id` → 警告跳過。
 * - `id` 找不到 → 警告跳過，**不是失敗**：一份 overlay 給多個 surface 共用時不必每棵樹都命中。
 * - **`name` 是斷言不是選擇器**：給了而且對不上就警告跳過，原列一個字都不動。
 * - 其餘欄位**淺層覆寫**，所以 `config` 是整份替換不是深層合併。dsh 的 README 把這一條
 *   列在「已知限制」裡：profile 覆寫必須重述要保留的欄位。
 *
 * 我們沒有 dsh 的 `group`，所以索引不用遞迴——扁平一層。
 *
 * @param entries - 疊之前的清單（不會被改）。
 * @param patches - 全部層攤平成一串，照套用順序。
 * @param warn - 跳過某條 patch 時往哪裡講。
 * @returns 疊完的新清單。
 */
export function applyEntryPatches(
  entries: readonly Record<string, unknown>[],
  patches: readonly ConfigPatch[],
  warn: PluginConfigWarn = warnToStderr,
): Record<string, unknown>[] {
  const data = structuredClone(entries) as Record<string, unknown>[];
  if (patches.length === 0) return data;

  const index = new Map<string, Record<string, unknown>>();
  const remember = (rows: readonly Record<string, unknown>[]): void => {
    for (const row of rows) {
      const id = row['id'];
      if (typeof id === 'string') index.set(id, row);
    }
  };
  remember(data);

  for (const patch of patches) {
    const { id, name, insert, ...overrides } = patch;

    if (insert !== undefined) {
      const inserted = structuredClone(insert) as Record<string, unknown>[];
      data.push(...inserted);
      remember(inserted);
      continue;
    }

    if (id === undefined) {
      warn('patch：不是 insert 的 patch 一定要有 id，這一條跳過。');
      continue;
    }

    const target = index.get(id);
    if (target === undefined) {
      warn(`patch：找不到 id 為 ${JSON.stringify(id)} 的條目，這一條跳過。`);
      continue;
    }

    if (name !== undefined && target['name'] !== name) {
      warn(
        `patch：id ${JSON.stringify(id)} 的 name 對不上` +
          `（清單上是 ${JSON.stringify(target['name'])}，patch 寫的是 ${JSON.stringify(name)}），這一條跳過。`,
      );
      continue;
    }

    for (const [key, value] of Object.entries(overrides)) {
      target[key] = value;
    }
  }

  return data;
}

/**
 * 疊完之後逐列驗形狀。
 *
 * @param rows - 疊完的清單。
 * @param label - 錯誤訊息裡怎麼稱呼這份清單。
 * @returns 驗過的條目。
 * @throws {PluginConfigError} 某一列不合 {@link entrySchema}，或兩列寫了同一個 id。
 */
export function validateEntries(
  rows: readonly Record<string, unknown>[],
  label: string,
): ConfigEntry[] {
  const entries = rows.map((row, position) => {
    const result = entrySchema.safeParse(row);
    if (!result.success) {
      throw new PluginConfigError(
        `${label} 疊完之後第 ${String(position + 1)} 列不是一個合法的條目 — ` +
          formatIssues(result.error),
      );
    }
    return result.data;
  });

  // **id 重複在這裡就擋。** `resolveEntries` 也會擋，但它的訊息講的是 `plugins[3]` 這種
  // 陣列位置——設定檔的使用者手上沒有那個陣列，他手上有的是一個 id 與兩個檔案。
  const seen = new Map<string, number>();
  for (const [position, entry] of entries.entries()) {
    if (entry.id === undefined) continue;
    const owner = seen.get(entry.id);
    if (owner !== undefined) {
      throw new PluginConfigError(
        `${label} 的第 ${String(owner + 1)} 列與第 ${String(position + 1)} 列都寫了 ` +
          `id ${JSON.stringify(entry.id)}。id 是「哪一次掛載」的答案，兩個人共用它，` +
          '之後每一則訊息都會同時指向兩個。',
      );
    }
    seen.set(entry.id, position);
  }
  return entries;
}

/**
 * 這個檔案只有目前使用者動得了。
 *
 * **判準照 dsh 的 `hasProtectedAncestors`**（`packages/spill/spill-local/src/cleanup.ts:86`）：
 * 一路走到根，任何祖先對群組或其他人可寫（`mode & 0o022`）就拒絕，**除非它帶 sticky 位**
 * （`/tmp` 底下的 per-process 目錄靠這一條才合法）；sticky 但下一層不是自己的，照樣拒絕。
 *
 * **這是比 dsh 嚴的一條，要登記**：dsh 把這個判準用在 spill root 上，**沒有**用在
 * `cordis.patch.yml` 上。我們用在 patch 檔上，因為這個部署是完全內網、多人共用主機
 * （[#387](https://github.com/DemianLi/nexus-agent/issues/387)），而 patch 檔停得掉核准。
 * 偏離的是「用在哪」，不是判準本身。
 *
 * **先 `realpath` 再檢查**：符號連結會讓「被檢查的路徑」與「真的被讀的檔」變成兩個，而
 * `readFileSync` 跟的是後者。dsh 的 `resolveRoot` 同樣解析成 canonical 路徑才信任它。
 *
 * 沒有 `geteuid` 的平台（Windows）直接放行——POSIX 的模式位在那邊沒有對應物，硬檢會變成
 * 一條看起來有在擋、其實在亂擋的規則。我們的部署是 Linux 與 macOS。
 *
 * @param path - 要檢查的檔案路徑。
 * @throws {PluginConfigError} 檔案或它的某個祖先別人動得了；訊息指名是哪一個。
 */
export function assertPrivateFile(path: string): void {
  /* v8 ignore next -- Windows 沒有 geteuid，POSIX 的測試走下面那條。 */
  if (process.geteuid === undefined) return;
  const uid = process.geteuid();
  const resolved = realpathSync(path);

  const stats = lstatSync(resolved);
  if (stats.uid !== uid) {
    throw new PluginConfigError(
      `${resolved} 不屬於目前的使用者（uid ${String(stats.uid)} ≠ ${String(uid)}），拒絕啟動。` +
        '這個檔案改得動 plugin 清單，包括把核准關掉。',
    );
  }
  if ((stats.mode & 0o022) !== 0) {
    throw new PluginConfigError(
      `${resolved} 群組或其他人可寫（mode ${formatMode(stats.mode)}），拒絕啟動。` +
        '這個檔案改得動 plugin 清單，包括把核准關掉。',
    );
  }

  let child = resolved;
  let childStats = stats;
  for (;;) {
    const parent = dirname(child);
    if (parent === child) return;
    const parentStats = lstatSync(parent);
    const writableByOthers = (parentStats.mode & 0o022) !== 0;
    const sticky = (parentStats.mode & 0o1000) !== 0;
    if (writableByOthers && !sticky) {
      throw new PluginConfigError(
        `${resolved} 的上層目錄 ${parent} 群組或其他人可寫（mode ${formatMode(parentStats.mode)}），` +
          '拒絕啟動——別人換得掉底下的檔案。',
      );
    }
    /* v8 ignore next 6 -- 要一個 sticky 目錄底下有別人擁有的祖先，測試造不出來。 */
    if (writableByOthers && childStats.uid !== uid) {
      throw new PluginConfigError(
        `${resolved} 的上層目錄 ${parent} 是 sticky 的，但 ${child} 不屬於目前的使用者，拒絕啟動。`,
      );
    }
    child = parent;
    childStats = parentStats;
  }
}

/**
 * 讀使用者那一層，**檔案不在就是沒有這一層**。
 *
 * 照 dsh 的 `loadOptionalPatches`（`packages/boot/app-boot/src/index.ts:289`）：`ENOENT` 回
 * `undefined`，其餘讀取失敗與解析失敗一律拋——一份在那裡卻套不上去的 patch 是設定錯了，
 * 不是「沒有這一層」。
 *
 * @param path - `$NEXUS_AGENT_HOME/cordis.patch.yml` 的絕對路徑。
 * @returns 這一層的 patch，檔案不存在時 `undefined`。
 * @throws {PluginConfigError} 檔案在但讀不了、形狀不合，或別人動得了。
 */
export function loadOptionalPatches(path: string): ConfigPatch[] | undefined {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined;
    throw new PluginConfigError(`讀不到 ${path}：${String(error)}`);
  }
  assertPrivateFile(path);
  return parsePatchList(source, path);
}

/**
 * 讀一個被指名的 overlay，**檔案不在就是設定錯了**。
 *
 * 照 dsh 的 `loadOverlayPatches`（`:309`）：是呼叫方指名這個檔的，它不在代表路徑寫錯或檔案
 * 沒放上去，安靜跳過會讓人以為 patch 生效了。
 *
 * @param path - `--patch` 給的路徑。
 * @returns 這一層的 patch。
 * @throws {PluginConfigError} 讀不到、形狀不合，或別人動得了。
 */
export function loadOverlayPatches(path: string): ConfigPatch[] {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    throw new PluginConfigError(`讀不到 --patch 指定的 ${path}：${String(error)}`);
  }
  assertPrivateFile(path);
  return parsePatchList(source, path);
}

/** 出貨那一份的絕對路徑。`apps/harness/src/` 往上一層就是 `apps/harness/`。 */
export function shippedConfigPath(): string {
  return new URL(`../${SHIPPED_CONFIG_FILENAME}`, import.meta.url).pathname;
}

/**
 * 把一列條目變成一個可以載入的 `PluginEntry`。
 *
 * **`module.default ?? module` 照 dsh 的 `unwrapExports`**（`vendor/loader/src/index.ts:189`）：
 * 先看 default，沒有才退回 namespace。dsh 的配套入口把 `name`／`apply` 散在頂層，namespace
 * 自己就是 plugin；我們的是巢狀常數，所以實際上走的是 default 那一條
 * （[#493](https://github.com/DemianLi/nexus-agent/pull/493) 讓二十個配套入口都有了 default
 * export）。兩種形狀都接得住，是因為退路本來就是標準的一部分。
 *
 * @param entry - 驗過的一列。
 * @returns 可以放進 `loadPlugins` 的條目。
 * @throws {PluginConfigError} 模組載不起來，或它匯出的東西不是一顆 plugin。
 */
export async function resolveEntryModule(entry: ConfigEntry): Promise<PluginEntry> {
  let module: Record<string, unknown>;
  try {
    module = (await import(entry.name)) as Record<string, unknown>;
  } catch (error) {
    throw new PluginConfigError(
      `條目 ${describeEntry(entry)} 載不起來：${String((error as Error).message)}`,
    );
  }
  const exported = (module['default'] ?? module) as unknown;
  if (!isPluginShaped(exported)) {
    throw new PluginConfigError(
      `條目 ${describeEntry(entry)} 的模組沒有匯出一顆 plugin——` +
        '要嘛 `export default` 那顆 `NexusPlugin`，要嘛把 `name` 與 `apply` 放在頂層。',
    );
  }
  return {
    plugin: exported,
    ...(entry.id === undefined ? {} : { id: entry.id }),
    ...(entry.disabled === undefined ? {} : { disabled: entry.disabled }),
    ...(entry.config === undefined ? {} : { config: entry.config }),
  };
}

/** 組裝一次要讀的東西。 */
export interface PluginConfigSources {
  /** 出貨那一份的路徑，省略即 {@link shippedConfigPath}。 */
  readonly shipped?: string;
  /** harness home 底下那一份的路徑，省略即不讀這一層。 */
  readonly userPatch?: string;
  /** `--patch` 指定的檔，照命令列順序。 */
  readonly overlays?: readonly string[];
  /** 跳過某條 patch 時往哪裡講，省略即 stderr。 */
  readonly warn?: PluginConfigWarn;
}

/**
 * 疊完三層，但**還沒 import 任何模組**。
 *
 * 分出這一層是為了 `--dump-config`（下一刀）：它要印的是疊完的設定，而印設定不該需要
 * 把每一顆 plugin 都載起來。dsh 的 dump 同樣走純函式那條路，理由一樣
 * （`.agents/notes/archived/feature/2026-07-30-dsh-dump-config.md`）。
 *
 * **所有層攤平成一次 {@link applyEntryPatches} 呼叫**，不是每層各呼叫一次——dsh 明寫分層
 * 各呼叫一次會在層與層之間重建索引，印出一棵啟動從來不會掛的樹。
 *
 * @param sources - 三層的來源。
 * @returns 疊完並驗過的條目清單。
 * @throws {PluginConfigError} 任何一層讀不了、形狀不合，或疊完之後有壞掉的列。
 */
export function composeEntries(sources: PluginConfigSources = {}): ConfigEntry[] {
  const shipped = sources.shipped ?? shippedConfigPath();
  let source: string;
  try {
    source = readFileSync(shipped, 'utf8');
  } catch (error) {
    throw new PluginConfigError(`讀不到出貨的 ${shipped}：${String(error)}`);
  }
  const rows = parseEntryList(source, shipped);

  const patches: ConfigPatch[] = [];
  if (sources.userPatch !== undefined) {
    patches.push(...(loadOptionalPatches(sources.userPatch) ?? []));
  }
  for (const overlay of sources.overlays ?? []) {
    patches.push(...loadOverlayPatches(overlay));
  }

  return validateEntries(applyEntryPatches(rows, patches, sources.warn), shipped);
}

/**
 * 組裝：疊完、驗完，再把每一列的模組 import 進來。
 *
 * @param sources - 三層的來源。
 * @returns 可以交給 `loadPlugins` 的清單。
 * @throws {PluginConfigError} 任何一步失敗。
 */
export async function loadPluginConfig(sources: PluginConfigSources = {}): Promise<PluginEntry[]> {
  const entries = composeEntries(sources);
  const loaded: PluginEntry[] = [];
  for (const entry of entries) loaded.push(await resolveEntryModule(entry));
  return loaded;
}

function isPluginShaped(value: unknown): value is PluginEntry['plugin'] {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { name?: unknown; apply?: unknown };
  return typeof candidate.name === 'string' && typeof candidate.apply === 'function';
}

function describeEntry(entry: ConfigEntry): string {
  return entry.id === undefined
    ? JSON.stringify(entry.name)
    : `${JSON.stringify(entry.id)}（${entry.name}）`;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  return Array.isArray(value) ? '一個陣列' : typeof value;
}

function formatMode(mode: number): string {
  return `0${(mode & 0o7777).toString(8)}`;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path === '' ? issue.message : `${path}：${issue.message}`;
    })
    .join('；');
}
