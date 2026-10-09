import type { PendingApproval } from '@nexus/wire';
import { APPROVAL_PENDING_KIND } from '@nexus/wire';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ApprovalCard } from '@/components/approval-card';

afterEach(cleanup);

/** 一張只有一筆的核准卡。其餘欄位這張卡不讀。 */
function pending(args: unknown, name = 'echo', description?: string): PendingApproval {
  return {
    kind: APPROVAL_PENDING_KIND,
    interruptId: 'int-1',
    actions: [{ name, args, ...(description === undefined ? {} : { description }) }],
    allowedDecisions: ['approve', 'reject'],
  } as unknown as PendingApproval;
}

describe('前景子代理在問（#328）', () => {
  it('給了 asker：卡上寫誰在問、它在做什麼；沒給（root 自己問）沒有這一行', () => {
    const { rerender } = render(
      <ApprovalCard
        pending={pending({ file: 'a' })}
        asker={{ label: '子代理「explore」', description: '整理 README' }}
        busy={false}
        onDecide={() => {}}
        onStop={() => {}}
      />,
    );
    const line = screen.getByTestId('approval-asker');
    expect(line.textContent).toBe('子代理「explore」要執行這個操作，它在做：整理 README');
    rerender(
      <ApprovalCard
        pending={pending({ file: 'a' })}
        busy={false}
        onDecide={() => {}}
        onStop={() => {}}
      />,
    );
    expect(screen.queryByTestId('approval-asker')).toBeNull();
  });

  it('委派卡沒有說明：只寫誰在問', () => {
    render(
      <ApprovalCard
        pending={pending({})}
        asker={{ label: '子代理「explore」' }}
        busy={false}
        onDecide={() => {}}
        onStop={() => {}}
      />,
    );
    expect(screen.getByTestId('approval-asker').textContent).toBe(
      '子代理「explore」要執行這個操作',
    );
  });
});

describe('核准卡上的參數', () => {
  it('參數解不開的那顆，酬載帶的是原字串：原樣顯示，不包一層引號（#281）', () => {
    render(
      <ApprovalCard
        pending={pending('{"text": 嗨}')}
        busy={false}
        onDecide={() => {}}
        onStop={() => {}}
      />,
    );
    expect(screen.getByText('{"text": 嗨}')).toBeTruthy();
  });

  it('一般的參數物件照舊序列化（#408 起分行縮排，面板裡的內容區可以捲）', () => {
    render(
      <ApprovalCard
        pending={pending({ text: '好' })}
        busy={false}
        onDecide={() => {}}
        onStop={() => {}}
      />,
    );
    expect(
      screen.getByText('{ "text": "好" }', { normalizer: (text) => text.replace(/\s+/g, ' ') }),
    ).toBeTruthy();
  });

  it('不允許在左、允許在右', () => {
    render(
      <ApprovalCard pending={pending({})} busy={false} onDecide={() => {}} onStop={() => {}} />,
    );
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
      '全部拒絕',
      '全部核准',
    ]);
  });
});

describe('沙箱升級（#1292）', () => {
  const ESCALATE = 'request_sandbox_escalation';
  const reason = (mode: string) =>
    `把 "/outside/a.txt" 的檔案政策升到 ${mode}，只蓋這一次：使用者要我寫到工作區外`;
  const card = (p: PendingApproval) =>
    render(<ApprovalCard pending={p} busy={false} onDecide={() => {}} onStop={() => {}} />);

  it('有描述：畫 harness 送的那句（模式、理由、只蓋這一次），不露工具名與參數 JSON', () => {
    card(
      pending(
        {
          file_path: '/outside/a.txt',
          sandbox_permissions: 'workspace-write',
          justification: '使用者要我寫到工作區外',
        },
        ESCALATE,
        reason('workspace-write'),
      ),
    );
    expect(screen.getByTestId('approval-escalation').textContent).toBe(reason('workspace-write'));
    expect(screen.queryByText(ESCALATE)).toBeNull();
    expect(screen.queryByText(/"sandbox_permissions"/)).toBeNull();
    expect(screen.queryByTestId('approval-full-access')).toBeNull();
  });

  it('升到 danger-full-access：多一句寫入不受工作區限制', () => {
    card(
      pending(
        {
          file_path: '/outside/a.txt',
          sandbox_permissions: 'danger-full-access',
          justification: '要寫系統設定',
        },
        ESCALATE,
        reason('danger-full-access'),
      ),
    );
    expect(screen.getByTestId('approval-full-access').textContent).toBe(
      '這一次的檔案寫入不受工作區限制。',
    );
  });

  it('沒有描述（較舊的 server）：照一般核准卡畫，不在 web 拼字', () => {
    card(pending({ sandbox_permissions: 'danger-full-access' }, ESCALATE));
    expect(screen.queryByTestId('approval-escalation')).toBeNull();
    expect(screen.getByText(ESCALATE)).toBeTruthy();
  });

  it('其他工具帶了描述也照舊：工具名＋參數，不畫描述', () => {
    card(pending({ file_path: '/a' }, 'write_file', '基座 HITL 的描述'));
    expect(screen.queryByTestId('approval-escalation')).toBeNull();
    expect(screen.queryByText('基座 HITL 的描述')).toBeNull();
    expect(screen.getByText('write_file')).toBeTruthy();
    expect(
      screen.getByText('{ "file_path": "/a" }', {
        normalizer: (text) => text.replace(/\s+/g, ' '),
      }),
    ).toBeTruthy();
  });
});
