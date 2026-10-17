import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { GOALS_CONTRACT_VERSION, GOALS_SERVICE, goalsToken } from './index.js';

describe('@nexus/goal 的定義', () => {
  it('token 名是 goals、契約版本是 semver 常數（1.0.0）', () => {
    expect(goalsToken).toEqual({ name: 'goals', version: GOALS_CONTRACT_VERSION });
    expect(GOALS_SERVICE).toBe('goals');
    expect(GOALS_CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('相依關係', () => {
  it('core 放 peer、devDependencies 留 workspace 版本，沒有執行期相依', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      dependencies?: Record<string, string>;
      peerDependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
    const peers = ['@nexus/core', '@nexus/sdk'].sort();
    expect(Object.keys(pkg.peerDependencies).sort()).toEqual(peers);
    for (const name of peers) expect(pkg.devDependencies[name]).toBe('workspace:*');
  });
});
