import type { ConversationState } from '@nexus/wire';
import { emptyConversation, reduceAll } from '@nexus/wire';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RightSidebarToggle } from '@/components/right-sidebar';
import { TRACE_WAITING_LABEL } from '@/components/trace-turn-head';
import { createConversationStore } from '@/lib/conversation-store';
import { LAYOUT_KEY_PREFIX } from '@/lib/right-sidebar';
import type { SidebarLayout } from '@/lib/right-sidebar';
import { traceModel } from '@/lib/trace-view';
import { Script } from '@/test/conversation-frames';
import { memoryStorage, WithRightSidebar } from '@/test/right-sidebar';
import { call, tool, turn, view, withTrajectory } from '@/test/trajectory-fixtures';

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const open: SidebarLayout = { open: true, tabs: [{ kind: 'trace' }], active: 'trace' };

type TurnSpec = Parameters<typeof turn>[1];

/**
 * 每輪一次呼叫、一顆工具（對話裡有對應的工具卡，投影的輪才歸得進去）。最後一輪的工具停在中斷點（日誌上照常 `turn/end`，
 * 所以投影的收尾是 `completed`）；`pause` 決定掛著核准、問答或什麼都沒有。
 */
function paused(
  pause: 'approval' | 'question' | 'none',
  specs: TurnSpec[] = [{}],
): ConversationState {
  const script = new Script();
  const frames = [script.running()];
  const turns = specs.map((spec, i) => {
    const last = i === specs.length - 1;
    frames.push(...script.human(`inbox:r${i}`, `第 ${i} 句`));
    frames.push(script.started(`c${i}`, 'write_file', {}));
    if (!last || pause === 'none') frames.push(script.finished(`c${i}`, 'ok'));
    return turn(i, {
      end: 'completed',
      ...spec,
      calls: [
        call(5 + i * 10, {
          tools: [
            tool(`c${i}`, {
              name: 'write_file',
              ...(last && pause !== 'none' ? { status: 'running' as const } : {}),
            }),
          ],
        }),
      ],
    });
  });
  if (pause === 'approval') frames.push(script.approval('i1', 'write_file'));
  if (pause === 'question') frames.push(script.question('q1'));
  if (pause === 'none') frames.push(script.completed());
  return withTrajectory(reduceAll(emptyConversation(), frames), script, view(turns));
}

function mount(state: ConversationState) {
  localStorage.setItem(LAYOUT_KEY_PREFIX + 't', JSON.stringify(open));
  return render(
    <WithRightSidebar sources={{ conversation: createConversationStore(state) }}>
      <RightSidebarToggle />
    </WithRightSidebar>,
  );
}

const head = () => screen.getAllByTestId('trace-turn-head').at(-1)!;

describe('觀測分頁：停在等人的那一輪，標頭不寫「完成」', () => {
  it('停在核准：寫「停在核准點」，不寫「完成」；耗時照寫（是停下來前那一段）', async () => {
    mount(paused('approval'));
    await act(async () => {});
    expect(screen.getByTestId('trace-head-waiting').textContent).toBe(TRACE_WAITING_LABEL.approval);
    expect(head().textContent).not.toContain('完成');
    expect(head().textContent).toContain('耗時');
    expect(head().textContent).toContain('1 次呼叫');
  });

  it('停在問答：寫「停在提問」', async () => {
    mount(paused('question'));
    await act(async () => {});
    expect(screen.getByTestId('trace-head-waiting').textContent).toBe(TRACE_WAITING_LABEL.question);
  });

  it('沒有掛著的中斷（核准有了結局、續接併回同一組）：照常寫收尾與耗時', async () => {
    mount(paused('none', [{}, { kind: 'resume', logical: false }]));
    await act(async () => {});
    expect(screen.queryByTestId('trace-head-waiting')).toBeNull();
    expect(head().textContent).toContain('完成');
    expect(head().textContent).toContain('耗時');
    expect(head().textContent).toContain('2 次呼叫');
  });

  it('只標最後一組：更早的輪就算對話現在掛著中斷，仍寫它自己的收尾', async () => {
    mount(paused('approval', [{}, {}]));
    await act(async () => {});
    const heads = screen.getAllByTestId('trace-turn-head');
    expect(heads).toHaveLength(2);
    expect(heads[0]!.textContent).toContain('完成');
    expect(heads[1]!.textContent).toContain(TRACE_WAITING_LABEL.approval);
  });

  it('最後一組的收尾若是停止或失敗：那是真的結束了，照寫', () => {
    for (const end of ['aborted', 'failed'] as const) {
      const model = traceModel(paused('approval', [{ end }]));
      expect(model.turns.at(-1)!.head?.waiting).toBeUndefined();
      expect(model.turns.at(-1)!.head?.end).toBe(end);
    }
  });

  it('還沒收尾（進行中）又掛著核准：也寫等待，不寫「進行中」', () => {
    const model = traceModel(paused('approval', [{ end: undefined }]));
    expect(model.turns.at(-1)!.head?.waiting).toBe('approval');
  });
});
