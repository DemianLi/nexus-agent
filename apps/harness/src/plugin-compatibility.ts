/**
 * 插件與執行中的 `@nexus/core` 相不相容，**在 import 之前**判
 * （[#1137](https://github.com/DemianLi/nexus-agent/issues/1137)）。
 *
 * 照 dsh `packages/boot/app-boot/src/plugin-compatibility.ts`：只讀插件 manifest 的 `peerDependencies['@nexus/core']`，用 `semver`
 * 對執行中的版本，不 import 插件程式碼；範圍寫壞或 manifest 讀不了都拒絕（檢查不了的東西不當成檢查過了）。
 *
 * **與 dsh 的偏離（AGENTS.md 的偏離規則）：**
 *
 * - dsh 在 `plugin-manager` 於 pnpm 安裝之前判（`pnpm view` 或讀 path spec 的 manifest）；我們沒有安裝流程，判在載入器
 *   （{@link ./plugin-config.ts | resolveEntryModule}）import 之前。表達得出來，只是時機晚到「讀設定」，而不是「安裝」。
 * - **沒有豁免機制。** dsh 的 `compatibility.json`（鍵是精確的 `package@version`、值是精確的 runtime 版本）我們不做：
 *   第一版沒有人需要放行一個宣告不相容的插件。要做時照 dsh 的形狀，不要另發明。
 * - 只檢查 `file:` 開頭的條目。出貨清單的 `name` 全是裸 specifier（`@nexus/*`），跟 core 同一棵 workspace，版本由 pnpm 一起解。
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
 * @param runtimeVersion - 執行中的 `@nexus/core` 版本。
 * @throws {PluginCompatibilityError} 範圍不滿足、範圍不合法，或 manifest 讀不了／不是物件。
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
  const { name, version, peerDependencies } = manifest as {
    name?: unknown;
    version?: unknown;
    peerDependencies?: unknown;
  };
  if (peerDependencies === undefined) return;
  if (
    peerDependencies === null ||
    typeof peerDependencies !== 'object' ||
    Array.isArray(peerDependencies)
  ) {
    throw new PluginCompatibilityError(`${manifestPath} 的 peerDependencies 不是一張表`);
  }
  const range = (peerDependencies as Record<string, unknown>)['@nexus/core'];
  if (range === undefined) return;
  const identity =
    typeof name === 'string' && typeof version === 'string' ? `${name}@${version}` : manifestPath;
  if (typeof range !== 'string' || semver.validRange(range) === null) {
    throw new PluginCompatibilityError(
      `${identity} 的 peerDependencies["@nexus/core"] 是 ${JSON.stringify(range)}，不是合法的 semver 範圍`,
    );
  }
  if (semver.valid(runtimeVersion) === null) {
    throw new PluginCompatibilityError(
      `執行中的 @nexus/core 版本 ${runtimeVersion} 不是合法的 semver，檢查不了相容性`,
    );
  }
  // `includePrerelease`：執行中的版本是 `1.0.0-rc.1` 時，`>=1.0.0-rc.0` 的插件應該放行。
  if (!semver.satisfies(runtimeVersion, range, { includePrerelease: true })) {
    throw new PluginCompatibilityError(
      `${identity} 需要 @nexus/core ${range}，執行中的是 ${runtimeVersion}`,
    );
  }
}
