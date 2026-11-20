import type { PendingApproval } from '@nexus/wire';
import { APPROVAL_PENDING_KIND } from '@nexus/wire';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ApprovalCard } from '@/features/approval/card';
import { defaultApprovalReason } from '@/features/approval/reason';

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
  it('給了 asker：內文最上面一行只寫它在做的事，不加前綴、不重複子代理名（#3039）；沒給（root 自己問）沒有這一行', () => {
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
    expect(line.textContent).toBe('整理 README');
    expect(line.parentElement?.firstElementChild).toBe(line);
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

  it('委派卡沒有說明：沒有這一行，誰在問由名稱列講', () => {
    render(
      <ApprovalCard
        pending={pending({})}
        asker={{ label: '子代理「explore」' }}
        busy={false}
        onDecide={() => {}}
        onStop={() => {}}
      />,
    );
    expect(screen.queryByTestId('approval-asker')).toBeNull();
  });
});

describe('多個操作（#3039 第 1 項）', () => {
  const twoActions = {
    kind: 'approval',
    interruptId: 'int-1',
    actions: [
      { name: 'read_file', args: { path: 'a' } },
      { name: 'write_file', args: { path: 'b' } },
    ],
    allowedDecisions: ['approve', 'reject'],
  } as unknown as PendingApproval;

  it('每段參數上方放工具名標籤，不加前綴字；單一操作不放', () => {
    const { rerender } = render(
      <ApprovalCard pending={twoActions} busy={false} onDecide={() => {}} onStop={() => {}} />,
    );
    const tools = screen.getAllByTestId('approval-tool');
    expect(tools.map((tool) => [tool.tagName, tool.textContent])).toEqual([
      ['CODE', 'read_file'],
      ['CODE', 'write_file'],
    ]);
    expect(tools[1]?.parentElement?.textContent).toContain('"path": "b"');
    rerender(
      <ApprovalCard
        pending={pending({ file: 'a' })}
        busy={false}
        onDecide={() => {}}
        onStop={() => {}}
      />,
    );
    expect(screen.queryByTestId('approval-tool')).toBeNull();
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
  });

  it('沒有描述（較舊的 server）：照一般核准卡畫，不在 web 拼字', () => {
    card(pending({ sandbox_permissions: 'workspace-write' }, ESCALATE));
    expect(screen.queryByTestId('approval-escalation')).toBeNull();
    // 工具名由面板名稱列講（#3035），卡裡只有參數。
    expect(screen.queryByText(ESCALATE)).toBeNull();
    expect(screen.getByText(/"sandbox_permissions": "workspace-write"/)).toBeTruthy();
  });

  it('其他工具不走升級那一支：只畫參數，工具名由面板名稱列講（#3035；描述照一般工具的規則，見下一組）', () => {
    card(pending({ file_path: '/a' }, 'write_file', defaultApprovalReason('write_file')));
    expect(screen.queryByTestId('approval-escalation')).toBeNull();
    expect(screen.queryByText('write_file')).toBeNull();
    expect(
      screen.getByText('{ "file_path": "/a" }', {
        normalizer: (text) => text.replace(/\s+/g, ' '),
      }),
    ).toBeTruthy();
  });
});

describe('閘門給的理由（#1628）', () => {
  const SEARCH = 'mcp__crm__orders_search_1a2b3c4d';
  const REASON = 'MCP server crm 的工具 orders.search 要先讓人看過（設定 approval）';
  const card = (p: PendingApproval) =>
    render(<ApprovalCard pending={p} busy={false} onDecide={() => {}} onStop={() => {}} />);

  it('真的理由：畫在參數上面，參數照舊', () => {
    card(pending({ query: '上週的退貨訂單' }, SEARCH, REASON));
    expect(screen.getByTestId('approval-reason').textContent).toBe(REASON);
    expect(screen.getByText(/"query": "上週的退貨訂單"/)).toBeTruthy();
    // 在「要執行的內容」那一組裡：讀屏進那一組就唸得到，不是 tooltip。
    expect(screen.getByRole('group', { name: '要執行的內容' }).textContent).toContain(REASON);
  });

  it('core 的預設字：不畫（跟面板名稱列的工具名重複）', () => {
    card(pending({ file_path: '/a' }, 'write_file', defaultApprovalReason('write_file')));
    expect(screen.queryByTestId('approval-reason')).toBeNull();
    expect(screen.queryByText(defaultApprovalReason('write_file'))).toBeNull();
  });

  it('沒有描述（較舊的 server）：不多一行', () => {
    card(pending({ file_path: '/a' }, 'write_file'));
    expect(screen.queryByTestId('approval-reason')).toBeNull();
  });

  it('沙箱升級不重複畫：理由只在升級那一句', () => {
    const reason = '把 "/outside/a.txt" 的檔案政策升到 workspace-write，只蓋這一次：要寫設定檔';
    card(pending({ sandbox_permissions: 'workspace-write' }, 'request_sandbox_escalation', reason));
    expect(screen.queryByTestId('approval-reason')).toBeNull();
    expect(screen.getAllByText(reason)).toHaveLength(1);
  });
});
