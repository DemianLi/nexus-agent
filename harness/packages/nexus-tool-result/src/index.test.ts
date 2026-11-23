import { readFileSync } from 'node:fs';

import * as core from '@nexus/core';
import { describe, expect, it } from 'vitest';

import * as toolResult from './index.js';

describe('@nexus/tool-result 是 @nexus/core 的單向轉出', () => {
  it('十個值與 core 是同一個參照（轉出，不是複製）', () => {
    expect(toolResult.APPROVAL_INVALID_REPLY).toBe(core.APPROVAL_INVALID_REPLY);
    expect(toolResult.APPROVAL_REJECTED_BY_USER).toBe(core.APPROVAL_REJECTED_BY_USER);
    expect(toolResult.approvalDenied).toBe(core.approvalDenied);
    expect(toolResult.EXTERNAL_MCP_CONTENT_NOTICE).toBe(core.EXTERNAL_MCP_CONTENT_NOTICE);
    expect(toolResult.REFERENCE_RULE).toBe(core.REFERENCE_RULE);
    expect(toolResult.toolRefusal).toBe(core.toolRefusal);
    expect(toolResult.toolCallIdOf).toBe(core.toolCallIdOf);
    expect(toolResult.markToolError).toBe(core.markToolError);
    expect(toolResult.callThreadId).toBe(core.callThreadId);
    expect(toolResult.toolCallSessionAddress).toBe(core.toolCallSessionAddress);
  });

  it('只轉出這十個值', () => {
    expect(Object.keys(toolResult).sort()).toEqual([
      'APPROVAL_INVALID_REPLY',
      'APPROVAL_REJECTED_BY_USER',
      'EXTERNAL_MCP_CONTENT_NOTICE',
      'REFERENCE_RULE',
      'approvalDenied',
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
