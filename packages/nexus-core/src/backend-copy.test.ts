/**
 * 照位元組複製穿過組好的 backend（[#2289](https://github.com/DemianLi/nexus-agent/issues/2289)）。組法照產品的三層：
 * 最內層是工作區加暫存、附件、共用參考區（`agent-factory.ts` 的 `withToolResultStash`），中間是會話歷史（`withConversationHistory`），
 * 最外層是插件的掛載點（`fold.ts` 的 `foldBackend`）。會話歷史在產品裡是記憶體 backend，暫存是主機私有目錄（`StashRoute`）；兩者今天都沒有複製兩半，
 * 這裡用基座的 `StateBackend` 代。附件與共用參考區在產品裡唯讀，那一條拒絕歸子 backend 的 fence，不在這裡驗。
 */

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';

import { CompositeBackend, StateBackend } from 'deepagents';
import { describe, expect, it, vi } from 'vitest';

import { COPY_INTO, COPY_SOURCE, copyFileOf } from './backend-copy.js';
import type { CopyCapable, CopyRequest, CopySource } from './backend-copy.js';
import { ModifiedOrderCompositeBackend } from './modified-order-composite.js';

/** 記憶體裡的兩半，記下每次收到的路徑與原路徑，以及交出去的串流。關掉來源就毀掉串流，關早了目的地會讀不完。 */
function bytesBackend(files: Record<string, Buffer> = {}) {
  const calls: { half: 'source' | 'into'; path: string; request: CopyRequest }[] = [];
  const opened: Readable[] = [];
  const closed = vi.fn(async () => {
    for (const stream of opened) stream.destroy();
  });
  const backend: CopyCapable = {
    async [COPY_SOURCE](path, request) {
      calls.push({ half: 'source', path, request });
      const content = files[path];
      if (content === undefined) return { error: `no such file: ${request.from}` };
      const stream = Readable.from([content]);
      opened.push(stream);
      return { stream, size: content.length, close: closed };
    },
    async [COPY_INTO](path, source: CopySource, request) {
      calls.push({ half: 'into', path, request });
      if (files[path] !== undefined) return { error: `exists: ${request.to}`, exists: true };
      files[path] = await buffer(source.stream);
      return { path, bytes: files[path].length, sha256: digest(files[path]) };
    },
  };
  return { backend, files, calls, closed, opened };
}

const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** 夾具的 close 不會拋；拋了就讓那一條紅。 */
const copy = (backend: unknown, from: string, to: string) =>
  copyFileOf(backend, from, to, (error) => {
    throw error;
  });

/** 不是 UTF-8 的位元組：經 `readRaw` 解碼再寫回就會變成 U+FFFD（夾具路徑是 `.txt`，被判成文字）。 */
const BYTES = Buffer.from([0xff, 0xfe, 0x00, 0x09, 0x20, 0x0a]);
const COPIED = { bytes: BYTES.length, sha256: digest(BYTES) };

function assembled() {
  const workspace = bytesBackend({ '/a.txt': BYTES });
  const shared = bytesBackend({ '/in.txt': BYTES, '/': BYTES });
  const attachments = bytesBackend();
  const plugin = bytesBackend();
  const inner = new ModifiedOrderCompositeBackend(workspace.backend as never, {
    '/large_tool_results/': new StateBackend(),
    '/attachments/': attachments.backend as never,
    '/shared/': shared.backend as never,
  });
  const middle = new ModifiedOrderCompositeBackend(inner, {
    '/conversation_history/': new StateBackend(),
  });
  const outer = new ModifiedOrderCompositeBackend(middle, { '/plugin/': plugin.backend as never });
  return { outer, workspace, shared, attachments, plugin };
}

