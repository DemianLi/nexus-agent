/**
 * harness home 的解析（#424），規則照 dsh `resolveDshHome`。
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HARNESS_HOME_ENV, resolveHarnessHome } from './harness-home.js';

describe('resolveHarnessHome', () => {
  it('沒設或只有空白就是 ~/.nexus-agent', () => {
    expect(resolveHarnessHome({})).toBe(join(homedir(), '.nexus-agent'));
    expect(resolveHarnessHome({ [HARNESS_HOME_ENV]: '' })).toBe(join(homedir(), '.nexus-agent'));
    expect(resolveHarnessHome({ [HARNESS_HOME_ENV]: '   ' })).toBe(join(homedir(), '.nexus-agent'));
  });

  it('有設就用它：展開 ~、正規化成絕對路徑', () => {
    expect(resolveHarnessHome({ [HARNESS_HOME_ENV]: '/srv/nexus/../nexus-home' })).toBe(
      resolve('/srv/nexus-home'),
    );
    expect(resolveHarnessHome({ [HARNESS_HOME_ENV]: '~' })).toBe(homedir());
    expect(resolveHarnessHome({ [HARNESS_HOME_ENV]: '~/work/home' })).toBe(
      join(homedir(), 'work', 'home'),
    );
    expect(resolveHarnessHome({ [HARNESS_HOME_ENV]: 'relative/home' })).toBe(
      resolve('relative/home'),
    );
  });
});
