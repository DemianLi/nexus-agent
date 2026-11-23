/**
 * 跨套件擴充事件表（[#1217](https://github.com/DemianLi/nexus-agent/issues/1217)，S0）：插件只相依 `@nexus/core`，用
 * `declare module '@nexus/core' { interface Events { … } }` 加自己的事件，宿主 import 到那個檔案就能 `on`、`waterfall`。
 *
 * **這條的價值在 `typecheck`，不在 vitest 的綠。** 草稿 §4-2 寫「在 pnpm 隔離下可不可行沒驗過」；2026-10-09 實測可行
 * （core、插件套件、harness 三處 `tsc` 都過；名字打錯、參數型別錯會紅；沒 import 增補檔則宿主紅），這個檔案把它釘成正式測試：
 * 下面每一個 `@ts-expect-error` 在被擋的那一刻必須真的出錯，否則 `typecheck` 本身就紅（未使用的 expect-error）。
 *
 * 這裡的宣告用 `test/` 前綴，且在 `*.test.ts` 裡，所以不算事件表的一部分（`event-table-scan.ts` 只掃產品碼）。
 */

import { createRegistry, loadPlugins } from '@nexus/core';
import type { NexusPlugin, PluginRegistry } from '@nexus/core';
import { describe, expect, it } from 'vitest';

declare module '@nexus/core' {
  interface Events {
    /**
     * 跨套件擴充的證明。
     * @mode waterfall
     * @param amount - 數量。
     * @param next - 內建行為。
     */
    'test/augmented'(amount: number, next: () => number): number;
  }
}

const plugin: NexusPlugin = {
  name: 'augmenting-plugin',
  apply(registry) {
    registry.events.on('test/augmented', (amount, next) => next() + amount);
  },
};

/** 只給型別檢查看、不執行：這些都該被擋下來。 */
function mustNotCompile(registry: PluginRegistry): void {
  // @ts-expect-error 事件名打錯：不在事件表裡
  registry.events.on('test/augmentd', () => 0);
  // @ts-expect-error 參數型別錯：amount 是 number
  registry.events.on('test/augmented', (amount: string, next) => next() + Number(amount));
}
void mustNotCompile;

describe('跨套件擴充事件表', () => {
  it('從 @nexus/core 的名字掛上去、宿主經 dispatch 派發，型別一路帶到', async () => {
    const registry = createRegistry();
    await loadPlugins([{ plugin }], registry);
    expect(registry.dispatch.waterfall('test/augmented', 2, () => 10)).toBe(12);
    expect(registry.dispatch.count('test/augmented')).toBe(1);
  });
});
