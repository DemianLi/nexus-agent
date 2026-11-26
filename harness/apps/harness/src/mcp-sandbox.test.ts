import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMcpGuardWrapper, createMcpSandboxWrapper, mcpGuardNotice } from './mcp-sandbox.js';
import type { McpSandboxHost } from './mcp-sandbox.js';

describe('createMcpSandboxWrapper', () => {
  let base: string;
  let host: McpSandboxHost;
  let command: string;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'nexus-mcp-sandbox-')));
    await mkdir(join(base, 'user/project'), { recursive: true });
    await mkdir(join(base, 'serve/thread-roots/t'), { recursive: true });
    command = join(base, 'user/project/server');
    await writeFile(command, '#!/bin/sh\n', { mode: 0o755 });
    host = {
      platform: 'linux',
      binary: '/opt/spawner',
      serveHome: join(base, 'serve'),
      userHomes: [join(base, 'user')],
    };
  });
  afterEach(() => rm(base, { recursive: true, force: true }));

  const wrap = (extra: { readable?: string[]; writable?: string[]; cwd?: string } = {}) =>
    createMcpSandboxWrapper(() => host)({
      command,
      args: ['--x'],
      readable: extra.readable ?? [],
      writable: extra.writable ?? [],
      cwd: extra.cwd,
    });

  it('換成單次模式：宣告的路徑進讀根、寫根，原本的指令接在 -- 後面', async () => {
    const data = join(base, 'user/project');
    const wrapped = await wrap({ readable: [data], writable: [data] });
    expect(wrapped.command).toBe('/opt/spawner');
    expect(wrapped.args[0]).toBe('--exec');
    expect(wrapped.args.slice(-3)).toEqual(['--', command, '--x']);
    const pairs = (flag: string): string[] =>
      wrapped.args.flatMap((arg, i) => (arg === flag ? [wrapped.args[i + 1]!] : []));
    expect(pairs('--read')).toEqual(expect.arrayContaining(['/usr', command, data]));
    expect(pairs('--write')).toEqual([data]);
  });

  it('`{}` 也是要套：包裝不看有沒有宣告路徑', async () => {
    expect((await wrap()).args[0]).toBe('--exec');
  });

  it.each(['darwin', 'win32'] as const)('%s：不連線', async (platform) => {
    host = { ...host, platform };
    await expect(wrap()).rejects.toThrow('沒有沙箱');
  });

  it('找不到 spawner：不連線', async () => {
    host = { ...host, binary: undefined };
    await expect(wrap()).rejects.toThrow('沒有沙箱');
  });

  describe.each(['readable', 'writable'] as const)('%s', (key) => {
    it.each([
      ['$HOME', 'user'],
      ['包住 $HOME 的目錄', '.'],
      ['serve 的 home', 'serve'],
      ['serve 的 home 底下', 'serve/thread-roots/t'],
    ])('拒絕 %s', async (_label, path) => {
      await expect(wrap({ [key]: [join(base, path)] })).rejects.toThrow('不能開');
    });

    it('拒絕經 symlink 走到 serve 的 home', async () => {
      const link = join(base, 'user/project/link');
      await symlink(join(base, 'serve'), link);
      await expect(wrap({ [key]: [link] })).rejects.toThrow('不能開');
    });

    it('路徑不存在：拒絕', async () => {
      await expect(wrap({ [key]: [join(base, 'gone')] })).rejects.toThrow('不存在');
    });
  });

  it('cwd 是 $HOME：拒絕', async () => {
    await expect(wrap({ cwd: join(base, 'user') })).rejects.toThrow('不能開');
  });

  it('command 落在 serve 的 home 底下：拒絕', async () => {
    command = join(base, 'serve/server');
    await writeFile(command, '#!/bin/sh\n', { mode: 0o755 });
    await expect(wrap()).rejects.toThrow('不能開');
  });

  it('系統目錄包住 serve 的 home：那一項不給', async () => {
    host = { ...host, serveHome: '/usr/share/nexus' };
    const wrapped = await wrap();
    expect(wrapped.args).not.toContain('/usr');
  });

  it('相對的 cwd 以行程的 cwd 為基準，只解一次', async () => {
    const before = process.cwd();
    process.chdir(join(base, 'user'));
    try {
      const wrapped = await wrap({ cwd: 'project', readable: ['.'] });
      expect(wrapped.args).toContain(join(base, 'user/project'));
    } finally {
      process.chdir(before);
    }
  });

  it('command 沒有斜線：照 PATH 找', async () => {
    const wrapped = await createMcpSandboxWrapper(() => host)({
      command: 'server',
      args: [],
      readable: [],
      writable: [],
      path: `/no/such:${join(base, 'user/project')}`,
    });
    expect(wrapped.args.at(-1)).toBe(command);
  });

  it('找不到 command：不連線', async () => {
    await expect(
      createMcpSandboxWrapper(() => host)({
        command: 'nope',
        args: [],
        readable: [],
        writable: [],
        path: '/no/such',
      }),
    ).rejects.toThrow('找不到');
  });
});

