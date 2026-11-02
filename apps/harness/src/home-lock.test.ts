/**
 * home 鎖本身（[#1503](https://github.com/DemianLi/nexus-agent/issues/1503)）：真的 kernel flock（拿鎖的是系統 perl）——同一個
 * 行程對同一個鎖檔開兩次，flock 一樣互斥，兩個把手就是兩個行程的縮影。產品路徑的接線在 `serve-home-lock.test.ts`。
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { acquireHomeLock, HOME_LOCK_FILE_NAME, HomeInUseError, HomeLock } from './home-lock.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-home-lock-unit-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function held(outcome: Awaited<ReturnType<typeof acquireHomeLock>>): HomeLock {
  if (!(outcome instanceof HomeLock)) throw new Error('沒拿到鎖');
  return outcome;
}

describe('acquireHomeLock', () => {
  it('home 不在就建（0700），鎖檔 0600 而且是空的（不寫 PID）', async () => {
    const home = join(dir, 'nested', 'home');
    const lock = held(await acquireHomeLock(home));

    expect((await stat(home)).mode & 0o777).toBe(0o700);
    const lockPath = join(home, HOME_LOCK_FILE_NAME);
    expect((await stat(lockPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(lockPath, 'utf8')).toBe('');
    await lock.release();
  });

  it('握著的時候第二次拿拋 HomeInUseError，訊息有 home 與鎖檔；放掉之後拿得到', async () => {
    const first = held(await acquireHomeLock(dir));

    const attempt = acquireHomeLock(dir);
    await expect(attempt).rejects.toThrow(HomeInUseError);
    await expect(attempt).rejects.toMatchObject({
      home: dir,
      lockPath: join(dir, HOME_LOCK_FILE_NAME),
    });

    await first.release();
    await held(await acquireHomeLock(dir)).release();
  });

  it('release 呼叫第二次是 no-op，而且不刪鎖檔', async () => {
    const lock = held(await acquireHomeLock(dir));
    await lock.release();
    await lock.release();
    expect((await stat(join(dir, HOME_LOCK_FILE_NAME))).isFile()).toBe(true);
  });

  it('不同 home 互不影響', async () => {
    const a = held(await acquireHomeLock(join(dir, 'a')));
    const b = held(await acquireHomeLock(join(dir, 'b')));
    await a.release();
    await b.release();
  });

  it('平台不支援：回 unavailable，不拋；EACCES：原樣拋', async () => {
    const outcome = await acquireHomeLock(dir, async () => {
      throw Object.assign(new Error('no flock here'), { code: 'ERR_FLOCK_UNAVAILABLE' });
    });
    expect(outcome).toEqual({ unavailable: 'no flock here' });

    await expect(
      acquireHomeLock(dir, async () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      }),
    ).rejects.toThrow('denied');
  });
});
