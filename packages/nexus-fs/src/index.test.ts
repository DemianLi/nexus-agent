import { readFileSync } from 'node:fs';

import { Context } from '@nexus/cordis';
import Loader from '@nexus/cordis-plugin-loader';
import { injectOf, need, service } from '@nexus/sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { createFsService, virtualPathOf as coreVirtualPathOf } from '@nexus/core';
import type { FsService } from '@nexus/core';

import { FS_LOOKUP_CONTRACT_VERSION, fsToken, virtualPathOf } from './index.js';
import type { FsLookup } from './index.js';
import { createFsLookupProvider } from './provider.js';

let root: Context | undefined;
afterEach(async () => {
  await root?.fiber.dispose();
  root = undefined;
});

describe('@nexus/fs 的定義', () => {
  it('token 名是 fs，契約版本是 semver 常數', () => {
    expect(fsToken).toEqual({ name: 'fs', version: FS_LOOKUP_CONTRACT_VERSION });
    expect(FS_LOOKUP_CONTRACT_VERSION).toBe('2.2.0');
  });

  it('virtualPathOf 是 core 那一支的單向轉出：同一個函式、相對路徑以根為起點、.. 夾回根（#1469）', () => {
    expect(virtualPathOf).toBe(coreVirtualPathOf);
    expect(virtualPathOf('report.md')).toBe('/report.md');
    expect(virtualPathOf('a/../b.md')).toBe('/b.md');
    expect(virtualPathOf('../x.md')).toBe('/x.md');
  });

  it('提供者的服務：每次呼叫都問宿主交進來的函式（不快取），config 原樣傳入', async () => {
    const seen: unknown[] = [];
    let answer: FsLookup = { kind: 'not-attached' };
    const provider = createFsLookupProvider((config) => {
      seen.push(config);
      return answer;
    });
    let grabbed: { forCall(config: unknown): FsLookup } | undefined;
    const consumer = {
      name: 'fs-consumer',
      inject: injectOf(need(fsToken, '^2.0.0')),
      apply(ctx: Context) {
        grabbed = service(ctx, fsToken);
      },
    };
    const context = new Context();
    root = context;
    await context.plugin(Loader);
    Object.assign(context.loader.builtins, { fs: provider.Provider, consumer });
    await context.loader.create({ id: 'fs', name: 'cordis:fs' } as never, null);
    await context.loader.create({ id: 'c', name: 'cordis:consumer' } as never, null);
    await context.loader.await();

    const config = { configurable: { thread_id: 't' } };
    expect(grabbed?.forCall(config)).toEqual({ kind: 'not-attached' });
    answer = { kind: 'ambiguous', count: 2 };
    expect(grabbed?.forCall(config)).toEqual({ kind: 'ambiguous', count: 2 });
    expect(seen).toEqual([config, config]);

    // 提供者那一列卸載之後，抓在手上的服務仍可呼叫（方法是屬性閉包、不碰 `this.ctx`）。
    await context.loader.resolve('fs').fiber?.ctx.fiber.dispose();
    expect(grabbed?.forCall(config)).toEqual({ kind: 'ambiguous', count: 2 });
  });

  it('hasContainment()：行程級的「有沒有圍堵」，建構時交進來；沒交是 false，列卸載後仍可呼叫（#1774）', async () => {
    for (const expected of [true, false]) {
      const provider = createFsLookupProvider(
        () => ({ kind: 'not-attached' }),
        undefined,
        expected,
      );
      const grabbed: { current?: { hasContainment(): boolean } } = {};
      const consumer = {
        name: 'fs-consumer',
        inject: injectOf(need(fsToken, '^2.0.0')),
        apply(ctx: Context) {
          grabbed.current = service(ctx, fsToken);
        },
      };
      const context = new Context();
      root = context;
      await context.plugin(Loader);
      Object.assign(context.loader.builtins, { fs: provider.Provider, consumer });
      await context.loader.create({ id: 'fs', name: 'cordis:fs' } as never, null);
      await context.loader.create({ id: 'c', name: 'cordis:consumer' } as never, null);
      await context.loader.await();
      expect(grabbed.current?.hasContainment()).toBe(expected);
      await context.loader.resolve('fs').fiber?.ctx.fiber.dispose();
      expect(grabbed.current?.hasContainment()).toBe(expected);
      await context.fiber.dispose();
    }
  });

  it('forThread()：每次呼叫都問宿主交進來的函式，原樣傳 threadId；沒交一律 undefined；列卸載後仍可呼叫（#1774）', async () => {
    const handles = new Map<string, FsService>();
    const seen: string[] = [];
    const provider = createFsLookupProvider(
      () => ({ kind: 'not-attached' }),
      (threadId) => {
        seen.push(threadId);
        return handles.get(threadId);
      },
    );
    const bare = createFsLookupProvider(() => ({ kind: 'not-attached' }));
    const grabbed: { current?: { forThread(threadId: string): FsService | undefined } } = {};
    const grabbedBare: { current?: { forThread(threadId: string): FsService | undefined } } = {};
    const consumerOf = (slot: typeof grabbed) => ({
      name: 'fs-consumer',
      inject: injectOf(need(fsToken, '^2.0.0')),
      apply(ctx: Context) {
        slot.current = service(ctx, fsToken);
      },
    });
    for (const [built, slot] of [
      [provider, grabbed],
      [bare, grabbedBare],
    ] as const) {
      const context = new Context();
      root = context;
      await context.plugin(Loader);
      Object.assign(context.loader.builtins, { fs: built.Provider, consumer: consumerOf(slot) });
      await context.loader.create({ id: 'fs', name: 'cordis:fs' } as never, null);
      await context.loader.create({ id: 'c', name: 'cordis:consumer' } as never, null);
      await context.loader.await();
      if (built === provider) {
        const handle = createFsService();
        handles.set('a', handle);
        expect(slot.current?.forThread('a')).toBe(handle);
        expect(slot.current?.forThread('b')).toBeUndefined();
        await context.loader.resolve('fs').fiber?.ctx.fiber.dispose();
        expect(slot.current?.forThread('a')).toBe(handle);
        expect(seen).toEqual(['a', 'b', 'a']);
      } else {
        expect(slot.current?.forThread('a')).toBeUndefined();
      }
      await context.fiber.dispose();
    }
  });

  // #1785 第 1 點（卡 #1774 驗收「契約版本」）：2.0.0 是破壞性改動，宣告舊範圍的消費者不能掛上新提供者（Loader 的 `inject` 檢查擋下）。
  // 2.1.0（#1775）是向後相容的新增：`^2.0.0` 照樣掛得上，要新方法的消費者宣告 `^2.1.0`；2.2.0（#1919）同樣是新增，`^2.2.0` 掛得上，更新的 `^2.3.0` 掛不上。
  it.each([
    ['^1.0.0', false],
    ['^1.1.0', false],
    ['^1.2.0', false],
    ['^2.0.0', true],
    ['^2.1.0', true],
    ['^2.2.0', true],
    ['^2.3.0', false],
  ] as const)('宣告 need(fsToken, %s) 的消費者在 %s 提供者上 apply：%s', async (range, applied) => {
    const provider = createFsLookupProvider(() => ({ kind: 'not-attached' }));
    let ran = false;
    const consumer = {
      name: 'fs-consumer',
      inject: injectOf(need(fsToken, range)),
      apply() {
        ran = true;
      },
    };
    const context = new Context();
    root = context;
    await context.plugin(Loader);
    Object.assign(context.loader.builtins, { fs: provider.Provider, consumer });
    await context.loader.create({ id: 'fs', name: 'cordis:fs' } as never, null);
    await context.loader.create({ id: 'c', name: 'cordis:consumer' } as never, null);
    await context.loader.await().catch(() => undefined);
    expect(ran).toBe(applied);
  });

  it('三角色：定義套件只相依 SDK 與 core 的單向轉出（型別與 virtualPathOf）；core 與 SDK 是 peer，不進 dependencies', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
      peerDependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(manifest.dependencies ?? {}).toEqual({});
    expect(Object.keys(manifest.peerDependencies).sort()).toEqual([
      '@nexus/cordis',
      '@nexus/core',
      '@nexus/sdk',
    ]);
    expect(manifest.devDependencies['@nexus/core']).toBe('workspace:*');
  });
});
