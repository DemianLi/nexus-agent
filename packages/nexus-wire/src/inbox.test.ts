/**
 * 送出佇列的 `custom` frame 怎麼折（[#637](https://github.com/DemianLi/nexus-agent/issues/637)）。
 *
 * 產出 frame 的那一半在 `apps/harness/src/send-queue.test.ts`；這裡只管折疊器：清單整份換掉、`claimed` 折出人的話
 * 而且不畫兩次、形狀不對整顆不收、往前翻頁不動它。
 */

import { describe, expect, it } from 'vitest';

import {
  appendHumanTurn,
  emptyConversation,
  prependEntries,
  reduceAll,
  reduceConversation,
} from './conversation.js';
import { INBOX } from './inbox.js';
import type { Event } from './protocol.js';

let seq = 0;
function frame(method: string, data: unknown, namespace: readonly string[] = []): Event {
  const current = seq++;
  return {
    type: 'event',
    seq: current,
    event_id: `i:${current}`,
    method,
    params: { namespace, timestamp: 0, data },
  } as Event;
}

const inboxFrame = (payload: unknown): Event => frame('custom', { name: INBOX, payload });

const first = { id: 'run-a', text: '先讀設定', source: { kind: 'user' } } as const;
const second = { id: 'run-b', text: '再改程式', source: { kind: 'user' } } as const;

const fold = (...frames: Event[]) => reduceAll(emptyConversation(), frames);

