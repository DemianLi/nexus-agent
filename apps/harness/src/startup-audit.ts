/**
 * 啟動時哪幾列掉了要整個起不來：**必掛名單**與那一段警告（[#751](https://github.com/DemianLi/nexus-agent/issues/751)）。
 *
 * ## 照 dsh：載入器不管嚴不嚴，嚴格的語意由用它的那一方持有
 *
 * dsh 的載入器一列起不來、其他列照樣起來；app-boot 在全部結算之後套一份**寫死在程式裡**的必掛名單：
 * 名單上的條目掛了就一定要起來，起不來就釋放資源、以 `StartupError` 拒絕，訊息連可少掛的失敗一起列；
 * 只有可少掛的沒起來時印一段警告、繼續（dsh `packages/boot/app-boot/src/index.ts:739-754`、`:925-938`，
 * `README.zh.md:137`，`477b4f4`）。**比對用條目的 id**（`:931-932`），名單不分入口；沒掛或被關掉的不影響啟動。
 *
 * 這個模組是那一步的產品路徑版。掉了哪幾列分兩次知道，照卡上第 4 項：
 *
 * 1. **讀完清單、還沒建任何東西**（{@link auditStartupEntries}）：`loadPluginConfig` 交出模組載不進來與設定驗不過的列，
 *    必掛的掉了就在這裡起不來——早於建模型、讀或建瀏覽器會話密鑰、綁 port。
 * 2. **組裝**（CLI 的那一次、serve 的那一次試組）：只有清單交出來、又不在必掛名單上的條目可以少掛
 *    （{@link optionalEntriesOf}），補上 `apply` 失敗、`requires` 缺件、撞名掉的列（{@link assemblyDropsOf}）。
 *    不能少掛的掉了，組裝拋 `AssemblyDropError`，換成跟第一次同一種 `StartupError`（{@link startupErrorFrom}）。
 *
 * 兩次合起來印一段（{@link startupWarning}），只印一次。
 *
 * ## 名單是 `browser-session`、`system-prompt` 與 `background-subagents`
 *
 * dsh 的七個 id 分三類（`README.zh.md:43`），對到我們：
 *
 * | dsh 那一類 | dsh 的條目 | 我們對應的是 | 是清單上的一列嗎 |
 * |---|---|---|---|
 * | 共用的 agent 執行 | `agent-loop` | 組裝本身（`createNexusAgent`、折疊、deepagents） | 不是 |
 * | 應用的對外端點 | `webserver`、`headless-runner`、`acp`、`sdk-jsonrpc-server` | serve 的 HTTP 伺服器、CLI 的對話迴圈 | 不是 |
 * | web 的啟動與傳輸 | `modules`、`connection` | `connection` 的 cookie 有效期在我們是 `browser-session` 這一列 | **是** |
 *
 * 不是清單上的列的那幾樣（組裝本身、入口自己的程式碼、組裝點自己加的外掛），失敗照舊一律起不來，不經過這裡。
 *
 * **`system-prompt` 是我們多的一個**（[#720](https://github.com/DemianLi/nexus-agent/issues/720)，偏離登記）：dsh 的名單沒有它，
 * 因為 dsh 的嚴格插值在渲染時拋——每一輪都紅，壞掉的設定不可能被忽略。我們的載入器把 `apply` 拋的錯變成「那一列掉了」，
 * 不列進名單的話，前綴寫了個打錯字的 `{{modle}}` 只換來一行警告，模型靜靜少了身分與 persona 照樣跑——比大聲失敗更糟。
 * 表達不出來的是「壞了就每輪都紅」（我們在掛載當下算，不在渲染時算），退到最接近的：讓這一列掉了就整個起不來。
 *
 * **`background-subagents` 是第三個**（[#707](https://github.com/DemianLi/nexus-agent/issues/707)，偏離登記），理由與 `system-prompt` 同型但方向相反：
 * 它帶著子代理的 `toolFilter`，那是一道**限制**。這一列設定驗不過就掉，掉了的後果是「沒有過濾」——部署方寫了 `deny: [write_file]`、
 * 寫錯一個字，換來一行警告和一個什麼都能寫的子代理，是 fail-open。dsh 那側同一格寫壞時整顆委派工具跟著掉（`apply` 拋），
 * 不會留下一個沒被限制的委派路徑；我們的前景 `task` 是基座的，不跟這一列一起掉，表達不出「一起掉」，退到最接近的：讓這一列掉了就整個起不來。
 * 代價是 `maxActiveSubagents` 寫壞也起不來（以前是警告加預設值）。
 *
 * **它跟「關不掉」的名單（`plugin-config.ts` 的 `PROTECTED_ENTRY_NAMES`）是兩回事**：那一份只管能不能寫
 * `disabled: true`，以 `name` 為鍵；這一份管掉了要不要整個起不來，以 id 為鍵，照 dsh。以 id 為鍵繞不過去：patch
 * 改不動既有列的 id（`applyEntryPatches` 的解構），出貨那一列也關不掉；`insert` 一列同 `name`、換個 id 的，
 * 設定寫壞只是那一列掉，出貨那一列照樣在、照樣被 `startupSetting` 讀到。
 *
 * **兩個入口共用一份清單，所以 `browser-session` 寫壞連 CLI 也起不來**（偏離登記）：dsh 的終端機那側根本不掛
 * `connection`；我們照「用條目 id 比、名單不分入口」推下來，方向是起不來，不是放行。
 *
 * ## 帶 `--live` 時 `live-model` 也要在
 *
 * 不是名單的一員，是 dsh 的連鎖：`agent-loop` 硬要 `llm`（dsh `packages/core/agent-loop/src/index.ts:331`），
 * 可少掛的提供方掉了會讓必掛的使用方起不來（`README.zh.md:109`）。我們的使用方是帶 `--live` 的那次組裝。
 * **不退回設定格式的預設值**：那份預設的網址是對外的公開端點，會連同金鑰一起送出去。沒帶 `--live` 時那份值沒人用，
 * 印警告就好。
 *
 * @module
 */

