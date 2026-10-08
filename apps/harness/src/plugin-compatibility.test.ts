/**
 * 插件與執行中 core 的相容性檢查（[#1137](https://github.com/DemianLi/nexus-agent/issues/1137)）：只讀 manifest 的 peer 範圍，
 * 不 import 插件。接進載入器、掉的是哪一列，見 `plugin-config.test.ts`。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NEXUS_CORE_VERSION } from '@nexus/core';
import { afterEach, describe, expect, it } from 'vitest';
import { assertPluginCompatible, PluginCompatibilityError } from './plugin-compatibility.js';

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
      new PluginCompatibilityError('demo@2.0.0 需要 @nexus/core >=2.0.0，執行中的是 1.4.0'),
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

  it('manifest 沒有 name／version：訊息退回講 manifest 的路徑', () => {
    const file = plugin({ peerDependencies: { '@nexus/core': '>=9.0.0' } });
    expect(() => {
      assertPluginCompatible(file, '1.0.0');
    }).toThrow(/package\.json 需要 @nexus\/core >=9\.0\.0，執行中的是 1\.0\.0/u);
  });

  it('檢查不了的一律拒絕：範圍不合法、不是字串、manifest 壞掉、peerDependencies 不是表、runtime 版本不合法', () => {
    expect(() => {
      assertPluginCompatible(
        plugin({ name: 'd', version: '1.0.0', peerDependencies: { '@nexus/core': 'not a range' } }),
        '1.0.0',
      );
    }).toThrow(/不是合法的 semver 範圍/u);
    expect(() => {
      assertPluginCompatible(
        plugin({ name: 'd', version: '1.0.0', peerDependencies: { '@nexus/core': 2 } }),
        '1.0.0',
      );
    }).toThrow(/不是合法的 semver 範圍/u);
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
});

describe('NEXUS_CORE_VERSION', () => {
  it('是合法的 semver（範圍檢查拿它當 runtime 版本）', () => {
    expect(NEXUS_CORE_VERSION).toMatch(/^\d+\.\d+\.\d+/u);
  });
});
