/**
 * `llm-retry`／`llm-retry-started`（#520）的折疊：整份換掉、對得上才清、各種收尾都清、壞酬載不收、不進歷史。
 */

import { describe, expect, it } from 'vitest';

import {
  emptyConversation,
  prependEntries,
  reduceAll,
  reduceConversation,
} from './conversation.js';
import { LLM_RETRY, LLM_RETRY_STARTED } from './llm-retry.js';
import type { Event } from './protocol.js';

let seq = 0;
function event(method: string, data: unknown, namespace: string[] = [], timestamp = 0): Event {
  const current = seq++;
  return {
    type: 'event',
    seq: current,
    event_id: `c:${current}`,
    method,
    params: { namespace, timestamp, data },
  } as Event;
}

const PAYLOAD = { retryId: 'r1', retry: 1, maxRetries: 2, delayMs: 1500, code: 'TRANSPORT' };
const retry = (payload: unknown = PAYLOAD, timestamp = 0) =>
  event('custom', { name: LLM_RETRY, payload }, [], timestamp);
const started = (payload: unknown) => event('custom', { name: LLM_RETRY_STARTED, payload });
const running = () => event('lifecycle', { event: 'running', graph_name: 'root' });
const completed = () => event('lifecycle', { event: 'completed', graph_name: 'root' });
const failed = () => event('lifecycle', { event: 'failed', graph_name: 'root' });
const aborted = () => event('lifecycle', { event: 'failed', graph_name: 'root', aborted: true });
const start = (namespace: string[] = [], role = 'ai') =>
  event('messages', { event: 'message-start', role, run_id: `m${String(seq)}` }, namespace);
const fold = (...frames: Event[]) => reduceAll(emptyConversation(), frames);

describe('llm-retry', () => {
  it('初值是 null；llm-retry 到就整份換掉，since 取 frame 的時刻', () => {
    expect(emptyConversation().retry).toBeNull();
    expect(fold(running(), retry(PAYLOAD, 1234)).retry).toEqual({ ...PAYLOAD, since: 1234 });
  });

  it('frame 沒有時刻就不帶 since（不留值是 undefined 的鍵）', () => {
    const state = fold(running(), retry());
    expect(state.retry).toEqual(PAYLOAD);
    expect('since' in state.retry!).toBe(false);
  });

  it('retryId 不同也直接換；第二次重試換掉第一次', () => {
    const state = fold(running(), retry(), retry({ ...PAYLOAD, retryId: 'r2', retry: 2 }));
    expect(state.retry).toMatchObject({ retryId: 'r2', retry: 2 });
  });

  it('llm-retry-started：retryId 對得上才清；對不上、或本來就沒有，是 no-op', () => {
    const waiting = fold(running(), retry());
    expect(reduceConversation(waiting, started({ retryId: 'zzz', retry: 1 })).retry).toBe(
      waiting.retry,
    );
    expect(reduceConversation(waiting, started({ retryId: 'r1', retry: 1 })).retry).toBeNull();
    const none = fold(running());
    expect(reduceConversation(none, started({ retryId: 'r1', retry: 1 })).retry).toBeNull();
  });

  it('下一則 root 回覆開始就清；子代理的回覆與人話不算', () => {
    const waiting = fold(running(), retry());
    expect(reduceConversation(waiting, start(['tools:a', 'x'])).retry).not.toBeNull();
    expect(reduceConversation(waiting, start([], 'human')).retry).not.toBeNull();
    expect(reduceConversation(waiting, start()).retry).toBeNull();
  });

  it.each([
    ['跑完', completed],
    ['失敗', failed],
    ['按停止（退避中）', aborted],
  ])('這一輪收尾（%s）就清：不留到下一輪', (_label, close) => {
    const waiting = fold(running(), retry());
    expect(waiting.retry).not.toBeNull();
    expect(reduceConversation(waiting, close()).retry).toBeNull();
  });

  it('新的一輪開始也清（保險：上一輪的收尾 frame 掉了也不卡一行倒數）', () => {
    // 收尾 frame 掉了：狀態仍是 running，再來一顆 idle→running 之間沒有 trackTurn 看到的轉換……
    // 這裡直接模擬「閒置狀態下殘留的 retry」：折到 idle 之後再開一輪。
    const stale = { ...fold(running(), completed()), retry: { ...PAYLOAD } };
    expect(reduceConversation(stale, running()).retry).toBeNull();
  });

  it('壞酬載整顆不收，留著前一份', () => {
    const waiting = fold(running(), retry());
    for (const bad of [
      { ...PAYLOAD, retryId: '' },
      { ...PAYLOAD, retry: 'x' },
      { ...PAYLOAD, delayMs: -1 },
      { ...PAYLOAD, delayMs: Number.NaN },
      { ...PAYLOAD, code: 3 },
      { retryId: 'r9' },
    ]) {
      expect(reduceConversation(waiting, retry(bad)).retry).toBe(waiting.retry);
    }
  });

  it('不進歷史：往前翻頁的 prependEntries 不動它', () => {
    const waiting = fold(running(), retry());
    expect(prependEntries(waiting, emptyConversation()).retry).toBe(waiting.retry);
  });
});
