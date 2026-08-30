import { loadPlugins } from '@nexus/core';
import type { ToolExecution } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import {
  createPlanModePlugin,
  EXIT_PLAN_MODE_TOOL_NAME,
  PLAN_MODE_CAPABILITY,
  PLAN_MODE_MIDDLEWARE_NAME,
} from './index.js';

/**
 * 薄測試，只斷言「`apply` 真的往那四個註冊點放了東西」，加上兩條**順序**的斷言。
 *
 * 計劃模式**真的有沒有作用**的驗收在組裝點（`apps/harness` 的 `plan-mode.test.ts`）
 * ——那裡看的是模型收到的 prompt 與跑完之後的 state，這裡看的是 registry 的內容。
 */
describe('createPlanModePlugin', () => {
  it('四個註冊點都放了東西', async () => {
    const { registry } = await loadPlugins([createPlanModePlugin()]);

    expect(registry.capabilities.has(PLAN_MODE_CAPABILITY)).toBe(true);
    expect([...registry.tools.effective().keys()]).toContain(EXIT_PLAN_MODE_TOOL_NAME);
    expect(registry.middleware.list().map((entry) => entry.value.middleware.name)).toEqual([
      PLAN_MODE_MIDDLEWARE_NAME,
    ]);
    expect(registry.approvals.listeners()).toHaveLength(1);
  });

  /**
   * **`prepend` 不是偏好。** 沒有它，`fold` 會把這個 middleware 排到核准閘門**之後**，
   * 於是一次模式外的 `exit_plan_mode` 會先撞上閘門——headless 入口回的是「沒有人被
   * 問到」，而真正的原因是「你不在計劃模式」。順序決定模型看到哪一句。
   */
  it('middleware 是 prepend 的', async () => {
    const { registry } = await loadPlugins([createPlanModePlugin()]);

    expect(registry.middleware.list()[0]?.value.prepend).toBe(true);
  });

  /** 閘門只認自己那一個工具名，其餘一律往下傳——不呼叫 `next()` 就會把別人短路掉。 */
  it('閘門只對 exit_plan_mode 要核准，別的工具原樣往下傳', async () => {
    const { registry } = await loadPlugins([createPlanModePlugin()]);
    const listener = registry.approvals.listeners()[0]?.value;
    if (listener === undefined) throw new Error('沒有掛上 listener');

    const exec = (name: string): ToolExecution => ({ name, args: {}, callId: 'c1' });
    const fellThrough = { kind: 'allow' } as const;

    // listener 對自己那個工具是**同步**回答的（沒有 `next()` 要等），所以兩邊都先
    // `Promise.resolve` 包一層——`.resolves` 收不了裸物件。
    const decide = async (name: string): Promise<unknown> =>
      Promise.resolve(listener(exec(name), () => Promise.resolve(fellThrough)));

    expect(await decide(EXIT_PLAN_MODE_TOOL_NAME)).toMatchObject({ kind: 'ask' });
    expect(await decide('echo')).toEqual(fellThrough);
  });
});
