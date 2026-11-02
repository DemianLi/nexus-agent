/**
 * 儲存探針的判準與護欄（[#2195](https://github.com/DemianLi/nexus-agent/issues/2195)）：
 * 假陽性、單飛、時間窗、卡住不算滿。
 */

import { describe, expect, it } from 'vitest';

import { isStorageFull, StorageProbe } from './storage-probe.js';
import type { StatfsResult } from './storage-probe.js';

const ROOMY: StatfsResult = { blocks: 100, bavail: 50, files: 100, ffree: 50 };
const NO_BLOCKS: StatfsResult = { ...ROOMY, bavail: 0 };

const areas = { home: ['/home'], 'thread-roots': ['/roots'] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe('isStorageFull', () => {
  it.each([
    ['區塊用完', NO_BLOCKS, true],
    ['inode 用完', { ...ROOMY, ffree: 0 }, true],
    ['都還有', ROOMY, false],
    ['btrfs、部分 NFS 的 files 回 0：不算 inode 用完', { ...ROOMY, files: 0, ffree: 0 }, false],
    ['回報不出區塊：不算滿', { ...ROOMY, blocks: 0, bavail: 0 }, false],
  ])('%s', (_name, stat, full) => {
    expect(isStorageFull(stat)).toBe(full);
  });
});

describe('StorageProbe', () => {
  it('各區分開看；釋放後回到空的，不留狀態', async () => {
    const stats = new Map([
      ['/home', ROOMY],
      ['/roots', NO_BLOCKS],
    ]);
    const warnings: string[] = [];
    const probe = new StorageProbe({
      areas,
      intervalMs: 0,
      warn: (message) => warnings.push(message),
      statfs: async (path) => stats.get(path)!,
    });
    await probe.refresh();
    expect(probe.full).toEqual(['thread-roots']);
    stats.set('/roots', ROOMY);
    await probe.refresh();
    expect(probe.full).toEqual([]);
    expect(warnings).toEqual(['[儲存] thread-roots 滿了', '[儲存] thread-roots 有空間了']);
  });

  it('同一區有幾個目錄，任一個滿就算滿', async () => {
    const probe = new StorageProbe({
      areas: { home: ['/home', '/logs'], 'thread-roots': [] },
      warn: () => undefined,
      statfs: async (path) => (path === '/logs' ? NO_BLOCKS : ROOMY),
    });
    await probe.refresh();
    expect(probe.full).toEqual(['home']);
  });

  it('時間窗內探針再多也只查一輪', async () => {
    let calls = 0;
    let now = 0;
    const probe = new StorageProbe({
      areas: { home: ['/home'], 'thread-roots': [] },
      intervalMs: 5000,
      now: () => now,
      warn: () => undefined,
      statfs: async () => {
        calls += 1;
        return ROOMY;
      },
    });
    await Promise.all([probe.refresh(), probe.refresh()]);
    await probe.refresh();
    expect(calls).toBe(1);
    now = 5000;
    await probe.refresh();
    expect(calls).toBe(2);
  });

  it('statfs 卡住：不疊新的、沿用上一次、只講一次；回來之後用新值', async () => {
    const stuck = deferred<StatfsResult>();
    let calls = 0;
    const warnings: string[] = [];
    const probe = new StorageProbe({
      areas: { home: ['/home'], 'thread-roots': [] },
      intervalMs: 0,
      timeoutMs: 5,
      warn: (message) => warnings.push(message),
      statfs: async () => {
        calls += 1;
        return calls === 1 ? NO_BLOCKS : stuck.promise;
      },
    });
    await probe.refresh();
    expect(probe.full).toEqual(['home']);
    await probe.refresh();
    await probe.refresh();
    await probe.refresh();
    expect(calls).toBe(2);
    expect(probe.full).toEqual(['home']);
    expect(warnings.filter((line) => line.includes('沒回來'))).toHaveLength(1);
    stuck.resolve(ROOMY);
    await stuck.promise;
    await new Promise((resolve) => setImmediate(resolve));
    expect(probe.full).toEqual([]);
  });

  it('第一次就卡住不算滿', async () => {
    const probe = new StorageProbe({
      areas,
      timeoutMs: 5,
      warn: () => undefined,
      statfs: () => new Promise(() => undefined),
    });
    await probe.refresh();
    expect(probe.full).toEqual([]);
  });

  it('查失敗不算滿也不拋，同一段狀況只講一次', async () => {
    const warnings: string[] = [];
    const probe = new StorageProbe({
      areas: { home: ['/home'], 'thread-roots': [] },
      intervalMs: 0,
      warn: (message) => warnings.push(message),
      statfs: async () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      },
    });
    await probe.refresh();
    await probe.refresh();
    expect(probe.full).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  it('目錄還沒建：往上找到存在的那一層', async () => {
    const seen: string[] = [];
    const probe = new StorageProbe({
      areas: { home: ['/a/b/c'], 'thread-roots': [] },
      warn: () => undefined,
      statfs: async (path) => {
        seen.push(path);
        if (path !== '/a') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return NO_BLOCKS;
      },
    });
    await probe.refresh();
    expect(seen).toEqual(['/a/b/c', '/a/b', '/a']);
    expect(probe.full).toEqual(['home']);
  });
});
