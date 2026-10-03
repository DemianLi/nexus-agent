import type { Event } from '@nexus/wire';
import { COMPACTION, emptyConversation, INBOX, reduceAll } from '@nexus/wire';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Transcript } from '@/components/transcript';
import { COMPACTION_SUMMARY_MAX_REM } from '@/lib/compaction-view';

/**
 * 壓縮標記（[#944](https://github.com/DemianLi/nexus-agent/issues/944)）。狀態從真的 frame 用 `reduceAll` 折出來：
 * `custom` 事件、`data.name` 是 `COMPACTION`，位置就是它在串流裡的位置（回覆之後，#896）。
 */

afterEach(cleanup);

let seq = 0;
function frame(method: string, namespace: readonly string[], data: unknown): Event {
  const current = seq++;
  return {
    type: 'event',
    seq: current,
    event_id: `t:${current}`,
    method,
    params: { namespace, timestamp: 0, data },
  } as Event;
}

const ROOT = ['model_request:1'];
const asked = (text: string): Event =>
  ({
    type: 'event',
    event_id: 't:asked',
    method: 'custom',
    params: {
      namespace: [],
      timestamp: 0,
      data: { name: INBOX, payload: { items: [], claimed: { id: 'q', text } } },
    },
  }) as Event;

const reply = (id: string, text: string): Event[] => [
  frame('messages', ROOT, { event: 'message-start', id: `run-${id}`, run_id: id }),
  frame('messages', ROOT, {
    event: 'content-block-delta',
    index: 0,
    delta: { type: 'text-delta', text },
    run_id: id,
  }),
  frame('messages', ROOT, { event: 'message-finish', reason: 'stop', run_id: id }),
];

const compaction = (payload: {
  seq: number;
  cutoff: number;
  saved: boolean;
  summary?: string;
}): Event => frame('custom', [], { name: COMPACTION, payload });

function show(events: Event[]) {
  seq = 0;
  const state = reduceAll(emptyConversation(), [asked('問'), ...events]);
  render(<Transcript state={state} isFresh={() => false} />);
}

const row = () => screen.getByTestId('compaction-row');

describe('壓縮列（#944）', () => {
  it('預設收合一行字：前 N 則換成了摘要；有摘要才有展開鈕，按了才看得到全文', () => {
    show([
      frame('lifecycle', [], { event: 'running', graph_name: 'root' }),
      ...reply('a', '好的'),
      compaction({ seq: 100, cutoff: 12, saved: true, summary: '## 目標\n\n**修好登入**' }),
    ]);
    expect(row().textContent).toContain('對話已壓縮：前 12 則換成了摘要');
    const trigger = screen.getByRole('button', { name: /對話已壓縮/ });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('修好登入')).toBeNull();

    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('修好登入').tagName).toBe('STRONG');

    fireEvent.click(trigger);
    expect(screen.queryByText('修好登入')).toBeNull();
  });

  it('沒有摘要（舊日誌）：一行不能點的字，沒有按鈕；只有空白的摘要也算沒有', () => {
    show([
      ...reply('a', '好的'),
      compaction({ seq: 100, cutoff: 3, saved: true }),
      compaction({ seq: 101, cutoff: 5, saved: true, summary: '  \n ' }),
    ]);
    expect(screen.getAllByTestId('compaction-row')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /對話已壓縮/ })).toBeNull();
    expect(screen.getAllByTestId('compaction-row')[0]!.textContent).toContain('前 3 則');
  });

  it('`saved: false` 同一行多一句「原文未另存」，不用警示色；存了的沒有這句', () => {
    show([
      ...reply('a', '好的'),
      compaction({ seq: 100, cutoff: 3, saved: false, summary: '摘要' }),
      compaction({ seq: 101, cutoff: 5, saved: true, summary: '摘要' }),
    ]);
    const [unsaved, saved] = screen.getAllByTestId('compaction-row');
    expect(unsaved!.textContent).toContain('原文未另存');
    expect(saved!.textContent).not.toContain('原文未另存');
    expect(unsaved!.outerHTML).not.toContain('destructive');
  });

  it('展開區有畫面上的行數上限，超過就在區內捲', () => {
    const long = Array.from({ length: 400 }, (_, i) => `第 ${i} 行`).join('\n\n');
    show([...reply('a', '好的'), compaction({ seq: 100, cutoff: 9, saved: true, summary: long })]);
    fireEvent.click(screen.getByRole('button', { name: /對話已壓縮/ }));
    const box = screen.getByTestId('compaction-summary');
    expect(box.style.maxHeight).toBe(`${COMPACTION_SUMMARY_MAX_REM}rem`);
    expect(box.className).toContain('overflow-y-auto');
  });

  it('不取代被蓋掉的列、落在回覆之後；同一個 seq 只長一格', () => {
    show([
      frame('lifecycle', [], { event: 'running', graph_name: 'root' }),
      ...reply('a', '前一則回覆'),
      compaction({ seq: 100, cutoff: 4, saved: true }),
      compaction({ seq: 100, cutoff: 4, saved: true }),
    ]);
    expect(screen.getAllByTestId('compaction-row')).toHaveLength(1);
    const text = screen.getByText('前一則回覆');
    expect(text).toBeTruthy();
    expect(text.compareDocumentPosition(row()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
