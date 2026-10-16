import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { Context } from '@nexus/cordis';
import Loader from '@nexus/cordis-plugin-loader';
import type { EntryOptions } from '@nexus/cordis-plugin-loader';
import { injectOf, need, service } from '@nexus/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { toolsToken } from './index.js';
import { createToolsProvider } from './provider.js';

const make = (name: string): StructuredToolInterface =>
  tool(({ message }) => message, {
    name,
    description: '測試用',
    schema: z.object({ message: z.string() }),
  });

/** 一顆註冊 `config.names` 裡每個工具的消費者，以命名空間物件的形式。 */
const consumer = {
  name: 'tools-consumer',
  inject: injectOf(need(toolsToken, '^1.0.0')),
  apply(ctx: Context, config: { names: string[] }) {
    for (const name of config.names) service(ctx, toolsToken).register(make(name));
  },
};

/** 帶選項登記的消費者（#1458）：`rootOnly` 兩種形狀與 `outputSchema` 都交給登記處。 */
const optionedConsumer = {
  name: 'tools-optioned-consumer',
  // 範圍仍是 `^1.0.0`：舊消費者不改範圍，提供者升到 1.1.0 之後照常（驗收 F）。
  inject: injectOf(need(toolsToken, '^1.0.0')),
  apply(ctx: Context) {
    const tools = service(ctx, toolsToken);
    tools.register(make('plain'));
    tools.register(make('root_true'), { rootOnly: true });
    tools.register(make('root_refusal'), {
      rootOnly: { message: '不給子代理', error: { name: 'SomeError', code: 'SOME_CODE' } },
      outputSchema: z.object({ answers: z.array(z.string()) }),
    });
  },
};

/** 登記核准閘門的消費者（#1466）：要 `^1.2.0`，名字是 `config.tool` 的呼叫回 `ask`，其餘 `next()`。 */
const gatingConsumer = {
  name: 'tools-gating-consumer',
  inject: injectOf(need(toolsToken, '^1.2.0')),
  apply(ctx: Context, config: { tool: string }) {
    const tools = service(ctx, toolsToken);
    if (tools.gate === undefined) throw new Error('提供者沒有 gate');
    tools.gate((exec, next) =>
      exec.name === config.tool ? { kind: 'ask', reason: '要人看過' } : next(),
    );
  },
};

/** 觀察者看到的呼叫，依 `config.key` 分開記（Loader 會把列的 config 深複製，不能把陣列塞進 config 傳回來）。 */
const seen = new Map<string, string[]>();

/** 登記 `tools/result` 觀察者的消費者（#1469）：要 `^1.3.0`，把看到的呼叫記進 {@link seen}。 */
const resultConsumer = {
  name: 'tools-result-consumer',
  inject: injectOf(need(toolsToken, '^1.3.0')),
  apply(ctx: Context, config: { key: string }) {
    const tools = service(ctx, toolsToken);
    if (tools.onResult === undefined) throw new Error('提供者沒有 onResult');
    tools.onResult((exec, result) => {
      const list = seen.get(config.key) ?? [];
      seen.set(config.key, list);
      list.push(`${exec.thread ?? '?'}:${exec.callId}:${String(result.isError)}`);
    });
  },
};

/** 舊範圍的消費者：只登記一個工具，不呼叫 `gate`／`onResult`（驗收：`^1.0.0`～`^1.2.0` 在 1.3.0 的提供者上照常）。 */
const oldRangeConsumer = (name: string, range: string) => ({
  name,
  inject: injectOf(need(toolsToken, range)),
  apply(ctx: Context) {
    service(ctx, toolsToken).register(make(`${name}_tool`));
  },
});

let root: Context | undefined;
afterEach(async () => {
  await root?.fiber.dispose();
  root = undefined;
});

