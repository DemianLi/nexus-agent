/**
 * **native 下 `assistant/attempt` 由模型呼叫的起訖紀錄器寫，落在那次呼叫的起訖之內**（#2361）。
 *
 * 每條測試走完整條路徑：假的 SSE 端點 → `createLiveModel` → native loop → 起訖紀錄器 → `ThreadPump`。`langgraph` 下 pump 寫在失敗收尾
 * 之後，見 `attempt-langgraph-retry.test.ts`。
 *
 * **寫入端的突變紅燈**：檢查器兩種位置都收，分不出 native 寫在失敗收尾之後，所以位置由這裡釘（第一條）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MESSAGE_DISCARD } from '@nexus/wire';
import type { SessionEvent } from '@nexus/core';
import { LIVE_API_KEY_ENV } from './live-model.js';
import { runRetryTurn } from './attempt-retry-turn.fixture.js';
import type { RetryAct } from './attempt-retry-turn.fixture.js';

/** 這一輪日誌上跟重試有關的事件，依序標成 `type` 或 `model/end:<outcome>`。 */
function shape(events: readonly SessionEvent[]): string[] {
  const keep = new Set([
    'model/start',
    'assistant/attempt',
    'model/end',
    'model/usage',
    'llm/retry',
    'llm/retry-started',
    'assistant/message',
    'turn/failed',
  ]);
  return events
    .filter((event) => keep.has(event.type))
    .map((event) =>
      event.type === 'model/end'
        ? `model/end:${String((event.data as { outcome?: string }).outcome)}`
        : event.type,
    );
}

const attemptsOf = (events: readonly SessionEvent[]): SessionEvent[] =>
  events.filter((event) => event.type === 'assistant/attempt');

describe('native 下作廢的半段記在那次呼叫的起訖之內', () => {
  const original = process.env[LIVE_API_KEY_ENV];
  beforeEach(() => {
    process.env[LIVE_API_KEY_ENV] = 'nvapi-test-value-not-a-real-key';
  });
  afterEach(() => {
    if (original === undefined) delete process.env[LIVE_API_KEY_ENV];
    else process.env[LIVE_API_KEY_ENV] = original;
  });

  const acts: readonly RetryAct[] = ['mid503', 'cut', 'stall'];

  it.each(acts)(
    '%s：attempt 在它指的 model/start 之後、同一次呼叫的 model/end(error) 之前，整段順序寫死',
    async (act) => {
      const run = await runRetryTurn([act], { loop: 'native' });
      expect(run.thrown).toBeUndefined();
      expect(run.hits).toBe(2);
      expect(shape(run.events)).toEqual([
        'model/start',
        'assistant/attempt',
        'model/end:error',
        'llm/retry',
        'llm/retry-started',
        'model/start',
        'assistant/message',
        'model/end:undefined',
      ]);
      const attempt = attemptsOf(run.events)[0]!;
      const modelCall = (attempt.data as { modelCall?: number }).modelCall!;
      const failedEnd = run.events.find(
        (e) => e.type === 'model/end' && (e.data as { modelCall?: number }).modelCall === modelCall,
      )!;
      expect(attempt.seq).toBeGreaterThan(modelCall);
      expect(attempt.seq).toBeLessThan(failedEnd.seq);
      expect(attempt.ignorable).toBeUndefined();
    },
    30_000,
  );

  it('每次失敗的呼叫恰好一顆：pump 在 native 下不寫；線上照樣送 message-discard', async () => {
    const run = await runRetryTurn(['mid503', 'cut'], { loop: 'native' });
    expect(run.hits).toBe(3);
    const attempts = attemptsOf(run.events);
    expect(attempts).toHaveLength(2);
    const starts = run.events.filter((e) => e.type === 'model/start').map((e) => e.seq);
    expect(attempts.map((a) => (a.data as { modelCall: number }).modelCall)).toEqual(
      starts.slice(0, 2),
    );
    const discards = run.frames.filter(
      (frame) =>
        frame.method === 'custom' &&
        (frame.params.data as { name?: string } | null)?.name === MESSAGE_DISCARD,
    );
    expect(discards).toHaveLength(2);
  }, 30_000);

  it.each(acts)(
    '%s：內容與 langgraph 下 pump 對同一份串流寫的逐格相同',
    async (act) => {
      const native = await runRetryTurn([act], { loop: 'native' });
      const langgraph = await runRetryTurn([act], { loop: 'langgraph' });
      const a = attemptsOf(native.events)[0]!.data as { message: unknown };
      const b = attemptsOf(langgraph.events)[0]!.data as { message: unknown };
      expect(a.message).toEqual(b.message);
      expect(JSON.stringify(a.message)).toContain('甲乙');
    },
    30_000,
  );

  it('寫不進去：這次呼叫以 AggregateError 失敗（原錯在前），不再重打，model/end(error) 照寫，這一輪 turn/failed', async () => {
    const run = await runRetryTurn(['mid503'], {
      loop: 'native',
      reject: { types: ['assistant/attempt'], error: new Error('磁碟滿了') },
    });
    expect(run.hits).toBe(1);
    // 圖的錯誤包裝不留 `errors`；落盤的 `turn/failed` 訊息兩個錯都在，順序是原錯在前。結構由 core 的 `model-calls-attempt.test.ts` 釘。
    expect(String(run.thrown)).toMatch(
      /^AggregateError: 模型呼叫失敗，assistant\/attempt 也記不進去/,
    );
    const failed = run.events.find((e) => e.type === 'turn/failed')!;
    expect(JSON.stringify(failed.data)).toMatch(/\[上游出事了; 磁碟滿了\]/);
    expect(shape(run.events)).toEqual(['model/start', 'model/end:error', 'turn/failed']);
    expect(run.events.map((e) => e.type)).not.toContain('llm/retry');
  }, 30_000);

  it('不重打的失敗（預算 0）不寫 attempt：被切斷的半段不是作廢的嘗試', async () => {
    const run = await runRetryTurn(['mid503'], {
      loop: 'native',
      streamRetry: { maxRetries: 0, initialDelayMs: 20 },
    });
    expect(run.hits).toBe(1);
    expect(attemptsOf(run.events)).toHaveLength(0);
    expect(shape(run.events)).not.toContain('assistant/attempt');
  }, 30_000);

  it('前景子代理（task）中段失敗、重打成功：attempt 寫在子代理自己的日誌，位置同 root；root 的日誌沒有', async () => {
    const run = await runRetryTurn(['task', 'mid503', 'ok', 'ok'], { loop: 'native' });
    expect(run.thrown).toBeUndefined();
    expect(run.hits).toBe(4);
    expect(attemptsOf(run.events)).toHaveLength(0);
    expect(run.children).toHaveLength(1);
    const child = run.children[0]!;
    expect(shape(child)).toEqual([
      'model/start',
      'assistant/attempt',
      'model/end:error',
      'llm/retry',
      'llm/retry-started',
      'model/start',
      'assistant/message',
      'model/end:undefined',
    ]);
    const attempt = attemptsOf(child)[0]!;
    expect((attempt.data as { modelCall: number }).modelCall).toBe(
      child.find((e) => e.type === 'model/start')!.seq,
    );
    expect(JSON.stringify(attempt.data)).toContain('甲乙');
  }, 30_000);
});
