/**
 * 插件與執行中的 nexus 相不相容，**在 import 之前**判
 * （[#1137](https://github.com/DemianLi/nexus-agent/issues/1137)、[#1568](https://github.com/DemianLi/nexus-agent/issues/1568)）。
 *
 * 照 dsh `packages/boot/app-boot/src/plugin-compatibility.ts`（`687f282e`，`unmetRequirements` 在 `:55-74`）：只讀插件 manifest，用 `semver`
 * 對執行中的版本，不 import 插件程式碼。判法：
 *
 * - 插件自己有 `engines.nexus` → **只看它**，`peerDependencies` 不看；它不滿足就擋，形狀不是字串就拋。
 * - 否則逐一走 `peerDependencies`，凡是「跟 runtime 同版號的家族」（`@nexus/core`、`@nexus/sdk`、`@nexus/tools`…，
 *   見 {@link isRuntimeFamily}）都要滿足執行中的版本，**全部**不滿足的一次列出。
 * - peer 寫 `workspace:^`、`workspace:~`、`workspace:*`（從 repo 裡的出貨插件複製出去的 `package.json` 就是這樣）視為「執行中的版本」。
 *   `engines.nexus` 寫 `workspace:` 不算（dsh 同）。
 * - 範圍是空字串或不合法的，算不滿足（`includePrerelease: true`）；欄位**形狀**不對（`engines` 不是物件、`engines.nexus` 或某個 peer 的範圍不是字串、
 *   `peerDependencies` 不是表、manifest 讀不了）一律拒絕——檢查不了的東西不當成檢查過了。
 *
 * **家族的劃法。** dsh 用名字劃出「跟 runtime 同版號」的一家（`@deepseek-ai/dsh` 與 `@deepseek-ai/dsh-*`），Cordis 在家族外：它有自己的版號。
 * nexus 的 vendor 在 #1403 搬進了 `@nexus` scope，版號仍是上游的（`@nexus/cordis` 4.0.0-rc.12 之類），所以用名單把它們排出去；
 * 名單由 `plugin-compatibility.test.ts` 對照 `vendor/` 底下每一份 `package.json` 的 `name` 釘住，多一個少一個都會紅。劃出來的是同一個家族。
 *
 * **與 dsh 的偏離（AGENTS.md 的偏離規則）：**
 *
 * - dsh 在 `plugin-manager` 於 pnpm 安裝之前判（`pnpm view` 或讀 path spec 的 manifest）；我們沒有安裝流程，判在載入器
 *   （{@link ./plugin-config.ts | resolveEntryModule}）import 之前。表達得出來，只是時機晚到「讀設定」，而不是「安裝」。
 * - **沒有豁免機制。** dsh 的 `compatibility.json`（鍵是精確的 `package@version`、值是精確的 runtime 版本）我們不做：
 *   第一版沒有人需要放行一個宣告不相容的插件。要做時照 dsh 的形狀，不要另發明。dsh 警告句裡「怎麼豁免」那一段因此不抄，
 *   「可能崩潰或遺失資料」的風險說明照抄。
 * - 只檢查 `file:` 開頭的條目。出貨清單的 `name` 全是裸 specifier（`@nexus/*`），跟 core 同一棵 workspace，版本由 pnpm 一起解。
 *
 * **前提：所有成員同一個版號**（#1502 的 bump 腳本把同一個版號寫進每一份 manifest；今天開發樹裡每一份都是 `0.0.0`）。執行中的版本取
 * `NEXUS_CORE_VERSION`，它就等於 dsh 的 runtime 版本。
 *
 * @module
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import semver from 'semver';

/** 插件宣告不相容，或相容性檢查本身做不下去。 */
export class PluginCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginCompatibilityError';
  }
}

/**
 * `vendor/` 底下的上游套件：住在 `@nexus` scope 裡，版號是上游的，**不跟 runtime 同版**。
 * `plugin-compatibility.test.ts` 對照 `vendor/` 底下每一份 `package.json` 的 `name` 釘住這份名單。
 */
export const VENDORED_PACKAGE_NAMES: readonly string[] = [
  '@nexus/cordis',
  '@nexus/cordis-plugin-include',
  '@nexus/cordis-plugin-loader',
  '@nexus/cordis-plugin-logger-console',
];

/** 這個 peer 名字是不是「跟 runtime 同版號的家族」：`@nexus/` 底下、不在 {@link VENDORED_PACKAGE_NAMES} 的套件。 */
export function isRuntimeFamily(name: string): boolean {
  return name.startsWith('@nexus/') && !VENDORED_PACKAGE_NAMES.includes(name);
}

/** 不相容的結果：哪些需求執行中的版本不滿足。 */
export interface PluginCompatibility {
  readonly name: string;
  readonly version: string;
  readonly runtimeVersion: string;
  /** 只有不滿足的：鍵是 `engines.nexus` 或 peer 的套件名，值是插件寫的範圍原文。 */
  readonly requirements: Readonly<Record<string, string>>;
}

function objectOf(value: unknown, field: string, source: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PluginCompatibilityError(`${source} 的 ${field} 不是一張表，檢查不了相容性`);
  }
  return value as Record<string, unknown>;
}

