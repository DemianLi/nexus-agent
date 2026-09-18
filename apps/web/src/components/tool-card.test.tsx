import type { ConversationState, ToolEntry } from '@nexus/wire';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ToolCard } from '@/components/tool-card';
import { Transcript } from '@/components/transcript';
import { axeViolations } from '@/test/axe';

/** 工具卡（#406）。四格狀態怎麼從日誌定出來在 `@nexus/wire` 與 harness 的測試裡；這裡只驗畫出來的。 */

afterEach(cleanup);

function tool(overrides: Partial<ToolEntry> = {}): ToolEntry {
  return {
    kind: 'tool',
    id: 'tool-1',
    callId: 'call-1',
    name: 'read_file',
    input: '{"file_path":"src/App.tsx"}',
    status: 'done',
    attribution: { kind: 'root' },
    ...overrides,
  };
}

describe('工具卡', () => {
  it.each([
    ['running', '執行中'],
    ['suspended', '等你回答'],
    ['done', '完成'],
    ['failed', '失敗'],
  ] as const)('四格狀態各自的字：%s → %s', (status, label) => {
    render(<ToolCard entry={tool({ status })} beam={false} />);
    const card = screen.getByTestId('tool-entry');
    expect(card.getAttribute('data-status')).toBe(status);
    expect(within(card).getByText(label)).toBeTruthy();
  });

  it('收著一行：分類的標題、工具名、參數摘要；展開看排好的參數', () => {
    render(<ToolCard entry={tool()} beam={false} />);
    const trigger = screen.getByRole('button', { name: /讀取/ });
    expect(trigger.textContent).toContain('read_file');
    expect(trigger.textContent).toContain('src/App.tsx');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(/"file_path"/)).toBeNull();

    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(/"file_path": "src\/App.tsx"/)).toBeTruthy();
  });

  it('失敗時收著那一行就是錯誤的第一行，展開看全文', () => {
    render(
      <ToolCard
        entry={tool({ status: 'failed', error: '人拒絕了這次呼叫\n第二行細節' })}
        beam={false}
      />,
    );
    const trigger = screen.getByRole('button', { name: /讀取/ });
    expect(trigger.textContent).toContain('人拒絕了這次呼叫');
    expect(trigger.textContent).not.toContain('第二行細節');
    fireEvent.click(trigger);
    expect(screen.getByText(/第二行細節/)).toBeTruthy();
  });

  it('子代理的工具帶歸屬；未歸屬照講', () => {
    render(
      <>
        <ToolCard
          entry={tool({ attribution: { kind: 'subagent', name: 'writer', callId: 'call-0' } })}
          beam={false}
        />
        <ToolCard
          entry={tool({ id: 't2', attribution: { kind: 'unattributed', namespace: ['tools:x'] } })}
          beam={false}
        />
      </>,
    );
    expect(screen.getByText('子代理 writer')).toBeTruthy();
    expect(screen.getByText('未歸屬的子代理')).toBeTruthy();
  });

  it('狀態變化不唸：卡片裡沒有 live region', () => {
    const { container } = render(<ToolCard entry={tool({ status: 'running' })} beam />);
    expect(container.querySelector('[aria-live], [role="status"], [role="alert"]')).toBeNull();
  });
});

describe('對話流裡的工具卡', () => {
  function state(entries: ToolEntry[]): ConversationState {
    return { status: 'running', entries, pendings: [] } as unknown as ConversationState;
  }

  it('執行中的邊框光同時最多一個：給最後一顆還在跑的', () => {
    render(
      <Transcript
        state={state([
          tool({ id: 'a', status: 'running' }),
          tool({ id: 'b', status: 'done' }),
          tool({ id: 'c', status: 'running' }),
        ])}
        isFresh={() => false}
      />,
    );
    const active = screen
      .getAllByTestId('tool-entry')
      .map((card) => card.getAttribute('data-active'));
    expect(active).toEqual(['false', 'false', 'true']);
  });

  it('含工具卡（收著與展開）的對話流過 axe', async () => {
    const { container } = render(
      <Transcript
        state={state([
          tool({ id: 'a', status: 'running', name: 'execute', input: '{"command":"pnpm test"}' }),
          tool({
            id: 'b',
            status: 'failed',
            error: '沒有這個檔',
            attribution: { kind: 'subagent', name: 'writer', callId: 'call-0' },
          }),
          tool({ id: 'c', name: 'mcp__github__create_issue', input: '{"title":"壞了"}' }),
        ])}
        isFresh={() => false}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /執行指令/ }));
    expect(await axeViolations(container)).toEqual([]);
  });
});
