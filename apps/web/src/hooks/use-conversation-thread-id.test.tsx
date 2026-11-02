import type { Event, WireClient } from '@nexus/wire';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useConversation } from '@/hooks/use-conversation';
import { stubInsecureCrypto, UUID_V4 } from '@/test/insecure-crypto';

/** 沒給 `threadId` 時這一次載入自己開一條（#1548）：非安全環境的頁面上也要開得出來。 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setup() {
  const opened: string[] = [];
  const client = {
    openEvents: async (threadId: string) => {
      opened.push(threadId);
      return (async function* stream(): AsyncGenerator<Event> {
        yield* [] as Event[];
        await new Promise<void>(() => {});
      })();
    },
    threadHistory: async () => ({
      kind: 'ok',
      result: { events: [], firstSeq: 0, throughSeq: 0, hasMore: false, legacy: false },
    }),
    slashList: async () => ({ kind: 'ok', commands: [] }),
  } as unknown as WireClient;
  return { client, opened };
}

describe('useConversation 沒給 threadId（#1548）', () => {
  it('沒有 crypto.randomUUID：render 不拋錯，開的那條 id 是 UUID v4', async () => {
    stubInsecureCrypto();
    const { client, opened } = setup();
    renderHook(() => useConversation({ client }));
    await waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0]).toMatch(UUID_V4);
  });
});
