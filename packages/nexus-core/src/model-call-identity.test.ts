/**
 * 寫方：一次模型呼叫的識別怎麼傳到每個寫入點（[#1021](https://github.com/DemianLi/nexus-agent/issues/1021)）。
 * 用真的起訖紀錄器、用量紀錄器與重試範圍串成一條洋蔥，不是各自單獨叫。
 */

import { AIMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { noteFailedAttempt, noteRequestStart } from './llm-retry.js';
import { captureModelCall, currentModelCall, lastModelCall } from './model-call-scope.js';
import { createModelCallRecorder } from './model-calls.js';
import { createModelUsageRecorder } from './model-usage.js';
import { indexModelCalls } from './model-call-index.js';
import type { SessionLookup } from './registry.js';
import { SessionLog } from './session-log.js';

type Hook = (request: unknown, handler: (r: unknown) => unknown) => Promise<unknown>;
const hookOf = (middleware: unknown): Hook => (middleware as { wrapModelCall: Hook }).wrapModelCall;

const ok = (log: SessionLog): SessionLookup => ({ kind: 'ok', address: { kind: 'root' }, log });
const REQUEST = { runtime: { configurable: {} } };

/** 起訖（外）→ 用量（內）→ handler，同 `fold.ts` 槽位表裡那兩顆的相對位置。 */
function onion(log: SessionLog, handler: () => unknown): Promise<unknown> {
  const sessions = { forCall: () => ok(log) };
  const calls = hookOf(createModelCallRecorder(sessions));
  const usage = hookOf(createModelUsageRecorder(sessions));
  return calls(REQUEST, (request) => usage(request, handler));
}

const withUsage = () =>
  new AIMessage({
    content: '好。',
    usage_metadata: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
  });

describe('起訖、用量、重試、回覆都帶同一個識別', () => {
  it('識別是 model/start 的 seq，每一顆都指回去', async () => {
    const log = new SessionLog('id');
    log.append('turn/start', { kind: 'message', text: 'x' }); // 讓 seq 不從 0 起
    await onion(log, () => {
      noteFailedAttempt({ message: '壞了', code: 'SERVER', status: 500 }, 3);
      noteRequestStart();
      return withUsage();
    });
    const start = log.events.find((event) => event.type === 'model/start')!;
    expect(start.seq).toBe(1);
    const tagged = log.events.filter(
      (event) => event.type !== 'model/start' && event.type !== 'turn/start',
    );
    expect(tagged.map((event) => event.type)).toEqual([
      'llm/retry',
      'llm/retry-started',
      'model/usage',
      'assistant/message',
      'model/end',
    ]);
    for (const event of tagged) {
      expect((event.data as { modelCall?: number }).modelCall, event.type).toBe(start.seq);
    }
    const { calls, unattributed } = indexModelCalls(log.events);
    expect(unattributed).toEqual([]);
    expect(calls[0]).toMatchObject({ modelCall: 1 });
    expect(calls[0]!.retries).toHaveLength(1);
    expect(calls[0]!.usage).toHaveLength(1);
    expect(calls[0]!.end).toBeDefined();
  });

  it('兩次呼叫各有各的識別：第二次的重試不會算進第一次', async () => {
    const log = new SessionLog('two');
    await onion(log, () => withUsage());
    await onion(log, () => {
      noteFailedAttempt({ message: '壞了', code: 'SERVER', status: 500 }, 3);
      return withUsage();
    });
    const { calls } = indexModelCalls(log.events);
    expect(calls.map((each) => each.modelCall)).toHaveLength(2);
    expect(calls[0]!.retries).toHaveLength(0);
    expect(calls[1]!.retries).toHaveLength(1);
  });

  it('模型拋了：model/end 照樣帶識別', async () => {
    const log = new SessionLog('throw');
    await expect(
      onion(log, () => {
        throw new Error('炸了');
      }),
    ).rejects.toThrow('炸了');
    const end = log.events.find((event) => event.type === 'model/end')!;
    // 拋錯收的呼叫還帶沒有正常回來的方式（#1022）。
    expect(end.data).toEqual({ modelCall: 0, outcome: 'error' });
  });
});

describe('識別只在同一份日誌上給', () => {
  it('在範圍裡、問的是別份日誌：沒有識別，不會附錯', async () => {
    const mine = new SessionLog('mine');
    const other = new SessionLog('other');
    let seen: { mine: number | undefined; other: number | undefined } | undefined;
    await onion(mine, () => {
      seen = { mine: currentModelCall(mine), other: currentModelCall(other) };
      return withUsage();
    });
    expect(seen).toEqual({ mine: 0, other: undefined });
  });

  it('範圍外一律沒有', () => {
    const log = new SessionLog('out');
    expect(currentModelCall(log)).toBeUndefined();
    expect(lastModelCall(log)).toBeUndefined();
  });

  it('lastModelCall：最近開的那次沒有正常回覆（拋了）就是它，呼叫結束之後還在', async () => {
    const log = new SessionLog('last');
    await onion(log, () => withUsage());
    await expect(
      onion(log, () => {
        throw new Error('被切斷');
      }),
    ).rejects.toThrow();
    const starts = log.events.filter((event) => event.type === 'model/start');
    expect(lastModelCall(log)).toBe(starts[1]!.seq);
  });

  it('lastModelCall：最近那次已經記過正常回覆就不給——半段回覆寧可沒有識別，也不掛到完整回覆過的呼叫底下', async () => {
    const log = new SessionLog('replied');
    await onion(log, () => withUsage());
    expect(lastModelCall(log)).toBeUndefined();
  });
});

describe('captureModelCall：外層拿回裡面那次的識別', () => {
  it('拿得到寫進該份日誌的那次；別份日誌問不到', async () => {
    const log = new SessionLog('cap');
    const other = new SessionLog('cap-other');
    const { call } = await captureModelCall(() => onion(log, () => withUsage()));
    expect(call.of(log)).toBe(0);
    expect(call.of(other)).toBeUndefined();
  });

  it('夾住的呼叫叫了兩次內層（脈絡溢出）：回報最後一次', async () => {
    const log = new SessionLog('cap2');
    const { call } = await captureModelCall(async () => {
      await onion(log, () => withUsage());
      return onion(log, () => withUsage());
    });
    const starts = log.events.filter((event) => event.type === 'model/start');
    expect(call.of(log)).toBe(starts[1]!.seq);
  });

  it('兩個夾住的呼叫各拿各的，不互相覆蓋', async () => {
    const log = new SessionLog('cap3');
    const [a, b] = await Promise.all([
      captureModelCall(() => onion(log, () => withUsage())),
      captureModelCall(() => onion(log, () => withUsage())),
    ]);
    expect(new Set([a.call.of(log), b.call.of(log)]).size).toBe(2);
  });

  it('裡面拋就照拋', async () => {
    await expect(
      captureModelCall(() => {
        throw new Error('裡面拋');
      }),
    ).rejects.toThrow('裡面拋');
  });
});