import type { NexusPlugin, PluginEntry, PluginWarning } from '@nexus/core';

import type { AssemblyDrop, AssemblyDropError } from './agent-factory.js';
import { PluginConfigError } from './plugin-config.js';
import type { IgnoredConfig, LoadedPluginConfig, StartupDrop } from './plugin-config.js';

/**
 * 必掛的條目 id，對到出貨清單（`apps/harness/cordis.yml`）上那一列的 `id:`。**寫字面值、不借 plugin 名的常數**：
 * 兩者今天剛好相同，但比對的是條目 id，契約是 id。
 */
export const REQUIRED_ENTRY_IDS: ReadonlySet<string> = new Set([
  'browser-session',
  'system-prompt',
  'background-subagents',
  'permission-presets',
]);

/** 帶 `--live` 時也必須在的那一列的 id，理由見檔頭。 */
const LIVE_MODEL_ENTRY_ID = 'live-model';

/** 組裝點自己加的外掛不是清單上的列，警告裡模組那一格寫這個。 */
const ASSEMBLY_POINT = '組裝點';

/** 有必掛的列掉了：整個起不來。訊息連可少掛的一起列，照 dsh 的 `StartupError`。 */
export class StartupError extends PluginConfigError {
  /** 這一次掉了的全部，必掛與可少掛都在。 */
  readonly dropped: readonly StartupDrop[];

  constructor(message: string, dropped: readonly StartupDrop[]) {
    super(message);
    this.name = 'StartupError';
    this.dropped = dropped;
  }
}

/** 判定要用到的這一次呼叫的事。 */
export interface StartupAuditOptions {
  /** 帶了 `--live`：那時 `live-model` 那一列掉了也整個起不來。 */
  readonly live: boolean;
}

