/**
 * 發版腳本（`scripts/release/`，[#1502](https://github.com/DemianLi/nexus-agent/issues/1502) 刀 2＋3）的單元紅燈。
 *
 * 規則在真的 repo 上全綠，不代表它擋得住壞掉的那一刻，所以每一條都用手造的最小產物樹跑「好的不報、壞的報」。
 * 真的 `pnpm deploy` 出來的樹由 CI 的 `packed-install` job 驗（`verify-packed-install.ts`）。
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  compareVersions,
  nextVersion,
  replaceManifestVersion,
} from '../../../scripts/release/bump.js';
import { releaseMembers, sharedVersion } from '../../../scripts/release/members.js';
import { fileSha256, productName, sha256Line } from '../../../scripts/release/pack.js';
import {
  collectClosureViolations,
  collectPayloadViolations,
  pruneThirdPartyMaps,
  removeSelfLink,
  shippedNames,
  walkInstalledGraph,
} from '../../../scripts/release/payload.js';
import { assertInputMatches } from '../../../scripts/release/version.js';
import {
  checksumProblems,
  cleanEnv,
  smokeInstalledServe,
  strayProcesses,
} from '../../../scripts/release/verify-packed-install.js';
import { ROOT } from '../../../scripts/workspace-packages.js';

describe('版號', () => {
  it.each([
    ['0.0.0', 'patch', '0.0.1'],
    ['0.3.9', 'minor', '0.4.0'],
    ['1.2.3', 'major', '2.0.0'],
    ['0.1.0', '0.2.0', '0.2.0'],
    ['0.1.0', '0.1.1-rc.1', '0.1.1-rc.1'],
    ['0.1.1-rc.1', '0.1.1', '0.1.1'],
  ])('%s + %s → %s', (current, spec, expected) => {
    expect(nextVersion(current, spec)).toBe(expected);
  });

  it.each([
    ['0.2.0', '0.1.9'],
    ['0.2.0', '0.2.0'],
    ['0.2.0', 'v0.3.0'],
    ['0.2.0', 'big'],
    // prerelease 降版：同一個 x.y.z 加 prerelease 比正式版小；rc.2 → rc.1 也是降版（#1657 審查第 2 項）
    ['0.0.0', '0.0.0-rc.1'],
    ['0.1.0-rc.2', '0.1.0-rc.1'],
    ['0.1.0-rc.1', '0.1.0-rc.1'],
    ['0.1.0', '0.1.0-rc.9'],
  ])('%s → %s 拒收', (current, spec) => {
    expect(() => nextVersion(current, spec)).toThrow();
  });

  it('compareVersions 照 semver 優先序（對照 dsh）', () => {
    const ascending = [
      '0.1.0-alpha',
      '0.1.0-alpha.1',
      '0.1.0-rc.2',
      '0.1.0-rc.10',
      '0.1.0',
      '0.1.1',
    ];
    for (let index = 1; index < ascending.length; index += 1) {
      expect(compareVersions(ascending[index - 1]!, ascending[index]!)).toBeLessThan(0);
      expect(compareVersions(ascending[index]!, ascending[index - 1]!)).toBeGreaterThan(0);
    }
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('只換 version，其餘位元組原樣；真的每份 manifest 換完 JSON 只差 version', () => {
    for (const member of releaseMembers()) {
      const text = readFileSync(join(ROOT, member.manifestPath), 'utf8');
      const next = replaceManifestVersion(text, '9.9.9');
      expect(JSON.parse(next)).toEqual({ ...JSON.parse(text), version: '9.9.9' });
      expect(next.length - text.length).toBe('9.9.9'.length - member.version.length);
    }
  });

  it('發版成員共用同一個版本（根、apps、packages）；vendor 不在內', () => {
    const members = releaseMembers();
    expect(members.map((member) => member.manifestPath)).toContain('package.json');
    expect(members.map((member) => member.manifestPath)).toContain('apps/harness/package.json');
    expect(members.some((member) => member.manifestPath.startsWith('vendor/'))).toBe(false);
    expect(() => sharedVersion(members)).not.toThrow();
  });

  it('有一份版本不同就拒收，訊息列出每一份', () => {
    expect(() =>
      sharedVersion([
        { name: 'a', manifestPath: 'a/package.json', version: '0.1.0' },
        { name: 'b', manifestPath: 'b/package.json', version: '0.2.0' },
      ]),
    ).toThrow(/a\/package.json: 0.1.0[\s\S]*b\/package.json: 0.2.0/u);
  });

  it('Release 輸入只拿來核對：vX.Y.Z 要等於 manifest', () => {
    expect(() => assertInputMatches('v0.1.0', '0.1.0')).not.toThrow();
    expect(() => assertInputMatches('v0.1.1', '0.1.0')).toThrow(/release:bump/u);
    expect(() => assertInputMatches('0.1.0', '0.1.0')).toThrow(/格式/u);
  });
});

describe('出貨清單的 name', () => {
  it('真的 cordis.yml／cordis.serve.yml：每個 - id: 都取得到一個 name', () => {
    for (const file of ['cordis.yml', 'cordis.serve.yml']) {
      const text = readFileSync(join(ROOT, 'apps/harness', file), 'utf8');
      expect(shippedNames(text)).toHaveLength((text.match(/^- id:/gmu) ?? []).length);
    }
  });

  it('套件名、子路徑、#settings 都取；註解與 config 裡更深的 name 不取', () => {
    const text = [
      '# name: ignored',
      '- id: a',
      "  name: '@nexus/plugin-a'",
      '- id: b',
      '  name: "@nexus/core/sub"  # trailing',
      '- id: c',
      "  name: '#settings/x'",
      '  config:',
      '    name: nested',
    ].join('\n');
    expect(shippedNames(text)).toEqual(['@nexus/plugin-a', '@nexus/core/sub', '#settings/x']);
  });

  it('停用的列不取（照 dsh 的 activeBarePluginPackages）；disabled: false 照取', () => {
    const text = [
      '- id: a',
      "  name: '@nexus/plugin-a'",
      '  disabled: true',
      '- id: b',
      "  name: '@nexus/plugin-b'",
      '  disabled: false',
    ].join('\n');
    expect(shippedNames(text)).toEqual(['@nexus/plugin-b']);
  });

  it.each([
    ['根不是陣列', 'id: a\nname: x'],
    ['列不是物件', '- just-a-string'],
    ['group 形狀（group: true）', "- id: g\n  name: '@nexus/g'\n  group: true\n  config: []"],
    [
      'config 是陣列',
      "- id: g\n  name: '@nexus/g'\n  config:\n    - id: c\n      name: '@nexus/c'",
    ],
    ['沒有 name', '- id: a'],
    [
      'disabled 不是布林（dsh 的 __jsExpr 我們不接）',
      "- id: a\n  name: '@nexus/a'\n  disabled:\n    __jsExpr: x",
    ],
  ])('認不得的結構報錯、不跳過：%s', (_label, text) => {
    expect(() => shippedNames(text)).toThrow(/認不得|group|name|disabled/u);
  });
});

describe('sha256', () => {
  let dir: string;
  beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'release-sha-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('一行是「雜湊、兩個空白、檔名」，sha256sum -c 讀得懂', () => {
    expect(sha256Line('ab', 'x.tar.gz')).toBe('ab  x.tar.gz\n');
    expect(productName('0.1.0', 'linux-x64')).toBe('nexus-agent-0.1.0-linux-x64');
  });

  it('對得上不報；改一個位元組、缺檔、檔名不符都報', () => {
    const tarball = join(dir, 'p.tar.gz');
    writeFileSync(tarball, 'payload');
    expect(checksumProblems(tarball)).toEqual(['缺 p.tar.gz.sha256']);
    writeFileSync(`${tarball}.sha256`, sha256Line(fileSha256(tarball), 'p.tar.gz'));
    expect(checksumProblems(tarball)).toEqual([]);
    writeFileSync(tarball, 'payloae');
    expect(checksumProblems(tarball).join()).toMatch(/對不上/u);
    writeFileSync(`${tarball}.sha256`, sha256Line(fileSha256(tarball), 'other.tar.gz'));
    expect(checksumProblems(tarball).join()).toMatch(/檔名/u);
  });
});

/** 一棵最小的、合格的產物樹。 */
function goodTree(root: string): void {
  const put = (path: string, text = '{}'): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  put('package.json', '{"name":"@nexus/harness","version":"0.0.0"}');
  put('build-stamp.json', '{"commit":"abc","dirty":false}');
  put('cordis.yml', '');
  put('cordis.serve.yml', '');
  for (const entry of ['serve', 'cli', 'plugin-cli']) put(`lib/${entry}.js`, '');
  put('node_modules/@nexus/web/dist/index.html', '<div id="root"></div>');
  put('node_modules/.pnpm/@nexus+core@file+x/node_modules/@nexus/core/lib/index.js', '');
  put('node_modules/.pnpm/@nexus+cordis@file+v/node_modules/@nexus/cordis/lib/index.js', '');
  put('node_modules/.pnpm/@nexus+cordis@file+v/node_modules/@nexus/cordis/src/index.ts', '');
  put(
    'node_modules/.pnpm/@deepseek-ai+node-addon-system-linux-x64@0.1.2/node_modules/x/bin/system.node',
    '',
  );
  put('node_modules/.pnpm/zod@4/node_modules/zod/index.js', '');
}

