import type { Event, ThreadHistoryResult, WireClient } from '@nexus/wire';
import { SESSION_STATS, TOKEN_USAGE } from '@nexus/wire';
import { describe, expect, it, vi } from 'vitest';

import { Script } from '@/test/conversation-frames';

import { createSubagentUsageLoader, foldSubagentUsage } from './subagent-usage';

function page(events: Event[]): ThreadHistoryResult {
  return { events, firstSeq: 0, throughSeq: 0, hasMore: false, legacy: false };
}

/** 子代理那一頁的樣子：一則人話（派出的任務）加上 harness 補在尾巴的兩顆總帳。 */
function subagentPage(): ThreadHistoryResult {
  const script = new Script();
  return page([
    ...script.human('h', '去查一下'),
    script.custom(TOKEN_USAGE, { inputTokens: 21, outputTokens: 9 }),
    script.custom(SESSION_STATS, { turns: 1, steps: 3, llmMs: 1200, toolMs: 300 }),
  ]);
}

describe('foldSubagentUsage', () => {
  it('取那一頁帶的兩顆總帳，是子代理自己的數字', () => {
    expect(foldSubagentUsage(subagentPage())).toEqual({
      tokenUsage: { inputTokens: 21, outputTokens: 9 },
      sessionStats: { turns: 1, steps: 3, llmMs: 1200, toolMs: 300 },
    });
  });

  it('那一頁沒帶總帳（它一次都沒記到帳，初值不送）就是兩個 null', () => {
    const script = new Script();
    expect(foldSubagentUsage(page(script.human('h', '去查一下')))).toEqual({
      tokenUsage: null,
      sessionStats: null,
    });
  });
});

describe('createSubagentUsageLoader', () => {
  function clientWith(subagentHistory: WireClient['subagentHistory']): WireClient {
    return { subagentHistory } as unknown as WireClient;
  }

  it('問那條 thread 的那個 runId，只要最後 1 則（數字跟切頁無關）', async () => {
    const subagentHistory = vi.fn(async () => ({ kind: 'ok' as const, result: subagentPage() }));
    const load = createSubagentUsageLoader(clientWith(subagentHistory), 'thread-1');
    const outcome = await load('bg-1');
    expect(subagentHistory).toHaveBeenCalledWith('thread-1', 'bg-1', { maxMessages: 1 });
    expect(outcome).toEqual({
      ok: true,
      usage: {
        tokenUsage: { inputTokens: 21, outputTokens: 9 },
        sessionStats: { turns: 1, steps: 3, llmMs: 1200, toolMs: 300 },
      },
    });
  });

  it('被拒絕是一句話，不是 0', async () => {
    const load = createSubagentUsageLoader(
      clientWith(async () => ({
        kind: 'rejected' as const,
        message: '沒有編號 bg-1 的背景子代理',
      })),
      't',
    );
    expect(await load('bg-1')).toEqual({ ok: false, message: '沒有編號 bg-1 的背景子代理' });
  });

  it('連線拋錯也是一句話', async () => {
    const load = createSubagentUsageLoader(
      clientWith(async () => {
        throw new TypeError('fetch failed');
      }),
      't',
    );
    expect(await load('bg-1')).toEqual({ ok: false, message: '連線出了問題' });
  });
});