describe('copyFileOf 穿過組好的三層', () => {
  it('跨路由：/shared/in.txt → /out.txt，位元組原樣落在工作區，兩半收到剝過前綴的路徑與原路徑', async () => {
    const { outer, workspace, shared } = assembled();

    const result = await copy(outer, '/shared/in.txt', '/out.txt');

    expect(result).toEqual({ path: '/out.txt', ...COPIED });
    expect(workspace.files['/out.txt']).toEqual(BYTES);
    const request = { from: '/shared/in.txt', to: '/out.txt' };
    expect(shared.calls).toEqual([{ half: 'source', path: '/in.txt', request }]);
    expect(workspace.calls).toEqual([{ half: 'into', path: '/out.txt', request }]);
    expect(shared.closed).toHaveBeenCalledTimes(1);
  });

  it('同一格內：工作區裡的 /a.txt → /b.txt', async () => {
    const { outer, workspace } = assembled();

    expect(await copy(outer, '/a.txt', '/b.txt')).toEqual({
      path: '/b.txt',
      ...COPIED,
    });
    expect(workspace.files['/b.txt']).toEqual(BYTES);
  });

  it('目的地在路由底下：回的路徑補回前綴，子 backend 回的其餘欄位原樣帶出（插件那一格在最外層）', async () => {
    const { outer, plugin, attachments } = assembled();

    expect(await copy(outer, '/a.txt', '/plugin/sub/out.bin')).toEqual({
      path: '/plugin/sub/out.bin',
      ...COPIED,
    });
    expect(plugin.files['/sub/out.bin']).toEqual(BYTES);
    // 最內層的路由：前綴在最內層補回，要原樣穿過外面兩層，其餘欄位一起帶出。
    expect(await copy(outer, '/a.txt', '/attachments/copy.bin')).toEqual({
      path: '/attachments/copy.bin',
      ...COPIED,
    });
    expect(attachments.files['/copy.bin']).toEqual(BYTES);
  });

  it('路徑剛好等於前綴、不帶結尾斜線：照基座 getBackendAndKey 的規則落到那一格的 /，回的路徑跟模型給的一樣', async () => {
    const { outer, shared, plugin } = assembled();

    expect(await copy(outer, '/shared', '/plugin')).toEqual({ path: '/plugin', ...COPIED });

    expect(shared.calls.map((call) => call.path)).toEqual(['/']);
    expect(plugin.calls.map((call) => call.path)).toEqual(['/']);
  });

  it('目的地是帶結尾斜線的前綴：同樣落到那一格的 /，回不帶結尾斜線的寫法', async () => {
    const { outer, plugin } = assembled();

    expect(await copy(outer, '/a.txt', '/plugin/')).toEqual({ path: '/plugin', ...COPIED });
    expect(plugin.calls.map((call) => call.path)).toEqual(['/']);
  });

  it.each(['/conversation_history/x.md', '/large_tool_results/x.txt'])(
    '目的地 %s 沒有目的地那一半：回固定錯誤、串流沒讀、來源照樣關掉',
    async (to) => {
      const { outer, shared } = assembled();

      expect(await copy(outer, '/shared/in.txt', to)).toEqual({
        error: `Error copying to '${to}': this location does not accept copied files`,
      });
      expect(shared.opened[0]?.readableDidRead).toBe(false);
      expect(shared.closed).toHaveBeenCalledTimes(1);
    },
  );

  it('基座原生的 CompositeBackend 掛在路由上：認不得，回固定錯誤', async () => {
    const { outer, shared } = assembled();
    const nested = new ModifiedOrderCompositeBackend(outer, {
      '/native/': new CompositeBackend(bytesBackend().backend as never, {}),
    });

    expect(await copy(nested, '/shared/in.txt', '/native/x.bin')).toEqual({
      error: `Error copying to '/native/x.bin': this location does not accept copied files`,
    });
    expect(shared.closed).toHaveBeenCalledTimes(1);
  });

  it('來源在沒有來源那一半的格子：回固定錯誤，不叫目的地', async () => {
    const { outer, workspace } = assembled();

    expect(await copy(outer, '/conversation_history/x.md', '/out.txt')).toEqual({
      error: `Error copying '/conversation_history/x.md': this location does not support copying files`,
    });
    expect(workspace.calls).toEqual([]);
  });

  it('外面包的是基座原生的 CompositeBackend：認不得，回固定錯誤', async () => {
    const workspace = bytesBackend({ '/a.txt': BYTES });
    const base = new CompositeBackend(workspace.backend as never, {});

    expect(await copy(base, '/a.txt', '/b.txt')).toEqual({
      error: `Error copying '/a.txt': this location does not support copying files`,
    });
    expect(workspace.calls).toEqual([]);
  });

  it('子 backend 的錯誤原樣往上：目的地已存在帶 exists，來源找不到就不叫目的地', async () => {
    const { outer, workspace, shared } = assembled();

    expect(await copy(outer, '/shared/in.txt', '/a.txt')).toEqual({
      error: 'exists: /a.txt',
      exists: true,
    });
    expect(workspace.files['/a.txt']).toEqual(BYTES);
    expect(shared.closed).toHaveBeenCalledTimes(1);

    expect(await copy(outer, '/shared/missing.txt', '/new.txt')).toEqual({
      error: 'no such file: /shared/missing.txt',
    });
    expect(workspace.calls.filter((call) => call.path === '/new.txt')).toEqual([]);
  });

  it('目的地那一半拋錯：錯誤往外拋，來源照樣關掉', async () => {
    const shared = bytesBackend({ '/in.txt': BYTES });
    const broken = {
      [COPY_INTO]: () => Promise.reject(new Error('disk full')),
    };
    const backend = new ModifiedOrderCompositeBackend(broken as never, {
      '/shared/': shared.backend as never,
    });

    await expect(copy(backend, '/shared/in.txt', '/out.txt')).rejects.toThrow('disk full');
    expect(shared.closed).toHaveBeenCalledTimes(1);
  });

  it('來源那一半拋錯：錯誤往外拋，不叫目的地', async () => {
    const workspace = bytesBackend();
    const broken = { [COPY_SOURCE]: () => Promise.reject(new Error('EIO')) };
    const backend = new ModifiedOrderCompositeBackend(workspace.backend as never, {
      '/shared/': broken as never,
    });

    await expect(copy(backend, '/shared/in.txt', '/out.txt')).rejects.toThrow('EIO');
    expect(workspace.calls).toEqual([]);
  });

  describe('關掉來源時拋錯：模型看到的照目的地那一半，close 的錯交給 onCloseError', () => {
    const failing = (into: CopyCapable[typeof COPY_INTO]) => ({
      async [COPY_SOURCE]() {
        return {
          stream: Readable.from([BYTES]),
          size: BYTES.length,
          close: () => Promise.reject(new Error('EBADF')),
        };
      },
      [COPY_INTO]: into,
    });
    const closeErrorsOf = (seen: unknown[]) => seen.map((error) => (error as Error).message);

    it('目的地成功：回成功', async () => {
      const seen: unknown[] = [];
      const backend = failing(async (path, source) => {
        await buffer(source.stream);
        return { path, ...COPIED };
      });

      expect(await copyFileOf(backend, '/a.txt', '/b.txt', (error) => seen.push(error))).toEqual({
        path: '/b.txt',
        ...COPIED,
      });
      expect(closeErrorsOf(seen)).toEqual(['EBADF']);
    });

    it('目的地回錯誤：回目的地的錯誤', async () => {
      const seen: unknown[] = [];
      const backend = failing(async () => ({ error: 'exists: /b.txt', exists: true }));

      expect(await copyFileOf(backend, '/a.txt', '/b.txt', (error) => seen.push(error))).toEqual({
        error: 'exists: /b.txt',
        exists: true,
      });
      expect(closeErrorsOf(seen)).toEqual(['EBADF']);
    });

    it('目的地拋錯：拋的是目的地的錯', async () => {
      const seen: unknown[] = [];
      const backend = failing(() => Promise.reject(new Error('disk full')));

      await expect(
        copyFileOf(backend, '/a.txt', '/b.txt', (error) => seen.push(error)),
      ).rejects.toThrow('disk full');
      expect(closeErrorsOf(seen)).toEqual(['EBADF']);
    });

    it('onCloseError 自己同步拋錯：那個錯取代結果往外拋（文件寫明的例外）', async () => {
      const backend = failing(async (path, source) => {
        await buffer(source.stream);
        return { path };
      });

      await expect(
        copyFileOf(backend, '/a.txt', '/b.txt', () => {
          throw new Error('log down');
        }),
      ).rejects.toThrow('log down');
    });

    it('close 同步拋錯（不回 Promise）：一樣交給 onCloseError，回目的地的結果', async () => {
      const seen: unknown[] = [];
      const backend = {
        async [COPY_SOURCE]() {
          return {
            stream: Readable.from([BYTES]),
            size: BYTES.length,
            close: (): Promise<void> => {
              throw new Error('EBADF');
            },
          };
        },
        async [COPY_INTO](path: string, source: CopySource) {
          await buffer(source.stream);
          return { path };
        },
      };

      expect(await copyFileOf(backend, '/a.txt', '/b.txt', (error) => seen.push(error))).toEqual({
        path: '/b.txt',
      });
      expect(closeErrorsOf(seen)).toEqual(['EBADF']);
    });
  });
});
