/**
 * 插件與執行中 nexus 的相容性檢查（[#1137](https://github.com/DemianLi/nexus-agent/issues/1137)、
 * [#1568](https://github.com/DemianLi/nexus-agent/issues/1568)）：只讀 manifest 的 `engines.nexus` 與 peer 範圍，不 import 插件。
 * 接進載入器、掉的是哪一列，見 `plugin-config.test.ts`。
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NEXUS_CORE_VERSION } from '@nexus/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertPluginCompatible,
  evaluatePluginCompatibility,
  isRuntimeFamily,
  PluginCompatibilityError,
  VENDORED_PACKAGE_NAMES,
} from './plugin-compatibility.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 一個帶 manifest 的插件目錄，回傳入口檔路徑。 */
function plugin(manifest: unknown, rawManifest?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'nexus-peer-'));
  roots.push(root);
  const dir = join(root, 'src');
  mkdirSync(dir);
  const text = rawManifest ?? JSON.stringify(manifest);
  writeFileSync(join(root, 'package.json'), text);
  writeFileSync(join(dir, 'index.mjs'), 'export default {};\n');
  return join(dir, 'index.mjs');
}

describe('assertPluginCompatible', () => {
  it('範圍不滿足：指名 套件@版本、範圍與執行中的版本', () => {
    const file = plugin({
      name: 'demo',
      version: '2.0.0',
      peerDependencies: { '@nexus/core': '>=2.0.0' },
    });
    expect(() => {
      assertPluginCompatible(file, '1.4.0');
    }).toThrow(
      new PluginCompatibilityError(
        'demo@2.0.0 需要 @nexus/core >=2.0.0，執行中的是 1.4.0。硬跑可能崩潰或遺失資料；請更新插件，或換一個與這個版本相容的插件。',
      ),
    );
  });

  it('範圍滿足：放行（含 ^ 與 || 的範圍）', () => {
    const file = plugin({
      name: 'demo',
      version: '1.0.0',
      peerDependencies: { '@nexus/core': '^1.2.0 || ^2.0.0' },
    });
    expect(() => {
      assertPluginCompatible(file, '1.4.0');
    }).not.toThrow();
    expect(() => {
      assertPluginCompatible(file, '2.1.0');
    }).not.toThrow();
    expect(() => {
      assertPluginCompatible(file, '3.0.0');
    }).toThrow(/需要 @nexus\/core \^1\.2\.0 \|\| \^2\.0\.0，執行中的是 3\.0\.0/u);
  });

  it('預發行版：執行中是 1.0.0-rc.1，>=1.0.0-rc.0 的插件放行', () => {
    const file = plugin({
      name: 'demo',
      version: '1.0.0',
      peerDependencies: { '@nexus/core': '>=1.0.0-rc.0' },
    });
    expect(() => {
      assertPluginCompatible(file, '1.0.0-rc.1');
    }).not.toThrow();
  });

  it('沒宣告就放行：沒有 peerDependencies、或沒有 @nexus/core 那一格、或根本沒有 manifest 可找', () => {
    expect(() => {
      assertPluginCompatible(plugin({ name: 'demo', version: '1.0.0' }), '1.0.0');
    }).not.toThrow();
    expect(() => {
      assertPluginCompatible(plugin({ name: 'demo', peerDependencies: { zod: '^4' } }), '1.0.0');
    }).not.toThrow();
  });

  it('不相容、但 manifest 沒有非空的 name／version：照 dsh 拒絕，訊息指出缺哪一格與不滿足的需求', () => {
    const noName = plugin({ version: '1.0.0', peerDependencies: { '@nexus/core': '>=9.0.0' } });
    expect(() => {
      assertPluginCompatible(noName, '1.0.0');
    }).toThrow(/package\.json 的 name 要是非空字串.*需要 @nexus\/core >=9\.0\.0/u);
    const emptyVersion = plugin({
      name: 'demo',
      version: '  ',
      peerDependencies: { '@nexus/core': '>=9.0.0' },
    });
    expect(() => {
      assertPluginCompatible(emptyVersion, '1.0.0');
    }).toThrow(/package\.json 的 version 要是非空字串/u);
    // 相容的插件不要求 name／version。
    expect(() => {
      assertPluginCompatible(plugin({ peerDependencies: { '@nexus/core': '>=0.0.0' } }), '1.0.0');
    }).not.toThrow();
  });

  it('檢查不了的一律拒絕：欄位形狀不對、manifest 壞掉、runtime 版本不合法', () => {
    expect(() => {
      assertPluginCompatible(
        plugin({ name: 'd', version: '1.0.0', peerDependencies: { '@nexus/core': 2 } }),
        '1.0.0',
      );
    }).toThrow(/peerDependencies\["@nexus\/core"\] 不是字串/u);
    expect(() => {
      assertPluginCompatible(
        plugin({ name: 'd', version: '1.0.0', peerDependencies: { zod: 4 } }),
        '1.0.0',
      );
    }).toThrow(/peerDependencies\["zod"\] 不是字串/u);
    expect(() => {
      assertPluginCompatible(plugin(undefined, '{壞掉'), '1.0.0');
    }).toThrow(/讀不了 .*package\.json/u);
    expect(() => {
      assertPluginCompatible(plugin(undefined, '[]'), '1.0.0');
    }).toThrow(/不是一個 JSON 物件/u);
    expect(() => {
      assertPluginCompatible(
        plugin({ name: 'd', version: '1.0.0', peerDependencies: [] }),
        '1.0.0',
      );
    }).toThrow(/peerDependencies 不是一張表/u);
    expect(() => {
      assertPluginCompatible(
        plugin({ name: 'd', version: '1.0.0', peerDependencies: { '@nexus/core': '>=1' } }),
        'x',
      );
    }).toThrow(/不是合法的 semver，檢查不了/u);
  });

  it('範圍是空字串或不合法的：算不滿足（擋下），不是「壞範圍」那條拒絕', () => {
    for (const range of ['not a range', '', '  ']) {
      expect(() => {
        assertPluginCompatible(
          plugin({ name: 'd', version: '1.0.0', peerDependencies: { '@nexus/core': range } }),
          '1.0.0',
        );
      }).toThrow(/d@1\.0\.0 需要 @nexus\/core/u);
    }
  });
});

