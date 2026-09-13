import type { PendingApproval } from '@nexus/wire';
import { APPROVAL_PENDING_KIND } from '@nexus/wire';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ApprovalCard } from '@/components/approval-card';

afterEach(cleanup);

/** 一張只有一筆的核准卡。其餘欄位這張卡不讀。 */
function pending(args: unknown): PendingApproval {
  return {
    kind: APPROVAL_PENDING_KIND,
    interruptId: 'int-1',
    actions: [{ name: 'echo', args }],
    allowedDecisions: ['approve', 'reject'],
  } as unknown as PendingApproval;
}

describe('核准卡上的參數', () => {
  it('參數解不開的那顆，酬載帶的是原字串：原樣顯示，不包一層引號（#281）', () => {
    render(<ApprovalCard pending={pending('{"text": 嗨}')} busy={false} onDecide={() => {}} />);
    expect(screen.getByText('{"text": 嗨}')).toBeTruthy();
  });

  it('一般的參數物件照舊序列化', () => {
    render(<ApprovalCard pending={pending({ text: '好' })} busy={false} onDecide={() => {}} />);
    expect(screen.getByText('{"text":"好"}')).toBeTruthy();
  });
});
