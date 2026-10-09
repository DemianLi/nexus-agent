/**
 * 側欄的釘選與封存集合（#633）：規則逐條照 dsh `WorkspaceRegistry`，載體規矩照瀏覽器密鑰檔，一條一條釘住。
 */

import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ThreadActiveError,
  ThreadArchivedPinError,
  ThreadOrganization,
  ThreadUnknownError,
  THREAD_ORGANIZATION_FILE,
} from './thread-organization.js';
import type { ArchiveDeps } from './thread-organization.js';

const POSIX = process.platform !== 'win32';

async function freshHome(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'nexus-thread-org-')), 'home');
}

async function homeWith(text: string, mode = 0o600): Promise<{ home: string; file: string }> {
  const home = await freshHome();
  await mkdir(home, { recursive: true, mode: 0o700 });
  const file = join(home, THREAD_ORGANIZATION_FILE);
  await writeFile(file, text, { mode });
  await chmod(file, mode);
  return { home, file };
}

const exists = async (): Promise<boolean> => true;
const missing = async (): Promise<boolean> => false;

function deps(overrides: Partial<ArchiveDeps> = {}): ArchiveDeps {
  return { known: exists, activity: () => [], stop: () => undefined, ...overrides };
}

async function readRecord(home: string): Promise<unknown> {
  return JSON.parse(await readFile(join(home, THREAD_ORGANIZATION_FILE), 'utf8'));
}

describe('ThreadOrganization：釘選', () => {
  it('沒有檔就是兩個空集合，而且開檔不建檔', async () => {
    const home = await freshHome();
    const organization = await ThreadOrganization.open(home);
    expect(organization.pinnedThreadIds).toEqual([]);
    expect(organization.archivedThreadIds).toEqual([]);
    await expect(stat(join(home, THREAD_ORGANIZATION_FILE))).rejects.toThrow();
  });

  it('最近釘的在前；檔案帶版本，目錄 0700、檔案 0600，不留暫存檔', async () => {
    const home = await freshHome();
    const organization = await ThreadOrganization.open(home);
    await organization.pin('a', exists);
    await organization.pin('b', exists);
    expect(organization.pinnedThreadIds).toEqual(['b', 'a']);
    expect(await readRecord(home)).toEqual({
      version: 1,
      pinnedThreadIds: ['b', 'a'],
      archivedThreadIds: [],
    });
    expect(await readdir(home)).toEqual([THREAD_ORGANIZATION_FILE]);
    if (POSIX) {
      expect((await stat(join(home, THREAD_ORGANIZATION_FILE))).mode & 0o777).toBe(0o600);
      expect((await stat(home)).mode & 0o777).toBe(0o700);
    }
  });

  it('已經釘了：什麼都不做——不重排、不寫、連存在都不問', async () => {
    const home = await freshHome();
    const organization = await ThreadOrganization.open(home);
    await organization.pin('a', exists);
    await organization.pin('b', exists);
    const before = await stat(join(home, THREAD_ORGANIZATION_FILE));
    let asked = 0;
    await organization.pin('a', async () => {
      asked += 1;
      return true;
    });
    expect(organization.pinnedThreadIds).toEqual(['b', 'a']);
    expect(asked).toBe(0);
    const after = await stat(join(home, THREAD_ORGANIZATION_FILE));
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ino).toBe(before.ino);
  });

  it('已經釘的會話即使已不存在也回成功（dsh 的檢查先後）；沒釘過的不存在才拋', async () => {
    const home = await freshHome();
    const organization = await ThreadOrganization.open(home);
    await organization.pin('a', exists);
    await expect(organization.pin('a', missing)).resolves.toBeUndefined();
    const error = await organization.pin('ghost', missing).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ThreadUnknownError);
    expect(error).toMatchObject({ threadId: 'ghost', operation: 'pin' });
    expect(organization.pinnedThreadIds).toEqual(['a']);
  });

  it('封存的會話不能釘；而且這個檢查排在「存在嗎」之前', async () => {
    const organization = await ThreadOrganization.open(await freshHome());
    await organization.archive('a', deps());
    let asked = 0;
    const error = await organization
      .pin('a', async () => {
        asked += 1;
        return false;
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ThreadArchivedPinError);
    expect(asked).toBe(0);
    expect(organization.pinnedThreadIds).toEqual([]);
  });

  it('取消釘選：冪等，不檢查會話存不存在，也不為沒釘過的寫檔', async () => {
    const home = await freshHome();
    const organization = await ThreadOrganization.open(home);
    await organization.unpin('never');
    await expect(stat(join(home, THREAD_ORGANIZATION_FILE))).rejects.toThrow();
    await organization.pin('a', exists);
    await organization.pin('b', exists);
    await organization.unpin('a');
    await organization.unpin('a');
    expect(organization.pinnedThreadIds).toEqual(['b']);
    expect(await readRecord(home)).toMatchObject({ pinnedThreadIds: ['b'] });
  });
});

