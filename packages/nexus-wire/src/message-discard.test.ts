/**
 * `message-discard`（#520）的折疊：只拿 AI 回覆、找不到與重複都是 no-op、畫面其餘原樣。
 */

import { describe, expect, it } from 'vitest';

import { emptyConversation, reduceAll } from './conversation.js';
import { MESSAGE_DISCARD } from './message-discard.js';
import type { Event } from './protocol.js';

let seq = 0;
function event(method: string, data: unknown): Event {
  const current = seq++;
  return {
    type: 'event',
    seq: current,
    event_id: `c:${current}`,
    method,
    params: { namespace: [], timestamp: 0, data },
  } as Event;
}

const start = (runId: string, id: string) =>
  event('messages', { event: 'message-start', role: 'ai', run_id: runId, id });
const delta = (runId: string, text: string) =>
  event('messages', {
    event: 'content-block-delta',
    run_id: runId,
    delta: { type: 'text-delta', text },
  });
const discard = (payload: unknown) => event('custom', { name: MESSAGE_DISCARD, payload });
const fold = (...frames: Event[]) => reduceAll(emptyConversation(), frames);

describe('message-discard', () => {
  it('依日誌訊息 id 拿掉那一則：重試前吐一半的回覆消失，重試後的那則留著', () => {
    const state = fold(
      start('r1', 'run-r1'),
      delta('r1', '寫到一半'),
      discard({ messageId: 'run-r1' }),
      start('r2', 'run-r2'),
      delta('r2', '完整的回答'),
    );
    expect(state.entries.map((e) => (e.kind === 'ai' ? e.text : e.kind))).toEqual(['完整的回答']);
  });

  it('也認串流的 run_id（entry 的 id）', () => {
    const state = fold(start('r1', 'run-r1'), delta('r1', '半'), discard({ messageId: 'r1' }));
    expect(state.entries).toEqual([]);
  });

  it('找不到、重複送、酬載壞掉：entries 原樣（同一個陣列；lastSeq 照走）', () => {
    const before = fold(start('r1', 'run-r1'), delta('r1', '字'));
    for (const payload of [{ messageId: 'nope' }, {}, { messageId: '' }, { messageId: 3 }]) {
      expect(reduceAll(before, [discard(payload)]).entries).toBe(before.entries);
    }
    const once = reduceAll(before, [discard({ messageId: 'run-r1' })]);
    expect(reduceAll(once, [discard({ messageId: 'run-r1' })]).entries).toBe(once.entries);
  });

  it('只拿 AI 回覆：同 id 的人話不動', () => {
    const state = fold(
      event('messages', { event: 'message-start', role: 'human', run_id: 'h1' }),
      discard({ messageId: 'h1' }),
    );
    expect(state.entries).toHaveLength(1);
  });
});
