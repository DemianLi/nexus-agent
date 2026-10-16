import { readFileSync } from 'node:fs';

import { Context } from '@nexus/cordis';
import Loader from '@nexus/cordis-plugin-loader';
import { injectOf, need, service } from '@nexus/sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { virtualPathOf as coreVirtualPathOf } from '@nexus/core';

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
    expect(FS_LOOKUP_CONTRACT_VERSION).toBe('1.1.0');
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
      inject: injectOf(need(fsToken, '^1.0.0')),
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
