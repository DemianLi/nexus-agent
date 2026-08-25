import { loadPlugins } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import { createEchoPlugin, ECHO_CAPABILITY, ECHO_TOOL_NAME } from './index.js';

/**
 * 薄測試，只斷言「`apply` 真的往那兩個註冊點放了東西」。
 *
 * 這個套件的真正驗收在組裝點（`apps/harness` 的正面路徑測試：一份清單 fold 出的
 * agent 真的呼叫得到這個工具）。這裡不重跑那條——重點是不要讓一個沒有測試的
 * package 通過 gate（[#32](https://github.com/DemianLi/nexus-agent/issues/32)：
 * `pnpm -r run test` 找不到測試檔就是紅燈）。
 */
describe('createEchoPlugin', () => {
  it('註冊 echo 工具並宣告 echo 能力', async () => {
    const { registry } = await loadPlugins([createEchoPlugin()]);

    expect(registry.capabilities.has(ECHO_CAPABILITY)).toBe(true);
    expect(registry.tools.resolve(ECHO_TOOL_NAME)?.value.name).toBe(ECHO_TOOL_NAME);
  });

  it('回聲帶上組裝點給的前綴', async () => {
    const { registry } = await loadPlugins([createEchoPlugin({ prefix: '聽到了' })]);
    const echo = registry.tools.resolve(ECHO_TOOL_NAME);

    await expect(echo?.value.invoke({ message: '嗨' })).resolves.toBe('聽到了：嗨');
  });
});