describe('ThreadOrganization：封存', () => {
  it('依封存順序排；封存的同一次寫入把它的釘選一併拿掉', async () => {
    const home = await freshHome();
    const organization = await ThreadOrganization.open(home);
    await organization.pin('a', exists);
    await organization.pin('b', exists);
    await organization.archive('a', deps());
    await organization.archive('c', deps());
    expect(organization.pinnedThreadIds).toEqual(['b']);
    expect(organization.archivedThreadIds).toEqual(['a', 'c']);
    expect(await readRecord(home)).toEqual({
      version: 1,
      pinnedThreadIds: ['b'],
      archivedThreadIds: ['a', 'c'],
    });
    expect(organization.isArchived('a')).toBe(true);
    expect(organization.isArchived('b')).toBe(false);
  });

  it('已經封存：什麼都不做——不問存在、不問在跑什麼、不去停', async () => {
    const organization = await ThreadOrganization.open(await freshHome());
    await organization.archive('a', deps());
    const calls: string[] = [];
    await organization.archive('a', {
      stopActivity: true,
      known: async () => {
        calls.push('known');
        return true;
      },
      activity: () => {
        calls.push('activity');
        return ['turn'];
      },
      stop: () => {
        calls.push('stop');
      },
    });
    expect(calls).toEqual([]);
    expect(organization.archivedThreadIds).toEqual(['a']);
  });

  it('不存在的會話封存不了，什麼都不寫', async () => {
    const home = await freshHome();
    const organization = await ThreadOrganization.open(home);
    const error = await organization
      .archive('ghost', deps({ known: missing }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ThreadUnknownError);
    expect(error).toMatchObject({ threadId: 'ghost', operation: 'archive' });
    await expect(stat(join(home, THREAD_ORGANIZATION_FILE))).rejects.toThrow();
  });

  it('還有工作在跑又沒帶 stopActivity：拋 ThreadActiveError（帶 activity），一個位元組都不寫，釘選也還在', async () => {
    const home = await freshHome();
    const organization = await ThreadOrganization.open(home);
    await organization.pin('a', exists);
    const written = await readFile(join(home, THREAD_ORGANIZATION_FILE), 'utf8');
    let stopped = 0;
    const error = await organization
      .archive('a', deps({ activity: () => ['turn', 'subagent'], stop: () => void (stopped += 1) }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ThreadActiveError);
    expect(error).toMatchObject({ threadId: 'a', activity: ['turn', 'subagent'] });
    expect(stopped).toBe(0);
    expect(organization.archivedThreadIds).toEqual([]);
    expect(organization.pinnedThreadIds).toEqual(['a']);
    expect(await readFile(join(home, THREAD_ORGANIZATION_FILE), 'utf8')).toBe(written);
  });

  it('帶 stopActivity：先寫、再停（停的時候檔案裡已經有它），而且不再問 activity', async () => {
    const home = await freshHome();
    const organization = await ThreadOrganization.open(home);
    let seenByStop: unknown;
    let activityAsked = 0;
    await organization.archive('a', {
      stopActivity: true,
      known: exists,
      activity: () => {
        activityAsked += 1;
        return ['turn'];
      },
      stop: async () => {
        seenByStop = await readRecord(home);
        // 停的當下閘門已經讀得到封存。
        expect(organization.isArchived('a')).toBe(true);
      },
    });
    expect(activityAsked).toBe(0);
    expect(seenByStop).toMatchObject({ archivedThreadIds: ['a'] });
  });

  it('停的時候拋：講一聲，封存照舊（不撤銷）', async () => {
    const home = await freshHome();
    const organization = await ThreadOrganization.open(home);
    const warnings: string[] = [];
    await organization.archive('a', {
      stopActivity: true,
      known: exists,
      activity: () => [],
      stop: () => {
        throw new Error('停不下來');
      },
      warn: (message) => warnings.push(message),
    });
    expect(organization.archivedThreadIds).toEqual(['a']);
    expect(await readRecord(home)).toMatchObject({ archivedThreadIds: ['a'] });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('停不下來');
  });

  it('存在與否的查詢拋了（儲存體壞）：往外拋，不當成「沒有這條」', async () => {
    const organization = await ThreadOrganization.open(await freshHome());
    const error = await organization
      .archive('a', deps({ known: () => Promise.reject(new Error('磁碟壞了')) }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ThreadUnknownError);
    expect(organization.archivedThreadIds).toEqual([]);
  });

  it('取消封存：冪等，不檢查存在，不為沒封存過的寫檔', async () => {
    const home = await freshHome();
    const organization = await ThreadOrganization.open(home);
    await organization.unarchive('never');
    await expect(stat(join(home, THREAD_ORGANIZATION_FILE))).rejects.toThrow();
    await organization.archive('a', deps());
    await organization.archive('b', deps());
    await organization.unarchive('a');
    await organization.unarchive('a');
    expect(organization.archivedThreadIds).toEqual(['b']);
    expect(organization.isArchived('a')).toBe(false);
    // 取消封存後釘選不會自己回來。
    expect(organization.pinnedThreadIds).toEqual([]);
  });
});

describe('ThreadOrganization：序列與耐久', () => {
  it('並行的變更排隊跑：「先檢查再寫」不會被插隊（同一個 id 同時釘兩次只寫一次）', async () => {
    const home = await freshHome();
    const organization = await ThreadOrganization.open(home);
    let asked = 0;
    const slow = async (): Promise<boolean> => {
      asked += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return true;
    };
    await Promise.all([
      organization.pin('a', slow),
      organization.pin('a', slow),
      organization.pin('b', exists),
    ]);
    expect(asked).toBe(1);
    expect(organization.pinnedThreadIds).toEqual(['b', 'a']);
  });

  it('釘與封存同時打：序列化之後封存勝出，集合不重疊', async () => {
    const organization = await ThreadOrganization.open(await freshHome());
    const results = await Promise.allSettled([
      organization.pin('a', exists),
      organization.archive('a', deps()),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(organization.pinnedThreadIds).toEqual([]);
    expect(organization.archivedThreadIds).toEqual(['a']);
  });

  it('重開（模擬重啟）讀回同樣的集合與順序', async () => {
    const home = await freshHome();
    const first = await ThreadOrganization.open(home);
    await first.pin('a', exists);
    await first.pin('b', exists);
    await first.pin('c', exists);
    await first.archive('b', deps());
    await first.archive('d', deps());
    const second = await ThreadOrganization.open(home);
    expect(second.pinnedThreadIds).toEqual(['c', 'a']);
    expect(second.archivedThreadIds).toEqual(['b', 'd']);
  });

  it('寫不進去：記憶體不動，錯誤往外拋，而且不拖垮後面的請求', async () => {
    const home = await freshHome();
    const organization = await ThreadOrganization.open(home);
    await organization.pin('a', exists);
    // 把目標檔換成目錄，rename 蓋不過去。
    const file = join(home, THREAD_ORGANIZATION_FILE);
    await rm(file);
    await mkdir(file);
    await expect(organization.pin('b', exists)).rejects.toThrow();
    expect(organization.pinnedThreadIds).toEqual(['a']);
    expect((await readdir(home)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    await rm(file, { recursive: true });
    // 佇列沒被毒死：修好之後下一個請求照常成功。
    await organization.pin('c', exists);
    expect(organization.pinnedThreadIds).toEqual(['c', 'a']);
    expect(await readRecord(home)).toMatchObject({ pinnedThreadIds: ['c', 'a'] });
  });
});

describe('ThreadOrganization.open：認不得的檔明確失敗，而且一個位元組都不動', () => {
  it('壞內容', async () => {
    const cases: readonly string[] = [
      'not json',
      JSON.stringify(null),
      JSON.stringify([]),
      JSON.stringify({ pinnedThreadIds: [], archivedThreadIds: [] }),
      JSON.stringify({ version: 2, pinnedThreadIds: [], archivedThreadIds: [] }),
      JSON.stringify({ version: 1, pinnedThreadIds: 'a', archivedThreadIds: [] }),
      JSON.stringify({ version: 1, pinnedThreadIds: [], archivedThreadIds: [1] }),
      JSON.stringify({ version: 1, pinnedThreadIds: [''], archivedThreadIds: [] }),
      JSON.stringify({ version: 1, pinnedThreadIds: ['a', 'a'], archivedThreadIds: [] }),
      JSON.stringify({ version: 1, pinnedThreadIds: ['a'], archivedThreadIds: ['a'] }),
      JSON.stringify({ version: 1, pinnedThreadIds: [] }),
    ];
    for (const text of cases) {
      const { home, file } = await homeWith(text);
      await expect(ThreadOrganization.open(home)).rejects.toThrow(/格式認不得/);
      expect(await readFile(file, 'utf8')).toBe(text);
    }
    // 對照：同一個寫法、合格的記錄讀得回來——上面紅的是內容，不是讀法。
    const { home } = await homeWith(
      JSON.stringify({ version: 1, pinnedThreadIds: ['p'], archivedThreadIds: ['q'] }),
    );
    const organization = await ThreadOrganization.open(home);
    expect(organization.pinnedThreadIds).toEqual(['p']);
    expect(organization.archivedThreadIds).toEqual(['q']);
  });

  it.skipIf(!POSIX)('權限過寬（group／other 讀得到）：拒絕，檔案不動', async () => {
    const text = JSON.stringify({ version: 1, pinnedThreadIds: [], archivedThreadIds: [] });
    for (const mode of [0o644, 0o640, 0o604]) {
      const { home, file } = await homeWith(text, mode);
      await expect(ThreadOrganization.open(home)).rejects.toThrow(/其他使用者讀得到/);
      expect(await readFile(file, 'utf8')).toBe(text);
    }
    const { home } = await homeWith(text, 0o600);
    await expect(ThreadOrganization.open(home)).resolves.toBeInstanceOf(ThreadOrganization);
  });
});
