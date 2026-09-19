import { describe, expect, it } from 'vitest';

import { emptyConversation, reduceAll } from './conversation.js';
import type { Event } from './protocol.js';
import { changesDiffPath, changesSummaryPath, WORKSPACE_CHANGES } from './workspace-changes.js';

describe('workspace/changes', () => {
  it('這顆 frame 折不出任何一格：卡片由 web 拿 seq 去路由要，折疊器不替它長格子', () => {
    const frame = {
      type: 'event',
      seq: 0,
      event_id: 't:0',
      method: 'custom',
      params: {
        namespace: [],
        timestamp: 0,
        data: { name: WORKSPACE_CHANGES, payload: { seq: 7 } },
      },
    } as Event;
    const state = reduceAll(emptyConversation(), [frame]);
    expect(state.entries).toEqual([]);
    expect(state.lastSeq).toBe(0);
  });

  it('路徑掛在 thread 底下，id 要編碼', () => {
    expect(changesSummaryPath('a/b')).toBe('/threads/a%2Fb/changes/summary');
    expect(changesDiffPath('t')).toBe('/threads/t/changes/diff');
  });
});
