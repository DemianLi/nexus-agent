/**
 * `@` 引用的列檔（#651）。前半逐條移植 dsh 的 `packages/context/file-reference-local/tests/search.spec.ts`
 * （`477b4f4`，文法那一段歸 web），後半是我們加的位址翻譯。
 */

import { chmod, mkdir, mkdtemp, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FILE_SEARCH_DEFAULTS,
  FILE_SEARCH_EXCLUDED_DIRECTORIES,
  listFileReferences,
  WorkspaceFileSearch,
  type FileSearchConfig,
} from './file-references.js';

const fsControl = vi.hoisted(() => ({
  /** `readdir` 會拒絕的那個絕對路徑：chmod 0 的替身，可以注入。同 dsh。 */
  denyReaddir: undefined as string | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: vi.fn((async (path: unknown, ...rest: never[]) => {
      if (fsControl.denyReaddir !== undefined && String(path) === fsControl.denyReaddir) {
        throw Object.assign(new Error('EACCES: injected unreadable directory'), {
          code: 'EACCES',
        });
      }
      return (actual.readdir as (path: unknown, ...args: never[]) => Promise<unknown>)(
        path,
        ...rest,
      );
    }) as typeof actual.readdir),
  };
});

const searches: WorkspaceFileSearch[] = [];
const roots: string[] = [];
/** 拔掉權限的目錄；清理前要先還原才刪得掉。 */
const locks: string[] = [];

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nexus-file-references-'));
  roots.push(root);
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(root, '.hidden'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'ignored-package'), { recursive: true });
  await writeFile(join(root, 'README.md'), 'readme');
  await writeFile(join(root, 'src', 'tui.spec.ts'), 'test');
  await writeFile(join(root, 'src', 'terminal-view.ts'), 'view');
  await writeFile(join(root, 'docs', 'design notes.md'), 'design');
  await writeFile(join(root, '.hidden', 'secret.txt'), 'hidden');
  await writeFile(join(root, 'node_modules', 'ignored-package', 'index.js'), 'ignored');
  await symlink(join(root, 'src', 'tui.spec.ts'), join(root, 'linked-test.ts'));
  return root;
}

/** 根外的目錄。放在 `/var/tmp`：不在任何暫存根底下，量到「不列」時不會是別的規則說的。 */
async function outside(): Promise<string> {
  const dir = await mkdtemp('/var/tmp/nexus-file-references-outside-');
  roots.push(dir);
  await writeFile(join(dir, 'outside-secret.txt'), 'secret');
  return dir;
}

function search(root: string, overrides: Partial<FileSearchConfig> = {}): WorkspaceFileSearch {
  const instance = new WorkspaceFileSearch(root, {
    maxResults: overrides.maxResults ?? 20,
    maxEntries: overrides.maxEntries ?? 10_000,
    excludedDirectories: overrides.excludedDirectories ?? ['.git', 'node_modules'],
  });
  searches.push(instance);
  return instance;
}

afterEach(async () => {
  for (const locked of locks.splice(0)) await chmod(locked, 0o700).catch(() => undefined);
  for (const instance of searches.splice(0)) instance.dispose();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.mocked(readdir).mockClear();
});

