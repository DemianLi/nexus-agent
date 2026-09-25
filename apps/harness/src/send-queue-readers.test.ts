/**
 * **讀日誌的那幾個，在佇列事件插進來之後照舊**——[#637](https://github.com/DemianLi/nexus-agent/issues/637)
 * 「動工前要查」那一節的絆索。
 *
 * `inbox/spliced` 會出現在以前沒有東西的位置：送出時在一輪前面（閒著時也一樣）、領走時在 `turn/start` 之後、停在
 * 核准點時收下的那句在 `interrupt/raised` 之後與 `resume` 的 `turn/start` 之前。每個讀者各一條，而且驗到第二輪。
 *
 * 另外兩個讀者不在這裡：日誌不變量的輪次配對見 `packages/nexus-core/src/invariant.test.ts` 的「送出佇列」那組；
 * `turn/start.kind` 的授權判準（`@nexus/plugin-goal` 的 `authority.ts`）往回找時只認 `turn/start`、其餘跳過，
 * 佇列事件落在哪裡都一樣。
 */

import { goalId, hasUnansweredInterrupt, SessionLog } from '@nexus/core';
import type { SessionEventMap } from '@nexus/core';
import type { GoalView } from '@nexus/plugin-goal';
import { describe, expect, it } from 'vitest';

import { historyPage } from './conversation-history.js';
import { scanSessionLog } from './eval/session-scan.js';
import { decideGoalRound } from './goal-driver.js';

const item = (id: string) => ({ id, text: id, source: { kind: 'user' as const } });
const INSERT = (id: string, start = 0) =>
  ['inbox/spliced', { target: 'next-turn', start, inserted: [item(id)] }] as const;
const CLAIM = [
  'inbox/spliced',
  { target: 'next-turn', start: 0, removedCount: 1, inserted: [] },
] as const;

function logOf(script: readonly (readonly [string, unknown])[]): SessionLog {
  const log = new SessionLog('readers');
  for (const [type, data] of script) {
    log.append(type as 'turn/end', data as SessionEventMap['turn/end']);
  }
  return log;
}

function view(overrides: Partial<GoalView> = {}): GoalView {
  return {
    id: goalId('goal-1'),
    revision: 1,
    objective: '把 CI 修綠',
    phase: 'active',
    maxGoalRounds: 8,
    roundsStarted: 0,
    createdAt: 10,
    updatedAt: 10,
    activation: 'armed',
    ...overrides,
  };
}

describe('goal 續行的判準', () => {
  it('兩輪都走佇列（領走那顆在輪內、下一句插在輪外）：收掉之後照樣排', () => {
    const events = logOf([
      INSERT('a'),
      ['turn/start', { kind: 'message', text: 'a' }],
      CLAIM,
      INSERT('b'),
      ['turn/end', {}],
      ['turn/start', { kind: 'message', text: 'b' }],
      CLAIM,
      ['turn/end', {}],
    ]).events;
    expect(decideGoalRound(events, view()).kind).toBe('run');
  });

  it('第二輪還開著：turn-open，不會因為最後一顆是 splice 就當成收了', () => {
    const events = logOf([
      INSERT('a'),
      ['turn/start', { kind: 'message', text: 'a' }],
      CLAIM,
      ['turn/end', {}],
      INSERT('b'),
      ['turn/start', { kind: 'message', text: 'b' }],
      CLAIM,
      INSERT('c'),
    ]).events;
    expect(decideGoalRound(events, view())).toEqual({ kind: 'idle', reason: 'turn-open' });
  });

  it('停在核准點時插進一句：中斷照樣算沒答，答完之後照樣排', () => {
    const suspended = [
      INSERT('a'),
      ['turn/start', { kind: 'message', text: 'a' }],
      CLAIM,
      ['interrupt/raised', { interruptId: 'i1' }],
      ['turn/end', {}],
      INSERT('b'),
    ] as const;
    const waiting = logOf(suspended).events;
    expect(hasUnansweredInterrupt(waiting)).toBe(true);
    expect(decideGoalRound(waiting, view())).toEqual({ kind: 'idle', reason: 'interrupt-pending' });

    const answered = logOf([
      ...suspended,
      ['turn/start', { kind: 'resume' }],
      ['turn/end', {}],
      ['turn/start', { kind: 'message', text: 'b' }],
      CLAIM,
      ['turn/end', {}],
    ]).events;
    expect(hasUnansweredInterrupt(answered)).toBe(false);
    expect(decideGoalRound(answered, view()).kind).toBe('run');
  });

  it('按停止之後排著的停住：那一輪 aborted，續行不排', () => {
    const events = logOf([
      INSERT('a'),
      ['turn/start', { kind: 'message', text: 'a' }],
      CLAIM,
      INSERT('b'),
      ['turn/end', { reason: { kind: 'aborted', cause: { kind: 'user' } } }],
    ]).events;
    expect(decideGoalRound(events, view())).toEqual({ kind: 'idle', reason: 'turn-aborted' });
  });
});

describe('歷史', () => {
  it('切頁照舊在人開的 turn/start 上切：佇列事件不算一則訊息、不另起一頁', () => {
    const events = logOf([
      INSERT('a'),
      ['turn/start', { kind: 'message', text: 'a' }],
      CLAIM,
      INSERT('b'),
      ['turn/end', {}],
      ['turn/start', { kind: 'message', text: 'b' }],
      CLAIM,
      ['turn/end', {}],
    ]).events;
    const last = historyPage(events, { maxMessages: 1 });
    // 第二輪的 `turn/start` 在 seq 5。
    expect(last.firstSeq).toBe(5);
    expect(last.hasMore).toBe(true);
    const older = historyPage(events, { maxMessages: 1, beforeSeq: 5 });
    expect(older.firstSeq).toBe(1);
  });

  it('佇列事件不畫成泡泡：人的話只來自 turn/start，一輪一則', () => {
    const events = logOf([
      INSERT('a'),
      ['turn/start', { kind: 'message', text: 'a' }],
      CLAIM,
      INSERT('b'),
      ['turn/end', {}],
      ['turn/start', { kind: 'message', text: 'b' }],
      CLAIM,
      ['turn/end', {}],
    ]).events;
    const humans = historyPage(events).events.filter(
      (frame) =>
        frame.method === 'messages' &&
        (frame.params.data as { event?: string; role?: string }).role === 'human',
    );
    expect(humans).toHaveLength(2);
  });
});

describe('scan', () => {
  it('認得 inbox/spliced：不報成不認得的事件種類', () => {
    const log = logOf([
      INSERT('a'),
      ['turn/start', { kind: 'message', text: 'a' }],
      CLAIM,
      ['turn/end', {}],
    ]);
    const report = scanSessionLog({
      file: 'readers.jsonl',
      header: { version: 17, id: 'readers' },
      events: log.events,
    });
    expect(report.unknownEvents).toBe(0);
  });
});
