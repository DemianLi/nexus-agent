import type { Context } from '@nexus/cordis';
import { Context as RootContext } from '@nexus/cordis';
import Loader from '@nexus/cordis-plugin-loader';
import type { EntryOptions } from '@nexus/cordis-plugin-loader';
import { injectOf, need, service } from '@nexus/sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { skillSourcesToken } from './index.js';
import { createSkillSourcesProvider } from './provider.js';

/** 一顆依序登記 `config.sources` 的消費者，以命名空間物件的形式。 */
const consumer = {
  name: 'skill-sources-consumer',
  inject: injectOf(need(skillSourcesToken, '^1.0.0')),
  apply(ctx: Context, config: { sources: string[] }) {
    for (const path of config.sources) service(ctx, skillSourcesToken).addSource(path);
  },
};

let root: RootContext | undefined;
afterEach(async () => {
  await root?.fiber.dispose();
  root = undefined;
});

async function boot() {
  const provider = createSkillSourcesProvider();
  const context = new RootContext();
  root = context;
  await context.plugin(Loader);
  Object.assign(context.loader.builtins, { 'skill-sources': provider.Provider, consumer });
  const create = (options: EntryOptions) =>
    context.loader.create(options as Omit<EntryOptions, 'id'>, null);
  await create({ id: 'skill-sources', name: 'cordis:skill-sources' });
  const add = (id: string, sources: string[]) =>
    create({ id, name: 'cordis:consumer', config: { sources } });
  const stop = (id: string) => context.loader.resolve(id).fiber?.ctx.fiber.dispose();
  const reconfigure = async (id: string, sources: string[]) => {
    await context.loader.resolve(id).update({ config: { sources } } as never);
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

describe('技能來源登記處的提供者', () => {
  it('每條路徑記下登記者那一列的 id 與原文，依登記順序（同一列的 sources 依序）', async () => {
    const { provider, loader, add } = await boot();
    await add('row-a', ['/base/', '/proj']);
    await add('row-b', ['/other/']);
    await loader.await();
    expect(provider.entries()).toEqual([
      { path: '/base/', source: 'row-a' },
      { path: '/proj', source: 'row-a' },
      { path: '/other/', source: 'row-b' },
    ]);
    expect(provider.registrations()).toBe(3);
  });

  it('消費者那一列卸載，它登記的路徑自己撤掉，別的列不受影響', async () => {
    const { provider, loader, add, stop } = await boot();
    await add('row-a', ['/a/']);
    await add('row-b', ['/b/']);
    await loader.await();
    await stop('row-a');
    expect(provider.entries()).toEqual([{ path: '/b/', source: 'row-b' }]);
  });

  describe('路徑格式在登記時就驗（Q2 (a)）', () => {
    it.each([
      ['~/skills', '~'],
      ['skills/', '絕對路徑'],
      ['/a/../b', '".."'],
      ['/a//b', '空路段'],
      ['/a\\b', '\\'],
    ])('%s 當場拒絕，那一列 FAILED，訊息帶列 id 與路徑', async (path, hint) => {
      const { provider, loader, add, stateOf, errorOf } = await boot();
      await add('row-a', [path]);
      await loader.await();
      expect(stateOf('row-a')).toBe(FAILED);
      const error = await errorOf('row-a');
      expect(error?.message).toContain('row-a');
      expect(error?.message).toContain(path);
      expect(error?.message).toContain(hint);
      expect(provider.entries()).toEqual([]);
    });
  });

  describe('同一個目錄只收一次（Q3 (a)）', () => {
    it('兩列登記同一個路徑：後登記的那一列 FAILED，錯誤指名兩邊，先登記的照舊在', async () => {
      const { provider, loader, add, stateOf, errorOf } = await boot();
      await add('row-a', ['/skills/']);
      await add('row-b', ['/skills/']);
      await loader.await();
      expect(stateOf('row-a')).toBe(ACTIVE);
      expect(stateOf('row-b')).toBe(FAILED);
      expect(provider.entries()).toEqual([{ path: '/skills/', source: 'row-a' }]);
      const error = await errorOf('row-b');
      expect(error?.message).toContain('row-a');
      expect(error?.message).toContain('row-b');
    });

    it('結尾斜線不同也是同一個目錄', async () => {
      const { loader, add, stateOf } = await boot();
      await add('row-a', ['/skills/']);
      await add('row-b', ['/skills']);
      await loader.await();
      expect(stateOf('row-b')).toBe(FAILED);
    });

    it('同一列自己寫兩次也拒絕（以前要到組 thread 才在 core 的 registry 掉）', async () => {
      const { provider, loader, add, stateOf } = await boot();
      await add('row-a', ['/skills/', '/skills']);
      await loader.await();
      expect(stateOf('row-a')).toBe(FAILED);
      expect(provider.entries()).toEqual([]);
    });

    it('同一列改設定重掛：不會被自己舊的那一份判成重名，順序跟著新設定', async () => {
      const { provider, loader, add, reconfigure, stateOf } = await boot();
      await add('row-a', ['/skills/', '/more/']);
      await add('row-b', ['/b/']);
      await loader.await();
      // 改成「同一個目錄還在、另外多一條」：舊的那一份若還佔著 `/skills/`，這裡會自己撞自己。
      await reconfigure('row-a', ['/skills/', '/more/', '/extra/']);
      expect(stateOf('row-a')).toBe(ACTIVE);
      expect(
        provider
          .entries()
          .filter((entry) => entry.source === 'row-a')
          .map((entry) => entry.path),
      ).toEqual(['/skills/', '/more/', '/extra/']);
      expect(provider.entries().filter((entry) => entry.source === 'row-b')).toHaveLength(1);
    });

    it('別列停掉之後，被它佔著的目錄可以被另一列登記', async () => {
      const { provider, loader, add, stop, reconfigure } = await boot();
      await add('row-a', ['/skills/']);
      await add('row-b', ['/b/']);
      await loader.await();
      await stop('row-a');
      await reconfigure('row-b', ['/b/', '/skills/']);
      expect(provider.entries()).toEqual([
        { path: '/b/', source: 'row-b' },
        { path: '/skills/', source: 'row-b' },
      ]);
    });
  });

  it('每次 createSkillSourcesProvider 的狀態是新的', () => {
    expect(createSkillSourcesProvider().entries()).toEqual([]);
    const one = createSkillSourcesProvider();
    const two = createSkillSourcesProvider();
    expect(one.Provider).not.toBe(two.Provider);
  });
});
