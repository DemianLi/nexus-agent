/**
 * **失敗的呼叫把講到一半的回覆記成 `assistant/attempt`**（native）：什麼時候記、記什麼、記不進去會怎樣。
 * 條件與形狀同 `langgraph` 下 pump 的 `#discardOpenReply`；整條路徑（真的假端點、兩個 loop 對照）在
 * `apps/harness/src/attempt-native-write.test.ts`。
 */

import { describe, expect, it, vi } from 'vitest';
import { createModelCallRecorder } from './model-calls.js';
import { beginPartialReply } from './model-call-scope.js';
import type { SessionLookup } from './registry.js';
import { SessionLog } from './session-log.js';
import { noteStreamFailure, retryModelCall } from './stream-retry.js';

function hookOf(middleware: unknown): (request: unknown, handler: unknown) => Promise<unknown> {
  return (middleware as { wrapModelCall: (r: unknown, h: unknown) => Promise<unknown> })
    .wrapModelCall;
}

const REQUEST = { runtime: { configurable: { checkpoint_ns: 'model_request:x' } } };
const ok = (log: SessionLog): SessionLookup => ({ kind: 'ok', address: { kind: 'root' }, log });
const typesOf = (log: SessionLog) => log.events.map((event) => event.type);

/** 事件序列：`message-start`、推理、正文，各自可省略。 */
function stream(
  feed: (event: unknown) => void,
  parts: { id?: string; reasoning?: string; text?: string; finish?: boolean },
) {
  feed({ event: 'message-start', ...(parts.id === undefined ? {} : { id: parts.id }) });
  if (parts.reasoning !== undefined) {
    feed({
      event: 'content-block-delta',
      delta: { type: 'reasoning-delta', reasoning: parts.reasoning },
    });
  }
  if (parts.text !== undefined) {
    feed({ event: 'content-block-delta', delta: { type: 'text-delta', text: parts.text } });
  }
  if (parts.finish === true) feed({ event: 'message-finish' });
}

/** 一次嘗試：餵事件、回報失敗碼、拋。 */
async function attemptThatFails(
  log: SessionLog,
  code: string,
  parts: Parameters<typeof stream>[1] | undefined,
  calls: { n: number },
): Promise<unknown> {
  return retryModelCall(
    { maxRetries: 1, initialDelayMs: 1 },
    { log },
    () =>
      hookOf(createModelCallRecorder({ forCall: () => ok(log) }))(REQUEST, () => {
        calls.n += 1;
        if (calls.n > 1) return Promise.resolve('ok');
        const feed = beginPartialReply();
        if (parts !== undefined) stream(feed!, parts);
        noteStreamFailure({ code, status: 503 } as never);
        return Promise.reject(new Error('上游出事了'));
      }) as Promise<unknown>,
  );
}

const attemptData = (log: SessionLog) =>
  log.events.find((event) => event.type === 'assistant/attempt')?.data as
    { message: { data: { id?: string; content: unknown } }; modelCall?: number } | undefined;

