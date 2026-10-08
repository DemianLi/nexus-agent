/**
 * 這顆 plugin 的**單元**驗收：政策那句話本身，以及它對協作者的硬相依。
 *
 * **走得到組裝的那幾條不在這裡**——「掛了 `--workspace` 的組裝真的把那句話送進 system
 * prompt」「沒有 `--workspace` 只講不宣稱圍堵的那一句」「`--sandbox` 旗標兩個入口收下同一個值」
 * 都要跑得起一個 agent 或一個 CLI 解析器，那些留在 `@nexus/harness` 的
 * `sandbox-policy.test.ts`。**這條分界是 import 畫的，不是口味**：套件 import 不到 app，
 * 硬要搬就得把那些斷言改寫成替身，而那是拿一組較弱的測試去換一條套件邊界。
 *
 * @module
 */

import { describe, expect, it } from 'vitest';

import { createHostServicesPlugin, loadPlugins } from '@nexus/core';

import { CONTAINED_FILESYSTEM, createSandboxPolicyPlugin, sandboxPolicySentence } from './index.js';
import { SandboxModeController } from './sandbox-mode.js';

describe('政策那句話本身', () => {
  it('三格各有各的話，沒有一格漏掉', () => {
    expect(sandboxPolicySentence('read-only')).toContain('read-only');
    expect(sandboxPolicySentence('workspace-write')).toContain('`/` 就是工作區根');
    expect(sandboxPolicySentence('danger-full-access')).toContain('不限制');
  });

  it('read-only 那句叫模型照升級指引做，但不在提示句裡講模式名', () => {
    const sentence = sandboxPolicySentence('read-only');
    expect(sentence).toContain('升級指引');
    expect(sentence).not.toContain('workspace-write');
    expect(sentence).not.toContain('danger-full-access');
  });
});

/**
 * **有圍堵時，控制器是硬相依**（[#459](https://github.com/DemianLi/nexus-agent/issues/459)、[#669](https://github.com/DemianLi/nexus-agent/issues/669)）：
 * 控制器與可寫根走服務注入，有圍堵而這顆 plugin 沒有它們一件事都做不了——所以缺件是**載入失敗**，不是
 * 靜靜地少掛半套。沒有圍堵（`fsContainment` 服務不在）時它不需要控制器，只貢獻那一句政策。
 *
 * 各守一半：`use()` 當場拋的那句要指名是誰要的（`requires` 的事後檢查來不及，消費者會先撞上一個
 * `undefined`），而正面那條確認有提供者時這顆真的掛得上去。
 */
describe('圍堵政策的協作者在有圍堵時是硬相依', () => {
  it('有圍堵卻沒有 sandboxPolicy → 載入失敗，訊息指名服務與要它的 plugin', async () => {
    const withFence = createHostServicesPlugin({ fsContainment: CONTAINED_FILESYSTEM });
    await expect(loadPlugins([withFence, createSandboxPolicyPlugin()])).rejects.toThrow(
      '卻沒有 sandboxPolicy 服務',
    );
    await expect(loadPlugins([withFence, createSandboxPolicyPlugin()])).rejects.toThrow(
      'sandbox-policy',
    );
  });

  it('有圍堵、組裝點提供了就掛得上去，而且拿到的是同一顆控制器', async () => {
    const controller = new SandboxModeController('read-only');
    const { registry } = await loadPlugins([
      createHostServicesPlugin({
        fsContainment: CONTAINED_FILESYSTEM,
        sandboxPolicy: { controller, rootDir: '/workspace' },
      }),
      createSandboxPolicyPlugin(),
    ]);
    expect(registry.commands.find('sandbox')).toBeDefined();
    // **同一顆，不是快照**：切換之後這顆 plugin 讀到的要跟著動。
    controller.switchTo('danger-full-access');
    expect(registry.services.use('sandboxPolicy').controller).toBe(controller);
    expect(registry.services.use('sandboxPolicy').controller.source()).toBe('danger-full-access');
  });

  it('沒有圍堵：載得起來、只貢獻那一句（一顆 middleware），不註冊 /sandbox、不要控制器', async () => {
    const { registry } = await loadPlugins([createSandboxPolicyPlugin()]);
    expect(registry.commands.find('sandbox')).toBeUndefined();
    expect(registry.middleware.list().map((entry) => entry.value)).toHaveLength(1);
  });

  it('沒有圍堵時就算交了 sandboxPolicy 也不掛控制器那半（訊號是 fsContainment，不是控制器在不在）', async () => {
    const controller = new SandboxModeController('read-only');
    const { registry } = await loadPlugins([
      createHostServicesPlugin({ sandboxPolicy: { controller, rootDir: '/workspace' } }),
      createSandboxPolicyPlugin(),
    ]);
    expect(registry.commands.find('sandbox')).toBeUndefined();
  });
});
