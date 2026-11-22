/**
 * `glob` 自己起 rg（[#1605](https://github.com/DemianLi/nexus-agent/issues/1605) N0345）：不列版本控制目錄、照修改時間排序、
 * 每一筆補 `size`／`modified_at`、沒有 rg 就是錯誤。
 *
 * 基座的 `glob` 是 `fast-glob` 的 `dot: true`，不剪目錄、照路徑排序；下面每一條都對著這兩個差別，
 * 外加 rg 的 pattern 語意（沒有 `/` 的比檔名、任何深度）。**用的是內附 rg**，不在就紅，不跳過（理由同 `contained-backend-ripgrep.test.ts`）。
 */

import { chmod, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemBackend } from 'deepagents';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContainedFilesystemBackend } from './contained-backend.js';
import { ripgrepStatus } from './rg-path.js';

let base: string;
let root: string;

beforeEach(async () => {
  const status = await ripgrepStatus();
  if (status.kind !== 'bundled') throw new Error(`內附 rg 不可用：${status.reason}`);
  base = await mkdtemp(join(tmpdir(), 'nexus-glob-'));
  root = join(base, 'ws');
  await mkdir(root);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(base, { recursive: true, force: true });
});

/** 在工作區裡寫檔（父目錄自動建）。 */
async function put(rel: string, content = 'x'): Promise<void> {
  const full = join(root, rel);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content);
}

const pathsOf = (result: { files?: Array<{ path: string }> }): string[] =>
  (result.files ?? []).map((file) => file.path);

describe('不列版本控制目錄', () => {
  it('`.git/config`、`sub/.git/HEAD`、`src/a.ts`：`glob("**/*")` 只回 `src/a.ts`', async () => {
    await put('.git/config');
    await put('sub/.git/HEAD');
    await put('src/a.ts');

    const result = await new ContainedFilesystemBackend({ rootDir: root }).glob('**/*');

    expect(result.error).toBeUndefined();
    expect(pathsOf(result)).toEqual(['/src/a.ts']);
  });

  it.each(['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'])(
    '%s：任何深度、整棵都不列',
    async (name) => {
      await put(`${name}/objects/ab/cdef`);
      await put(`deep/er/${name}/config`);
      await put('keep.txt');

      const result = await new ContainedFilesystemBackend({ rootDir: root }).glob('**/*');

      expect(pathsOf(result)).toEqual(['/keep.txt']);
    },
  );

  it('搜尋起點本身就在版本控制目錄裡面（`path` 是 `/.git`）：照樣不列內容', async () => {
    await put('.git/config');
    await put('.git/objects/ab/cdef');

    const backend = new ContainedFilesystemBackend({ rootDir: root });

    expect(pathsOf(await backend.glob('**/*', '/.git'))).toEqual([]);
    expect(pathsOf(await backend.glob('**/*', '/.git/objects'))).toEqual([]);
  });

  it('名字只是長得像的不剪：`.github`、`.gitignore`、`gitlab`', async () => {
    await put('.github/workflows/ci.yml');
    await put('.gitignore');
    await put('gitlab/readme.md');

    const result = await new ContainedFilesystemBackend({ rootDir: root }).glob('**/*');

    expect(pathsOf(result).sort()).toEqual([
      '/.github/workflows/ci.yml',
      '/.gitignore',
      '/gitlab/readme.md',
    ]);
  });
});

describe('順序：修改時間，舊的在前', () => {
  it('`b.ts` 比 `a.ts` 舊：`b.ts` 在前（路徑排序會是 a 在前）', async () => {
    await put('src/a.ts');
    await put('src/b.ts');
    await utimes(
      join(root, 'src/b.ts'),
      new Date('2020-01-01T00:00:00Z'),
      new Date('2020-01-01T00:00:00Z'),
    );
    await utimes(
      join(root, 'src/a.ts'),
      new Date('2021-01-01T00:00:00Z'),
      new Date('2021-01-01T00:00:00Z'),
    );

    const result = await new ContainedFilesystemBackend({ rootDir: root }).glob('**/*.ts');

    expect(pathsOf(result)).toEqual(['/src/b.ts', '/src/a.ts']);
  });
});

