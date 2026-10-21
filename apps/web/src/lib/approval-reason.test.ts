// @vitest-environment node
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { approvalReasonOf, defaultApprovalReason } from '@/lib/approval-reason';

/** core 的閘門（web 不相依那個套件，改了那邊這裡要紅）。 */
const CORE_APPROVAL = '../../../../packages/nexus-core/src/approval.ts';
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('抄來的預設字跟 core 對得上', () => {
  it('沒有理由時 core 填的那一句，就是 `defaultApprovalReason` 的樣板', () => {
    const template = /decision\.reason \?\? `([^`]*)`/.exec(read(CORE_APPROVAL))?.[1];
    expect(template).toBe('"${exec.name}" 需要人工核准');
    expect(template?.replace('${exec.name}', 'write_file')).toBe(
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
