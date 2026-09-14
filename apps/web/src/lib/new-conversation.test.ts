import type { ThreadListResult, ThreadSummary } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { newConversationTarget, readThreadListing } from './new-conversation.js';

function row(threadId: string, blank: boolean): ThreadSummary {
  return { threadId, updatedAt: 0, running: false, blank };
}

function listed(...items: ThreadSummary[]): ThreadListResult {
  return { items, unreadable: 0 };
}

/**
 * 「新對話」挑哪一條（#313）。「目前這條還是空白就留在原地」在畫面那一側判，驗在 `App.test.tsx`。
 */
describe('newConversationTarget', () => {
  it('清單讀不出來：開新的', () => {
    expect(newConversationTarget(undefined, '目前')).toEqual({ kind: 'new' });
  });

  it('拿清單順序上第一條空白的，不看它前面那些講過話的', () => {
    const target = newConversationTarget(
      listed(row('講過話', false), row('空白一', true), row('空白二', true)),
      '目前',
    );

    expect(target).toEqual({ kind: 'reuse', threadId: '空白一' });
  });

  it('目前這條就算標著空白也不挑：走到這裡代表這個分頁在它上面講過話了', () => {
    expect(newConversationTarget(listed(row('目前', true), row('別條', true)), '目前')).toEqual({
      kind: 'reuse',
      threadId: '別條',
    });
    expect(newConversationTarget(listed(row('目前', true)), '目前')).toEqual({ kind: 'new' });
  });

  it('沒有空白的：開新的', () => {
    expect(newConversationTarget(listed(row('講過話', false)), '目前')).toEqual({ kind: 'new' });
  });
});

describe('readThreadListing', () => {
  it('讀得到：回清單', async () => {
    const result = listed(row('一條', true));

    expect(await readThreadListing({ listThreads: async () => ({ kind: 'ok', result }) })).toBe(
      result,
    );
  });

  it('被拒絕或拋錯：都是 undefined，不往外拋——「新對話」照樣走得出去', async () => {
    expect(
      await readThreadListing({
        listThreads: async () => ({ kind: 'rejected', message: '沒給 --session-log' }),
      }),
    ).toBeUndefined();
    expect(
      await readThreadListing({
        listThreads: async () => {
          throw new Error('415');
        },
      }),
    ).toBeUndefined();
  });
});
