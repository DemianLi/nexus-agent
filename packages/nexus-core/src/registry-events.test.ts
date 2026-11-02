/**
 * `registry.events`：插件掛、宿主派發，兩條收尾路徑（[#1217](https://github.com/DemianLi/nexus-agent/issues/1217)，S0）。
 *
 * 判準是**經 `loadPlugins` 的真實路徑**，不是直接 new 匯流排：載入期回滾與 `dispose()` 都在載入器那一層。
 * 事件表是空的，名字用 declaration merging 加（`test/` 前綴）。
 */

import { describe, expect, it } from 'vitest';

import { fakePlugin } from './fixtures.js';
import { loadPlugins } from './load.js';
import type { PluginRegistry } from './registry.js';
import { createRegistry } from './registry.js';

declare module './events.js' {
  interface Events {
    /**
     * 測試用。
     * @mode emit
     */
    'test/registry-emit'(label: string): void;
    /**
     * 測試用。
     * @mode waterfall
     */
    'test/registry-waterfall'(label: string, next: () => string): string;
  }
}

describe('registry.events', () => {
  it('插件在 apply 裡掛，宿主經 dispatch 派發；插件拿到的窄 registry 沒有派發面', async () => {
    const seen: string[] = [];
    let narrow: PluginRegistry | undefined;
    const { registry } = await loadPlugins([
      fakePlugin('a', (each) => {
        narrow = each;
        each.events.on('test/registry-emit', (label) => void seen.push(`a:${label}`));
      }),
      fakePlugin('b', (each) => {
        each.events.on('test/registry-emit', (label) => void seen.push(`b:${label}`), {
          prepend: true,
        });
      }),
    ]);
    registry.dispatch.emit('test/registry-emit', 'x');
    expect(seen).toEqual(['b:x', 'a:x']);
    // 型別那一層：窄的 registry 上沒有 dispatch，events 上也沒有 emit／serial／waterfall。
    // @ts-expect-error 插件不能派發
    void narrow?.dispatch;
    // @ts-expect-error 插件不能派發
    void narrow?.events.emit;
    // 執行期那一層：窄的 registry 就是同一個物件（不是複製），所以這裡只證明宿主那側拿得到；窄與寬的差別由型別守。
    expect(registry.events.listeners().map((each) => each.name)).toEqual([
      'test/registry-emit',
      'test/registry-emit',
    ]);
  });

  it('waterfall 經 registry 掛、經 dispatch 派發：否決與穿過', async () => {
    const { registry } = await loadPlugins([
      fakePlugin('guard', (each) => {
        each.events.on('test/registry-waterfall', (label, next) =>
          label === 'deny' ? '擋' : next(),
        );
      }),
    ]);
    expect(registry.dispatch.waterfall('test/registry-waterfall', 'deny', () => '內建')).toBe('擋');
    expect(registry.dispatch.waterfall('test/registry-waterfall', 'ok', () => '內建')).toBe('內建');
  });

  it('listeners() 記得是誰掛的', async () => {
    const { registry, entries } = await loadPlugins([
      fakePlugin('a', (each) => {
        each.events.on('test/registry-emit', () => undefined);
      }),
    ]);
    const [listener] = registry.events.listeners();
    expect(listener?.origin).toBe(entries[0]?.origin);
  });

  it('收尾路徑一：apply 掛完才拋錯，載入器回滾後監聽者不見，其他插件掛的還在', async () => {
    const registry = createRegistry();
    await loadPlugins(
      [
        fakePlugin('keeps', (each) => {
          each.events.on('test/registry-emit', () => undefined);
        }),
      ],
      registry,
    );
    await expect(
      loadPlugins(
        [
          fakePlugin('throws', (each) => {
            each.events.on('test/registry-emit', () => undefined);
            each.events.once('test/registry-emit', () => undefined);
            throw new Error('apply 掛完才炸');
          }),
        ],
        registry,
      ),
    ).rejects.toThrow('apply 掛完才炸');
    expect(registry.dispatch.count('test/registry-emit')).toBe(1);
  });

  it('收尾路徑二：dispose() 之後整張表清空，派發什麼都不跑', async () => {
    const seen: string[] = [];
    const { registry, dispose } = await loadPlugins([
      fakePlugin('a', (each) => {
        each.events.on('test/registry-emit', (label) => void seen.push(label));
      }),
    ]);
    registry.dispatch.emit('test/registry-emit', 'before');
    await dispose();
    registry.dispatch.emit('test/registry-emit', 'after');
    expect(seen).toEqual(['before']);
    expect(registry.events.listeners()).toEqual([]);
  });

  it('dispose() 的清理途中派發的事件還聽得到（清空排在清理之後）', async () => {
    const seen: string[] = [];
    const { registry, dispose } = await loadPlugins([
      fakePlugin('a', (each) => {
        each.events.on('test/registry-emit', (label) => void seen.push(label));
        each.lifecycle.onDispose(() => {
          registry.dispatch.emit('test/registry-emit', 'during');
        });
      }),
    ]);
    await dispose();
    expect(seen).toEqual(['during']);
  });

  it('不在插件的 apply 之內掛會拋，指名是哪個方法', () => {
    expect(() => createRegistry().events.on('test/registry-emit', () => undefined)).toThrow(
      /events\.on\(\)/,
    );
  });
});
