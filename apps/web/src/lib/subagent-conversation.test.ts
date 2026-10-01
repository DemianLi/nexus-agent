import type { Event, ThreadHistoryResult } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import {
  foldSubagentHistory,
  RETURN_GUIDANCE_MARKER,
  taskText,
  unmatchedEchoes,
} from './subagent-conversation';

const frame = (method: string, data: unknown): Event =>
  ({ type: 'event', method, params: { namespace: [], timestamp: 0, data } }) as Event;

const said = (role: 'human' | 'ai', id: string, text: string): Event[] => [
  frame('messages', { event: 'message-start', role, id }),
  frame('messages', {
    event: 'content-block-delta',
    index: 0,
    delta: { type: 'text-delta', text },
    id,
  }),
  frame('messages', { event: 'message-finish', reason: 'stop', id }),
];

const page = (events: Event[], hasMore = false): ThreadHistoryResult => ({
  events,
  firstSeq: 0,
  throughSeq: 10,
  hasMore,
  legacy: false,
});

describe('背景子代理自己那份對話（#861）', () => {
  it('折成獨立的對話：人話、回覆、工具卡都在；第一則人話去掉回報指示', () => {
    const { entries, hasMore } = foldSubagentHistory(
      page(
        [
          frame('lifecycle', { event: 'running', graph_name: 'root' }),
          ...said('human', 'h1', `查三個檔案${RETURN_GUIDANCE_MARKER}"root"。收尾前回報。`),
          frame('tools', {
            event: 'tool-started',
            tool_call_id: 'c1',
            tool_name: 'look',
            input: '{}',
          }),
          frame('tools', { event: 'tool-finished', tool_call_id: 'c1', message: '看過了' }),
          ...said('ai', 'a1', '查完了'),
          ...said('human', 'h2', '先看 A'),
          frame('lifecycle', { event: 'completed', graph_name: 'root' }),
        ],
        true,
      ),
    );
    expect(hasMore).toBe(true);
    expect(entries.map((entry) => entry.kind)).toEqual(['human', 'tool', 'ai', 'human']);
    expect(entries[0]).toMatchObject({ text: '查三個檔案' });
    expect(entries[3]).toMatchObject({ text: '先看 A' });
  });

  it('只有第一則人話被去掉指示：後面人說的話原樣留著，就算裡面剛好有那句英文', () => {
    const later = `順便說${RETURN_GUIDANCE_MARKER}x`;
    const { entries } = foldSubagentHistory(
      page([...said('human', 'h1', '任務'), ...said('human', 'h2', later)]),
    );
    expect(entries[1]).toMatchObject({ text: later });
  });

  it('認不得指示（措辭改了）就原樣畫，不吃掉字', () => {
    expect(taskText('查檔案\n\nParent is root')).toBe('查檔案\n\nParent is root');
    expect(taskText('只有任務')).toBe('只有任務');
  });

  it('只留人話、回覆與工具卡：折疊器為別的情境長出來的（通知）不進這一區', () => {
    const settled = frame('custom', {
      name: 'inbox',
      payload: {
        items: [],
        claimed: { id: 'n', text: 'x', source: { kind: 'subagent-settled' } },
      },
    });
    const folded = foldSubagentHistory(page([settled, ...said('ai', 'a1', '好')]));
    expect(folded.entries.map((entry) => entry.kind)).toEqual(['ai']);
  });

  it('空的一頁是空的對話', () => {
    expect(foldSubagentHistory(page([]))).toEqual({ entries: [], hasMore: false });
  });

  it('本地回聲：歷史已有的消掉（一對一），還沒有的留下；同一句說兩次要兩則才消兩次', () => {
    const entries = foldSubagentHistory(
      page([...said('human', 'h1', '任務'), ...said('human', 'h2', '先看 A')]),
    ).entries;
    expect(unmatchedEchoes(['先看 A'], entries)).toEqual([]);
    expect(unmatchedEchoes(['先看 A', '再看 B'], entries)).toEqual(['再看 B']);
    expect(unmatchedEchoes(['先看 A', '先看 A'], entries)).toEqual(['先看 A']);
    expect(unmatchedEchoes(['  先看 A '], entries)).toEqual([]);
    expect(unmatchedEchoes(['先看 A'], [])).toEqual(['先看 A']);
  });
});
