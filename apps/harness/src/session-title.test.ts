/**
 * 會話標題的退回規則與寫法（[#647](https://github.com/DemianLi/nexus-agent/issues/647)）。
 *
 * 產品路徑上誰在什麼時刻寫、線上送出什麼，在 `session-title-wire.test.ts`；列表怎麼讀在 `session-list.test.ts`。
 */

import { SessionLog } from '@nexus/core';
import type { GoalId, SessionEvent } from '@nexus/core';
import { describe, expect, it } from 'vitest';

import {
  assertThreadTitleLimits,
  ensureFallbackTitle,
  fallbackThreadTitle,
  threadTitleOf,
} from './session-title.js';

const LIMITS = { maxWords: 5, maxBytes: 40 };

const goal = {
  kind: 'goal',
  text: '目標排的那一輪',
  goalId: 'g1' as GoalId,
  revision: 1,
  round: 1,
} as const;

function titles(log: SessionLog): readonly SessionEvent<'session/title'>[] {
  return log.events.filter(
    (event): event is SessionEvent<'session/title'> => event.type === 'session/title',
  );
}

describe('fallbackThreadTitle', () => {
  it('中文吃位元組上限：40 個位元組是 13 個字，不切在一個字的中間', () => {
    const title = fallbackThreadTitle('請幫我把登入頁面的錯誤訊息改成中文並補上測試', LIMITS);
    expect(title).toBe('請幫我把登入頁面的錯誤訊息');
    expect(Buffer.byteLength(title, 'utf8')).toBeLessThanOrEqual(40);
  });

  it('英文吃詞數上限', () => {
    expect(fallbackThreadTitle('fix the login bug on safari please', LIMITS)).toBe(
      'fix the login bug on',
    );
  });

  it('控制字元、跳脫序列與方向控制字元都拿掉，空白收成一格', () => {
    const esc = String.fromCharCode(0x1b);
    const rlo = String.fromCharCode(0x202e);
    const bell = String.fromCharCode(0x07);
    expect(fallbackThreadTitle(`  ${esc}[31m紅字${esc}[0m\n\t${rlo}反過來${bell}  `, LIMITS)).toBe(
      '紅字 反過來',
    );
  });

  it('清完是空的就是空字串', () => {
    expect(fallbackThreadTitle(`  ${String.fromCharCode(0x200b)}  `, LIMITS)).toBe('');
  });
});

describe('assertThreadTitleLimits', () => {
  it('兩個都要是正整數', () => {
    expect(() => assertThreadTitleLimits(LIMITS)).not.toThrow();
    expect(() => assertThreadTitleLimits({ maxWords: 0, maxBytes: 40 })).toThrow(/maxWords/);
    expect(() => assertThreadTitleLimits({ maxWords: 5, maxBytes: 1.5 })).toThrow(/maxBytes/);
  });
});

describe('ensureFallbackTitle', () => {
  it('第一則人打的字：記一顆 fallback，messageSeqs 指到那顆 turn/start', () => {
    const log = new SessionLog('t');
    const start = log.append('turn/start', {
      kind: 'message',
      text: '請幫我把登入頁面的錯誤訊息改成中文',
    });
    ensureFallbackTitle(log, LIMITS);
    expect(titles(log).map((event) => event.data)).toEqual([
      {
        title: '請幫我把登入頁面的錯誤訊息',
        messageSeqs: [start.seq],
        source: { kind: 'fallback' },
      },
    ]);
  });

  it('已經有標題就不寫：第二句不換', () => {
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'message', text: '第一句' });
    ensureFallbackTitle(log, LIMITS);
    log.append('turn/start', { kind: 'message', text: '第二句' });
    ensureFallbackTitle(log, LIMITS);
    expect(titles(log).map((event) => event.data.title)).toEqual(['第一句']);
  });

  it('目標排的輪次與清完是空的那句不算；下一則合格的才寫', () => {
    const log = new SessionLog('t');
    log.append('turn/start', goal);
    ensureFallbackTitle(log, LIMITS);
    log.append('turn/start', { kind: 'message', text: `  ${String.fromCharCode(0x200b)} ` });
    ensureFallbackTitle(log, LIMITS);
    expect(titles(log)).toEqual([]);
    const start = log.append('turn/start', { kind: 'message', text: '這一句才算' });
    ensureFallbackTitle(log, LIMITS);
    expect(titles(log).map((event) => event.data)).toEqual([
      { title: '這一句才算', messageSeqs: [start.seq], source: { kind: 'fallback' } },
    ]);
  });

  it('18 以前的日誌接回來：推的是整份日誌裡第一則，不是這一句', () => {
    const seed = new SessionLog('t');
    seed.append('turn/start', { kind: 'message', text: '上一個行程的第一句' });
    seed.append('turn/end', {});
    const log = new SessionLog('t', { seed: seed.events });
    log.append('turn/start', { kind: 'message', text: '接回來之後的一句' });
    ensureFallbackTitle(log, LIMITS);
    expect(titles(log).map((event) => event.data)).toEqual([
      { title: '上一個行程的第一句', messageSeqs: [0], source: { kind: 'fallback' } },
    ]);
  });
});

describe('threadTitleOf', () => {
  it('讀最後一顆 session/title', () => {
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'message', text: '第一句' });
    log.append('session/title', { title: '甲', messageSeqs: [0], source: { kind: 'fallback' } });
    log.append('session/title', { title: '乙', messageSeqs: [0], source: { kind: 'fallback' } });
    expect(threadTitleOf(log.events, LIMITS)).toBe('乙');
  });

  it('一顆都沒有就照規則推，跟寫的那一邊一字不差；一則合格的都沒有是 undefined', () => {
    const log = new SessionLog('t');
    expect(threadTitleOf(log.events, LIMITS)).toBeUndefined();
    log.append('turn/start', goal);
    expect(threadTitleOf(log.events, LIMITS)).toBeUndefined();
    log.append('turn/start', { kind: 'message', text: 'fix the login bug on safari please' });
    const derived = threadTitleOf(log.events, LIMITS);
    expect(derived).toBe('fix the login bug on');
    ensureFallbackTitle(log, LIMITS);
    expect(titles(log)[0]?.data.title).toBe(derived);
  });
});
