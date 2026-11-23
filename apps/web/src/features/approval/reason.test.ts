// @vitest-environment node
import { APPROVAL_DEFAULT_REASON_TEMPLATE } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { approvalReasonOf, defaultApprovalReason } from '@/features/approval/reason';

describe('抄來的預設字跟 wire 對得上（wire 的值跟 core 一致由 harness 的 `wire-harness-facts.test.ts` 釘住）', () => {
  it('沒有理由時 core 填的那一句，就是 `defaultApprovalReason` 的樣板', () => {
    expect(APPROVAL_DEFAULT_REASON_TEMPLATE.replace('{name}', 'write_file')).toBe(
      defaultApprovalReason('write_file'),
    );
  });
});

describe('approvalReasonOf', () => {
  const action = (name: string, description?: string) => ({
    name,
    args: {},
    ...(description === undefined ? {} : { description }),
  });

  it('閘門給的理由：原樣', () => {
    const reason = 'MCP server crm 的工具 orders.search 要先讓人看過（設定 approval）';
    expect(approvalReasonOf(action('mcp__crm__orders_search_1a2b3c4d', reason))).toBe(reason);
  });

  it('預設字、沒有、空白：不畫', () => {
    expect(
      approvalReasonOf(action('write_file', defaultApprovalReason('write_file'))),
    ).toBeUndefined();
    expect(approvalReasonOf(action('write_file'))).toBeUndefined();
    expect(approvalReasonOf(action('write_file', '  '))).toBeUndefined();
  });
});
