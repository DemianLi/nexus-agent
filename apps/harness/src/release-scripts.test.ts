/**
 * 發版腳本（`scripts/release/`，[#1502](https://github.com/DemianLi/nexus-agent/issues/1502) 刀 2＋3、
 * [#1545](https://github.com/DemianLi/nexus-agent/issues/1545) 的授權檔與 SBOM）的單元紅燈。
 *
 * 規則在真的 repo 上全綠，不代表它擋得住壞掉的那一刻，所以每一條都用手造的最小產物樹跑「好的不報、壞的報」。
 * 真的 `pnpm deploy` 出來的樹由 CI 的 `packed-install` job 驗（`verify-packed-install.ts`）。
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  compareVersions,
  nextVersion,
  replaceManifestVersion,
} from '../../../scripts/release/bump.js';
import { releaseMembers, sharedVersion } from '../../../scripts/release/members.js';
import { fileSha256, productName, sha256Line } from '../../../scripts/release/pack.js';
import {
  BUNDLED_LICENSE_TEXTS,
  SBOM_FILE,
  collectClosureViolations,
  collectPayloadViolations,
  pruneThirdPartyMaps,
  pruneUnlinkedStoreEntries,
  removeSelfLink,
  shippedNames,
  walkInstalledGraph,
} from '../../../scripts/release/payload.js';
import {
  buildSbom,
  cycloneDxLicense,
  integrityToHashes,
  licenseProblems,
  listInstalledPackages,
  npmPurl,
  renderSbom,
  repoLicense,
  sbomProblems,
  walkClosure,
} from '../../../scripts/release/sbom.js';
import { assertInputMatches } from '../../../scripts/release/version.js';
import {
  attachedSbomProblems,
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

/**
 * 網頁打包的三顆字型的 OFL 全文（#1713）。刻意寫死、不引 `payload.ts` 的常數：那邊少列一份，這裡的「少一份就紅」要跟著紅。
 */
const FONT_LICENSES = ['Geist-OFL.txt', 'GeistMono-OFL.txt', 'NotoSansTC-OFL.txt'];

/** 一棵最小的、合格的產物樹。 */
function goodTree(root: string): void {
  const put = (path: string, text = '{}'): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  put('package.json', '{"name":"@nexus/harness","version":"0.0.0","license":"MIT"}');
  put('build-stamp.json', '{"commit":"abc","dirty":false}');
  put('LICENSE', 'MIT License');
  put('THIRD_PARTY_NOTICES.md', '# 第三方授權');
  for (const file of BUNDLED_LICENSE_TEXTS) put(file, 'GNU');
  put(SBOM_FILE, '{}');
  put('cordis.yml', '');
  put('cordis.serve.yml', '');
  for (const entry of ['serve', 'cli', 'plugin-cli']) put(`lib/${entry}.js`, '');
  put('node_modules/@nexus/web/dist/index.html', '<div id="root"></div>');
  for (const file of FONT_LICENSES) put(`node_modules/@nexus/web/dist/assets/fonts/${file}`, 'OFL');
  put('node_modules/.pnpm/@nexus+core@file+x/node_modules/@nexus/core/lib/index.js', '');
  put('node_modules/.pnpm/@nexus+cordis@file+v/node_modules/@nexus/cordis/lib/index.js', '');
  put('node_modules/.pnpm/@nexus+cordis@file+v/node_modules/@nexus/cordis/src/index.ts', '');
  put(
    'node_modules/.pnpm/@deepseek-ai+node-addon-system-linux-x64@0.1.2/node_modules/x/bin/system.node',
    '',
  );
  put('node_modules/.pnpm/zod@4/node_modules/zod/index.js', '');
  // 內附 ripgrep（#1502 刀 4）：本體加目標平台的平台套件，rg 要有執行權限。
  put('node_modules/.pnpm/@vscode+ripgrep@1.18.0/node_modules/@vscode/ripgrep/lib/index.js', '');
  put(RG_BINARY, '');
  chmodSync(join(root, RG_BINARY), 0o755);
}

