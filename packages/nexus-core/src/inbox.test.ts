/**
 * 送出佇列的折疊（[#637](https://github.com/DemianLi/nexus-agent/issues/637)）。規則照 dsh 的
 * `inboxProjectionDefinition.apply`（`packages/core/agent-loop/src/inbox.ts`，`477b4f4`）：陣列的 `splice`，範圍超出或
 * id 重複就拋。
 */

import { describe, expect, it } from 'vitest';

import { EMPTY_INBOX, foldInbox, spliceInbox } from './inbox.js';
import type { InboxState, QueuedInput } from './inbox.js';
import { SessionLog } from './session-log.js';

const item = (id: string, text = id): QueuedInput => ({ id, text, source: { kind: 'user' } });
const turns = (...items: QueuedInput[]): InboxState => ({ 'next-turn': items, 'next-step': [] });

describe('spliceInbox', () => {
  it('插、領、改、刪都是 splice', () => {
    let inbox = EMPTY_INBOX;
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
    expect(inbox).toEqual(turns(item('a'), item('b', 'B2'), item('c')));
    inbox = spliceInbox(inbox, { target: 'next-turn', start: 0, removedCount: 1, inserted: [] });
    inbox = spliceInbox(inbox, {
      target: 'next-turn',
      start: 1,
      removedCount: 1,
      inserted: [],
      outcome: 'canceled',
    });
    expect(inbox).toEqual(turns(item('b', 'B2')));
  });

  it('範圍超出、id 重複都拋，原清單不動', () => {
    const inbox = turns(item('a'));
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
    expect(inbox).toEqual(turns(item('a')));
  });

  it('兩條清單各自 splice，範圍只看 target 那一條（#710）', () => {
    let inbox = turns(item('a'), item('b'));
    inbox = spliceInbox(inbox, { target: 'next-step', start: 0, inserted: [item('s1')] });
    inbox = spliceInbox(inbox, { target: 'next-step', start: 1, inserted: [item('s2')] });
    expect(inbox).toEqual({
      'next-turn': [item('a'), item('b')],
      'next-step': [item('s1'), item('s2')],
    });
    // 領走整條 next-step：next-turn 不動。
    inbox = spliceInbox(inbox, { target: 'next-step', start: 0, removedCount: 2, inserted: [] });
    expect(inbox).toEqual(turns(item('a'), item('b')));
    // next-turn 有兩件，next-step 是空的：範圍照 next-step 算。
    expect(() =>
      spliceInbox(inbox, { target: 'next-step', start: 1, inserted: [item('s3')] }),
    ).toThrow('（next-step）的變動超出範圍');
  });

  it('id 在兩條清單之間唯一，同 dsh 的折疊', () => {
    const inbox = turns(item('a'));
    expect(() =>
      spliceInbox(inbox, { target: 'next-step', start: 0, inserted: [item('a')] }),
    ).toThrow('已經有一件 id 是 "a"');
    // 排著的一件改成插話：先從 next-turn 拿掉，才接到 next-step。
    const moved = spliceInbox(
      spliceInbox(inbox, {
        target: 'next-turn',
        start: 0,
        removedCount: 1,
        inserted: [],
        outcome: 'canceled',
      }),
      { target: 'next-step', start: 0, inserted: [item('a')] },
    );
    expect(moved).toEqual({ 'next-turn': [], 'next-step': [item('a')] });
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
    expect(foldInbox(resumed.events)).toEqual(turns(item('a'), item('b')));
    expect(foldInbox([])).toEqual(EMPTY_INBOX);
  });

  it('照 target 折進各自那一條；格式 19 以前的日誌只有 next-turn，照樣折得回來', () => {
    const log = new SessionLog('s');
    log.append('inbox/spliced', { target: 'next-turn', start: 0, inserted: [item('a')] });
    log.append('inbox/spliced', { target: 'next-step', start: 0, inserted: [item('s')] });
    log.append('inbox/spliced', { target: 'next-turn', start: 1, inserted: [item('b')] });
    expect(foldInbox(log.events)).toEqual({
      'next-turn': [item('a'), item('b')],
      'next-step': [item('s')],
    });
  });

  it('不合規的那一顆：訊息帶它的 seq', () => {
    const log = new SessionLog('s');
    log.append('turn/start', { kind: 'message', text: 'x' });
    log.append('inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] });
    expect(() => foldInbox(log.events)).toThrow('seq 1');
  });
});
