/**
 * 插件投影的 `custom` frame 怎麼折（[#1026](https://github.com/DemianLi/nexus-agent/issues/1026)）：
 * 整份取代、依 key 分格、形狀不對整顆不收、往前翻頁不動它。
 */

import { describe, expect, it } from 'vitest';

import { emptyConversation, prependEntries, reduceAll } from './conversation.js';
import { PROJECTION } from './projection.js';
import type { Event } from './protocol.js';

const frame = (payload: unknown, name: string = PROJECTION): Event =>
  ({
    type: 'event',
    method: 'custom',
    params: { namespace: [], timestamp: 0, data: { name, payload } },
  }) as Event;

const fold = (...frames: Event[]) => reduceAll(emptyConversation(), frames).projections;

describe('projections', () => {
  it('一顆都沒有是空物件', () => {
    expect(fold()).toEqual({});
  });

  it('依 key 分格，同一個 key 後到的整份取代先到的', () => {
    expect(
      fold(
        frame({ key: 'calls', version: 1, view: { n: 1 } }),
        frame({ key: 'other', version: 0, view: [1, 2] }),
        frame({ key: 'calls', version: 1, view: { n: 2 } }),
      ),
    ).toEqual({
      calls: { version: 1, view: { n: 2 } },
      other: { version: 0, view: [1, 2] },
    });
  });

  it('version 跟著 frame 存下來，新版本取代舊版本的格', () => {
    expect(
      fold(
        frame({ key: 'calls', version: 1, view: { n: 1 } }),
        frame({ key: 'calls', version: 2, view: { n: 1, extra: true } }),
      ).calls,
    ).toEqual({ version: 2, view: { n: 1, extra: true } });
  });

  it('view 可以是 null、字串、數字、陣列：這一層不看形狀', () => {
    for (const view of [null, 'x', 0, false, []]) {
      expect(fold(frame({ key: 'k', version: 0, view })).k).toEqual({ version: 0, view });
    }
  });

  it('failed 把該格換成失敗，別的 key 不動；之後好的 frame 可以恢復它', () => {
    const failed = fold(
      frame({ key: 'a', version: 1, view: 1 }),
      frame({ key: 'b', version: 1, view: 2 }),
      frame({ key: 'a', version: 1, view: null, failed: true }),
    );
    expect(failed).toEqual({
      a: { version: 1, view: null, failed: true },
      b: { version: 1, view: 2 },
    });
    expect(
      fold(
        frame({ key: 'a', version: 1, view: null, failed: true }),
        frame({ key: 'a', version: 1, view: 3 }),
      ).a,
    ).toEqual({
      version: 1,
      view: 3,
    });
  });

  it('形狀不對整顆不收，留著前一份', () => {
    const good = frame({ key: 'k', version: 1, view: 'ok' });
    const bads: unknown[] = [
      {},
      { key: 'K', version: 1, view: 1 },
      { key: '__proto__', version: 1, view: 1 },
      { key: 'k', version: -1, view: 1 },
      { key: 'k', version: 1.5, view: 1 },
      { key: 'k', version: '1', view: 1 },
      { key: 'k', version: 1 },
      { key: 'k', version: 1, view: 1, failed: false },
      { key: 'k', version: 1, view: 1, failed: true },
      { key: 'k', version: 1, view: null, failed: 'true' },
    ];
    for (const bad of bads) {
      expect(fold(good, frame(bad)), JSON.stringify(bad)).toEqual({
        k: { version: 1, view: 'ok' },
      });
    }
  });

  it('不是 projection 這個名字的 frame 不進這一格', () => {
    expect(fold(frame({ key: 'k', version: 1, view: 1 }, 'projections'))).toEqual({});
  });

  it('往前翻頁不動它', () => {
    const state = reduceAll(emptyConversation(), [frame({ key: 'k', version: 1, view: 1 })]);
    expect(prependEntries(state, emptyConversation()).projections).toEqual({
      k: { version: 1, view: 1 },
    });
  });
});