function satisfies(runtimeVersion: string, range: string): boolean {
  return (
    range.trim() !== '' && semver.satisfies(runtimeVersion, range, { includePrerelease: true })
  );
}

function unmetRequirements(
  fields: Record<string, unknown>,
  runtimeVersion: string,
  source: string,
): Record<string, string> {
  const engines = Object.hasOwn(fields, 'engines')
    ? objectOf(fields.engines, 'engines', source)
    : {};
  if (Object.hasOwn(engines, 'nexus')) {
    const range = engines.nexus;
    if (typeof range !== 'string') {
      throw new PluginCompatibilityError(`${source} 的 engines.nexus 不是字串，檢查不了相容性`);
    }
    return satisfies(runtimeVersion, range) ? {} : { 'engines.nexus': range };
  }
  if (!Object.hasOwn(fields, 'peerDependencies')) return {};
  const dependencies = objectOf(fields.peerDependencies, 'peerDependencies', source);
  const unmet: Record<string, string> = {};
  for (const [name, range] of Object.entries(dependencies)) {
    if (typeof range !== 'string') {
      throw new PluginCompatibilityError(
        `${source} 的 peerDependencies[${JSON.stringify(name)}] 不是字串，檢查不了相容性`,
      );
    }
    if (!isRuntimeFamily(name)) continue;
    const requirement = ['workspace:^', 'workspace:~', 'workspace:*'].includes(range)
      ? runtimeVersion
      : range;
    if (!satisfies(runtimeVersion, requirement)) unmet[name] = range;
  }
  return unmet;
}

function identityField(
  fields: Record<string, unknown>,
  field: 'name' | 'version',
  source: string,
  unmet: string,
): string {
  const value = Object.hasOwn(fields, field) ? fields[field] : undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PluginCompatibilityError(
      `${source} 的 ${field} 要是非空字串：插件與執行中的 nexus 不相容（需要 ${unmet}）時，要指得出是哪一個插件`,
    );
  }
  return value;
}

const listOf = (requirements: Readonly<Record<string, string>>): string =>
  Object.entries(requirements)
    .map(([name, range]) => `${name} ${range}`)
    .join('、');

/**
 * 判一份插件 manifest 對執行中的版本相不相容（不碰檔案系統）。
 *
 * @param manifest - 解析過的 `package.json`；繼承來的欄位不算。
 * @param runtimeVersion - 執行中的 nexus 版本。
 * @param source - 訊息裡指這份 manifest 的字（通常是路徑）。
 * @returns 全部滿足回 `undefined`；否則是不滿足的需求。
 * @throws {PluginCompatibilityError} 版本不是合法 semver、欄位形狀不對，或不滿足時 `name`／`version` 不是非空字串。
 */
export function evaluatePluginCompatibility(
  manifest: unknown,
  runtimeVersion: string,
  source = 'manifest',
): PluginCompatibility | undefined {
  if (semver.valid(runtimeVersion) === null) {
    throw new PluginCompatibilityError(
      `執行中的 nexus 版本 ${runtimeVersion} 不是合法的 semver，檢查不了相容性`,
    );
  }
  const fields = objectOf(manifest, 'manifest', source);
  const requirements = unmetRequirements(fields, runtimeVersion, source);
  if (Object.keys(requirements).length === 0) return undefined;
  const unmet = listOf(requirements);
  return {
    name: identityField(fields, 'name', source, unmet),
    version: identityField(fields, 'version', source, unmet),
    runtimeVersion,
    requirements,
  };
}

/** 從模組檔往上找最近的 `package.json`；找不到回傳 `undefined`。 */
function findManifest(modulePath: string): string | undefined {
  let dir = dirname(modulePath);
  const root = parse(dir).root;
  for (;;) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) return candidate;
    if (dir === root) return undefined;
    dir = dirname(dir);
  }
}

/**
 * 判一個插件模組檔相容不相容。
 *
 * @param modulePath - 模組檔的本機路徑。
 * @param runtimeVersion - 執行中的 nexus 版本（`NEXUS_CORE_VERSION`）。
 * @throws {PluginCompatibilityError} 有需求不滿足（訊息列出全部）、欄位形狀不對，或 manifest 讀不了／不是物件。
 */
export function assertPluginCompatible(modulePath: string, runtimeVersion: string): void {
  const manifestPath = findManifest(modulePath);
  // 沒有 manifest 的單檔插件沒有可宣告的地方，放行。
  if (manifestPath === undefined) return;
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new PluginCompatibilityError(
      `讀不了 ${manifestPath}（${String(error)}），檢查不了相容性`,
    );
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new PluginCompatibilityError(`${manifestPath} 不是一個 JSON 物件，檢查不了相容性`);
  }
  const issue = evaluatePluginCompatibility(manifest, runtimeVersion, manifestPath);
  if (issue === undefined) return;
  throw new PluginCompatibilityError(
    `${issue.name}@${issue.version} 需要 ${listOf(issue.requirements)}，執行中的是 ${runtimeVersion}。` +
      '硬跑可能崩潰或遺失資料；請更新插件，或換一個與這個版本相容的插件。',
  );
}