describe('寫的條件', () => {
  it('會整次重打的失敗：attempt 在 model/start 之後、model/end(error) 之前，指著這次呼叫', async () => {
    const log = new SessionLog('a');
    await attemptThatFails(log, 'SERVER', { id: 'chatcmpl-1', text: '甲乙' }, { n: 0 });
    expect(typesOf(log).slice(0, 4)).toEqual([
      'model/start',
      'assistant/attempt',
      'model/end',
      'llm/retry',
    ]);
    expect(attemptData(log)).toMatchObject({
      modelCall: 0,
      message: { data: { id: 'chatcmpl-1', content: '甲乙' } },
    });
  });

  it('message-start 來過、正文是空字串也記（同 pump）；沒有 id 就不帶 id', async () => {
    const log = new SessionLog('a');
    await attemptThatFails(log, 'SERVER', {}, { n: 0 });
    const data = attemptData(log)!;
    expect(data.message.data.content).toBe('');
    // 供應商沒給 id：native 省略（`langgraph` 下 pump 讀到的是 protocol 補的 `run-<runId>`）。
    expect(Object.keys(data.message.data)).not.toContain('id');
  });

  it('推理去空白後非空：content 是 [推理區塊, 正文區塊?]；正文空就沒有正文區塊', async () => {
    const log = new SessionLog('a');
    await attemptThatFails(log, 'SERVER', { reasoning: '想一想' }, { n: 0 });
    expect(attemptData(log)!.message.data.content).toEqual([
      { type: 'reasoning', reasoning: '想一想' },
    ]);
    const both = new SessionLog('b');
    await attemptThatFails(both, 'SERVER', { reasoning: '想', text: '說' }, { n: 0 });
    expect(attemptData(both)!.message.data.content).toEqual([
      { type: 'reasoning', reasoning: '想' },
      { type: 'text', text: '說' },
    ]);
  });

  it.each([
    ['已經 message-finish', 'SERVER', { text: '完', finish: true }],
    ['沒有 message-start（殼沒餵）', 'SERVER', undefined],
    ['不重打的失敗碼', 'AUTH', { text: '半' }],
  ] as const)('%s：不記', async (_label, code, parts) => {
    const log = new SessionLog('a');
    await attemptThatFails(log, code, parts, { n: 0 }).catch(() => undefined);
    expect(typesOf(log)).not.toContain('assistant/attempt');
  });

  it('不在重試範圍裡（摘要器、沒開重試）：不記', async () => {
    const log = new SessionLog('a');
    await hookOf(createModelCallRecorder({ forCall: () => ok(log) }))(REQUEST, () => {
      stream(beginPartialReply()!, { text: '半' });
      return Promise.reject(new Error('x'));
    }).catch(() => undefined);
    expect(typesOf(log)).toEqual(['model/start', 'model/end']);
  });
});

describe('寫進呼叫所屬的那一份日誌', () => {
  it('子代理的呼叫：attempt 寫進子代理自己的日誌，root 的日誌不動', async () => {
    const root = new SessionLog('root');
    const child = new SessionLog('child');
    const lookup: SessionLookup = {
      kind: 'ok',
      address: { kind: 'subagent', runId: 'bg-aaaaaaaaaaaa' },
      log: child,
    };
    const calls = { n: 0 };
    await retryModelCall(
      { maxRetries: 1, initialDelayMs: 1 },
      { log: child },
      () =>
        hookOf(createModelCallRecorder({ forCall: () => lookup }))(REQUEST, () => {
          calls.n += 1;
          if (calls.n > 1) return Promise.resolve('ok');
          stream(beginPartialReply()!, { id: 'chatcmpl-9', text: '半' });
          noteStreamFailure({ code: 'SERVER' } as never);
          return Promise.reject(new Error('上游出事了'));
        }) as Promise<unknown>,
    );
    expect(typesOf(child).slice(0, 3)).toEqual(['model/start', 'assistant/attempt', 'model/end']);
    expect(attemptData(child)).toMatchObject({ modelCall: 0 });
    expect(root.events).toEqual([]);
  });
});

describe('記不進去', () => {
  it('AggregateError 原錯在前也是 cause；model/end(error) 照寫；不再重打', async () => {
    const log = new SessionLog('a');
    const boom = new Error('磁碟滿了');
    const real = log.append.bind(log);
    vi.spyOn(log, 'append').mockImplementation(((type: never, data: never, opts: never) => {
      if ((type as string) === 'assistant/attempt') throw boom;
      return real(type, data, opts);
    }) as typeof log.append);
    const calls = { n: 0 };
    const error = (await attemptThatFails(log, 'SERVER', { text: '甲' }, calls).catch(
      (e: unknown) => e,
    )) as AggregateError;
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual([expect.objectContaining({ message: '上游出事了' }), boom]);
    expect(error.cause).toBe(error.errors[0]);
    expect(calls.n).toBe(1);
    expect(typesOf(log)).toEqual(['model/start', 'model/end']);
    expect(log.events[1]!.data).toMatchObject({ outcome: 'error' });
  });
});
