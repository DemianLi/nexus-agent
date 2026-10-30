/**
 * 產品選哪一支 launcher（#1946 Q1 的接線紅燈）。測試設施換掉了 `productToolLauncher`，所以這裡驗選法本身，再驗 backend 真的走它。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { ContainedFilesystemBackend } from './contained-backend.js';
import {
  findSpawnerBinary,
  formatSandboxStatus,
  productToolLauncher,
  selectToolLauncher,
} from './tool-launcher.js';
import { runRipgrep } from './ripgrep-runner.js';
import type { ToolLauncher, ToolProcess, ToolRequest, ToolResult } from './tool-process.js';

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

describe('formatSandboxStatus', () => {
  it.each([
    ['darwin', '/s', undefined, '只有 danger-full-access'],
    ['linux', undefined, undefined, '找不到 spawner'],
    ['linux', '/s', undefined, 'spawner 起不來'],
    ['linux', '/s', 0, '沒有 Landlock'],
    ['linux', '/s', 4, 'ABI 4，只有部分強制'],
    ['linux', '/s', 6, 'ABI 6，完整強制'],
  ] as const)('%s %s ABI %s', (platform, binary, abi, expected) => {
    expect(formatSandboxStatus(platform, binary, abi)).toContain(expected);
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

describe('起 rg 的途中取消', () => {
  it('起來之後照樣 SIGTERM，寬限到了升級 SIGKILL', async () => {
    const kills: string[] = [];
    let finish!: (result: ToolResult) => void;
    let started!: (process: ToolProcess) => void;
    const launcher: ToolLauncher = () => new Promise((resolve) => (started = resolve));
    const controller = new AbortController();
    const outcome = runRipgrep({
      argv: [],
      cwd: tmpdir(),
      executable: process.execPath,
      signal: controller.signal,
      internals: { launcher, killGraceMs: 200 },
    });
    await vi.waitFor(() => expect(started).toBeDefined());
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    started({
      pid: 1,
      stdout: Readable.from([]),
      stderr: Readable.from([]),
      kill: (signal) => {
        kills.push(signal);
        if (signal === 'SIGKILL') finish({ kind: 'exited', code: null, signal });
      },
      exited: new Promise(() => undefined),
      done: new Promise((resolve) => (finish = resolve)),
    });
    expect(await outcome).toMatchObject({ code: 'SEARCH_ABORTED' });
    expect(kills).toEqual(['SIGTERM', 'SIGKILL']);
  });
});

describe('取消之後一定收得掉', () => {
  const stuck = (kills: string[], output: readonly Buffer[] = []): ToolProcess => ({
    pid: 1,
    stdout: Readable.from(output),
    stderr: Readable.from([]),
    kill: (signal) => {
      kills.push(signal);
    },
    exited: new Promise<ToolResult>(() => undefined),
    done: new Promise<ToolResult>(() => undefined),
  });
  const run = (launcher: ToolLauncher, signal: AbortSignal, killGraceMs = 10) =>
    runRipgrep({
      argv: [],
      cwd: tmpdir(),
      executable: process.execPath,
      signal,
      internals: { launcher, killGraceMs },
    });

  it('launch 永遠不回', async () => {
    const controller = new AbortController();
    const outcome = run(() => new Promise(() => undefined), controller.signal);
    controller.abort();
    expect(await outcome).toMatchObject({ code: 'SEARCH_ABORTED' });
  });

  it('起來了但 SIGKILL 之後 done 永遠不 settle', async () => {
    const kills: string[] = [];
    const controller = new AbortController();
    let launched!: () => void;
    const ready = new Promise<void>((resolve) => (launched = resolve));
    const outcome = run(async () => {
      setTimeout(launched, 0);
      return stuck(kills);
    }, controller.signal);
    await ready;
    controller.abort();
    expect(await outcome).toMatchObject({ code: 'SEARCH_ABORTED' });
    expect(kills).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('逾時走同一條路', async () => {
    const kills: string[] = [];
    const outcome = await runRipgrep({
      argv: [],
      cwd: tmpdir(),
      executable: process.execPath,
      internals: { launcher: async () => stuck(kills), killGraceMs: 10, timeoutMs: 200 },
    });
    expect(outcome).toMatchObject({ code: 'SEARCH_ABORTED' });
    expect(kills).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('輸出超限之後卡住：回超限，不回取消', async () => {
    const kills: string[] = [];
    const outcome = await runRipgrep({
      argv: [],
      cwd: tmpdir(),
      executable: process.execPath,
      internals: {
        launcher: async () => stuck(kills, [Buffer.alloc(100)]),
        killGraceMs: 10,
        rawOutputMaxBytes: 10,
      },
    });
    expect(outcome).toMatchObject({ code: 'SEARCH_RAW_OUTPUT_OVERFLOW' });
    expect(kills).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('已經收掉之後才 Started：工具被殺掉，輸出照樣排空', async () => {
    const kills: string[] = [];
    const controller = new AbortController();
    let started!: (process: ToolProcess) => void;
    const outcome = run(() => new Promise((resolve) => (started = resolve)), controller.signal);
    await vi.waitFor(() => expect(started).toBeDefined());
    controller.abort();
    expect(await outcome).toMatchObject({ code: 'SEARCH_ABORTED' });
    const late = stuck(kills, [Buffer.from('late')]);
    started(late);
    await vi.waitFor(() => expect(kills).toEqual(['SIGKILL']));
    await vi.waitFor(() => expect(late.stdout.readableEnded).toBe(true));
  });

  it('計時器已經升級過才 Started：直接 SIGKILL，不用再等一輪 SIGTERM', async () => {
    const kills: string[] = [];
    const controller = new AbortController();
    let started!: (process: ToolProcess) => void;
    const outcome = run(
      () => new Promise((resolve) => (started = resolve)),
      controller.signal,
      150,
    );
    await vi.waitFor(() => expect(started).toBeDefined());
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 200));
    started(stuck(kills));
    expect(await outcome).toMatchObject({ code: 'SEARCH_ABORTED' });
    expect(kills).toEqual(['SIGKILL']);
  });
});

describe('backend 的搜尋走產品的 launcher', () => {
  it('grep 帶著這一格的模式、不給寫根；沙箱不可用時訊息裡有 SANDBOX_UNAVAILABLE', async () => {
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
