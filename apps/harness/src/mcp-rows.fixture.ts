/**
 * 測試用：mcp 的幾列，走部署方掛它的那條路取回來：寫成一份只有這幾列的清單，經 {@link loadPluginConfig} 解析成樹上函式插件的
 * 橋接列。組裝時（沒有樹）單獨掛一次，經出廠的授權表與宿主的 `runThreadSources`，跟產品路徑同一套。
 *
 * @module
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginEntry } from '@nexus/core';

import { loadPluginConfig } from './plugin-config.js';

/**
 * @param configs - 每一列的 `config`（照清單的寫法），照給的順序；列不寫 `id`，由組裝點照模組名補號。
 * @returns 那幾列的橋接列，照給的順序。
 * @throws 有列沒掛上，或寫了沒有作用的 `config`。
 */
export async function mcpRows(...configs: readonly unknown[]): Promise<readonly PluginEntry[]> {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-mcp-rows-'));
  try {
    const shipped = join(dir, 'cordis.yml');
    // JSON 是 YAML 的子集：config 原樣寫進去，字串裡的路徑與引號不必另外跳脫。
    const rows = configs.map(
      (config) => `- name: '@nexus/plugin-mcp'\n  config: ${JSON.stringify(config)}\n`,
    );
    writeFileSync(shipped, rows.join(''));
    const { plugins, dropped, ignoredConfig } = await loadPluginConfig({ shipped });
    const problems = [
      ...dropped.map((drop) => drop.message),
      ...ignoredConfig.map((row) => `${row.id} 寫了沒有作用的 config`),
    ];
    if (problems.length > 0) throw new Error(`mcp 的列沒掛上：${problems.join('；')}`);
    return plugins;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
