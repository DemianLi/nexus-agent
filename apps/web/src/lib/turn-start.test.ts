import type { ConversationEntry } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { startsTurn } from '@/lib/turn-start';

const entry = (kind: string) => ({ kind, id: 'x' }) as unknown as ConversationEntry;

describe('startsTurn', () => {
  it('人的話、結算通知、子代理寄來的話切輪；其餘都不切', () => {
    expect(['human', 'notice', 'agent-message'].map((kind) => startsTurn(entry(kind)))).toEqual([
      true,
      true,
      true,
    ]);
    expect(
      ['ai', 'tool', 'answer', 'deliverables', 'workspace-changes'].map((kind) =>
        startsTurn(entry(kind)),
      ),
    ).toEqual([false, false, false, false, false]);
  });
});