describe('inbox', () => {
  it('一顆都沒有是空的', () => {
    expect(emptyConversation().inbox).toEqual([]);
  });

  it('清單整份換掉，只帶認得的欄位', () => {
    expect(fold(inboxFrame({ items: [first, second] })).inbox).toEqual([first, second]);
    expect(
      fold(inboxFrame({ items: [first, second] }), inboxFrame({ items: [second] })).inbox,
    ).toEqual([second]);
    expect(fold(inboxFrame({ items: [first] }), inboxFrame({ items: [] })).inbox).toEqual([]);
    expect(
      fold(inboxFrame({ items: [{ ...first, extra: 1, source: { kind: 'user', x: 2 } }] })).inbox,
    ).toEqual([first]);
  });

  it('沒帶 claimed 不畫人的話（歷史那一顆就是這樣）', () => {
    const state = fold(inboxFrame({ items: [first] }));
    expect(state.entries).toEqual([]);
    expect(state.status).toBe('idle');
  });

  it('帶 claimed 的那一顆折出一則人的話，文字用開跑用的那份，status 不動', () => {
    const state = fold(
      inboxFrame({ items: [first, second] }),
      inboxFrame({ items: [second], claimed: { id: first.id, text: '先讀設定（改過）' } }),
    );
    expect(state.inbox).toEqual([second]);
    expect(state.entries).toEqual([
      { kind: 'human', id: `inbox:${first.id}`, text: '先讀設定（改過）' },
    ]);
    expect(state.status).toBe('idle');
  });

  it('同一顆 claimed 再到一次不畫第二次；另一件開跑再畫一則', () => {
    const claimFirst = { items: [second], claimed: { id: first.id, text: first.text } };
    const state = fold(
      inboxFrame(claimFirst),
      inboxFrame(claimFirst),
      inboxFrame({ items: [], claimed: { id: second.id, text: second.text } }),
    );
    expect(state.entries.map((entry) => entry.id)).toEqual([
      `inbox:${first.id}`,
      `inbox:${second.id}`,
    ]);
    expect(state.inbox).toEqual([]);
  });

  it('形狀不對整顆不收：不換清單、不畫人的話', () => {
    const bad: unknown[] = [
      {},
      { items: 'x' },
      { items: [null] },
      { items: [{ ...first, text: 1 }] },
      { items: [{ id: 'run-c', text: '目標續行' }] },
      // 用另一件的 id：拿 `first` 改的話，正規化之後跟原本那份長得一樣，比不出有沒有收。
      { items: [{ ...second, source: { kind: 'goal' } }] },
      { items: [], claimed: null },
      { items: [], claimed: { id: first.id } },
      { items: [], claimed: { id: 1, text: first.text } },
    ];
    for (const payload of bad) {
      const state = fold(inboxFrame({ items: [first] }), inboxFrame(payload));
      expect(state.inbox).toEqual([first]);
      expect(state.entries).toEqual([]);
    }
  });

  it('開跑那一輪：人的話在回覆之前，收尾照常標在回覆上', () => {
    const state = fold(
      inboxFrame({ items: [], claimed: { id: first.id, text: first.text } }),
      frame('lifecycle', { event: 'running', graph_name: 'root' }),
      frame('messages', { event: 'message-start', id: 'run-r1', run_id: 'r1' }, [
        'model_request:1',
      ]),
      frame(
        'messages',
        {
          event: 'content-block-delta',
          index: 0,
          delta: { type: 'text-delta', text: '讀完了' },
          run_id: 'r1',
        },
        ['model_request:1'],
      ),
      frame('messages', { event: 'message-finish', reason: 'stop', run_id: 'r1' }, [
        'model_request:1',
      ]),
      frame('lifecycle', { event: 'completed', graph_name: 'root' }),
    );
    expect(state.entries.map((entry) => entry.kind)).toEqual(['human', 'ai']);
    expect(state.entries[1]).toMatchObject({ text: '讀完了', turnTail: true });
    expect(state.status).toBe('idle');
  });

  describe('過渡期：送出當下畫過的那則被認領，不畫第二次', () => {
    const claim = (id: string, text: string) => inboxFrame({ items: [], claimed: { id, text } });

    it('送出當下畫的那則標著還沒認領', () => {
      expect(appendHumanTurn(emptyConversation(), '嗨').entries).toEqual([
        { kind: 'human', id: 'human-0', text: '嗨', pendingClaim: true },
      ]);
    });

    it('claimed 認領它：換成 inbox 的 id 與開跑用的文字，只剩一則；同一顆再到不變', () => {
      const sent = appendHumanTurn(emptyConversation(), '先讀設定');
      const claimed = reduceConversation(sent, claim(first.id, '先讀設定（改過）'));
      expect(claimed.entries).toEqual([
        { kind: 'human', id: `inbox:${first.id}`, text: '先讀設定（改過）' },
      ]);
      expect(claimed.status).toBe('running');
      expect(reduceConversation(claimed, claim(first.id, '先讀設定（改過）')).entries).toEqual(
        claimed.entries,
      );
    });

    it('認領過了，下一件 claimed 就另畫一則', () => {
      const sent = appendHumanTurn(emptyConversation(), 'A');
      const state = reduceAll(sent, [claim(first.id, 'A'), claim(second.id, 'B')]);
      expect(state.entries.map((entry) => entry.id)).toEqual([
        `inbox:${first.id}`,
        `inbox:${second.id}`,
      ]);
    });

    it('只認領最後那一則：更早留下來、還標著的那則不動', () => {
      const failed = appendHumanTurn(emptyConversation(), '送出失敗的那句');
      const sent = appendHumanTurn({ ...failed, status: 'idle' }, '這一句');
      const state = reduceConversation(sent, claim(first.id, '這一句'));
      expect(state.entries).toEqual([
        { kind: 'human', id: 'human-0', text: '送出失敗的那句', pendingClaim: true },
        { kind: 'human', id: `inbox:${first.id}`, text: '這一句' },
      ]);
    });

    it('歷史重播的人話不算：沒標著，claimed 另畫一則', () => {
      const replayed = reduceAll(emptyConversation(), [
        frame('messages', { event: 'message-start', role: 'human', id: 'run-h', run_id: 'h' }),
      ]);
      const state = reduceConversation(replayed, claim(first.id, 'A'));
      expect(state.entries.map((entry) => entry.id)).toEqual(['h', `inbox:${first.id}`]);
    });
  });

  it('往前翻頁不動它：那是「現在」的事', () => {
    const now = fold(inboxFrame({ items: [first] }));
    const earlier = fold(inboxFrame({ items: [second] }));
    expect(prependEntries(now, earlier).inbox).toEqual([first]);
  });
});