const RG_BINARY =
  'node_modules/.pnpm/@vscode+ripgrep-linux-x64@1.18.0/node_modules/@vscode/ripgrep-linux-x64/bin/rg';

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

  it('產物 manifest 就是 apps/harness/package.json，它宣告 MIT', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { license?: unknown };
    expect(manifest.license).toBe('MIT');
  });

  it.each<[string, () => void, RegExp]>([
    ['缺戳記', () => rmSync(join(root, 'build-stamp.json')), /build-stamp\.json/u],
    ['缺 LICENSE', () => rmSync(join(root, 'LICENSE')), /^LICENSE 產物缺這個檔/mu],
    [
      '缺第三方授權清單',
      () => rmSync(join(root, 'THIRD_PARTY_NOTICES.md')),
      /THIRD_PARTY_NOTICES\.md 產物缺這個檔/u,
    ],
    ['缺 SBOM', () => rmSync(join(root, SBOM_FILE)), /sbom\.cdx\.json 產物缺這個檔/u],
    ...BUNDLED_LICENSE_TEXTS.map(
      (file) =>
        [
          `缺 libvips 要附的授權全文 ${file}`,
          () => rmSync(join(root, file)),
          new RegExp(`^${file.replace('.', '\\.')} 產物缺這個檔`, 'mu'),
        ] as [string, () => void, RegExp],
    ),
    // 期望值寫死 MIT、不引產品常數（照 dsh `build-python-release.py:256-259`）。
    [
      'manifest 沒有 license',
      () => writeFileSync(join(root, 'package.json'), '{"name":"@nexus/harness"}'),
      /^package\.json 產物 manifest 的 license 是 undefined，應為 MIT$/mu,
    ],
    [
      'manifest 的 license 不是 MIT',
      () => writeFileSync(join(root, 'package.json'), '{"license":"Apache-2.0"}'),
      /^package\.json 產物 manifest 的 license 是 "Apache-2\.0"，應為 MIT$/mu,
    ],
    ...FONT_LICENSES.map(
      (file) =>
        [
          `缺字型的 OFL 全文 ${file}`,
          () => rmSync(join(root, `node_modules/@nexus/web/dist/assets/fonts/${file}`)),
          new RegExp(`fonts/${file.replace('.', '\\.')} 網頁打包的字型缺 OFL`, 'u'),
        ] satisfies [string, () => void, RegExp],
    ),
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
    [
      '缺內附 ripgrep 本體',
      () =>
        rmSync(join(root, 'node_modules/.pnpm/@vscode+ripgrep@1.18.0'), {
          recursive: true,
        }),
      /缺 @vscode\/ripgrep（/u,
    ],
    [
      '缺目標平台的內附 ripgrep',
      () =>
        rmSync(join(root, 'node_modules/.pnpm/@vscode+ripgrep-linux-x64@1.18.0'), {
          recursive: true,
        }),
      /缺目標平台的 @vscode\/ripgrep-linux-x64/u,
    ],
    [
      '內附的只有別的平台（darwin 的不算 linux 的）',
      () => {
        rmSync(join(root, 'node_modules/.pnpm/@vscode+ripgrep-linux-x64@1.18.0'), {
          recursive: true,
        });
        mkdirSync(
          join(
            root,
            'node_modules/.pnpm/@vscode+ripgrep-darwin-arm64@1.18.0/node_modules/@vscode/ripgrep-darwin-arm64/bin',
          ),
          { recursive: true },
        );
      },
      /缺目標平台的 @vscode\/ripgrep-linux-x64（找到：@vscode\+ripgrep-darwin-arm64@1\.18\.0）/u,
    ],
    ['內附的 rg 執行檔不在', () => rmSync(join(root, RG_BINARY)), /內附的 rg 執行檔不在/u],
    [
      '內附的 rg 沒有執行權限',
      () => chmodSync(join(root, RG_BINARY), 0o644),
      /內附的 rg 沒有執行權限/u,
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

  it('pruneUnlinkedStoreEntries 只拿掉沒有連結指進去的項目，連帶只被它指著的也拿掉', () => {
    const tree = mkdtempSync(join(tmpdir(), 'release-prune-'));
    const store = join(tree, 'node_modules/.pnpm');
    const entry = (name: string, pkg: string): string => {
      const directory = join(store, name, 'node_modules', pkg);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: pkg }));
      return directory;
    };
    const link = (from: string, to: string): void => {
      mkdirSync(dirname(from), { recursive: true });
      symlinkSync(relative(dirname(from), to), from);
    };
    const sharp = entry('sharp@1', 'sharp');
    link(join(tree, 'node_modules/sharp'), sharp);
    // 只被 hoist 目錄指著的也算有人連（Node 從 `.pnpm/node_modules` 解析得到）。
    link(join(store, 'node_modules/undici-types'), entry('undici-types@7', 'undici-types'));
    // tslib 沒有任何連結；emnapi 沒有連結、只連到 wasm，wasm 只被 emnapi 指著：三個都要拿掉。
    entry('tslib@2', 'tslib');
    const wasm = entry('wasm@1', 'wasm');
    link(join(entry('emnapi@1', 'emnapi'), '..', 'wasm'), wasm);

    try {
      expect(pruneUnlinkedStoreEntries(tree)).toEqual(['emnapi@1', 'tslib@2', 'wasm@1']);
      expect(readdirSync(store).sort()).toEqual(['node_modules', 'sharp@1', 'undici-types@7']);
      expect(pruneUnlinkedStoreEntries(tree)).toEqual([]);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
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

describe('SBOM（#1545 步驟 4、驗收 6）', () => {
  let root: string;
  beforeEach(() => void (root = mkdtempSync(join(tmpdir(), 'release-sbom-'))));
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const sri = (text: string): string =>
    `sha512-${createHash('sha512').update(text).digest('base64')}`;
  const hex = (text: string): string => createHash('sha512').update(text).digest('hex');

  /** 照 `pnpm deploy` 的 isolated 佈局：套件裝在 `.pnpm/<項目>/node_modules/<名字>`，其餘都是相對連結。 */
  const install = (entry: string, manifest: { name: string } & Record<string, unknown>): string => {
    const directory = join(root, 'node_modules/.pnpm', entry, 'node_modules', manifest.name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest));
    return directory;
  };
  const link = (from: string, to: string): void => {
    mkdirSync(dirname(from), { recursive: true });
    symlinkSync(relative(dirname(from), to), from);
  };

  // 根 → a（第三方）→ native-linux（只掛在 a 的 optionalDependencies，像平台二進位套件）；根 → @nexus/core（自己的、沒宣告 license）。
  const lockfile = [
    'lockfileVersion: "9.0"',
    'packages:',
    '  a@1.0.0:',
    `    resolution: {integrity: ${sri('a')}}`,
    '  native-linux@2.0.0:',
    `    resolution: {integrity: ${sri('native')}}`,
    '',
  ].join('\n');

  beforeEach(() => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: '@nexus/harness',
        version: '1.0.0',
        dependencies: { a: '1.0.0', '@nexus/core': 'workspace:*' },
      }),
    );
    const a = install('a@1.0.0', {
      name: 'a',
      version: '1.0.0',
      license: 'MIT',
      optionalDependencies: { 'native-linux': '2.0.0' },
    });
    const native = install('native-linux@2.0.0', {
      name: 'native-linux',
      version: '2.0.0',
      license: '(MIT OR Apache-2.0)',
    });
    const core = install('@nexus+core@file+packages+core', {
      name: '@nexus/core',
      version: '0.0.0',
    });
    link(join(root, 'node_modules/a'), a);
    link(join(root, 'node_modules/@nexus/core'), core);
    link(join(root, 'node_modules/.pnpm/a@1.0.0/node_modules/native-linux'), native);
    writeFileSync(join(root, 'node_modules/.pnpm/lock.yaml'), lockfile);
  });

  it('從閉包產生：只掛在 optionalDependencies 的套件也收；第三方帶 hex 雜湊，自己的不帶、授權取 repo 的', () => {
    const bom = buildSbom(root, { firstPartyLicense: 'MIT' });
    expect(bom.metadata.component).toMatchObject({
      type: 'application',
      group: '@nexus',
      name: 'harness',
      purl: 'pkg:npm/%40nexus/harness@1.0.0',
    });
    expect(bom.components.map((entry) => entry.purl)).toEqual([
      'pkg:npm/%40nexus/core@0.0.0',
      'pkg:npm/a@1.0.0',
      'pkg:npm/native-linux@2.0.0',
    ]);
    const [core, a, native] = bom.components;
    expect(core).toMatchObject({ licenses: [{ license: { id: 'MIT' } }] });
    expect(core).not.toHaveProperty('hashes');
    expect(a).toMatchObject({ hashes: [{ alg: 'SHA-512', content: hex('a') }] });
    expect(native).toMatchObject({
      licenses: [{ expression: '(MIT OR Apache-2.0)' }],
      hashes: [{ alg: 'SHA-512', content: hex('native') }],
    });
    // 位元組穩定：同一個閉包產兩次相同。
    expect(renderSbom(buildSbom(root, { firstPartyLicense: 'MIT' }))).toBe(renderSbom(bom));
  });

  it('同一個 name@version 有兩個 peer 變體目錄：只收一份，bom-ref 唯一', () => {
    // 根 → b → a 的另一個 peer 變體（另一個目錄、同一個 a@1.0.0），像 lockfile 裡 deepagents@1.13.1 的兩份。
    const twin = install('a@1.0.0_peer@1.0.0', { name: 'a', version: '1.0.0', license: 'MIT' });
    const b = install('b@1.0.0', {
      name: 'b',
      version: '1.0.0',
      license: 'MIT',
      dependencies: { a: '1.0.0' },
    });
    link(join(root, 'node_modules/.pnpm/b@1.0.0/node_modules/a'), twin);
    link(join(root, 'node_modules/b'), b);
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: '@nexus/harness',
        version: '1.0.0',
        dependencies: { a: '1.0.0', b: '1.0.0', '@nexus/core': 'workspace:*' },
      }),
    );
    // 前提：依目錄走，a@1.0.0 真的走到兩次。
    expect(walkClosure(root).filter((pkg) => pkg.name === 'a')).toHaveLength(2);

    const bom = buildSbom(root, {
      firstPartyLicense: 'MIT',
      lockfile: `${lockfile}  b@1.0.0:\n    resolution: {integrity: ${sri('b')}}\n`,
    });
    const refs = bom.components.map((entry) => entry['bom-ref']);
    expect(refs).toEqual([
      'pkg:npm/%40nexus/core@0.0.0',
      'pkg:npm/a@1.0.0',
      'pkg:npm/b@1.0.0',
      'pkg:npm/native-linux@2.0.0',
    ]);
  });

  it('只寫在 peerDependenciesMeta 的選用 peer 裝在閉包裡也收（sharp 的 @types/node），SBOM 跟閉包相同', () => {
    // 根 → sharp；sharp 的 manifest 只有 `peerDependenciesMeta`（沒有 `peerDependencies`），pnpm 照樣把 @types/node 連到它底下。
    const types = install('@types+node@24.0.0', {
      name: '@types/node',
      version: '24.0.0',
      license: 'MIT',
    });
    const sharp = install('sharp@0.35.5_@types+node@24.0.0', {
      name: 'sharp',
      version: '0.35.5',
      license: 'Apache-2.0',
      peerDependenciesMeta: { '@types/node': { optional: true } },
    });
    link(
      join(root, 'node_modules/.pnpm/sharp@0.35.5_@types+node@24.0.0/node_modules/@types/node'),
      types,
    );
    link(join(root, 'node_modules/sharp'), sharp);
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: '@nexus/harness',
        version: '1.0.0',
        dependencies: { a: '1.0.0', sharp: '0.35.5', '@nexus/core': 'workspace:*' },
      }),
    );
    const bom = buildSbom(root, {
      firstPartyLicense: 'MIT',
      lockfile: `${lockfile}  sharp@0.35.5:\n    resolution: {integrity: ${sri('sharp')}}\n  '@types/node@24.0.0':\n    resolution: {integrity: ${sri('types')}}\n`,
    });
    expect(bom.components.map((entry) => entry.purl)).toContain('pkg:npm/%40types/node@24.0.0');
    writeFileSync(join(root, SBOM_FILE), renderSbom(bom));
    expect(sbomProblems(root)).toEqual([]);
  });

  it('閉包的授權：寬鬆的、OFL 字型、sharp 的 libvips（LGPL）不報；其他非寬鬆的要報', () => {
    const entry = (name: string, license: string) => {
      const slash = name.startsWith('@') ? name.indexOf('/') : -1;
      return {
        ...(slash > 0 ? { group: name.slice(0, slash), name: name.slice(slash + 1) } : { name }),
        version: '1.0.0',
        licenses: [{ expression: license }],
      };
    };
    expect(
      licenseProblems({
        components: [
          entry('a', 'MIT'),
          entry('@fontsource-variable/geist', 'OFL-1.1'),
          entry('@img/sharp-libvips-linux-x64', 'LGPL-3.0-or-later'),
        ],
      }),
    ).toEqual([]);
    expect(
      licenseProblems({
        components: [
          entry('copyleft', 'LGPL-3.0-or-later'),
          entry('@img/sharp-libvips-linux-x64', 'GPL-3.0-only'),
          entry('font', 'OFL-1.1'),
        ],
      }),
    ).toEqual([
      expect.stringContaining('copyleft@1.0.0'),
      expect.stringContaining('@img/sharp-libvips-linux-x64@1.0.0'),
      expect.stringContaining('font@1.0.0'),
    ]);
  });

  it('docs/operations.md〈核對安裝內容〉第 3、4 步原樣在夾具上跑：一致印顆數、0 結束；漏一顆就列出來、1 結束', () => {
    const doc = readFileSync(join(ROOT, 'docs/operations.md'), 'utf8');
    const block = /<!-- verify-install:start -->([\s\S]*?)<!-- verify-install:end -->/u.exec(
      doc,
    )?.[1];
    const step = (n: number): string => {
      const script = new RegExp(
        `^# ${String(n)}\\.[^\\n]*\\n(?:cd [^\\n]*\\n)?node -e '([^']*)'`,
        'mu',
      ).exec(block ?? '')?.[1];
      if (script === undefined) throw new Error(`文件裡找不到第 ${String(n)} 步的 node -e`);
      return script;
    };
    const run = (script: string) =>
      spawnSync(process.execPath, ['-e', script], { cwd: root, encoding: 'utf8' });

    const bom = buildSbom(root, { firstPartyLicense: 'MIT' });
    writeFileSync(join(root, SBOM_FILE), renderSbom(bom));
    expect(run(step(3)).stdout.split('\n')).toContain('a@1.0.0\tMIT');
    const same = run(step(4));
    expect([same.status, same.stdout.trim()]).toEqual([0, '一致：4 顆']);

    writeFileSync(
      join(root, SBOM_FILE),
      renderSbom({
        ...bom,
        components: bom.components.filter((entry) => entry.name !== 'native-linux'),
      }),
    );
    const missing = run(step(4));
    expect([missing.status, missing.stdout.trim()]).toEqual([
      1,
      'SBOM 漏了：native-linux@2.0.0\nSBOM 多了：',
    ]);
  });

  it('核對用的列法不走相依圖：列 .pnpm 裡實際裝了的，加上根', () => {
    expect([...listInstalledPackages(root)].sort()).toEqual([
      '@nexus/core@0.0.0',
      '@nexus/harness@1.0.0',
      'a@1.0.0',
      'native-linux@2.0.0',
    ]);
  });

  it('SBOM 與閉包相同不報；漏一顆、多一顆都報', () => {
    const bom = buildSbom(root, { firstPartyLicense: 'MIT' });
    writeFileSync(join(root, SBOM_FILE), renderSbom(bom));
    expect(sbomProblems(root)).toEqual([]);

    // 產生器漏了 optional 那一支的樣子：平台套件不在 SBOM 裡。
    writeFileSync(
      join(root, SBOM_FILE),
      renderSbom({
        ...bom,
        components: bom.components.filter((entry) => entry.name !== 'native-linux'),
      }),
    );
    expect(sbomProblems(root)).toEqual(['SBOM 漏了閉包裡的 native-linux@2.0.0']);

    const [, a] = bom.components;
    if (a === undefined) throw new Error('夾具少了 a');
    writeFileSync(
      join(root, SBOM_FILE),
      renderSbom({ ...bom, components: [...bom.components, { ...a, version: '9.9.9' }] }),
    );
    expect(sbomProblems(root)).toEqual(['SBOM 列了閉包裡沒有的 a@9.9.9']);

    rmSync(join(root, SBOM_FILE));
    expect(sbomProblems(root)).toEqual([`缺 ${SBOM_FILE}`]);
  });

  it('第三方在閉包 lockfile 裡查不到 integrity：拋錯，不靜靜省略', () => {
    expect(() =>
      buildSbom(root, {
        firstPartyLicense: 'MIT',
        lockfile: lockfile.split('  native-linux')[0] ?? '',
      }),
    ).toThrow(/native-linux@2\.0\.0 在閉包的 lockfile 裡查不到 integrity/u);
  });

  it('第三方沒有 license 或不是合法的 SPDX：拋錯', () => {
    expect(() => cycloneDxLicense(undefined, 'x@1')).toThrow(/沒有字串 license/u);
    expect(() => cycloneDxLicense('SEE LICENSE IN LICENSE.md', 'x@1')).toThrow(/不是合法的 SPDX/u);
    expect(cycloneDxLicense('Apache-2.0', 'x@1')).toEqual({ license: { id: 'Apache-2.0' } });
    // CycloneDX 的 id 只收 SPDX 清單上的值：LicenseRef 放 name。
    expect(cycloneDxLicense('LicenseRef-Proprietary', 'x@1')).toEqual({
      license: { name: 'LicenseRef-Proprietary' },
    });
    expect(cycloneDxLicense('GPL-2.0-or-later WITH Classpath-exception-2.0', 'x@1')).toEqual({
      expression: 'GPL-2.0-or-later WITH Classpath-exception-2.0',
    });
  });

  it('integrity 轉 hex；認不得的演算法拋錯', () => {
    expect(integrityToHashes(sri('a'))).toEqual([{ alg: 'SHA-512', content: hex('a') }]);
    expect(() => integrityToHashes('md5-AAAA')).toThrow(/認不得的 integrity/u);
    expect(npmPurl('@scope/x', '1.0.0')).toBe('pkg:npm/%40scope/x@1.0.0');
  });

  it('repo 根 LICENSE 認得是 MIT；換了授權要先教它', () => {
    expect(repoLicense(readFileSync(join(ROOT, 'LICENSE'), 'utf8'))).toBe('MIT');
    expect(() => repoLicense('Apache License\n')).toThrow(/認不得/u);
  });

  it('Release 要附的那份：要在、對得上 .sha256、與產物裡的相同', () => {
    writeFileSync(join(root, SBOM_FILE), '{"a":1}\n');
    const tarball = join(root, 'nexus-agent-1.0.0-linux-x64.tar.gz');
    const attached = join(root, 'nexus-agent-1.0.0-linux-x64.cdx.json');
    expect(attachedSbomProblems(tarball, root)).toEqual([
      '缺 nexus-agent-1.0.0-linux-x64.cdx.json（Release 要附的 SBOM）',
    ]);
    writeFileSync(attached, '{"a":1}\n');
    writeFileSync(`${attached}.sha256`, sha256Line(fileSha256(attached), basename(attached)));
    expect(attachedSbomProblems(tarball, root)).toEqual([]);
    writeFileSync(join(root, SBOM_FILE), '{"a":2}\n');
    expect(attachedSbomProblems(tarball, root)).toEqual([
      `nexus-agent-1.0.0-linux-x64.cdx.json 與產物裡的 ${SBOM_FILE} 不同`,
    ]);
  });
});
