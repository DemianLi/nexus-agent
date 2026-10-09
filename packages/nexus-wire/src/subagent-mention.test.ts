/**
 * 點名子代理在折疊器裡的樣子（[#328](https://github.com/DemianLi/nexus-agent/issues/328) 第 2 項）：排著的件、領走時的人話、歷史重播的人話都帶 `mention`；
 * 壞掉的點名當沒有（畫不出標記，但話不能因此丟掉）。產出這些 frame 的一半在 `apps/harness/src/subagent-mention-*.test.ts`。
 */

import { describe, expect, it } from 'vitest';

import { emptyConversation, reduceAll } from './conversation.js';
import { INBOX } from './inbox.js';
import type { Event } from './protocol.js';
import { isSubagentMention, mentionField } from './subagent-list.js';

let seq = 0;
function frame(method: string, data: unknown): Event {
  const current = seq++;
  return {
    type: 'event',
    seq: current,
    event_id: `m:${current}`,
    method,
    params: { namespace: [], timestamp: 0, data },
  } as Event;
}

const inboxFrame = (payload: unknown): Event => frame('custom', { name: INBOX, payload });
const fold = (...frames: Event[]) => reduceAll(emptyConversation(), frames);

const MENTION = { kind: 'subagent', name: 'reviewer' } as const;
const queued = { id: 'q1', text: '看 diff', source: { kind: 'user' } } as const;

describe('點名在折疊器裡', () => {
  it('排著的件（items／nextStep）帶 mention 進 state.inbox 與 state.inboxNextStep；沒點名不帶這一格', () => {
    const state = fold(
      inboxFrame({
        items: [
          { ...queued, mention: MENTION },
          { id: 'q2', text: '沒點名', source: { kind: 'user' } },
        ],
        nextStep: [{ ...queued, id: 'q3', mention: MENTION }],
      }),
    );
    expect(state.inbox).toEqual([
      { ...queued, mention: MENTION },
      { id: 'q2', text: '沒點名', source: { kind: 'user' } },
    ]);
    expect(state.inboxNextStep).toEqual([{ ...queued, id: 'q3', mention: MENTION }]);
  });

  it('claimed 與 claimedNextStep 的 mention 折進人的話；只留認得的欄位', () => {
    const state = fold(
      inboxFrame({
        items: [],
        claimed: { id: 'a', text: '開場', mention: { ...MENTION, secret: 'x' } },
        claimedNextStep: [
          { id: 'b', text: '插話', mention: MENTION },
          { id: 'c', text: '沒點名' },
        ],
      }),
    );
    expect(state.entries).toEqual([
      { kind: 'human', id: 'inbox:a', text: '開場', inboxId: 'a', mention: MENTION },
      { kind: 'human', id: 'inbox:b', text: '插話', inboxId: 'b', mention: MENTION },
      { kind: 'human', id: 'inbox:c', text: '沒點名', inboxId: 'c' },
    ]);
  });

  it('歷史重播的人話（message-start）帶 mention', () => {
    const state = fold(
      frame('messages', { event: 'message-start', role: 'human', id: 'h1', mention: MENTION }),
      frame('messages', { event: 'message-start', role: 'human', id: 'h2' }),
    );
    expect(state.entries).toMatchObject([
      { kind: 'human', id: 'h1', mention: MENTION },
      { kind: 'human', id: 'h2' },
    ]);
    expect('mention' in state.entries[1]!).toBe(false);
  });

  it('壞掉的點名當沒有：話照收、排著的件照列，只是沒有這一格', () => {
    for (const bad of [
      { kind: 'skill', name: 'x' },
      { kind: 'subagent', name: '' },
      'reviewer',
      7,
    ]) {
      const state = fold(
        inboxFrame({
          items: [{ ...queued, mention: bad }],
          claimed: { id: 'a', text: '開場', mention: bad },
        }),
      );
      expect(state.inbox, JSON.stringify(bad)).toEqual([queued]);
      expect(state.entries, JSON.stringify(bad)).toEqual([
        { kind: 'human', id: 'inbox:a', text: '開場', inboxId: 'a' },
      ]);
    }
  });
});

describe('isSubagentMention／mentionField', () => {
  it('kind 是 subagent、name 是非空字串才算', () => {
    expect(isSubagentMention(MENTION)).toBe(true);
    expect(isSubagentMention({ kind: 'subagent', name: '' })).toBe(false);
    expect(isSubagentMention({ kind: 'skill', name: 'x' })).toBe(false);
    expect(isSubagentMention(null)).toBe(false);
    expect(mentionField(undefined)).toEqual({});
    expect(mentionField({ ...MENTION, extra: 1 })).toEqual({ mention: MENTION });
  });
});