const options = { nativeSuffix: 'linux-x64', vendorNames: ['@nexus/cordis'] };

describe('產物樹的內容檢查', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'release-payload-'));
    goodTree(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const messages = (): string =>
    collectPayloadViolations(root, options)
      .map((v) => `${v.path} ${v.message}`)
      .join('\n');

  it('合格的樹不報（vendor 帶 src/ 放行）', () => {
    expect(collectPayloadViolations(root, options)).toEqual([]);
  });

  it.each([
    ['缺戳記', () => rmSync(join(root, 'build-stamp.json')), /build-stamp\.json/u],
    ['缺入口', () => rmSync(join(root, 'lib/serve.js')), /lib\/serve\.js/u],
    ['缺出貨清單', () => rmSync(join(root, 'cordis.yml')), /cordis\.yml/u],
    ['產物根有 src/', () => mkdirSync(join(root, 'src')), /不收 src/u],
    [
      'workspace 套件帶 src/',
      () =>
        mkdirSync(join(root, 'node_modules/.pnpm/@nexus+core@file+x/node_modules/@nexus/core/src')),
      /@nexus\/core 帶了 src/u,
    ],
    [
      '缺網頁 dist',
      () => rmSync(join(root, 'node_modules/@nexus/web'), { recursive: true }),
      /dist/u,
    ],
    [
      '我們自己的 .map',
      () =>
        writeFileSync(
          join(
            root,
            'node_modules/.pnpm/@nexus+core@file+x/node_modules/@nexus/core/lib/index.js.map',
          ),
          '{}',
        ),
      /不收 \.map/u,
    ],
    [
      '開發工具進閉包',
      () =>
        mkdirSync(join(root, 'node_modules/.pnpm/vitest@4/node_modules/vitest'), {
          recursive: true,
        }),
      /開發工具/u,
    ],
    [
      '缺目標平台二進位',
      () =>
        rmSync(join(root, 'node_modules/.pnpm/@deepseek-ai+node-addon-system-linux-x64@0.1.2'), {
          recursive: true,
        }),
      /node-addon-system-linux-x64/u,
    ],
    ['絕對符號連結', () => symlinkSync('/etc/hosts', join(root, 'abs')), /絕對路徑/u],
    ['斷掉的符號連結', () => symlinkSync('./nowhere', join(root, 'dangling')), /解不開/u],
    [
      '跑出產物外的相對連結',
      () => symlinkSync('../../', join(root, 'node_modules/escape')),
      /產物外面/u,
    ],
  ])('壞的要報：%s', (_label, damage, pattern) => {
    damage();
    expect(messages()).toMatch(pattern);
  });

  it('pruneThirdPartyMaps 只刪第三方的 .map，我們自己的留著讓檢查抓', () => {
    const third = join(root, 'node_modules/.pnpm/zod@4/node_modules/zod/index.js.map');
    const ours = join(
      root,
      'node_modules/.pnpm/@nexus+core@file+x/node_modules/@nexus/core/lib/a.js.map',
    );
    writeFileSync(third, '{}');
    writeFileSync(ours, '{}');
    writeFileSync(join(root, 'node_modules/.pnpm/lock.yaml'), '');
    expect(pruneThirdPartyMaps(root)).toBe(1);
    expect(readdirSync(dirname(third))).not.toContain('index.js.map');
    expect(readdirSync(dirname(ours))).toContain('a.js.map');
  });

  it('removeSelfLink 拿掉指回原始碼樹的 harness 連結，其他東西不動', () => {
    const link = join(root, 'node_modules/.pnpm/node_modules/@nexus/harness');
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync('/somewhere/else/apps/harness', link);
    expect(removeSelfLink(root)).toBe(true);
    expect(removeSelfLink(root)).toBe(false);
  });
});

