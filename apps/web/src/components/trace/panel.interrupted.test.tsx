import type { ConversationState } from '@nexus/wire';
import { emptyConversation, reduceAll } from '@nexus/wire';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RightSidebarToggle } from '@/components/sidebar/right-sidebar';
import { createConversationStore } from '@/lib/conversation-store';
import { LAYOUT_KEY_PREFIX } from '@/lib/right-sidebar';
import type { SidebarLayout } from '@/lib/right-sidebar';
import { traceModel } from '@/lib/trace-view';
import { Script } from '@/test/conversation-frames';
import { memoryStorage, WithRightSidebar } from '@/test/right-sidebar';
import { call, digest, tool, turn, view, withTrajectory } from '@/test/trajectory-fixtures';

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const open: SidebarLayout = { open: true, tabs: [{ kind: 'trace' }], active: 'trace' };

/** 一輪一次呼叫、一顆帶 `code` 失敗的工具。 */
function conversation(code: string, extra?: Parameters<typeof turn>[1]): ConversationState {
  const script = new Script();
  const frames = [
    script.running(),
    ...script.human('inbox:r0', '第 0 句'),
    script.started('c0', 'echo', {}),
    script.failed('c0', 'Error: tool call aborted', code),
    script.completed(),
  ];
  return withTrajectory(
    reduceAll(emptyConversation(), frames),
    script,
    view([
      turn(0, {
        toolErrors: 1,
        calls: [call(5, { tools: [tool('c0', { name: 'echo', status: 'error', code })] })],
        ...extra,
      }),
    ]),
  );
}

function mount(state: ConversationState) {
  localStorage.setItem(LAYOUT_KEY_PREFIX + 't', JSON.stringify(open));
  return render(
    <WithRightSidebar sources={{ conversation: createConversationStore(state) }}>
      <RightSidebarToggle />
    </WithRightSidebar>,
  );
}

const head = () => screen.getByTestId('trace-turn-head').textContent;
const row = () =>
  screen
    .getAllByTestId('trace-row')
    .find((candidate) => candidate.querySelector('[data-testid="trace-error-code"]') !== null)!;

describe('觀測分頁：被中止的工具不寫成失敗（#2247）', () => {
  it.each([
    ['ABORTED', '已停止'],
    ['ABORTED_BEFORE_DISPATCH', '沒有執行'],
  ])('%s：工具列寫「%s」、沒有危險色、原碼留著，標頭不數', async (code, label) => {
    mount(conversation(code));
    await act(async () => {});
    expect(row().textContent).toContain(label);
    expect(row().textContent).not.toContain('失敗');
    expect(row().querySelector('[data-testid="trace-error-code"]')!.textContent).toBe(code);
    expect(row().innerHTML).not.toContain('text-destructive');
    expect(head()).toContain('1 個工具');
    expect(head()).not.toContain('個失敗');
  });

  it('工具自己失敗的：紅字失敗，標頭照數', async () => {
    mount(conversation('FS_NO_SPACE'));
    await act(async () => {});
    expect(row().textContent).toContain('失敗');
    expect(row().innerHTML).toContain('text-destructive');
    expect(head()).toContain('1 個工具（1 個失敗）');
  });

  it('被單輪上限摺掉的工具拿不到碼：標頭維持投影的數', async () => {
    mount(conversation('ABORTED', { toolCount: 3, toolErrors: 3 }));
    await act(async () => {});
    expect(head()).toContain('3 個工具（2 個失敗）');
  });

  it('只有摘要的輪拿不到碼：標頭維持投影的數', () => {
    const script = new Script();
    const frames = [1, 2].flatMap((n) => [
      script.running(),
      ...script.human(`inbox:r${n}`, `第 ${n} 輪`),
      ...script.ai(`m${n}`, { text: `第 ${n} 輪的回覆` }),
      script.completed(),
    ]);
    const state = withTrajectory(
      reduceAll(emptyConversation(), frames),
      script,
      view([turn(2)], { digests: [digest(1, { toolCount: 1, toolErrors: 1 })] }),
    );
    expect(traceModel(state).digests.map((one) => one.toolErrors)).toEqual([1]);
  });
});
