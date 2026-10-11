/**
 * [#1386](https://github.com/DemianLi/nexus-agent/issues/1386) 驗收 ⑤：用 `provide` 的 `check` 擋下 major 不相容的提供者，錯誤指名插件與服務。
 *
 * 全部走 vendor 的 Loader：提供者與消費者各是一列，消費者的 id 就是錯誤裡指名的那個。量的是 Cordis 本來的行為，
 * 所以除了 `contract.ts` 那個 `Service` 子類別之外沒有任何框架層的補丁。
 */

import type { Context } from 'cordis';
import { describe, expect, it } from 'vitest';
import { ContractError, contractProvider } from './contract.js';
import { STATE, boot as bootTree, createEntry, fiberOf } from './tree.js';

declare module 'cordis' {
  interface Context {
    memory: { version: string };
  }
}

/** 開一棵樹，另外挑出 ContractError 與記下它的 fiber。 */
async function boot(builtins: Record<string, unknown>) {
  const t = await bootTree(builtins);
  const contractLogs = () =>
    t.errors.filter((message) => message.args.some((arg) => arg instanceof ContractError));
  const thrown = () =>
    contractLogs().flatMap((message) => message.args.filter((arg) => arg instanceof ContractError));
  const loggedBy = () => contractLogs().map((message) => message.fiber?.deref());
  return { ...t, thrown, loggedBy };
}

/** 消費者：拿到服務就記下版本。範圍可以寫在插件自己的 inject，或交給 Loader 列的 intercept。 */
function consumer(range?: string) {
  const seen: string[] = [];
  const plugin = {
    name: 'memory-consumer',
    inject: range === undefined ? ['memory'] : { memory: { range } },
    apply(ctx: Context) {
      seen.push(ctx.memory.version);
    },
  };
  return { plugin, seen };
}

describe('服務契約的 semver 檢查（#1386 ⑤）', () => {
  it('範圍相容：消費者 ACTIVE、拿到服務', async () => {
    const c = consumer('^2.0.0');
    const t = await boot({ v2: contractProvider('memory', '2.3.0'), consumer: c.plugin });
    await t.loader.create({ name: 'cordis:v2' });
    await createEntry(t.loader, { id: 'consumer-ok', name: 'cordis:consumer' });
    await t.loader.await();
    expect(t.state('consumer-ok')).toBe(STATE.ACTIVE);
    expect(c.seen).toEqual(['2.3.0']);
    expect(t.thrown()).toEqual([]);
  });

  it('major 不相容：消費者停在 PENDING，錯誤指名消費者與提供者兩列、服務與兩邊版本', async () => {
    const c = consumer('^3.0.0');
    const t = await boot({ v2: contractProvider('memory', '2.3.0'), consumer: c.plugin });
    await createEntry(t.loader, { id: 'provider', name: 'cordis:v2' });
    await createEntry(t.loader, { id: 'consumer-new', name: 'cordis:consumer' });
    await t.loader.await();
    expect(t.state('consumer-new')).toBe(STATE.PENDING);
    expect(c.seen).toEqual([]);
    const [error] = t.thrown();
    expect(error?.message).toBe(
      '插件 consumer-new 要的服務 memory 是 ^3.0.0，provider 提供的是 2.3.0',
    );
    expect(error).toMatchObject({
      consumer: 'consumer-new',
      provider: 'provider',
      service: 'memory',
      provided: '2.3.0',
      range: '^3.0.0',
    });
    // 錯誤進的是**提供者**的 logger：結構化的歸屬指向提供者，消費者只出現在訊息與 ContractError 的欄位裡。
    // （比身分，不用 toEqual：vitest 印 Fiber 時會碰到 Cordis 的 proxy 而拋錯。）
    const [loggedBy, ...rest] = t.loggedBy();
    expect(rest).toHaveLength(0);
    expect(loggedBy === fiberOf(t.loader, 'provider')).toBe(true);
    expect(loggedBy === fiberOf(t.loader, 'consumer-new')).toBe(false);
  });

  it('範圍寫在 Loader 列的 intercept（manifest 的 consumes 會落在這裡），插件本身只寫 inject 名字', async () => {
    const c = consumer();
    const t = await boot({ v2: contractProvider('memory', '2.3.0'), consumer: c.plugin });
    await t.loader.create({ name: 'cordis:v2' });
    await createEntry(t.loader, {
      id: 'consumer-row',
      name: 'cordis:consumer',
      intercept: { memory: { range: '^3.0.0' } },
    });
    await t.loader.await();
    expect(t.state('consumer-row')).toBe(STATE.PENDING);
    expect(t.thrown()).toMatchObject([{ consumer: 'consumer-row', range: '^3.0.0' }]);
  });

  it('換上相容的提供者：被擋的消費者自己接上，原本相容的那個換成被擋', async () => {
    const oldOne = consumer('^2.0.0');
    const newOne = consumer('^3.0.0');
    const t = await boot({
      v2: contractProvider('memory', '2.3.0'),
      v3: contractProvider('memory', '3.0.1'),
      old: oldOne.plugin,
      new: newOne.plugin,
    });
    await createEntry(t.loader, { id: 'provider', name: 'cordis:v2' });
    await createEntry(t.loader, { id: 'old', name: 'cordis:old' });
    await createEntry(t.loader, { id: 'new', name: 'cordis:new' });
    await t.loader.await();
    expect([t.state('old'), t.state('new')]).toEqual([STATE.ACTIVE, STATE.PENDING]);

    t.loader.remove('provider');
    await createEntry(t.loader, { id: 'provider', name: 'cordis:v3' });
    await t.loader.await();
    expect([t.state('old'), t.state('new')]).toEqual([STATE.PENDING, STATE.ACTIVE]);
    expect(newOne.seen).toEqual(['3.0.1']);
  });

  it('負對照：plain object 提供者的 check 摸不到消費者——this 就是值本身，消費者宣告的範圍讀不到', async () => {
    const value = { version: '2.3.0' };
    const receivers: unknown[] = [];
    const c = consumer('^3.0.0');
    const t = await boot({
      provider: (ctx: Context) => {
        ctx.reflect.provide('memory', value, function (this: unknown) {
          receivers.push(this);
          return true;
        });
      },
      consumer: c.plugin,
    });
    await t.loader.create({ name: 'cordis:provider' });
    await createEntry(t.loader, { id: 'consumer-plain', name: 'cordis:consumer' });
    await t.loader.await();
    expect(receivers.length).toBeGreaterThan(0);
    expect(receivers.every((receiver) => receiver === value)).toBe(true);
    // check 只能回 true／false，看不到消費者宣告的 ^3.0.0，所以不相容的也放行了。
    expect(t.state('consumer-plain')).toBe(STATE.ACTIVE);
  });
});