describe('相依圖', () => {
  let root: string;
  beforeEach(() => void (root = mkdtempSync(join(tmpdir(), 'release-graph-'))));
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const pkg = (dir: string, manifest: object): void => {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, 'package.json'), JSON.stringify(manifest));
  };

  it('完整的圖走得完；optional 的缺席不算，必要的缺席要報並帶鏈', () => {
    pkg('', { name: 'root', dependencies: { a: '1' }, optionalDependencies: { native: '1' } });
    pkg('node_modules/a', { name: 'a', dependencies: { b: '1' } });
    pkg('node_modules/b', { name: 'b' });
    expect(walkInstalledGraph(root)).toEqual({ missing: [], visited: 3 });

    rmSync(join(root, 'node_modules/b'), { recursive: true });
    expect(walkInstalledGraph(root).missing).toEqual(['root -> a -> b']);
  });
});

describe('出貨清單每一列要解析得到', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'release-closure-'));
    const put = (path: string, text: string): void => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    put(
      'package.json',
      '{"name":"h","type":"module","imports":{"#settings/*":"./lib/settings/*.js"}}',
    );
    put('lib/settings/x.js', 'export {};');
    put(
      'node_modules/@nexus/a/package.json',
      '{"name":"@nexus/a","type":"module","exports":{".":"./lib/index.js","./sub":"./lib/sub.js"}}',
    );
    put('node_modules/@nexus/a/lib/index.js', 'export {};');
    put('node_modules/@nexus/a/lib/sub.js', 'export {};');
    put(
      'cordis.yml',
      "- id: a\n  name: '@nexus/a'\n- id: s\n  name: '@nexus/a/sub'\n- id: x\n  name: '#settings/x'\n",
    );
    put('cordis.serve.yml', '');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('套件、子路徑、#settings 都在：不報', () => {
    expect(collectClosureViolations(root)).toEqual([]);
  });

  it.each([
    [
      '套件不在',
      () => rmSync(join(root, 'node_modules/@nexus/a'), { recursive: true }),
      '@nexus/a',
    ],
    [
      '子路徑沒 export',
      () => rmSync(join(root, 'node_modules/@nexus/a/lib/sub.js')),
      '@nexus/a/sub',
    ],
    ['#settings 檔不在', () => rmSync(join(root, 'lib/settings/x.js')), '#settings/x'],
  ])('壞的要報：%s', (_label, damage, name) => {
    damage();
    expect(
      collectClosureViolations(root)
        .map((v) => v.message)
        .join(),
    ).toContain(name);
  });

  it('讀不到任何一列：報（解析規則壞了不能靜靜通過）', () => {
    writeFileSync(join(root, 'cordis.yml'), '');
    expect(collectClosureViolations(root)).toHaveLength(1);
  });
});

