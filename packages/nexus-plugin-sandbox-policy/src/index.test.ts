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
    expect(sandboxPolicySentence('danger-full-access')).toContain('不受限制');
  });

  it('三句都限定在「受檔案沙箱管的可用操作」——這是句子不宣稱圍堵的來源（照 dsh）', () => {
    for (const mode of ['read-only', 'workspace-write', 'danger-full-access'] as const) {
      for (const contained of [true, false]) {
        expect(sandboxPolicySentence(mode, { contained })).toContain('受檔案沙箱管的可用操作');
      }
    }
  });

  it('workspace-write：有圍堵帶可寫根（`/`），沒有圍堵不帶根、不教路徑規則；兩邊都不說暫存區可寫', () => {
    const contained = sandboxPolicySentence('workspace-write', { contained: true });
    const uncontained = sandboxPolicySentence('workspace-write', { contained: false });
    expect(contained).toContain('`/` 就是工作區根');
    // 不抄 dsh 的暫存區半句：我們的 backend 只認可寫根，說了會讓模型去寫 `/tmp` 然後被擋。
    expect(contained).not.toContain('暫存區');
    expect(uncontained).not.toContain('暫存區');
    expect(uncontained).not.toContain('`/`');
    expect(uncontained).not.toContain('磁碟上的絕對路徑');
  });

  it('read-only：叫模型不要只因這個政策就拒絕必要的修改，照拒絕與升級指引做', () => {
    const sentence = sandboxPolicySentence('read-only');
    expect(sentence).toContain('不要只因這個政策就拒絕必要的修改');
    expect(sentence).toContain('拒絕與升級指引');
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
    // `/sandbox` 拿掉了（#437）：唯一的切換入口是 `@nexus/plugin-permission-presets` 的 `/permission`。有圍堵也不註冊，
    // 否則部署的人刪掉「全開」那一組也關不掉全開。
    expect(registry.commands.find('sandbox')).toBeUndefined();
    // **同一顆，不是快照**：切換之後這顆 plugin 讀到的要跟著動。
    controller.switchTo('danger-full-access');
    expect(registry.services.use('sandboxPolicy').controller).toBe(controller);
    expect(registry.services.use('sandboxPolicy').controller.source()).toBe('danger-full-access');
  });

  it('沒有圍堵：載得起來、只貢獻那一句（一顆 middleware），不要控制器', async () => {
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
