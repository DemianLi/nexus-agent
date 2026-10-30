/**
 * rg 的讀根（#1946）。清單是不是夠，由 `sandbox-spawner.integration.test.ts` 對著 rg 的輸出驗。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ripgrepReadRoots } from './ripgrep-sandbox.js';

describe('ripgrepReadRoots', () => {
  let base: string;
  let home: string;
  let repo: string;
  let ws: string;

  const put = (path: string, text = ''): void => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
  };

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'nexus-rg-roots-'));
    home = join(base, 'home');
    repo = join(base, 'repo');
    ws = join(repo, 'sub');
    mkdirSync(ws, { recursive: true });
    mkdirSync(home);
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('工作區、rg 本身，與真的存在的祖先忽略檔；不給 home 底下別的檔', async () => {
    put(join(repo, '.gitignore'));
    put(join(repo, '.rgignore'));
    put(join(home, '.env'), 'NVIDIA_API_KEY=x');
    mkdirSync(join(repo, '.ignore'));
    const rg = join(base, 'rg');
    put(rg);
    const roots = await ripgrepReadRoots(ws, rg, { HOME: home });
    expect(roots.slice(0, 2)).toEqual([ws, rg]);
    expect(roots).toContain(join(repo, '.gitignore'));
    expect(roots).toContain(join(repo, '.rgignore'));
    expect(roots).not.toContain(join(repo, '.ignore'));
    expect(roots).not.toContain(home);
    expect(roots).not.toContain(join(home, '.env'));
  });

  it('全域設定逐檔給：兩份設定檔、它們指到的檔，~ 展開成 HOME', async () => {
    put(join(home, '.gitconfig'), '[core]\n\texcludesFile = ~/my-ignore\n');
    put(join(home, 'my-ignore'));
    put(join(home, '.config/git/ignore'));
    put(join(base, 'xdg/git/config'), '[core]\n  ExcludesFile = "/nope"\n');
    const plain = await ripgrepReadRoots(ws, '/rg', { HOME: home });
    expect(plain).toContain(join(home, '.gitconfig'));
    expect(plain).toContain(join(home, 'my-ignore'));
    expect(plain).toContain(join(home, '.config/git/ignore'));
    const xdg = await ripgrepReadRoots(ws, '/rg', {
      HOME: home,
      XDG_CONFIG_HOME: join(base, 'xdg'),
    });
    expect(xdg).toContain(join(base, 'xdg/git/config'));
    expect(xdg).not.toContain(join(home, '.config/git/ignore'));
  });

  it('最近的 repo 的 info/exclude；更外層的 repo 不給', async () => {
    put(join(repo, '.git/info/exclude'));
    put(join(base, '.git/info/exclude'));
    const roots = await ripgrepReadRoots(ws, '/rg', {});
    expect(roots).toContain(join(repo, '.git/info/exclude'));
    expect(roots).not.toContain(join(base, '.git/info/exclude'));
    expect(roots).not.toContain(join(repo, '.git/config'));
  });

  it('.git 是 worktree 的指標檔：順著 gitdir 與 commondir 找到 info/exclude', async () => {
    const main = join(base, 'main/.git');
    const linked = join(main, 'worktrees/w');
    put(join(linked, 'commondir'), '../..\n');
    put(join(main, 'info/exclude'));
    put(join(ws, '.git'), `gitdir: ${linked}\n`);
    const roots = await ripgrepReadRoots(ws, '/rg', {});
    expect(roots).toContain(join(ws, '.git'));
    expect(roots).toContain(join(linked, 'commondir'));
    expect(roots).toContain(join(main, 'info/exclude'));
  });

  it('起點與 rg 不存在時不列：要照它們自己的原因失敗，不是沙箱不可用', async () => {
    expect(await ripgrepReadRoots(join(base, 'gone'), join(base, 'no-rg'), {})).toEqual([]);
  });
});
