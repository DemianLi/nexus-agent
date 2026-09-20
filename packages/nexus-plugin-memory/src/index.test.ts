import { loadPlugins } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import {
  createMemoryPlugin,
  DEFAULT_MEMORY_SOURCE,
  MEMORY_CAPABILITY,
  memoryPlugin,
} from './index.js';

/**
 * 薄測試，只斷言「`apply` 真的往那兩個註冊點放了東西」，加上這個套件自己拒絕的那一種。
 *
 * 記憶**真的有沒有進到 prompt** 的驗收在組裝點（`apps/harness` 的 `memory.test.ts`）
 * ——那裡看的是模型收到的 system prompt，這裡看的是 registry 的內容。兩件事。
 */
describe('createMemoryPlugin', () => {
  it('省略 sources 時註冊慣例路徑並宣告 memory 能力', async () => {
    const { registry } = await loadPlugins([createMemoryPlugin()]);

    expect(registry.capabilities.has(MEMORY_CAPABILITY)).toBe(true);
    expect(registry.memory.sources()).toEqual([DEFAULT_MEMORY_SOURCE]);
  });

  it('多來源照給的順序進 registry——基座依這個順序串進 prompt', async () => {
    const { registry } = await loadPlugins([
      createMemoryPlugin({ sources: ['/專案/AGENTS.md', '/AGENTS.md'] }),
    ]);

    expect(registry.memory.sources()).toEqual(['/專案/AGENTS.md', '/AGENTS.md']);
  });

  // 空清單與沒掛 plugin 在 fold 之後完全同形，所以差別必須在載入時就吵出來。
  // **翻面過的絆索**（#453）：原本是工廠當場拋。
  it('空的 sources 讓載入失敗，不會靜默變成「沒有記憶」', async () => {
    const bad = [createMemoryPlugin({ sources: [] })];
    await expect(loadPlugins(bad)).rejects.toThrow('memory#0 (memory)');
    await expect(loadPlugins(bad)).rejects.toThrow('空的來源清單');
  });

  it('未知欄位讓載入失敗（登記的偏離：dsh 放行）', async () => {
    await expect(
      loadPlugins([{ plugin: memoryPlugin, config: { source: ['/AGENTS.md'] } }]),
    ).rejects.toThrow(/source\b/);
  });
});
