/**
 * 檔名別名換新時是原子的（[#1352](https://github.com/DemianLi/nexus-agent/issues/1352)）：先連到暫存名、再 `rename` 蓋過去，
 * 絕不「先刪別名、再建」——那樣中間有一段時間模型讀這個路徑會讀不到。檔案系統的呼叫順序用包一層的 `fs/promises` 記下來。
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
let renameDoesNothing = false;

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    link: async (from: string, to: string) => {
      calls.push(`link ${to}`);
      return actual.link(from, to);
    },
    unlink: async (path: string) => {
      calls.push(`unlink ${path}`);
      return actual.unlink(path);
    },
    rename: async (from: string, to: string) => {
      calls.push(`rename ${to}`);
      // 模擬 POSIX「兩邊已經是同一個 inode 時 rename 什麼都不做、回成功」：暫存名會留著。
      if (renameDoesNothing) return;
      return actual.rename(from, to);
    },
  };
});

const { AttachmentStore, attachmentsRootOf } = await import('./attachment-store.js');

let home: string;
let store: InstanceType<typeof AttachmentStore>;

beforeEach(async () => {
  home = await mkdtemp(join('/var/tmp', 'nexus-alias-'));
  store = new AttachmentStore(attachmentsRootOf(home));
  calls.length = 0;
  renameDoesNothing = false;
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('別名換新是原子的（#1352）', () => {
  it('物件被刪掉重建後重傳：別名是 rename 蓋過去的，沒有對別名 unlink，也沒有「先刪再建」', async () => {
    const body = Buffer.from('hello world');
    const ref = await store.save({ data: body, name: 'a.txt' });
    const digest = ref.attachmentId.slice('sha256:'.length);
    const object = join(store.rootDir, 'file-objects', digest.slice(0, 2), digest);
    const alias = store.pathOf(ref);
    await rm(object);
    calls.length = 0;

    await store.save({ data: body, name: 'a.txt' });

    expect(calls).toContain(`rename ${alias}`);
    expect(calls).not.toContain(`unlink ${alias}`);
    // 取代之前，別名的位置上沒有發生過「連結別名本身」以外的刪除。
    const renameAt = calls.indexOf(`rename ${alias}`);
    const tempLinkAt = calls.findIndex(
      (call, index) => index < renameAt && call.startsWith('link ') && call.includes('/staging/'),
    );
    expect(tempLinkAt).toBeGreaterThanOrEqual(0);
  });

  it('rename 什麼都不做（兩邊碰巧已是同一個 inode）時，暫存名也不會留在 staging/', async () => {
    const body = Buffer.from('hello world');
    const ref = await store.save({ data: body, name: 'a.txt' });
    const digest = ref.attachmentId.slice('sha256:'.length);
    await rm(join(store.rootDir, 'file-objects', digest.slice(0, 2), digest));
    renameDoesNothing = true;

    await store.save({ data: body, name: 'a.txt' });

    expect(calls.some((call) => call.startsWith('rename '))).toBe(true);
    expect(await readdir(join(store.rootDir, 'staging'))).toEqual([]);
  });
});
