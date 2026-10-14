import { readFileSync } from 'node:fs';

import * as core from '@nexus/core';
import { describe, expect, it } from 'vitest';

import * as session from './index.js';

describe('@nexus/session 是 @nexus/core 的單向轉出', () => {
  it('四個值與 core 是同一個參照（轉出，不是複製）', () => {
    expect(session.loggedContentBlocks).toBe(core.loggedContentBlocks);
    expect(session.loggedMessageId).toBe(core.loggedMessageId);
    expect(session.toolCallIds).toBe(core.toolCallIds);
    expect(session.REPEAT_REMINDER_MARKER).toBe(core.REPEAT_REMINDER_MARKER);
  });

  it('只轉出這四個值', () => {
    expect(Object.keys(session).sort()).toEqual([
      'REPEAT_REMINDER_MARKER',
      'loggedContentBlocks',
      'loggedMessageId',
      'toolCallIds',
    ]);
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
