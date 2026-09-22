/**
 * 從 YAML 組裝 plugin 清單：出貨的預設 ＋ 使用者的 patch 層。
 *
 * **`cli.ts` 與 `serve.ts` 的清單只有這一個來源**
 * （[#454](https://github.com/DemianLi/nexus-agent/issues/454)）。兩個入口共用
 * {@link loadDefaultPlugins}，接線的實測在
 * [`plugin-config-wire.test.ts`](./plugin-config-wire.test.ts)。
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
 * ## 權限檢查只管使用者那兩層
 *
 * {@link assertPrivateFile} 跑在 home 那一層與 `--patch` 上，**不跑在出貨的 `cordis.yml`
 * 上**。這不是漏掉：信任邊界劃在安裝目錄上——`cordis.yml` 跟著 `apps/harness/` 一起來，
 * 別人動得了它就等於別人動得了整棵樹的原始碼，那時候檢查一個檔的模式位沒有任何意義。
 * 使用者那兩層不一樣：它們住在 home 底下，是安裝之後才出現、而且**預期會被編輯**的東西。
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
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { PluginEntry } from '@nexus/core';

import { resolveHarnessHome } from './harness-home.js';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
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
 * 關不掉的條目，以 `name` 為鍵。
 *
 * **鍵是 `name` 不是 `id`，而那是從 {@link applyEntryPatches} 的解構讀出來的**：
 * `const { id, name, insert, ...overrides } = patch` —— `id` 與 `name` 兩個都不在
 * `overrides` 裡，所以 patch 改不動它們（`name` 給了只是一句斷言，對不上就跳過整條）。
 * 兩個都釘得住，但 `name` 多守一條路：`insert` 進來的列一樣會走到
 * {@link validateEntries}，所以一列
 * `{ name: '@nexus/core/approval-gate', disabled: true }` 換個 id 插進來，以 `name` 為鍵
 * 擋得下，以 `id` 為鍵擋不下。今天那樣插一列不會有任何後果（閘門是
 * `foldApprovalGate` 無條件建的，不看清單），但鍵的選擇不應該靠「今天剛好沒有後果」。
 *
 * **為什麼要有這份名單**：一條指向不存在的 id 的 patch 是**警告不是失敗**
 * （見 {@link applyEntryPatches}），所以在 `approval-gate` 這一列存在之前，
 * `- id: approval-gate` ＋ `disabled: true` 的下場是一行 stderr、`exit 0`、而且
 * `--dump-config` 的輸出跟沒帶那份 patch 逐字相同——量過（2026-09-22）。核准其實照樣
 * 開著，但讀起來像成功關掉了。這個部署是完全內網、多人共用主機
 * （[#387](https://github.com/DemianLi/nexus-agent/issues/387)），那個誤會的代價由別人付。
 *
 * **名單裡只有核准閘門，而「圍堵不進來」是量過的結論不是疏漏。** 圍堵
 * （`@nexus/core` 的 `containment.ts`）**連 id 都不該有**：它是註冊表管線自己的 `catch`
 * （dsh `packages/core/tools/src/index.ts:1494`，`4e84901`），不是一顆掛不掛隨人的
 * plugin，而且把它從兩個插入點拿掉的突變量到 **126 條紅**。沒有條目，就沒有「關得掉」
 * 這個問題要擋。
 *
 * @see {@link assertNotProtected}
 */
export const PROTECTED_ENTRY_NAMES: ReadonlySet<string> = new Set(['@nexus/core/approval-gate']);

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
    return anchorInsertedNames(result.data, label);
  });
}

/**
 * 把 `insert` 條目裡的檔案路徑錨在 patch 檔旁邊。
 *
 * **這是一個修正，不是新功能。** 沒有它的話，`name: './probe.ts'` 會被
 * {@link resolveEntryModule} 的 `import()` 解析到 **`plugin-config.ts` 自己的位置**——因為裸
 * 的相對 specifier 錨在做 import 的那個模組上，不是使用者手上那個檔。實測的訊息是
 * `Cannot find module '…/apps/harness/src/probe.ts'`，而那底下剛好有同名檔的時候，它會
 * **安靜地載錯一顆**。
 *
 * 照 dsh 的 `anchorInsertedPluginNames`（`packages/boot/app-boot/src/index.ts:319`）：
 *
 * - 絕對路徑、以及相對 patch 檔的 `./` 與 `../`，轉成 file URL；
 * - **其餘原樣**——裸的套件名（`@nexus/plugin-echo`）要留給 Node 的解析器，轉成 URL 會讓
 *   它變成一個不存在的檔案路徑。
 * - **對既有條目的 `name` 斷言不動。** 那個欄位是拿來跟清單上的字串比的
 *   （{@link applyEntryPatches} 的 name mismatch 那一條），轉成 file URL 之後它永遠比不中，
 *   而失敗的樣子是「這條 patch 被靜靜跳過」——比載錯模組更難查。所以只動 `insert` 裡的。
 *
 * @param patch - 驗過的一條 patch。
 * @param file - 這條 patch 來自哪個檔，相對路徑錨在它旁邊。
 * @returns 同一條 patch，`insert` 裡的路徑換成 file URL。
 */
