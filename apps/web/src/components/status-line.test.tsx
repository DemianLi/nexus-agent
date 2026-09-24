import { emptyConversation } from '@nexus/wire';
import type { ConversationState } from '@nexus/wire';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StatusLine } from '@/components/status-line';

afterEach(cleanup);

const idle = emptyConversation();

describe('StatusLine 的連線那幾句（#593）', () => {
  it('連上過、中斷了：講正在重新連線，旁邊一顆「立刻重連」，按鈕不在 live region 裡', () => {
    const onReconnect = vi.fn();
    render(
      <StatusLine
        state={idle}
        connected={false}
        connectionError="network error"
        reconnecting={{ wasConnected: true, offline: false }}
        onReconnect={onReconnect}
      />,
    );
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('連線中斷，正在重新連線…');
    const button = screen.getByRole('button', { name: '立刻重連' });
    expect(status.contains(button)).toBe(false);
    fireEvent.click(button);
    expect(onReconnect).toHaveBeenCalledOnce();
  });

  it('從沒連上過：講連不上與原因', () => {
    render(
      <StatusLine
        state={idle}
        connected={false}
        connectionError="connection refused"
        reconnecting={{ wasConnected: false, offline: false }}
      />,
    );
    expect(screen.getByRole('status').textContent).toBe(
      '連不上 agent：connection refused。正在重試…',
    );
  });

  it('瀏覽器離線：講恢復之後會自動重連', () => {
    render(
      <StatusLine
        state={idle}
        connected={false}
        reconnecting={{ wasConnected: true, offline: true }}
      />,
    );
    expect(screen.getByRole('status').textContent).toBe('網路離線：恢復之後會自動重新連線');
  });

  it('剛接回來：就緒那一格換成「已重新連線」', () => {
    render(<StatusLine state={idle} connected recovered />);
    expect(screen.getByRole('status').textContent).toBe('已重新連線');
  });

  it('剛接回來但正在跑：講執行中，不蓋掉', () => {
    const running: ConversationState = { ...idle, status: 'running' };
    render(<StatusLine state={running} connected recovered />);
    expect(screen.getByRole('status').textContent).toContain('執行中');
  });
});
