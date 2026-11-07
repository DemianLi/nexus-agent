import { emptyConversation } from '@nexus/wire';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ConversationNotices } from '@/components/conversation/conversation-notices';
import { OPENING_TEXT } from '@/components/status-line';
import type { Conversation } from '@/hooks/use-conversation';

afterEach(cleanup);

/** `ConversationNotices` 讀到的必填欄位；其他必填欄位它不讀，所以用 `as` 轉。 */
function conversation(overrides: Partial<Conversation>): Conversation {
  return {
    state: emptyConversation(),
    connected: false,
    slowConnect: false,
    opening: false,
    recovered: false,
    reconnectNow: () => {},
    ...overrides,
  } as Conversation;
}

describe('ConversationNotices 把連線狀態交給狀態列', () => {
  it('開線等了一下（#2343）：狀態列講正在開啟這條對話', () => {
    render(
      <ConversationNotices conversation={conversation({ opening: true })} notice={undefined} />,
    );
    expect(screen.getByRole('status').textContent).toBe(OPENING_TEXT);
  });

  it('停止自動重連給的按鈕字（#2343）交到狀態列的按鈕上', () => {
    render(
      <ConversationNotices
        conversation={conversation({
          refusal: '這條對話停了',
          reconnecting: { wasConnected: true, offline: false, actionLabel: '重新開啟' },
        })}
        notice={undefined}
      />,
    );
    expect(screen.getByRole('button', { name: '重新開啟' })).toBeTruthy();
  });
});
