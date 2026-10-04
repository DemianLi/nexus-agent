/**
 * 會話日誌 header 的建置中繼資料：建置版本、插件清單、設定雜湊（[#1025](https://github.com/DemianLi/nexus-agent/issues/1025)）。
 *
 * 寫的一側（{@link resolveSessionHeaderMetadata}）由 `cli.ts` 與 `serve.ts` 在起動期各叫一次，結果交給 `@nexus/core` 的
 * `attachSessionPersistence`；讀的一側（{@link readSessionHeaderMetadata}、{@link formatSessionHeaderMetadata}）給離線掃描。
 *
 * ## 三個來源，都不另造
 *
 * - **建置版本**：`build-version.ts`，跟 eval 結果檔（#1000）同一支。
 * - **插件清單**：`loadDefaultPlugins` 交出來的 {@link LoadedPluginConfig.entries}——`--dump-config` 印的那一份。投影只留
 *   `name`、`id`、`disabled`。
 * - **設定雜湊**：同一份清單整份（含 `config`）的穩定序列化（`stable-stringify.ts`，同 eval 的題庫版本），取**帶鍵**的
 *   HMAC-SHA256。
 *
 * ## 為什麼雜湊要帶鍵
 *
 * 設定可能含金鑰或內網位址，所以內容不進日誌。但**無鍵雜湊也不安全**：出貨的 `cordis.yml` 在 repo 裡，誰都拿得到，一台
 * 機器上的未知數常常只剩 patch 裡的一兩個值——一個 `10.x.x.x` 的端點是兩千萬種可能，逐一算雜湊對上日誌只要幾秒。帶鍵之後
 * 拿到日誌的人沒有鍵，算不出任何一個候選的雜湊。
 *
 * 代價：**雜湊只能跟同一個 harness home 寫的比**。鍵是 home 底下的 {@link CONFIG_HASH_KEY_FILE}，讀寫規矩同瀏覽器會話密鑰
 * （`browser-session-secret.ts`），但是另一把：刪掉瀏覽器那一把是撤銷會話的開關，不該順便換掉每一份日誌的設定雜湊。
 * 鍵讀不到（權限過寬、內容認不得、建不出來）只少雜湊那一格並講一聲，不擋啟動——它是描述，不是功能。
 *
 * ## 與 dsh 的關係
 *
 * dsh 的 `SessionHeader`（`packages/core/session/src/types.ts:94-131`，`5badb15`）只有 `version`、`id`、`createdAt`、`cwd`、
 * `parentSession`、`isSeeded`、`origin`、`delegationDepth`、`agentPreset`，**沒有建置版本、插件清單或設定雜湊**；它唯一記
 * 程式版本的地方是啟動失敗的診斷報告（`apps/cli/src/startup-diagnostics.ts`，`dshVersion`），而那份報告明寫「不收環境變數與
 * plugin 設定」——不放設定內容是同一個立場。所以這三格是標準沒有的功能，照卡片要求加；形狀上比照 `agentPreset`：建立時定下、
 * 之後不變的組成身分。
 *
 * @module
 */

import { createHmac } from 'node:crypto';
import { join } from 'node:path';

import type {
  SessionHeaderBuildMetadata,
  StoredSessionBuild,
  StoredSessionHeader,
  StoredSessionPluginRow,
} from '@nexus/core';

import { outsideWorkspace } from './assembly-root.js';
import { loadOrCreateHomeSecret, type HomeSecretRole } from './browser-session-secret.js';
import { processBuildVersion } from './build-version.js';
import { resolveHarnessHome } from './harness-home.js';
import type { ConfigEntry } from './plugin-config.js';
import { stableStringify } from './stable-stringify.js';

/** 設定雜湊的鍵在 harness home 底下的檔名。 */
export const CONFIG_HASH_KEY_FILE = 'config-hash-key.json';

const CONFIG_HASH_KEY_ROLE: HomeSecretRole = {
  file: CONFIG_HASH_KEY_FILE,
  label: '設定雜湊的鍵檔',
  resetHint: '要重設就刪掉它——之後寫的日誌設定雜湊會換一套，跟之前的比不起來。',
};

/** 雜湊的前綴：換演算法或長度時讀的人分得出來。 */
export const CONFIG_HASH_PREFIX = 'hmac-sha256:';

/** 取前 16 個十六進位字元（64 位元）：給人比「兩份是不是同一套設定」，不拿來防偽。 */
const CONFIG_HASH_HEX_LENGTH = 16;

/**
 * 疊完的清單投影成 header 的插件清單：每一列只留 `name`、`id`、`disabled`，**不帶 `config`**。
 *
 * @param entries - {@link LoadedPluginConfig.entries}，或 `--dump-config` 印出來再讀回的那一份。
 * @returns 照清單順序的每一列。
 */
export function pluginRowsOf(entries: readonly ConfigEntry[]): StoredSessionPluginRow[] {
  return entries.map((entry) => ({
    name: entry.name,
    ...(entry.id !== undefined && { id: entry.id }),
    disabled: entry.disabled === true,
  }));
}

/**
 * 整份清單（含 `config`）的帶鍵雜湊。
 *
 * @param entries - 疊完的清單。
 * @param key - {@link CONFIG_HASH_KEY_FILE} 那一把。
 * @returns `hmac-sha256:<16 個十六進位字元>`。
 */
export function configHashOf(entries: readonly ConfigEntry[], key: Uint8Array): string {
  const digest = createHmac('sha256', key).update(stableStringify(entries)).digest('hex');
  return `${CONFIG_HASH_PREFIX}${digest.slice(0, CONFIG_HASH_HEX_LENGTH)}`;
}

