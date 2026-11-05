import { spawn } from 'node:child_process';
import { chmod, chown, lstat, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertProxySocketDirectory,
  clearStaleSocket,
  openSocketToProxy,
  parseSocketGroup,
} from './proxy-socket.js';

const POSIX = process.platform !== 'win32';
const GID = process.getgid?.() ?? 0;

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

/** 一個權限是 `mode`、群組是這個行程的群組的目錄，回 socket 放在裡面的路徑。 */
async function socketIn(mode: number): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'nx-sock-'));
  await chown(directory, process.getuid?.() ?? 0, GID);
  await chmod(directory, mode);
  return join(directory, 's');
}

async function listenOn(path: string): Promise<Server> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return server;
}

/** 起一個子行程聽 `path`，再 `SIGKILL` 它：留下一個沒有人在聽的 socket 檔。 */
async function staleSocketAt(path: string): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      '-e',
      'require("node:net").createServer().listen(process.argv[1], () => process.stdout.write("ready"))',
      path,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGKILL');
  await exited;
}

describe('parseSocketGroup', () => {
  it('收數字 gid', () => {
    expect(parseSocketGroup('0')).toBe(0);
    expect(parseSocketGroup('101')).toBe(101);
  });

  it.each(['nginx', '-1', '1.5', '', ' 101', '0x10', '99999999999999999999'])(
    '"%s" 不收：只收非負整數',
    (raw) => {
      expect(() => parseSocketGroup(raw)).toThrow(/--socket-group 要給代理所在群組的數字 gid/);
    },
  );
});

describe.runIf(POSIX)('assertProxySocketDirectory', () => {
  it.each([0o750, 0o710])('%o 過', async (mode) => {
    await expect(assertProxySocketDirectory(await socketIn(mode), GID)).resolves.toBeUndefined();
  });

  it.each([0o755, 0o751, 0o770, 0o700, 0o711, 0o740])(
    '%o 不過：要恰好 750 或 710',
    async (mode) => {
      await expect(assertProxySocketDirectory(await socketIn(mode), GID)).rejects.toThrow(
        /要恰好 750 或 710/,
      );
    },
  );

  it('群組跟 --socket-group 不一樣不過', async () => {
    await expect(assertProxySocketDirectory(await socketIn(0o750), GID + 1)).rejects.toThrow(
      /跟 --socket-group/,
    );
  });

  it('目錄是符號連結不過，即使它指向合格的目錄', async () => {
    const real = await socketIn(0o750);
    const link = join(await mkdtemp(join(tmpdir(), 'nx-link-')), 'd');
    await symlink(join(real, '..'), link);
    await expect(assertProxySocketDirectory(join(link, 's'), GID)).rejects.toThrow(
      /不是目錄（符號連結也不算）/,
    );
  });

  it('目錄不存在不過', async () => {
    const missing = join(await mkdtemp(join(tmpdir(), 'nx-miss-')), 'none', 's');
    await expect(assertProxySocketDirectory(missing, GID)).rejects.toThrow(/讀不到/);
  });

  it('路徑上那一層是一般檔不過', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'nx-file-'));
    await writeFile(join(parent, 'f'), '');
    await expect(assertProxySocketDirectory(join(parent, 'f', 's'), GID)).rejects.toThrow(
      /不是目錄/,
    );
  });
});

describe.runIf(POSIX)('clearStaleSocket', () => {
  it('路徑上沒有檔：什麼都不做', async () => {
    await expect(clearStaleSocket(await socketIn(0o750))).resolves.toBeUndefined();
  });

  it('沒有人在聽的 socket 檔被清掉，之後聽得起來', async () => {
    const path = await socketIn(0o750);
    await staleSocketAt(path);
    expect((await lstat(path)).isSocket()).toBe(true);
    await clearStaleSocket(path);
    await expect(lstat(path)).rejects.toThrow(/ENOENT/);
    await listenOn(path);
  });

  it('還有行程在聽：拒絕，檔留著', async () => {
    const path = await socketIn(0o750);
    await listenOn(path);
    await expect(clearStaleSocket(path)).rejects.toThrow(/已經有行程在聽/);
    expect((await lstat(path)).isSocket()).toBe(true);
  });

  it('不是 socket 的檔：拒絕，不刪', async () => {
    const path = await socketIn(0o750);
    await writeFile(path, 'keep');
    await expect(clearStaleSocket(path)).rejects.toThrow(/不是 socket 的檔/);
    expect((await lstat(path)).isFile()).toBe(true);
  });

  it('是目錄也拒絕', async () => {
    const path = await socketIn(0o750);
    await mkdir(path);
    await expect(clearStaleSocket(path)).rejects.toThrow(/不是 socket 的檔/);
  });
});

describe.runIf(POSIX)('openSocketToProxy', () => {
  it('socket 檔改成 666，不管 umask 給了什麼', async () => {
    const path = await socketIn(0o750);
    await listenOn(path);
    await chmod(path, 0o600);
    await openSocketToProxy(path);
    expect((await lstat(path)).mode & 0o777).toBe(0o666);
  });
});
