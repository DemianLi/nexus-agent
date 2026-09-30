/**
 * 外溢層的設定列（[#719](https://github.com/DemianLi/nexus-agent/issues/719)）：**關得掉**，而且關的寫法都導到同一個結果——
 * `maxInlineTokens` 是 `undefined`，組裝點就不掛外溢層（超過 80,000 字元的仍由基座換成預覽）。
 */

import type { PluginEntry } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import { PROTECTED_ENTRY_NAMES, loadPluginConfig } from '../plugin-config.js';
import { spillPolicyPlugin, spillPolicyConfigSchema } from './spill-policy.js';
import { startupSetting } from './startup.js';

function row(config: unknown, disabled = false): PluginEntry {
  return { plugin: spillPolicyPlugin as never, config, ...(disabled ? { disabled: true } : {}) };
}

describe('外溢層的設定列', () => {
  it('出貨的清單把它開在 12500', async () => {
    const { plugins } = await loadPluginConfig();
    expect(startupSetting(plugins, spillPolicyPlugin)).toEqual({ maxInlineTokens: 12_500 });
  });

  it('不在保護名單上：關得掉', () => {
    expect(PROTECTED_ENTRY_NAMES.has('#settings/spill-policy')).toBe(false);
  });

  it.each([
    ['沒有那一列', []],
    ['把那一列標成 disabled', [row({ maxInlineTokens: 12_500 }, true)]],
    ['那一列刪掉 maxInlineTokens', [row({})]],
  ])('%s：外溢層停用（maxInlineTokens 是 undefined）', (_, plugins) => {
    expect(startupSetting(plugins, spillPolicyPlugin).maxInlineTokens).toBeUndefined();
  });

  it('改小預算：讀到的就是那個值', () => {
    expect(startupSetting([row({ maxInlineTokens: 4_000 })], spillPolicyPlugin)).toEqual({
      maxInlineTokens: 4_000,
    });
  });

  it('太小（連通知都放不下）或多寫欄位：載入時就擋', () => {
    expect(() => spillPolicyConfigSchema.parse({ maxInlineTokens: 10 })).toThrow();
    expect(() => spillPolicyConfigSchema.parse({ maxInlineTokens: 12_500, typo: 1 })).toThrow();
  });
});