function anchorInsertedNames(patch: ConfigPatch, file: string): ConfigPatch {
  if (patch.insert === undefined) return patch;
  const base = dirname(resolve(file));
  return {
    ...patch,
    insert: patch.insert.map((row) => {
      const name = row['name'];
      if (typeof name !== 'string') return row;
      if (!isAbsolute(name) && !name.startsWith('./') && !name.startsWith('../')) return row;
      return { ...row, name: pathToFileURL(resolve(base, name)).href };
    }),
  };
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
    // **在這裡問，不是在迴圈後面。** 一份檔案同時寫壞了兩件事的時候，維運者要先看到的是
    // 關於核准的那一句，不是 id 撞號那一句。
    assertNotProtected(result.data, label, position);
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
 * 保護名單上的條目不准被 `disabled: true` 關掉——**當場拋，而且在載入期**。
 *
 * **這個檢查住在 {@link validateEntries} 裡，而那個位置是被量具逼出來的、不是偏好。**
 * {@link renderConfigDump} 在印之前自己跑一次 `validateEntries`（「印一棵啟動不起來的樹，
 * 讀的人會以為問題在別的地方」），{@link composeEntries} 走同一支。所以放在這裡的檢查，
 * `--dump-config` 與真的啟動**兩條路都擋得到**。
 *
 * 放到 import／`apply` 那一層就只擋得到真的啟動：`--dump-config` 會高高興興印出
 * `disabled: true`，替錯的信念背書——而 `cordis.yml` 的檔頭正是叫人用 `--dump-config`
 * 看「這台機器上實際長什麼樣」。那等於把這整件事要消滅的病往上搬一層。
 *
 * **`disabled: false` 與沒寫都放行**，只有明著寫 `true` 才拋：擋的是「關掉」這個動作，
 * 不是「提到這一列」。
 *
 * @param entry - 驗過形狀的那一列。
 * @param label - 錯誤訊息裡怎麼稱呼這份清單。
 * @param position - 它在疊完的清單裡的索引（從 0 數）。
 * @throws {PluginConfigError} 這一列在 {@link PROTECTED_ENTRY_NAMES} 上而且被關掉了。
 */
function assertNotProtected(entry: ConfigEntry, label: string, position: number): void {
  if (entry.disabled !== true) return;
  if (!PROTECTED_ENTRY_NAMES.has(entry.name)) return;
  throw new PluginConfigError(
    `${label} 疊完之後第 ${String(position + 1)} 列把 ${JSON.stringify(entry.name)} ` +
      '標成了 `disabled: true`，而這一列關不掉。' +
      '核准閘門不是一顆掛不掛隨人的 plugin：它由組裝時無條件建起來，' +
      '今天沒有任何設定關得掉它。這一行如果安靜地被跳過，讀的人會以為核准已經關了' +
      '——實際上照樣會問，而這台機器是多人共用的。' +
      '把這一列的 `disabled` 拿掉（或寫成 `false`）再啟動。',
  );
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
 * （[#387](https://github.com/DemianLi/nexus-agent/issues/387)），而一份 patch 檔**決定
 * 這個行程載入哪些模組**：`insert` 進來的列，它的 `name` 會被 `resolveEntryModule`
 * 直接 import，相對路徑還錨在 patch 檔自己旁邊。別人寫得動那個檔，就是別人替你決定跑
 * 什麼程式碼。偏離的是「用在哪」，不是判準本身。
 *
 * **這句理由改過一次，而改的是理由不是結論**（#456 第四刀）：原本寫的是「patch 檔停得掉
 * 核准」。那件事現在擋住了——`approval-gate` 那一列在 {@link PROTECTED_ENTRY_NAMES} 上，
 * `disabled: true` 當場拋。但這條檢查該留，射程反而比原本那句寬：patch 檔照樣改得動其餘
 * 每一列的 `config`、關得掉名單外的條目，還能插新模組進來。
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

/**
 * 出貨那一份的絕對路徑。`apps/harness/src/` 往上一層就是 `apps/harness/`。
 *
 * **`fileURLToPath` 而不是 `.pathname`**：`.pathname` 不做百分號解碼，安裝路徑裡只要有一個
 * 空白就會變成 `%20`，而 `readFileSync` 開不了那個字面路徑。本機的路徑剛好沒有這種字元，
 * 所以這一格測不出來——它是讀出來的，不是量出來的。
 */
export function shippedConfigPath(): string {
  return fileURLToPath(new URL(`../${SHIPPED_CONFIG_FILENAME}`, import.meta.url));
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
  const { shipped, rows, layers } = readLayers(sources);
  const patches = layers.flatMap((layer) => layer.patches);
  return validateEntries(applyEntryPatches(rows, patches, sources.warn), shipped);
}

/** 一層 patch 加上它在 dump 的來源註解裡叫什麼。 */
export interface ConfigLayer {
  /** 來源標籤，dump 的 `# ==` 註解印的就是這個。 */
  readonly label: string;
  readonly patches: readonly ConfigPatch[];
}

/**
 * 把三層讀進來，**還沒疊**。
 *
 * `composeEntries` 與 {@link renderConfigDump} 共用這一段，所以 dump 印出來的層與啟動真的
 * 疊的層是同一組——照 dsh，它的 dump 與 `boot()` 共用 `applyEntryPatches`，理由是
 * 「dump 不可能與實際啟動漂移，因為它復用掛載程式碼」
 * （`.agents/notes/archived/feature/2026-07-30-dsh-dump-config.zh.md`）。
 *
 * @param sources - 三層的來源。
 * @returns 出貨檔的路徑、它的每一列，以及帶標籤的各層。
 * @throws {PluginConfigError} 任何一層讀不了或形狀不合。
 */
function readLayers(sources: PluginConfigSources): {
  shipped: string;
  rows: Record<string, unknown>[];
  layers: ConfigLayer[];
} {
  const shipped = sources.shipped ?? shippedConfigPath();
  let source: string;
  try {
    source = readFileSync(shipped, 'utf8');
  } catch (error) {
    throw new PluginConfigError(`讀不到出貨的 ${shipped}：${String(error)}`);
  }
  const rows = parseEntryList(source, shipped);

  const layers: ConfigLayer[] = [];
  if (sources.userPatch !== undefined) {
    const patches = loadOptionalPatches(sources.userPatch);
    if (patches !== undefined) layers.push({ label: sources.userPatch, patches });
  }
  for (const overlay of sources.overlays ?? []) {
    layers.push({ label: overlay, patches: loadOverlayPatches(overlay) });
  }
  return { shipped, rows, layers };
}

/**
 * 把疊完的設定印成一份**讀得回來的** YAML。
 *
 * 逐條照 dsh 的 `renderConfigDump`（`packages/boot/app-boot/src/index.ts:403`）：
 *
 * - **所有層攤平成一次 {@link applyEntryPatches} 呼叫**，跟啟動的呼叫形狀完全一樣。分層各
 *   呼叫一次會在層與層之間重建 id 索引，印出一棵啟動從來不會掛的樹。
 * - **來源是從前綴快照按位置 diff 出來的**：疊完第 1..k 層之後某一列的 JSON 變了，就算第 k
 *   層修過它；索引超出前一份快照長度的，是第 k 層插進來的。patch 演算法只會原地改寫或在
 *   尾巴追加，所以頂層索引在各快照之間指的是同一列。
 * - **每一段來源相同的連續列前面加一行 `# ==` 註解**，所以輸出既看得出哪一段來自哪個檔，
 *   又仍然是一份合法的 YAML 文件。
 * - **沒命中任何列的 patch 帶著層標籤報出去**，與啟動時的警告一致。早先那幾層在每一份含
 *   有它們的快照裡看到的前置狀態都一樣，所以每份快照的警告清單是前一份的延長，新增的尾巴
 *   屬於剛加進來的那一層。
 *
 * **不做黃金檔比對。** dsh 自己的開發備註寫著這份輸出「不承諾跨包版本的位元組穩定性；在
 * 程式化消費它之前，請先決定 dump 要不要成為序列化約定」——照抄一個它自己說不穩定的東西
 * 當測試判準，是把別人的免責聲明變成我們的絆索。測試驗的是結構性質。
 *
 * @param sources - 三層的來源。
 * @returns 一份 YAML 文件，帶來源註解。
 * @throws {PluginConfigError} 任何一層讀不了、形狀不合，或疊完之後有壞掉的列。
 */
export function renderConfigDump(sources: PluginConfigSources = {}): string {
  const { shipped, rows, layers } = readLayers(sources);
  const warn = sources.warn ?? warnToStderr;

  // **每份快照都自己 clone 一份 patch**：`applyEntryPatches` 會把 `insert` 的列放進結果，
  // 共用同一批 patch 物件會讓後一份快照的改動漏進前一份的結果裡。dsh 同一條理由。
  const snapshot = (count: number, warnings: string[]): Record<string, unknown>[] =>
    applyEntryPatches(
      rows,
      structuredClone(layers.slice(0, count).flatMap((layer) => [...layer.patches])),
      (message) => warnings.push(message),
    );

  const origins = rows.map(() => ({ origin: shipped, patchedBy: [] as string[] }));
  let previous: Record<string, unknown>[] = rows;
  let previousWarnings: string[] = [];
  let composed: Record<string, unknown>[] = rows;

  for (const [index, layer] of layers.entries()) {
    const warnings: string[] = [];
    composed = snapshot(index + 1, warnings);
    for (const line of warnings.slice(previousWarnings.length)) warn(`[${layer.label}] ${line}`);

    const before = previous.map((row) => JSON.stringify(row));
    for (const [position, row] of composed.entries()) {
      if (position >= before.length) origins.push({ origin: layer.label, patchedBy: [] });
      else if (JSON.stringify(row) !== before[position])
        origins[position]?.patchedBy.push(layer.label);
    }
    previous = composed;
    previousWarnings = warnings;
  }

  // 疊完先驗過才印：印一棵啟動不起來的樹，讀的人會以為問題在別的地方。
  validateEntries(composed, shipped);
  return groupedDump(composed, origins);
}

/** 每一段來源相同的連續列，前面加一行 `# ==`。 */
function groupedDump(
  composed: readonly Record<string, unknown>[],
  origins: readonly { origin: string; patchedBy: string[] }[],
): string {
  const lines: string[] = [];
  let current: string | undefined;
  let group: Record<string, unknown>[] = [];
  const flush = (): void => {
    if (current === undefined || group.length === 0) return;
    lines.push(`# == ${current}`);
    lines.push(stringifyYaml(group).trimEnd());
    group = [];
  };
  for (const [index, row] of composed.entries()) {
    const record = origins[index];
    if (record === undefined) continue;
    const label =
      record.patchedBy.length === 0
        ? record.origin
        : `${record.origin}, patched by ${record.patchedBy.join(', ')}`;
    if (label !== current) {
      flush();
      current = label;
    }
    group.push(row);
  }
  flush();
  return `${lines.join('\n')}\n`;
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

/**
 * 產品路徑上那一次組裝：出貨預設 ＋ harness home 那一層 ＋ `--patch`。
 *
 * **`cli.ts` 與 `serve.ts` 共用這一個**，理由同 `parseSandboxMode`：兩份各寫一次的下場是
 * 有一天只有一邊讀得到 home 那一層，而那種缺陷在畫面上看不出來——少疊一層只是「我的設定
 * 沒有生效」，不會有任何東西變紅。
 *
 * @param options - `env` 決定 harness home 落在哪（省略即 `process.env`）；`patches` 是
 *   `--patch` 給的那幾個檔，照命令列順序；`warn` 省略即 stderr。
 * @returns 可以交給 `createNexusAgent` 的清單。
 * @throws {PluginConfigError} 任何一層讀不了、形狀不合、別人動得了，或模組載不起來。
 */
export async function loadDefaultPlugins(
  options: DefaultConfigOptions = {},
): Promise<PluginEntry[]> {
  return loadPluginConfig(defaultSources(options));
}

/** {@link loadDefaultPlugins} 與 {@link renderDefaultConfigDump} 共用的那幾格。 */
export interface DefaultConfigOptions {
  /** 決定 harness home 落在哪，省略即 `process.env`。 */
  readonly env?: NodeJS.ProcessEnv;
  /** `--patch` 給的那幾個檔，照命令列順序。 */
  readonly patches?: readonly string[];
  /** 跳過某條 patch 時往哪裡講，省略即 stderr。 */
  readonly warn?: PluginConfigWarn;
}

/**
 * 產品路徑上那三層的來源。
 *
 * **`--dump-config` 與啟動共用這一個**，所以 dump 印的層與啟動疊的層是同一組。各自算一次
 * 的下場是有一天 dump 說「你的 home patch 沒生效」而它其實生效了——那比沒有 dump 更糟。
 *
 * @param options - env、`--patch`、警告出口。
 * @returns 三層的來源。
 */
function defaultSources(options: DefaultConfigOptions): PluginConfigSources {
  const home = resolveHarnessHome(options.env ?? process.env);
  return {
    userPatch: join(home, USER_PATCH_FILENAME),
    ...(options.patches !== undefined && { overlays: options.patches }),
    ...(options.warn !== undefined && { warn: options.warn }),
  };
}

/**
 * 產品路徑上那三層疊完的樣子，印成 YAML。
 *
 * @param options - 與 {@link loadDefaultPlugins} 同一組。
 * @returns 一份帶來源註解的 YAML 文件。
 * @throws {PluginConfigError} 任何一層讀不了、形狀不合，或疊完之後有壞掉的列。
 */
export function renderDefaultConfigDump(options: DefaultConfigOptions = {}): string {
  return renderConfigDump(defaultSources(options));
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