describe('#1568：照 dsh 看 engines 與每個同版的 @nexus 套件', () => {
  it('驗收 1：只 peer @nexus/sdk（沒有 @nexus/core）的插件也會被判，訊息指名 @nexus/sdk', () => {
    const file = plugin({
      name: 'sdk-only',
      version: '1.0.0',
      peerDependencies: { '@nexus/sdk': '>=99.0.0' },
    });
    expect(() => {
      assertPluginCompatible(file, '0.0.0');
    }).toThrow(/sdk-only@1\.0\.0 需要 @nexus\/sdk >=99\.0\.0，執行中的是 0\.0\.0/u);
  });

  it('驗收 2：engines.nexus 單獨決定——滿足就放行（即使 peer 不滿足）、不滿足就擋（即使 peer 滿足）', () => {
    const enginesOk = plugin({
      name: 'e',
      version: '1.0.0',
      engines: { nexus: '>=0.0.0' },
      peerDependencies: { '@nexus/sdk': '>=99.0.0' },
    });
    expect(() => {
      assertPluginCompatible(enginesOk, '0.0.0');
    }).not.toThrow();

    const enginesBad = plugin({
      name: 'e',
      version: '1.0.0',
      engines: { nexus: '>=99.0.0' },
      peerDependencies: { '@nexus/sdk': '>=0.0.0' },
    });
    expect(() => {
      assertPluginCompatible(enginesBad, '0.0.0');
    }).toThrow(/e@1\.0\.0 需要 engines\.nexus >=99\.0\.0，執行中的是 0\.0\.0/u);
  });

  it('engines 有、但沒有 nexus 那一格（例如只寫 node）→ 照常走 peer', () => {
    const file = plugin({
      name: 'n',
      version: '1.0.0',
      engines: { node: '>=22' },
      peerDependencies: { '@nexus/sdk': '>=99.0.0' },
    });
    expect(() => {
      assertPluginCompatible(file, '0.0.0');
    }).toThrow(/@nexus\/sdk >=99\.0\.0/u);
  });

  it('engines 的形狀不對一律拒絕：不是表、engines.nexus 不是字串；engines.nexus 寫 workspace: 算不滿足', () => {
    expect(() => {
      assertPluginCompatible(plugin({ name: 'e', version: '1.0.0', engines: [] }), '1.0.0');
    }).toThrow(/engines 不是一張表/u);
    expect(() => {
      assertPluginCompatible(
        plugin({ name: 'e', version: '1.0.0', engines: { nexus: 3 } }),
        '1.0.0',
      );
    }).toThrow(/engines\.nexus 不是字串/u);
    expect(() => {
      assertPluginCompatible(
        plugin({ name: 'e', version: '1.0.0', engines: { nexus: 'workspace:*' } }),
        '1.0.0',
      );
    }).toThrow(/需要 engines\.nexus workspace:\*/u);
  });

  it('驗收 3：peer 寫 workspace:*／^／~ 視為執行中的版本，放行（包括 @nexus/core 與 @nexus/sdk）', () => {
    for (const range of ['workspace:*', 'workspace:^', 'workspace:~']) {
      const file = plugin({
        name: 'copied',
        version: '1.0.0',
        peerDependencies: { '@nexus/core': range, '@nexus/sdk': range, '@nexus/tools': range },
      });
      expect(() => {
        assertPluginCompatible(file, '0.0.0');
      }).not.toThrow();
    }
    // 其他 workspace: 寫法不是 dsh 認得的那三種，算不滿足。
    expect(() => {
      assertPluginCompatible(
        plugin({
          name: 'copied',
          version: '1.0.0',
          peerDependencies: { '@nexus/core': 'workspace:1.2.3' },
        }),
        '0.0.0',
      );
    }).toThrow(/需要 @nexus\/core workspace:1\.2\.3/u);
  });

  it('驗收 4：vendor 的 Cordis 套件不檢查（版號是上游的）', () => {
    for (const name of VENDORED_PACKAGE_NAMES) {
      const file = plugin({
        name: 'cordis-user',
        version: '1.0.0',
        peerDependencies: { [name]: '>=99.0.0' },
      });
      expect(() => {
        assertPluginCompatible(file, '0.0.0');
      }).not.toThrow();
    }
  });

  it('驗收 5：兩個 peer 都不滿足時，訊息兩個都列；滿足的、家族外的不列', () => {
    const file = plugin({
      name: 'many',
      version: '3.0.0',
      peerDependencies: {
        '@nexus/sdk': '^2.0.0',
        '@nexus/tools': '^2.0.0',
        '@nexus/commands': '>=0.0.0',
        '@nexus/cordis': '^9.0.0',
        zod: '^99.0.0',
      },
    });
    let message = '';
    try {
      assertPluginCompatible(file, '0.0.0');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(
      'many@3.0.0 需要 @nexus/sdk ^2.0.0、@nexus/tools ^2.0.0，執行中的是 0.0.0',
    );
    expect(message).not.toContain('@nexus/commands');
    expect(message).not.toContain('@nexus/cordis');
    expect(message).not.toContain('zod');
    expect(message).toContain('可能崩潰或遺失資料');
  });

  it('evaluatePluginCompatibility：全部滿足回 undefined；不滿足回結構化結果；繼承來的欄位不算', () => {
    expect(
      evaluatePluginCompatibility({ peerDependencies: { '@nexus/sdk': '*' } }, '0.0.0'),
    ).toBeUndefined();
    expect(
      evaluatePluginCompatibility(
        { name: 'm', version: '1.0.0', peerDependencies: { '@nexus/sdk': '^1.0.0' } },
        '0.0.0',
      ),
    ).toEqual({
      name: 'm',
      version: '1.0.0',
      runtimeVersion: '0.0.0',
      requirements: { '@nexus/sdk': '^1.0.0' },
    });
    // 原型上的 engines 不算：沿 prototype 繼承來的不是插件自己宣告的。
    const inherited = Object.create({ engines: { nexus: '>=99.0.0' } }) as object;
    expect(evaluatePluginCompatibility(inherited, '0.0.0')).toBeUndefined();
  });

  it('預發行版：執行中是 1.0.0-rc.1，peer 寫 >=1.0.0-rc.0 的 @nexus/sdk 放行', () => {
    const file = plugin({
      name: 'rc',
      version: '1.0.0',
      peerDependencies: { '@nexus/sdk': '>=1.0.0-rc.0' },
    });
    expect(() => {
      assertPluginCompatible(file, '1.0.0-rc.1');
    }).not.toThrow();
    // 範圍的 tuple 跟預發行版對不上時，只有 includePrerelease 放得過：>=0.5.0 對 1.0.0-rc.1。
    const wide = plugin({
      name: 'rc',
      version: '1.0.0',
      peerDependencies: { '@nexus/sdk': '>=0.5.0' },
    });
    expect(() => {
      assertPluginCompatible(wide, '1.0.0-rc.1');
    }).not.toThrow();
  });
});

describe('家族名單', () => {
  it('@nexus/ 底下、不在 vendor 名單的都算同一家；scope 外與前綴像的不算', () => {
    for (const name of ['@nexus/core', '@nexus/sdk', '@nexus/tools', '@nexus/session']) {
      expect(isRuntimeFamily(name)).toBe(true);
    }
    for (const name of ['@nexus-other/sdk', 'nexus', '@nexus', '@types/node', 'zod']) {
      expect(isRuntimeFamily(name)).toBe(false);
    }
    for (const name of VENDORED_PACKAGE_NAMES) expect(isRuntimeFamily(name)).toBe(false);
  });

  it('vendor 名單等於 vendor/ 底下每一份 package.json 的 name（多一個少一個都會紅）', () => {
    const vendorRoot = fileURLToPath(new URL('../../../vendor/', import.meta.url));
    const names = readdirSync(vendorRoot, { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && existsSync(join(vendorRoot, entry.name, 'package.json')),
      )
      .map(
        (entry) =>
          (
            JSON.parse(readFileSync(join(vendorRoot, entry.name, 'package.json'), 'utf8')) as {
              name: string;
            }
          ).name,
      )
      .sort();
    expect([...VENDORED_PACKAGE_NAMES].sort()).toEqual(names);
  });
});

describe('NEXUS_CORE_VERSION', () => {
  it('是合法的 semver（範圍檢查拿它當 runtime 版本）', () => {
    expect(NEXUS_CORE_VERSION).toMatch(/^\d+\.\d+\.\d+/u);
  });
});
