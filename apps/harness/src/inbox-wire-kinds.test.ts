/**
 * 佇列件的每一種來源，harness 真的送出去的 `inbox` frame，**餵給 `@nexus/wire` 的折疊器，件數一件都不少**。
 *
 * 為什麼存在：#1242 給佇列加了 `goal` 來源，harness 這一側的投影（`inboxData`）與型別都跟著改了，wire 折疊器裡手寫的
 * 來源守衛卻沒改；含 goal 件的 frame 因此整顆被丟，連同一份裡人的件。兩邊各自的測試都綠——一邊只驗產出、一邊只驗收到
 * 手寫的樣本，沒有一條把產出餵給收的那一邊（#1243）。
 *
 * 表以 core 的聯集為鍵：加一種來源，這裡當場編不過，逼著補樣本，而不是等到執行期才整顆丟掉。
 */

import { goalId } from '@nexus/core';
import type { InboxState, QueuedInput, QueuedInputSource } from '@nexus/core';
import { emptyConversation, INBOX, reduceConversation } from '@nexus/wire';
import type { Event } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { inboxData } from './conversation-history.js';

/** 每一種來源各一個樣本。 */
const SAMPLES: {
  readonly [K in QueuedInputSource['kind']]: Extract<QueuedInputSource, { kind: K }>;
} = {
  user: { kind: 'user' },
  'subagent-settled': {
    kind: 'subagent-settled',
    summary: '做完了',
    reason: 'completed',
    senderSessionId: 'child-1',
  },
  'agent-message': { kind: 'agent-message', senderSessionId: 'child-1' },
  goal: { kind: 'goal', goalId: goalId('goal-1'), revision: 1, round: 1 },
};

let seq = 0;
function frameOf(payload: unknown): Event {
  const current = seq++;
  return {
    type: 'event',
    seq: current,
    event_id: `k:${current}`,
    method: 'custom',
    params: { namespace: [], timestamp: 0, data: { name: INBOX, payload } },
  } as Event;
}

const item = (id: string, source: QueuedInputSource): QueuedInput => ({ id, text: id, source });
const human = (id: string): QueuedInput => item(id, { kind: 'user' });

describe('harness 送出的 inbox frame，wire 折疊器每一種來源都收', () => {
  for (const [kind, source] of Object.entries(SAMPLES)) {
    it(`${kind}：排隊中，夾在兩件人的件中間，三件都在，順序不變`, () => {
      const inbox: InboxState = {
        'next-turn': [human('before'), item('subject', source), human('after')],
        'next-step': [],
      };
      const folded = reduceConversation(
        emptyConversation(),
        frameOf(inboxData(inbox).payload),
      ).inbox;
      expect(folded.map((queued) => queued.id)).toEqual(['before', 'subject', 'after']);
      expect(folded[1]?.source.kind).toBe(kind);
    });

    it(`${kind}：插話那一條也收`, () => {
      const inbox: InboxState = {
        'next-turn': [human('turn')],
        'next-step': [item('subject', source)],
      };
      const state = reduceConversation(emptyConversation(), frameOf(inboxData(inbox).payload));
      expect(state.inbox.map((queued) => queued.id)).toEqual(['turn']);
      expect(state.inboxNextStep.map((queued) => queued.id)).toEqual(['subject']);
    });

    it(`${kind}：被領走那一顆的 frame 收，清單照換`, () => {
      const before = reduceConversation(
        emptyConversation(),
        frameOf(
          inboxData({ 'next-turn': [item('subject', source), human('next')], 'next-step': [] })
            .payload,
        ),
      );
      const after = reduceConversation(
        before,
        frameOf(
          inboxData(
            { 'next-turn': [human('next')], 'next-step': [] },
            { turn: item('subject', source) },
          ).payload,
        ),
      );
      // 整顆被丟的話，清單會停在領走之前的兩件。
      expect(after.inbox.map((queued) => queued.id)).toEqual(['next']);
    });
  }
});
