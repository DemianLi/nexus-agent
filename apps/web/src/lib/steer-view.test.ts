import { emptyConversation, INBOX, reduceConversation } from '@nexus/wire';
import type { ConversationState, Event, WireQueuedInput } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import {
  AGENT_MESSAGE_QUEUED_TEXT,
  SETTLED_NOTICE_TEXT,
  SETTLED_NOTICE_UNKNOWN_TEXT,
} from '@/lib/queue-view';

import {
  PARKED_STEER_TEXT,
  PENDING_STEER_TEXT,
  pendingSteers,
  pendingSteerText,
  pendingAgentText,
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

  it('帶附件的插話：附件參照跟著走；沒帶附件的不多長欄位', () => {
    const image = {
      type: 'image' as const,
      attachmentId: 'sha256:img',
      mediaType: 'image/png' as const,
      bytes: 221,
      width: 96,
      height: 96,
    };
    const state = fold(
      inboxFrame({ items: [], nextStep: [{ ...first, attachments: [image] }, second] }),
    );
    expect(pendingSteers(state)).toEqual([
      { key: 'inbox:run-a', text: '改用 X', attachments: [image] },
      { key: 'inbox:run-b', text: '那個檔先別動' },
    ]);
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
    expect(pendingSteers(state).map(({ key, agentText }) => ({ key, agentText }))).toEqual([
      { key: 'inbox:run-a' },
      { key: 'inbox:settled-a', agentText: SETTLED_NOTICE_UNKNOWN_TEXT },
    ]);
  });

  it('被領走時折疊器不長人的話，改長一格「通知」（同一個 key）：排著的那一行消失，不留一則人說的話', () => {
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
    // 折疊器長出 `notice`（#851）：id 跟排著時那一行的 key 是同一個，畫面可以同一格換成正式的。
    expect(claimed.entries).toEqual([
      { kind: 'notice', id: 'inbox:settled-a', source: 'subagent-settled', inboxId: 'settled-a' },
    ]);
    expect(pendingSteers(claimed)).toEqual([]);
  });
});

describe('結算通知帶原因時（#884）', () => {
  it('排著那一行與領走後長出的 notice 帶同一個原因：同一格換內容，字不變', () => {
    const withReason: WireQueuedInput = {
      id: 'settled-b',
      text: 'Background subagent was stopped.',
      source: { kind: 'subagent-settled', reason: 'aborted' },
    };
    const pending = fold(inboxFrame({ items: [], nextStep: [withReason] }));
    expect(pendingSteers(pending)).toEqual([
      { key: 'inbox:settled-b', text: withReason.text, agentText: '背景子代理已被停止' },
    ]);
    const claimed = reduceConversation(
      pending,
      inboxFrame({
        items: [],
        nextStep: [],
        claimedNextStep: [{ id: withReason.id, text: withReason.text, source: withReason.source }],
      }),
    );
    expect(claimed.entries).toEqual([
      {
        kind: 'notice',
        id: 'inbox:settled-b',
        source: 'subagent-settled',
        reason: 'aborted',
        inboxId: 'settled-b',
      },
    ]);
  });
});

describe('背景子代理的來信排在插話那一條（#861）', () => {
  const relay: WireQueuedInput = {
    id: 'relay-a',
    text: 'Agent root/bg-1 sent a message: 三個檔案看過了',
    source: { kind: 'agent-message' },
  };

  it('標成來信：畫面不能把給模型的英文（帶前綴）畫成人的泡泡', () => {
    const state = fold(inboxFrame({ items: [], nextStep: [relay] }));
    expect(pendingSteers(state)).toEqual([
      { key: 'inbox:relay-a', text: relay.text, agentText: AGENT_MESSAGE_QUEUED_TEXT },
    ]);
  });
});

describe('pendingAgentText（#851、#861）', () => {
  it('這一輪還在是下一步、停了是下一輪，跟插話同一條線', () => {
    expect(pendingAgentText(SETTLED_NOTICE_TEXT.completed, 'running')).toBe(
      `${SETTLED_NOTICE_TEXT.completed}・下一步送進模型`,
    );
    expect(pendingAgentText(AGENT_MESSAGE_QUEUED_TEXT, 'awaiting-input')).toBe(
      `${AGENT_MESSAGE_QUEUED_TEXT}・下一步送進模型`,
    );
    for (const status of ['idle', 'stopped', 'failed'] as const) {
      expect(pendingAgentText(SETTLED_NOTICE_TEXT.completed, status)).toBe(
        `${SETTLED_NOTICE_TEXT.completed}・下一輪送進模型`,
      );
    }
  });
});
