/**
 * 圖片額度省略（[#1270](https://github.com/DemianLi/nexus-agent/issues/1270)）在折疊器裡的樣子：冷載入的人話帶 `omittedAttachments`，
 * 即時的 `image-offload` frame 累加進同一格，並且用 `inboxId` 或 `history-<seq>` 認條目。產出這些 frame 的一半在
 * `apps/harness/src/image-offload-pump.test.ts`。
 */

import { describe, expect, it } from 'vitest';

import { emptyConversation, reduceAll } from './conversation.js';
import { IMAGE_OFFLOAD } from './image-offload.js';
import { INBOX } from './inbox.js';
import type { Event } from './protocol.js';

let seq = 0;
function frame(method: string, data: unknown): Event {
  const current = seq++;
  return {
    type: 'event',
    seq: current,
    event_id: `o:${current}`,
    method,
    params: { namespace: [], timestamp: 0, data },
  } as Event;
}

const FILE = { type: 'file', attachmentId: `sha256:${'a'.repeat(64)}`, name: 'a.csv', bytes: 3 };
const image = (letter: string) => ({
  type: 'image',
  attachmentId: `sha256:${letter.repeat(64)}`,
  mediaType: 'image/png',
  bytes: 90,
  width: 3,
  height: 2,
});

const offload = (...items: unknown[]) =>
  frame('custom', { name: IMAGE_OFFLOAD, payload: { items } });
const fold = (...frames: Event[]) => reduceAll(emptyConversation(), frames);

describe('冷載入：message-start 帶 omittedAttachments', () => {
  it('位置落在 attachments 範圍內才留，遞增去重；沒有附件或沒有合格位置就不給這一格', () => {
    const state = fold(
      frame('messages', {
        event: 'message-start',
        role: 'human',
        id: 'history-1',
        attachments: [FILE, image('b'), image('c')],
        omittedAttachments: [2, 1, 1, 7, -1, 1.5, 'x'],
      }),
      frame('messages', {
        event: 'message-start',
        role: 'human',
        id: 'history-5',
        attachments: [image('d')],
        omittedAttachments: [3],
      }),
      frame('messages', {
        event: 'message-start',
        role: 'human',
        id: 'history-9',
        omittedAttachments: [0],
      }),
    );
    expect(state.entries).toMatchObject([
      { id: 'history-1', omittedAttachments: [1, 2] },
      { id: 'history-5' },
      { id: 'history-9' },
    ]);
    expect('omittedAttachments' in state.entries[1]!).toBe(false);
    expect('omittedAttachments' in state.entries[2]!).toBe(false);
  });
});

describe('即時：image-offload frame', () => {
  const claimed = (id: string, attachments: unknown[]) =>
    frame('custom', {
      name: INBOX,
      payload: { items: [], claimed: { id, text: '看圖', attachments } },
    });

  it('用 inboxId 認即時長出來的條目，累加位置', () => {
    const state = fold(
      claimed('q1', [FILE, image('b'), image('c')]),
      offload({ seq: 4, inboxId: 'q1', positions: [1] }),
      offload({ seq: 4, inboxId: 'q1', positions: [2, 1] }),
    );
    expect(state.entries).toMatchObject([{ id: 'inbox:q1', omittedAttachments: [1, 2] }]);
  });

  it('沒有 inboxId 的用 history-<seq> 認歷史載入的條目；其他條目不受影響', () => {
    const state = fold(
      frame('messages', {
        event: 'message-start',
        role: 'human',
        id: 'history-3',
        attachments: [image('b')],
      }),
      claimed('q1', [image('c')]),
      offload({ seq: 3, positions: [0] }),
    );
    expect(state.entries).toMatchObject([
      { id: 'history-3', omittedAttachments: [0] },
      { id: 'inbox:q1' },
    ]);
    expect('omittedAttachments' in state.entries[1]!).toBe(false);
  });

  it('兩種身分都給時各自命中（同一句在不同客戶端手上身分不同）', () => {
    const live = fold(
      claimed('q1', [image('b')]),
      offload({ seq: 3, inboxId: 'q1', positions: [0] }),
    );
    const cold = fold(
      frame('messages', {
        event: 'message-start',
        role: 'human',
        id: 'history-3',
        attachments: [image('b')],
      }),
      offload({ seq: 3, inboxId: 'q1', positions: [0] }),
    );
    expect(live.entries[0]).toMatchObject({ omittedAttachments: [0] });
    expect(cold.entries[0]).toMatchObject({ omittedAttachments: [0] });
  });

  it('對不上的項、超出附件範圍的位置：不動', () => {
    const base = claimed('q1', [image('b')]);
    const state = fold(
      base,
      offload({ seq: 9, inboxId: 'nobody', positions: [0] }),
      offload({ seq: 4, inboxId: 'q1', positions: [5] }),
    );
    expect('omittedAttachments' in state.entries[0]!).toBe(false);
  });

  it('任何一項形狀不對就整顆不收，不收一半', () => {
    for (const bad of [
      { seq: 'x', positions: [0] },
      { seq: -1, positions: [0] },
      { seq: 4, inboxId: 7, positions: [0] },
      { seq: 4, positions: 'x' },
    ]) {
      const state = fold(
        claimed('q1', [image('b')]),
        offload({ seq: 4, inboxId: 'q1', positions: [0] }, bad),
      );
      expect('omittedAttachments' in state.entries[0]!).toBe(false);
    }
    // 酬載不是 { items: [] }：略過。
    const noItems = fold(
      claimed('q1', [image('b')]),
      frame('custom', { name: IMAGE_OFFLOAD, payload: {} }),
    );
    expect('omittedAttachments' in noItems.entries[0]!).toBe(false);
  });
});
