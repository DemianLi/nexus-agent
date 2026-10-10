/**
 * 送出佇列的折疊（[#637](https://github.com/DemianLi/nexus-agent/issues/637)）。規則照 dsh 的
 * `inboxProjectionDefinition.apply`（`packages/core/agent-loop/src/inbox.ts`，`477b4f4`）：陣列的 `splice`，範圍超出或
 * id 重複就拋。
 */

import { describe, expect, it } from 'vitest';

import { EMPTY_INBOX, findPromptRequest, foldInbox, spliceInbox } from './inbox.js';
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

/** 客戶端帶了請求編號的那一件（#1335）。 */
const requested = (id: string, requestId: string, text = id): QueuedInput => ({
  id,
  text,
  source: { kind: 'user', requestId },
});

describe('findPromptRequest：這個請求編號收過沒有', () => {
  it('還排著：認出來，回那一件的 id（兩條清單都找）', () => {
    const inbox: InboxState = {
      'next-turn': [item('a'), requested('b', 'req-b')],
      'next-step': [requested('s', 'req-s')],
    };
    expect(findPromptRequest(inbox, [], 'req-b')).toEqual({ runId: 'b', stage: 'queued' });
    expect(findPromptRequest(inbox, [], 'req-s')).toEqual({ runId: 's', stage: 'queued' });
    expect(findPromptRequest(inbox, [], 'req-none')).toBeUndefined();
  });

  it('已領走、開了一輪：turn/start 帶的編號與 runId', () => {
    const log = new SessionLog('s');
    log.append('turn/start', { kind: 'message', text: 'X', requestId: 'req-x', runId: 'item-x' });
    expect(findPromptRequest(EMPTY_INBOX, log.events, 'req-x')).toEqual({
      runId: 'item-x',
      stage: 'started',
    });
  });

  it('插話被領走：user/message 的 source 帶編號，run_id 是那則訊息的 id', () => {
    const log = new SessionLog('s');
    log.append('user/message', {
      message: { type: 'human', data: { content: '改用 X', id: 'steer-1' } } as never,
      source: { kind: 'user', requestId: 'req-steer' },
    });
    expect(findPromptRequest(EMPTY_INBOX, log.events, 'req-steer')).toEqual({
      runId: 'steer-1',
      stage: 'started',
    });
  });

  it('沒帶編號的、別的 kind、編號對不上：都不算', () => {
    const log = new SessionLog('s');
    log.append('turn/start', { kind: 'message', text: 'X' });
    log.append('turn/start', {
      kind: 'goal',
      text: 'G',
      goalId: 'g' as never,
      revision: 1,
      round: 1,
    });
    log.append('user/message', {
      message: { type: 'human', data: { content: 'x', id: 'u1' } } as never,
      source: { kind: 'plugin', plugin: 'p' },
    });
    expect(findPromptRequest(EMPTY_INBOX, log.events, 'req-x')).toBeUndefined();
  });

  it('只比編號、不比內容：同編號不同文字也認得', () => {
    const inbox = turns(requested('a', 'req-a', '原本的字'));
    expect(findPromptRequest(inbox, [], 'req-a')?.runId).toBe('a');
  });

  it('被取消的不算：排著的那件刪掉之後，同一個編號再送是新的一句', () => {
    const log = new SessionLog('s');
    log.append('inbox/spliced', {
      target: 'next-turn',
      start: 0,
      inserted: [requested('a', 'req-a')],
    });
    log.append('inbox/spliced', {
      target: 'next-turn',
      start: 0,
      removedCount: 1,
      inserted: [],
      outcome: 'canceled',
    });
    expect(findPromptRequest(foldInbox(log.events), log.events, 'req-a')).toBeUndefined();
  });
});