/**
 * 第一次判定：讀完清單時有必掛的掉了就拋。可少掛的掉了在這裡不印，等組裝完跟那一次的合成一段
 * （{@link startupWarning}）。
 *
 * @param loaded - `loadDefaultPlugins` 的結果。
 * @param options - 這一次呼叫的事。
 * @throws {StartupError} 有必掛的列掉了。
 */
export function auditStartupEntries(
  loaded: Pick<LoadedPluginConfig, 'dropped'>,
  options: StartupAuditOptions,
): void {
  const required = requiredIds(options);
  const count = loaded.dropped.filter((drop) => required.has(drop.id)).length;
  if (count > 0) {
    throw new StartupError(startupDiagnostic(loaded.dropped, required, count), loaded.dropped);
  }
}

/**
 * 組裝時可以少掛的條目：清單交出來的列裡，不在必掛名單上的那些。
 *
 * **只有清單交出來的列照名單判**（卡上第 2 項）：組裝點自己加的外掛（`host-services`、`sandbox-policy`……）不在
 * {@link LoadedPluginConfig.rows} 裡，所以不在這份裡，掉了照舊整個起不來。
 */
export function optionalEntriesOf(
  loaded: Pick<LoadedPluginConfig, 'rows'>,
  options: StartupAuditOptions,
): ReadonlySet<PluginEntry> {
  const required = requiredIds(options);
  return new Set(
    [...loaded.rows].filter(([, row]) => !required.has(row.id)).map(([entry]) => entry),
  );
}

/** 把組裝時掉了的列換成跟讀清單那一次同一種形狀：id 與模組名從清單查，組裝點的外掛查不到。 */
export function assemblyDropsOf(
  loaded: Pick<LoadedPluginConfig, 'rows'>,
  dropped: readonly AssemblyDrop[],
): StartupDrop[] {
  return dropped.map(({ entry, drop }) => ({
    id: drop.origin.id,
    module: loaded.rows.get(entry)?.module ?? ASSEMBLY_POINT,
    stage: drop.stage,
    message: drop.message,
    entry,
  }));
}

/**
 * 組裝時有不能少掛的掉了：換成跟第一次同一種 {@link StartupError}，讀清單那一次掉的與組裝這一次掉的一起列，
 * 不能少掛的標出來。
 */
export function startupErrorFrom(
  loaded: Pick<LoadedPluginConfig, 'dropped' | 'rows'>,
  error: AssemblyDropError,
  options: StartupAuditOptions,
): StartupError {
  const all = [...loaded.dropped, ...assemblyDropsOf(loaded, error.dropped)];
  const fatal = new Set(
    error.dropped.filter(({ entry }) => error.fatal.has(entry)).map(({ drop }) => drop.origin.id),
  );
  const required = new Set([...requiredIds(options), ...fatal]);
  const count = all.filter((drop) => required.has(drop.id)).length;
  return new StartupError(startupDiagnostic(all, required, count), all);
}

/**
 * 兩次合起來要印的那一段（可能是空的），照 dsh 的 `activationDiagnostic`。**呼叫端只印一次**：CLI 印到標準錯誤，
 * serve 印到伺服器日誌、在綁 port 之前。外掛在 `apply` 裡交出的警告（`registry.logger`）也印在同一段（卡上第 7 項）。
 *
 * @param loaded - `loadDefaultPlugins` 的結果。
 * @param assembled - 組裝那一次掉的（{@link assemblyDropsOf}）。
 * @param warnings - 組裝那一次外掛交出的警告。
 * @returns 那一段警告的每一行；沒有要講的就是空陣列。
 */
