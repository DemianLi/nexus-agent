import { mkdtemp, readdir, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { captureFile, mutationPath, sameCapture } from './capture.js';
import { canonicalPath, displayPathOf, durablePathOf, hostPathOf } from './paths.js';

const cleanup: string[] = [];
afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'nexus-wc-capture-'));
  cleanup.push(path);
  return path;
}

describe('mutationPath：哪些呼叫要先擷取', () => {
  it('基座的三顆檔案工具，參數齊了才算', () => {
    expect(mutationPath('write_file', { file_path: '/a.md', content: '' })).toBe('/a.md');
    expect(mutationPath('write_file', { file_path: '/a.md' })).toBeUndefined();
    expect(mutationPath('edit_file', { file_path: 'a.md', old_string: 'x', new_string: 'y' })).toBe(
      'a.md',
    );
    expect(mutationPath('edit_file', { file_path: 'a.md', old_string: 'x' })).toBeUndefined();
    expect(mutationPath('delete', { file_path: '/gone.md' })).toBe('/gone.md');
  });

  it('基座在 schema 前把 `path` 正規化成 `file_path`，所以原始參數兩個名字都認；兩個都給時照基座取 `file_path`', () => {
    expect(mutationPath('delete', { path: '/p.md' })).toBe('/p.md');
    expect(mutationPath('write_file', { path: '/p.md', content: 'x' })).toBe('/p.md');
    expect(mutationPath('delete', { file_path: '  ', path: '/p.md' })).toBeUndefined();
  });

  it('讀檔的、別的工具、空白路徑、不是物件的參數：都不擷取', () => {
    for (const [name, args] of [
      ['read_file', { file_path: '/a.md' }],
      ['ls', { path: '/' }],
      ['write', { file_path: '/a.md', content: 'x' }],
      ['write_file', { file_path: '   ', content: 'x' }],
      ['write_file', null],
      ['write_file', ['/a.md']],
    ] as const) {
      expect(mutationPath(name, args), name).toBeUndefined();
    }
  });
});

describe('captureFile', () => {
  it('缺席、過大、二進位、一般文字；同樣的內容只存一份', async () => {
    const root = await directory();
    const copies = join(root, 'captures');
    expect(await captureFile(join(root, 'none'), copies, 8)).toEqual({ kind: 'absent' });
    await writeFile(join(root, 'big'), '123456789');
    expect(await captureFile(join(root, 'big'), copies, 8)).toEqual({ kind: 'oversized' });
    await writeFile(join(root, 'bin'), Buffer.from([1, 0, 2]));
    expect(await captureFile(join(root, 'bin'), copies, 8)).toMatchObject({
      kind: 'file',
      binary: true,
    });
    await writeFile(join(root, 'one'), 'same');
    await writeFile(join(root, 'two'), 'same');
    const one = await captureFile(join(root, 'one'), copies, 8);
    const two = await captureFile(join(root, 'two'), copies, 8);
    expect(one).toEqual(two);
    expect(sameCapture(one!, two!)).toBe(true);
    // 剛好等於上限的收得下（上限是含的）。
    await writeFile(join(root, 'edge'), '12345678');
    expect(await captureFile(join(root, 'edge'), copies, 8)).toMatchObject({ kind: 'file' });
    expect((await readdir(copies)).length).toBe(3);
  });

  it('目錄不是一般檔案：不擷取', async () => {
    const root = await directory();
    await mkdir(join(root, 'dir'));
    expect(await captureFile(join(root, 'dir'), join(root, 'captures'), 8)).toBeUndefined();
  });

  it('過大的一側永遠不算一樣：沒讀過的內容不能認定沒改', () => {
    expect(sameCapture({ kind: 'oversized' }, { kind: 'oversized' })).toBe(false);
    expect(sameCapture({ kind: 'absent' }, { kind: 'absent' })).toBe(true);
    expect(sameCapture({ kind: 'absent' }, { kind: 'file', file: 'x', binary: false })).toBe(false);
  });
});

describe('路徑', () => {
  it('虛擬路徑對到工作區底下：開頭有沒有 `/` 一樣，`..` 夾回根之內', () => {
    expect(hostPathOf('/w', '/a/b.md')).toBe('/w/a/b.md');
    expect(hostPathOf('/w', 'a/b.md')).toBe('/w/a/b.md');
    expect(hostPathOf('/w', '/../../etc/passwd')).toBe('/w/etc/passwd');
  });

  it('工作區內是相對路徑；經由符號連結指到外面的，顯示成家目錄或絕對路徑', async () => {
    const root = await directory();
    const outside = await directory();
    await symlink(outside, join(root, 'link'));
    const cwd = await canonicalPath(root);
    const target = await canonicalPath(join(root, 'link', 'x.md'));
    expect(durablePathOf(join(cwd, 'a', 'b.md'), cwd)).toBe('a/b.md');
    expect(durablePathOf(target, cwd)).toBe(target);
    expect(displayPathOf(target, cwd, '')).toBe(target);
    expect(displayPathOf(target, cwd, await canonicalPath(outside))).toBe('~/x.md');
  });
});
