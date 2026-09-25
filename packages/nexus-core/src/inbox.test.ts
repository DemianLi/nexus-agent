/**
 * 送出佇列的折疊（[#637](https://github.com/DemianLi/nexus-agent/issues/637)）。規則照 dsh 的
 * `inboxProjectionDefinition.apply`（`packages/core/agent-loop/src/inbox.ts`，`477b4f4`）：陣列的 `splice`，範圍超出或
 * id 重複就拋。
 */

import { describe, expect, it } from 'vitest';

import { foldInbox, spliceInbox } from './inbox.js';
import type { QueuedInput } from './inbox.js';
import { SessionLog } from './session-log.js';

const item = (id: string, text = id): QueuedInput => ({ id, text, source: { kind: 'user' } });

describe('spliceInbox', () => {
  it('插、領、改、刪都是 splice', () => {
    let inbox: readonly QueuedInput[] = [];
    inbox = spliceInbox(inbox, { target: 'next-turn', start: 0, inserted: [item('a')] });
    inbox = spliceInbox(inbox, { target: 'next-turn', start: 1, inserted: [item('b')] });
    inbox = spliceInbox(inbox, { target: 'next-turn', start: 2, inserted: [item('c')] });
    inbox = spliceInbox(inbox, {
      target: 'next-turn',
      start: 1,
      removedCount: 1,
      inserted: [item('b', 'B2')],
      outcome: 'canceled',
    });
    expect(inbox).toEqual([item('a'), item('b', 'B2'), item('c')]);
    inbox = spliceInbox(inbox, { target: 'next-turn', start: 0, removedCount: 1, inserted: [] });
    inbox = spliceInbox(inbox, {
      target: 'next-turn',
      start: 1,
      removedCount: 1,
      inserted: [],
      outcome: 'canceled',
    });
    expect(inbox).toEqual([item('b', 'B2')]);
  });

  it('範圍超出、id 重複都拋，原清單不動', () => {
    const inbox = [item('a')];
    expect(() =>
      spliceInbox(inbox, { target: 'next-turn', start: 2, inserted: [item('b')] }),
    ).toThrow('超出範圍');
    expect(() =>
      spliceInbox(inbox, { target: 'next-turn', start: 0, removedCount: 2, inserted: [] }),
    ).toThrow('超出範圍');
    expect(() => spliceInbox(inbox, { target: 'next-turn', start: -1, inserted: [] })).toThrow(
      '超出範圍',
    );
    expect(() =>
      spliceInbox(inbox, { target: 'next-turn', start: 1, inserted: [item('a')] }),
    ).toThrow('已經有一件 id 是 "a"');
    expect(inbox).toEqual([item('a')]);
  });
});

describe('foldInbox', () => {
  it('從日誌開頭折起，跨 session/end-seed 不重設；只讀 inbox/spliced', () => {
    const first = new SessionLog('s');
    first.append('inbox/spliced', { target: 'next-turn', start: 0, inserted: [item('a')] });
    first.append('turn/start', { kind: 'message', text: 'x' });
    first.append('turn/end', {});
    const resumed = new SessionLog('s', { seed: first.events });
    resumed.append('inbox/spliced', { target: 'next-turn', start: 1, inserted: [item('b')] });
    expect(resumed.events.map((event) => event.type)).toContain('session/end-seed');
    expect(foldInbox(resumed.events)).toEqual([item('a'), item('b')]);
    expect(foldInbox([])).toEqual([]);
  });

  it('不合規的那一顆：訊息帶它的 seq', () => {
    const log = new SessionLog('s');
    log.append('turn/start', { kind: 'message', text: 'x' });
    log.append('inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] });
    expect(() => foldInbox(log.events)).toThrow('seq 1');
  });
});
