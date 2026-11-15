/**
 * 從日誌還原記過的壓縮動作時，壞事件的錯誤訊息帶事件種類與 `seq`：整份讀、單顆累積、推導與增量推導四條路都一樣。
 */

import { describe, expect, it } from 'vitest';

import { deriveConversation } from './conversation-replay.js';
import { readingEvent } from './event-read-error.js';
import { ModelHistoryCache } from './model-history.js';
import type { SessionEvent } from './session-log.js';
import { recordArgTruncationsInto, recordedArgTruncationsOf } from './tool-arg-truncation-log.js';
import { recordPruneInto, recordedPrunesOf } from './tool-result-prune-log.js';

const event = (type: string, data: unknown, seq: number): SessionEvent =>
  ({ type, data, seq, time: 0 }) as unknown as SessionEvent;

const badPrune = event('compaction/prune', { results: 1 }, 5);
const badNullPrune = event('compaction/prune', { results: [null] }, 6);
const badTruncation = event('compaction/truncate-args', { calls: 1 }, 7);
const badNullArgs = event('compaction/truncate-args', { calls: [{ callId: 'a', args: null }] }, 8);

const PRUNE_MESSAGE = /^compaction\/prune 事件讀不出來（seq 5）：.*results is not iterable$/;
const TRUNCATION_MESSAGE =
  /^compaction\/truncate-args 事件讀不出來（seq 7）：.*calls is not iterable$/;

describe('readingEvent', () => {
  it('沒拋就原樣回傳', () => {
    expect(readingEvent({ type: 'compaction/prune', seq: 1 }, () => 42)).toBe(42);
  });

  it('拋了：訊息帶種類與 seq，cause 是原錯；非 Error 的拋出物也轉成字串', () => {
    const original = new TypeError('壞了');
    try {
      readingEvent({ type: 'compaction/prune', seq: 3 }, () => {
        throw original;
      });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toBe('compaction/prune 事件讀不出來（seq 3）：壞了');
      expect((error as Error).cause).toBe(original);
    }
    expect(() =>
      readingEvent({ type: 'x', seq: 1 }, () => {
        throw 'plain';
      }),
    ).toThrow('x 事件讀不出來（seq 1）：plain');
  });
});

describe('壞事件的錯誤訊息帶事件種類與 seq', () => {
  it.each([
    ['recordedPrunesOf', () => recordedPrunesOf([badPrune]), PRUNE_MESSAGE],
    ['recordPruneInto', () => recordPruneInto(new Map(), badPrune), PRUNE_MESSAGE],
    [
      'recordedArgTruncationsOf',
      () => recordedArgTruncationsOf([badTruncation]),
      TRUNCATION_MESSAGE,
    ],
    [
      'recordArgTruncationsInto',
      () => recordArgTruncationsInto(new Map(), badTruncation),
      TRUNCATION_MESSAGE,
    ],
    [
      'deriveConversation（applyPrunes）',
      () => deriveConversation([badPrune], { applyPrunes: true }),
      PRUNE_MESSAGE,
    ],
    [
      'deriveConversation（applyArgTruncations）',
      () => deriveConversation([badTruncation], { applyArgTruncations: true }),
      TRUNCATION_MESSAGE,
    ],
    [
      'ModelHistoryCache（applyPrunes，增量路徑）',
      () => new ModelHistoryCache({ applyPrunes: true }).derive([badPrune]),
      PRUNE_MESSAGE,
    ],
    [
      'ModelHistoryCache（applyArgTruncations，增量路徑）',
      () => new ModelHistoryCache({ applyArgTruncations: true }).derive([badTruncation]),
      TRUNCATION_MESSAGE,
    ],
  ] as const)('%s', (_label, read, message) => {
    expect(read).toThrow(message);
  });

  it.each([
    ['compaction/prune', badNullPrune, () => recordedPrunesOf([badNullPrune])],
    ['compaction/truncate-args', badNullArgs, () => recordedArgTruncationsOf([badNullArgs])],
  ] as const)(
    '內容裡的元素壞了（不是陣列本身）：%s 一樣帶種類與 seq，cause 保留原錯',
    (kind, bad, read) => {
      try {
        read();
        expect.unreachable();
      } catch (error) {
        expect((error as Error).message).toContain(`${kind} 事件讀不出來（seq ${bad.seq}）`);
        expect((error as Error).cause).toBeInstanceOf(TypeError);
      }
    },
  );

  it('不是壓縮動作的事件、好事件都不受影響', () => {
    expect(recordedPrunesOf([badTruncation]).size).toBe(0);
    expect(recordedArgTruncationsOf([badPrune]).size).toBe(0);
    expect(recordedPrunesOf([event('compaction/prune', { results: [] }, 1)]).size).toBe(0);
  });
});
