import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  APPROVAL_POLICIES,
  PERMISSION_COMMAND_NAME,
  PERMISSION_PRESETS_CONTRACT_VERSION,
  PERMISSION_PRESETS_PLUGIN_NAME,
  PERMISSION_PRESETS_SERVICE,
  SANDBOX_MODES,
  permissionPresetsToken,
} from './index.js';

describe('@nexus/permission-presets 的定義', () => {
  it('token 名是 permissionPresets，契約版本是 semver 常數', () => {
    expect(permissionPresetsToken).toEqual({
      name: PERMISSION_PRESETS_SERVICE,
      version: PERMISSION_PRESETS_CONTRACT_VERSION,
    });
    expect(permissionPresetsToken.name).toBe('permissionPresets');
    expect(PERMISSION_PRESETS_CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('常數：命令名不帶斜線、列的名字是必掛名單認的 permission-presets', () => {
    expect(PERMISSION_COMMAND_NAME).toBe('permission');
    expect(PERMISSION_PRESETS_PLUGIN_NAME).toBe('permission-presets');
  });

  it('轉出的詞彙就是 core 的那一份', () => {
    expect([...SANDBOX_MODES]).toEqual(['read-only', 'workspace-write', 'danger-full-access']);
    expect([...APPROVAL_POLICIES]).toEqual(['ask', 'never']);
  });
});

describe('相依關係', () => {
  it('core、sdk、wire 放 peer、devDependencies 留 workspace 版本，沒有執行期相依', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      dependencies?: Record<string, string>;
      peerDependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
    const peers = ['@nexus/core', '@nexus/sdk', '@nexus/wire'].sort();
    expect(Object.keys(pkg.peerDependencies).sort()).toEqual(peers);
    for (const name of peers) expect(pkg.devDependencies[name]).toBe('workspace:*');
  });
});
