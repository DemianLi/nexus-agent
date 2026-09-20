/**
 * 組裝點交協作者的那個條目：**有給的才提供，`undefined` 的那幾格整個跳過**。
 *
 * 對應 [#459](https://github.com/DemianLi/nexus-agent/issues/459) 的「組裝點提供執行期的
 * 協作者」。
 */

import { describe, expect, it } from 'vitest';
import { createHostServicesPlugin } from './host-services.js';
import { loadPlugins } from './load.js';
import { fakePlugin } from './fixtures.js';

describe('createHostServicesPlugin', () => {
  it('把給的每一格都提供出去，名字就是鍵', async () => {
    const channel = { kind: 'human' };
    const backend = { kind: 'contained' };
    const { registry } = await loadPlugins([createHostServicesPlugin({ channel, backend })]);

    expect(registry.services.get('channel')).toBe(channel);
    expect(registry.services.get('backend')).toBe(backend);
    expect(registry.services.names()).toEqual(['channel', 'backend']);
  });

  /**
   * **`undefined` 是「沒有」，不是「提供一個 undefined」。** 組裝點手上好幾個協作者本來
   * 就可有可無（沒有 `--workspace` 就沒有 backend），而消費者靠 `get()` 回 `undefined`
   * 走自己的退路——提供一個 `undefined` 進去的話那條退路照走，但名字被佔住了，真正的
   * 提供者之後掛不上來。
   */
  it('值是 undefined 的那一格不佔名字', async () => {
    const { registry } = await loadPlugins([
      createHostServicesPlugin({ channel: { kind: 'human' }, backend: undefined }),
    ]);

    expect(registry.services.names()).toEqual(['channel']);
    expect(registry.services.provider('backend')).toBeUndefined();
  });

  it('plugin 名可以換，一次組裝交兩批不會撞', async () => {
    const { registry, entries } = await loadPlugins([
      createHostServicesPlugin({ channel: { kind: 'human' } }),
      createHostServicesPlugin({ backend: {} }, 'host-services-late'),
    ]);

    expect(entries.map((entry) => entry.origin.name)).toEqual([
      'host-services',
      'host-services-late',
    ]);
    expect(registry.services.names()).toEqual(['channel', 'backend']);
  });

  /**
   * **排在消費者前面是承重的**，不是風格：載入一趟到底，`apply` 當下讀不到的服務不會
   * 之後補上來（偏離登記見 `registry.ts` 的 `ServiceRegistrationPoint`）。
   */
  it('排在消費者後面 → 消費者的 apply 當場拿不到', async () => {
    const seen: unknown[] = [];
    const consumer = fakePlugin('consumer', (registry) => {
      seen.push(registry.services.get('channel'));
    });

    await loadPlugins([consumer, createHostServicesPlugin({ channel: { kind: 'human' } })]);
    expect(seen).toEqual([undefined]);

    seen.length = 0;
    await loadPlugins([createHostServicesPlugin({ channel: { kind: 'human' } }), consumer]);
    expect(seen).toEqual([{ kind: 'human' }]);
  });
});
