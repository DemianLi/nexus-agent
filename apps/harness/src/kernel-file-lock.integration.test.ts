/**
 * 真的 spawner 拿真的鎖（#2253）：走 `lockFileExclusive`，第二個行程搶不到，持有者 SIGKILL 之後拿得到。
 * 只在 Linux 跑，`NEXUS_SPAWNER_BIN` 指到執行檔；CI 的 `sandbox-spawner` job 會設，其他地方跳過。
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { spawnerFlock } from './kernel-file-lock.js';

const BINARY = process.env.NEXUS_SPAWNER_BIN;

const { lockFileExclusive } =
  await vi.importActual<typeof import('./kernel-file-lock.js')>('./kernel-file-lock.js');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexus-kernel-lock-real-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(BINARY === undefined)('真的 spawner', () => {
  const lock = spawnerFlock(BINARY);

  it('同行程的第二個把手搶不到；第一個關了才拿得到', async () => {
    const path = join(dir, 'x.lock');
    const first = await lockFileExclusive(path, lock);
    if (!('held' in first)) throw new Error('沒拿到鎖');
    expect(await lockFileExclusive(path, lock)).toEqual({ contended: true });
    await first.held.close();
    const again = await lockFileExclusive(path, lock);
    if (!('held' in again)) throw new Error('放了還拿不到');
    await again.held.close();
  });

  it('別的行程握著：搶不到；它被 SIGKILL 之後拿得到', async () => {
    const path = join(dir, 'x.lock');
    const holder = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('./kernel-file-lock-holder.fixture.ts', import.meta.url)),
        BINARY as string,
        path,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const [first] = (await once(holder.stdout, 'data')) as [Buffer];
    expect(first.toString().trim()).toBe('held');
    expect(await lockFileExclusive(path, lock)).toEqual({ contended: true });
    holder.kill('SIGKILL');
    await once(holder, 'exit');
    const after = await lockFileExclusive(path, lock);
    if (!('held' in after)) throw new Error('持有者死了還拿不到');
    await after.held.close();
  });
});