describe('每一筆有 size 與 modified_at，形狀同基座', () => {
  it('跟同一個檔走 `super.glob`（基座）時相同', async () => {
    await put('src/a.ts', 'hello 世界');
    const mine = await new ContainedFilesystemBackend({ rootDir: root }).glob('**/*.ts');
    const base0 = await new FilesystemBackend({ rootDir: root, virtualMode: true }).glob(
      'src/a.ts',
    );

    expect(mine.files).toHaveLength(1);
    expect(mine.files?.[0]).toEqual(base0.files?.[0]);
    expect(mine.files?.[0]).toMatchObject({
      path: '/src/a.ts',
      is_dir: false,
      size: Buffer.byteLength('hello 世界'),
    });
    expect(mine.files?.[0]?.modified_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });
});

describe('沒有 rg：回錯誤，沒有退路', () => {
  it('執行檔不存在：錯誤字句指名 glob，`FilesystemBackend.prototype.glob` 一次都沒被叫', async () => {
    await put('src/a.ts');
    await put('.git/config');
    const bare = vi.spyOn(FilesystemBackend.prototype, 'glob');

    const result = await new ContainedFilesystemBackend({
      rootDir: root,
      ripgrep: { executable: join(base, 'no-such-rg') },
    }).glob('**/*');

    expect(result.error).toBe(
      'glob could not start its search command (bundled ripgrep not found)',
    );
    expect(result.files).toBeUndefined();
    expect(result.error).not.toContain(base);
    expect(bare).not.toHaveBeenCalled();
  });
});

describe('pattern 與起點', () => {
  it('空白 pattern 回錯誤（`--glob=` 空字串會讓 rg 列出全部，含 `.git`）', async () => {
    await put('.git/config');
    await put('a.txt');
    const backend = new ContainedFilesystemBackend({ rootDir: root });

    for (const pattern of ['', '   ']) {
      const result = await backend.glob(pattern);
      expect(result.error).toBe('glob pattern must be a non-empty string');
      expect(result.files).toBeUndefined();
    }
  });

  it('沒有 `/` 的 pattern 比檔名、任何深度；帶 `/` 的對工作區根錨定', async () => {
    await put('a.ts');
    await put('src/b.ts');
    await put('src/deep/c.ts');
    await put('other/src/d.ts');
    const backend = new ContainedFilesystemBackend({ rootDir: root });

    expect(pathsOf(await backend.glob('*.ts')).sort()).toEqual([
      '/a.ts',
      '/other/src/d.ts',
      '/src/b.ts',
      '/src/deep/c.ts',
    ]);
    expect(pathsOf(await backend.glob('src/*.ts'))).toEqual(['/src/b.ts']);
    expect(pathsOf(await backend.glob('/src/**/*.ts')).sort()).toEqual([
      '/src/b.ts',
      '/src/deep/c.ts',
    ]);
  });

  it('大括號選擇與沒有命中', async () => {
    await put('a.js');
    await put('b.jsx');
    await put('c.ts');
    const backend = new ContainedFilesystemBackend({ rootDir: root });

    expect(pathsOf(await backend.glob('*.{js,jsx}')).sort()).toEqual(['/a.js', '/b.jsx']);
    expect(await backend.glob('*.zzz')).toEqual({ files: [] });
  });

  it('`path` 縮小範圍；不存在或不是目錄回空（同基座），不是錯誤', async () => {
    await put('src/a.ts');
    await put('docs/b.ts');
    const backend = new ContainedFilesystemBackend({ rootDir: root });

    expect(pathsOf(await backend.glob('**/*.ts', '/src'))).toEqual(['/src/a.ts']);
    expect(await backend.glob('**/*', '/nope')).toEqual({ files: [] });
    expect(await backend.glob('**/*', '/src/a.ts')).toEqual({ files: [] });
  });

  it('根不存在：沒有東西可找，不是錯誤', async () => {
    const result = await new ContainedFilesystemBackend({ rootDir: join(base, 'missing') }).glob(
      '**/*',
    );

    expect(result).toEqual({ files: [] });
  });

  it('被 `.gitignore` 蓋住的與隱藏檔照樣列（`--no-ignore --hidden`），這是 dsh 的契約', async () => {
    await put('.gitignore', 'ignored.txt\n');
    await put('ignored.txt');
    await put('.hidden');
    await put('shown.txt');

    const result = await new ContainedFilesystemBackend({ rootDir: root }).glob('*');

    expect(pathsOf(result).sort()).toEqual([
      '/.gitignore',
      '/.hidden',
      '/ignored.txt',
      '/shown.txt',
    ]);
  });

  it('隱藏目錄裡的檔照樣列：`*.yml` 找得到 `.github/workflows/ci.yml`', async () => {
    await put('.github/workflows/ci.yml');
    await put('docs/readme.yml');

    const result = await new ContainedFilesystemBackend({ rootDir: root }).glob('*.yml');

    expect(pathsOf(result).sort()).toEqual(['/.github/workflows/ci.yml', '/docs/readme.yml']);
  });

  it('檔名含換行：整個檔名是一筆，不被切成兩筆', async () => {
    await put('odd\nname.ts');
    await put('plain.ts');

    const result = await new ContainedFilesystemBackend({ rootDir: root }).glob('*.ts');

    expect(pathsOf(result).sort()).toEqual(['/odd\nname.ts', '/plain.ts']);
  });

  it('symlink 不跟、不列：指到工作區外的目錄不會把外面的檔帶進來', async () => {
    const outside = join(base, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'secret.ts'), 'secret');
    await symlink(outside, join(root, 'link'));
    await put('real.ts');

    const result = await new ContainedFilesystemBackend({ rootDir: root }).glob('**/*.ts');

    expect(pathsOf(result)).toEqual(['/real.ts']);
  });
});