describe('WorkspaceFileSearch（照 dsh）', () => {
  it('列即時的那一層、往下鑽、含空白的路徑，濾掉隱藏與排除的', async () => {
    const root = await workspace();
    const files = search(root);
    const signal = new AbortController().signal;

    // 資料夾在前，其餘照字母；符號連結不列。
    expect(await files.list('', signal)).toEqual([
      { path: 'docs', kind: 'directory' },
      { path: 'src', kind: 'directory' },
      { path: 'README.md', kind: 'file' },
    ]);
    expect(await files.list('src/', signal)).toEqual([
      { path: 'src/terminal-view.ts', kind: 'file' },
      { path: 'src/tui.spec.ts', kind: 'file' },
    ]);
    expect(await files.list('src/ts', signal)).toEqual([
      { path: 'src/tui.spec.ts', kind: 'file' },
      { path: 'src/terminal-view.ts', kind: 'file' },
    ]);
    expect(await files.list('docs/design n', signal)).toEqual([
      { path: 'docs/design notes.md', kind: 'file' },
    ]);
    expect(await files.list('node_modules/', signal)).toEqual([]);
    expect(await files.list('.hidden/', signal)).toEqual([
      { path: '.hidden/secret.txt', kind: 'file' },
    ]);
    expect(await files.list('~/.nexus-file-references-missing/', signal)).toEqual([]);
    expect(await files.list('../', signal)).toEqual([]);
    expect(await files.list('README.md/', signal)).toEqual([]);
  });

  it('列單層時，片段以 . 開頭才列隱藏的', async () => {
    const root = await workspace();
    const files = search(root);
    const signal = new AbortController().signal;
    await writeFile(join(root, 'src', '.local.ts'), 'local');
    expect(await files.list('src/', signal)).not.toContainEqual({
      path: 'src/.local.ts',
      kind: 'file',
    });
    // 片段 `.` 也照常排序：名字裡有 `.` 的都相符，前綴相符的那一個排第一。
    expect(await files.list('src/.', signal)).toEqual([
      { path: 'src/.local.ts', kind: 'file' },
      { path: 'src/tui.spec.ts', kind: 'file' },
      { path: 'src/terminal-view.ts', kind: 'file' },
    ]);
  });

  it('不穿越指向根外的符號連結', async () => {
    const root = await workspace();
    await symlink(await outside(), join(root, 'escape'), 'dir');
    const files = search(root);
    const signal = new AbortController().signal;

    expect(await files.list('escape/', signal)).toEqual([]);
    expect(await files.list('escape/outside', signal)).toEqual([]);
    // 索引也不走進去、不列它。
    expect(await files.list('outside', signal)).toEqual([]);
    expect(await files.list('escape', signal)).toEqual([]);
  });

  it('路徑上有符號連結就拒，即使它指回根裡', async () => {
    const root = await workspace();
    await symlink(join(root, 'src'), join(root, 'alias'), 'dir');
    const files = search(root);
    expect(await files.list('alias/', new AbortController().signal)).toEqual([]);
  });

  it('在有上限的索引上照 basename 與子序列排序', async () => {
    const root = await workspace();
    await writeFile(join(root, 'src', 'tspc-helper.ts'), 'helper');
    const files = search(root, { maxResults: 2 });
    const signal = new AbortController().signal;

    expect(await files.list('tspc', signal)).toEqual([
      { path: 'src/tspc-helper.ts', kind: 'file' },
      { path: 'src/tui.spec.ts', kind: 'file' },
    ]);
    expect(await files.list('README.md', signal)).toEqual([{ path: 'README.md', kind: 'file' }]);
    expect(await files.list('terminal', signal)).toEqual([
      { path: 'src/terminal-view.ts', kind: 'file' },
    ]);
    expect(await files.list('secret', signal)).toEqual([]);
    expect(await files.list('.hidden', signal)).toEqual([
      { path: '.hidden', kind: 'directory' },
      { path: '.hidden/secret.txt', kind: 'file' },
    ]);
  });

  it('同分時資料夾在前，再比路徑短', async () => {
    const root = await workspace();
    await mkdir(join(root, 'docs', 'alpha'), { recursive: true });
    await writeFile(join(root, 'src', 'alpha'), 'file');
    await writeFile(join(root, 'alpha'), 'file');
    const files = search(root);
    expect(await files.list('alpha', new AbortController().signal)).toEqual([
      { path: 'docs/alpha', kind: 'directory' },
      { path: 'alpha', kind: 'file' },
      { path: 'src/alpha', kind: 'file' },
    ]);
  });

  it('資料夾加的 25 分只在子序列那一級改得動順序', async () => {
    const root = await workspace();
    await mkdir(join(root, 'qxxz'));
    await writeFile(join(root, 'qxz'), 'file');
    const files = search(root);
    // 檔案的間隔比資料夾少一格（399 對 398），加分讓資料夾排上來（423）。
    expect(await files.list('qz', new AbortController().signal)).toEqual([
      { path: 'qxxz', kind: 'directory' },
      { path: 'qxz', kind: 'file' },
    ]);
  });

  it('失效之後舊的索引照答，替代品建好再換上', async () => {
    const root = await workspace();
    const files = search(root);
    const signal = new AbortController().signal;
    expect(await files.list('fresh-file', signal)).toEqual([]);
    await writeFile(join(root, 'fresh-file.ts'), 'fresh');
    // 沒失效：落定的那次走訪還是答案。
    expect(await files.list('fresh-file', signal)).toEqual([]);
    files.invalidate();
    // 這一次由舊的條目回答，重建在背景跑。
    expect(await files.list('fresh-file', signal)).toEqual([]);
    await vi.waitFor(async () => {
      expect(await files.list('fresh-file', signal)).toEqual([
        { path: 'fresh-file.ts', kind: 'file' },
      ]);
    });
    files.dispose();
    expect(await files.list('fresh-file', signal)).toEqual([]);
    files.dispose();
  });

  it('根讀不到時留著舊的條目，根回來之後再試', async () => {
    const root = await workspace();
    const files = search(root);
    const signal = new AbortController().signal;
    expect(await files.list('README', signal)).toEqual([{ path: 'README.md', kind: 'file' }]);
    const rootReads = () =>
      vi.mocked(readdir).mock.calls.filter(([path]) => String(path) === root).length;
    const initialReads = rootReads();

    // 根在活著的索引底下不見了：讀不到的分支只少掉它自己的候選，但讀不到根不能發布成一個空的工作區。
    await rm(root, { recursive: true, force: true });
    files.invalidate();
    expect(await files.list('README', signal)).toEqual([{ path: 'README.md', kind: 'file' }]);
    await vi.waitFor(async () => {
      expect(await files.list('README', signal)).toEqual([{ path: 'README.md', kind: 'file' }]);
      expect(rootReads()).toBeGreaterThan(initialReads + 1);
    });

    const replacement = await mkdtemp(`${root}-replacement-`);
    roots.push(replacement);
    await writeFile(join(replacement, 'restored.ts'), 'restored');
    await rename(replacement, root);
    await vi.waitFor(async () => {
      expect(await files.list('restored', signal)).toEqual([{ path: 'restored.ts', kind: 'file' }]);
    });
  });

  it('第一次就讀不到根：拒絕，不落定成空的', async () => {
    const root = await workspace();
    await rm(root, { recursive: true, force: true });
    const files = search(root);
    await expect(files.list('README', new AbortController().signal)).rejects.toThrow('ENOENT');
  });

  // chmod 0 只在 POSIX、非 root 時擋得住 readdir。
  it.runIf(process.getuid !== undefined && process.getuid() !== 0)(
    '讀不到的子目錄只少掉它自己的候選',
    async () => {
      const root = await workspace();
      const locked = join(root, 'locked');
      await mkdir(locked, { recursive: true });
      await writeFile(join(locked, 'sealed.ts'), 'sealed');
      await chmod(locked, 0o000);
      locks.push(locked);
      // 量具先驗：這個夾具真的讀不到。沒擋住的話下面那條「找不到 sealed」是別的原因。
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      await expect(actual.readdir(locked)).rejects.toMatchObject({ code: 'EACCES' });
      const files = search(root);
      const signal = new AbortController().signal;

      expect(await files.list('sealed', signal)).toEqual([]);
      expect(await files.list('README', signal)).toEqual([{ path: 'README.md', kind: 'file' }]);
      // 資料夾本身照列：只是讀不進去。
      expect(await files.list('locked', signal)).toEqual([{ path: 'locked', kind: 'directory' }]);
    },
  );

  it('注入的 readdir 失敗也只少掉那一支', async () => {
    const root = await workspace();
    const locked = join(root, 'locked');
    await mkdir(locked, { recursive: true });
    await writeFile(join(locked, 'sealed.ts'), 'sealed');
    fsControl.denyReaddir = locked;
    try {
      const files = search(root);
      const signal = new AbortController().signal;
      expect(await files.list('sealed', signal)).toEqual([]);
      expect(await files.list('README', signal)).toEqual([{ path: 'README.md', kind: 'file' }]);
      expect(await files.list('locked', signal)).toEqual([{ path: 'locked', kind: 'directory' }]);
      expect(await files.list('locked/', signal)).toEqual([]);
    } finally {
      fsControl.denyReaddir = undefined;
    }
  });

  it('守住索引上限', async () => {
    const root = await workspace();
    const capped = search(root, { maxEntries: 2 });
    expect(await capped.list('README', new AbortController().signal)).toEqual([
      { path: 'README.md', kind: 'file' },
    ]);
    // 根那一層照字母排：`.hidden`、`README.md` 兩筆就滿了，`src` 底下的不會進來。
    expect(await capped.list('tui', new AbortController().signal)).toEqual([]);
  });

  it('守住一次的筆數上限：出廠是 20', async () => {
    const root = await workspace();
    for (let index = 0; index < 25; index += 1) {
      await writeFile(join(root, 'docs', `note-${String(index).padStart(2, '0')}.md`), 'x');
    }
    const files = search(root, FILE_SEARCH_DEFAULTS);
    const signal = new AbortController().signal;
    expect(await files.list('note', signal)).toHaveLength(20);
    expect(await files.list('docs/', signal)).toHaveLength(20);
  });

  it('不走排除的建置產物，所以產物分身搶不到原始碼前面', async () => {
    const root = await workspace();
    await mkdir(join(root, 'dist'), { recursive: true });
    await writeFile(join(root, 'dist', 'terminal-view.js'), 'built');
    const files = search(root, { excludedDirectories: [...FILE_SEARCH_EXCLUDED_DIRECTORIES] });
    expect(await files.list('terminal-view', new AbortController().signal)).toEqual([
      { path: 'src/terminal-view.ts', kind: 'file' },
    ]);
    expect(await files.list('dist/', new AbortController().signal)).toEqual([]);
  });

  it('照樣列 `lib`，有些生態的原始碼在那裡', async () => {
    const root = await workspace();
    await mkdir(join(root, 'lib'), { recursive: true });
    await writeFile(join(root, 'lib', 'gem-entry.rb'), 'source');
    const files = search(root, { excludedDirectories: [...FILE_SEARCH_EXCLUDED_DIRECTORIES] });
    expect(await files.list('gem-entry', new AbortController().signal)).toEqual([
      { path: 'lib/gem-entry.rb', kind: 'file' },
    ]);
  });

  it('逐個呼叫者取消、略過不存在的目錄、驗上限', async () => {
    const root = await workspace();
    expect(() => search(root, { maxResults: 0 })).toThrow('maxResults');
    expect(() => search(root, { maxEntries: 1.5 })).toThrow('maxEntries');
    expect(() => search(root, { excludedDirectories: ['nested/name'] })).toThrow('basenames');

    const files = search(root);
    expect(await files.list('missing/', new AbortController().signal)).toEqual([]);

    const preAborted = new AbortController();
    preAborted.abort(new Error('pre-aborted'));
    await expect(files.list('tui', preAborted.signal)).rejects.toThrow('pre-aborted');

    // **第一次裸查詢**才會等走訪；之後的直接拿舊索引答，取消了也看不出差別。
    const running = new AbortController();
    const pending = files.list('tui', running.signal);
    running.abort(new Error('superseded'));
    await expect(pending).rejects.toThrow('superseded');

    const fresh = search(root);
    const nonErrorAbort = new AbortController();
    const nonErrorPending = fresh.list('tui', nonErrorAbort.signal);
    nonErrorAbort.abort('cancelled');
    await expect(nonErrorPending).rejects.toThrow('file search aborted');
  });

  it('一個呼叫者取消，同時等著的另一個照樣拿到答案', async () => {
    const root = await workspace();
    const files = search(root);
    const first = new AbortController();
    const second = new AbortController();
    const cancelled = files.list('tui', first.signal);
    const kept = files.list('tui', second.signal);
    first.abort(new Error('superseded'));
    await expect(cancelled).rejects.toThrow('superseded');
    await expect(kept).resolves.toEqual([{ path: 'src/tui.spec.ts', kind: 'file' }]);
  });
});

