/**
 * 回給模型的錯誤文字不含主機路徑（[#2201](https://github.com/DemianLi/nexus-agent/issues/2201)）。模型的回覆使用者看得到，多人共用的主機上，
 * 根放在哪、連結指到哪都是不該講出去的佈局。
 *
 * backend 那一層逐入口斷言；工具層的樣子見 `read-containment-tools.test.ts`。
 */

import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ContainedFilesystemBackend, pathlessReason } from './contained-backend.js';
import type { ContainedFilesystemBackendOptions } from './contained-backend.js';

let base: string;
let root: string;
let outside: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'nexus-host-paths-')));
  root = join(base, 'thread-root');
  outside = join(base, 'somewhere-else');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, 'target.txt'), '根外的檔');
  await writeFile(join(root, 'a.txt'), '內容');
  await symlink(outside, join(root, 'out'));
});

afterEach(async () => {
  await chmod(join(root, 'locked'), 0o700).catch(() => undefined);
  await rm(base, { recursive: true, force: true });
});

function backend(options: Partial<ContainedFilesystemBackendOptions> = {}) {
  return new ContainedFilesystemBackend({ rootDir: root, mode: 'workspace-write', ...options });
}

/** 文字非空（工具真的失敗了），而且不含主機上任何一段絕對路徑。 */
function expectVirtual(error: string | undefined): void {
  expect(error).toBeTruthy();
  expect(error).not.toContain(base);
  expect(error).not.toContain('thread-root');
  expect(error).not.toContain('somewhere-else');
}

describe('被圍堵拒絕：不說連結指到哪', () => {
  it('write、edit、delete 經連結落到根外：只說落在根外', async () => {
    const fence = backend();
    const results = [
      await fence.write('/out/target.txt', '寫穿'),
      await fence.edit('/out/target.txt', '根外', '改掉'),
      await fence.delete('/out/target.txt'),
    ];
    for (const result of results) {
      expect(result.error).toContain('落在可寫根之外');
      expectVirtual(result.error);
    }
  });

  it('連結底下還不存在的路徑同樣不露出目標', async () => {
    const result = await backend().write('/out/new/file.txt', '寫穿');
    expect(result.error).toContain('落在可寫根之外');
    expectVirtual(result.error);
  });

  it('可寫根不存在：不說根在哪', async () => {
    await rm(root, { recursive: true, force: true });
    const result = await backend().write('/a.txt', '內容');
    expect(result.error).toContain('可寫根不存在');
    expectVirtual(result.error);
  });
});

describe('系統錯誤：留下原因，路徑只有模型給的那一個', () => {
  it('read_file 撞連結迴圈：ELOOP，沒有主機路徑', async () => {
    await symlink(join(root, 'loop'), join(root, 'loop'));
    const result = await backend().read('/loop/x.txt');
    expect(result.error).toMatch(/^Error reading file '\/loop\/x\.txt': ELOOP/);
    expectVirtual(result.error);
  });

  it('read_file 碰指向根內的檔案連結：ELOOP，沒有主機路徑', async () => {
    await symlink(join(root, 'a.txt'), join(root, 'a-link.txt'));
    const result = await backend().read('/a-link.txt');
    expect(result.error).toMatch(/^Error reading file '\/a-link\.txt': ELOOP/);
    expectVirtual(result.error);
  });

  it('read_file 在根不存在時：ENOENT，沒有主機路徑', async () => {
    await rm(root, { recursive: true, force: true });
    const result = await backend().read('/a.txt');
    expect(result.error).toMatch(/^Error reading file '\/a\.txt': ENOENT/);
    expectVirtual(result.error);
  });

  it('write_file 的父路徑是檔案：沒有主機路徑', async () => {
    const result = await backend().write('/a.txt/child.txt', '內容');
    expect(result.error).toMatch(/^Error writing file '\/a\.txt\/child\.txt': E/);
    expectVirtual(result.error);
  });

  it('edit_file 讀不了：沒有主機路徑', async () => {
    await mkdir(join(root, 'locked'));
    await writeFile(join(root, 'locked', 'x.txt'), '內容');
    await chmod(join(root, 'locked', 'x.txt'), 0o000);
    const result = await backend().edit('/locked/x.txt', '內容', '新內容');
    expect(result.error).toMatch(/^Error editing file '\/locked\/x\.txt': EACCES/);
    expectVirtual(result.error);
  });

  it('刪除被作業系統擋下：基座的訊息也換掉主機路徑', async () => {
    await mkdir(join(root, 'locked'));
    await writeFile(join(root, 'locked', 'x.txt'), '內容');
    await chmod(join(root, 'locked'), 0o500);
    const result = await backend().delete('/locked/x.txt');
    expect(result.error).toContain('EACCES');
    expect(result.error).toContain('/locked/x.txt');
    expectVirtual(result.error);
  });

  it('沒有 errno 的錯誤帶著根：換成虛擬路徑', async () => {
    const fence = backend({
      atomicInternals: {
        afterWrite: ({ tempPath }) => {
          throw new Error(`暫存檔 ${tempPath} 壞了`);
        },
      },
    });
    const result = await fence.write('/b.txt', '內容');
    expect(result.error).toContain('暫存檔 /');
    expectVirtual(result.error);
  });
});

