/**
 * 分叉的切點換算（[#1580](https://github.com/DemianLi/nexus-agent/issues/1580) 刀 2）：`messageId` → 同一輪收尾那顆 `turn/end` 的 `seq`。
 */

import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';

import { forkBoundaryOf } from './fork-boundary.js';
import { toLoggedMessage } from './logged-message.js';
import { buildForkSeed, SessionLog } from './session-log.js';

function reply(id: string, text: string) {
  return toLoggedMessage(new AIMessage({ content: text, id }));
}

/** 三輪，每輪一則回覆 `m<n>`；第二輪有兩則（`m2a` 中途、`m2b` 收尾）。回傳日誌與每輪 `turn/end` 的 seq。 */
function threeTurns() {
  const log = new SessionLog('source');
  const ends: number[] = [];
  log.append('turn/start', { kind: 'message', text: '一' });
  log.append('assistant/message', { message: reply('m1', '好') });
  ends.push(log.append('turn/end', {}).seq);
  log.append('turn/start', { kind: 'message', text: '二' });
  log.append('assistant/message', { message: reply('m2a', '先查') });
  log.append('tool/call', { callId: 'c1', name: 'ls', arguments: '{}' });
  log.append('tool/result', { callId: 'c1', isError: false });
  log.append('assistant/message', { message: reply('m2b', '查完了') });
  ends.push(log.append('turn/end', {}).seq);
  log.append('turn/start', { kind: 'message', text: '三' });
  log.append('assistant/message', { message: reply('m3', '好') });
  ends.push(log.append('turn/end', {}).seq);
  return { log, ends };
}

describe('forkBoundaryOf', () => {
  it('指名一輪的回覆，換算成那一輪的 turn/end', () => {
    const { log, ends } = threeTurns();
    expect(forkBoundaryOf(log.events, 'm1')).toBe(ends[0]);
    expect(forkBoundaryOf(log.events, 'm2b')).toBe(ends[1]);
    expect(forkBoundaryOf(log.events, 'm3')).toBe(ends[2]);
  });

  it('同一輪中途那則回覆也換算到同一顆 turn/end', () => {
    const { log, ends } = threeTurns();
    expect(forkBoundaryOf(log.events, 'm2a')).toBe(ends[1]);
  });

  it('換算出來的切點交得給 buildForkSeed', () => {
    const { log } = threeTurns();
    const boundary = forkBoundaryOf(log.events, 'm2b');
    if (boundary === undefined) throw new Error('應該分得出去');
    const seed = buildForkSeed(log.events, boundary);
    expect(seed.at(-2)?.type).toBe('turn/end');
    expect(seed.at(-1)).toMatchObject({ type: 'session/end-seed', data: { inherited: true } });
  });

  it('找不到這個 id、或它是使用者的話：分不出去', () => {
    const { log } = threeTurns();
    expect(forkBoundaryOf(log.events, 'nope')).toBeUndefined();
    const withUser = new SessionLog('u');
    withUser.append('turn/start', { kind: 'message', text: '一' });
    withUser.append('user/message', {
      message: toLoggedMessage(new HumanMessage({ content: '一', id: 'h1' })),
      source: { kind: 'plugin', plugin: 'update_goal' },
    });
    withUser.append('turn/end', {});
    expect(forkBoundaryOf(withUser.events, 'h1')).toBeUndefined();
  });

  it('那一輪還沒收尾：分不出去', () => {
    const log = new SessionLog('open');
    log.append('turn/start', { kind: 'message', text: '一' });
    log.append('assistant/message', { message: reply('m1', '寫到一半') });
    expect(forkBoundaryOf(log.events, 'm1')).toBeUndefined();
  });

  it('失敗收尾的那一輪：分不出去', () => {
    const log = new SessionLog('failed');
    log.append('turn/start', { kind: 'message', text: '一' });
    log.append('assistant/message', { message: reply('m1', '先查') });
    log.append('turn/failed', { message: '模型掛了' });
    expect(forkBoundaryOf(log.events, 'm1')).toBeUndefined();
  });

  it('停在核准點、沒人回答（那一段也有 turn/end）：分不出去', () => {
    const log = new SessionLog('paused');
    log.append('turn/start', { kind: 'message', text: '一' });
    log.append('assistant/message', { message: reply('m1', '要跑指令') });
    log.append('interrupt/raised', { interruptId: 'i1' });
    log.append('turn/end', {});
    expect(forkBoundaryOf(log.events, 'm1')).toBeUndefined();
  });

  it('核准之後接著跑完：換算到這個邏輯輪最後一顆 turn/end', () => {
    const log = new SessionLog('resumed');
    log.append('turn/start', { kind: 'message', text: '一' });
    log.append('assistant/message', { message: reply('m1', '要跑指令') });
    log.append('interrupt/raised', { interruptId: 'i1' });
    log.append('turn/end', {});
    log.append('turn/start', { kind: 'resume' });
    log.append('assistant/message', { message: reply('m2', '跑完了') });
    const end = log.append('turn/end', {});
    expect(forkBoundaryOf(log.events, 'm1')).toBe(end.seq);
    expect(forkBoundaryOf(log.events, 'm2')).toBe(end.seq);
  });

  it('核准之後接著跑、還沒收：分不出去', () => {
    const log = new SessionLog('resuming');
    log.append('turn/start', { kind: 'message', text: '一' });
    log.append('assistant/message', { message: reply('m1', '要跑指令') });
    log.append('interrupt/raised', { interruptId: 'i1' });
    log.append('turn/end', {});
    log.append('turn/start', { kind: 'resume' });
    expect(forkBoundaryOf(log.events, 'm1')).toBeUndefined();
  });

  it('核准之後接著跑、失敗收尾：分不出去', () => {
    const log = new SessionLog('resume-failed');
    log.append('turn/start', { kind: 'message', text: '一' });
    log.append('assistant/message', { message: reply('m1', '要跑指令') });
    log.append('interrupt/raised', { interruptId: 'i1' });
    log.append('turn/end', {});
    log.append('turn/start', { kind: 'resume' });
    log.append('turn/failed', { message: '模型掛了' });
    expect(forkBoundaryOf(log.events, 'm1')).toBeUndefined();
  });

  it('前一輪的 turn/end 不會被下一輪的回覆借走', () => {
    const log = new SessionLog('next-open');
    log.append('turn/start', { kind: 'message', text: '一' });
    log.append('assistant/message', { message: reply('m1', '好') });
    const first = log.append('turn/end', {});
    log.append('turn/start', { kind: 'message', text: '二' });
    log.append('assistant/message', { message: reply('m2', '寫到一半') });
    expect(forkBoundaryOf(log.events, 'm1')).toBe(first.seq);
    expect(forkBoundaryOf(log.events, 'm2')).toBeUndefined();
  });
});