async function boot() {
  const provider = createToolsProvider();
  const context = new Context();
  root = context;
  await context.plugin(Loader);
  Object.assign(context.loader.builtins, {
    tools: provider.Provider,
    consumer,
    optioned: optionedConsumer,
    gating: gatingConsumer,
    results: resultConsumer,
    'old-100': oldRangeConsumer('old-100', '^1.0.0'),
    'old-110': oldRangeConsumer('old-110', '^1.1.0'),
    'old-120': oldRangeConsumer('old-120', '^1.2.0'),
  });
  const create = (options: EntryOptions) =>
    context.loader.create(options as Omit<EntryOptions, 'id'>, null);
  await create({ id: 'tools', name: 'cordis:tools' });
  return { provider, loader: context.loader, create };
}

describe('工具登記處的提供者', () => {
  it('每一筆登記記下登記者那一列的 id，依登記順序', async () => {
    const { provider, loader, create } = await boot();
    await create({ id: 'row-a', name: 'cordis:consumer', config: { names: ['a1', 'a2'] } });
    await create({ id: 'row-b', name: 'cordis:consumer', config: { names: ['b1'] } });
    await loader.await();
    expect(provider.entries().map(({ tool: t, source }) => [t.name, source])).toEqual([
      ['a1', 'row-a'],
      ['a2', 'row-a'],
      ['b1', 'row-b'],
    ]);
  });

  it('消費者那一列卸載，它登記的工具自己撤掉，別的列不受影響', async () => {
    const { provider, loader, create } = await boot();
    await create({ id: 'row-a', name: 'cordis:consumer', config: { names: ['a1'] } });
    await create({ id: 'row-b', name: 'cordis:consumer', config: { names: ['b1'] } });
    await loader.await();
    await loader.resolve('row-a').fiber?.ctx.fiber.dispose();
    expect(provider.entries().map(({ tool: t }) => t.name)).toEqual(['b1']);
  });

  it('同名工具報錯，掛第二個的那一列 FAILED，第一個照舊在', async () => {
    const { provider, loader, create } = await boot();
    await create({ id: 'row-a', name: 'cordis:consumer', config: { names: ['dup'] } });
    await create({ id: 'row-b', name: 'cordis:consumer', config: { names: ['dup'] } });
    await loader.await();
    expect(provider.entries().map(({ source }) => source)).toEqual(['row-a']);
    expect(loader.resolve('row-b').fiber?.ctx.fiber.state).toBe(3);
  });

  it('登記帶的選項原樣記在那一筆上；沒帶就是沒有這一格（不是空物件）', async () => {
    const { provider, loader, create } = await boot();
    await create({ id: 'row-opt', name: 'cordis:optioned' });
    await loader.await();
    const byName = new Map(provider.entries().map((entry) => [entry.tool.name, entry]));
    expect(byName.get('plain')?.options).toBeUndefined();
    expect('options' in (byName.get('plain') ?? {})).toBe(false);
    expect(byName.get('root_true')?.options).toEqual({ rootOnly: true });
    const refusal = byName.get('root_refusal')?.options;
    expect(refusal?.rootOnly).toEqual({
      message: '不給子代理',
      error: { name: 'SomeError', code: 'SOME_CODE' },
    });
    // schema 是原物件：宿主折進組裝時交給 `outputSchema`，不是複本。
    expect(refusal?.outputSchema?.safeParse({ answers: ['x'] }).success).toBe(true);
    expect(refusal?.outputSchema?.safeParse({ answers: 3 }).success).toBe(false);
  });

  it('選項跟著那一筆撤掉：消費者那一列卸載後，整筆（連選項）不在登記處', async () => {
    const { provider, loader, create } = await boot();
    await create({ id: 'row-opt', name: 'cordis:optioned' });
    await loader.await();
    expect(provider.entries()).toHaveLength(3);
    await loader.resolve('row-opt').fiber?.ctx.fiber.dispose();
    expect(provider.entries()).toEqual([]);
  });

  it('核准閘門：登記記下登記者那一列的 id，依登記順序；listener 是原函式', async () => {
    const { provider, loader, create } = await boot();
    await create({ id: 'gate-a', name: 'cordis:gating', config: { tool: 'a' } });
    await create({ id: 'gate-b', name: 'cordis:gating', config: { tool: 'b' } });
    await loader.await();
    const gates = provider.gates();
    expect(gates.map((entry) => entry.source)).toEqual(['gate-a', 'gate-b']);
    const exec = { name: 'a', args: {}, callId: undefined };
    const allow = async () => ({ kind: 'allow' as const });
    expect(await gates[0]!.listener(exec, allow)).toEqual({ kind: 'ask', reason: '要人看過' });
    expect(await gates[1]!.listener(exec, allow)).toEqual({ kind: 'allow' });
  });

  it('核准閘門：登記者那一列卸載，它的 listener 自己撤掉，別的列不受影響', async () => {
    const { provider, loader, create } = await boot();
    await create({ id: 'gate-a', name: 'cordis:gating', config: { tool: 'a' } });
    await create({ id: 'gate-b', name: 'cordis:gating', config: { tool: 'b' } });
    await loader.await();
    await loader.resolve('gate-a').fiber?.ctx.fiber.dispose();
    expect(provider.gates().map((entry) => entry.source)).toEqual(['gate-b']);
  });

  it('tools/result 觀察者：登記記下登記者那一列的 id，依登記順序；listener 是原函式，每次呼叫都收到 exec 與結果', async () => {
    const { provider, loader, create } = await boot();
    seen.clear();
    await create({ id: 'res-a', name: 'cordis:results', config: { key: 'a' } });
    await create({ id: 'res-b', name: 'cordis:results', config: { key: 'b' } });
    await loader.await();
    const listeners = provider.resultListeners();
    expect(listeners.map((entry) => entry.source)).toEqual(['res-a', 'res-b']);
    const exec = {
      callId: 'c1',
      name: 'present',
      args: {},
      agent: { kind: 'root' as const },
      thread: 't1',
    };
    await listeners[0]!.listener(exec, { isError: false });
    await listeners[1]!.listener(exec, { isError: true });
    expect(seen.get('a')).toEqual(['t1:c1:false']);
    expect(seen.get('b')).toEqual(['t1:c1:true']);
  });

  it('tools/result 觀察者：登記者那一列卸載，它的 listener 自己撤掉，別的列不受影響', async () => {
    const { provider, loader, create } = await boot();
    await create({ id: 'res-a', name: 'cordis:results', config: { key: 'x' } });
    await create({ id: 'res-b', name: 'cordis:results', config: { key: 'x' } });
    await loader.await();
    await loader.resolve('res-a').fiber?.ctx.fiber.dispose();
    expect(provider.resultListeners().map((entry) => entry.source)).toEqual(['res-b']);
  });

  it('舊範圍：^1.0.0、^1.1.0、^1.2.0 的消費者在 1.3.0 的提供者上照常登記工具，而且沒有人因此多出閘門或觀察者', async () => {
    const { provider, loader, create } = await boot();
    await create({ id: 'old-a', name: 'cordis:old-100' });
    await create({ id: 'old-b', name: 'cordis:old-110' });
    await create({ id: 'old-c', name: 'cordis:old-120' });
    await loader.await();
    expect(loader.resolve('old-a').fiber?.ctx.fiber.state).toBe(2);
    expect(loader.resolve('old-b').fiber?.ctx.fiber.state).toBe(2);
    expect(loader.resolve('old-c').fiber?.ctx.fiber.state).toBe(2);
    expect(provider.entries().map(({ tool: t, source }) => [t.name, source])).toEqual([
      ['old-100_tool', 'old-a'],
      ['old-110_tool', 'old-b'],
      ['old-120_tool', 'old-c'],
    ]);
    expect(provider.gates()).toEqual([]);
    expect(provider.resultListeners()).toEqual([]);
  });

  it('每次 createToolsProvider 的狀態是新的', () => {
    expect(createToolsProvider().entries()).toEqual([]);
    expect(createToolsProvider().gates()).toEqual([]);
    expect(createToolsProvider().resultListeners()).toEqual([]);
    const one = createToolsProvider();
    const two = createToolsProvider();
    expect(one.Provider).not.toBe(two.Provider);
  });
});
