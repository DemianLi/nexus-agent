import { readFileSync } from 'node:fs';

import * as core from '@nexus/core';
import { describe, expect, it } from 'vitest';

import * as subprocess from './index.js';

describe('@nexus/subprocess 轉出 @nexus/core 的兩支函式', () => {
  it('兩支函式與 core 是同一個參照（轉出，不是複製）', () => {
    expect(subprocess.scrubbedParentEnv).toBe(core.scrubbedParentEnv);
    expect(subprocess.trackHostExitChild).toBe(core.trackHostExitChild);
  });

  it('只轉出這兩支', () => {
    expect(Object.keys(subprocess).sort()).toEqual(['scrubbedParentEnv', 'trackHostExitChild']);
  });

  it('@nexus/core 只放 peerDependencies 與 devDependencies，不進 dependencies（不能讓安裝結果出現第二份 core）', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      dependencies?: Record<string, string>;
      peerDependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(Object.keys(pkg.peerDependencies)).toEqual(['@nexus/core']);
    expect(pkg.devDependencies['@nexus/core']).toBe('workspace:*');
  });
});
