/**
 * 掛載的身分：補 id、手寫 id、以及這兩者的射程。
 *
 * 對應 [#104](https://github.com/DemianLi/nexus-agent/issues/104) 的驗收。**射程是這一組
 * 測試的重點**，不只是「有沒有 id」：補出來的 id 對「清單裡多一個別的 plugin」是穩的，
 * 對「多一個同名的 plugin」不是——兩邊都寫成測試，因為只寫穩的那半會讓人以為它是
 * 一個可以存下來的識別，而它不是（見 `PluginOrigin` 的 JSDoc）。
 */

import { describe, expect, it } from 'vitest';
import { fakePlugin } from './fixtures.js';
import { formatOrigin, resolveEntries } from './plugin.js';
import type { NexusPlugin } from './plugin.js';

/** 清單裡一次帶著手寫 id 的掛載。**這就是文件裡給使用者的寫法**，不是測試專用的捷徑。 */
function withId(plugin: NexusPlugin, id: string): NexusPlugin {
  return { ...plugin, id };
}

const noop = (): void => {};

/** 只取 id，斷言讀起來才是一行。 */
function ids(plugins: readonly NexusPlugin[]): string[] {
  return resolveEntries(plugins).map((entry) => entry.origin.id);
}

describe('補 id', () => {
  it('沒寫 id 的補一個 `<name>#<序號>`', () => {
    expect(ids([fakePlugin('echo', noop), fakePlugin('mcp', noop)])).toEqual(['echo#0', 'mcp#0']);
  });

  it('同一個工廠掛兩次拿到兩個不同的 id——那正是 name 答不出來的那個問題', () => {
    const entries = resolveEntries([fakePlugin('mcp', noop), fakePlugin('mcp', noop)]);
    expect(entries.map((entry) => entry.origin.id)).toEqual(['mcp#0', 'mcp#1']);
    // name 照樣是同一個，這一層沒有被改掉。
    expect(entries.map((entry) => entry.origin.name)).toEqual(['mcp', 'mcp']);
  });

  it('回傳的掛載與清單等長同序，plugin 是原本那顆', () => {
    const first = fakePlugin('a', noop);
    const second = fakePlugin('b', noop);
    const entries = resolveEntries([first, second]);
    expect(entries.map((entry) => entry.plugin)).toEqual([first, second]);
  });

  it('沒有隨機成分——同一份清單解析兩次拿到同一批 id', () => {
    const plugins = [fakePlugin('mcp', noop), fakePlugin('echo', noop), fakePlugin('mcp', noop)];
    expect(ids(plugins)).toEqual(ids(plugins));
    expect(ids(plugins)).toEqual(['mcp#0', 'echo#0', 'mcp#1']);
  });

  it('補號跳過被手寫 id 佔走的', () => {
    // 手寫的那個正好長得像補出來的，補號要讓開而不是撞上去。
    const plugins = [withId(fakePlugin('mcp', noop), 'mcp#0'), fakePlugin('mcp', noop)];
    expect(ids(plugins)).toEqual(['mcp#0', 'mcp#1']);
  });
});

describe('手寫 id', () => {
  it('原樣留著，name 不受影響', () => {
    const entries = resolveEntries([withId(fakePlugin('mcp', noop), 'mcp-github')]);
    expect(entries[0]?.origin).toEqual({ id: 'mcp-github', name: 'mcp' });
  });

  it('兩個人寫了同一個 id 就報錯，訊息指得出是清單裡哪兩個', () => {
    const plugins = [
      fakePlugin('echo', noop),
      withId(fakePlugin('mcp', noop), 'mcp-github'),
      withId(fakePlugin('mcp', noop), 'mcp-github'),
    ];
    expect(() => resolveEntries(plugins)).toThrow(/plugins\[1\][\s\S]*plugins\[2\]/);
    expect(() => resolveEntries(plugins)).toThrow('"mcp-github"');
  });

  it('空字串與前後空白在 manifest 那一層就被擋下', () => {
    expect(() => resolveEntries([withId(fakePlugin('mcp', noop), '')])).toThrow(/不能是空字串/);
    expect(() => resolveEntries([withId(fakePlugin('mcp', noop), ' mcp')])).toThrow(/前後空白/);
  });
});

describe('射程', () => {
  it('清單最前面插一個別的 plugin，其他人的指名一個都不動', () => {
    const mcp = withId(fakePlugin('mcp', noop), 'mcp-github');
    const echo = fakePlugin('echo', noop);
    const before = ids([mcp, echo]);

    expect(ids([fakePlugin('validation', noop), mcp, echo])).toEqual(['validation#0', ...before]);
  });

  it('但插一個同名的進去，後面那個同名的序號就會移動——這是承諾的邊界', () => {
    const echo = fakePlugin('echo', noop);
    expect(ids([echo])).toEqual(['echo#0']);
    expect(ids([fakePlugin('echo', noop), echo])).toEqual(['echo#0', 'echo#1']);
    // 想要不動的話就自己寫 id，那是使用者手上唯一的保證。
    const pinned = withId(echo, 'echo-main');
    expect(ids([pinned])).toEqual(['echo-main']);
    expect(ids([fakePlugin('echo', noop), pinned])).toEqual(['echo#0', 'echo-main']);
  });
});

describe('manifest 的訊息用清單位置，不用 id', () => {
  it('id 還沒驗過的時候，位置是當下唯一可靠的說法', () => {
    const broken = { name: '', apply: noop } as NexusPlugin;
    expect(() => resolveEntries([fakePlugin('ok', noop), broken])).toThrow('plugins[1]');
  });
});

describe('formatOrigin', () => {
  it('印 id 與 name 兩個——手寫 id 時 name 只有這裡看得到', () => {
    expect(formatOrigin({ id: 'mcp-github', name: 'mcp' })).toBe('mcp-github (mcp)');
    expect(formatOrigin({ id: 'echo#0', name: 'echo' })).toBe('echo#0 (echo)');
  });
});
