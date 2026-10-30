/**
 * 產品選哪一支 launcher（#1946 Q1 的接線紅燈）。測試設施換掉了 `productToolLauncher`，所以這裡驗選法本身，再驗 backend 真的走它。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { ContainedFilesystemBackend } from './contained-backend.js';
import { findSpawnerBinary, productToolLauncher, selectToolLauncher } from './tool-launcher.js';
import type { ToolLauncher, ToolRequest } from './tool-process.js';

const launched = vi.hoisted(() => [] as ToolRequest[]);
vi.mock('./tool-launcher.js', async (importActual) => ({
  ...(await importActual<typeof import('./tool-launcher.js')>()),
  productToolLauncher: (): ToolLauncher => (request) => {
    launched.push(request);
    return Promise.resolve('sandbox-unavailable');
  },
}));

const request = (mode: ToolRequest['mode']): ToolRequest => ({
  executable: '/rg',
  args: [],
  cwd: '/w',
  mode,
  readable: [],
  writable: [],
  env: {},
});

describe('selectToolLauncher', () => {
  const direct = vi.fn<ToolLauncher>(() => Promise.resolve('launch-failed'));

  it('非 Linux：受限的模式回 sandbox-unavailable，全權才直接 spawn', async () => {
    const launcher = selectToolLauncher('darwin', '/spawner', direct);
    expect(await launcher(request('workspace-write'))).toBe('sandbox-unavailable');
    expect(await launcher(request('read-only'))).toBe('sandbox-unavailable');
    expect(direct).not.toHaveBeenCalled();
    expect(await launcher(request('danger-full-access'))).toBe('launch-failed');
    expect(direct).toHaveBeenCalledOnce();
  });

  it('Linux 上找不到 spawner：連全權都不退回直接 spawn', async () => {
    direct.mockClear();
    const launcher = selectToolLauncher('linux', undefined, direct);
    expect(await launcher(request('danger-full-access'))).toBe('sandbox-unavailable');
    expect(direct).not.toHaveBeenCalled();
  });

  it('Linux：經 spawner，起不來就是 sandbox-unavailable，不碰直接 spawn', async () => {
    direct.mockClear();
    const launcher = selectToolLauncher('linux', '/no/such/spawner', direct);
    expect(await launcher(request('workspace-write'))).toBe('sandbox-unavailable');
    expect(direct).not.toHaveBeenCalled();
  });
});

describe('findSpawnerBinary', () => {
  it('從模組往上找產物裡的 native/ 目錄', () => {
    const root = mkdtempSync(join(tmpdir(), 'nexus-find-spawner-'));
    try {
      expect(findSpawnerBinary(join(root, 'apps/harness/dist/a.js'))).toBeUndefined();
      mkdirSync(join(root, 'native'));
      writeFileSync(join(root, 'native/nexus-sandbox-spawner'), '');
      expect(findSpawnerBinary(join(root, 'apps/harness/dist/a.js'))).toBe(
        join(root, 'native/nexus-sandbox-spawner'),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('backend 的搜尋走產品的 launcher', () => {
  it('grep 帶著這一格的模式、不給寫根；沙箱不可用的文案開頭就講', async () => {
    expect(productToolLauncher).toBeDefined();
    const root = mkdtempSync(join(tmpdir(), 'nexus-wire-'));
    try {
      const backend = new ContainedFilesystemBackend({
        rootDir: root,
        mode: 'workspace-write',
        ripgrep: { executable: process.execPath },
      });
      const result = await backend.grep('needle', '/');
      expect(result.error).toContain('SANDBOX_UNAVAILABLE');
      expect(launched.at(-1)).toMatchObject({ mode: 'read-only', writable: [] });
      expect(launched.at(-1)?.readable).toContain(root);
      const full = new ContainedFilesystemBackend({
        rootDir: root,
        mode: 'danger-full-access',
        ripgrep: { executable: process.execPath },
      });
      await full.glob('*', '/');
      expect(launched.at(-1)).toMatchObject({ mode: 'danger-full-access', readable: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
