/**
 * 第三方元件清單（`scripts/gen-third-party-notices.ts`，[#1545](https://github.com/DemianLi/nexus-agent/issues/1545)）的
 * 新鮮度與規則紅燈。照 dsh（687f282e）`scripts/gen-third-party-notices.spec.ts`：新鮮度放在測試裡，不另開 job。
 *
 * 新鮮度那格真的跑一次網頁的 vite build（`write: false`），而 import 圖看不到「改了某顆插件的 `package.json`」這種異動，
 * 所以 `.github/scripts/plan_ci.py` 把含 `gen-third-party-notices` 字樣的測試列進必跑集合。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  OUT,
  assertRuntimeLicenses,
  cssBareImportsIn,
  isPermissive,
  normalizeRepo,
  parseVendoredRows,
  render,
  tierExternalDeps,
  type Manifest,
} from '../../../scripts/gen-third-party-notices.js';
import { ROOT } from '../../../scripts/workspace-packages.js';

describe('THIRD_PARTY_NOTICES.md', () => {
  it('進版控的內容等於從今天的 manifest 重新產生的', { timeout: 120_000 }, async () => {
    const generated = await render();
    // 網頁打包的套件（含 CSS 帶進來的）在執行期那層，不在開發那層。
    const [runtime] = generated.split('## 只在開發時用的 npm 相依');
    expect(runtime).toContain('| [`react`]');
    expect(runtime).toContain('| [`tailwindcss`]');
    expect(runtime).toContain('| [`@fontsource-variable/geist`]');
    expect(runtime).toContain('## 網頁的字型');
    expect(
      readFileSync(join(ROOT, OUT), 'utf8'),
      '清單過期：跑 `pnpm run gen-third-party-notices`',
    ).toBe(generated);
  });
});

function workspace(entries: Record<string, Manifest>): {
  manifests: Map<string, Manifest>;
  names: Set<string>;
} {
  const manifests = new Map(Object.entries(entries));
  const names = new Set<string>();
  for (const manifest of manifests.values())
    if (manifest.name !== undefined) names.add(manifest.name);
  return { manifests, names };
}

describe('執行期授權', () => {
  it('執行期塞一顆 GPL-3.0 的相依：產生失敗並點名', () => {
    const { manifests, names } = workspace({
      'packages/nexus-plugin-x/package.json': {
        name: '@nexus/plugin-x',
        dependencies: { 'copyleft-lib': '^1' },
      },
    });
    const tiers = tierExternalDeps(manifests, names);
    const deps = [{ name: 'copyleft-lib', license: 'GPL-3.0' }].filter((dep) =>
      tiers.get(dep.name),
    );
    expect(deps).toHaveLength(1);
    expect(() => assertRuntimeLicenses(deps)).toThrow('copyleft-lib（GPL-3.0）');
    expect(() => assertRuntimeLicenses([{ name: 'copyleft-lib', license: 'MIT' }])).not.toThrow();
  });

  it('OFL 字型的例外只限審過的三個套件名、而且授權剛好是 OFL-1.1（照 dsh spec :56-75）', () => {
    for (const name of [
      '@fontsource-variable/geist',
      '@fontsource-variable/geist-mono',
      '@fontsource-variable/noto-sans-tc',
    ]) {
      expect(() => assertRuntimeLicenses([{ name, license: 'OFL-1.1' }])).not.toThrow();
      expect(() => assertRuntimeLicenses([{ name, license: 'GPL-3.0-only' }])).toThrow(name);
    }
    for (const dependency of [
      { name: 'unrelated-font', license: 'OFL-1.1' },
      { name: '@fontsource/geist', license: 'OFL-1.1' },
      { name: '@fontsource-variable/geist-unreviewed', license: 'OFL-1.1' },
      { name: '@fontsource-variable/geist', license: 'OFL-1.1-RFN' },
      { name: '@fontsource-variable/geist', license: 'UNKNOWN' },
    ]) {
      expect(() => assertRuntimeLicenses([dependency])).toThrow(
        `${dependency.name}（${dependency.license}）`,
      );
    }
    expect(isPermissive('OFL-1.1')).toBe(false);
  });

  it('開發那層的授權不擋', () => {
    const { manifests, names } = workspace({
      'package.json': { devDependencies: { 'lint-tool': '^1' } },
      'apps/web/package.json': { name: '@nexus/web', devDependencies: { 'test-tool': '^1' } },
    });
    expect([...tierExternalDeps(manifests, names)]).toEqual([
      ['lint-tool', false],
      ['test-tool', false],
    ]);
  });
});

describe('isPermissive（照 dsh spec :369-399）', () => {
  it('收這個專案出貨的授權，拒絕 copyleft 與認不得的', () => {
    for (const license of ['MIT', 'ISC', 'Apache-2.0', 'BSD-3-Clause', '0BSD', 'BlueOak-1.0.0']) {
      expect(isPermissive(license), license).toBe(true);
    }
    for (const license of [
      'GPL-3.0-only',
      'LGPL-2.1',
      'MPL-2.0',
      'AGPL-3.0',
      'UNLICENSED',
      'SEE LICENSE IN LICENSE',
      '',
    ]) {
      expect(isPermissive(license), license).toBe(false);
    }
  });

  it('AND 每一支都要合格：copyleft 不能搭便車', () => {
    expect(isPermissive('MIT AND Apache-2.0')).toBe(true);
    expect(isPermissive('MIT AND GPL-3.0-only')).toBe(false);
  });

  it('OR 有一支合格就合格，括號與優先序照 SPDX，斜線當 OR', () => {
    expect(isPermissive('(MIT OR GPL-3.0-only)')).toBe(true);
    expect(isPermissive('GPL-3.0-only OR MIT AND Apache-2.0')).toBe(true);
    expect(isPermissive('(GPL-3.0-only OR MIT) AND LGPL-2.1')).toBe(false);
    expect(isPermissive('MIT / Apache-2.0')).toBe(true);
  });

  it('解不開、帶 + 或 WITH 的一律不合格', () => {
    for (const license of [
      '(MIT',
      'MIT)',
      'MIT AND',
      'OR MIT',
      'Apache-2.0+',
      'Apache-2.0 WITH LLVM-exception',
    ]) {
      expect(isPermissive(license), license).toBe(false);
    }
  });
});

describe('tierExternalDeps', () => {
  it('依宣告的區域分層：根 manifest 一律是開發用，插件的 dependencies 是執行期', () => {
    const { manifests, names } = workspace({
      'package.json': { dependencies: { 'root-runtime-looking': '^1' } },
      'packages/nexus-plugin-mcp/package.json': {
        name: '@nexus/plugin-mcp',
        dependencies: { 'protocol-sdk': '^1', '@nexus/core': 'workspace:*' },
        devDependencies: { 'fixture-server': '^1' },
        optionalDependencies: { 'native-bin': '^1' },
      },
      'packages/nexus-core/package.json': { name: '@nexus/core' },
    });
    expect(tierExternalDeps(manifests, names)).toEqual(
      new Map([
        ['root-runtime-looking', false],
        ['protocol-sdk', true],
        ['fixture-server', false],
        ['native-bin', true],
      ]),
    );
  });

  it('網頁打包的開發相依算執行期；打包了卻沒人宣告就錯', () => {
    const { manifests, names } = workspace({
      'apps/web/package.json': {
        name: '@nexus/web',
        devDependencies: { react: '^19', 'type-only': '^1' },
      },
    });
    expect(tierExternalDeps(manifests, names, new Set(['react']))).toEqual(
      new Map([
        ['react', true],
        ['type-only', false],
      ]),
    );
    expect(() => tierExternalDeps(manifests, names, new Set(['missing-lib']))).toThrow(
      'missing-lib',
    );
  });
});

describe('cssBareImportsIn', () => {
  const installed = (name: string): boolean =>
    ['@fontsource-variable/geist', 'katex'].includes(name);

  it('@import／@plugin 的裸 specifier 是套件；相對路徑不是', () => {
    const css = `@import 'tailwindcss';\n@import "tw-animate-css";\n@import './styles/fonts.css';\n@plugin '@scope/plugin/sub';\n@import url('https://x.test/a.css');`;
    expect(cssBareImportsIn(css, installed)).toEqual([
      'tailwindcss',
      'tw-animate-css',
      '@scope/plugin',
    ]);
  });

  it('url() 只有指到已安裝的套件才算；註解裡的不算', () => {
    const css = [
      "/* url('katex/dist/x.woff2') */",
      "src: url('@fontsource-variable/geist/files/geist-latin-wght-normal.woff2') format('woff2');",
      'background: url(images/bg.png);',
      "background: url('data:image/png;base64,AAAA');",
      "background: url('#icon');",
    ].join('\n');
    expect(cssBareImportsIn(css, installed)).toEqual(['@fontsource-variable/geist']);
  });
});