/** {@link resolveSessionHeaderMetadata} 的輸入。 */
export interface ResolveSessionHeaderMetadataOptions {
  /** {@link LoadedPluginConfig.entries}。 */
  readonly entries: readonly ConfigEntry[];
  /** 決定 harness home 落在哪，同 `loadDefaultPlugins`。 */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** 鍵讀不到時往哪裡講。 */
  readonly warn: (message: string) => void;
  /** 建置版本，省略即 {@link processBuildVersion}。測試注入，不靠跑測試那台機器有沒有 `.git`。 */
  readonly build?: StoredSessionBuild;
  /** `--workspace` 原樣與解析它的 cwd：鍵檔落在工作區底下就不用它，同不變量量測記錄那條（`resolveInvariantLogPath`）。 */
  readonly workspace?: string;
  readonly cwd: string;
}

/**
 * 算一次這個行程每一份新 header 都帶的那三格。**只在會落盤時叫**：落盤關掉的啟動不該在 home 底下建鍵檔。
 *
 * @param options - 清單、env、警告出口。
 * @returns 建置版本、插件清單，與雜湊（鍵讀不到就沒有這一格）。
 */
export async function resolveSessionHeaderMetadata(
  options: ResolveSessionHeaderMetadataOptions,
): Promise<SessionHeaderBuildMetadata> {
  const build = options.build ?? processBuildVersion();
  const plugins = pluginRowsOf(options.entries);
  let key: Buffer;
  try {
    const home = resolveHarnessHome(options.env);
    // 鍵檔落在工作區底下的話模型讀得到也改得動它，帶鍵就沒有意義：不建、不用。
    outsideWorkspace(
      join(home, CONFIG_HASH_KEY_FILE),
      options.workspace,
      options.cwd,
      '設定雜湊的鍵檔',
    );
    key = await loadOrCreateHomeSecret(home, CONFIG_HASH_KEY_ROLE);
  } catch (error) {
    options.warn(
      `會話日誌的 header 這一次不記設定雜湊：${error instanceof Error ? error.message : String(error)}`,
    );
    return { build, plugins };
  }
  return { build, plugins, configHash: configHashOf(options.entries, key) };
}

// ───────────────────────── 讀的一側 ─────────────────────────

/**
 * 從一份已存的 header 讀回那四格。**判準是那一格在不在，不是 `version`**（續接會把舊檔的版本蓋成這一版而不回填）。
 *
 * 讀的是磁碟上的東西，形狀不對的那一格當成沒記，不拋：一格描述壞掉不該讓整份讀不了，`parseHeader` 也因此不驗這幾格。
 */
export interface SessionHeaderMetadataView {
  readonly build?: StoredSessionBuild;
  readonly plugins?: readonly StoredSessionPluginRow[];
  readonly configHash?: string;
  readonly modelEntryId?: string;
}

function isBuild(value: unknown): value is StoredSessionBuild {
  if (typeof value !== 'object' || value === null) return false;
  const { commit, dirty } = value as Record<string, unknown>;
  return (
    (commit === null || typeof commit === 'string') &&
    (dirty === null || typeof dirty === 'boolean')
  );
}

function isPluginRow(value: unknown): value is StoredSessionPluginRow {
  if (typeof value !== 'object' || value === null) return false;
  const { name, id, disabled } = value as Record<string, unknown>;
  return (
    typeof name === 'string' &&
    (id === undefined || typeof id === 'string') &&
    typeof disabled === 'boolean'
  );
}

/**
 * 讀回 header 上的建置中繼資料，見 {@link SessionHeaderMetadataView}。
 *
 * @param header - 讀回來的 header，原樣（舊版、或別的東西寫的都可能）。
 * @returns 形狀對得上的那幾格。
 */
export function readSessionHeaderMetadata(
  header: Pick<StoredSessionHeader, 'build' | 'plugins' | 'configHash' | 'modelEntryId'>,
): SessionHeaderMetadataView {
  const { build, plugins, configHash, modelEntryId } = header as Record<string, unknown>;
  return {
    ...(isBuild(build) && { build }),
    ...(Array.isArray(plugins) && plugins.every(isPluginRow) && { plugins }),
    ...(typeof configHash === 'string' && { configHash }),
    ...(typeof modelEntryId === 'string' && { modelEntryId }),
  };
}

/** 報表上 commit 的長度，同 git 的短 SHA。 */
const SHORT_COMMIT = 12;

/**
 * 印成報表上的一行。**沒記的格是「—」**（同離線掃描其餘欄位的慣例），記了但取不到的是「取不到」——那一格在，只是寫的那
 * 一刻沒有 git，兩件事不一樣。
 *
 * @param view - {@link readSessionHeaderMetadata} 的結果。
 * @returns 一行，不含縮排。
 */
export function formatSessionHeaderMetadata(view: SessionHeaderMetadataView): string {
  const build =
    view.build === undefined
      ? '—'
      : `${view.build.commit === null ? '取不到' : view.build.commit.slice(0, SHORT_COMMIT)}` +
        `（未提交的改動：${view.build.dirty === null ? '取不到' : view.build.dirty ? '有' : '無'}）`;
  const plugins =
    view.plugins === undefined
      ? '—'
      : `${view.plugins.length} 列（停用 ${view.plugins.filter((row) => row.disabled).length}）`;
  return (
    `建置 ${build} ｜模型 ${view.modelEntryId ?? '—'} ｜插件 ${plugins} ｜` +
    `設定雜湊 ${view.configHash ?? '—'}`
  );
}
