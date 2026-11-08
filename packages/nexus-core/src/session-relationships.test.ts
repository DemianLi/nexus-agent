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
      'request/system',
      'request/header',
      'assistant/attempt',
      'turn/end',
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

describe('請求快照與作廢嘗試的位置（格式 55，#2416）', () => {
  const system = { type: 'request/system', data: { system: '', reason: 'initial' } };
  const header = { type: 'request/header', data: { header: { config: {} }, reason: 'initial' } };
  const end = (outcome?: string, modelCall = 2) => ({
    type: 'model/end',
    data: { modelCall, ...(outcome === undefined ? {} : { outcome }) },
  });
  const turnEnd = (reason?: unknown) => ({
    type: 'turn/end',
    data: reason === undefined ? {} : { reason },
  });
  const attempt = (modelCall?: number) => ({
    type: 'assistant/attempt',
    data: { message: {}, ...(modelCall === undefined ? {} : { modelCall }) },
  });
  const rules = (events: Parameters<typeof violationsOf>[0]) =>
    violationsOf(events).map((v) => [v.seq, v.rule]);

  it('55 的形狀：快照 → model/start → … → 收工，沒有違規；同一次呼叫裡重送的快照落在 model/start 之後也收', () => {
    expect(
      rules([turnStart, system, header, modelStart, header, end(undefined, 3), turnEnd()]),
    ).toEqual([]);
  });

  it('快照之後等不到 model/start 就收工：報在快照上那一顆的 seq', () => {
    expect(rules([turnStart, system, header, turnEnd()])).toEqual([
      [3, 'request-without-model-start'],
    ]);
    expect(rules([turnStart, system, { type: 'turn/failed', data: { message: 'x' } }])).toEqual([
      [2, 'request-without-model-start'],
    ]);
  });

  it('被 interrupted 收掉的輪不檢「等不到 model/start」：行程在快照之後死掉', () => {
    expect(rules([turnStart, system, header, turnEnd({ kind: 'interrupted' })])).toEqual([]);
    // 別的收尾理由照檢。
    expect(
      rules([turnStart, system, turnEnd({ kind: 'aborted', cause: { kind: 'user' } })]),
    ).toEqual([[2, 'request-without-model-start']]);
  });

  it('輪外的快照：有輪的日誌報 request-outside-turn；從沒有輪的日誌（子代理）不報', () => {
    expect(rules([turnStart, turnEnd(), system, modelStart])).toEqual([
      [2, 'request-outside-turn'],
    ]);
    expect(rules([system, header, modelStart, end(undefined, 2)])).toEqual([]);
  });

  it('54 的形狀（帶 modelCall）：只檢它指得到 model/start，位置不管', () => {
    const legacy = (modelCall: number) => ({
      type: 'request/system',
      data: { system: '', reason: 'initial', modelCall },
    });
    expect(rules([turnStart, modelStart, legacy(1), end(undefined, 1), turnEnd()])).toEqual([]);
    expect(rules([turnStart, modelStart, legacy(7), end(undefined, 1), turnEnd()])).toEqual([
      [2, 'model-call-unknown'],
    ]);
  });

  it('帶過去的輪由下一顆 turn/start 接手：上一個行程留下的快照不算這一輪的', () => {
    expect(
      rules([
        turnStart,
        system,
        { type: 'session/end-seed', data: {} },
        turnStart,
        modelStart,
        end(undefined, 4),
        turnEnd(),
      ]),
    ).toEqual([]);
  });

  it('作廢的嘗試落在失敗收尾之後：error 與 aborted 都收；不帶 modelCall 的只檢在輪內', () => {
    expect(rules([turnStart, system, modelStart, end('error'), attempt(2), turnEnd()])).toEqual([]);
    expect(rules([turnStart, system, modelStart, end('aborted'), attempt(2), turnEnd()])).toEqual(
      [],
    );
    expect(rules([turnStart, attempt(), turnEnd()])).toEqual([]);
  });

  it('作廢的嘗試在它那次呼叫失敗收尾之前、或那次正常收尾：attempt-before-failed-end', () => {
    expect(rules([turnStart, system, modelStart, attempt(2), end('error'), turnEnd()])).toEqual([
      [3, 'attempt-before-failed-end'],
    ]);
    expect(rules([turnStart, system, modelStart, end(), attempt(2), turnEnd()])).toEqual([
      [4, 'attempt-before-failed-end'],
    ]);
  });

  it('作廢的嘗試落在輪外：attempt-outside-turn；指不到 model/start：model-call-unknown', () => {
    expect(rules([attempt()])).toEqual([[0, 'attempt-outside-turn']]);
    expect(rules([turnStart, attempt(9), turnEnd()])).toEqual([[1, 'model-call-unknown']]);
  });
});