describe('createMcpGuardWrapper（#2197）', () => {
  const linux = { platform: 'linux', binary: '/opt/spawner' } as const;
  let base: string;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'nexus-mcp-guard-')));
  });
  afterEach(() => rm(base, { recursive: true, force: true }));

  /** 檔名固定 `server`：裸名的測試靠 `path: base` 找到它。 */
  const program = async (content: string | Uint8Array, mode = 0o755): Promise<string> => {
    const path = join(base, 'server');
    await writeFile(path, content, { mode });
    return path;
  };

  it('#! 的腳本：command 原樣交給 --guard，不換成解好的路徑，argv[0] 與 PATH 跟直接起一樣', async () => {
    await program('#!/bin/sh\n');
    const guard = createMcpGuardWrapper(() => linux);
    await expect(guard({ command: 'server', args: ['-x'], path: base })).resolves.toEqual({
      command: '/opt/spawner',
      args: ['--guard', '--', 'server', '-x'],
    });
  });

  it('ELF 包', async () => {
    const path = await program(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1]));
    await expect(
      createMcpGuardWrapper(() => linux)({ command: path, args: [] }),
    ).resolves.toMatchObject({ command: '/opt/spawner' });
  });

  it.each([
    ['沒有 #! 的腳本', 'echo hello\n'],
    ['只有 ELF 前幾個位元組', new Uint8Array([0x7f, 0x45])],
    ['空檔', ''],
  ])('%s 不包：直接起才會退回 /bin/sh', async (_name, content) => {
    const path = await program(content);
    await expect(
      createMcpGuardWrapper(() => linux)({ command: path, args: [] }),
    ).resolves.toBeUndefined();
  });

  it('讀不到檔頭不包', async () => {
    const path = await program('#!/bin/sh\n', 0o111);
    // root 不受檔案模式限制，讀得到檔頭。
    const readable = process.getuid?.() === 0;
    const wrapped = await createMcpGuardWrapper(() => linux)({ command: path, args: [] });
    expect(wrapped === undefined).toBe(!readable);
  });

  it('找不到程式不包：直接起才報得出找不到程式', async () => {
    const guard = createMcpGuardWrapper(() => linux);
    await expect(guard({ command: 'no-such-program-2197', args: [] })).resolves.toBeUndefined();
    await program('#!/bin/sh\n');
    await expect(
      guard({ command: 'server', args: [], path: '/no/such/dir' }),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['不是 Linux', { platform: 'darwin', binary: '/opt/spawner' }],
    ['找不到 spawner', { platform: 'linux', binary: undefined }],
  ] as const)('%s：照舊直接起，起動講一次', async (_name, host) => {
    const path = await program('#!/bin/sh\n');
    await expect(
      createMcpGuardWrapper(() => host)({ command: path, args: [] }),
    ).resolves.toBeUndefined();
    expect(mcpGuardNotice(host)).toContain('孤兒');
  });

  it('包得了就不講', () => {
    expect(mcpGuardNotice(linux)).toBeUndefined();
  });
});
