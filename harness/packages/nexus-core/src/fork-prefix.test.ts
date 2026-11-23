/**
 * 分叉前綴（[#1579](https://github.com/DemianLi/nexus-agent/issues/1579)）：切點、`buildForkSeed`、`SessionLog` 的
 * `ownEvents`／`isOwnSeq`、子代理判準，以及從日誌折「我擁有的狀態」的兩支（子代理目錄、評分）。
 */

import { AIMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';

import { currentMessageFeedback } from './feedback.js';
import { toLoggedMessage } from './logged-message.js';
import {
  buildForkSeed,
  currentTurnStart,
  hasUnansweredInterrupt,
  inheritedEventCount,
  openTurnStart,
  SessionLog,
} from './session-log.js';
import type { SessionEvent } from './session-log.js';
import { isSubagentSessionHeader } from './session-store.js';
import { appendSubagentCatalog, subagentLinks } from './subagent-catalog.js';

function reply(id: string, text: string) {
  return toLoggedMessage(new AIMessage({ content: text, id }));
}

/** 父會話：一輪，裡面派了一個子代理、回覆被評了一次。最後一顆是那一輪的 `turn/end`。 */
function parentLog(): SessionLog {
  const log = new SessionLog('parent');
  log.append('turn/start', { kind: 'message', text: '一' });
  log.append('tool/call', { callId: 'c1', name: 'task', arguments: '{}' });
  appendSubagentCatalog(log, { childId: 'parent/x', callId: 'c1', mode: 'continuable' });
  log.append('assistant/message', { message: reply('m1', '好') });
  log.append('feedback/message-put', {
    item: { messageId: 'm1', rating: 'negative', version: 'v1', createdAt: 1, updatedAt: 1 },
  });
  log.append('turn/end', {});
  return log;
}

describe('inheritedEventCount', () => {
  it('沒有 inherited 標記是 0；普通的 end-seed 不算', () => {
    const log = new SessionLog('t', {
      seed: [{ type: 'turn/end', seq: 0, time: 1, data: {} } as SessionEvent],
    });
    expect(log.events.map((event) => event.type)).toEqual(['turn/end', 'session/end-seed']);
    expect(inheritedEventCount(log.events)).toBe(0);
    expect(log.inheritedEventCount).toBe(0);
  });

  it('取最後一顆 inherited 標記的 seq（分叉再分叉時前綴裡有祖先的標記）', () => {
    const first = buildForkSeed(parentLog().events, 5);
    const child = new SessionLog('child', { seed: first });
    child.append('turn/start', { kind: 'message', text: '二' });
    const end = child.append('turn/end', {});
    const second = buildForkSeed(child.events, end.seq);
    expect(inheritedEventCount(first)).toBe(6);
    expect(inheritedEventCount(second)).toBe(end.seq + 1);
  });
});

describe('buildForkSeed', () => {
  it('前綴原樣、seq 不改，接一顆 inherited 標記：seq 是 boundary + 1、time 抄切點那一顆（同 dsh fork.ts:21-30）', () => {
    const source = parentLog().events;
    const seed = buildForkSeed(source, 5);
    expect(seed.slice(0, 6)).toEqual(source);
    expect(seed[0]).toBe(source[0]);
    expect(seed[6]).toEqual({
      type: 'session/end-seed',
      seq: 6,
      time: source[5]!.time,
      data: { inherited: true },
    });
    expect(seed).toHaveLength(7);
  });

  it('切點不是 turn/end、或不在來源裡，都拋（不產生開著回合的閉合）', () => {
    const source = parentLog().events;
    expect(() => buildForkSeed(source, 3)).toThrow(/turn\/end/);
    expect(() => buildForkSeed(source, 6)).toThrow(RangeError);
    expect(() => buildForkSeed(source, -1)).toThrow(RangeError);
    expect(() => buildForkSeed(source, 1.5)).toThrow(RangeError);
  });
});

describe('SessionLog 帶分叉前綴', () => {
  it('剛分叉：不再補 end-seed；切點是標記的位置，標記與之後的才是自己的', () => {
    const log = new SessionLog('child', { seed: buildForkSeed(parentLog().events, 5) });
    expect(log.length).toBe(7);
    expect(log.inheritedEventCount).toBe(6);
    expect(log.ownEvents().map((event) => event.seq)).toEqual([6]);
    expect(log.isOwnSeq(5)).toBe(false);
    expect(log.isOwnSeq(6)).toBe(true);
    expect(log.isOwnSeq(7)).toBe(false);
    log.append('turn/start', { kind: 'message', text: '二' });
    expect(log.isOwnSeq(7)).toBe(true);
    expect(log.ownEvents().map((event) => event.seq)).toEqual([6, 7]);
  });

  it('續接一份分叉來的日誌（驗收 4）：從 length 接著編號、結尾補普通的 end-seed，inherited 標記留在原位', () => {
    const forked = new SessionLog('child', { seed: buildForkSeed(parentLog().events, 5) });
    forked.append('turn/start', { kind: 'message', text: '二' });
    forked.append('turn/end', {});
    const stored = forked.events;

    const resumed = new SessionLog('child', { seed: stored });
    expect(resumed.length).toBe(stored.length + 1);
    expect(resumed.events.at(-1)).toMatchObject({
      type: 'session/end-seed',
      seq: stored.length,
      data: {},
    });
    expect(resumed.events[6]).toMatchObject({
      type: 'session/end-seed',
      data: { inherited: true },
    });
    expect(resumed.inheritedEventCount).toBe(6);
    expect(resumed.append('turn/start', { kind: 'message', text: '三' }).seq).toBe(
      stored.length + 1,
    );
  });

  it('讀「當前這一段」的人在 inherited 標記重設，同普通的 end-seed', () => {
    const parent = new SessionLog('parent');
    parent.append('turn/start', { kind: 'message', text: '一' });
    parent.append('interrupt/raised', { interruptId: 'i-1' });
    parent.append('turn/end', {});
    const events = new SessionLog('child', { seed: buildForkSeed(parent.events, 2) }).events;
    // 前綴裡有一顆沒回答的中斷；不切的話它會被讀成「這一份還有人在等回答」。
    expect(hasUnansweredInterrupt(parent.events)).toBe(true);
    expect(hasUnansweredInterrupt(events)).toBe(false);
    expect(currentTurnStart(events)).toBe(-1);
    expect(openTurnStart(events)).toBe(-1);
  });
});

describe('從日誌折「我擁有的狀態」不算前綴（驗收 5）', () => {
  function forked(): SessionLog {
    const log = new SessionLog('child', { seed: buildForkSeed(parentLog().events, 5) });
    log.append('turn/start', { kind: 'message', text: '二' });
    log.append('tool/call', { callId: 'c2', name: 'task', arguments: '{}' });
    appendSubagentCatalog(log, { childId: 'child/y', callId: 'c2', mode: 'one-shot' });
    log.append('assistant/message', { message: reply('m2', '再好') });
    log.append('turn/end', {});
    return log;
  }

  it('子代理目錄：父會話派的不列，自己派的照列（同 dsh catalog.ts:121-126）', () => {
    const log = forked();
    expect(subagentLinks(log.events).map((link) => link.childId)).toEqual(['parent/x', 'child/y']);
    expect(subagentLinks(log.events, log.inheritedEventCount).map((link) => link.childId)).toEqual([
      'child/y',
    ]);
  });

  it('評分：父會話給的不算；前綴裡的回覆照樣能在分叉之後重新評', () => {
    const log = forked();
    const ids = (cut: number) =>
      currentMessageFeedback(log.events, cut).map(({ item }) =>
        'messageId' in item ? `${item.messageId}:${item.rating}` : '?',
      );
    expect(ids(0)).toEqual(['m1:negative']);
    expect(ids(log.inheritedEventCount)).toEqual([]);
    log.append('feedback/message-put', {
      item: { messageId: 'm1', rating: 'positive', version: 'v2', createdAt: 2, updatedAt: 2 },
    });
    expect(ids(log.inheritedEventCount)).toEqual(['m1:positive']);
  });
});

describe('isSubagentSessionHeader（驗收 1）', () => {
  it.each([
    ['舊子代理 header：有 parentSession、沒有 origin', { parentSession: 'root' }, true],
    ['新子代理 header：origin', { parentSession: 'root', origin: 'subagent' as const }, true],
    [
      '分叉 header：parentSession 加 isSeeded',
      { parentSession: 'root', isSeeded: true as const },
      false,
    ],
    ['什麼都沒有', {}, false],
    // 只有 `origin` 分得出來的一列：dsh 的子代理可以帶 seed 開（`subagent/subagent/src/manager.ts:421`），退路那條判它不是子代理。
    [
      '帶 seed 開出來的子代理：origin 加 isSeeded',
      { parentSession: 'root', origin: 'subagent' as const, isSeeded: true as const },
      true,
    ],
  ])('%s', (_label, header, expected) => {
    expect(isSubagentSessionHeader(header)).toBe(expected);
  });
});
