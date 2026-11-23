/**
 * 會話參與者的登記（#1491 Q2）：`sessionLookup.join` 與提供者的 `participants()`／`registrations()`。
 * 「折進 thread 的位置」與「冷復活」在 `apps/harness` 的 `permission-presets-on-tree.test.ts`；這裡只管登記簿本身。
 */

import { Context } from '@nexus/cordis';
import Loader from '@nexus/cordis-plugin-loader';
import { afterEach, describe, expect, it } from 'vitest';

import { sessionLookupToken } from './index.js';
import type { SessionInstaller, SessionLookupService } from './index.js';
import { createSessionLookupProvider } from './provider.js';

const opened: Context[] = [];
afterEach(async () => {
  for (const root of opened.splice(0)) await root.fiber.dispose();
});

async function mount() {
  const handle = createSessionLookupProvider(() => ({ kind: 'not-attached' }));
  const root = new Context();
  opened.push(root);
  await root.plugin(Loader);
  Object.assign(root.loader.builtins, { 'session-lookup': handle.Provider });
  await root.loader.create({ id: 'session-lookup', name: 'cordis:session-lookup' } as never, null);
  await root.loader.await();
  const service = root.get(sessionLookupToken.name) as SessionLookupService;
  return { handle, root, service };
}

const noop: SessionInstaller = () => undefined;

describe('sessionLookup.join', () => {
  it('登記一位：participants() 看得到，註冊筆數 +1；撤銷函式把它撤掉', async () => {
    const { handle, service } = await mount();
    const off = service.join(noop);
    expect(handle.participants().map((entry) => entry.participant)).toEqual([noop]);
    expect(handle.registrations()).toBe(1);
    off();
    expect(handle.participants()).toEqual([]);
    expect(handle.registrations()).toBe(0);
  });

  it('依登記順序；快照不會跟著之後的登記變', async () => {
    const { handle, service } = await mount();
    const a: SessionInstaller = () => undefined;
    const b: SessionInstaller = () => undefined;
    service.join(a);
    const snapshot = handle.participants();
    service.join(b);
    expect(snapshot.map((entry) => entry.participant)).toEqual([a]);
    expect(handle.participants().map((entry) => entry.participant)).toEqual([a, b]);
  });

  it('撤其中一位不動其他位；撤兩次是空操作', async () => {
    const { handle, service } = await mount();
    const a: SessionInstaller = () => undefined;
    const b: SessionInstaller = () => undefined;
    const offA = service.join(a);
    service.join(b);
    offA();
    offA();
    expect(handle.participants().map((entry) => entry.participant)).toEqual([b]);
  });

  it('不是函式：拋 TypeError，訊息帶登記者；什麼都沒登記', async () => {
    const { handle, service } = await mount();
    expect(() => service.join('nope' as never)).toThrow(TypeError);
    expect(handle.registrations()).toBe(0);
  });

  it('登記者那一列卸載：它登記的參與者跟著撤掉（effect 歸屬）', async () => {
    const { handle, root } = await mount();
    const mounted = root.plugin(
      {
        name: 'joiner',
        inject: ['sessionLookup'],
        apply(ctx: Context) {
          (ctx as unknown as { sessionLookup: SessionLookupService }).sessionLookup.join(noop);
        },
      } as never,
      {} as never,
    );
    await root.loader.await();
    expect(handle.registrations()).toBe(1);
    expect(handle.participants()[0]?.source).toBe('joiner');
    await (mounted as unknown as { dispose(): Promise<void> | void }).dispose();
    expect(handle.registrations()).toBe(0);
  });
});
