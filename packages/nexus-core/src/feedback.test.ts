/**
 * 評分歸到哪一輪（#682）：`resume` 不開新的邏輯輪，所以跨過 `resume` 的回覆仍屬於它前面那一輪。
 *
 * 這條規則由 {@link isLogicalTurnStart} 定。折疊 `currentMessageFeedback` 沒有別的直接測試，
 * 起草工具的測試只走舊式的 `item.turn`；少了這一條，把 `resume` 當成新輪的人不會讓任何測試變紅，
 * 點踩就安靜地掛到錯的輪。
 */

import { AIMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';

import { currentMessageFeedback } from './feedback.js';
import { toLoggedMessage } from './logged-message.js';
import { SessionLog } from './session-log.js';

function reply(id: string, text: string) {
  return toLoggedMessage(new AIMessage({ content: text, id }));
}

describe('currentMessageFeedback 的輪', () => {
  it('跨過 resume 的回覆仍屬於 resume 前面那一輪', () => {
    const log = new SessionLog('t');
    const first = log.append('turn/start', { kind: 'message', text: '做事' });
    log.append('assistant/message', { message: reply('a', '先問你') });
    log.append('interrupt/raised', { interruptId: 'i-1' });
    log.append('turn/end', {});
    log.append('turn/start', { kind: 'resume' });
    log.append('assistant/message', { message: reply('b', '做完了') });
    log.append('turn/end', {});
    const second = log.append('turn/start', { kind: 'message', text: '再來' });
    log.append('assistant/message', { message: reply('c', '好') });
    for (const messageId of ['a', 'b', 'c']) {
      log.append('feedback/message-put', {
        item: {
          messageId,
          rating: 'negative',
          version: `v-${messageId}`,
          createdAt: 1,
          updatedAt: 1,
        },
      });
    }

    const turns = Object.fromEntries(
      currentMessageFeedback(log.events).map(({ item, turn }) => [
        'messageId' in item ? item.messageId : '?',
        turn,
      ]),
    );
    expect(turns).toEqual({ a: first.seq, b: first.seq, c: second.seq });
  });
});
