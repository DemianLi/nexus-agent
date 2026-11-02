import type { FeedbackOutcome, FeedbackListResult, WireFeedbackItem } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { FEEDBACK_COPY } from '@/lib/feedback';
import { RatingsController } from '@/lib/feedback-ratings';
import type { RatingsRemote, RatingsView } from '@/lib/feedback-ratings';

/**
 * 伺服器不收評分（[#1849](https://github.com/DemianLi/nexus-agent/issues/1849)）：落盤關掉的組裝三個評分 method 都回
 * `not_supported`（#1606）。判的是碼，不是訊息；不收評分的不再試，重連的 `resync` 才重讀。
 */

const ITEM: WireFeedbackItem = {
  messageId: 'm1',
  rating: 'positive',
  version: 'v1',
  createdAt: 0,
  updatedAt: 0,
};
const UNSUPPORTED = {
  kind: 'rejected',
  code: 'not_supported',
  message: '這個組裝沒有掛落盤，評分存不住',
} as const;
const OK_LIST: FeedbackOutcome<FeedbackListResult> = {
  kind: 'ok',
  result: { ok: true, value: { items: [ITEM] } },
};

function controller(remote: Partial<RatingsRemote>) {
  const calls = { list: 0, put: 0, delete: 0 };
  const views: RatingsView[] = [];
  const full: RatingsRemote = {
    list: async () => {
      calls.list += 1;
      return remote.list === undefined ? OK_LIST : remote.list();
    },
    put: async (params) => {
      calls.put += 1;
      return remote.put === undefined
        ? { kind: 'ok', result: { ok: true, value: { ...ITEM, rating: params.rating } } }
        : remote.put(params);
    },
    delete: async (params) => {
      calls.delete += 1;
      return remote.delete === undefined
        ? { kind: 'ok', result: { ok: true, value: { absent: true } } }
        : remote.delete(params);
    },
  };
  const ratings = new RatingsController(full, (view) => views.push(view));
  return { ratings, calls, views };
}

describe('RatingsController：伺服器不收評分（#1849）', () => {
  it('list 回 not_supported：狀態是 unsupported（不是 failed），講那一句', async () => {
    const { ratings } = controller({ list: async () => UNSUPPORTED });
    expect(await ratings.ensure()).toEqual({ ok: false, failure: FEEDBACK_COPY.unsupported });
    expect(ratings.view.status).toBe('unsupported');
  });

  it('不收評分的不再試：ensure、rate、retract 都不再打線', async () => {
    const { ratings, calls } = controller({ list: async () => UNSUPPORTED });
    await ratings.ensure();
    await ratings.ensure();
    expect(await ratings.rate('m1', 'negative')).toEqual({
      ok: false,
      failure: FEEDBACK_COPY.unsupported,
    });
    await ratings.retract('m1', 'positive');
    expect(calls).toEqual({ list: 1, put: 0, delete: 0 });
  });

  it('對照：別的 rejected（沒帶碼、或別的碼）照舊是 failed，下次再試', async () => {
    for (const rejected of [
      { kind: 'rejected', message: '這個組裝沒有掛落盤，評分存不住' },
      { kind: 'rejected', code: 'invalid_argument', message: '讀不到' },
    ] as const) {
      const { ratings, calls } = controller({ list: async () => rejected });
      const result = await ratings.ensure();
      expect(ratings.view.status).toBe('failed');
      expect(result).toEqual({
        ok: false,
        failure: `${FEEDBACK_COPY.generic}：${rejected.message}`,
      });
      await ratings.ensure();
      expect(calls.list).toBe(2);
    }
  });

  it('讀得到、寫的時候才回 not_supported（put 或 delete）：也進 unsupported，讀過的那些清掉', async () => {
    const put = controller({ put: async () => UNSUPPORTED });
    expect((await put.ratings.rate('m1', 'negative')).ok).toBe(false);
    expect(put.ratings.view).toEqual({ status: 'unsupported', items: new Map() });

    const del = controller({ delete: async () => UNSUPPORTED });
    expect((await del.ratings.retract('m1', 'positive')).ok).toBe(false);
    expect(del.ratings.view.status).toBe('unsupported');
  });

  it('重連的 resync 照樣重讀：伺服器改成收評分，讀得到就回到 ready', async () => {
    let unsupported = true;
    const { ratings, calls } = controller({
      list: async () => (unsupported ? UNSUPPORTED : OK_LIST),
    });
    await ratings.ensure();
    expect(ratings.view.status).toBe('unsupported');
    unsupported = false;
    expect(await ratings.resync()).toEqual({ ok: true });
    expect(calls.list).toBe(2);
    expect(ratings.view.status).toBe('ready');
    expect(ratings.view.items.get('m1')).toEqual(ITEM);
  });
});
