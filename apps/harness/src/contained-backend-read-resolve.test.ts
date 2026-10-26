/**
 * 讀取面的圍堵**判不了**的時候（[#1982](https://github.com/DemianLi/nexus-agent/issues/1982)）：解析路徑撞上的錯，只有下游開檔
 * 必定也會撞上的那幾種交給下游，其餘拒。
 *
 * `EMFILE`、`EIO` 這類暫時性的錯在真的檔案系統上做不出來，所以把 `canonicalize` 換成替身：對 `/escape` 底下的路徑拋指定的碼，
 * 其餘照真的走。開檔那一步是真的，替身拋錯之後檔案照樣讀得到——放行的話內容就經連結出去了，斷言量得到。
 */

import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const failure = vi.hoisted(() => ({ code: undefined as string | undefined }));

vi.mock('./canonical-path.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./canonical-path.js')>();
  return {
    ...actual,
    canonicalize: async (target: string): Promise<string> => {
      if (failure.code !== undefined && target.includes(`${'/'}escape`)) {
        throw Object.assign(new Error(`${failure.code}: 替身`), { code: failure.code });
      }
      return actual.canonicalize(target);
    },
  };
});

const { ContainedFilesystemBackend } = await import('./contained-backend.js');

const SECRET = '根外的內容';
let base: string;
let root: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'nexus-read-resolve-'));
  root = join(base, 'root');
  const outside = join(base, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, 'secret.txt'), SECRET);
  await symlink(outside, join(root, 'escape'));
});

afterEach(async () => {
  failure.code = undefined;
  await chmod(join(root, 'locked'), 0o700).catch(() => {});
  await rm(base, { recursive: true, force: true });
});

describe('解析撞上暫時性的錯：拒，不交給下游', () => {
  it.each(['EMFILE', 'EIO'])('%s：read 回「路徑解析失敗」，內容沒出去', async (code) => {
    failure.code = code;
    const result = await new ContainedFilesystemBackend({ rootDir: root }).read(
      '/escape/secret.txt',
    );

    expect(result).toEqual({
      error: `[containment] 拒絕 read "/escape/secret.txt"：路徑解析失敗（${code}）（mode: workspace-write）`,
    });
  });

  it('對照：替身不拋時同一條路照常被判成根外', async () => {
    const result = await new ContainedFilesystemBackend({ rootDir: root }).read(
      '/escape/secret.txt',
    );

    expect(result.error).toContain('經符號連結解析之後落在根之外');
  });
});

describe('下游必定也會撞上的錯：交給下游，錯誤字句照舊', () => {
  // root 帳號讀得穿 0000 的目錄，量不到 EACCES。
  it.skipIf(process.getuid?.() === 0)('EACCES：照舊是開檔那一步的錯', async () => {
    await mkdir(join(root, 'locked'));
    await writeFile(join(root, 'locked', 'a.txt'), 'x');
    await chmod(join(root, 'locked'), 0o000);
    const result = await new ContainedFilesystemBackend({ rootDir: root }).read('/locked/a.txt');

    expect(result.error).toMatch(/^Error reading file '\/locked\/a\.txt': EACCES/);
  });
});
