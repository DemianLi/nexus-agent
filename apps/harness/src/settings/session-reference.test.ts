/**
 * `session-reference` 那一列的 schema（[#1573](https://github.com/DemianLi/nexus-agent/issues/1573) N0862 驗收 D 的 schema 那一半）：
 * 範圍同 dsh `SessionReferenceResolver.Config`（`packages/context/session-reference/src/index.ts:90-95`，`1517a4db`／`687f282e`／`22ddee37`）。
 * 起動期「寫壞整個起不來」那一半走 `runServe`，在 `startup-audit.test.ts`。
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_REFERENCE_CONTEXT_FRACTION,
  sessionReferenceConfigSchema,
  sessionReferencePlugin,
} from './session-reference.js';

describe('schema 的預設與範圍，同 dsh', () => {
  it('省略的格補 dsh 的預設：3 條、候選 50、比例 0.2，maxReferenceBytes 沒有（照模型窗口算）', () => {
    const parsed = sessionReferenceConfigSchema.parse({});
    expect(parsed).toEqual({
      maxReferences: 3,
      candidateLimit: 50,
      referenceContextFraction: 0.2,
    });
    expect(Object.hasOwn(parsed, 'maxReferenceBytes')).toBe(false);
    expect(DEFAULT_REFERENCE_CONTEXT_FRACTION).toBe(0.2);
  });

  it('邊界值收：maxReferences 1 與 3、比例 0 與 1、位元組與候選上限 1', () => {
    expect(sessionReferenceConfigSchema.parse({ maxReferences: 1 }).maxReferences).toBe(1);
    expect(sessionReferenceConfigSchema.parse({ maxReferences: 3 }).maxReferences).toBe(3);
    expect(
      sessionReferenceConfigSchema.parse({ referenceContextFraction: 0 }).referenceContextFraction,
    ).toBe(0);
    expect(
      sessionReferenceConfigSchema.parse({ referenceContextFraction: 1 }).referenceContextFraction,
    ).toBe(1);
    expect(sessionReferenceConfigSchema.parse({ maxReferenceBytes: 1 }).maxReferenceBytes).toBe(1);
    expect(sessionReferenceConfigSchema.parse({ candidateLimit: 1 }).candidateLimit).toBe(1);
  });

  it.each([
    ['maxReferences 4（上限 3，web 端只認三條）', { maxReferences: 4 }, 'maxReferences'],
    ['maxReferences 0', { maxReferences: 0 }, 'maxReferences'],
    ['maxReferences 2.5', { maxReferences: 2.5 }, 'maxReferences'],
    ['referenceContextFraction 1.5', { referenceContextFraction: 1.5 }, 'referenceContextFraction'],
    [
      'referenceContextFraction -0.1',
      { referenceContextFraction: -0.1 },
      'referenceContextFraction',
    ],
    ['candidateLimit 0', { candidateLimit: 0 }, 'candidateLimit'],
    ['candidateLimit 1.5', { candidateLimit: 1.5 }, 'candidateLimit'],
    ['maxReferenceBytes 0', { maxReferenceBytes: 0 }, 'maxReferenceBytes'],
    ['maxReferenceBytes 字串', { maxReferenceBytes: '很大' }, 'maxReferenceBytes'],
  ])('擋下 %s，訊息指名欄位', (_name, input, field) => {
    const result = sessionReferenceConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain(field);
  });

  it('strictObject：多寫的欄位是打錯字，擋下', () => {
    expect(sessionReferenceConfigSchema.safeParse({ maxReference: 2 }).success).toBe(false);
  });
});

describe('plugin 本身', () => {
  it('名字是 session-reference，apply 是空的（值由 startupSetting 讀）', () => {
    expect(sessionReferencePlugin.name).toBe('session-reference');
    expect(() =>
      sessionReferencePlugin.apply({} as never, sessionReferenceConfigSchema.parse({})),
    ).not.toThrow();
  });
});
