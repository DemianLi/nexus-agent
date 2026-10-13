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
  Object.assign(context.loader.builtins, { tools: provider.Provider, consumer });
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

  it('每次 createToolsProvider 的狀態是新的', () => {
    expect(createToolsProvider().entries()).toEqual([]);
    const one = createToolsProvider();
    const two = createToolsProvider();
    expect(one.Provider).not.toBe(two.Provider);
  });
});