describe('verify-packed-install 的環境與收尾（#1657 審查第 4、5 項）', () => {
  let dir: string;
  beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'release-verify-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const withoutPs = async <T>(body: () => T | Promise<T>): Promise<T> => {
    const saved = process.env.PATH;
    process.env.PATH = join(dir, 'no-such-bin');
    try {
      return await body();
    } finally {
      if (saved === undefined) delete process.env.PATH;
      else process.env.PATH = saved;
    }
  };

  it('cleanEnv 清掉遙測與宿主的 node 掛鉤，HOME 指進暫存目錄', () => {
    const saved = { ...process.env };
    process.env.NEXUS_OTLP_LOGS_URL = 'http://example.invalid/logs';
    process.env.NODE_OPTIONS = '--import tsx';
    process.env.NVIDIA_API_KEY = 'real';
    try {
      const env = cleanEnv(dir);
      expect(env.NEXUS_OTLP_LOGS_URL).toBeUndefined();
      expect(env.NODE_OPTIONS).toBeUndefined();
      expect(env.NVIDIA_API_KEY).toBe('verify-fake-key');
      expect(env.HOME).toBe(dir);
    } finally {
      for (const key of ['NEXUS_OTLP_LOGS_URL', 'NODE_OPTIONS', 'NVIDIA_API_KEY']) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });

  it('ps 不存在：strayProcesses 回 problem，不拋錯', async () => {
    const result = await withoutPs(() => strayProcesses(dir));
    expect(result.lines).toEqual([]);
    expect(result.problem).toMatch(/ps 沒跑成/u);
  });

  it('ps 不存在時 smokeInstalledServe 仍記成 problem，且 serve 子行程被收掉（不留孤兒）', async () => {
    const root = join(dir, 'root');
    mkdirSync(join(root, 'lib'), { recursive: true });
    const pidFile = join(dir, 'serve.pid');
    writeFileSync(
      join(root, 'lib/serve.js'),
      [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
        "console.log('nexus-agent 在 http://127.0.0.1:1/login?token=x');",
        "console.log('plugin：fake');",
        "process.on('SIGTERM', () => process.exit(0));",
        'setInterval(() => {}, 1000);',
      ].join('\n'),
    );
    const problems = await withoutPs(() => smokeInstalledServe(root, dir, { ...process.env }, dir));
    expect(problems.join('\n')).toMatch(/ps 沒跑成/u);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/u);
  }, 30_000);
});
