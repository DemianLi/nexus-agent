/**
 * 對話行程 socket 上的驗證（[#2338](https://github.com/DemianLi/nexus-agent/issues/2338)）：目錄權限與擁有者，以及「只有對話行程的入口建它」。
 */

import { statSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { openPeerSocketAuth } from './peer-socket-auth.js';

let directory: string | undefined;

afterEach(async () => {
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function socketIn(mode: number): Promise<string> {
  directory = await mkdtemp(join(tmpdir(), 'peer-socket-'));
  await chmod(directory, mode);
  return join(directory, 'wire.sock');
}

/** 一個存在、權限 0700、擁有者不是自己的目錄（macOS 的 `/private/var/audit`、Linux 的 `/root`）；找不到就略過那一條。 */
const foreignPrivate = ['/private/var/audit', '/root'].find((path) => {
  try {
    const info = statSync(path);
    return info.isDirectory() && (info.mode & 0o777) === 0o700 && info.uid !== process.getuid?.();
  } catch {
    return false;
  }
});

describe('openPeerSocketAuth', () => {
  it('目錄是自己的、權限 0700：放行', async () => {
    const auth = await openPeerSocketAuth(await socketIn(0o700));
    expect(auth.authenticate(new Headers())).toEqual({ kind: 'owner' });
    expect(auth.directory).toBe(directory);
  });

  it.each([0o755, 0o750, 0o770, 0o701, 0o600])('權限 %o：起不來', async (mode) => {
    await expect(openPeerSocketAuth(await socketIn(mode))).rejects.toThrow(/要恰好 700/u);
  });

  it('不是目錄：起不來', async () => {
    directory = await mkdtemp(join(tmpdir(), 'peer-socket-'));
    const file = join(directory, 'file');
    await writeFile(file, '');
    await expect(openPeerSocketAuth(join(file, 'wire.sock'))).rejects.toThrow();
  });

  it('指向 0700 目錄的符號連結：起不來', async () => {
    directory = await mkdtemp(join(tmpdir(), 'peer-socket-'));
    const real = join(directory, 'real');
    await mkdir(real, { mode: 0o700 });
    const link = join(directory, 'link');
    await symlink(real, link);
    await expect(openPeerSocketAuth(join(link, 'wire.sock'))).rejects.toThrow(/符號連結也不算/u);
  });

  it.skipIf(foreignPrivate === undefined)('擁有者不是自己：起不來', async () => {
    await expect(openPeerSocketAuth(join(foreignPrivate!, 'wire.sock'))).rejects.toThrow(
      /擁有者是 uid/u,
    );
  });
});

describe('只有對話行程的入口建它', () => {
  it('原始碼裡呼叫 openPeerSocketAuth 的只有 conversation-process.ts', async () => {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const callers: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(path);
          continue;
        }
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
        if (entry.name === 'peer-socket-auth.ts') continue;
        if ((await readFile(path, 'utf8')).includes('openPeerSocketAuth(')) {
          callers.push(path.slice(here.length));
        }
      }
    };
    await walk(here);
    expect(callers).toEqual(['conversation-process.ts']);
  });
});
