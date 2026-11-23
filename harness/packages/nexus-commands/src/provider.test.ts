import type { Context } from '@nexus/cordis';
import { Context as RootContext } from '@nexus/cordis';
import Loader from '@nexus/cordis-plugin-loader';
import type { EntryOptions } from '@nexus/cordis-plugin-loader';
import { injectOf, need, service } from '@nexus/sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { commandsToken } from './index.js';
import type { CommandDefinition } from './index.js';
import { createCommandsProvider } from './provider.js';

const define = (name: string, description = `命令 ${name}`): CommandDefinition => ({
  name,
  description,
  handler: () => ({ kind: 'success' }),
});

/** 一顆依序登記 `config.names` 的消費者，以命名空間物件的形式。 */
const consumer = {
  name: 'commands-consumer',
  inject: injectOf(need(commandsToken, '^1.0.0')),
  apply(ctx: Context, config: { names: string[] }) {
    for (const name of config.names) service(ctx, commandsToken).register(define(name));
  },
};

let root: RootContext | undefined;
afterEach(async () => {
  await root?.fiber.dispose();
  root = undefined;
});

async function boot() {
  const provider = createCommandsProvider();
  const context = new RootContext();
  root = context;
  await context.plugin(Loader);
  Object.assign(context.loader.builtins, { commands: provider.Provider, consumer });
  const create = (options: EntryOptions) =>
    context.loader.create(options as Omit<EntryOptions, 'id'>, null);
  await create({ id: 'commands', name: 'cordis:commands' });
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

describe('命令登記處的提供者', () => {
  it('每個命令記下登記者那一列的 id 與完整定義（含 handler），依登記順序', async () => {
    const { provider, loader, add } = await boot();
    await add('row-a', ['beta', 'alpha']);
    await add('row-b', ['gamma']);
    await loader.await();
    expect(provider.entries().map((entry) => [entry.definition.name, entry.source])).toEqual([
      ['beta', 'row-a'],
      ['alpha', 'row-a'],
      ['gamma', 'row-b'],
    ]);
    expect(typeof provider.entries()[0]?.definition.handler).toBe('function');
    expect(provider.registrations()).toBe(3);
  });

  it('list 依名字排序、不帶 handler（同 core 的 registry）', async () => {
    const { loader, add } = await boot();
    await add('row-a', ['beta', 'alpha']);
    await loader.await();
    const registry = (await loader.resolve('commands').fiber?.ctx.fiber.await(), undefined);
    expect(registry).toBeUndefined();
    const listing = root!.get('commands') as { list(): readonly Record<string, unknown>[] };
    expect(listing.list().map((descriptor) => descriptor['name'])).toEqual(['alpha', 'beta']);
    expect('handler' in listing.list()[0]!).toBe(false);
  });

  it('消費者那一列卸載，它登記的命令自己撤掉，別的列不受影響', async () => {
    const { provider, loader, add, stop } = await boot();
    await add('row-a', ['alpha']);
    await add('row-b', ['beta']);
    await loader.await();
    await stop('row-a');
    expect(provider.entries().map((entry) => entry.definition.name)).toEqual(['beta']);
  });

  describe('中繼資料在登記時就驗', () => {
    it.each([['Bad'], ['1abc'], ['has space'], ['']])(
      '名字 %j 當場拒絕，那一列 FAILED',
      async (name) => {
        const { provider, loader, add, stateOf } = await boot();
        await add('row-a', [name]);
        await loader.await();
        expect(stateOf('row-a')).toBe(FAILED);
        expect(provider.entries()).toEqual([]);
      },
    );
  });

  describe('同一個名字只收一次（Q5 (a)）', () => {
    it('兩列登記同名命令：後登記的那一列 FAILED，錯誤指名兩邊，先登記的照舊在', async () => {
      const { provider, loader, add, stateOf, errorOf } = await boot();
      await add('row-a', ['dup']);
      await add('row-b', ['dup']);
      await loader.await();
      expect(stateOf('row-a')).toBe(ACTIVE);
      expect(stateOf('row-b')).toBe(FAILED);
      expect(provider.entries().map((entry) => entry.source)).toEqual(['row-a']);
      const error = await errorOf('row-b');
      expect(error?.message).toContain('/dup');
      expect(error?.message).toContain('row-a');
      expect(error?.message).toContain('row-b');
    });

    it('同一列自己寫兩次也拒絕', async () => {
      const { provider, loader, add, stateOf } = await boot();
      await add('row-a', ['dup', 'dup']);
      await loader.await();
      expect(stateOf('row-a')).toBe(FAILED);
      expect(provider.entries()).toEqual([]);
    });

    it('同一列改設定重掛：不會被自己舊的那一份判成重名', async () => {
      const { provider, loader, add, reconfigure, stateOf } = await boot();
      await add('row-a', ['alpha']);
      await loader.await();
      await reconfigure('row-a', ['alpha', 'beta']);
      expect(stateOf('row-a')).toBe(ACTIVE);
      expect(provider.entries().map((entry) => entry.definition.name)).toEqual(['alpha', 'beta']);
    });

    it('別列停掉之後，被它佔著的名字可以被另一列登記', async () => {
      const { provider, loader, add, stop, reconfigure } = await boot();
      await add('row-a', ['alpha']);
      await add('row-b', ['beta']);
      await loader.await();
      await stop('row-a');
      await reconfigure('row-b', ['beta', 'alpha']);
      expect(provider.entries().map((entry) => entry.definition.name)).toEqual(['beta', 'alpha']);
    });
  });

  it('每次 createCommandsProvider 的狀態是新的', () => {
    expect(createCommandsProvider().entries()).toEqual([]);
    expect(createCommandsProvider().Provider).not.toBe(createCommandsProvider().Provider);
  });
});
