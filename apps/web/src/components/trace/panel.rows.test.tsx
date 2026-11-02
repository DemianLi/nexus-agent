import type { ConversationState } from '@nexus/wire';
import { emptyConversation, reduceAll, reduceConversation } from '@nexus/wire';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createConversationStore } from '@/lib/conversation-store';
import { LAYOUT_KEY_PREFIX } from '@/lib/right-sidebar';
import { Script } from '@/test/conversation-frames';
import { memoryStorage, WithRightSidebar } from '@/test/right-sidebar';

/**
 * 串流中只有正在長的那一列重畫（#1033）。**單獨一個檔**：要把 `ReasoningRow` 換成會數次數的替身，
 * `vi.mock` 是整個檔生效，不能跟其他測試混在一起。
 *
 * 光看 DOM 不夠：React 重畫同一棵樹會沿用同一批節點、字也一樣，`memo` 拿掉也看不出來。所以數替身被畫了幾次。
 */
const renders = vi.hoisted(() => ({ thinking: 0 }));

vi.mock('@/components/reasoning-row', () => ({
  ReasoningRow: ({ text }: { text: string }) => {
    renders.thinking += 1;
    return <p data-testid="reasoning-stub">{text}</p>;
  },
}));

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  renders.thinking = 0;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('觀測分頁：沒變的列不重畫', () => {
  it('第二則回覆在串流，第一則的思考列（條目沒動）不重畫；對照：正在長的那一列有重畫', async () => {
    const script = new Script();
    let state: ConversationState = reduceAll(emptyConversation(), [
      script.running(),
      ...script.human('history-0', '先想一想'),
      ...script.ai('first', { reasoning: '第一則的思考', text: '第一則回覆' }),
      script.openAi('live'),
      script.delta('live', '開頭'),
    ]);
    localStorage.setItem(
      LAYOUT_KEY_PREFIX + 't',
      JSON.stringify({ open: true, tabs: [{ kind: 'trace' }], active: 'trace' }),
    );
    const store = createConversationStore(state);
    const view = render(
      <WithRightSidebar sources={{ conversation: store }}>{null}</WithRightSidebar>,
    );
    await act(async () => {});
    const first = renders.thinking;
    expect(first).toBeGreaterThan(0);

    for (const piece of ['，續', '寫', '下去']) {
      state = reduceConversation(state, script.delta('live', piece));
      await act(async () => store.set(state));
    }
    // 正在長的那一列確實跟著畫了（量具沒壞）。
    expect(view.container.textContent).toContain('開頭，續寫下去');
    // 沒動的思考列一次都沒多畫。
    expect(renders.thinking).toBe(first);
  });
});
