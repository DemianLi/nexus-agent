import { describe, expect, it } from 'vitest';

import { collectManifestViolations } from '../../../scripts/verify-lib-manifests.js';
import type { Manifest, WorkspacePackage } from '../../../scripts/workspace-packages.js';

/**
 * 每個套件的 manifest 都指 `lib/`（#1502 刀 1）。這份規則掛在 gate（`verify-lib-manifests`）；這裡對著真的 repo 量一次，
 * 再用手造的 manifest 證明每一條會紅——規則在真 repo 上全綠，不代表它擋得住退回 `src/` 的那一刻。
 */

/** 借 `packages/nexus-deque` 的目錄：它有 `src/index.ts`，沒有 `src/missing.ts`。 */
function sample(manifest: Partial<Manifest>): WorkspacePackage {
  const full: Manifest = {
    name: '@nexus/deque',
    main: 'lib/index.js',
    exports: { '.': './lib/index.js', './src/*': './src/*', './package.json': './package.json' },
    files: ['lib'],
    ...manifest,
  };
  return {
    name: full.name,
    dir: 'packages/nexus-deque',
    vendor: false,
    manifest: full,
    entries: {},
    aliases: [],
  };
}

const messages = (manifest: Partial<Manifest>): string[] =>
  collectManifestViolations([sample(manifest)]).map((violation) => violation.message);

describe('對著真的 repo', () => {
  it('每個套件的 manifest 都指 lib/，沒有收 src/', () => {
    expect(collectManifestViolations()).toEqual([]);
  });
});

describe('每一條規則都擋得住', () => {
  it('合格的樣子不報', () => {
    expect(messages({})).toEqual([]);
  });

  it('main 指 src', () => {
    expect(messages({ main: 'src/index.ts' }).join('\n')).toMatch(/main 是 "src\/index\.ts"/);
  });

  it('exports 的入口指 src（字串）', () => {
    expect(messages({ exports: { '.': './src/index.ts' } }).join('\n')).toMatch(/exports\["\."\]/);
  });

  it('exports 的入口指 src（條件物件的 default）；types 條件不算執行期入口', () => {
    expect(
      messages({
        exports: { '.': { types: './lib/types/index.d.ts', default: './src/index.ts' } },
      }),
    ).toHaveLength(1);
    expect(
      messages({
        exports: { '.': { types: './lib/types/index.d.ts', default: './lib/index.js' } },
      }),
    ).toEqual([]);
  });

  it('bin 與 imports 指 src', () => {
    expect(messages({ bin: { x: 'src/index.ts' } }).join('\n')).toMatch(/bin\.x/);
    expect(messages({ imports: { '#a': './src/index.ts' } }).join('\n')).toMatch(/imports\["#a"\]/);
  });

  it('指到 lib 但 src 沒有對應的檔：編不出來', () => {
    expect(messages({ exports: { '.': './lib/missing.js' } }).join('\n')).toMatch(
      /src\/missing\.ts 不存在/,
    );
  });

  it('files 沒收 lib、或收了 src／.map', () => {
    expect(messages({ files: [] }).join('\n')).toMatch(/沒有收 lib/);
    expect(messages({ files: ['lib', 'src'] }).join('\n')).toMatch(/收了 "src"/);
    expect(messages({ files: ['lib', 'lib/index.js.map'] }).join('\n')).toMatch(/\.map/);
  });

  it('vendor 照 dsh 可以帶 src，但仍不收 .map', () => {
    const vendor = (files: string[]): string[] =>
      collectManifestViolations([{ ...sample({ files }), vendor: true }]).map(
        (violation) => violation.message,
      );
    expect(vendor(['lib', 'src'])).toEqual([]);
    expect(vendor(['lib', 'lib/types/index.d.ts.map']).join('\n')).toMatch(/\.map/);
    // 非 vendor 收 src 仍然紅（上面那條），這裡確認豁免沒有擴到別處。
    expect(messages({ files: ['lib', 'src'] }).join('\n')).toMatch(/收了 "src"/);
  });
});
