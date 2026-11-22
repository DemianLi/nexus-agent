/**
 * 子代理選模型的設定列（[#875](https://github.com/DemianLi/nexus-agent/issues/875)）：出廠關著；開著就必須有可挑的、
 * 不能重複；關著的清單不驗。
 */

import type { PluginEntry } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import { PROTECTED_ENTRY_NAMES, loadPluginConfig } from '../plugin-config.js';
import {
  subagentModelSelectionConfigSchema,
  subagentModelSelectionPlugin,
} from './subagent-model-selection.js';
import { startupSetting } from './startup.js';

function row(config: unknown, disabled = false): PluginEntry {
  return {
    plugin: subagentModelSelectionPlugin as never,
    config,
    ...(disabled ? { disabled: true } : {}),
  };
}

describe('子代理選模型的設定列', () => {
  it('出貨的清單把它關著、清單空', async () => {
    const { plugins } = await loadPluginConfig();
    expect(startupSetting(plugins, subagentModelSelectionPlugin)).toEqual({
      enabled: false,
      allowedModels: [],
    });
  });

  it.each([
    ['沒有那一列', []],
    ['把那一列標成 disabled', [row({ enabled: true, allowedModels: ['m'] }, true)]],
  ])('%s：回到 schema 的預設（關）', (_, plugins) => {
    expect(startupSetting(plugins, subagentModelSelectionPlugin)).toEqual({
      enabled: false,
      allowedModels: [],
    });
  });

  it('不在保護名單上：關得掉', () => {
    expect(PROTECTED_ENTRY_NAMES.has('#settings/subagent-model-selection')).toBe(false);
  });

  it('開著且有清單：讀到那份', () => {
    expect(
      startupSetting(
        [row({ enabled: true, allowedModels: ['a', 'b'] })],
        subagentModelSelectionPlugin,
      ),
    ).toEqual({ enabled: true, allowedModels: ['a', 'b'] });
  });

  it('開著卻空、或有重複：載入期失敗，訊息指名；關著的清單（含重複）不驗', () => {
    expect(() =>
      subagentModelSelectionConfigSchema.parse({ enabled: true, allowedModels: [] }),
    ).toThrow(/不能是空的/);
    expect(() =>
      subagentModelSelectionConfigSchema.parse({ enabled: true, allowedModels: ['a', 'a'] }),
    ).toThrow(/重複的模型/);
    expect(subagentModelSelectionConfigSchema.parse({ allowedModels: ['a', 'a'] })).toEqual({
      enabled: false,
      allowedModels: ['a', 'a'],
    });
  });

  it('多寫一個欄位是打錯字', () => {
    expect(() => subagentModelSelectionConfigSchema.parse({ enable: true })).toThrow();
  });
});
