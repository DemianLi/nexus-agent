/**
 * 會話日誌事件之間的關係檢查（[#1597](https://github.com/DemianLi/nexus-agent/issues/1597)）。
 *
 * turn、模型呼叫、工具、送出佇列的規則與訊息由執行期那一側的 `invariant.test.ts` 釘；這裡釘的是這支檢查自己的契約：
 * 違規以回傳值交出、不拋，形狀不對的 `data` 不漏出 `TypeError`，與重試的兩條規則。
 */

import { describe, expect, it } from 'vitest';

import type { SessionEvent } from './session-log.js';
import { createSessionRelationshipChecker } from './session-relationships.js';
import type { SessionRelationshipViolation } from './session-relationships.js';

/** 依序餵進一份新的檢查狀態，攤平交出所有違規。`seq` 取它的位置。 */
function violationsOf(
  events: readonly { readonly type: string; readonly data: unknown }[],
): SessionRelationshipViolation[] {
  const checker = createSessionRelationshipChecker();
  return events.flatMap((event, seq) =>
    checker.accept({ ...event, seq, time: 1 } as unknown as SessionEvent),
  );
}

const turnStart = { type: 'turn/start', data: { kind: 'message', text: '嗨' } };
const modelStart = { type: 'model/start', data: {} };
const retry = (retryId: string, n: number) => ({
  type: 'llm/retry',
  data: { retryId, retry: n, maxRetries: 3, failure: { message: 'x', code: 'RATE_LIMIT' } },
});
const started = (retryId: string, n: number) => ({
  type: 'llm/retry-started',
  data: { retryId, retry: n, waitedMs: 1 },
});

describe('重試的配對（#1597）', () => {
  it('同一個 retryId 從 1 連號，每一次排定的各開跑一次：沒有違規', () => {
    expect(
      violationsOf([
        turnStart,
        modelStart,
        retry('r', 1),
        started('r', 1),
        retry('r', 2),
        started('r', 2),
        retry('s', 1),
      ]),
    ).toEqual([]);
  });

  it('跳號、不從 1 起、開跑沒排定過的、同一對開跑兩次：各報一筆，帶 seq 與規則', () => {
    expect(
      violationsOf([turnStart, modelStart, retry('r', 1), retry('r', 3)]).map((v) => [
        v.seq,
        v.rule,
      ]),
    ).toEqual([[3, 'retry-chain']]);
    expect(violationsOf([retry('r', 2)]).map((v) => v.rule)).toEqual(['retry-chain']);
    expect(violationsOf([started('r', 1)]).map((v) => v.rule)).toEqual([
      'retry-started-unscheduled',
    ]);
    expect(
      violationsOf([retry('r', 1), started('r', 1), started('r', 1)]).map((v) => [v.seq, v.rule]),
    ).toEqual([[2, 'retry-started-unscheduled']]);
  });

  it('等待中被取消、沒有 retry-started 的那一次不是違規', () => {
    expect(
      violationsOf([turnStart, modelStart, retry('r', 1), { type: 'turn/end', data: {} }]),
    ).toEqual([]);
  });
});

describe('形狀不對的 data 不拋（讀盤只驗過信封）', () => {
  it.each([null, 3, [], {}])('data 是 %j：每一種事件都回違規或空陣列，不拋 TypeError', (data) => {
    for (const type of [
      'tool/call',
      'tool/result',
      'model/end',
      'model/usage',
      'llm/retry',
      'llm/retry-started',
      'inbox/spliced',
      'turn/start',
    ]) {
      expect(() => violationsOf([{ type, data }])).not.toThrow();
    }
  });

  it('callId 不是字串的 tool/result 配不到，報 tool-result-without-call', () => {
    expect(
      violationsOf([
        { type: 'tool/call', data: { callId: 3 } },
        { type: 'tool/result', data: { callId: 3, isError: false } },
      ]).map((v) => v.rule),
    ).toEqual(['tool-result-without-call']);
  });

  it('modelCall 不是數字報 model-call-unknown', () => {
    expect(
      violationsOf([modelStart, { type: 'model/usage', data: { modelCall: '0' } }]).map(
        (v) => v.rule,
      ),
    ).toEqual(['model-call-unknown']);
  });
});
