/**
 * 掛載的身分：補 id、手寫 id、以及這兩者的射程。
 *
 * 對應 [#104](https://github.com/DemianLi/nexus-agent/issues/104) 的驗收。**射程是這一組
 * 測試的重點**，不只是「有沒有 id」：補出來的 id 對「清單裡多一個別的 plugin」是穩的，
 * 對「多一個同名的 plugin」不是——兩邊都寫成測試，因為只寫穩的那半會讓人以為它是
 * 一個可以存下來的識別，而它不是（見 `PluginOrigin` 的 JSDoc）。
 *
 * `disabled` 在這一層只有一件事要驗，而它是整組裡最容易寫壞的那件：**編號在停用之前
 * 就發完了**。要不要跑是載入那一層的事。
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fakePlugin } from './fixtures.js';
import { formatOrigin, resolveEntries } from './plugin.js';
import type { NexusPlugin, PluginEntry } from './plugin.js';

/** 清單裡一次帶著手寫 id 的掛載。**這就是文件裡給使用者的寫法**，不是測試專用的捷徑。 */
function withId(entry: PluginEntry, id: string): PluginEntry {
  return { ...entry, id };
}

/** 關掉的一次掛載，寫法同上。 */
function off(entry: PluginEntry): PluginEntry {
  return { ...entry, disabled: true };
}

const noop = (): void => {};

