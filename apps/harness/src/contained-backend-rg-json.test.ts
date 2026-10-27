/**
 * `grep` 解 `rg --json` 的輸出（[#1942](https://github.com/DemianLi/nexus-agent/issues/1942)）：壞掉的輸出整次判 `SEARCH_FAILED`，
 * 不回半份結果；行不是 UTF-8 時換成佔位字串。
 *
 * 假 rg 是一支 `cat` 指定內容的腳本，stdout 一字不差由測試決定。
 */

import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SEARCH_FAILED } from '@nexus/core';

import { ContainedFilesystemBackend } from './contained-backend.js';
import type { GrepPathsResult } from './contained-backend.js';

let base: string;
let root: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'nexus-rg-json-'));
  root = join(base, 'ws');
  await mkdir(root);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** 從工作區根搜，交出 `errorCode`（`grep` 只留 `error`）。 */
class Probe extends ContainedFilesystemBackend {
  search(pattern: string): Promise<GrepPathsResult> {
    return this.grepPaths(pattern, ['/']);
  }
}

/** 一支假 rg：stdout 是 `lines` 各接一個換行，stderr 是 `stderr`，以 `exit` 結束。 */
async function fakeRg(lines: readonly string[], stderr = '', exit = 0): Promise<string> {
  const out = join(base, 'stdout.txt');
  const err = join(base, 'stderr.txt');
  await writeFile(out, lines.map((line) => `${line}\n`).join(''));
  await writeFile(err, stderr);
  const file = join(base, 'fake-rg.sh');
  await writeFile(file, `#!/bin/sh\ncat '${out}'\ncat '${err}' >&2\nexit ${String(exit)}\n`);
  await chmod(file, 0o755);
  return file;
}

const match = (data: unknown): string => JSON.stringify({ type: 'match', data });

describe('壞掉的 `rg --json` 輸出：整次 SEARCH_FAILED', () => {
  it.each([
    ['一行不是 JSON', 'not json at all', 'a line is not JSON'],
    ['紀錄不是物件', '42', 'a record is not an object'],
    ['match 紀錄沒有 data', JSON.stringify({ type: 'match' }), 'a match record has no data'],
    [
      'match 紀錄的 path 沒有 text',
      match({ path: {}, lines: { text: 'x' }, line_number: 1 }),
      'a match record has no path text',
    ],
    [
      'match 紀錄的 path 不是物件',
      match({ path: 'a.ts', lines: { text: 'x' }, line_number: 1 }),
      'a match record has no path text',
    ],
    [
      'match 紀錄沒有行號',
      match({ path: { text: 'a.ts' }, lines: { text: 'x' } }),
      'a match record has no line number',
    ],
    [
      'match 紀錄沒有行內容',
      match({ path: { text: 'a.ts' }, line_number: 1 }),
      'a match record has no line content',
    ],
    [
      'match 紀錄的行內容既沒有 text 也沒有 bytes',
      match({ path: { text: 'a.ts' }, lines: {}, line_number: 1 }),
      'a match record has neither line text nor bytes',
    ],
  ])('%s', async (_label, line, detail) => {
    const good = match({ path: { text: 'ok.ts' }, lines: { text: 'x\n' }, line_number: 1 });
    const backend = new Probe({
      rootDir: root,
      ripgrep: { executable: await fakeRg([good, line]) },
    });

    expect(await backend.search('x')).toEqual({
      error: `grep received malformed ripgrep --json output (${detail})`,
      errorCode: SEARCH_FAILED,
    });
  });

  it('結束碼 2、stderr 只有「讀不到」、stdout 有一行壞的：照樣判錯，不放行', async () => {
    const executable = await fakeRg(
      ['not json at all'],
      'rg: ./locked.txt: Permission denied (os error 13)\n',
      2,
    );
    const backend = new Probe({ rootDir: root, ripgrep: { executable }, tolerateUnreadable: true });

    expect(await backend.search('x')).toEqual({
      error: 'grep received malformed ripgrep --json output (a line is not JSON)',
      errorCode: SEARCH_FAILED,
    });
  });
});

describe('完好的輸出', () => {
  it('其他種類的紀錄略過；行不是 UTF-8（只有 bytes）換成佔位字串', async () => {
    const executable = await fakeRg([
      JSON.stringify({ type: 'begin', data: { path: { text: './a.ts' } } }),
      match({ path: { text: './a.ts' }, lines: { text: 'needle\n' }, line_number: 3 }),
      match({ path: { text: './b.bin' }, lines: { bytes: '/w==' }, line_number: 7 }),
      JSON.stringify({ type: 'end', data: {} }),
      JSON.stringify({ type: 'summary', data: {} }),
    ]);
    const backend = new ContainedFilesystemBackend({ rootDir: root, ripgrep: { executable } });

    expect(await backend.grep('needle', '/')).toEqual({
      matches: [
        { path: '/a.ts', line: 3, text: 'needle' },
        { path: '/b.bin', line: 7, text: '(line is not valid UTF-8)' },
      ],
    });
  });
});
