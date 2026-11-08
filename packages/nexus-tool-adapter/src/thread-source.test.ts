/**
 * `ToolThread` 的 `on`／`join`／`provide`（#2533）：樹上的插件經這三格登記的東西，要落在那一列在清單上的位置，跟相容層那一列
 * 直接對 registry 登記的一樣，而且撤得掉。
 *
 * 走的是 core 真的 `loadPlugins`。排序的測試載三列 A、B、C：A 與 C 是相容層的直接登記，B 在 `apply` 裡 await {@link runThreadSources}。
 *
 * @module
 */

import { loadPlugins, WORKSPACE_CAPABILITY } from '@nexus/core';
import type { Events, PluginEntry, PluginRegistry } from '@nexus/core';
import type { ToolThread, ToolThreadSource } from '@nexus/tools';
import { describe, expect, it } from 'vitest';

import { runThreadSources } from './thread-source.js';

type Exec = Parameters<Events['tools/execute']>[0];
type Outcome = Awaited<ReturnType<Parameters<Events['tools/execute']>[1]>>;

const EXEC = {
  callId: 'call-1',
  name: 'probe',
  args: {},
  agent: { kind: 'root' },
} as unknown as Exec;
const INNER = { kind: 'inner-result' } as unknown as Outcome;

function plugin(
  name: string,
  apply: (registry: PluginRegistry) => void | Promise<void>,
): PluginEntry {
  return { plugin: { name, apply } };
}

function viaThread(name: string, source: ToolThreadSource): PluginEntry {
  return plugin(name, (registry) =>
    runThreadSources(registry, [{ threadSource: source, services: [] }], { id: name, module: {} }),
  );
}

function marking(order: string[], label: string): Events['tools/execute'] {
  return (_exec, next) => {
    order.push(label);
    return next();
  };
}

describe('ToolThread.on／join／provide 落在那一列的位置', () => {
  it("on('tools/execute')：排在前後兩列相容層監聽者之間，交出的是 next() 原樣那一份", async () => {
    const order: string[] = [];
    let seenExec: unknown;
    const { registry } = await loadPlugins([
      plugin('a', (r) => void r.events.on('tools/execute', marking(order, 'a'))),
      viaThread('b', (thread) => {
        thread.on?.('tools/execute', (exec, next) => {
          seenExec = exec;
          order.push('b');
          return next();
        });
      }),
      plugin('c', (r) => void r.events.on('tools/execute', marking(order, 'c'))),
    ]);

    const result = await registry.dispatch.waterfall('tools/execute', EXEC, () =>
      Promise.resolve(INNER),
    );

    expect(order).toEqual(['a', 'b', 'c']);
    expect(result).toBe(INNER);
    expect(seenExec).toBe(EXEC);
    expect(
      registry.events
        .listeners()
        .filter((info) => info.name === 'tools/execute')
        .map((info) => [info.origin?.name, info.prepend]),
    ).toEqual([
      ['a', false],
      ['b', false],
      ['c', false],
    ]);
  });

  it('join：參與者依列序排在前後兩列之間，subject 原樣交給它', async () => {
    const subject = { thread: 'thread-1' };
    let seen: unknown;
    const { registry } = await loadPlugins([
      plugin('a', (r) => void r.sessions.join(() => {})),
      viaThread('b', (thread) => {
        thread.join?.((s) => {
          seen = s;
        });
      }),
      plugin('c', (r) => void r.sessions.join(() => {})),
    ]);

    const installers = registry.sessions.installers();
    expect(installers.map((entry) => entry.origin.name)).toEqual(['a', 'b', 'c']);
    installers[1]?.value(subject as never);
    expect(seen).toBe(subject);
  });

  it("provide('workspace')：能力記在那一列名下", async () => {
    const { registry } = await loadPlugins([
      viaThread('b', (thread) => {
        thread.provide?.(WORKSPACE_CAPABILITY);
      }),
    ]);
    expect(registry.capabilities.has(WORKSPACE_CAPABILITY)).toBe(true);
    expect(
      registry.capabilities.providers(WORKSPACE_CAPABILITY).map((origin) => origin.name),
    ).toEqual(['b']);
  });
});

