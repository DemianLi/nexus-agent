import type { Context } from '@nexus/cordis';
import { describe, expect, it } from 'vitest';

import { ContractError } from './contract.js';
import { boot } from './fixtures/boot.js';
import { createRegistryProvider, widgetsToken } from './fixtures/registry.js';
import { FIBER_STATE, fiberOf } from './conformance.js';
import { injectOf, need, service } from './token.js';

function consumer(range?: string) {
  const seen: string[] = [];
  const plugin = {
    name: 'widget-consumer',
    inject: range === undefined ? ['widgets'] : injectOf(need(widgetsToken, range)),
    apply(ctx: Context) {
      seen.push(
        (service(ctx, widgetsToken) as unknown as { contractVersion: string }).contractVersion,
      );
    },
  };
  return { plugin, seen };
}

async function setup(builtins: Record<string, unknown>) {
  const t = await boot(builtins);
  const thrown = () =>
    t.errors.flatMap((message) => message.args.filter((arg) => arg instanceof ContractError));
  return { ...t, thrown };
}

describe('服務契約的 semver 檢查（驗收 C）', () => {
  it('範圍相容：消費者 ACTIVE、拿到服務', async () => {
    const c = consumer('^1.0.0');
    const t = await setup({ provider: createRegistryProvider().Provider, consumer: c.plugin });
    await t.create({ id: 'provider', name: 'cordis:provider' });
    await t.create({ id: 'consumer-ok', name: 'cordis:consumer' });
    await t.loader.await();
    expect(t.state('consumer-ok')).toBe(FIBER_STATE.ACTIVE);
    expect(c.seen).toEqual(['1.2.0']);
    expect(t.thrown()).toEqual([]);
  });

  it('major 不相容：消費者不起來，錯誤指名消費者、提供者、服務、兩邊的版本與範圍', async () => {
    const c = consumer('^2.0.0');
    const t = await setup({ provider: createRegistryProvider().Provider, consumer: c.plugin });
    await t.create({ id: 'provider', name: 'cordis:provider' });
    await t.create({ id: 'consumer-new', name: 'cordis:consumer' });
    await t.loader.await();
    expect(t.state('consumer-new')).toBe(FIBER_STATE.PENDING);
    expect(c.seen).toEqual([]);
    const [error, ...rest] = t.thrown();
    expect(rest).toHaveLength(0);
    expect(error?.message).toBe(
      '插件 consumer-new 要的服務 widgets 是 ^2.0.0，provider 提供的是 1.2.0',
    );
    expect(error).toMatchObject({
      consumer: 'consumer-new',
      provider: 'provider',
      service: 'widgets',
      provided: '1.2.0',
      range: '^2.0.0',
    });
    // Cordis 把錯誤交給**提供者**的 logger：歸屬指向提供者，要對回消費者那一列只能靠 ContractError 的欄位。
    // （比身分，不用 toEqual：vitest 印 Fiber 會碰到 Cordis 的 proxy 而拋錯。）
    const logged = t.errors.find((message) => message.args.includes(error));
    expect(logged?.fiber?.deref() === fiberOf(t.loader, 'provider')).toBe(true);
  });

  it('範圍寫在 Loader 列的 intercept，插件本身只寫 inject 名字', async () => {
    const c = consumer();
    const t = await setup({ provider: createRegistryProvider().Provider, consumer: c.plugin });
    await t.create({ id: 'provider', name: 'cordis:provider' });
    await t.create({
      id: 'consumer-row',
      name: 'cordis:consumer',
      intercept: { widgets: { range: '^2.0.0' } },
    });
    await t.loader.await();
    expect(t.state('consumer-row')).toBe(FIBER_STATE.PENDING);
    expect(t.thrown()).toMatchObject([{ consumer: 'consumer-row', range: '^2.0.0' }]);
  });

  it('沒宣告範圍就不檢查', async () => {
    const c = consumer();
    const t = await setup({ provider: createRegistryProvider().Provider, consumer: c.plugin });
    await t.create({ id: 'provider', name: 'cordis:provider' });
    await t.create({ id: 'consumer-open', name: 'cordis:consumer' });
    await t.loader.await();
    expect(t.state('consumer-open')).toBe(FIBER_STATE.ACTIVE);
  });

  it('換上相容的提供者：被擋的消費者自己接上', async () => {
    const need2 = consumer('^2.0.0');
    const t = await setup({
      v1: createRegistryProvider().Provider,
      v2: createRegistryProvider({ version: '2.0.1' }).Provider,
      consumer: need2.plugin,
    });
    await t.create({ id: 'provider', name: 'cordis:v1' });
    await t.create({ id: 'consumer', name: 'cordis:consumer' });
    await t.loader.await();
    expect(t.state('consumer')).toBe(FIBER_STATE.PENDING);
    t.loader.remove('provider');
    await t.create({ id: 'provider', name: 'cordis:v2' });
    await t.loader.await();
    expect(t.state('consumer')).toBe(FIBER_STATE.ACTIVE);
    expect(need2.seen).toEqual(['2.0.1']);
  });
});
