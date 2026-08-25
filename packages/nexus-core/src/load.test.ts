/**
 * 載入一份 plugin 清單：命令式註冊、載入期回滾、`requires` 的存在性檢查。
 *
 * 對應 [#29](https://github.com/DemianLi/nexus-agent/issues/29) 的「載入期回滾」驗收。
 * 回滾那條的計劃原文是「一個 tool 與一個 middleware」，這裡改用 **tool 與 subagent**：
 * `middleware` 註冊點屬 `feat/plugin-registry-fold`，驗收的意思是「回滾撤得掉跨不同表
 * 的異質註冊」，換成同一個 PR 裡已存在的兩張表一樣成立。middleware 是匿名的順序追加，
 * 撤銷路徑與具名插入不同，那一條隨 `AnonymousEntries` 一起留給下一個 PR。
 */

import { describe, expect, it } from 'vitest';
import { loadPlugins } from './load.js';
import { createRegistry } from './registry.js';
import { fakePlugin, fakeSubAgent, fakeTool } from './fixtures.js';
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
    expect(registry.tools.resolve('github_search')).toBeDefined();
    expect(registry.tools.resolve('linear_search')).toBeDefined();
  });

  it('兩個 plugin 註冊同名工具，載入期報錯且指名雙方', async () => {
    const plugins = [
      fakePlugin('alpha', (registry) => void registry.tools.register(fakeTool('search'))),
      fakePlugin('mcp', (registry) => void registry.tools.register(fakeTool('search'))),
    ];
    await expect(loadPlugins(plugins)).rejects.toThrow(/plugins\[1\] \(mcp\)/);
    await expect(loadPlugins(plugins)).rejects.toThrow(
      expect.objectContaining({
        cause: expect.objectContaining({
          message: expect.stringMatching(/plugins\[0\] \(alpha\)[\s\S]*plugins\[1\] \(mcp\)/),
        }),
      }),
    );
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

    await expect(loadPlugins(plugins, registry)).rejects.toThrow('plugins[1] (bad)');

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
    await expect(loadPlugins(plugins)).rejects.toThrow('plugins[0] (provider)');
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
      /plugins\[0\] \(consumer\)[\s\S]*"filesystem"/,
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