/** 只取 id，斷言讀起來才是一行。 */
function ids(plugins: readonly PluginEntry[]): string[] {
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
    expect(entries.map((entry) => entry.plugin)).toEqual([first.plugin, second.plugin]);
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

describe('停用', () => {
  it('解析成 entry.disabled，沒寫就是 false', () => {
    const entries = resolveEntries([off(fakePlugin('mcp', noop)), fakePlugin('echo', noop)]);
    expect(entries.map((entry) => entry.disabled)).toEqual([true, false]);
  });

  it('關掉的條目照樣在回傳裡，照樣有 id——那是它與「把這行刪掉」的差別', () => {
    const entries = resolveEntries([off(fakePlugin('mcp', noop))]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.origin).toEqual({ id: 'mcp#0', name: 'mcp' });
  });

  it('**關掉一個不會讓別人的序號位移**——編號在停用之前就發完了', () => {
    // 這一條是這組裡唯一擋得住「先過濾再編號」那個寫法的：底下每一條它都會通過，
    // 只有這裡會紅。位移的後果是 `disabled` 一開一關，錯誤訊息裡的指名整批換人。
    const plugins = [fakePlugin('mcp', noop), fakePlugin('mcp', noop), fakePlugin('mcp', noop)];
    expect(ids(plugins)).toEqual(['mcp#0', 'mcp#1', 'mcp#2']);

    const middleOff = [plugins[0]!, off(plugins[1]!), plugins[2]!];
    expect(ids(middleOff)).toEqual(['mcp#0', 'mcp#1', 'mcp#2']);
  });

  it('關掉的條目照樣佔住手寫 id，重複還是報錯', () => {
    const plugins = [
      off(withId(fakePlugin('mcp', noop), 'mcp-github')),
      withId(fakePlugin('mcp', noop), 'mcp-github'),
    ];
    expect(() => resolveEntries(plugins)).toThrow('"mcp-github"');
  });

  it('只收字面布林——`disabled: string` 在 manifest 那一層就被擋下', () => {
    // 不驗的話這個寫法是真值，plugin 靜靜地不跑而且沒有任何訊息。
    const sneaky = { ...fakePlugin('mcp', noop), disabled: 'false' } as unknown as PluginEntry;
    expect(() => resolveEntries([sneaky])).toThrow(/plugins\[0\][\s\S]*disabled/);
  });
});

describe('manifest 的訊息用清單位置，不用 id', () => {
  it('id 還沒驗過的時候，位置是當下唯一可靠的說法', () => {
    const broken: PluginEntry = { plugin: { name: '', apply: noop } };
    expect(() => resolveEntries([fakePlugin('ok', noop), broken])).toThrow('plugins[1]');
  });
});

describe('formatOrigin', () => {
  it('印 id 與 name 兩個——手寫 id 時 name 只有這裡看得到', () => {
    expect(formatOrigin({ id: 'mcp-github', name: 'mcp' })).toBe('mcp-github (mcp)');
    expect(formatOrigin({ id: 'echo#0', name: 'echo' })).toBe('echo#0 (echo)');
  });
});

/**
 * 一顆帶設定的假 plugin。巢狀那一層是刻意的：**未知欄位要每一層都擋**，只在最外層
 * `strictObject` 的話，`connection` 或 `exporter` 底下打錯字照樣靜靜沒有作用。
 */
const sizedConfigSchema = z.strictObject({
  maxBytes: z.number().int().positive().default(1024),
  nested: z.strictObject({ label: z.string().default('預設') }).prefault({}),
});

type SizedConfig = z.infer<typeof sizedConfigSchema>;

/** 記下每次 `apply` 拿到什麼，用來驗「交給 plugin 的是驗過的那一份」。 */
function sizedPlugin(seen: SizedConfig[] = []): NexusPlugin<SizedConfig> {
  return {
    name: 'sized',
    Config: sizedConfigSchema,
    apply(_registry, config) {
      seen.push(config);
    },
  };
}

describe('設定是資料（#453）', () => {
  it('合法的覆寫會生效，沒給的格子由 schema 的預設值補上', () => {
    const [entry] = resolveEntries([{ plugin: sizedPlugin(), config: { maxBytes: 7 } }]);
    expect(entry?.config).toEqual({ maxBytes: 7, nested: { label: '預設' } });
  });

  it('一格都不給也驗得過——`config ?? {}`，預設值全部補齊', () => {
    const [entry] = resolveEntries([{ plugin: sizedPlugin() }]);
    expect(entry?.config).toEqual({ maxBytes: 1024, nested: { label: '預設' } });
  });

  it('型別錯或範圍錯就報錯，訊息帶 `<id> (<name>)` 與欄位路徑', () => {
    const bad = [{ plugin: sizedPlugin(), config: { maxBytes: -1 } }];
    expect(() => resolveEntries(bad)).toThrow('sized#0 (sized)');
    expect(() => resolveEntries(bad)).toThrow('maxBytes');
  });

  it('手寫 id 時訊息指的是那個 id——這才是 YAML 上找得到的那一行', () => {
    const bad = [{ id: 'sized-main', plugin: sizedPlugin(), config: { maxBytes: 'x' } }];
    expect(() => resolveEntries(bad)).toThrow('sized-main (sized)');
  });

  it('未知欄位讓載入失敗（登記的偏離：dsh 放行）', () => {
    const typo = [{ plugin: sizedPlugin(), config: { maxByte: 7 } }];
    expect(() => resolveEntries(typo)).toThrow('sized#0 (sized)');
    expect(() => resolveEntries(typo)).toThrow(/maxByte\b/);
  });

  it('**巢狀 object 裡的未知欄位也擋**，而且路徑指得到那一層', () => {
    const typo = [{ plugin: sizedPlugin(), config: { nested: { labe: 'x' } } }];
    expect(() => resolveEntries(typo)).toThrow(/nested(\.|:)/);
  });

  it('沒有 Config 的 plugin 給了 config 就報錯——設了卻沒有作用是這張卡要消滅的病', () => {
    const entry = { ...fakePlugin('plain', noop), config: { anything: 1 } };
    expect(() => resolveEntries([entry])).toThrow('plain#0 (plain)');
    expect(() => resolveEntries([entry])).toThrow('不收 config');
  });

  it('沒有 Config 又沒給 config 的，解析出來的 config 是 undefined', () => {
    const [entry] = resolveEntries([fakePlugin('plain', noop)]);
    expect(entry?.config).toBeUndefined();
  });

  it('停用的條目連 config 都不驗——同一條規則的同一面（`requires` 也不驗）', () => {
    const off = [{ plugin: sizedPlugin(), config: { maxByte: 7 }, disabled: true }];
    expect(() => resolveEntries(off)).not.toThrow();
    expect(resolveEntries(off)[0]?.config).toBeUndefined();
    // 有人把它打開的那一次才失敗——那時它才真的有作用。
    expect(() => resolveEntries([{ ...off[0]!, disabled: false }])).toThrow('sized#0 (sized)');
  });
});

describe('id 與 disabled 搬到條目上（#453 推翻 #104 的 (b)）', () => {
  it('留在 plugin 物件上的 id 明著擋下來，不是靜靜忽略', () => {
    const stale = {
      plugin: { name: 'mcp', id: 'mcp-github', apply: noop },
    } as unknown as PluginEntry;
    expect(() => resolveEntries([stale])).toThrow(/plugins\[0\][\s\S]*id/);
    expect(() => resolveEntries([stale])).toThrow('搬到條目上');
  });

  it('留在 plugin 物件上的 disabled 也一樣——它才是「設了卻沒跑」的那一個', () => {
    const stale = {
      plugin: { name: 'mcp', disabled: true, apply: noop },
    } as unknown as PluginEntry;
    expect(() => resolveEntries([stale])).toThrow(/plugins\[0\][\s\S]*disabled/);
  });

  it('直接把 plugin 塞進清單（忘了包成條目）時，訊息講得出改法', () => {
    const bare = { name: 'echo', apply: noop } as unknown as PluginEntry;
    expect(() => resolveEntries([bare])).toThrow('{ plugin: … }');
  });

  it('條目沒有 plugin 那一格時也指得出是清單裡哪一個', () => {
    const empty = {} as unknown as PluginEntry;
    expect(() => resolveEntries([fakePlugin('ok', noop), empty])).toThrow(/plugins\[1\]/);
  });
});
