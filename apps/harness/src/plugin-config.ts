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
 * 出貨預設 → **變更紀錄折出來的那一層**（`$NEXUS_AGENT_HOME/plugin-journal.jsonl`，#1412，見 {@link readJournalLayer}）→ 任意個
 * `--patch`，照命令列順序。**不從目前目錄讀**——那一份會跟著 clone 一起到來，而它能停用核准。
 *
 * **home 的 `cordis.patch.yml` 不再是一層**（#1412，demian 2026-10-13 Q2）：第一次啟動時遷進變更紀錄（{@link prepareJournal}），
 * 之後出現這個檔只警告、不讀。`--patch` 是部署端在命令列給的，照 dsh 的覆蓋層留著。照 dsh 的層序
 * （`packages/boot/app-boot/src/profile-context.ts:63-75`：各層 → profile 的 patch → home 的 patch → overlays）：
 * 後台只寫 profile 那一層，我們把它與 home 那層併成一份稽核過的紀錄。
 *
 * ## 權限檢查只管使用者那兩層
 *
 * {@link assertPrivateFile} 跑在 home 那一層與 `--patch` 上，以及它們 `insert` 進來、指到檔案的
 * 模組上（{@link resolveEntryModule}，#542），**不跑在出貨的 `cordis.yml` 上**。這不是漏掉：信任邊界劃在安裝目錄上——`cordis.yml` 跟著 `apps/harness/` 一起來，
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

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { StructuredTool, StructuredToolInterface } from '@langchain/core/tools';
import { CHANNEL_SERVICE, NEXUS_CORE_VERSION, resolveEntriesPerEntry } from '@nexus/core';
import type {
  CommandDefinition,
  NexusPlugin,
  PluginEntry,
  ProjectionUnit,
  RegisterOptions,
} from '@nexus/core';
import { ManifestError, validateManifest } from '@nexus/sdk';
import type { ToolGateListener, ToolRegisterOptions } from '@nexus/tools';

import { resolveHarnessHome } from './harness-home.js';
import { registryFsLookup } from './registry-fs-lookup.js';
import { assertPluginCompatible, PluginCompatibilityError } from './plugin-compatibility.js';
import {
  createJournalFile,
  foldJournal,
  isAcceptedRecord,
  PLUGIN_JOURNAL_FILE_NAME,
  PLUGIN_JOURNAL_VERSION,
  PluginJournalError,
  readJournal,
  withFileLock,
} from './plugin-journal.js';
import type { JournalActor, JournalBody, JournalRecord } from './plugin-journal.js';
import { findJsExpr, isFunctionPluginModule, mountDetached } from './plugin-tree.js';
import type {
  FunctionPluginModule,
  HostService,
  PluginTree,
  TreeInput,
  TreeRowInput,
  TreeSnapshot,
} from './plugin-tree.js';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';

/** 出貨的預設清單，放在 `apps/harness/` 底下。 */
export const SHIPPED_CONFIG_FILENAME = 'cordis.yml';

/**
 * serve 專屬的出貨層（[#669](https://github.com/DemianLi/nexus-agent/issues/669) 第 4 步）。疊在 {@link SHIPPED_CONFIG_FILENAME}
 * 之後、使用者的 patch 之前，**只有 serve 載**（`DefaultConfigOptions.serve`）；CLI 不載，`--dump-config` 也跟著入口走。
 *
 * 照 dsh：web-app bundle 疊在 base 上（`packages/bundle/web-app/cordis.patch.yml`，`477b4f4`）。**登記：我們沒有 profile／組合包
 * （#46 Out of scope），所以退到最接近的一個檔**——出貨層有兩個檔而不是 dsh 的 preset 機制；層與層之間不能互相覆寫或刪列，
 * 只能追加列（patch 才能改列），所以它不是 profile 層，不會長成 #46 排除的東西。
 */
export const SERVE_SHIPPED_CONFIG_FILENAME = 'cordis.serve.yml';

/**
 * 舊的使用者那一層的檔名，放在 harness home 底下。**#1412 之後它不再是一層**：第一次啟動時遷進變更紀錄
 * （{@link prepareJournal}），之後有這個檔只警告、不讀。
 */
export const USER_PATCH_FILENAME = 'cordis.patch.yml';

/** 這個模組所有的失敗都是這個型別。訊息一律指得出是哪個檔、哪一列。 */
export class PluginConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginConfigError';
  }
}

/**
 * 指到檔案的那一列，它的模組檔別人動得了（或檢查不了）。
 *
 * **分成子類別是為了讓 {@link loadPluginConfig} 分得出兩種「那一列載不起來」**
 * （[#751](https://github.com/DemianLi/nexus-agent/issues/751)）：模組真的載不進來，那一列掉了、其餘照樣起來；
 * 權限被拒照舊整個起不來——理由跟 patch 檔那條是同一則偏離登記（見 {@link assertPrivateFile}），別人寫得動那個檔，
 * 就是別人替你決定跑什麼程式碼，不能降成「少掛一列」。{@link resolveEntryModule} 本身兩種都照舊拋。
 */