export function startupWarning(
  loaded: Pick<LoadedPluginConfig, 'dropped' | 'ignoredConfig' | 'rows'>,
  assembled: readonly StartupDrop[],
  warnings: readonly PluginWarning[] = [],
): readonly string[] {
  const lines = [...activationWarning([...loaded.dropped, ...assembled], loaded.ignoredConfig)];
  if (warnings.length > 0) {
    lines.push(`警告：${String(warnings.length)} 則外掛掛上時交出的話：`);
    for (const line of describeWarnings(loaded, warnings)) lines.push(`  ${line}`);
  }
  return lines;
}

/** 外掛交出的每一則警告一行（不帶縮排）：是誰（id 與模組名）、說了什麼。 */
export function describeWarnings(
  loaded: Pick<LoadedPluginConfig, 'rows'>,
  warnings: readonly PluginWarning[],
): readonly string[] {
  const modules = new Map([...loaded.rows.values()].map((row) => [row.id, row.module]));
  return warnings.map(
    ({ origin, message }) =>
      `${origin.id}（${modules.get(origin.id) ?? ASSEMBLY_POINT}）：${message}`,
  );
}

/**
 * 讀清單那一次掉了的、屬於這顆 plugin 的列，每列一行（不帶縮排）。
 *
 * 給組裝之前就要拋的錯自己帶上原因：那時合成的那一段警告還沒印（要等組裝完），錯誤只講「那一列沒掛上」的話，
 * 使用者看不到為什麼。
 */
export function dropReasonsOf<T>(
  loaded: Pick<LoadedPluginConfig, 'dropped'>,
  plugin: NexusPlugin<T>,
): readonly string[] {
  // 以名字比，同 `startupEntryMounted`：那一支判「沒掛」用的就是名字。
  return loaded.dropped.filter((drop) => drop.entry?.plugin.name === plugin.name).map(describeDrop);
}

/** 一列掉了的那一行，不帶縮排。serve 每條對話組裝時才掉的列用它記進伺服器日誌。 */
export function describeDrop(drop: StartupDrop): string {
  return dropLine(drop, false).trimStart();
}

function requiredIds(options: StartupAuditOptions): ReadonlySet<string> {
  return options.live ? new Set([...REQUIRED_ENTRY_IDS, LIVE_MODEL_ENTRY_ID]) : REQUIRED_ENTRY_IDS;
}

/** 起不來那一則，照 dsh 的 `startupDiagnostic`：必掛的標出來，可少掛的一起列。 */
function startupDiagnostic(
  dropped: readonly StartupDrop[],
  required: ReadonlySet<string>,
  requiredCount: number,
): string {
  const lines = [`起不來：${String(requiredCount)} 列必掛的沒有掛上。這一次掉了的全部：`];
  for (const drop of dropped) lines.push(dropLine(drop, required.has(drop.id)));
  return lines.join('\n');
}

/** 可少掛的沒起來、或寫了沒作用的 `config` 時那一段，照 dsh 的 `activationDiagnostic`。 */
function activationWarning(
  dropped: readonly StartupDrop[],
  ignored: readonly IgnoredConfig[],
): readonly string[] {
  const lines: string[] = [];
  if (dropped.length > 0) {
    lines.push(`警告：${String(dropped.length)} 列沒有掛上，其餘照樣起來：`);
    for (const drop of dropped) lines.push(dropLine(drop, false));
  }
  if (ignored.length > 0) {
    lines.push(
      `警告：${String(ignored.length)} 列寫的 config 沒有作用——那顆 plugin 沒有設定格式，那一列照樣掛：`,
    );
    for (const row of ignored) lines.push(`  ${row.id}（${row.module}）`);
  }
  return lines;
}

const STAGE_LABEL: Readonly<Record<StartupDrop['stage'], string>> = {
  module: '模組載不起來',
  config: '設定驗不過',
  apply: '掛上時失敗',
  requires: '要用的服務沒人提供',
};

function dropLine(drop: StartupDrop, required: boolean): string {
  return `  ${drop.id}（${drop.module}）${required ? '〔必掛〕' : ''}${STAGE_LABEL[drop.stage]}：${drop.message}`;
}
