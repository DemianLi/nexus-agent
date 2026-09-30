/**
 * 背景續行的設定列（[#841](https://github.com/DemianLi/nexus-agent/issues/841)）：schema 預設是 `one-shot`（照 dsh），
 * **出貨的 `cordis.yml` 那一列才把它打開**——所以「沒有那一列／標成 disabled」回到今天的一次性。
 */

import type { PluginEntry } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import { PROTECTED_ENTRY_NAMES, loadPluginConfig } from '../plugin-config.js';
import {
  backgroundSubagentsConfigSchema,
  backgroundSubagentsPlugin,
  DEFAULT_MAX_ACTIVE_SUBAGENTS,
} from './background-subagents.js';
import { startupSetting } from './startup.js';

function row(config: unknown, disabled = false): PluginEntry {
  return {
    plugin: backgroundSubagentsPlugin as never,
    config,
    ...(disabled ? { disabled: true } : {}),
  };
}

describe('背景續行的設定列', () => {
  it('出貨的清單把它開成 continuable、上限 8', async () => {
    const { plugins } = await loadPluginConfig();
    expect(startupSetting(plugins, backgroundSubagentsPlugin)).toEqual({
      backgroundMode: 'continuable',
      maxActiveSubagents: 8,
    });
  });

  it('不在保護名單上：關得掉', () => {
    expect(PROTECTED_ENTRY_NAMES.has('#settings/background-subagents')).toBe(false);
  });

  it.each([
    ['沒有那一列', []],
    ['把那一列標成 disabled', [row({ backgroundMode: 'continuable' }, true)]],
    ['那一列沒寫 backgroundMode', [row({})]],
  ])('%s：回到今天的一次性', (_, plugins) => {
    expect(startupSetting(plugins, backgroundSubagentsPlugin)).toEqual({
      backgroundMode: 'one-shot',
      maxActiveSubagents: DEFAULT_MAX_ACTIVE_SUBAGENTS,
    });
  });

  it('改上限：讀到的就是那個值', () => {
    expect(
      startupSetting(
        [row({ backgroundMode: 'continuable', maxActiveSubagents: 3 })],
        backgroundSubagentsPlugin,
      ),
    ).toEqual({ backgroundMode: 'continuable', maxActiveSubagents: 3 });
  });

  it('上限不是 ≥ 1 的整數、模式不認得、多寫欄位：載入時就擋', () => {
    for (const bad of [
      { maxActiveSubagents: 0 },
      { maxActiveSubagents: 1.5 },
      { backgroundMode: 'background' },
      { backgroundMode: 'continuable', extra: 1 },
    ]) {
      expect(backgroundSubagentsConfigSchema.safeParse(bad).success).toBe(false);
    }
  });
});