describe('listFileReferences：位址翻譯', () => {
  it('開頭的 / 剝掉一個再分派，回來的路徑補回 /', async () => {
    const root = await workspace();
    const files = search(root);
    const signal = new AbortController().signal;
    for (const query of ['sr', '/sr']) {
      expect(await listFileReferences(files, query, signal)).toEqual([
        { path: '/src', kind: 'directory' },
        { path: '/src/tui.spec.ts', kind: 'file' },
        { path: '/src/terminal-view.ts', kind: 'file' },
      ]);
    }
    for (const query of ['', '/']) {
      expect(await listFileReferences(files, query, signal)).toEqual([
        { path: '/docs', kind: 'directory' },
        { path: '/src', kind: 'directory' },
        { path: '/README.md', kind: 'file' },
      ]);
    }
    for (const query of ['src/', '/src/', '\\src\\']) {
      expect(await listFileReferences(files, query, signal)).toEqual([
        { path: '/src/terminal-view.ts', kind: 'file' },
        { path: '/src/tui.spec.ts', kind: 'file' },
      ]);
    }
  });

  it('根外的位址回空：.. 與 ~/ 與多出來的 /', async () => {
    const root = await workspace();
    const files = search(root);
    const signal = new AbortController().signal;
    for (const query of ['../', '/../', '~/', '//', `${root}/`, '/src/../../']) {
      expect(await listFileReferences(files, query, signal)).toEqual([]);
    }
  });

  it('主機絕對路徑剝掉 / 之後是工作區裡的子路徑，不是主機上的檔', async () => {
    const root = await workspace();
    await mkdir(join(root, 'etc'), { recursive: true });
    await writeFile(join(root, 'etc', 'hosts.md'), 'mine');
    const files = search(root);
    expect(await listFileReferences(files, '/etc/', new AbortController().signal)).toEqual([
      { path: '/etc/hosts.md', kind: 'file' },
    ]);
  });
});