describe('ToolThread.on／join／provide 的範圍', () => {
  async function rejectionOf(source: ToolThreadSource): Promise<unknown> {
    return loadPlugins([viaThread('b', source)]).then(
      () => undefined,
      (error: unknown) => error,
    );
  }

  it("on 只收 'tools/execute'、provide 只收 'workspace'：別的值拋 TypeError", async () => {
    const offEvent = await rejectionOf((thread) => {
      (thread.on as (event: string, listener: unknown) => unknown)('tools/result', () => {});
    });
    expect(String((offEvent as Error).cause ?? offEvent)).toMatch(/只收 'tools\/execute'/);

    const offCapability = await rejectionOf((thread) => {
      (thread.provide as (capability: string) => unknown)('network');
    });
    expect(String((offCapability as Error).cause ?? offCapability)).toMatch(/只收 'workspace'/);
  });

  it('來源 resolve 之後再呼叫 on、join、provide 都拋', async () => {
    let kept: ToolThread | undefined;
    await loadPlugins([
      viaThread('b', (thread) => {
        kept = thread;
      }),
    ]);
    const thread = kept as ToolThread;
    expect(() => thread.on?.('tools/execute', (_exec, next) => next())).toThrow(/thread\.on\(\)/);
    expect(() => thread.join?.(() => {})).toThrow(/thread\.join\(\)/);
    expect(() => thread.provide?.('workspace')).toThrow(/thread\.provide\(\)/);
  });
});

describe('ToolThread.on／join／provide 撤得掉', () => {
  it('三個 undo 各自撤掉自己那一筆，第二次呼叫是 no-op', async () => {
    const undos: (() => void)[] = [];
    const { registry } = await loadPlugins([
      viaThread('b', (thread) => {
        undos.push(
          thread.on?.('tools/execute', (_exec, next) => next()) as () => void,
          thread.join?.(() => {}) as () => void,
          thread.provide?.('workspace') as () => void,
        );
      }),
    ]);
    expect(registry.dispatch.count('tools/execute')).toBe(1);
    expect(registry.sessions.installers()).toHaveLength(1);
    expect(registry.capabilities.has(WORKSPACE_CAPABILITY)).toBe(true);

    for (const undo of undos) {
      undo();
      undo();
    }

    expect(registry.dispatch.count('tools/execute')).toBe(0);
    expect(registry.sessions.installers()).toHaveLength(0);
    expect(registry.capabilities.has(WORKSPACE_CAPABILITY)).toBe(false);
  });

  it('那一列掉了（逐列掉模式、之後的來源 reject）：三樣跟著撤，別列照樣掛著', async () => {
    const result = await loadPlugins(
      [
        plugin('a', (r) => void r.events.on('tools/execute', (_exec, next) => next())),
        viaThread('b', (thread) => {
          thread.on?.('tools/execute', (_exec, next) => next());
          thread.join?.(() => {});
          thread.provide?.('workspace');
          throw new Error('故意在 threadSource 裡壞掉');
        }),
      ],
      undefined,
      { perEntry: true },
    );
    expect(result.dropped.map((item) => item.origin.name)).toEqual(['b']);
    expect(
      result.registry.events
        .listeners()
        .filter((info) => info.name === 'tools/execute')
        .map((info) => info.origin?.name),
    ).toEqual(['a']);
    expect(result.registry.sessions.installers()).toHaveLength(0);
    expect(result.registry.capabilities.has(WORKSPACE_CAPABILITY)).toBe(false);
  });

  it('thread 收掉（載入結果的 dispose）：監聽者清掉，之後派發不再經過它', async () => {
    let calls = 0;
    const loaded = await loadPlugins([
      viaThread('b', (thread) => {
        thread.on?.('tools/execute', (_exec, next) => {
          calls += 1;
          return next();
        });
      }),
    ]);
    await loaded.dispose();
    expect(loaded.registry.dispatch.count('tools/execute')).toBe(0);
    await loaded.registry.dispatch.waterfall('tools/execute', EXEC, () => Promise.resolve(INNER));
    expect(calls).toBe(0);
  });
});

describe('ToolThread.section 的 text 收到的 context（2.8.0）', () => {
  it('函式只拿到 { call }，call 是相容層交給段的那一份身分；字串原樣登記', async () => {
    const seen: unknown[] = [];
    const { registry } = await loadPlugins([
      viaThread('b', (thread) => {
        thread.section({
          name: 'probe:fn',
          order: 2000,
          text: (context) => {
            seen.push(context);
            return '段';
          },
        });
        thread.section({ name: 'probe:str', order: 2000, text: '原文' });
      }),
    ]);
    const [fn, str] = registry.prompt.sections();
    const call = { configurable: { thread_id: 't-1' } };
    const text = fn?.text;
    if (typeof text !== 'function') throw new Error('probe:fn 應該登記成函式');

    expect(text({ agent: { kind: 'root' }, call, tools: ['probe'] })).toBe('段');
    expect(seen).toEqual([{ call }]);
    expect((seen[0] as { call: unknown }).call).toBe(call);
    expect(str?.text).toBe('原文');
  });
});
