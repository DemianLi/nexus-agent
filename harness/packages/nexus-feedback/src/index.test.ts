import { readFileSync } from 'node:fs';

import { MESSAGE_FEEDBACK_SERVICE } from '@nexus/core';
import { describe, expect, it } from 'vitest';

import { FEEDBACK_CATEGORIES, FEEDBACK_CONTRACT_VERSION, feedbackToken } from './index.js';

describe('@nexus/feedback 的定義', () => {
  it('token 名就是 core 的 MESSAGE_FEEDBACK_SERVICE（兩處同一個字串），契約版本是 semver 常數', () => {
    expect(feedbackToken).toEqual({
      name: MESSAGE_FEEDBACK_SERVICE,
      version: FEEDBACK_CONTRACT_VERSION,
    });
    expect(feedbackToken.name).toBe('messageFeedback');
    expect(FEEDBACK_CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('轉出的分類清單就是 core 的那一份', () => {
    expect(FEEDBACK_CATEGORIES).toContain('task-result');
    expect(FEEDBACK_CATEGORIES).toHaveLength(7);
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
