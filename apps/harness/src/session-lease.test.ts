/**
 * 寫租約——[#251](https://github.com/DemianLi/nexus-agent/issues/251) 拍板的第 2 件，照 dsh 的
 * `session-persistence-jsonl/src/lease.ts`。
 *
 * **搶鎖那幾條測的是真的 kernel 鎖**，沒有替身：同一個行程開兩次同一個鎖檔，flock 一樣互斥
 * （以 open file description 為單位），所以兩個把手就是兩個行程的縮影。只有「這個平台拿不到」
 * 那兩條路換了拿鎖的那一下——macOS 與 CI 的 Linux 上都走不到它們，不換就是沒驗過就出貨。
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SESSION_LOG_FORMAT_VERSION,
  SessionAlreadyOwnedError,
  SessionCorruptionError,
} from '@nexus/core';
import type { SessionEvent, StoredSessionHeader } from '@nexus/core';

import { openJsonlSessionStore } from './jsonl-session-store.js';
import { acquireSessionLease } from './session-lease.js';
import type { TryLock } from './session-lease.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-lease-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function header(id: string): StoredSessionHeader {
  return { version: SESSION_LOG_FORMAT_VERSION, id, createdAt: 1, cwd: '/tmp' };
}

/** 一筆讀方收得下的事件。內容不重要，store 只驗 `type`／`time`／`seq`。 */
function event(seq: number): SessionEvent {
  return { type: 'model/usage', seq, time: 1, data: {} } as unknown as SessionEvent;
}

/** 一個永遠失敗、帶著 `code` 的拿鎖。 */
function failing(code: string): TryLock {
  return async () => {
    throw Object.assign(new Error(`boom ${code}`), { code });
  };
}

/** 寫一份一筆的會話然後關掉——後面要接的那一份。 */
async function written(id = 'cli'): Promise<void> {
  const stored = openJsonlSessionStore({ directory: dir }).create(header(id));
  await stored.append([event(0)]);
  await stored.close();
}

describe('兩個把手搶同一份', () => {
  it('寫著的那個還開著，另一個接不了；它關了才接得了', async () => {
    const writer = openJsonlSessionStore({ directory: dir }).create(header('cli'));
    await writer.append([event(0)]);

    const other = openJsonlSessionStore({ directory: dir });
    await expect(other.resume('cli')).rejects.toThrow(SessionAlreadyOwnedError);

    await writer.close();
    const resumed = await other.resume('cli');
    expect(resumed.events).toHaveLength(1);
    await resumed.stored.close();
  });

  it('兩次續接同一份：第二次拋，訊息帶會話 id', async () => {
    await written();
    const first = await openJsonlSessionStore({ directory: dir }).resume('cli');
    await expect(openJsonlSessionStore({ directory: dir }).resume('cli')).rejects.toThrow(
      /會話 "cli" 已經有另一個寫入把手握著/,
    );
    await first.stored.close();
  });

  /** 續接在讀之前就拿了租約；一筆都沒寫就關，`#handle` 從來沒開過——租約照樣要放。 */
  it('一筆都沒寫就關的續接把手，也把租約放掉', async () => {
    await written();
    const first = await openJsonlSessionStore({ directory: dir }).resume('cli');
    await first.stored.close();
    const second = await openJsonlSessionStore({ directory: dir }).resume('cli');
    await second.stored.close();
  });

  it('讀壞了的續接不佔著租約', async () => {
    await written();
    const headerPath = join(dir, 'cli.header.json');
    const good = await readFile(headerPath, 'utf8');
    await writeFile(headerPath, '{壞的');
    await expect(openJsonlSessionStore({ directory: dir }).resume('cli')).rejects.toThrow(
      SessionCorruptionError,
    );

    await writeFile(headerPath, good);
    const resumed = await openJsonlSessionStore({ directory: dir }).resume('cli');
    await resumed.stored.close();
  });
});