// 下面三條的序列，今天的生產者寫不出來，但 `SessionLog` 照收（#1580 刀 2a 審查 N2）。所以它們釘的是函式本身的判斷，
// 不靠「生產者一定先寫 turn/start」這種別處的保證：每一條各殺一個只在生產者寫法下才等價的突變。
describe('forkBoundaryOf：日誌照收、生產者今天寫不出來的序列', () => {
  it('turn/end 之後緊接 turn/failed（中間沒有 resume）：仍然分不出去', () => {
    const log = new SessionLog('end-then-failed');
    log.append('turn/start', { kind: 'message', text: '一' });
    log.append('assistant/message', { message: reply('m1', '好') });
    log.append('turn/end', {});
    log.append('turn/failed', { message: '收尾之後又失敗' });
    expect(forkBoundaryOf(log.events, 'm1')).toBeUndefined();
  });

  it('turn/end 之後一顆 resume 的 turn/start、沒有核准點、還沒收：分不出去', () => {
    const log = new SessionLog('resume-without-interrupt');
    log.append('turn/start', { kind: 'message', text: '一' });
    log.append('assistant/message', { message: reply('m1', '好') });
    log.append('turn/end', {});
    log.append('turn/start', { kind: 'resume' });
    expect(forkBoundaryOf(log.events, 'm1')).toBeUndefined();
  });

  it('同一個邏輯輪連著兩顆 turn/end（中間沒有 resume）：取最後一顆', () => {
    const log = new SessionLog('two-ends');
    log.append('turn/start', { kind: 'message', text: '一' });
    log.append('assistant/message', { message: reply('m1', '好') });
    log.append('turn/end', {});
    const last = log.append('turn/end', {});
    expect(forkBoundaryOf(log.events, 'm1')).toBe(last.seq);
  });
});
