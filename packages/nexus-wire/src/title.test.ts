/**
 * 會話標題的 `custom` frame 怎麼折（[#647](https://github.com/DemianLi/nexus-agent/issues/647)）。
 *
 * 產出 frame 的那一半在 `apps/harness/src/session-title-wire.test.ts`；這裡只管折疊器：初值、換掉、形狀不對不收、
 * 往前翻頁不動它。
 */

import { describe, expect, it } from 'vitest';

import { emptyConversation, prependEntries, reduceAll } from './conversation.js';
import type { Event } from './protocol.js';
import { TITLE } from './title.js';

let seq = 0;
function titleFrame(payload: unknown, name: string = TITLE): Event {
  const current = seq++;
  return {
    type: 'event',
    seq: current,
    event_id: `t:${current}`,
    method: 'custom',
    params: { namespace: [], timestamp: 0, data: { name, payload } },
  } as Event;
}

const fold = (...frames: Event[]) => reduceAll(emptyConversation(), frames);

describe('title', () => {
  it('還沒收到過是 null', () => {
    expect(emptyConversation().title).toBeNull();
  });

  it('後到的換掉先到的', () => {
    expect(fold(titleFrame({ title: '甲' })).title).toBe('甲');
    expect(fold(titleFrame({ title: '甲' }), titleFrame({ title: '乙' })).title).toBe('乙');
  });

  it('形狀不對不收：空字串、不是字串、沒有這一格、名字不對', () => {
    for (const bad of [{ title: '' }, { title: 42 }, { title: null }, {}]) {
      expect(fold(titleFrame({ title: '甲' }), titleFrame(bad)).title).toBe('甲');
    }
    expect(fold(titleFrame({ title: '乙' }, 'titles')).title).toBeNull();
  });

  it('往前翻頁不動它：那是「現在」的事', () => {
    const now = fold(titleFrame({ title: '現在的' }));
    const earlier = fold(titleFrame({ title: '更早那頁的' }));
    expect(prependEntries(now, earlier).title).toBe('現在的');
    expect(prependEntries(fold(), earlier).title).toBeNull();
  });
});
