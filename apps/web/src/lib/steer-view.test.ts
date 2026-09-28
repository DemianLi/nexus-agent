import { emptyConversation, INBOX, reduceConversation } from '@nexus/wire';
import type { ConversationState, Event, WireQueuedInput } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import {
  PARKED_STEER_TEXT,
  PENDING_STEER_TEXT,
  pendingSteers,
  pendingSteerText,
} from './steer-view';

let seq = 0;
function inboxFrame(payload: unknown): Event {
  const current = seq++;
  return {
    type: 'event',
    seq: current,
    event_id: `s:${current}`,
    method: 'custom',
    params: { namespace: [], timestamp: 0, data: { name: INBOX, payload } },
  } as Event;
}

const fold = (...frames: Event[]): ConversationState =>
  frames.reduce(reduceConversation, emptyConversation());

const first: WireQueuedInput = { id: 'run-a', text: '改用 X', source: { kind: 'user' } };
const second: WireQueuedInput = { id: 'run-b', text: '那個檔先別動', source: { kind: 'user' } };

describe('pendingSteers（#710）', () => {
  it('照送出的先後列出排著的插話；排隊的那條不算', () => {
    const state = fold(inboxFrame({ items: [second], nextStep: [first] }));
    expect(pendingSteers(state)).toEqual([{ key: 'inbox:run-a', text: '改用 X' }]);
  });

  it('鍵就是領走之後那則人的話的 id：換成正式的是同一格', () => {
    const pending = fold(inboxFrame({ items: [], nextStep: [first, second] }));
    const claimed = reduceConversation(
      pending,
      inboxFrame({
        items: [],
        nextStep: [],
        claimedNextStep: [
          { id: first.id, text: first.text },
          { id: second.id, text: second.text },
        ],
      }),
    );
    expect(claimed.entries.map((entry) => entry.id)).toEqual(
      pendingSteers(pending).map((steer) => steer.key),
    );
    expect(pendingSteers(claimed)).toEqual([]);
  });

  it('已經折成人的話的那件不再畫一次', () => {
    const claimed = fold(
      inboxFrame({
        items: [],
        nextStep: [],
        claimedNextStep: [{ id: first.id, text: first.text }],
      }),
    );
    const stale: ConversationState = { ...claimed, inboxNextStep: [first, second] };
    expect(pendingSteers(stale).map((steer) => steer.key)).toEqual(['inbox:run-b']);
  });
});

describe('pendingSteerText', () => {
  it('這一輪還在是下一步；停了是下一輪（harness 留到下一輪的第一次模型呼叫才領）', () => {
    expect(pendingSteerText('running')).toBe(PENDING_STEER_TEXT);
    expect(pendingSteerText('awaiting-input')).toBe(PENDING_STEER_TEXT);
    for (const status of ['idle', 'stopped', 'failed'] as const) {
      expect(pendingSteerText(status)).toBe(PARKED_STEER_TEXT);
    }
  });
});