export class PluginModuleAccessError extends PluginConfigError {
  constructor(message: string) {
    super(message);
    this.name = 'PluginModuleAccessError';
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
 * **名單上另外六列是只講設定的條目**——六列 `#settings/*`
 * （[#529](https://github.com/DemianLi/nexus-agent/issues/529)）。理由跟核准閘門同形但不同源：
 * 它們**不裝任何東西**，所以「關掉」對它們沒有意義。名單擋的正是那個誤會。
 *
 * **`@nexus/core/session-persistence` 曾經在名單上，現在不在，這是刻意的**
 * （[#612](https://github.com/DemianLi/nexus-agent/issues/612)）。它從前只講批次窗口，關掉只會
 * 回到預設；#444 讓落盤預設開著之後，它改成**代表落盤本身**，照 dsh 的
 * `session-persistence-jsonl` 那一列：關掉就是兩個入口都只在記憶體裡，一個位元組都不寫。
 *
 * **理由跟名字綁在同一張表上，不共用一段文字。** 從前這裡是一個 `Set`、訊息只有一段，而那段
 * 逐字在講核准閘門——名單長出第二種列之後，關掉 `#settings/thread-title` 的人會拿到一整段關於核准
 * 與多人共用主機的說明，那對他那一列完全是錯的（實測）。改成表之後，**加一列就必須寫它自己的
 * 理由**，漏寫是 typecheck 紅，不是一段安靜的錯話。
 *
 * @see {@link assertNotProtected}
 */
export const PROTECTED_ENTRY_REASONS: ReadonlyMap<string, string> = new Map([
  [
    '@nexus/core/approval-gate',
    '核准閘門不是一顆掛不掛隨人的 plugin：它由組裝時無條件建起來，' +
      '今天沒有任何設定關得掉它。這一行如果安靜地被跳過，讀的人會以為核准已經關了' +
      '——實際上照樣會問，而這台機器是多人共用的。',
  ],
  [
    '#settings/thread-title',
    '這一列不裝任何東西，只講執行緒列表上標題的兩個上限。關掉它不會讓標題不再被裁切' +
      '——裁切由讀清單那一側無條件做——只會讓這份設定讀起來像關掉了什麼。',
  ],
  [
    '#settings/browser-session',
    '這一列不裝任何東西，只講瀏覽器 cookie 的絕對有效期。關掉它不會讓 cookie 不再過期' +
      '——過期由 `BrowserAuth` 無條件做——只會讓這份設定讀起來像關掉了什麼。',
  ],
  [
    '#settings/deliverable-files',
    '這一列不裝任何東西，只講交付檔的三個上限（一頁的位元組、整檔的位元組、一頁的行數）。' +
      '關掉它不會讓交付檔不再有上限——`startupSetting` 把關掉的那一列當成沒有那一列，' +
      '三個值於是回到 schema 的預設，行為一個位元組都不變，只會讓這份設定讀起來像關掉了什麼。',
  ],
  [
    '#settings/tool-text',
    '這一列不裝任何東西，只講工具結果 meta 與壓縮摘要放上線的位元組上限。關掉它不會讓它們不再被截' +
      '——`startupSetting` 把關掉的那一列當成沒有那一列，上限於是回到 schema 的預設，' +
      '送出去的位元組一個都不變，只會讓這份設定讀起來像關掉了什麼。',
  ],
  [
    '#settings/projection-flush',
    '這一列不裝任何東西，只講插件投影 frame 的合併視窗毫秒數。關掉它不會讓合併停下來' +
      '——`startupSetting` 把關掉的那一列當成沒有那一列，視窗於是回到 schema 的預設 100，' +
      '合併照樣在，只會讓這份設定讀起來像把合併關了。',
  ],
  [
    '#settings/tool-result-stash',
    '這一列不裝任何東西，只講過大工具結果暫存的根目錄與保留天數。關掉它不會讓工具結果不再暫存' +
      '——`startupSetting` 把關掉的那一列當成沒有那一列，值於是回到 schema 的預設，' +
      '暫存照樣寫在同一個位置，只會讓這份設定讀起來像關掉了什麼。',
  ],
  [
    '#settings/live-model',
    '這一列不裝任何東西，只講真實供應商的五個連線值（端點、模型 id、輸出上限、逾時、重試次數）。' +
      '關掉它不會讓 `--live` 不再有這些值——`startupSetting` 把關掉的那一列當成沒有那一列，' +
      '五個值於是回到 schema 的預設，連的還是同一個端點、同一顆模型，只會讓這份設定讀起來像關掉了什麼。',
  ],
  [
    '#settings/default-model',
    '這一列不裝任何東西，只講沒帶 `--live` 時用哪個模型提供者。關掉它不會讓模型沒有來源' +
      '——`startupSetting` 把關掉的那一列當成沒有那一列，`provider` 於是回到預設的 `cli-script`（出貨清單上的腳本提供者），' +
      '要用的提供者換不過去，只會讓這份設定讀起來像關掉了什麼。要換提供者是改它的 `provider`。',
  ],
  [
    '#settings/recursion-limit',
    '這一列不裝任何東西，只講 agent 迴圈的 super-step 上限。關掉它確實會讓那個服務消失，' +
      '但組裝點接著就落回內建的 100——**護欄還在**，關掉的只是「這台機器上它是多少」這句話。' +
      '讀起來卻像把迴圈上限解除了，而基座自己那層是一萬。',
  ],
  [
    '#settings/agent-loop',
    '這一列不裝任何東西，只講每步同時在跑的工具呼叫上限。關掉它確實會讓那個服務消失，' +
      '但組裝點接著就落回內建的 10——**上限還在**，關掉的只是「這台機器上它是多少」這句話。' +
      '讀起來卻像把平行上限解除了，而基座自己那層是不限。',
  ],
]);

/**
 * 關不掉的那幾列。見 {@link PROTECTED_ENTRY_REASONS}——**這份名單從那張表導出**，所以兩者不會漂移。
 */
export const PROTECTED_ENTRY_NAMES: ReadonlySet<string> = new Set(PROTECTED_ENTRY_REASONS.keys());

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
  const reason = PROTECTED_ENTRY_REASONS.get(entry.name);
  if (reason === undefined) return;
  throw new PluginConfigError(
    `${label} 疊完之後第 ${String(position + 1)} 列把 ${JSON.stringify(entry.name)} ` +
      '標成了 `disabled: true`，而這一列關不掉。' +
      reason +
      '把這一列的 `disabled` 拿掉（或寫成 `false`）再啟動。',
  );
}

/**
 * {@link assertPrivateFile} 在檢查哪一種檔：錯誤訊息要講得出是哪一個被拒、為什麼要緊。
 */
export interface PrivateFileRole {
  /** 訊息開頭怎麼稱呼它。 */
  readonly subject: string;
  /** 它被別人改掉的後果，接在「拒絕啟動。」之後。 */
  readonly why: string;
}

/** patch 檔：它決定這個行程載入哪些模組。 */
export const PATCH_FILE_ROLE: PrivateFileRole = {
  subject: 'patch 檔',
  why: '這個檔案改得動 plugin 清單，包括把核准關掉。',
};

/** 變更紀錄（#1412）：它折出來的 patch 決定載入哪些模組，跟舊的 patch 檔同一條理由。 */
export const JOURNAL_FILE_ROLE: PrivateFileRole = {
  subject: '變更紀錄',
  why: '它折出來的 patch 改得動 plugin 清單，包括 insert 新模組進來。',
};

/** `insert` 進來、指到檔案的模組（[#542](https://github.com/DemianLi/nexus-agent/issues/542)）。 */
export const PLUGIN_MODULE_ROLE: PrivateFileRole = {
  subject: 'plugin 模組',
  why: '這個模組會以你的身分在 harness 行程裡執行，比核准閘門、沙箱、圍堵都早。',
};

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
 * **同一條理由也蓋住被 import 的那個模組檔**（[#542](https://github.com/DemianLi/nexus-agent/issues/542)），
 * 所以 {@link resolveEntryModule} 對指到檔案的條目也跑這一條——射程往前推一跳，登記不變。dsh 在這條路上
 * 什麼都不檢查（`packages/boot/app-boot/src/index.ts:519` 的 `Include.import` 只做 specifier 解析）。
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
 * @param role - 它是哪一種檔，只影響錯誤訊息。
 * @throws {PluginConfigError} 檔案或它的某個祖先別人動得了；訊息指名是哪一個。
 */
export function assertPrivateFile(path: string, role: PrivateFileRole = PATCH_FILE_ROLE): void {
  /* v8 ignore next -- Windows 沒有 geteuid，POSIX 的測試走下面那條。 */
  if (process.geteuid === undefined) return;
  const uid = process.geteuid();
  const resolved = realpathSync(path);

  const stats = lstatSync(resolved);
  if (stats.uid !== uid) {
    throw new PluginConfigError(
      `${role.subject} ${resolved} 不屬於目前的使用者（uid ${String(stats.uid)} ≠ ${String(uid)}），` +
        `拒絕啟動。${role.why}`,
    );
  }
  if ((stats.mode & 0o022) !== 0) {
    throw new PluginConfigError(
      `${role.subject} ${resolved} 群組或其他人可寫（mode ${formatMode(stats.mode)}），拒絕啟動。` +
        role.why,
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
        `${role.subject} ${resolved} 的上層目錄 ${parent} 群組或其他人可寫` +
          `（mode ${formatMode(parentStats.mode)}），拒絕啟動——別人換得掉底下的檔案。${role.why}`,
      );
    }
    /* v8 ignore next 6 -- 要一個 sticky 目錄底下有別人擁有的祖先，測試造不出來。 */
    if (writableByOthers && childStats.uid !== uid) {
      throw new PluginConfigError(
        `${role.subject} ${resolved} 的上層目錄 ${parent} 是 sticky 的，但 ${child} 不屬於目前的` +
          `使用者，拒絕啟動。${role.why}`,
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

/** serve 專屬出貨層的絕對路徑，見 {@link SERVE_SHIPPED_CONFIG_FILENAME}。 */
export function serveShippedConfigPath(): string {
  return fileURLToPath(new URL(`../${SERVE_SHIPPED_CONFIG_FILENAME}`, import.meta.url));
}

/**
 * 把一列條目變成一個可以載入的 `PluginEntry`。
 *
 * **`module.default ?? module` 照 dsh 的 `unwrapExports`**（`vendor/loader/src/index.ts:189`）：
 * 先看 default，沒有才退回 namespace。dsh 的配套入口把 `name`／`apply` 散在頂層，namespace
 * 自己就是 plugin；我們的是巢狀常數，所以實際上走的是 default 那一條
 * （[#493](https://github.com/DemianLi/nexus-agent/pull/493) 讓當時的二十個配套入口都有了 default
 * export；#974 之後剩八個）。兩種形狀都接得住，是因為退路本來就是標準的一部分。
 *
 * **指到檔案的條目，import 之前先過 {@link assertPrivateFile}**（[#542](https://github.com/DemianLi/nexus-agent/issues/542)）。
 * 判別式是 `file:` 開頭：出貨清單的 `name` 全是裸 specifier，patch 裡只有 `insert` 生得出新 `name`，而
 * {@link anchorInsertedNames} 把 `./`、`../`、絕對路徑都轉成了 `file:`；直接寫 `file:///…` 的原樣也是。
 * 裸 specifier（`@nexus/*`、`#settings/*`、`node_modules`）不在射程內，理由同出貨的 `cordis.yml`：它們錨在
 * 安裝樹上，別人動得了那裡就等於動得了整棵樹的原始碼。
 *
 * **射程只到那一個檔**：模組自己再 import 的旁邊檔案不逐一檢查。祖先鏈擋得住別人換掉那個目錄裡的檔，擋不住
 * 旁邊一個 `0664` 的檔被改內容；要逐檔檢查得掛 loader hook，那是另一張卡的事。所以放 plugin 的目錄要整個
 * 私有（`docs/operations.md`）。
 *
 * @param entry - 驗過的一列。
 * @returns 可以放進 `loadPlugins` 的條目。
 * @throws {PluginConfigError} 模組檔別人動得了、模組載不起來，或它匯出的東西不是一顆 plugin。
 */
export async function resolveEntryModule(entry: ConfigEntry): Promise<PluginEntry> {
  if (entry.name.startsWith('file:')) {
    assertPrivateModule(entry);
    // **import 之前**判：不相容的模組主體一行都沒跑（#1137）。掉的只有這一列，訊息指名 `套件@版本`、範圍與執行中的版本。
    try {
      assertPluginCompatible(fileURLToPath(entry.name), NEXUS_CORE_VERSION);
    } catch (error) {
      if (!(error instanceof PluginCompatibilityError)) throw error;
      throw new PluginConfigError(`條目 ${describeEntry(entry)} 不相容：${error.message}`);
    }
  }
  let module: Record<string, unknown>;
  try {
    module = (await import(entry.name)) as Record<string, unknown>;
  } catch (error) {
    throw new PluginConfigError(
      `條目 ${describeEntry(entry)} 載不起來：${String((error as Error).message)}`,
    );
  }
  // **判別式只有一個**（`plugin-tree.ts` 的 `isFunctionPluginModule`）：有 `manifest` 具名匯出就是樹上的函式插件，
  // 不是 `NexusPlugin`，不看 default。Include 的允許名單從走這條路的列算出來，兩邊用同一支所以不會漂移。
  if (isFunctionPluginModule(module)) return bridgeEntry(entry, module);
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

/** 橋接外殼上掛的記號：這顆 `NexusPlugin` 是樹上某顆函式插件在相容層的代表。 */
const BRIDGE = Symbol.for('nexus.plugin-bridge');

interface BridgeMeta {
  /** 函式插件的命名空間。 */
  readonly module: FunctionPluginModule;
}

type BridgePlugin = NexusPlugin<unknown> & { readonly [BRIDGE]: BridgeMeta };

function bridgeOf(plugin: PluginEntry['plugin']): BridgeMeta | undefined {
  return (plugin as Partial<BridgePlugin>)[BRIDGE];
}

/**
 * 這一列是不是樹上的函式插件在相容層的橋接列（#1416 PR 2）。
 *
 * 橋接列跟 `NexusPlugin` 長一樣、佔同一個 id 與位置，`Config` 是 manifest 的 `config`，所以**設定驗證、停用、id 補號、
 * 快照、會話 header 都照舊走相容層那條路**。它的 `apply` 自己不掛任何東西——真正的 `apply` 在樹上跑了一次；這裡只把
 * **登記者就是這一列**的工具折進這一條 thread 的 registry，排在它在清單上的位置（工具順序不變）。
 *
 * **過渡性質**：卡上寫「拿掉」，這裡留著，是因為清單上其餘的列還是 `NexusPlugin`，它們跟 echo 要排在同一份清單、同一個
 * 順序裡（PM 決議 Q-A）。最後一顆搬出相容層時橋接連同整個相容層一起拿掉。
 */
export function isBridgeEntry(entry: PluginEntry): boolean {
  return bridgeOf(entry.plugin) !== undefined;
}

function bridgeEntry(entry: ConfigEntry, module: FunctionPluginModule): PluginEntry {
  const row = describeEntry(entry);
  let manifest;
  try {
    manifest = validateManifest(module.manifest, entry.id ?? entry.name);
  } catch (error) {
    if (!(error instanceof ManifestError)) throw error;
    throw new PluginConfigError(`條目 ${row} 的 manifest 不合格：${error.message}`);
  }
  if (typeof module.apply !== 'function') {
    throw new PluginConfigError(`條目 ${row} 是函式插件（有 manifest）卻沒有具名匯出 apply`);
  }
  const plugin: BridgePlugin = {
    name: typeof module.name === 'string' && module.name !== '' ? module.name : manifest.id,
    Config: manifest.config,
    apply() {
      throw new Error(
        `橋接列 ${row} 還沒綁定到樹：只有 loadPluginConfig 交出來的清單上的條目能組裝`,
      );
    },
    [BRIDGE]: { module },
  };
  return {
    plugin,
    ...(entry.id === undefined ? {} : { id: entry.id }),
    ...(entry.disabled === undefined ? {} : { disabled: entry.disabled }),
    ...(entry.config === undefined ? {} : { config: entry.config }),
  };
}

/**
 * 一列在樹上登記的東西，**每一種接縫一格**（#1421）。加一個新接縫要在這裡多一格，然後在 {@link registerFolded} 折進
 * 這條 thread 的 registry；`plugin-tree.ts` 的 `RowVerdict.active` 與 `mountDetached` 是兩個產生它的地方。
 */
interface FoldedContributions {
  readonly tools: readonly StructuredToolInterface[];
  /** 帶了註冊選項的工具與選項（#1458 Q3）：`rootOnly`、`outputSchema`，折進 thread 時原樣交給註冊點。 */
  readonly toolOptions: ReadonlyMap<StructuredToolInterface, ToolRegisterOptions>;
  /** 核准閘門監聽（#1466），照那一列登記的順序；折進 thread 時一條一條交給 `registry.approvals.gate`。 */
  readonly gates: readonly ToolGateListener[];
  readonly projections: readonly ProjectionUnit[];
  /** 技能來源路徑（#1446），照那一列登記的順序。 */
  readonly skillSources: readonly string[];
  /** 命令定義（#1456），照那一列登記的順序。 */
  readonly commands: readonly CommandDefinition[];
  /** 這一列提供、宿主取到的服務（#1456）。 */
  readonly services: readonly HostService[];
}

/**
 * 把樹上登記的東西折進這條 thread 的 registry。
 *
 * - 登記進相容層 registry 的工具是 `StructuredTool` 類別；契約上的 `StructuredToolInterface` 在執行期就是它（`tool()` 的
 *   回傳）。
 * - 投影單元走 `registry.projections.register`：這一層每個 key 只收一份、重複拒絕照舊（`NamedEntries`）。共用的 key 由
 *   `plugin-tree.ts` 只交給其中一列，所以這裡不會撞自己。
 */
function registerFolded(
  registry: Parameters<NexusPlugin<unknown>['apply']>[0],
  contributions: FoldedContributions,
): void {
  // 工具連同它登記時帶的選項（`rootOnly`、`outputSchema`，#1458 Q3）一起折：宿主不認得選項的語意，原樣轉交註冊點，由它
  // 與 fold 照舊處理（子代理那份換成拒絕樁、成功輸出過校驗器）。`outputSchema` 在定義套件裡是「有 `safeParse` 的東西」，
  // 註冊點要的是 zod 型別——執行期是同一個物件。
  for (const tool of contributions.tools) {
    const options = contributions.toolOptions.get(tool);
    registry.tools.register(
      tool as StructuredTool,
      options === undefined ? undefined : (options as RegisterOptions),
    );
  }
  // 核准閘門（#1466）：**走 `registry.approvals.gate`，來源就是這一列的橋接插件**——`approval-gate-order.test.ts` 的層一仍是
  // `submit-record (submit-record)`。監聽的形狀是結構型別（`@nexus/tools` 不 import core），與 core 的 `PreToolListener` 同形。
  // 排在工具之後、投影之前：與相容層那一列「`apply` 裡先 `tools.register` 再 `approvals.gate`」同一個順序。
  for (const listener of contributions.gates) registry.approvals.gate(listener);
  for (const unit of contributions.projections) registry.projections.register(unit);
  // 技能來源走 `registry.skills.addSource`，**照那一列登記的順序**：`sources` 依序即優先序（後面的來源贏過前面的同名 skill）。
  // 格式與重名在樹上的提供者登記時就驗過了，這一層的 `NamedEntries` 只是第二道（相容層的列也走它）。
  for (const path of contributions.skillSources) registry.skills.addSource(path);
  // 命令走 `registry.commands.register`（照登記順序；名字格式與重名在樹上的提供者登記時就驗過了，這一層的 `NamedEntries` 是
  // 第二道，相容層的列也走它——樹上的命令跟相容層的命令撞名要到這裡才掉，#1456 已知的縫）。
  for (const definition of contributions.commands) registry.commands.register(definition);
  // 服務走 `registry.services.provide`：同名只收一份，重名當場拋（相容層也提供同名服務時在這裡掉）。
  for (const { name, value } of contributions.services) registry.services.provide(name, value);
}

/** 樹上這一列起來了：折進它登記的工具與投影單元。 */
function bindToTree(entry: PluginEntry, contributions: FoldedContributions): PluginEntry {
  const plugin: BridgePlugin = {
    ...(entry.plugin as BridgePlugin),
    apply(registry) {
      registerFolded(registry, contributions);
    },
  };
  return { ...entry, plugin };
}

/** 沒有樹的呼叫端（手搭清單的測試、基準任務）：組裝時單獨掛一次、取工具、立刻卸載。 */
function bindDetached(entry: PluginEntry, id: string): PluginEntry {
  const meta = bridgeOf(entry.plugin);
  if (meta === undefined) return entry;
  const plugin: BridgePlugin = {
    ...(entry.plugin as BridgePlugin),
    async apply(registry) {
      // 答題管道：從組裝的 registry 讀 `channel` 服務（組裝根提供，#1458 Q1 (c) 的第三個進入點）。讀不到就是「沒有指定」，
      // 照今天的語意不提供。**每次單獨掛上各讀各的**：同一個行程裡兩份無樹組裝（一份 headless、一份有人在）各有各的值。
      const channel = registry.services.get(CHANNEL_SERVICE);
      registerFolded(
        registry,
        await mountDetached({
          id,
          module: meta.module,
          config: entry.config,
          ...(channel === undefined ? {} : { channel }),
          // 會話查找（#1463）：**這一次組裝自己的 `registry.sessions`**，只看那一份。查找在呼叫當下才問、不在掛載當下
          // 快取，所以之後 `attachSession` 才綁上來的註冊表也看得到；同一個行程裡兩份無樹組裝各問各的、互不相見。
          sessionLookup: (config) => registry.sessions.forCall(config),
          // fs 查找（#1466）：**這一次組裝自己的 host-services `fs` 服務**——就是這次組裝 fold 填值的那一格，不是另建的 backend。
          // 在呼叫當下才讀；無樹的組裝一份註冊表就一個 backend，所以不必依 thread 挑（見 `registry-fs-lookup.ts`）。
          fsLookup: registryFsLookup(registry),
        }),
      );
    },
  };
  return { ...entry, plugin };
}

/**
 * 指到檔案的那一列，它的模組檔只有自己動得了。
 *
 * **只有「檔案不在」放過**（`ENOENT`、路徑中間有一段不是目錄的 `ENOTDIR`），交給 `import` 講原本那句
 * 「載不起來」——不然使用者看到的是一個裸的 `ENOENT`，而不是哪一列寫錯了。其餘的解析失敗（讀不到上層目錄、
 * 連結繞圈、URL 不是本機路徑）一律拒絕：檢查不了的東西不能當成檢查過了。
 */
function assertPrivateModule(entry: ConfigEntry): void {
  const reject = (reason: string): never => {
    throw new PluginModuleAccessError(`條目 ${describeEntry(entry)}：${reason}`);
  };
  let path: string;
  try {
    path = realpathSync(fileURLToPath(entry.name));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return;
    return reject(
      `檢查不了 plugin 模組 ${entry.name} 的權限（${String(error)}），拒絕啟動。${PLUGIN_MODULE_ROLE.why}`,
    );
  }
  try {
    assertPrivateFile(path, PLUGIN_MODULE_ROLE);
  } catch (error) {
    reject(error instanceof Error ? error.message : String(error));
  }
}

/** 變更紀錄那一層的來源（#1412）。 */
export interface JournalSource {
  /** 紀錄檔的絕對路徑。 */
  readonly path: string;
  /**
   * 舊的 `cordis.patch.yml`。紀錄檔還不在時，它是**待遷移**的來源（照舊疊進清單，行為跟遷移前一樣）；紀錄檔在了，
   * 它在就只警告、不讀。
   */
  readonly legacyPatch?: string;
  /** 還沒寫進紀錄的內容，接在已有的後面折：寫入前驗證「這一筆寫下去之後清單長什麼樣」用。 */
  readonly pending?: readonly JournalBody[];
}

/** 組裝一次要讀的東西。 */
export interface PluginConfigSources {
  /** 出貨那一份的路徑，省略即 {@link shippedConfigPath}。 */
  readonly shipped?: string;
  /**
   * 追加在出貨那一份**後面**、仍算出貨的檔（serve 專屬層，見 {@link SERVE_SHIPPED_CONFIG_FILENAME}），照給的順序。
   * 它們的列接在出貨列後面，dump 的來源註解標各自的檔；使用者的 patch 照樣疊在全部出貨列之上。
   */
  readonly shippedLayers?: readonly string[];
  /** 一份 patch 檔當一層（測試與函式庫層級用）；產品路徑不再走它，走 {@link journal}。 */
  readonly userPatch?: string;
  /** 變更紀錄折出來的那一層，疊在出貨層之後、`--patch` 之前（#1412）。 */
  readonly journal?: JournalSource;
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
  return composeEntriesWithReport(sources).entries;
}

/**
 * {@link composeEntries}，多交出各層的報告（#1412）：變更紀錄有幾筆、有沒有舊的 patch 檔被略過、`--patch` 蓋到哪幾列。
 *
 * @param sources - 各層的來源。
 * @returns 疊完並驗過的條目清單，與各層的報告。
 * @throws {PluginConfigError} 任何一層讀不了、形狀不合，或疊完之後有壞掉的列。
 */
export function composeEntriesWithReport(sources: PluginConfigSources = {}): {
  readonly entries: ConfigEntry[];
  readonly report: LayerReport;
  /** 疊之前的出貨列與全部層攤平後的 patch：樹上的插件從這裡讀（#1416），不另外再讀一次檔。 */
  readonly source: ComposeSource;
  /** 紀錄裡最後一筆被接受的改動的序號（#1426），跟這一份條目是同一次讀的。 */
  readonly acceptedSeq: number | null;
} {
  const { shipped, rows, rowOrigins, layers, report, acceptedSeq } = readLayers(sources);
  const patches = layers.flatMap((layer) => layer.patches);
  return {
    entries: validateEntries(applyEntryPatches(rows, patches, sources.warn), shipped),
    report,
    source: { shipped, rows, rowOrigins, patches },
    acceptedSeq,
  };
}

/** {@link composeEntriesWithReport} 疊之前的原料。 */
export interface ComposeSource {
  /** 出貨 `cordis.yml` 的路徑。 */
  readonly shipped: string;
  /** 出貨列（出貨檔加 serve 專屬層），照順序。 */
  readonly rows: readonly Record<string, unknown>[];
  /** 每一列出貨列來自哪個檔，與 `rows` 同長同序。 */
  readonly rowOrigins: readonly string[];
  /** 各層攤平成一串、照套用順序的 patch。 */
  readonly patches: readonly ConfigPatch[];
}

/**
 * 各層的報告（#1412）。**不帶設定值**：快照與日誌都從這裡取材。
 */
export interface LayerReport {
  /** 變更紀錄那一層；沒有給 `journal` 來源（測試、`--dump-default-config`）就沒有。 */
  readonly journal?: {
    readonly path: string;
    /** 紀錄檔在不在。 */
    readonly exists: boolean;
    /** 紀錄幾筆（不含還沒寫的）。 */
    readonly records: number;
    /** 最後一筆的序號。 */
    readonly lastSeq: number | null;
    /** 紀錄檔還不在、舊 patch 檔在：這一次當待遷移讀，下一次啟動才遷。 */
    readonly pendingMigration: boolean;
    /** 紀錄檔在了、舊 patch 檔也在：看到了、沒讀（也不會自動再遷）。 */
    readonly ignoredLegacyPatch?: string;
  };
  /**
   * 未稽核的覆蓋層：`--patch` 給的檔，與它們指到（改或插入）的列 id。這一層不經過變更紀錄，所以寫入口看不到它，
   * 稽核也看不到——這份報告就是讓它不要靜靜地在。
   */
  readonly overlays: readonly {
    readonly file: string;
    /** 這個檔的 patch 指到的列 id，依出現順序、不重複。 */
    readonly rows: readonly string[];
  }[];
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
  /** 每一列出貨列來自哪個檔，與 `rows` 同長同序。 */
  rowOrigins: string[];
  layers: ConfigLayer[];
  report: LayerReport;
  /** 紀錄裡最後一筆被接受的改動的序號；沒有紀錄、或紀錄裡一筆都沒被接受就是 `null`。 */
  acceptedSeq: number | null;
} {
  const shipped = sources.shipped ?? shippedConfigPath();
  const rows: Record<string, unknown>[] = [];
  const rowOrigins: string[] = [];
  for (const path of [shipped, ...(sources.shippedLayers ?? [])]) {
    let source: string;
    try {
      source = readFileSync(path, 'utf8');
    } catch (error) {
      throw new PluginConfigError(`讀不到出貨的 ${path}：${String(error)}`);
    }
    for (const row of parseEntryList(source, path)) {
      rows.push(row);
      rowOrigins.push(path);
    }
  }

  const layers: ConfigLayer[] = [];
  if (sources.userPatch !== undefined) {
    const patches = loadOptionalPatches(sources.userPatch);
    if (patches !== undefined) layers.push({ label: sources.userPatch, patches });
  }
  let journalReport: LayerReport['journal'];
  let acceptedSeq: number | null = null;
  if (sources.journal !== undefined) {
    const read = readJournalLayer(sources.journal, sources.warn ?? warnToStderr);
    if (read.patches.length > 0) layers.push({ label: read.label, patches: read.patches });
    journalReport = read.report;
    acceptedSeq = read.acceptedSeq;
  }
  const overlays: { file: string; rows: string[] }[] = [];
  for (const overlay of sources.overlays ?? []) {
    const patches = loadOverlayPatches(overlay);
    layers.push({ label: overlay, patches });
    overlays.push({ file: overlay, rows: rowsTouchedBy(patches) });
  }
  return {
    shipped,
    rows,
    rowOrigins,
    layers,
    report: { ...(journalReport !== undefined && { journal: journalReport }), overlays },
    acceptedSeq,
  };
}

/** 一批 patch 指到的列 id：`insert` 進來的用它的 id（沒寫就用 name），其餘用 patch 的 id。 */
function rowsTouchedBy(patches: readonly ConfigPatch[]): string[] {
  const ids = new Set<string>();
  for (const patch of patches) {
    if (patch.insert !== undefined) {
      for (const row of patch.insert) {
        const id = row['id'] ?? row['name'];
        if (typeof id === 'string') ids.add(id);
      }
    } else if (patch.id !== undefined) {
      ids.add(patch.id);
    }
  }
  return [...ids];
}

/** 紀錄檔在了、舊 patch 檔又出現：看到、沒讀。訊息只在這一處組，日誌那一側用同一句去重。 */
export function legacyPatchIgnoredMessage(legacy: string, journal: string): string {
  return (
    `看到 ${legacy}，但沒讀：變更紀錄 ${journal} 已經建立，這個檔不會生效，也不會再自動遷移` +
    `（誰都能放個檔進來，自動遷移會讓「誰改的」全變成「遷移」）。` +
    '要保留裡面的改動，請用 plugin 寫入口重做，或改放進 --patch。'
  );
}

/**
 * 讀變更紀錄那一層，折成 patch（#1412）。
 *
 * | 紀錄檔 | 舊 `cordis.patch.yml` | 這一次 |
 * |---|---|---|
 * | 在 | 不在 | 折紀錄 |
 * | 在 | 在 | 折紀錄；**舊檔不讀**，警告一次（加 3：誰都能放個檔進來，自動再遷等於繞過稽核） |
 * | 不在 | 在 | **待遷移**：照遷移前的行為把舊檔當這一層讀，下一次啟動（{@link prepareJournal}）才遷 |
 * | 不在 | 不在 | 沒有這一層 |
 *
 * 紀錄檔**讀端不取鎖**：最後一行還沒寫完就略過（`plugin-journal.ts`）。權限檢查與舊 patch 檔同一條
 * （{@link assertPrivateFile}）：它決定這個行程載入哪些模組，別人寫得動就是別人替你決定跑什麼。
 */
function readJournalLayer(
  source: JournalSource,
  warn: PluginConfigWarn,
): {
  patches: ConfigPatch[];
  label: string;
  report: NonNullable<LayerReport['journal']>;
  acceptedSeq: number | null;
} {
  let contents;
  try {
    contents = readJournal(source.path, {
      check: (path) => assertPrivateFile(path, JOURNAL_FILE_ROLE),
    });
  } catch (error) {
    if (error instanceof PluginJournalError) throw new PluginConfigError(error.message);
    throw error;
  }
  const legacyExists = source.legacyPatch !== undefined && existsSync(source.legacyPatch);
  const bodies: JournalBody[] = [...(contents?.records ?? [])];
  let label = source.path;
  let pendingMigration = false;
  let ignoredLegacyPatch: string | undefined;
  if (contents === undefined && legacyExists && source.legacyPatch !== undefined) {
    pendingMigration = true;
    label = source.legacyPatch;
    for (const patch of loadOptionalPatches(source.legacyPatch) ?? []) {
      bodies.push({ op: 'patch', patch });
    }
  } else if (contents !== undefined && legacyExists && source.legacyPatch !== undefined) {
    ignoredLegacyPatch = source.legacyPatch;
    warn(legacyPatchIgnoredMessage(source.legacyPatch, source.path));
  }
  bodies.push(...(source.pending ?? []));
  const patches = foldJournal(bodies).map((row, index) => {
    const result = patchSchema.safeParse(row);
    if (!result.success) {
      throw new PluginConfigError(
        `${label} 折出來的第 ${String(index + 1)} 條 patch 不合法 — ${formatIssues(result.error)}`,
      );
    }
    return result.data;
  });
  const records = contents?.records ?? [];
  return {
    patches,
    label,
    // 最後一筆**被接受的**改動的序號（#1426）：`failed`、`rejected` 是只記不折的筆，不算。
    acceptedSeq: records.findLast((record) => isAcceptedRecord(record))?.seq ?? null,
    report: {
      path: source.path,
      exists: contents !== undefined,
      records: records.length,
      lastSeq: records.at(-1)?.seq ?? null,
      pendingMigration,
      ...(ignoredLegacyPatch !== undefined && { ignoredLegacyPatch }),
    },
  };
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
  const { shipped, rows, rowOrigins, layers } = readLayers(sources);
  const warn = sources.warn ?? warnToStderr;

  // **每份快照都自己 clone 一份 patch**：`applyEntryPatches` 會把 `insert` 的列放進結果，
  // 共用同一批 patch 物件會讓後一份快照的改動漏進前一份的結果裡。dsh 同一條理由。
  const snapshot = (count: number, warnings: string[]): Record<string, unknown>[] =>
    applyEntryPatches(
      rows,
      structuredClone(layers.slice(0, count).flatMap((layer) => [...layer.patches])),
      (message) => warnings.push(message),
    );

  const origins = rowOrigins.map((origin) => ({ origin, patchedBy: [] as string[] }));
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
 * 啟動時掉了的一列（[#751](https://github.com/DemianLi/nexus-agent/issues/751)）。讀清單那一次交出 `module`／`config`
 * 兩步，組裝那一次（`startup-audit.ts` 的 `assemblyDropsOf`）補上 `apply`／`requires` 兩步。
 */
export interface StartupDrop {
  /** 條目 id。沒寫 id 的列（只有 `insert` 進來的會這樣）：設定那一步是補過號的 id，模組那一步是模組 specifier。 */
  readonly id: string;
  /** 模組 specifier，即那一列的 `name`。組裝點自己加的外掛不是清單上的列，沒有這個名字，見 `startup-audit.ts`。 */
  readonly module: string;
  /**
   * 掉在哪一步：模組載不進來（或匯出的不是一顆 plugin）、設定驗不過，或組裝時 `apply` 失敗（含撞到基座保留的
   * 工具名）、`requires` 缺件。
   */
  readonly stage: 'module' | 'config' | 'apply' | 'requires';
  /** 指名那一列的原因，跟今天整個拋的那一句同一句。 */
  readonly message: string;
  /**
   * 清單上那一列：設定那一步的已標成 `disabled: true`，組裝那兩步的是交給組裝的那一顆。模組那一步掉的沒有：它不在
   * 清單上，見 {@link loadPluginConfig}。
   */
  readonly entry?: PluginEntry;
}

/** 照樣掛上、但要警告的一列：這顆 plugin 沒有設定格式，那一列卻寫了 `config`。 */
export interface IgnoredConfig {
  readonly id: string;
  readonly module: string;
}

/** {@link loadPluginConfig} 的結果。 */
export interface LoadedPluginConfig {
  /**
   * 可以交給 `loadPlugins` 的清單。**設定驗不過的那一列還在，改成 `disabled: true`**：掉了的列照 dsh 算沒掛，
   * 標成停用，載入器才會記進 `disabledEntries`，折疊那側與 `startupSetting`／`startupEntryMounted` 都把它當沒掛。
   */
  readonly plugins: readonly PluginEntry[];
  /** 掉了哪幾列：模組那一步的在前、設定那一步的在後，各自依清單順序。哪幾列掉了要整個起不來由呼叫端判（`startup-audit.ts`）。 */
  readonly dropped: readonly StartupDrop[];
  /** 照樣掛上、但寫的 `config` 沒有作用的列。 */
  readonly ignoredConfig: readonly IgnoredConfig[];
  /**
   * {@link plugins} 裡每一顆條目的 id 與模組名，以條目物件為鍵。組裝時掉了的列只帶著條目物件回來，警告要寫 id 與
   * 模組名、必掛名單要比 id，從這裡查（`startup-audit.ts`）。
   */
  readonly rows: ReadonlyMap<PluginEntry, { readonly id: string; readonly module: string }>;
  /**
   * 疊完、驗過、**還沒 import 任何模組**的那份清單（{@link composeEntries} 的回傳值，原樣）——`--dump-config` 印的就是
   * 這一份（同一組層、同一次 {@link applyEntryPatches}、同一次 {@link validateEntries}）。會話日誌 header 的插件清單與
   * 設定雜湊從這裡投影（[#1025](https://github.com/DemianLi/nexus-agent/issues/1025)，`session-header-metadata.ts`），
   * **不另外再疊一次**：兩次讀檔之間 patch 被改的話，header 會描述一棵沒有掛過的樹。
   *
   * 啟動時才掉的列（{@link dropped}）在這裡照宣告的樣子留著，同 `--dump-config`。
   */
  readonly entries: readonly ConfigEntry[];
  /**
   * {@link entries} 每一列解析後的 id，一格對一格（[#1406](https://github.com/DemianLi/nexus-agent/issues/1406)）。
   * 寫了 `id` 的列就是那個 id；沒寫的（只有 `insert` 進來的會這樣）是載入器補的那個號，跟 {@link rows}、
   * {@link StartupDrop.id} 同一套。模組載不進來的列載入器沒補過號，用 `id ?? name`，同 {@link StartupDrop.id} 的規則。
   * 「磁碟上有哪幾列」要從這裡走，不能從 {@link rows} 或 {@link plugins} 走：模組那一步掉了的列、與停用而且模組載
   * 不起來的列不在那兩份裡。
   */
  readonly ids: readonly string[];
  /**
   * 各層的報告（#1412）：變更紀錄幾筆、舊 patch 檔有沒有被略過、`--patch` 蓋到哪幾列。**不帶設定值。**
   * 快照（`plugin-snapshot.ts`）與伺服器日誌從這裡取材。
   */
  readonly layers: LayerReport;
  /**
   * 變更紀錄裡**最後一筆被接受的**改動的序號（{@link isAcceptedRecord}），沒有就是 `null`（#1426）。跟 {@link entries}
   * 是同一次讀的。放在這裡而不是 {@link layers}：`layers` 整份進快照檔，這個數字只給「試組掉在 `requires` 的列什麼時候
   * 重試」用（`thread-plugin-list.ts`），不屬於對外報的那份。
   */
  readonly acceptedSeq: number | null;
}

/**
 * 組裝：疊完、驗完，再把每一列的模組 import 進來，逐列驗一次設定。
 *
 * **一列自己的失敗只讓那一列掉**，照 dsh 的失敗表（`packages/boot/app-boot/README.zh.md:97-99`，`477b4f4`），
 * 掉了哪幾列交出去，哪幾列掉了要整個失敗由呼叫端拿必掛名單判
 * （[#751](https://github.com/DemianLi/nexus-agent/issues/751)，`startup-audit.ts`）：
 *
 * - **模組載不進來、或匯出的不是一顆 plugin**：那一列不在回傳的清單上——手上沒有那顆 plugin，連名字都取不到，
 *   所以載入器標不到它，折疊那側會把它讀成「清單上沒有」而不是「關掉」。射程：出貨的列是 `@nexus/*`／`#settings/*`
 *   的裸 specifier，patch 又改不動既有列的 `name`（{@link applyEntryPatches} 的解構），所以只有 `insert` 進來的列
 *   或安裝壞掉才走得到這一格。停用的列模組載不起來時不算掉：dsh 對停用的列根本不載入（`Entry.refresh` 開頭就
 *   `if (this.disabled) return`），失敗表那一列是「忽略」（`README.zh.md:106`）。
 * - **設定驗不過**：那一列留在清單上、改成 `disabled: true`（見 {@link LoadedPluginConfig.plugins}）。
 * - **沒有設定格式卻寫了 `config`**：不算掉，照 dsh 原樣交下去（`vendor/cordis/src/fiber.ts:51`），記進
 *   {@link LoadedPluginConfig.ignoredConfig} 讓呼叫端印警告。
 *
 * 整份的錯照舊整個拋，對到 dsh 失敗表第一列（`README.zh.md:96`）：讀檔、疊層、條目形狀、重複 id、關不掉的列被關掉；
 * 權限被拒也照舊整個拋（{@link PluginModuleAccessError}）。
 *
 * @param sources - 三層的來源。
 * @returns 清單、掉了的列、寫了沒作用的 `config` 的列。
 * @throws {PluginConfigError} 整份的錯，或權限被拒。
 */
export async function loadPluginConfig(
  sources: PluginConfigSources = {},
  options: LoadPluginConfigOptions = {},
): Promise<LoadedPluginConfig> {
  const { tree } = options;
  // 有樹的話，「讀清單 → 推給樹 → 等收斂 → 取工具快照」是一段臨界區（`plugin-tree.ts`）：兩條 thread 同時組裝時，
  // 各自拿到的工具跟自己讀到的清單相符。
  if (tree !== undefined) return tree.run(() => loadPluginConfigOnce(sources, tree));
  return loadPluginConfigOnce(sources, undefined);
}

/** {@link loadPluginConfig} 的選項。 */
export interface LoadPluginConfigOptions {
  /**
   * 產品路徑的樹（`cordis-root.ts` 的 `root.tree`）：函式插件的工具從這棵長壽的樹來。省略就是**沒有樹的呼叫端**
   * （手搭清單的測試、基準任務、驗證寫入用的疊檔）：函式插件的列在組裝時單獨掛一次，驗證寫入的疊檔路徑根本不組裝。
   */
  readonly tree?: PluginTree;
}

async function loadPluginConfigOnce(
  sources: PluginConfigSources,
  tree: PluginTree | undefined,
): Promise<LoadedPluginConfig> {
  const { entries, report, source, acceptedSeq } = composeEntriesWithReport(sources);
  const loaded: { readonly row: ConfigEntry; readonly entry: PluginEntry }[] = [];
  const dropped: StartupDrop[] = [];
  // `entries` 每一列解析後的 id：先放「宣告的 id 或模組名」，載進來的那幾列等載入器補完號再換成補過的那個。
  const ids = entries.map((row) => row.id ?? row.name);
  const loadedAt: number[] = [];
  for (const [position, row] of entries.entries()) {
    try {
      loaded.push({ row, entry: await resolveEntryModule(row) });
      loadedAt.push(position);
    } catch (error) {
      if (error instanceof PluginModuleAccessError || !(error instanceof PluginConfigError)) {
        throw error;
      }
      if (row.disabled === true) continue;
      dropped.push({
        id: row.id ?? row.name,
        module: row.name,
        stage: 'module',
        message: error.message,
      });
    }
  }
  // 身分照載入器同一支算（補號、重複 id），訊息裡的 id 才跟組裝時對得上。
  const resolutions = resolveEntriesPerEntry(loaded.map(({ entry }) => entry));
  // 樹上的函式插件（橋接列）：先把 id 補完、位置記下，才知道要推什麼給樹。
  const bridged: TreeRowInput[] = [];
  loaded.forEach(({ row, entry }, index) => {
    const resolution = resolutions[index];
    const position = loadedAt[index];
    if (resolution === undefined) return;
    if (position !== undefined) ids[position] = resolution.origin.id;
    if (!isBridgeEntry(entry)) return;
    // 樹上的設定會過 Loader 的 `interpolate`，`__jsExpr` 在那裡是 `eval`：進樹之前整份拒絕，寫入前驗證也走這一條。
    const jsExpr = findJsExpr(entry.config, `${resolution.origin.id} 的 config`);
    if (jsExpr !== undefined) {
      throw new PluginConfigError(
        `${jsExpr} 帶了 \`__jsExpr\`：樹上的設定不接受表達式（Loader 會把它 eval 掉，` +
          '這裡刻意不接，同 cordis.yml 檔頭對 `disabled` 的偏離標註 #104）。',
      );
    }
    bridged.push({
      id: resolution.origin.id,
      module: row.name,
      // 設定驗不過的列相容層標成停用，樹上也不該去掛它。
      disabled: resolution.disabled || resolution.configError !== undefined,
      config: entry.config,
    });
  });
  const snapshot: TreeSnapshot | undefined =
    tree === undefined ? undefined : await tree.sync(treeInputOf(source, ids, bridged));
  const ignoredConfig: IgnoredConfig[] = [];
  const rows = new Map<PluginEntry, { readonly id: string; readonly module: string }>();
  const plugins = loaded.map(({ row, entry }, index): PluginEntry => {
    const resolution = resolutions[index];
    if (resolution === undefined) return entry;
    const { origin, configError } = resolution;
    rows.set(entry, { id: origin.id, module: row.name });
    if (resolution.disabled) return entry;
    if (configError !== undefined) {
      const off: PluginEntry = { ...entry, disabled: true };
      rows.set(off, { id: origin.id, module: row.name });
      dropped.push({
        id: origin.id,
        module: row.name,
        stage: 'config',
        message: configError.message,
        entry: off,
      });
      return off;
    }
    if (entry.plugin.Config === undefined && entry.config !== undefined) {
      ignoredConfig.push({ id: origin.id, module: row.name });
    }
    if (!isBridgeEntry(entry)) return entry;
    // 橋接列：樹上起來了就折它登記的工具；沒起來就跟設定驗不過同一個待遇——標成停用、記進 `dropped`，
    // 哪一步掉的取樹上的（FAILED／缺席是 `apply`，缺服務與契約不相容是 `requires`）。
    if (snapshot === undefined) {
      const bound = bindDetached(entry, origin.id);
      rows.set(bound, { id: origin.id, module: row.name });
      return bound;
    }
    const verdict = snapshot.verdict(origin.id);
    if (verdict.kind === 'dropped') {
      const off: PluginEntry = { ...entry, disabled: true };
      rows.set(off, { id: origin.id, module: row.name });
      dropped.push({
        id: origin.id,
        module: row.name,
        stage: verdict.stage,
        message: verdict.message,
        entry: off,
      });
      return off;
    }
    if (verdict.kind === 'off') {
      // 樹上這一列自我停用過、宣告沒變（#1424）：不是掉了，是它自己停的，行程裡一直停著。標成停用，不進 `dropped`，
      // 所以不會在紀錄裡多一筆 `failed`、也不會讓必掛名單把它當成掛不上。
      const off: PluginEntry = { ...entry, disabled: true };
      rows.set(off, { id: origin.id, module: row.name });
      return off;
    }
    const bound = bindToTree(entry, {
      tools: verdict.tools,
      toolOptions: verdict.toolOptions,
      gates: verdict.gates,
      projections: verdict.projections,
      skillSources: verdict.skillSources,
      commands: verdict.commands,
      services: verdict.services,
    });
    rows.set(bound, { id: origin.id, module: row.name });
    return bound;
  });
  return { plugins, dropped, ignoredConfig, rows, entries, ids, layers: report, acceptedSeq };
}

/**
 * 這一份清單推給樹的是什麼。
 *
 * - **只推走橋接的那幾列的 patch**：指到其他列的 patch 對樹沒有意義，也不該讓它們的內容（例如一顆舊插件的 `config`）
 *   過樹的 `__jsExpr` 掃描。目標 id 取自出貨檔那一層與 `insert` 進來的橋接列。
 * - **插進來的列補上相容層解析後的 id**：Include 對沒有 id 的 `insert` 會補隨機 id，樹上那一列對不回相容層的列。
 *   `applyEntryPatches` 把 `insert` 的列接在尾巴、照 patch 順序，所以第 k 個插進來的列就是 `entries[出貨列數 + k]`。
 * - **出貨列沒寫 `config` 的補 `{}`**：Loader 對沒有 `config` 的列交 `undefined`，`strictObject` 收不下；相容層對沒寫的
 *   視同 `{}`（`resolveEntries`），樹這一側也要一致。
 * - **相容層標成停用的列，結尾補一條 `disabled: true`**：設定驗不過的列不該在樹上掛著。
 */
function treeInputOf(
  source: ComposeSource,
  ids: readonly string[],
  bridged: readonly TreeRowInput[],
): TreeInput {
  const modules = new Set(bridged.map((row) => row.module));
  const treeIds = new Set<string>();
  const patches: Record<string, unknown>[] = [];
  source.rows.forEach((row, index) => {
    if (source.rowOrigins[index] !== source.shipped) return;
    const id = row['id'];
    const name = row['name'];
    if (typeof id !== 'string' || typeof name !== 'string' || !modules.has(name)) return;
    treeIds.add(id);
    if (row['config'] === undefined) patches.push({ id, config: {} });
  });
  let inserted = 0;
  for (const patch of source.patches) {
    if (patch.insert !== undefined) {
      const kept: Record<string, unknown>[] = [];
      for (const row of patch.insert) {
        const position = source.rows.length + inserted;
        inserted += 1;
        const name = row['name'];
        const id = ids[position];
        if (typeof name !== 'string' || !modules.has(name) || id === undefined) continue;
        treeIds.add(id);
        kept.push({ ...structuredClone(row), id, config: row['config'] ?? {} });
      }
      if (kept.length > 0) patches.push({ insert: kept });
      continue;
    }
    if (patch.id !== undefined && treeIds.has(patch.id)) patches.push(structuredClone(patch));
  }
  for (const row of bridged) {
    if (row.disabled && treeIds.has(row.id)) patches.push({ id: row.id, disabled: true });
  }
  return { shipped: source.shipped, patches, rows: bridged };
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
 * @returns 同 {@link loadPluginConfig}：清單、掉了的列、寫了沒作用的 `config` 的列。
 * @throws {PluginConfigError} 任何一層讀不了、形狀不合、別人動得了。
 */
export async function loadDefaultPlugins(
  options: DefaultConfigOptions = {},
  load: LoadPluginConfigOptions = {},
): Promise<LoadedPluginConfig> {
  return loadPluginConfig(defaultSources(options), load);
}

/** {@link loadDefaultPlugins} 與 {@link renderLayeredConfigDump} 共用的那幾格。 */
export interface DefaultConfigOptions {
  /**
   * 這是 serve 入口：多疊一層 serve 專屬的出貨清單（{@link SERVE_SHIPPED_CONFIG_FILENAME}）。省略／`false` 是 CLI。
   * **啟動與 `--dump-config`／`--dump-config-schema`／`--dump-default-config` 傳同一個值**，否則 dump 印的不是啟動會掛的樹。
   */
  readonly serve?: boolean;
  /** 決定 harness home 落在哪，省略即 `process.env`。 */
  readonly env?: NodeJS.ProcessEnv;
  /** `--patch` 給的那幾個檔，照命令列順序。 */
  readonly patches?: readonly string[];
  /** 跳過某條 patch 時往哪裡講，省略即 stderr。 */
  readonly warn?: PluginConfigWarn;
  /** 還沒寫進變更紀錄的內容（寫入前驗證用），見 {@link JournalSource.pending}。 */
  readonly pending?: readonly JournalBody[];
}

/**
 * 產品路徑上那幾層的來源。
 *
 * **`--dump-config` 與啟動共用這一個**，所以 dump 印的層與啟動疊的層是同一組。各自算一次
 * 的下場是有一天 dump 說「你的 home patch 沒生效」而它其實生效了——那比沒有 dump 更糟。
 *
 * @param options - env、`--patch`、警告出口。
 * @returns 三層的來源。
 */
export function defaultSources(options: DefaultConfigOptions): PluginConfigSources {
  const home = resolveHarnessHome(options.env ?? process.env);
  return {
    ...(options.serve === true && { shippedLayers: [serveShippedConfigPath()] }),
    journal: {
      path: join(home, PLUGIN_JOURNAL_FILE_NAME),
      legacyPatch: join(home, USER_PATCH_FILENAME),
      ...(options.pending !== undefined && { pending: options.pending }),
    },
    ...(options.patches !== undefined && { overlays: options.patches }),
    ...(options.warn !== undefined && { warn: options.warn }),
  };
}

/**
 * 產品路徑上那三層疊完的條目，**還沒 import 任何模組**——`--dump-config-schema`（#741）收集規格表的起點。
 * 疊的層與 {@link renderLayeredConfigDump}、啟動是同一組（共用 `defaultSources`）。
 *
 * @param options - 與 {@link loadDefaultPlugins} 同一組。
 * @returns 疊完並驗過形狀的條目清單。
 * @throws {PluginConfigError} 任何一層讀不了、形狀不合，或疊完之後有壞掉的列。
 */
export function composeDefaultEntries(options: DefaultConfigOptions = {}): ConfigEntry[] {
  return composeEntries(defaultSources(options));
}

/**
 * 產品路徑上那三層疊完的樣子，印成 YAML。
 *
 * @param options - 與 {@link loadDefaultPlugins} 同一組。
 * @returns 一份帶來源註解的 YAML 文件。
 * @throws {PluginConfigError} 任何一層讀不了、形狀不合，或疊完之後有壞掉的列。
 */
export function renderLayeredConfigDump(options: DefaultConfigOptions = {}): string {
  return renderConfigDump(defaultSources(options));
}

/**
 * 只印出貨那一層的設定（[#740](https://github.com/DemianLi/nexus-agent/issues/740)）——`--dump-default-config`。
 *
 * 照 dsh 的 `--dump-default-config`（`apps/cli/src/dump-config.ts:47`）：**真的不讀**home 覆寫檔與 `--patch`，不是讀了再丟。
 * 它就是設計來救「`cordis.patch.yml` 壞掉」的：壞掉的檔（權限錯、YAML 寫壞）不會被解析，所以 {@link renderLayeredConfigDump}
 * 印不出來的時候，這一份還印得出來，拿來跟壞掉的那份對照。
 *
 * **刻意不經過 `defaultSources`**：那條路一定帶 `userPatch`，也要解析 home 路徑；這裡直接給一份空來源，
 * 讀的只有 `shippedConfigPath()`。我們沒有 profile 也沒有組合包（#46 Out of scope），dsh 的「出貨」在這裡就是一個檔。
 *
 * @param options - `serve`：serve 入口，出貨層多一個 serve 專屬檔（同 {@link DefaultConfigOptions.serve}）。
 * @returns 一份帶來源註解的 YAML 文件。
 * @throws {PluginConfigError} 出貨檔讀不了、形狀不合，或有壞掉的列。
 */
export function renderShippedConfigDump(options: { readonly serve?: boolean } = {}): string {
  return renderConfigDump(
    options.serve === true ? { shippedLayers: [serveShippedConfigPath()] } : {},
  );
}

/** {@link prepareJournal} 的選項。 */
export interface PrepareJournalOptions {
  /** 決定 harness home 落在哪，省略即 `process.env`。 */
  readonly env?: NodeJS.ProcessEnv;
  /** 做不成時往哪裡講，省略即 stderr。 */
  readonly warn?: PluginConfigWarn;
  /** 算遷移那幾筆的 `at`，測試給固定的。 */
  readonly now?: () => Date;
  /**
   * 測試用：紀錄檔已經 rename 進位、舊 patch 檔還沒改名的那一刻。在這裡拋，等於「兩步之間當掉」。
   */
  readonly afterJournalWritten?: () => void | Promise<void>;
  /**
   * 紀錄檔和舊 patch 檔都不在的時候要不要建一個空的，省略即 `true`。
   *
   * serve 與寫入口要建（那是「第一次啟動」的界線，見 {@link prepareJournal}）；**一次性的 CLI 傳 `false`**：
   * 落盤關掉的那一次、預設根被拒絕的那一次，承諾的是「home 連目錄都不建」（`session-log-durability.test.ts`、
   * `invariant-log.test.ts`），建一個空紀錄檔就破了它。沒有舊檔要遷的時候 CLI 什麼都不寫，讀端本來就把「沒有紀錄檔」
   * 當成沒有這一層（驗收 H）。
   */
  readonly createWhenAbsent?: boolean;
}

/** {@link prepareJournal} 做了什麼。 */
export type PrepareJournalResult =
  | { readonly status: 'present'; readonly path: string }
  | { readonly status: 'absent'; readonly path: string }
  | { readonly status: 'created'; readonly path: string }
  | {
      readonly status: 'migrated';
      readonly path: string;
      /** 遷了幾條 patch。 */
      readonly migrated: number;
      /** 舊檔改名成了什麼（0600）。 */
      readonly renamedTo: string;
    }
  | { readonly status: 'unavailable'; readonly path: string; readonly reason: string };

/**
 * 啟動步驟：確保變更紀錄存在，必要時把舊的 `cordis.patch.yml` 遷進去（#1412 Q2）。
 *
 * **serve 與 CLI 啟動、寫入口寫之前都先呼叫它**；`--dump-config` 不呼叫（它只讀，遷移還沒發生時照舊把舊檔當待遷移那一層
 * 讀，見 {@link readJournalLayer}）。
 *
 * - **界線是紀錄檔存在**：第一次啟動時沒有紀錄檔，就建一個（沒有舊檔就建空的）。之後只要紀錄檔在，舊檔再出現一律
 *   警告、不讀、不遷（加 3）。沒有這個界線，「從來沒有 patch 的新 home」之後被人丟進一個檔就會被當成第一次遷移吃進去。
 * - **整件事在 `plugin-journal.jsonl.lock` 裡做，拿到鎖後再查一次紀錄檔在不在**：serve 與 CLI 同時第一次啟動，只有一個
 *   遷，另一個看到的是 `present`。
 * - **順序**：帶遷移內容的紀錄先寫暫存檔、fsync、rename 成正式檔，**最後**才把舊檔改名成 `cordis.patch.yml.migrated-<時間>`
 *   （並設 0600：舊檔裡同樣有秘密，原本的權限不一定是 0600）。兩步之間當掉：下次啟動紀錄檔已在、舊檔還在，走
 *   「警告、不讀」，既不重複遷也不漏——改動已經在紀錄裡。
 * - **每條 patch 一筆，actor 記「遷移」**（來源路徑與全文的 SHA-256）。`insert` 的模組路徑在解析時已經換成絕對的
 *   file URL（{@link anchorInsertedNames}），不然檔案改名之後相對路徑就沒有基準了（加 1）。
 *
 * **舊檔壞了（YAML、形狀、權限）照舊整個拋**，跟遷移前啟動讀它的下場一樣；建不出紀錄檔（唯讀的 home、等不到鎖）不拋，
 * 回 `unavailable`：紀錄檔還不在，讀端照樣把舊檔當待遷移那一層讀，不漏任何改動。
 *
 * @param options - env、警告出口、測試鉤子。
 * @returns 做了什麼。
 * @throws {PluginConfigError} 舊的 patch 檔讀不了、形狀不合，或別人動得了。
 */
export async function prepareJournal(
  options: PrepareJournalOptions = {},
): Promise<PrepareJournalResult> {
  const home = resolveHarnessHome(options.env ?? process.env);
  const path = join(home, PLUGIN_JOURNAL_FILE_NAME);
  const legacy = join(home, USER_PATCH_FILENAME);
  if (existsSync(path)) return { status: 'present', path };
  if (options.createWhenAbsent === false && !existsSync(legacy)) return { status: 'absent', path };
  const warn = options.warn ?? warnToStderr;
  const now = options.now ?? (() => new Date());
  let journalWritten = false;
  try {
    await mkdir(home, { recursive: true, mode: 0o700 });
    return await withFileLock(path, async (): Promise<PrepareJournalResult> => {
      if (existsSync(path)) return { status: 'present', path };
      if (!existsSync(legacy)) {
        if (options.createWhenAbsent === false) return { status: 'absent', path };
        await createJournalFile(path, []);
        return { status: 'created', path };
      }
      const text = readFileSync(legacy, 'utf8');
      assertPrivateFile(legacy);
      const patches = parsePatchList(text, legacy);
      const actor: JournalActor = {
        kind: 'migration',
        source: resolve(legacy),
        sha256: createHash('sha256').update(text).digest('hex'),
      };
      const at = now().toISOString();
      const records: JournalRecord[] = patches.map((patch, index) => ({
        v: PLUGIN_JOURNAL_VERSION,
        seq: index + 1,
        at,
        actor,
        op: 'patch',
        patch: structuredClone(patch) as Record<string, unknown>,
      }));
      await createJournalFile(path, records);
      journalWritten = true;
      await options.afterJournalWritten?.();
      const stamp = now().toISOString().replace(/[:.]/gu, '-');
      const renamedTo = `${legacy}.migrated-${stamp}`;
      chmodSync(legacy, 0o600);
      await rename(legacy, renamedTo);
      return { status: 'migrated', path, migrated: records.length, renamedTo };
    });
  } catch (error) {
    if (error instanceof PluginConfigError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    warn(
      journalWritten
        ? `${legacy} 的內容已經遷進 ${path}，但舊檔沒能改名（${reason}）。它會被當成「遷移後又出現的檔」警告、不讀；` +
            '確認紀錄之後可以自己把它改名或刪掉。'
        : `建不出變更紀錄 ${path}（${reason}）。紀錄檔還不在，${legacy} 照舊當這一層讀，改動不會漏；下一次啟動再試。`,
    );
    return { status: 'unavailable', path, reason };
  }
}

/**
 * {@link prepareJournal} 的結果寫成一行給人看的話；沒什麼好講的（紀錄在、或剛建空檔）回 `undefined`。
 *
 * @param result - {@link prepareJournal} 的回傳。
 * @returns 一行，或 `undefined`。
 */
export function describePrepareJournal(result: PrepareJournalResult): string | undefined {
  if (result.status !== 'migrated') return undefined;
  return (
    `[清單] 已把舊的 cordis.patch.yml 的 ${String(result.migrated)} 條 patch 遷進變更紀錄 ${result.path}；` +
    `原檔改名為 ${result.renamedTo}（不再讀取，0600）。之後改插件請用 plugin 寫入口。`
  );
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
