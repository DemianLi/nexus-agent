import { readFileSync } from 'node:fs';

import * as core from '@nexus/core';
import { describe, expect, it } from 'vitest';

import * as toolResult from './index.js';

describe('@nexus/tool-result 是 @nexus/core 的單向轉出', () => {
  it('五個值與 core 是同一個參照（轉出，不是複製）', () => {
    expect(toolResult.toolRefusal).toBe(core.toolRefusal);
    expect(toolResult.toolCallIdOf).toBe(core.toolCallIdOf);
    expect(toolResult.markToolError).toBe(core.markToolError);
    expect(toolResult.callThreadId).toBe(core.callThreadId);
    expect(toolResult.toolCallSessionAddress).toBe(core.toolCallSessionAddress);
  });

  it('只轉出這五個值', () => {
    expect(Object.keys(toolResult).sort()).toEqual([
      'callThreadId',
      'markToolError',
      'toolCallIdOf',
      'toolCallSessionAddress',
      'toolRefusal',
    ]);
  });

  it('標上去的碼 core 讀得到：同一張表（兩份 core 就是兩張 WeakMap，這是不能複製實作的理由）', () => {
    const message = toolResult.toolRefusal('不行', {
      callId: 'c1',
      name: 'probe',
    });
    toolResult.markToolError(message, { name: 'ProbeError', code: 'PROBE' });
    expect(core.toolErrorOf(message)).toEqual({ name: 'ProbeError', code: 'PROBE' });
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
