/**
 * `spawnerFlock` 把 spawner 的結局分成哪幾種（#2253）。helper 是假的 shell 腳本，任何平台都跑得；真的 kernel 鎖
 * 在 `home-lock.test.ts` 與 `session-lease.test.ts`。
 */

import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { lockFileExclusive, spawnerFlock } from './kernel-file-lock.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-kernel-lock-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function helper(body: string, mode = 0o755): Promise<string> {
  const path = join(dir, 'helper');
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, mode);
  return path;
}

const lockFile = () => join(dir, 'x.lock');

/** 起行程那一下就丟 `code`，同 Node 的 `spawn` 在 `fork` 失敗時的樣子。 */
function spawnFails(code: string): typeof spawn {
  return (() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('error', Object.assign(new Error(`spawn ${code}`), { code })));
    return child;
  }) as unknown as typeof spawn;
}

describe('spawnerFlock', () => {
  it('結束碼 0：拿到，把手留著', async () => {
    const outcome = await lockFileExclusive(lockFile(), spawnerFlock(await helper('exit 0')));
    if (!('held' in outcome)) throw new Error('沒拿到鎖');
    await outcome.held.close();
  });

  it('結束碼 10：別人握著', async () => {
    const lock = spawnerFlock(await helper('exit 10'));
    expect(await lockFileExclusive(lockFile(), lock)).toEqual({ contended: true });
  });

  it('結束碼 11：stdout 的 errno 換回名字往外拋，不算別人握著', async () => {
    const eacces = spawnerFlock(await helper('echo 13; exit 11'));
    await expect(lockFileExclusive(lockFile(), eacces)).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('helper 被訊號殺掉、或回不認得的結束碼：往外拋', async () => {
    const killed = spawnerFlock(await helper('kill -9 $$'));
    await expect(lockFileExclusive(lockFile(), killed)).rejects.toMatchObject({
      code: 'ERR_FLOCK_HELPER_FAILED',
      message: expect.stringContaining('SIGKILL'),
    });
    const odd = spawnerFlock(await helper('exit 2'));
    await expect(lockFileExclusive(lockFile(), odd)).rejects.toMatchObject({
      code: 'ERR_FLOCK_HELPER_FAILED',
    });
  });

  it('沒有 spawner、或那個路徑不存在：退到不鎖', async () => {
    expect(await lockFileExclusive(lockFile(), spawnerFlock(undefined))).toHaveProperty(
      'unavailable',
    );
    const missing = spawnerFlock(join(dir, 'nothing'));
    expect(await lockFileExclusive(lockFile(), missing)).toHaveProperty('unavailable');
  });

  it('spawn 本身丟 EAGAIN（行程數到頂）：往外拋，不是別人握著', async () => {
    const lock = spawnerFlock('/whatever', spawnFails('EAGAIN'));
    await expect(lockFileExclusive(lockFile(), lock)).rejects.toMatchObject({
      code: 'ERR_FLOCK_SPAWN',
    });
  });

  it('spawner 在但起不來（沒有執行權限）：往外拋，不退到不鎖', async () => {
    const lock = spawnerFlock(await helper('exit 0', 0o644));
    await expect(lockFileExclusive(lockFile(), lock)).rejects.toMatchObject({
      code: 'ERR_FLOCK_SPAWN',
    });
  });
});
