import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readBuildStamp, resolveBuildVersion } from './build-version.js';
import type { GitProbe } from './build-version.js';

/**
 * 建置戳記（#1502 刀 2 寫進產物，刀 1 先讀）：裝好的樹沒有 `.git`，會話 header 的 build 不能是 `null`。
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 在暫存目錄寫一個戳記檔，回路徑。 */
function stampFile(content: string): string {
  const root = mkdtempSync(join(tmpdir(), 'build-stamp-'));
  roots.push(root);
  const path = join(root, 'build-stamp.json');
  writeFileSync(path, content);
  return path;
}

const STAMP = JSON.stringify({ commit: '1234567890abcdef1234567890abcdef12345678', dirty: false });
const NO_GIT: GitProbe = () => undefined;
const OTHER_REPO: GitProbe = (args) =>
  args[0] === 'rev-parse' ? 'ffffffffffffffffffffffffffffffffffffffff\n' : '';

describe('readBuildStamp', () => {
  it('讀得到 commit 與 dirty', () => {
    expect(readBuildStamp(stampFile(STAMP))).toEqual({
      commit: '1234567890abcdef1234567890abcdef12345678',
      dirty: false,
    });
  });

  it('dirty 不是布林就記 null，不猜', () => {
    expect(readBuildStamp(stampFile(JSON.stringify({ commit: 'abc' })))).toEqual({
      commit: 'abc',
      dirty: null,
    });
  });

  it.each([
    ['檔不存在', undefined],
    ['不是 JSON', stampFile('{oops')],
    ['不是物件', stampFile('"abc"')],
    ['沒有 commit', stampFile('{}')],
    ['commit 是空字串', stampFile(JSON.stringify({ commit: '' }))],
    ['commit 不是字串', stampFile(JSON.stringify({ commit: 7 }))],
  ])('%s：回 undefined，不拋', (_name, path) => {
    expect(readBuildStamp(path ?? join(tmpdir(), 'no-such-build-stamp.json'))).toBeUndefined();
  });
});

describe('原始碼樹沒有戳記（戳記只在打包產物裡）', () => {
  it('預設路徑讀不到，resolveBuildVersion 回的是 git HEAD', () => {
    expect(readBuildStamp()).toBeUndefined();
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    expect(resolveBuildVersion().commit).toBe(head);
  });
});

describe('resolveBuildVersion', () => {
  it('拿不到 git 的樹：帶戳記的 commit，不是 null', () => {
    expect(resolveBuildVersion({ stampPath: stampFile(STAMP), probe: NO_GIT })).toEqual({
      commit: '1234567890abcdef1234567890abcdef12345678',
      dirty: false,
    });
  });

  it('戳記優先：安裝目錄剛好在別的 git repo 底下，也不記成那個 repo 的 HEAD', () => {
    expect(resolveBuildVersion({ stampPath: stampFile(STAMP), probe: OTHER_REPO }).commit).toBe(
      '1234567890abcdef1234567890abcdef12345678',
    );
  });

  it('沒有戳記（原始碼樹）：照舊問 git', () => {
    const missing = join(tmpdir(), 'no-such-build-stamp.json');
    expect(resolveBuildVersion({ stampPath: missing, probe: OTHER_REPO })).toEqual({
      commit: 'ffffffffffffffffffffffffffffffffffffffff',
      dirty: false,
    });
  });

  it('戳記壞了也拿不到 git：記 null，不是 "unknown"', () => {
    expect(resolveBuildVersion({ stampPath: stampFile('{oops'), probe: NO_GIT })).toEqual({
      commit: null,
      dirty: null,
    });
  });
});
