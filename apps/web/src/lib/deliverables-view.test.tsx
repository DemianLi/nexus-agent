import type { ConversationState, DeliverablesPresentedPayload, Event } from '@nexus/wire';
import { appendHumanTurn, DELIVERABLES_PRESENTED, emptyConversation, reduceAll } from '@nexus/wire';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Transcript } from '@/components/transcript';
import { transcriptItems } from '@/lib/deliverables-view';

/**
 * 交付卡片歸到它那一輪的尾端（#441 第二刀）。狀態從真的 frame 用 `reduceAll` 折出來，折疊器怎麼放那一格在
 * `@nexus/wire` 的 `deliverables.test.ts`；這裡驗 web 怎麼切輪、畫在哪。
 */

afterEach(cleanup);

const ROOT = ['model_request:1'];

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

const running = () => frame('lifecycle', [], { event: 'running', graph_name: 'root' });
const completed = () => frame('lifecycle', [], { event: 'completed', graph_name: 'root' });

function reply(id: string, text: string): Event[] {
  return [
    frame('messages', ROOT, { event: 'message-start', id: `run-${id}`, run_id: id }),
    frame('messages', ROOT, {
      event: 'content-block-delta',
      index: 0,
      delta: { type: 'text-delta', text },
      run_id: id,
    }),
    frame('messages', ROOT, { event: 'message-finish', reason: 'stop', run_id: id }),
  ];
}

function present(callId: string, paths: readonly string[]): Event[] {
  const namespace = [`tools:${callId}`];
  return [
    frame('tools', namespace, {
      event: 'tool-started',
      tool_call_id: callId,
      tool_name: 'present',
      input: JSON.stringify({ files: paths.map((path) => ({ path })) }),
    }),
    frame('tools', namespace, {
      event: 'tool-finished',
      tool_call_id: callId,
      tool_name: 'present',
      output: paths.map((path) => `Presented ${path}`).join('\n'),
    }),
  ];
}

function delivered(payload: DeliverablesPresentedPayload): Event {
  return frame('custom', [], { name: DELIVERABLES_PRESENTED, payload });
}

/** 一輪：frame 照線上的順序取 seq，所以本體要在 `running` 之後才建（先建的 seq 比較小，會被當成重複丟掉）。 */
function turn(text: string, events: () => Event[], from = emptyConversation()): ConversationState {
  const start = running();
  const body = events();
  return reduceAll(appendHumanTurn(from, text), [start, ...body, completed()]);
}

/** 每一格的種類；交付卡寫成 `卡:路徑,路徑`。 */
function layout(state: ConversationState): string[] {
  return transcriptItems(state.entries).map((item) =>
    item.kind === 'deliverables'
      ? `卡:${item.files.map((file) => file.path).join(',')}`
      : item.entry.kind,
  );
}

describe('交付卡片歸到輪尾', () => {
  it('夾在工具卡與最後那段話之間的交付，畫在這一輪最後一格之後', () => {
    const state = turn('交付。', () => [
      ...present('c1', ['a.md']),
      delivered({ callId: 'c1', files: [{ path: 'a.md', description: '報告' }] }),
      ...reply('r1', '好了。'),
    ]);
    expect(state.entries.map((entry) => entry.kind)).toEqual([
      'human',
      'tool',
      'deliverables',
      'ai',
    ]);
    expect(layout(state)).toEqual(['human', 'tool', 'ai', '卡:a.md']);
  });

  it('同一輪兩次 present 收攏成一張，順序照宣告；卡的 id 是第一顆交付那一格的', () => {
    const state = turn('兩次。', () => [
      ...present('c1', ['a.md']),
      delivered({ callId: 'c1', files: [{ path: 'a.md' }] }),
      ...present('c2', ['b.md', 'c.md']),
      delivered({ callId: 'c2', files: [{ path: 'b.md' }, { path: 'c.md' }] }),
      ...reply('r1', '好了。'),
    ]);
    expect(layout(state)).toEqual(['human', 'tool', 'tool', 'ai', '卡:a.md,b.md,c.md']);
    expect(transcriptItems(state.entries).at(-1)?.id).toBe('deliverables:c1');
  });

  it('只有工具、沒有文字的輪（沒有輪尾）照樣有卡，而且不跑到下一輪', () => {
    const first = turn('只交付。', () => [
      ...present('c1', ['a.md']),
      delivered({ callId: 'c1', files: [{ path: 'a.md' }] }),
    ]);
    const second = turn('再來。', () => reply('r2', '嗯。'), first);
    expect(layout(second)).toEqual(['human', 'tool', '卡:a.md', 'human', 'ai']);
  });

  it('失敗的 present 沒有交付事件，就沒有卡', () => {
    const state = turn('交付。', () => [...present('c1', ['a.md']), ...reply('r1', '好了。')]);
    expect(layout(state)).toEqual(['human', 'tool', 'ai']);
  });

  it('畫在 Transcript 裡：卡跟在回覆後面，卡裡是那幾個檔', () => {
    const state = turn('交付。', () => [
      ...present('c1', ['out/report.pdf']),
      delivered({ callId: 'c1', files: [{ path: 'out/report.pdf', description: '季報' }] }),
      ...reply('r1', '好了。'),
    ]);
    render(<Transcript state={state} isFresh={() => false} />);
    const card = screen.getByRole('region', { name: '這一輪交付的檔案，共 1 個' });
    const reply1 = screen.getByTestId('ai-entry');
    expect(reply1.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(card).getByTestId('deliverable').textContent).toBe(
      'report.pdf季報out/report.pdf',
    );
  });
});
