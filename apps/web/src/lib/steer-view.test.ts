import { emptyConversation, INBOX, reduceConversation } from '@nexus/wire';
import type { ConversationState, Event, WireQueuedInput } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { SETTLED_NOTICE_TEXT } from '@/lib/queue-view';

import {
  PARKED_STEER_TEXT,
  PENDING_STEER_TEXT,
  pendingSteers,
  pendingSteerText,
  settledNoticeText,
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
    expect(pendingSteers(state)).toEqual([{ key: 'inbox:run-a', text: '改用 X', settled: false }]);
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

describe('背景子代理的結算通知排在插話那一條（#851）', () => {
  const notice: WireQueuedInput = {
    id: 'settled-a',
    text: 'Background subagent finished.',
    source: { kind: 'subagent-settled' },
  };

  it('列進來但標成通知：畫面不能把給模型的英文畫成人的泡泡', () => {
    const state = fold(inboxFrame({ items: [], nextStep: [first, notice] }));
    expect(pendingSteers(state).map(({ key, settled }) => ({ key, settled }))).toEqual([
      { key: 'inbox:run-a', settled: false },
      { key: 'inbox:settled-a', settled: true },
    ]);
  });

  it('被領走時折疊器不長人的話：那一格直接消失，不留一則人說的話', () => {
    const pending = fold(inboxFrame({ items: [], nextStep: [notice] }));
    const claimed = reduceConversation(
      pending,
      inboxFrame({
        items: [],
        nextStep: [],
        claimedNextStep: [
          { id: notice.id, text: notice.text, source: { kind: 'subagent-settled' } },
        ],
      }),
    );
    expect(claimed.entries).toEqual([]);
    expect(pendingSteers(claimed)).toEqual([]);
  });
});

describe('settledNoticeText（#851）', () => {
  it('說背景子代理已完成，這一輪還在是下一步、停了是下一輪，跟插話同一條線', () => {
    expect(settledNoticeText('running')).toBe(`${SETTLED_NOTICE_TEXT}・下一步送進模型`);
    expect(settledNoticeText('awaiting-input')).toBe(`${SETTLED_NOTICE_TEXT}・下一步送進模型`);
    for (const status of ['idle', 'stopped', 'failed'] as const) {
      expect(settledNoticeText(status)).toBe(`${SETTLED_NOTICE_TEXT}・下一輪送進模型`);
    }
  });
});
