import { loadPlugins } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import {
  createSkillsPlugin,
  DEFAULT_SKILLS_SOURCE,
  SKILLS_CAPABILITY,
  skillsPlugin,
} from './index.js';

/**
 * 薄測試，只斷言「`apply` 真的往那兩個註冊點放了東西」，加上這個套件自己拒絕的那一種。
 *
 * skill **真的有沒有進到 prompt**、以及「看得到讀不到」那條，驗收在組裝點
 * （`apps/harness` 的 `skills.test.ts`）——那裡看的是模型收到的 system prompt 與工具
 * 回傳，這裡看的是 registry 的內容。兩件事。
 */
describe('createSkillsPlugin', () => {
  it('省略 sources 時註冊慣例路徑並宣告 skills 能力', async () => {
    const { registry } = await loadPlugins([createSkillsPlugin()]);

    expect(registry.capabilities.has(SKILLS_CAPABILITY)).toBe(true);
    expect(registry.skills.sources()).toEqual([DEFAULT_SKILLS_SOURCE]);
  });

  it('多來源照給的順序進 registry——順序即優先序，後者覆蓋同名 skill', async () => {
    const { registry } = await loadPlugins([
      createSkillsPlugin({ sources: ['/skills/內建/', '/skills/專案/'] }),
    ]);

    expect(registry.skills.sources()).toEqual(['/skills/內建/', '/skills/專案/']);
  });

  // 空清單與沒掛 plugin 在 fold 之後完全同形，所以差別必須在載入時就吵出來。
  // **翻面過的絆索**（#453）：原本是工廠當場拋。
  it('空的 sources 讓載入失敗，不會靜默變成「沒有 skill」', async () => {
    const bad = [createSkillsPlugin({ sources: [] })];
    await expect(loadPlugins(bad)).rejects.toThrow('skills#0 (skills)');
    await expect(loadPlugins(bad)).rejects.toThrow('空的來源清單');
  });

  it('未知欄位讓載入失敗（登記的偏離：dsh 放行）', async () => {
    await expect(
      loadPlugins([{ plugin: skillsPlugin, config: { source: ['/skills/'] } }]),
    ).rejects.toThrow(/source\b/);
  });
});
