/**
 * `scripts/release/verify-packed-install.ts` 執行期那一半（步驟 3 到 6）的單元紅燈
 * （[#1666](https://github.com/DemianLi/nexus-agent/issues/1666)，#1657 的已知缺口）。
 *
 * 這一半原本只有 CI 的 `packed-install` job 護著：哪天有人把某一步的判斷寫錯、`problems.push` 漏掉，job 照樣綠。
 * 所以每一步的判斷抽成輸入是子行程結果、輸出是 problems 的純函式，這裡每一步至少一格「壞輸入 → 有 problem」，
 * 另外一格好輸入 → 空陣列，免得判斷寫成永遠報。
 * 環境清理、`ps` 缺席、`SIGTERM` 收尾見 `release-scripts.test.ts`。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cliRunProblems,
  headerProblems,
  homepageProblems,
  nativeLockProblems,
  serveOutputProblems,
  shutdownProblems,
  smokeInstalledServe,
  stampProblems,
  versionProblems,
} from '../../../scripts/release/verify-packed-install.js';

const ok = { status: 0, stdout: '', stderr: '' };

describe('步驟 3：--version', () => {
  it('印出產物版本、stderr 空：不報', () => {
    expect(versionProblems({ ...ok, stdout: '1.2.3\n' }, '1.2.3')).toEqual([]);
  });

  it('版本不對、非 0 退出、stderr 不空：各自報', () => {
    expect(versionProblems({ ...ok, stdout: '1.2.4\n' }, '1.2.3')).toHaveLength(1);
    expect(versionProblems({ status: 1, stdout: '1.2.3\n', stderr: '' }, '1.2.3')).toHaveLength(1);
    expect(versionProblems({ status: null, stdout: '1.2.3\n', stderr: '' }, '1.2.3')).toHaveLength(
      1,
    );
    expect(versionProblems({ ...ok, stdout: '1.2.3\n', stderr: 'warn' }, '1.2.3')).toEqual([
      expect.stringMatching(/stderr 不是空的/u),
    ]);
  });
});

describe('步驟 4：flock 原生二進位', () => {
  it('印 locked：不報；載不起來、印別的：報並帶 stderr 尾巴', () => {
    expect(nativeLockProblems({ ...ok, stdout: 'locked\n' })).toEqual([]);
    expect(nativeLockProblems({ status: 1, stdout: '', stderr: 'ERR_DLOPEN_FAILED' })).toEqual([
      expect.stringContaining('ERR_DLOPEN_FAILED'),
    ]);
    expect(nativeLockProblems({ ...ok, stdout: 'nope' })).toHaveLength(1);
  });
});

describe('戳記本身', () => {
  it('commit 非空字串、dirty 是 false：不報', () => {
    expect(stampProblems({ commit: 'abc', dirty: false })).toEqual([]);
  });

  it('dirty 是 true、缺、或不是布林：報；commit 空或不是字串：報', () => {
    expect(stampProblems({ commit: 'abc', dirty: true })).toEqual([
      expect.stringMatching(/dirty 要是 false/u),
    ]);
    expect(stampProblems({ commit: 'abc' })).toHaveLength(1);
    expect(stampProblems({ commit: 'abc', dirty: 'no' })).toHaveLength(1);
    expect(stampProblems({ commit: '', dirty: false })).toHaveLength(1);
    expect(stampProblems({ commit: 5, dirty: false })).toHaveLength(1);
  });

  it('--allow-dirty 只放行 dirty: true，不放行缺欄位或亂值', () => {
    expect(stampProblems({ commit: 'abc', dirty: true }, { allowDirty: true })).toEqual([]);
    expect(stampProblems({ commit: 'abc' }, { allowDirty: true })).toHaveLength(1);
    expect(stampProblems({ commit: 'abc', dirty: 'yes' }, { allowDirty: true })).toHaveLength(1);
    expect(stampProblems({ commit: '', dirty: true }, { allowDirty: true })).toHaveLength(1);
  });

  it('戳記檔不在：這裡不報（payload 檢查報「產物缺這個檔」）', () => {
    expect(stampProblems(undefined)).toEqual([]);
  });
});

describe('步驟 5：假模型跑一輪與會話 header', () => {
  it('cli 非 0 退出：報；0：不報', () => {
    expect(cliRunProblems(ok)).toEqual([]);
    expect(cliRunProblems({ status: 2, stdout: '', stderr: 'boom' })).toEqual([
      expect.stringContaining('boom'),
    ]);
  });

  const stamp = { commit: 'aaa', dirty: false };

  it('header 的 commit 等於戳記：不報；給了 expectCommit 也相等：不報', () => {
    expect(headerProblems({ build: { commit: 'aaa' } }, stamp)).toEqual([]);
    expect(headerProblems({ build: { commit: 'aaa' } }, stamp, 'aaa')).toEqual([]);
  });

  it('沒有 header 檔：報', () => {
    expect(headerProblems(undefined, stamp)).toEqual(['cli 跑完沒有 cli.header.json']);
  });

  it('header 的 commit 是 null 或別的值：報（跟戳記比）', () => {
    expect(headerProblems({ build: { commit: null } }, stamp).length).toBeGreaterThan(0);
    expect(headerProblems({ build: {} }, stamp).length).toBeGreaterThan(0);
    expect(headerProblems({ build: { commit: 'bbb' } }, stamp).length).toBeGreaterThan(0);
  });

  it('戳記被拿掉時兩邊同時不見：給了 expectCommit 才抓得到', () => {
    expect(headerProblems({ build: { commit: null } }, undefined, 'aaa')).toEqual([
      expect.stringMatching(/打包的 commit/u),
    ]);
    expect(headerProblems({ build: { commit: null } }, undefined)).toEqual([
      expect.stringMatching(/無從比對/u),
    ]);
  });

  it('header 等於 CI 給的打包 commit、但不等於產物自己的戳記：報（戳記被換掉）', () => {
    expect(headerProblems({ build: { commit: 'ccc' } }, stamp, 'ccc')).toEqual([
      expect.stringMatching(/不等於戳記的 aaa/u),
    ]);
  });

  it('header 等於戳記、但不等於 CI 給的打包 commit：報', () => {
    expect(headerProblems({ build: { commit: 'aaa' } }, stamp, 'ccc')).toEqual([
      expect.stringMatching(/打包的 commit/u),
    ]);
  });
});

describe('步驟 6：serve', () => {
  it('有網址、沒有載不起來：不報', () => {
    expect(
      serveOutputProblems('nexus-agent 在 http://127.0.0.1:1/?token=x\nplugin：echo', 'u'),
    ).toEqual([]);
  });

  it('沒印出網址：報並帶輸出尾巴', () => {
    expect(serveOutputProblems('啟動失敗 xyz', undefined)).toEqual([
      expect.stringContaining('啟動失敗 xyz'),
    ]);
  });

  it('有插件載不起來（serve 只印警告照常起）：報', () => {
    expect(serveOutputProblems('plugin 某某 載不起來：ERR_MODULE_NOT_FOUND', 'u')).toEqual([
      expect.stringMatching(/有插件載不進來/u),
    ]);
  });

  const index = '<html><div id="root"></div></html>';

  it('303＋cookie＋首頁 200 且像 index：不報', () => {
    expect(homepageProblems({ status: 303, cookie: 'c=1' }, { status: 200, body: index })).toEqual(
      [],
    );
    expect(
      homepageProblems(
        { status: 303, cookie: 'c=1' },
        { status: 200, body: '<script type="module" src="/a.js"></script>' },
      ),
    ).toEqual([]);
  });

  it('token 交換不是 303、或沒有 cookie：報', () => {
    expect(homepageProblems({ status: 401, cookie: undefined }, undefined)).toEqual([
      expect.stringMatching(/token 交換失敗/u),
    ]);
    expect(homepageProblems({ status: 303, cookie: undefined }, undefined)).toHaveLength(1);
  });

  it('首頁 404、或 200 但不是網頁 index：報', () => {
    expect(homepageProblems({ status: 303, cookie: 'c=1' }, { status: 404, body: index })).toEqual([
      expect.stringMatching(/首頁回 404/u),
    ]);
    expect(
      homepageProblems({ status: 303, cookie: 'c=1' }, { status: 200, body: 'Not Found' }),
    ).toEqual([expect.stringMatching(/不像網頁 index/u)]);
  });

  it('SIGTERM 後 exit 0：不報；非 0 或被訊號殺（null）：報', () => {
    expect(shutdownProblems(0, '')).toEqual([]);
    expect(shutdownProblems(1, 'x')).toHaveLength(1);
    expect(shutdownProblems(null, 'x')).toHaveLength(1);
  });
});

describe('smokeInstalledServe 逾時送 SIGKILL 給整個行程群組', () => {
  let dir: string;
  beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'verify-pgroup-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it('serve 忽略 SIGTERM 又起了子行程：逾時被殺之後，子行程也不見', async () => {
    const root = join(dir, 'root');
    mkdirSync(join(root, 'lib'), { recursive: true });
    const grandchildPid = join(dir, 'grandchild.pid');
    writeFileSync(
      join(root, 'lib/serve.js'),
      [
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        `writeFileSync(${JSON.stringify(grandchildPid)}, String(g.pid));`,
        "process.on('SIGTERM', () => {});",
        'setInterval(() => {}, 1000);',
      ].join('\n'),
    );
    const problems = await smokeInstalledServe(root, dir, { ...process.env }, dir, {
      startupMs: 1_500,
      terminateMs: 500,
    });
    // serve 沒印網址、被 SIGKILL 殺掉（exit null），這兩條都要現形。
    expect(problems.join('\n')).toMatch(/serve 沒印出網址/u);
    expect(problems.join('\n')).toMatch(/SIGTERM 後 exit null/u);
    expect(existsSync(grandchildPid)).toBe(true);
    const pid = Number(readFileSync(grandchildPid, 'utf8'));
    // 孤兒被 init 收養後還要一點時間才會消失：等到 3 秒。
    const deadline = Date.now() + 3_000;
    while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const stillAlive = alive(pid);
    if (stillAlive) process.kill(pid, 'SIGKILL'); // 失敗時也別留下孤兒
    expect(stillAlive).toBe(false);
  }, 30_000);
});