describe('檔名以 `..` 開頭的檔不被當成跑出根外（dsh `toWorkdirRelative`）', () => {
  it('glob：`..foo`、`...bar`、`..` 開頭的目錄底下的檔都列', async () => {
    await put('..foo', 'x');
    await put('...bar', 'x');
    await put('..dir/inner.txt', 'x');
    await put('plain.txt', 'x');

    const result = await new ContainedFilesystemBackend({ rootDir: root }).glob('*');

    expect(pathsOf(result).sort()).toEqual(['/...bar', '/..dir/inner.txt', '/..foo', '/plain.txt']);
  });

  it('grep：同上，命中不被丟掉（虛擬路徑本身含 `..` 會被 fence 擋掉，所以用 glob 篩選從根搜，隱藏檔靠明給的 glob 放行）', async () => {
    await put('..foo', 'needle\n');
    await put('..dir/inner.txt', 'needle\n');
    const backend = new ContainedFilesystemBackend({ rootDir: root });

    // glob 篩選明給了，隱藏的檔與目錄才會被放行；`*` 放行整棵。
    const result = await backend.grep('needle', '/', '*');
    expect(result.error).toBeUndefined();
    expect((result.matches ?? []).map((match) => match.path).sort()).toEqual([
      '/..dir/inner.txt',
      '/..foo',
    ]);
  });
});

describe('rg 吐出來的不是一般檔就略過（兩次呼叫之間被換掉的防線）', () => {
  it('用 stub 的 rg 吐出一個目錄與一個 symlink 與一個真檔：只回真檔', async () => {
    await put('real.txt', 'x');
    await mkdir(join(root, 'adir'));
    await symlink(join(root, 'real.txt'), join(root, 'alink'));
    const stub = join(base, 'fake-rg.sh');
    await writeFile(stub, "#!/bin/sh\nprintf 'adir\\0alink\\0real.txt\\0'\n");
    await chmod(stub, 0o755);

    const result = await new ContainedFilesystemBackend({
      rootDir: root,
      ripgrep: { executable: stub },
    }).glob('*');

    expect(pathsOf(result)).toEqual(['/real.txt']);
  });
});
