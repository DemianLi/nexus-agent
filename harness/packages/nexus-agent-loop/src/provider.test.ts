import type { Context } from '@nexus/cordis';
import { Context as RootContext } from '@nexus/cordis';
import Loader from '@nexus/cordis-plugin-loader';
import type { EntryOptions } from '@nexus/cordis-plugin-loader';
import { injectOf, need, service } from '@nexus/sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { agentLoopToken } from './index.js';
import type { PreStepListener } from './index.js';
import { createAgentLoopProvider } from './provider.js';

const NOOP: PreStepListener = () => undefined;

/** 依序登記 `config.names` 的消費者，以命名空間物件的形式。 */
const consumer = {
  name: 'agent-loop-consumer',
  inject: injectOf(need(agentLoopToken, '^1.0.0')),
  apply(ctx: Context, config: { names: string[] }) {
    for (const name of config.names) service(ctx, agentLoopToken).preStep(name, NOOP);
  },
};

let root: RootContext | undefined;
afterEach(async () => {
  await root?.fiber.dispose();
  root = undefined;
});

async function boot() {
  const provider = createAgentLoopProvider();
  const context = new RootContext();
  root = context;
  await context.plugin(Loader);
  Object.assign(context.loader.builtins, { 'pre-step': provider.Provider, consumer });
  const create = (options: EntryOptions) =>
    context.loader.create(options as Omit<EntryOptions, 'id'>, null);
  await create({ id: 'pre-step', name: 'cordis:pre-step' });
  const add = (id: string, names: string[]) =>
    create({ id, name: 'cordis:consumer', config: { names } });
  const stop = (id: string) => context.loader.resolve(id).fiber?.ctx.fiber.dispose();
  const reconfigure = async (id: string, names: string[]) => {
    await context.loader.resolve(id).update({ config: { names } } as never);
    await context.loader.await();
  };
  const stateOf = (id: string) => context.loader.resolve(id).fiber?.ctx.fiber.state;
  const errorOf = async (id: string) =>
    context.loader
      .resolve(id)
      .fiber?.ctx.fiber.await()
      .then(
        () => undefined,
        (reason: unknown) => reason as Error,
      );
  return { provider, loader: context.loader, add, stop, reconfigure, stateOf, errorOf };
}

const ACTIVE = 2;
const FAILED = 3;

describe('agent loop 登記處的提供者', () => {
  it('每位 listener 記下名字、listener 與登記者那一列的 id，依登記順序', async () => {
    const { provider, loader, add } = await boot();
    await add('row-a', ['A1', 'A2']);
    await add('row-b', ['B1']);
    await loader.await();
    expect(provider.preSteps().map(({ name, source }) => ({ name, source }))).toEqual([
      { name: 'A1', source: 'row-a' },
      { name: 'A2', source: 'row-a' },
      { name: 'B1', source: 'row-b' },
    ]);
    expect(provider.preSteps().every((entry) => entry.listener === NOOP)).toBe(true);
    expect(provider.registrations()).toBe(3);
  });

  it('消費者那一列卸載，它登記的 listener 自己撤掉，別的列不受影響', async () => {
    const { provider, loader, add, stop } = await boot();
    await add('row-a', ['A']);
    await add('row-b', ['B']);
    await loader.await();
    await stop('row-a');
    expect(provider.preSteps().map((entry) => entry.name)).toEqual(['B']);
  });

  it('名字是空的就當場拒絕，那一列 FAILED，訊息帶列 id', async () => {
    const { provider, loader, add, stateOf, errorOf } = await boot();
    await add('row-a', ['  ']);
    await loader.await();
    expect(stateOf('row-a')).toBe(FAILED);
    expect((await errorOf('row-a'))?.message).toContain('row-a');
    expect(provider.preSteps()).toEqual([]);
  });

  it('兩列登記同一個名字：後登記的那一列 FAILED，錯誤指名兩邊，先登記的照舊在', async () => {
    const { provider, loader, add, stateOf, errorOf } = await boot();
    await add('row-a', ['Same']);
    await add('row-b', ['Same']);
    await loader.await();
    expect(stateOf('row-a')).toBe(ACTIVE);
    expect(stateOf('row-b')).toBe(FAILED);
    expect(provider.preSteps().map(({ name, source }) => ({ name, source }))).toEqual([
      { name: 'Same', source: 'row-a' },
    ]);
    const error = await errorOf('row-b');
    expect(error?.message).toContain('row-a');
    expect(error?.message).toContain('row-b');
  });

  it('同一列自己寫兩次也拒絕', async () => {
    const { provider, loader, add, stateOf } = await boot();
    await add('row-a', ['Same', 'Same']);
    await loader.await();
    expect(stateOf('row-a')).toBe(FAILED);
    expect(provider.preSteps()).toEqual([]);
  });

  it('同一列改設定重掛：不會被自己舊的那一份判成重名', async () => {
    const { provider, loader, add, reconfigure, stateOf } = await boot();
    await add('row-a', ['A', 'B']);
    await loader.await();
    await reconfigure('row-a', ['A', 'B', 'C']);
    expect(stateOf('row-a')).toBe(ACTIVE);
    expect(provider.preSteps().map((entry) => entry.name)).toEqual(['A', 'B', 'C']);
  });

  it('每次 createAgentLoopProvider 的狀態是新的', () => {
    expect(createAgentLoopProvider().preSteps()).toEqual([]);
    const one = createAgentLoopProvider();
    const two = createAgentLoopProvider();
    expect(one.Provider).not.toBe(two.Provider);
  });
});
