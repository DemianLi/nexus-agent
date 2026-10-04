/**
 * 一筆這一版不認得、但標了 `ignorable` 的事件，穿過各個讀日誌的地方都不出事、也不改變它們的答案
 * （[#507](https://github.com/DemianLi/nexus-agent/issues/507)）。
 *
 * 守衛只保證「標了的讀得進來」；讀進來之後每一個折疊都得自己放行。這一檔把同一份日誌各讀兩次——有那一筆、沒有那一筆
 * （其餘事件的 `seq` 重新編號）——比答案。新增一個讀方卻忘了放行時，會紅在這裡，而不是紅在使用者的 thread 上。
 */

import { AIMessage } from '@langchain/core/messages';
import {
  deriveSessionStats,
  foldInbox,
  replayConversation,
  SessionLog,
  toLoggedMessage,
} from '@nexus/core';
import type { SessionEvent } from '@nexus/core';
import { foldGoal } from '@nexus/plugin-goal';
import { describe, expect, it } from 'vitest';

import { historyFrames } from './conversation-history.js';
import { DEFAULT_TOOL_TEXT_MAX_BYTES } from './settings/tool-text.js';

/** 兩輪對話，都有回覆、有工具呼叫、有模型起訖：所有讀方都有東西可折。 */
function baseline(): SessionEvent[] {
  const log = new SessionLog('t');
  log.append('turn/start', { kind: 'message', text: '嗨' });
  log.append('model/start', {});
  log.append('model/end', {});
  log.append('assistant/message', { message: toLoggedMessage(new AIMessage('你好')) });
  log.append('turn/end', {});
  log.append('turn/start', { kind: 'message', text: '再來一次' });
  log.append('model/start', {});
  log.append('model/end', {});
  log.append('assistant/message', { message: toLoggedMessage(new AIMessage('好')) });
  log.append('turn/end', {});
  return [...log.events];
}

/** 在 `at` 之前插一筆不認得、標了可忽略的；其餘照序重新編號。 */
function withFutureEventAt(events: readonly SessionEvent[], at: number): SessionEvent[] {
  const entries: object[] = [...events];
  entries.splice(at, 0, { type: 'future/thing', data: { n: 1 }, ignorable: true });
  return entries.map((entry, seq) => ({ ...entry, seq, time: 1 }) as unknown as SessionEvent);
}

/** 答案裡的 `seq` 與歷史幀的 id（`history-<seq>`）是位置，插了一筆就整串平移；比的是內容，所以抹掉位置。 */
function withoutPositions(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value), (key, entry: unknown) => {
    if (key === 'seq') return undefined;
    return typeof entry === 'string' ? entry.replace(/^history-\d+$/, 'history-N') : entry;
  });
}

describe('不認得但標了可忽略的事件', () => {
  const plain = baseline();
  for (const at of [0, 3, 5, plain.length]) {
    it(`插在第 ${at} 筆之前：各個讀方的答案跟沒有它時一樣`, () => {
      const withFuture = withFutureEventAt(plain, at);
      const renumbered = withFutureEventAt(plain, plain.length).slice(0, -1);
      expect(withFuture).toHaveLength(plain.length + 1);

      const answers = (events: readonly SessionEvent[]) => ({
        replay: replayConversation(events),
        inbox: foldInbox(events),
        goal: foldGoal(events),
        // 統計只數它認得的：不認得的那筆不多算一步、不多算一輪。
        stats: deriveSessionStats(events),
        history: historyFrames(events, DEFAULT_TOOL_TEXT_MAX_BYTES),
      });
      const expected = answers(renumbered);
      expect(expected.replay.kind).toBe('replayed');
      expect(withoutPositions(answers(withFuture))).toEqual(withoutPositions(expected));
    });
  }
});
