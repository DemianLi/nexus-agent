import { describe, expect, it } from 'vitest';

import { createWireClient } from './client.js';
import { THREAD_SEARCH_PATH } from './protocol.js';

/**
 * 按內容搜尋的 client 那一半（#631）。server 那一半在 `@nexus/harness` 的 `thread-search.test.ts` 與
 * `serve-thread-search.test.ts`。
 */

describe('searchThreads', () => {
  it('POST 帶 content-type 與 query；結果照原樣交出', async () => {
    const seen: { url: string; method?: string; contentType: string | null; body: unknown }[] = [];
    const client = createWireClient({
      baseUrl: 'http://agent.test/',
      fetch: async (input, init) => {
        seen.push({
          url: String(input),
          ...(init?.method === undefined ? {} : { method: init.method }),
          contentType: new Headers(init?.headers).get('content-type'),
          body: JSON.parse(String(init?.body)),
        });
        return Response.json({
          type: 'success',
          result: { items: [{ threadId: 't', snippet: '…會話清單…' }], hasMore: true },
        });
      },
    });
    expect(await client.searchThreads('會話')).toEqual({
      kind: 'ok',
      result: { items: [{ threadId: 't', snippet: '…會話清單…' }], hasMore: true },
    });
    expect(seen).toEqual([
      {
        url: `http://agent.test${THREAD_SEARCH_PATH}`,
        method: 'POST',
        contentType: 'application/json',
        body: { query: '會話' },
      },
    ]);
  });

  it('協定層的失敗是 rejected，帶著原因；載體層的失敗拋', async () => {
    const refused = createWireClient({
      baseUrl: 'http://agent.test',
      fetch: async () =>
        Response.json({ type: 'error', id: null, error: 'not_supported', message: '沒開' }),
    });
    expect(await refused.searchThreads('x')).toEqual({
      kind: 'rejected',
      code: 'not_supported',
      message: '沒開',
    });
    const blocked = createWireClient({
      baseUrl: 'http://agent.test',
      fetch: async () => new Response('unauthorized', { status: 401 }),
    });
    await expect(blocked.searchThreads('x')).rejects.toThrow('搜尋被載體層擋下：401 unauthorized');
  });

  it('回來的形狀不對就拋：這是別人的位元組', async () => {
    for (const result of [
      { items: [] },
      { items: 'x', hasMore: false },
      { items: [{ threadId: 't' }], hasMore: false },
    ]) {
      const client = createWireClient({
        baseUrl: 'http://agent.test',
        fetch: async () => Response.json({ type: 'success', result }),
      });
      await expect(client.searchThreads('x')).rejects.toThrow(THREAD_SEARCH_PATH);
    }
  });
});
