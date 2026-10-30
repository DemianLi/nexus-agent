/**
 * `scripts/release/verify-packed-install.ts` 執行期那一半（步驟 3 到 6）的單元紅燈
 * （[#1666](https://github.com/DemianLi/nexus-agent/issues/1666)，#1657 的已知缺口）。
 *
 * 這一半原本只有 CI 的 `packed-install` job 護著：哪天有人把某一步的判斷寫錯、`problems.push` 漏掉，job 照樣綠。
 * 所以每一步的判斷抽成輸入是子行程結果、輸出是 problems 的純函式，這裡每一步至少一格「壞輸入 → 有 problem」，
 * 另外一格好輸入 → 空陣列，免得判斷寫成永遠報。
 * 環境清理、`ps` 缺席、`SIGTERM` 收尾見 `release-scripts.test.ts`。
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  bundledRgProblems,
  cliRunProblems,
  headerProblems,
  homepageProblems,
  installedGrepProblems,
  nativeLockProblems,
  ripgrepDisclosureProblems,
  serveOutputProblems,
  SHARP_PROBE,
  SHARP_PROBE_LIMIT,
  sharpProblems,
  shutdownProblems,
  smokeInstalledServe,
  stampProblems,
  versionProblems,
} from '../../../scripts/release/verify-packed-install.js';
import { spawnerProbeProblems } from '../../../scripts/release/spawner-probe.js';
import { isAlive, readPidFile, signalPid } from './test-pids.fixture.js';

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

describe('步驟 4d：sharp 在產物裡縮得了圖', () => {
  const good = { width: SHARP_PROBE_LIMIT, height: 1365, space: 'srgb', format: 'jpeg' };

  it('長邊等於上限、sRGB、JPEG：不報', () => {
    expect(sharpProblems({ ...ok, stdout: JSON.stringify(good) })).toEqual([]);
  });

  it('載不起來、沒縮、色彩空間或格式不對、印的不是 JSON：各自報', () => {
    expect(
      sharpProblems({ status: 1, stdout: '', stderr: 'Could not load the "sharp" module' }),
    ).toEqual([expect.stringContaining('sharp')]);
    expect(
      sharpProblems({ ...ok, stdout: JSON.stringify({ ...good, width: 3000, height: 2000 }) }),
    ).toHaveLength(1);
    expect(
      sharpProblems({ ...ok, stdout: JSON.stringify({ ...good, space: 'cmyk' }) }),
    ).toHaveLength(1);
    expect(
      sharpProblems({ ...ok, stdout: JSON.stringify({ ...good, format: 'png' }) }),
    ).toHaveLength(1);
    expect(sharpProblems({ ...ok, stdout: 'not json' })).toHaveLength(1);
  });

  it('探針本身在 repo 裝好的 sharp 上跑得通：判斷函式收它的輸出不報', () => {
    const run = spawnSync(process.execPath, ['--input-type=module', '--eval', SHARP_PROBE], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(sharpProblems(run)).toEqual([]);
  });
});

describe('步驟 4b：內附 ripgrep 在 PATH 上沒有 rg 的環境裡跑得起來', () => {
  it('印出 ripgrep 版本：不報；跑不起來、印別的：報並帶 stderr 尾巴', () => {
    expect(bundledRgProblems({ ...ok, stdout: 'ripgrep 15.1.0\n' })).toEqual([]);
    expect(
      bundledRgProblems({ status: 1, stdout: '', stderr: "Cannot find package '@vscode/ripgrep'" }),
    ).toEqual([expect.stringContaining('@vscode/ripgrep')]);
    expect(bundledRgProblems({ ...ok, stdout: 'FAIL spawn ENOENT' })).toHaveLength(1);
    expect(bundledRgProblems({ status: null, stdout: '', stderr: '' })).toHaveLength(1);
  });
});

describe('步驟 4e：產物裡的沙箱 spawner 起得來、經它起得了主機的 git', () => {
  const ready = { type: 'ready', filterInsns: 77, landlockAbi: 6 } as const;
  const started = { type: 'started', id: 1, pid: 16, partial: false } as const;
  const exited = { type: 'exited', id: 1, code: 0, signal: 0 } as const;
  const ok = { events: [ready, started, exited], stdout: 'git version 2.39.5\n', stderr: '' };

  it('Ready、Started、Exited 0、印出版本：沒有 problem', () => {
    expect(spawnerProbeProblems(ok)).toEqual([]);
  });

  it.each([
    ['中途出錯', { ...ok, error: '等第一筆事件逾時' }],
    ['spawner 起不來', { ...ok, events: [{ type: 'unavailable', errno: 22, detail: 'seccomp' }] }],
    ['沒有任何事件', { ...ok, events: [] }],
    ['主機沒有 Landlock', { ...ok, events: [{ ...ready, landlockAbi: 0 }] }],
    [
      'git 沒起成',
      {
        ...ok,
        events: [ready, { type: 'failed', id: 1, kind: 'exec', errno: 13, detail: 'exec' }],
      },
    ],
    ['git 沒正常結束', { ...ok, events: [ready, started, { ...exited, code: 128 }] }],
    ['只有 Started', { ...ok, events: [ready, started] }],
    ['結局是別的 id 的', { ...ok, events: [ready, { ...started, id: 2 }, { ...exited, id: 2 }] }],
    ['stdout 不是版本', { ...ok, stdout: '' }],
  ] as const)('%s：有一條 problem', (_, outcome) => {
    expect(spawnerProbeProblems(outcome)).toHaveLength(1);
  });
});

describe('步驟 4c：安裝樹裡真的跑一次 grep', () => {
  const hit =
    '{"type":"tool","data":{"content":"/a.txt:\\n  2: needle-1502 here","name":"grep","status":"success"}}';

  it('這一輪成功、日誌有 grep 的結果且命中工作區的檔：不報', () => {
    expect(installedGrepProblems(ok, hit)).toEqual([]);
  });

  it('這一輪非 0 退出：報並帶 stderr', () => {
    expect(installedGrepProblems({ status: 1, stdout: '', stderr: 'boom' }, hit)).toEqual([
      expect.stringContaining('boom'),
    ]);
    expect(installedGrepProblems({ status: null, stdout: '', stderr: '' }, hit)).toHaveLength(1);
  });

  it('沒有會話日誌、或日誌裡沒有 grep 的結果：報', () => {
    expect(installedGrepProblems(ok, undefined)).toEqual([expect.stringMatching(/沒有會話日誌/u)]);
    expect(installedGrepProblems(ok, '{"type":"ai"}')).toEqual([
      expect.stringMatching(/沒有 grep 的工具結果/u),
    ]);
  });

  it('grep 跑了但沒命中（搜尋走了別的、或回了錯誤）：報', () => {
    const miss = '{"type":"tool","data":{"content":"Error: grep could not start","name":"grep"}}';
    expect(installedGrepProblems(ok, miss)).toEqual([expect.stringMatching(/沒有命中/u)]);
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
  describe('grep 用哪一支 ripgrep（啟動日誌那一行，#1502 驗收 6）', () => {
    const root = '/var/tmp/verify-x/extract/nexus-agent-1.0.0-linux-x64';

    it('路徑在安裝樹底下：不報', () => {
      const line = `搜尋（grep）：內附 ripgrep ${root}/node_modules/.pnpm/@vscode+ripgrep-linux-x64@1.18.0/node_modules/@vscode/ripgrep-linux-x64/bin/rg`;
      expect(ripgrepDisclosureProblems(`plugin：echo\n${line}\n網頁：x`, root)).toEqual([]);
    });

    /**
     * #1534：serve 的日誌每行帶「時間 [等級] 名字 」前綴，整行不再以「搜尋（grep）」開頭。驗證腳本先剝前綴再比；
     * 拿掉 `ripgrepDisclosureProblems` 裡的 `.map(serverLogBody)` 這一條會紅（CI 的 packed-install 曾因此紅）。
     */
    it('帶伺服器日誌前綴的那一行（有時間、沒有時間）：照樣認得，路徑在安裝樹底下不報', () => {
      const path = `${root}/node_modules/.pnpm/@vscode+ripgrep-linux-x64@1.18.0/node_modules/@vscode/ripgrep-linux-x64/bin/rg`;
      const body = `搜尋（grep）：內附 ripgrep ${path}`;
      expect(
        ripgrepDisclosureProblems(
          `2026-10-19 17:33:16 [I] serve plugin：echo\n2026-10-19 17:33:16 [I] serve ${body}`,
          root,
        ),
      ).toEqual([]);
      expect(ripgrepDisclosureProblems(`[I] serve ${body}`, root)).toEqual([]);
    });

    it('帶前綴的「不可用」與「宿主的 rg」兩種問題仍報（剝前綴不能把壞的也放過去）', () => {
      expect(
        ripgrepDisclosureProblems(
          '2026-10-19 17:33:16 [I] serve 搜尋（grep）：內附 ripgrep 不可用（x 不存在）',
          root,
        ),
      ).toEqual([expect.stringContaining('不可用')]);
      expect(
        ripgrepDisclosureProblems(
          '2026-10-19 17:33:16 [I] serve 搜尋（grep）：內附 ripgrep /usr/bin/rg',
          root,
        ),
      ).toEqual([expect.stringMatching(/不在安裝樹/u)]);
    });

    it('沒有這一行（啟動路徑少了披露）：報', () => {
      expect(ripgrepDisclosureProblems('plugin：echo\n網頁：x', root)).toEqual([
        expect.stringMatching(/沒有 grep 用哪一支 ripgrep/u),
      ]);
    });

    it('內附的不可用（缺了或沒有執行權限）：報並帶那一行', () => {
      const line =
        '搜尋（grep）：內附 ripgrep 不可用（x 不存在）；每一次 grep 都會以 SEARCH_FAILED 失敗，沒有退路';
      expect(ripgrepDisclosureProblems(line, root)).toEqual([expect.stringContaining('不可用')]);
    });

    it('安裝樹根是 symlink（macOS 的 /var/tmp）：路徑是 realpath 寫法也不報', () => {
      const real = mkdtempSync(join(tmpdir(), 'rg-real-'));
      const link = `${real}-link`;
      symlinkSync(real, link);
      try {
        const line = `搜尋（grep）：內附 ripgrep ${realpathSync(real)}/node_modules/@vscode/ripgrep-linux-x64/bin/rg`;
        expect(ripgrepDisclosureProblems(line, link)).toEqual([]);
        // 反例：根不存在時只認字面寫法，realpath 那一格不能丟例外。
        expect(ripgrepDisclosureProblems(line, `${real}-missing`)).toHaveLength(1);
      } finally {
        rmSync(link, { force: true });
        rmSync(real, { recursive: true, force: true });
      }
    });

    it('路徑跑到安裝樹外面（用的是宿主的 rg）：報；前綴相同的兄弟目錄也算外面', () => {
      expect(ripgrepDisclosureProblems('搜尋（grep）：內附 ripgrep /usr/bin/rg', root)).toEqual([
        expect.stringMatching(/不在安裝樹/u),
      ]);
      expect(
        ripgrepDisclosureProblems(`搜尋（grep）：內附 ripgrep ${root}-evil/bin/rg`, root),
      ).toHaveLength(1);
    });
  });

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

  const alive = isAlive;

  it('serve 忽略 SIGTERM 又起了子行程：逾時被殺之後，子行程也不見', async () => {
    const root = join(dir, 'root');
    mkdirSync(join(root, 'lib'), { recursive: true });
    const grandchildPid = join(dir, 'grandchild.pid');
    writeFileSync(
      join(root, 'lib/serve.js'),
      [
        "import { spawn } from 'node:child_process';",
        "import { renameSync, writeFileSync } from 'node:fs';",
        "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        `writeFileSync(${JSON.stringify(grandchildPid)} + '.tmp', String(g.pid)); renameSync(${JSON.stringify(grandchildPid)} + '.tmp', ${JSON.stringify(grandchildPid)});`,
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
    const pid = await readPidFile(grandchildPid);
    // 孤兒被 init 收養後還要一點時間才會消失：等到 3 秒。
    const deadline = Date.now() + 3_000;
    while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const stillAlive = alive(pid);
    if (stillAlive) signalPid(pid, 'SIGKILL'); // 失敗時也別留下孤兒
    expect(stillAlive).toBe(false);
  }, 30_000);
  // verify 自己被中斷（終端機 Ctrl-C、CI 取消）時，離開了前景群組的 serve 與它的子行程不能留下來。
  it.each(['SIGINT', 'SIGTERM'] as const)(
    '對跑著 smokeInstalledServe 的行程送 %s：serve 與孫行程都消失、暫存目錄收掉、行程被同一個訊號結束',
    async (signal) => {
      const root = join(dir, 'root');
      mkdirSync(join(root, 'lib'), { recursive: true });
      const servePid = join(dir, 'serve.pid');
      const grandchildPid = join(dir, 'grandchild.pid');
      writeFileSync(
        join(root, 'lib/serve.js'),
        [
          "import { spawn } from 'node:child_process';",
          "import { renameSync, writeFileSync } from 'node:fs';",
          "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
          `writeFileSync(${JSON.stringify(grandchildPid)} + '.tmp', String(g.pid)); renameSync(${JSON.stringify(grandchildPid)} + '.tmp', ${JSON.stringify(grandchildPid)});`,
          `writeFileSync(${JSON.stringify(servePid)} + '.tmp', String(process.pid)); renameSync(${JSON.stringify(servePid)} + '.tmp', ${JSON.stringify(servePid)});`,
          "process.on('SIGTERM', () => {});",
          'setInterval(() => {}, 1000);',
        ].join('\n'),
      );
      const scratch = join(dir, 'scratch');
      mkdirSync(scratch);
      const verifyModule = join(
        dirname(fileURLToPath(import.meta.url)),
        '../../../scripts/release/verify-packed-install.ts',
      );
      const runner = join(dir, 'runner.mts');
      writeFileSync(
        runner,
        [
          `import { smokeInstalledServe } from ${JSON.stringify(verifyModule)};`,
          `await smokeInstalledServe(${JSON.stringify(root)}, ${JSON.stringify(dir)}, { ...process.env }, ${JSON.stringify(scratch)}, { startupMs: 60_000, terminateMs: 60_000 });`,
          "console.log('smoke 正常結束（不該走到這裡）');",
        ].join('\n'),
      );
      const runnerProc = spawn(process.execPath, ['--import', 'tsx', runner], {
        cwd: join(dirname(fileURLToPath(import.meta.url)), '../../..'),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let log = '';
      runnerProc.stdout.on('data', (c: Buffer) => (log += c.toString('utf8')));
      runnerProc.stderr.on('data', (c: Buffer) => (log += c.toString('utf8')));
      const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
        runnerProc.once('exit', (code, sig) => resolve({ code, signal: sig })),
      );
      let serve = 0;
      let grandchild = 0;
      try {
        const ready = Date.now() + 30_000;
        while (Date.now() < ready && !(existsSync(servePid) && existsSync(grandchildPid))) {
          await new Promise((r) => setTimeout(r, 50));
        }
        expect(existsSync(servePid) && existsSync(grandchildPid), log).toBe(true);
        serve = await readPidFile(servePid);
        grandchild = await readPidFile(grandchildPid);
        expect(alive(serve) && alive(grandchild)).toBe(true);
        runnerProc.kill(signal);
        const result = await ended;
        // 照原本的訊號結束，不是靜靜變成 exit 0。
        expect(result.signal, log).toBe(signal);
        const gone = Date.now() + 3_000;
        while ((alive(serve) || alive(grandchild)) && Date.now() < gone) {
          await new Promise((r) => setTimeout(r, 50));
        }
        expect(alive(serve)).toBe(false);
        expect(alive(grandchild)).toBe(false);
        expect(existsSync(scratch)).toBe(false);
      } finally {
        for (const pid of [serve, grandchild]) if (pid > 1 && alive(pid)) signalPid(pid, 'SIGKILL');
        if (runnerProc.exitCode === null && runnerProc.signalCode === null)
          runnerProc.kill('SIGKILL');
      }
    },
    60_000,
  );
});
