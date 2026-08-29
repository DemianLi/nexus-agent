/**
 * 載入一份 plugin 清單：命令式註冊、載入期回滾、`requires` 的存在性檢查。
 *
 * 對應 [#29](https://github.com/DemianLi/nexus-agent/issues/29) 的「載入期回滾」驗收。
 * `feat/nexus-plugin-contract` 當時只有三個註冊點，回滾那條用 tool ＋ subagent（兩次
 * 具名插入）；middleware 是 symbol-keyed 的匿名追加，撤銷路徑與具名插入不同，那一條
 * 隨 `AnonymousEntries` 落在本 PR 的「九個註冊點的回滾」。那組測試同時是 `load.ts`
 * 的 `trackUndo` 漏包某個註冊點時唯一會紅的地方。
 */

import { describe, expect, it } from 'vitest';
import { loadPlugins } from './load.js';
import { createRegistry } from './registry.js';
import {
  fakeBackend,
  fakeMiddleware,
  fakePlugin,
  fakeSink,
  fakeSubAgent,
  fakeTool,
} from './fixtures.js';
import type { NexusPlugin } from './plugin.js';

describe('loadPlugins', () => {
  it('依清單順序跑每個 plugin 的 apply', async () => {
    const order: string[] = [];
    const plugins = [
      fakePlugin('a', () => void order.push('a')),
      fakePlugin('b', () => void order.push('b')),
    ];
    await loadPlugins(plugins);
    expect(order).toEqual(['a', 'b']);
  });

  it('apply 可以是 async', async () => {
    const plugin = fakePlugin('slow', async (registry) => {
      await Promise.resolve();
      registry.tools.register(fakeTool('late'));
    });
    const { registry } = await loadPlugins([plugin]);
    expect(registry.tools.resolve('late')).toBeDefined();
  });

  it('plugin 名不唯一——同一個工廠掛兩次是合法的', async () => {
    const mcp = (server: string): NexusPlugin =>
      fakePlugin('mcp', (registry) => {
        registry.tools.register(fakeTool(`${server}_search`));
      });
    const { registry, origins } = await loadPlugins([mcp('github'), mcp('linear')]);
    expect(origins.map((o) => o.name)).toEqual(['mcp', 'mcp']);
    // **id 才是「哪一次掛載」的答案**，name 兩個都一樣。
    expect(origins.map((o) => o.id)).toEqual(['mcp#0', 'mcp#1']);
    expect(registry.tools.resolve('github_search')).toBeDefined();
    expect(registry.tools.resolve('linear_search')).toBeDefined();
  });

  it('手寫的 id 就是錯誤訊息裡的那個名字', async () => {
    const plugins = [
      {
        ...fakePlugin('mcp', () => {
          throw new Error('連不上');
        }),
        id: 'mcp-github',
      },
    ];
    await expect(loadPlugins(plugins)).rejects.toThrow('mcp-github (mcp)');
  });

  it('id 撞了在任何 apply 跑起來之前就報——沒有半個 plugin 掛上去', async () => {
    const applied: string[] = [];
    const plugins = [
      { ...fakePlugin('a', () => void applied.push('a')), id: 'same' },
      { ...fakePlugin('b', () => void applied.push('b')), id: 'same' },
    ];
    await expect(loadPlugins(plugins)).rejects.toThrow('"same"');
    // 這一條是「先解析完整份清單」的證據：id 是壞的就沒有任何東西該被跑起來。
    expect(applied).toEqual([]);
  });

  it('兩個 plugin 註冊同名工具，載入期報錯且指名雙方', async () => {
    const plugins = [
      fakePlugin('alpha', (registry) => void registry.tools.register(fakeTool('search'))),
      fakePlugin('mcp', (registry) => void registry.tools.register(fakeTool('search'))),
    ];
    // 指名兩個 plugin 與那個工具名，全部在頂層訊息裡 —— 錯誤處理只印 error.message 就夠。
    await expect(loadPlugins(plugins)).rejects.toThrow(/alpha#0 \(alpha\)[\s\S]*mcp#0 \(mcp\)/);
    await expect(loadPlugins(plugins)).rejects.toThrow('"search"');
  });

  it('manifest 不合法時載入失敗，訊息指得出是清單裡哪一個', async () => {
    const broken = { name: '', apply: () => {} } as NexusPlugin;
    await expect(loadPlugins([fakePlugin('ok', () => {}), broken])).rejects.toThrow('plugins[1]');
  });
});

describe('載入期回滾', () => {
  it('apply 中途拋錯，它註冊過的 tool 與 subagent 都不留下，先前成功的 plugin 不受影響', async () => {
    const registry = createRegistry();
    const plugins = [
      fakePlugin('good', (r) => {
        r.tools.register(fakeTool('kept_tool'));
        r.subagents.register(fakeSubAgent('kept_agent'));
        r.capabilities.provide('kept_capability');
      }),
      fakePlugin('bad', (r) => {
        r.tools.register(fakeTool('doomed_tool'));
        r.subagents.register(fakeSubAgent('doomed_agent'));
        r.capabilities.provide('doomed_capability');
        throw new Error('apply 到一半爆了');
      }),
    ];

    await expect(loadPlugins(plugins, registry)).rejects.toThrow('bad#0 (bad)');

    expect(registry.tools.resolve('doomed_tool')).toBeUndefined();
    expect(registry.subagents.get('doomed_agent')).toBeUndefined();
    expect(registry.capabilities.has('doomed_capability')).toBe(false);

    expect(registry.tools.resolve('kept_tool')).toBeDefined();
    expect(registry.subagents.get('kept_agent')).toBeDefined();
    expect(registry.capabilities.has('kept_capability')).toBe(true);
  });

  it('原始錯誤掛在 cause 上，不被吞掉', async () => {
    const boom = new Error('apply 到一半爆了');
    const plugins = [
      fakePlugin('bad', () => {
        throw boom;
      }),
    ];
    await expect(loadPlugins(plugins)).rejects.toThrow(expect.objectContaining({ cause: boom }));
  });

  it('回滾掉的能力宣告不會拿去滿足別人的 requires', async () => {
    const plugins = [
      fakePlugin('provider', (r) => {
        r.capabilities.provide('filesystem');
        throw new Error('提供到一半爆了');
      }),
      fakePlugin('consumer', () => {}, ['filesystem']),
    ];
    await expect(loadPlugins(plugins)).rejects.toThrow('provider#0 (provider)');
  });

  it('一個 plugin 回滾掉的能力，不影響另一個 plugin 對同一能力的宣告', async () => {
    const registry = createRegistry();
    await loadPlugins(
      [fakePlugin('stable', (r) => void r.capabilities.provide('filesystem'))],
      registry,
    );
    await expect(
      loadPlugins(
        [
          fakePlugin('unstable', (r) => {
            r.capabilities.provide('filesystem');
            throw new Error('爆了');
          }),
        ],
        registry,
      ),
    ).rejects.toThrow();
    expect(registry.capabilities.has('filesystem')).toBe(true);
  });

  it('撤銷後同名工具可由後續 plugin 重新註冊而不撞名', async () => {
    const registry = createRegistry();
    await expect(
      loadPlugins(
        [
          fakePlugin('bad', (r) => {
            r.tools.register(fakeTool('search'));
            throw new Error('爆了');
          }),
        ],
        registry,
      ),
    ).rejects.toThrow();

    const late = fakeTool('search');
    await loadPlugins([fakePlugin('late', (r) => void r.tools.register(late))], registry);
    expect(registry.tools.resolve('search')?.value).toBe(late);
  });
});

describe('requires', () => {
  it('缺件時報錯，訊息指名是誰缺哪個能力', async () => {
    const plugins = [fakePlugin('consumer', () => {}, ['filesystem'])];
    await expect(loadPlugins(plugins)).rejects.toThrow(
      /consumer#0 \(consumer\)[\s\S]*"filesystem"/,
    );
  });

  it('不排序——清單裡靠後的 plugin 可以滿足靠前的 plugin 的 requires', async () => {
    const plugins = [
      fakePlugin('consumer', () => {}, ['filesystem']),
      fakePlugin('provider', (r) => void r.capabilities.provide('filesystem')),
    ];
    await expect(loadPlugins(plugins)).resolves.toBeDefined();
  });

  it('同一能力被兩個 plugin 提供，requires 照樣滿足且不報錯', async () => {
    const plugins = [
      fakePlugin('state-fs', (r) => void r.capabilities.provide('filesystem')),
      fakePlugin('disk-fs', (r) => void r.capabilities.provide('filesystem')),
      fakePlugin('consumer', () => {}, ['filesystem']),
    ];
    const { registry } = await loadPlugins(plugins);
    expect(registry.capabilities.providers('filesystem').map((o) => o.name)).toEqual([
      'state-fs',
      'disk-fs',
    ]);
  });

  it('缺多個能力時一次列全，不是報第一個就停', async () => {
    const plugins = [fakePlugin('consumer', () => {}, ['filesystem', 'network'])];
    await expect(loadPlugins(plugins)).rejects.toThrow(/"filesystem"[\s\S]*"network"/);
  });
});

describe('每個註冊點的回滾', () => {
  /**
   * 每個點各放一樣東西，然後 throw。少包一個 undo 追蹤，這裡就會留下孤兒。
   *
   * **`telemetry` 兩個方法都在裡面。** `use` 漏追的下場最陰：回滾過的 plugin 會佔著
   * 那個唯一的後端位子，後面的 plugin 掛不上去，而錯誤訊息指的是一個已經不存在的註冊者。
   */
  const greedy = fakePlugin('greedy', (registry) => {
    registry.tools.register(fakeTool('search'));
    registry.subagents.register(fakeSubAgent('researcher'));
    registry.capabilities.provide('filesystem');
    registry.backend.mount('/memories/', fakeBackend('store'));
    registry.middleware.use(fakeMiddleware('audit'));
    registry.permissions.deny(['/.env*']);
    registry.interrupts.require('rm', { reason: '刪檔' });
    registry.skills.addSource('/skills/user/');
    registry.memory.addSource('/AGENTS.md');
    registry.lifecycle.onDispose(() => {});
    registry.telemetry.redact((record) => record);
    registry.telemetry.use(fakeSink());
    registry.tools.register(fakeTool('grep'), { scope: 'researcher' });
    throw new Error('半路壞掉');
  });

  it('apply 中途 throw → 每個註冊點一個都不剩', async () => {
    const registry = createRegistry();
    await expect(loadPlugins([greedy], registry)).rejects.toThrow('半路壞掉');

    expect(registry.tools.resolve('search')).toBeUndefined();
    expect(registry.tools.scopes()).toEqual([]);
    expect(registry.subagents.get('researcher')).toBeUndefined();
    expect(registry.capabilities.has('filesystem')).toBe(false);
    expect(registry.backend.mounts()).toEqual([]);
    expect(registry.middleware.list()).toEqual([]);
    expect(registry.permissions.rules()).toEqual([]);
    expect(registry.interrupts.requirements()).toEqual([]);
    expect(registry.skills.sources()).toEqual([]);
    expect(registry.memory.sources()).toEqual([]);
    expect(registry.lifecycle.disposers()).toEqual([]);
    expect(registry.telemetry.rules()).toEqual([]);
    expect(registry.telemetry.service()).toBeUndefined();
  });

  it('服務位子回滾之後是真的空出來，別的 plugin 掛得上去', async () => {
    const registry = createRegistry();
    await expect(loadPlugins([greedy], registry)).rejects.toThrow('半路壞掉');

    const later = fakePlugin('later', (r) => {
      r.telemetry.use(fakeSink());
    });
    await loadPlugins([later], registry);
    expect(registry.telemetry.service()?.origin.name).toBe('later');
  });

  it('先前成功載入的 plugin 不受影響', async () => {
    const registry = createRegistry();
    const good = fakePlugin('good', (r) => {
      r.middleware.use(fakeMiddleware('keep'));
      r.memory.addSource('/KEEP.md');
    });
    await expect(loadPlugins([good, greedy], registry)).rejects.toThrow('半路壞掉');
    expect(registry.middleware.list()).toHaveLength(1);
    expect(registry.memory.sources()).toEqual(['/KEEP.md']);
  });

  it('匿名撤銷是逐筆的：同一個 plugin 的兩個 middleware 一起撤，別人的留著', async () => {
    const registry = createRegistry();
    const keeper = fakePlugin('keeper', (r) => void r.middleware.use(fakeMiddleware('keep')));
    const doomed = fakePlugin('doomed', (r) => {
      r.middleware.use(fakeMiddleware('first'));
      r.middleware.use(fakeMiddleware('second'));
      throw new Error('中途壞掉');
    });
    await expect(loadPlugins([keeper, doomed], registry)).rejects.toThrow('中途壞掉');
    expect(registry.middleware.list().map((entry) => entry.origin.name)).toEqual(['keeper']);
  });

  it('撤銷過的掛載點與 skill 來源可以被後續 plugin 重新註冊', async () => {
    const registry = createRegistry();
    await expect(loadPlugins([greedy], registry)).rejects.toThrow('半路壞掉');

    const late = fakePlugin('late', (r) => {
      r.backend.mount('/memories/', fakeBackend('late'));
      r.skills.addSource('/skills/user/');
    });
    await expect(loadPlugins([late], registry)).resolves.toBeDefined();
    expect(registry.backend.mounts().map(([prefix]) => prefix)).toEqual(['/memories/']);
    expect(registry.skills.sources()).toEqual(['/skills/user/']);
  });
});

describe('關機清理', () => {
  it('逆序跑：後開的先收', async () => {
    const closed: string[] = [];
    const opener = (id: string): NexusPlugin =>
      fakePlugin(id, (registry) => {
        registry.lifecycle.onDispose(() => void closed.push(id));
      });
    const { dispose } = await loadPlugins([opener('a'), opener('b')]);
    await dispose();
    expect(closed).toEqual(['b', 'a']);
  });

  it('async 的清理會被等到', async () => {
    let done = false;
    const plugin = fakePlugin('slow', (registry) => {
      registry.lifecycle.onDispose(async () => {
        await Promise.resolve();
        done = true;
      });
    });
    const { dispose } = await loadPlugins([plugin]);
    await dispose();
    expect(done).toBe(true);
  });

  it('呼叫第二次是 no-op', async () => {
    let count = 0;
    const plugin = fakePlugin('once', (registry) => {
      registry.lifecycle.onDispose(() => void (count += 1));
    });
    const { dispose } = await loadPlugins([plugin]);
    await dispose();
    await dispose();
    expect(count).toBe(1);
  });

  // 註冊內容留著（診斷要有東西可看），活資源不留——載入失敗的呼叫端拿到的是一個
  // exception，不是 handle，沒有第二個人知道那些東西還開著。
  it('靠後的 plugin 拋錯時，靠前的 plugin 開的資源也收掉', async () => {
    const closed: string[] = [];
    const opener = fakePlugin('opener', (r) => {
      r.middleware.use(fakeMiddleware('keep'));
      r.lifecycle.onDispose(() => void closed.push('opener'));
    });
    const doomed = fakePlugin('doomed', () => {
      throw new Error('半路壞掉');
    });
    const registry = createRegistry();
    await expect(loadPlugins([opener, doomed], registry)).rejects.toThrow('半路壞掉');
    expect(closed).toEqual(['opener']);
    expect(registry.middleware.list()).toHaveLength(1);
  });

  it('requires 缺件同樣算載入失敗，資源一樣收掉', async () => {
    const closed: string[] = [];
    const opener = fakePlugin('opener', (r) => {
      r.lifecycle.onDispose(() => void closed.push('opener'));
    });
    const consumer = fakePlugin('consumer', () => {}, ['nobody-provides-this']);
    await expect(loadPlugins([opener, consumer])).rejects.toThrow('nobody-provides-this');
    expect(closed).toEqual(['opener']);
  });

  // 關機途中有人拋錯不是停下來的理由——剩下的資源更需要被收掉。
  it('有清理拋錯，其餘照樣跑完，訊息指名是誰', async () => {
    const closed: string[] = [];
    const plugins = [
      fakePlugin('good', (r) => void r.lifecycle.onDispose(() => void closed.push('good'))),
      fakePlugin(
        'bad',
        (r) =>
          void r.lifecycle.onDispose(() => {
            throw new Error('關不掉');
          }),
      ),
    ];
    const { dispose } = await loadPlugins(plugins);
    await expect(dispose()).rejects.toThrow(/bad#0 \(bad\)[\s\S]*關不掉/);
    expect(closed).toEqual(['good']);
  });
});