describe('同一個把手同時實體化兩次', () => {
  /**
   * 協調器的背景寫入與 `flush` 排在不同的隊伍上，第一次實體化時兩條都可能進 `#materialize`。
   * 各自去拿租約的話，第二條撞上**自己的**鎖，拋出一句「另一個行程還開著它」。
   */
  it('一份全新的會話同時 append 與 flush：兩個都成功，日誌只有那一筆', async () => {
    const stored = openJsonlSessionStore({ directory: dir }).create(header('cli'));
    await Promise.all([stored.append([event(0)]), stored.flush()]);
    await stored.close();

    const back = await openJsonlSessionStore({ directory: dir }).resume('cli');
    expect(back.events).toHaveLength(1);
    await back.stored.close();
  });
});

describe('一份會話一把', () => {
  /**
   * run 目錄裝著 root 與它的 subagent。整個目錄一把的話，root 會跟**自己的** subagent 搶——
   * 那個錯只在 subagent 出生時才冒出來，所以這一條要兩份都真的寫。
   */
  it('root 與它的 subagent 在同一個 run 目錄裡各拿各的', async () => {
    const store = openJsonlSessionStore({ directory: dir });
    const root = store.create(header('cli'));
    const sub = store.create({ ...header('cli/run-1'), parentSession: 'cli' });
    await root.append([event(0)]);
    await sub.append([event(0)]);

    const locks = (await readdir(dir)).filter((name) => name.endsWith('.lock')).sort();
    expect(locks).toEqual(['cli%2frun-1.lock', 'cli.lock']);
    await root.close();
    await sub.close();
  });
});

describe('打錯的 --resume', () => {
  it('沒有這份會話：不建目錄、不留鎖檔', async () => {
    const nowhere = join(dir, 'nope');
    await expect(openJsonlSessionStore({ directory: nowhere }).resume('cli')).rejects.toThrow(
      /裡沒有會話 "cli"/,
    );
    await expect(openJsonlSessionStore({ directory: dir }).resume('cli')).rejects.toThrow(
      /裡沒有會話 "cli"/,
    );
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('失敗分四種，只有「這個平台沒有」退到不鎖', () => {
  it.each([
    'ERR_FLOCK_UNSUPPORTED_PLATFORM',
    'MODULE_NOT_FOUND',
    'ERR_MODULE_NOT_FOUND',
    'ERR_DLOPEN_FAILED',
  ])('%s：退到不鎖，帶著原本那句話', async (code) => {
    const outcome = await acquireSessionLease(join(dir, 'x.lock'), 'x', failing(code));
    expect(outcome).toEqual({ unavailable: `boom ${code}` });
  });

  it.each(['EAGAIN', 'EWOULDBLOCK'])('%s：被人握著', async (code) => {
    await expect(acquireSessionLease(join(dir, 'x.lock'), 'x', failing(code))).rejects.toThrow(
      SessionAlreadyOwnedError,
    );
  });

  /** 一個什麼都吞成「退到不鎖」的分類，會讓權限問題悄悄關掉整道租約。 */
  it.each(['EACCES', 'EIO'])('%s：原樣往外拋，不退', async (code) => {
    await expect(
      acquireSessionLease(join(dir, 'x.lock'), 'x', failing(code)),
    ).rejects.toMatchObject({ code });
  });
});

describe('這個平台拿不到鎖', () => {
  it('照常寫，而且一個後端只講一次', async () => {
    const warnings: string[] = [];
    const store = openJsonlSessionStore({
      directory: dir,
      warn: (message) => void warnings.push(message),
      lock: failing('ERR_FLOCK_UNSUPPORTED_PLATFORM'),
    });
    const root = store.create(header('cli'));
    const sub = store.create(header('cli/run-1'));
    await root.append([event(0)]);
    await sub.append([event(0)]);
    await root.close();
    await sub.close();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('拿不到寫租約');
    const back = await openJsonlSessionStore({ directory: dir }).resume('cli');
    expect(back.events).toHaveLength(1);
    await back.stored.close();
  });
});