it('根本身經符號連結：cwd 與 realpath 兩種寫法都換掉', async () => {
  const alias = join(base, 'root-alias');
  await symlink(root, alias);
  const fence = new ContainedFilesystemBackend({
    rootDir: alias,
    mode: 'workspace-write',
    atomicInternals: {
      afterWrite: () => {
        throw new Error(`${alias}/x 與 ${root}/y 都壞了`);
      },
    },
  });
  const result = await fence.write('/b.txt', '內容');
  expect(result.error).toContain('/x 與 /y 都壞了');
  expect(result.error).not.toContain('root-alias');
  expectVirtual(result.error);
});

it('cwd 是 realpath 的後綴：換完不留前綴', async () => {
  // 形狀同 macOS 的 `/var/…` 與 `/private/var/…`：先換短的會把長的打斷。
  const alias = join(base, 'alias');
  const real = `${base}/private${alias}`;
  await mkdir(real, { recursive: true });
  await symlink(real, alias);
  const fence = new ContainedFilesystemBackend({
    rootDir: alias,
    mode: 'workspace-write',
    atomicInternals: {
      afterWrite: () => {
        throw new Error(`壞在 ${real}/a.txt`);
      },
    },
  });
  const result = await fence.write('/b.txt', '內容');
  expect(result.error).toBe("Error writing file '/b.txt': 壞在 /a.txt");
});

describe('pathlessReason', () => {
  it('errno 的路徑不在根裡也不留：真的 ENOENT 只剩碼與說明', async () => {
    const error = await readFile(join(outside, 'missing.txt')).catch((caught: unknown) => caught);
    expect(pathlessReason(error)).toBe('ENOENT: no such file or directory');
  });

  it('沒有 errno 形狀的錯誤原樣回', () => {
    expect(pathlessReason(new Error('壞了'))).toBe('壞了');
  });
});

describe('搜尋失敗：rg 的 stderr 也換掉根', () => {
  /** 一支假 rg：stderr 印出它被起在哪個目錄底下的絕對路徑，結束碼 2。 */
  async function failingRg(): Promise<string> {
    const script = join(base, 'fake-rg');
    await writeFile(script, '#!/bin/sh\necho "rg: $PWD/.gitignore: unreadable" >&2\nexit 2\n');
    await chmod(script, 0o755);
    return script;
  }

  it('grep', async () => {
    const fence = backend({ ripgrep: { executable: await failingRg() } });
    const result = await fence.grep('內容', '/');
    expect(result.error).toContain('/.gitignore');
    expectVirtual(result.error);
  });

  it('glob', async () => {
    const fence = backend({ ripgrep: { executable: await failingRg() } });
    const result = await fence.glob('*', '/');
    expect(result.error).toContain('/.gitignore');
    expectVirtual(result.error);
  });
});
