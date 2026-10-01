/**
 * 重試範圍的規則（[#712](https://github.com/DemianLi/nexus-agent/issues/712)）：什麼時候寫、什麼時候不寫。
 * 真的打假端點、數請求的那一半在 `apps/harness/src/live-model-retry-events.test.ts`。
 */

import { AIMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { noteFailedAttempt, noteRequestStart, runInRetryScope } from './llm-retry.js';
import { createModelCallRecorder } from './model-calls.js';
import type { SessionLookup } from './registry.js';
import { SessionLog } from './session-log.js';
import type { LlmFailure } from './session-log.js';

const FAILURE: LlmFailure = { message: '壞了', code: 'SERVER', status: 500 };
const typesOf = (log: SessionLog) => log.events.map((event) => event.type);

describe('範圍外', () => {
  it('回報一律是空操作，不拋', () => {
    expect(() => noteFailedAttempt(FAILURE, 3)).not.toThrow();
    expect(() => noteRequestStart()).not.toThrow();
  });
});

describe('範圍內', () => {
  it('第 k 次失敗只有 k <= maxRetries 才寫：預算用盡的那一次不排，所以不寫', async () => {
    const log = new SessionLog('retry');
    await runInRetryScope(log, async () => {
      noteRequestStart();
      noteFailedAttempt(FAILURE, 2);
      noteRequestStart();
      noteFailedAttempt(FAILURE, 2);
      noteRequestStart();
      // 第三次失敗：`AsyncCaller` 連最後一次也會叫 `onFailedAttempt`，這裡不寫。
      noteFailedAttempt(FAILURE, 2);
    });
    expect(typesOf(log)).toEqual([
      'llm/retry',
      'llm/retry-started',
      'llm/retry',
      'llm/retry-started',
    ]);
    const [first, started, second] = log.events as unknown as {
      data: { retryId: string; retry: number; maxRetries?: number; waitedMs?: number };
    }[];
    expect(first!.data).toMatchObject({ retry: 1, maxRetries: 2, failure: FAILURE });
    expect(started!.data.retry).toBe(1);
    expect(started!.data.waitedMs).toBeGreaterThanOrEqual(0);
    expect(second!.data.retry).toBe(2);
    // 一次呼叫的重試共用一個 retryId。
    expect(second!.data.retryId).toBe(first!.data.retryId);
    expect(started!.data.retryId).toBe(first!.data.retryId);
  });

  it('第一次請求開跑不寫 retry-started', async () => {
    const log = new SessionLog('retry');
    await runInRetryScope(log, async () => {
      noteRequestStart();
    });
    expect(typesOf(log)).toEqual([]);
  });

  it('範圍關了之後的回報什麼都不寫：取消之後背景迴圈再打一次，不會多出事件', async () => {
    const log = new SessionLog('retry');
    let woke: Promise<void> | undefined;
    await runInRetryScope(log, async () => {
      noteRequestStart();
      noteFailedAttempt(FAILURE, 2);
      // 呼叫方先拿到中止；背景的重試迴圈稍後才醒來——它還在這個範圍的 async context 裡，
      // 所以要靠「範圍已關」擋，而不是靠「找不到範圍」。
      woke = new Promise<void>((done) =>
        setTimeout(() => {
          noteRequestStart();
          noteFailedAttempt(FAILURE, 2);
          done();
        }, 5),
      );
    });
    await woke;
    expect(typesOf(log)).toEqual(['llm/retry']);
  });

  it('兩次呼叫並行：各記各的日誌，計數與 retryId 不混', async () => {
    const a = new SessionLog('a');
    const b = new SessionLog('b');
    const step = () => new Promise<void>((done) => setTimeout(done, 5));
    const call = (log: SessionLog, failures: number) =>
      runInRetryScope(log, async () => {
        for (let index = 0; index < failures; index += 1) {
          noteRequestStart();
          await step();
          noteFailedAttempt(FAILURE, 5);
        }
      });
    await Promise.all([call(a, 2), call(b, 1)]);
    expect(typesOf(a)).toEqual(['llm/retry', 'llm/retry-started', 'llm/retry']);
    expect(typesOf(b)).toEqual(['llm/retry']);
    const idOf = (log: SessionLog) => (log.events[0]!.data as { retryId: string }).retryId;
    expect(idOf(a)).not.toBe(idOf(b));
  });

  it('append 拋錯吞掉，不扳倒呼叫', async () => {
    const log = new SessionLog('retry');
    log.subscribe(() => {
      throw new Error('訂閱者壞了');
    });
    await expect(
      runInRetryScope(log, async () => {
        noteRequestStart();
        noteFailedAttempt(FAILURE, 1);
        return 'done';
      }),
    ).resolves.toBe('done');
  });
});

describe('接在 wrapModelCall 上', () => {
  it('重試事件落在 model/start 與 model/end 之間，回應原樣傳回', async () => {
    const log = new SessionLog('retry');
    const lookup: SessionLookup = { kind: 'ok', address: { kind: 'root' }, log };
    const hook = (
      createModelCallRecorder({ forCall: () => lookup }) as unknown as {
        wrapModelCall: (request: unknown, handler: unknown) => Promise<unknown>;
      }
    ).wrapModelCall;
    const response = new AIMessage('好。');
    const returned = await hook({ runtime: { configurable: {} } }, async () => {
      noteRequestStart();
      noteFailedAttempt(FAILURE, 1);
      noteRequestStart();
      return response;
    });
    expect(returned).toBe(response);
    expect(typesOf(log)).toEqual([
      'model/start',
      'llm/retry',
      'llm/retry-started',
      'assistant/message',
      'model/end',
    ]);
  });
});
