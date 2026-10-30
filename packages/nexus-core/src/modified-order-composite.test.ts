/**
 * `ModifiedOrderCompositeBackend`（[#1605](https://github.com/DemianLi/nexus-agent/issues/1605) N0345）：`glob` 的結果照 `modified_at` 排，
 * 不是基座 `CompositeBackend` 重排出來的路徑序。經 `createNexusAgent` 的產品路徑在 `apps/harness/src/tool-fs.test.ts`。
 */

import { CompositeBackend } from 'deepagents';
import type { GlobResult } from 'deepagents';
import { describe, expect, it } from 'vitest';

import { ModifiedOrderCompositeBackend } from './modified-order-composite.js';

const entry = (path: string, modified_at?: string) => ({
  path,
  is_dir: false as const,
  size: 1,
  ...(modified_at !== undefined && { modified_at }),
});

/** 只有 `glob` 的假 backend。 */
const fake = (result: GlobResult) => ({ glob: () => Promise.resolve(result) }) as never;

describe('ModifiedOrderCompositeBackend', () => {
  it('前提：基座的 CompositeBackend 會把 default 排好的順序照路徑重排（這就是要這個子類別的原因）', async () => {
    const base = new CompositeBackend(
      fake({
        files: [
          entry('/b.ts', '2020-01-01T00:00:00.000Z'),
          entry('/a.ts', '2021-01-01T00:00:00.000Z'),
        ],
      }),
      {},
    );
    expect(((await base.glob('*.ts')).files ?? []).map((each) => each.path)).toEqual([
      '/a.ts',
      '/b.ts',
    ]);
  });

  it('舊的在前，不是路徑序；default 與路由的結果合在同一條時間軸上', async () => {
    const backend = new ModifiedOrderCompositeBackend(
      fake({
        files: [
          entry('/m.ts', '2022-01-01T00:00:00.000Z'),
          entry('/a.ts', '2023-01-01T00:00:00.000Z'),
        ],
      }),
      { '/routed/': fake({ files: [entry('/z.ts', '2021-01-01T00:00:00.000Z')] }) },
    );

    const result = await backend.glob('*.ts');

    expect((result.files ?? []).map((each) => each.path)).toEqual([
      '/routed/z.ts',
      '/m.ts',
      '/a.ts',
    ]);
  });

  it('同一刻或沒有 modified_at 的，保持基座給的相對順序（路徑序），排序是穩定的', async () => {
    const backend = new ModifiedOrderCompositeBackend(
      fake({
        files: [
          entry('/c.ts'),
          entry('/b.ts', '2020-01-01T00:00:00.000Z'),
          entry('/a.ts', '2020-01-01T00:00:00.000Z'),
        ],
      }),
      {},
    );

    const result = await backend.glob('*.ts');

    expect((result.files ?? []).map((each) => each.path)).toEqual(['/a.ts', '/b.ts', '/c.ts']);
  });

  it('錯誤與 truncated 原樣帶出，不排序', async () => {
    const failing = new ModifiedOrderCompositeBackend(fake({ error: 'boom' }), {});
    expect(await failing.glob('*')).toEqual({ error: 'boom' });

    const capped = new ModifiedOrderCompositeBackend(
      fake({ files: [entry('/a.ts', '2020-01-01T00:00:00.000Z')], truncated: true }),
      {},
    );
    expect((await capped.glob('*')).truncated).toBe(true);
  });

  it('路由出錯：整筆回路由的錯誤，default 的命中不留（#2158）', async () => {
    const backend = new ModifiedOrderCompositeBackend(
      fake({ files: [entry('/a.ts', '2020-01-01T00:00:00.000Z')] }),
      { '/routed/': fake({ error: 'SANDBOX_UNAVAILABLE' }) },
    );
    expect(await backend.glob('*.ts')).toEqual({ error: 'SANDBOX_UNAVAILABLE' });
  });

  it('起點碰不到的路由出錯：不影響結果（#2158）', async () => {
    const backend = new ModifiedOrderCompositeBackend(
      fake({ files: [entry('/src/a.ts', '2020-01-01T00:00:00.000Z')] }),
      { '/routed/': fake({ error: 'SANDBOX_UNAVAILABLE' }) },
    );
    expect((await backend.glob('*.ts', '/src')).files?.map((each) => each.path)).toEqual([
      '/src/a.ts',
    ]);
  });

  it('路由的 truncated 與路徑前綴照基座帶回來', async () => {
    const backend = new ModifiedOrderCompositeBackend(fake({ files: [] }), {
      '/routed/': fake({
        files: [entry('/x.ts', '2020-01-01T00:00:00.000Z')],
        truncated: true,
      }),
    });
    expect(await backend.glob('*.ts')).toMatchObject({
      files: [{ path: '/routed/x.ts' }],
      truncated: true,
    });
  });

  it('起點落在路由底下：結果也是時間序，路徑前綴照基座加回去', async () => {
    const backend = new ModifiedOrderCompositeBackend(fake({ files: [] }), {
      '/routed/': fake({
        files: [
          entry('/y.ts', '2022-01-01T00:00:00.000Z'),
          entry('/x.ts', '2020-01-01T00:00:00.000Z'),
        ],
      }),
    });

    const result = await backend.glob('*.ts', '/routed/');

    expect((result.files ?? []).map((each) => each.path)).toEqual(['/routed/x.ts', '/routed/y.ts']);
  });

  it('是 CompositeBackend：isInstance 與 instanceof 都成立（基座認得）', () => {
    const backend = new ModifiedOrderCompositeBackend(fake({ files: [] }), {});
    expect(backend).toBeInstanceOf(CompositeBackend);
    expect(CompositeBackend.isInstance(backend)).toBe(true);
  });
});