describe('parseVendoredRows', () => {
  it('讀得到進版控的 vendor 清單表', () => {
    const rows = parseVendoredRows(readFileSync(join(ROOT, 'vendor/README.md'), 'utf8'));
    expect(rows.map((row) => row.npmName)).toEqual([
      '@nexus/cordis',
      '@nexus/cordis-plugin-loader',
      '@nexus/cordis-plugin-include',
      '@nexus/cordis-plugin-logger-console',
    ]);
    expect(rows.every((row) => /^https:\/\/\S+$/.test(row.upstream))).toBe(true);
  });

  it('表的欄位變了就一列都讀不到，產生器因此當場錯', () => {
    expect(
      parseVendoredRows('| `cordis/` | `@nexus/cordis` | `cordis` | https://github.com/x |'),
    ).toEqual([]);
  });
});

describe('normalizeRepo', () => {
  it('scp 形式、git+、github: 都轉成可瀏覽的 https', () => {
    expect(normalizeRepo('git@github.com:langchain-ai/langchainjs.git')).toBe(
      'https://github.com/langchain-ai/langchainjs',
    );
    expect(normalizeRepo('git+https://github.com/a/b.git')).toBe('https://github.com/a/b');
    expect(normalizeRepo('git+ssh://git@github.com/a/b.git')).toBe('https://github.com/a/b');
    expect(normalizeRepo('github:a/b')).toBe('https://github.com/a/b');
    expect(normalizeRepo('a/b')).toBe('https://github.com/a/b');
    expect(normalizeRepo(undefined)).toBeUndefined();
  });
});
