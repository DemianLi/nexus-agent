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
 * 這個模組是那一步的產品路徑版：`loadPluginConfig` 交出掉了哪幾列，這裡拿名單判要不要整個起不來。
 *
 * ## 名單只有 `browser-session`
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

import { PluginConfigError } from './plugin-config.js';
import type { IgnoredConfig, LoadedPluginConfig, StartupDrop } from './plugin-config.js';

/**
 * 必掛的條目 id，對到出貨清單（`apps/harness/cordis.yml`）上那一列的 `id:`。**寫字面值、不借 plugin 名的常數**：
 * 兩者今天剛好相同，但比對的是條目 id，契約是 id。
 */
export const REQUIRED_ENTRY_IDS: ReadonlySet<string> = new Set(['browser-session']);

/** 帶 `--live` 時也必須在的那一列的 id，理由見檔頭。 */
const LIVE_MODEL_ENTRY_ID = 'live-model';

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
 * 套必掛名單：有必掛的掉了就拋，否則交出要印的那一段警告（可能是空的）。
 *
 * **呼叫端只印一次**：CLI 印到標準錯誤，serve 印到伺服器日誌、在綁 port 之前。
 *
 * @param loaded - `loadDefaultPlugins` 的結果。
 * @param options - 這一次呼叫的事。
 * @returns 那一段警告的每一行；沒有要講的就是空陣列。
 * @throws {StartupError} 有必掛的列掉了。
 */
export function auditStartupEntries(
  loaded: Pick<LoadedPluginConfig, 'dropped' | 'ignoredConfig'>,
  options: StartupAuditOptions,
): readonly string[] {
  const required = requiredIds(options);
  const fatal = loaded.dropped.filter((drop) => required.has(drop.id));
  if (fatal.length > 0) {
    throw new StartupError(
      startupDiagnostic(loaded.dropped, required, fatal.length),
      loaded.dropped,
    );
  }
  return activationWarning(loaded.dropped, loaded.ignoredConfig);
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
};

function dropLine(drop: StartupDrop, required: boolean): string {
  return `  ${drop.id}（${drop.module}）${required ? '〔必掛〕' : ''}${STAGE_LABEL[drop.stage]}：${drop.message}`;
}
