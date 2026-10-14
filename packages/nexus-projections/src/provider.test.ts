import type { Context } from '@nexus/cordis';
import { Context as RootContext } from '@nexus/cordis';
import Loader from '@nexus/cordis-plugin-loader';
import type { EntryOptions } from '@nexus/cordis-plugin-loader';
import type { ProjectionUnit } from '@nexus/core';
import { injectOf, need, service } from '@nexus/sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { projectionsToken } from './index.js';
import { createProjectionsProvider } from './provider.js';

const unit = (key: string, stateVersion = 1): ProjectionUnit<number, number> => ({
  key,
  stateVersion,
  init: () => 0,
  apply: (state) => state,
  view: (state) => state,
});

/** 一顆登記 `config.units` 裡每個單元的消費者，以命名空間物件的形式。 */
const consumer = {
  name: 'projections-consumer',
  inject: injectOf(need(projectionsToken, '^1.0.0')),
  apply(ctx: Context, config: { units: [string, number][] }) {
    for (const [key, version] of config.units) {
      service(ctx, projectionsToken).register(unit(key, version));
    }
  },
};

let root: RootContext | undefined;
afterEach(async () => {
  await root?.fiber.dispose();
  root = undefined;
});

async function boot() {
  const provider = createProjectionsProvider();
  const context = new RootContext();
  root = context;
  await context.plugin(Loader);
  Object.assign(context.loader.builtins, { projections: provider.Provider, consumer });
  const create = (options: EntryOptions) =>
    context.loader.create(options as Omit<EntryOptions, 'id'>, null);
  await create({ id: 'projections', name: 'cordis:projections' });
  const add = (id: string, units: [string, number][]) =>
    create({ id, name: 'cordis:consumer', config: { units } });
  const stop = (id: string) => context.loader.resolve(id).fiber?.ctx.fiber.dispose();
  return { provider, loader: context.loader, add, stop };
}

describe('投影登記處的提供者', () => {
  it('每個 key 記下登記者那一列的 id，依第一次登記的順序', async () => {
    const { provider, loader, add } = await boot();
    await add('row-a', [['alpha', 1]]);
    await add('row-b', [['beta', 1]]);
    await loader.await();
    expect(provider.entries().map((entry) => [entry.unit.key, entry.sources])).toEqual([
      ['alpha', ['row-a']],
      ['beta', ['row-b']],
    ]);
    expect(provider.registrations()).toBe(2);
  });

  it('消費者那一列卸載，它登記的單元自己撤掉，別的列不受影響', async () => {
    const { provider, loader, add, stop } = await boot();
    await add('row-a', [['alpha', 1]]);
    await add('row-b', [['beta', 1]]);
    await loader.await();
    await stop('row-a');
    expect(provider.entries().map((entry) => entry.unit.key)).toEqual(['beta']);
  });

  describe('同一個 key（照 dsh：引用計數共用）', () => {
    it('同 key 同 stateVersion：兩列都起來，登記處只有一份，兩列都是登記者', async () => {
      const { provider, loader, add } = await boot();
      await add('row-a', [['shared', 1]]);
      await add('row-b', [['shared', 1]]);
      await loader.await();
      expect(loader.resolve('row-a').fiber?.ctx.fiber.state).toBe(2);
      expect(loader.resolve('row-b').fiber?.ctx.fiber.state).toBe(2);
      expect(provider.entries().map((entry) => [entry.unit.key, entry.sources])).toEqual([
        ['shared', ['row-a', 'row-b']],
      ]);
      expect(provider.registrations()).toBe(2);
    });

    it('停掉其中一列：key 還在，單元照舊是第一個登記者的；兩列都停：key 沒了', async () => {
      const { provider, loader, add, stop } = await boot();
      await add('row-a', [['shared', 1]]);
      await add('row-b', [['shared', 1]]);
      await loader.await();
      const first = provider.entries()[0]?.unit;
      await stop('row-a');
      expect(provider.entries().map((entry) => [entry.unit.key, entry.sources])).toEqual([
        ['shared', ['row-b']],
      ]);
      // 引用計數沒歸零：第一個登記者的定義不換。
      expect(provider.entries()[0]?.unit).toBe(first);
      await stop('row-b');
      expect(provider.entries()).toEqual([]);
      expect(provider.registrations()).toBe(0);
    });

    it('stateVersion 不同：後到的那列 FAILED，錯誤指名 key、兩個版本與兩邊的來源，第一個照舊在', async () => {
      const { provider, loader, add } = await boot();
      await add('row-a', [['shared', 1]]);
      await add('row-b', [['shared', 2]]);
      await loader.await();
      expect(provider.entries().map((entry) => [entry.unit.key, entry.sources])).toEqual([
        ['shared', ['row-a']],
      ]);
      const fiber = loader.resolve('row-b').fiber?.ctx.fiber;
      expect(fiber?.state).toBe(3);
      const error = await fiber?.await().then(
        () => undefined,
        (reason: unknown) => reason as Error,
      );
      expect(error?.message).toContain('shared');
      expect(error?.message).toContain('stateVersion 1');
      expect(error?.message).toContain('stateVersion 2');
      expect(error?.message).toContain('row-a');
      expect(error?.message).toContain('row-b');
    });
  });

  it('不合規的單元（key 不合型）當場拒絕，列 FAILED', async () => {
    const { provider, loader, add } = await boot();
    await add('row-a', [['Bad_Key', 1]]);
    await loader.await();
    expect(loader.resolve('row-a').fiber?.ctx.fiber.state).toBe(3);
    expect(provider.entries()).toEqual([]);
  });

  it('每次 createProjectionsProvider 的狀態是新的', () => {
    expect(createProjectionsProvider().entries()).toEqual([]);
    const one = createProjectionsProvider();
    const two = createProjectionsProvider();
    expect(one.Provider).not.toBe(two.Provider);
  });
});
