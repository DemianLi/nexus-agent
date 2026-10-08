/**
 * 續接時補寫當掉那一輪的收尾（[#721](https://github.com/DemianLi/nexus-agent/issues/721)）：算補結的規則、
 * 寫回的把手、冪等，以及補寫之後模型那一側與不變量都不變。接到 CLI／serve 的整合在 `apps/harness`。
 */

import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';

import {
  replayConversation,
  TOOL_NOT_STARTED_TEXT,
  TOOL_OUTCOME_UNKNOWN_TEXT,
} from './conversation-replay.js';
import { interruptedTurnClosers, resumeClosingInterruptedTurn } from './interrupted-turn.js';
import { createInvariantRunner } from './invariants.js';
import type { InvariantError } from './invariants.js';
import { sessionInvariant, CORE_INVARIANT_PACKAGE } from './invariant.js';
import { toLoggedMessage } from './logged-message.js';
import { SessionLog } from './session-log.js';
import type { SessionEvent } from './session-log.js';
import type { ResumedStoredSession, SessionStore, StoredSession } from './session-store.js';
import { TOOL_NOT_STARTED, TOOL_OUTCOME_UNKNOWN } from './tool-events.js';

const asking = (calls: readonly (readonly [string, string])[]) =>
  toLoggedMessage(
    new AIMessage({
      content: '我來',
      tool_calls: calls.map(([id, name]) => ({ id, name, args: {}, type: 'tool_call' as const })),
    }),
  );

/** 一輪開著：人說話、模型要兩個工具、第一個記了 `tool/call` 並落定、第二個記了 `tool/call` 沒結果。 */
function crashed(): SessionLog {
  const log = new SessionLog('crash');
  log.append('turn/start', { kind: 'message', text: '做事' });
  log.append('assistant/message', {
    message: asking([
      ['a', 'ls'],
      ['b', 'write_file'],
    ]),
  });
  log.append('tool/call', { callId: 'a', name: 'ls', arguments: '{}' });
  log.append('tool/result', {
    callId: 'a',
    isError: false,
    message: toLoggedMessage(new ToolMessage({ content: 'x', tool_call_id: 'a', name: 'ls' })),
  });
  log.append('tool/call', { callId: 'b', name: 'write_file', arguments: '{}' });
  return log;
}

const typesOf = (events: readonly SessionEvent[]) => events.map((event) => event.type);

describe('interruptedTurnClosers', () => {
  it('開著的輪：記過 tool/call 沒結果的補「結果不明」，最後 turn/end interrupted；seq 接續、time 沿用最後一顆', () => {
    const log = crashed();
    const last = log.events.at(-1)!;
    const closers = interruptedTurnClosers(log.events);

    expect(typesOf(closers)).toEqual(['tool/result', 'turn/end']);
    expect(closers.map((event) => event.seq)).toEqual([last.seq + 1, last.seq + 2]);
    expect(closers.every((event) => event.time === last.time)).toBe(true);
    const [result, end] = closers as [SessionEvent<'tool/result'>, SessionEvent<'turn/end'>];
    expect(result.data).toMatchObject({
      callId: 'b',
      isError: true,
      error: { name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN },
    });
    expect(result.data.message?.data.content).toBe(TOOL_OUTCOME_UNKNOWN_TEXT);
    expect(end.data).toEqual({ reason: { kind: 'interrupted' } });
  });

  it('沒有未配到的呼叫：只補 turn/end', () => {
    const log = new SessionLog('crash');
    log.append('turn/start', { kind: 'message', text: '講話' });
    expect(typesOf(interruptedTurnClosers(log.events))).toEqual(['turn/end']);
  });

  it('只在回覆裡要了、沒記過 tool/call 的呼叫補「還沒開始」（與記過的那句不同）', () => {
    const log = new SessionLog('crash');
    log.append('turn/start', { kind: 'message', text: '做事' });
    log.append('assistant/message', { message: asking([['a', 'ls']]) });
    const closers = interruptedTurnClosers(log.events);
    expect(typesOf(closers)).toEqual(['tool/result', 'turn/end']);
    const result = closers[0] as SessionEvent<'tool/result'>;
    expect(result.data).toMatchObject({
      callId: 'a',
      isError: true,
      error: { name: 'ToolNotStartedError', code: TOOL_NOT_STARTED },
    });
    expect(result.data.message?.data.content).toBe(TOOL_NOT_STARTED_TEXT);
  });

  it('同一批裡記過的與沒記過的各補各的，照回覆要的順序', () => {
    const log = new SessionLog('crash');
    log.append('turn/start', { kind: 'message', text: '做事' });
    log.append('assistant/message', {
      message: asking([
        ['a', 'ls'],
        ['b', 'write_file'],
      ]),
    });
    log.append('tool/call', { callId: 'b', name: 'write_file', arguments: '{}' });
    const results = interruptedTurnClosers(log.events).filter(
      (event): event is SessionEvent<'tool/result'> => event.type === 'tool/result',
    );
    expect(results.map((event) => [event.data.callId, event.data.error?.code])).toEqual([
      ['a', TOOL_NOT_STARTED],
      ['b', TOOL_OUTCOME_UNKNOWN],
    ]);
  });

  it('開著的 model/start 補 model/end {modelCall, outcome:error}，順序是結果、model/end、turn/end', () => {
    const log = new SessionLog('crash');
    log.append('turn/start', { kind: 'message', text: '做事' });
    const first = log.append('model/start', {});
    log.append('model/end', { modelCall: first.seq });
    const second = log.append('model/start', {});
    log.append('assistant/message', { message: asking([['a', 'ls']]), modelCall: second.seq });
    log.append('tool/call', { callId: 'a', name: 'ls', arguments: '{}' });
    const closers = interruptedTurnClosers(log.events);
    expect(typesOf(closers)).toEqual(['tool/result', 'model/end', 'turn/end']);
    expect((closers[1] as SessionEvent<'model/end'>).data).toEqual({
      modelCall: second.seq,
      outcome: 'error',
    });
  });

  it('後面又開了新一次模型呼叫：前一批沒配到的呼叫當作已結清（基座在記憶體補過、模型已往下走），不補', () => {
    const log = new SessionLog('crash');
    log.append('turn/start', { kind: 'message', text: '做事' });
    const first = log.append('model/start', {});
    log.append('assistant/message', { message: asking([['a', 'ls']]), modelCall: first.seq });
    log.append('model/end', { modelCall: first.seq });
    const second = log.append('model/start', {});
    expect(interruptedTurnClosers(log.events)).toEqual([
      expect.objectContaining({
        type: 'model/end',
        data: { modelCall: second.seq, outcome: 'error' },
      }),
      expect.objectContaining({ type: 'turn/end' }),
    ]);
  });

  it('model/start 都已有結尾：不補 model/end', () => {
    const log = new SessionLog('crash');
    log.append('turn/start', { kind: 'message', text: '做事' });
    const start = log.append('model/start', {});
    log.append('model/end', { modelCall: start.seq });
    expect(typesOf(interruptedTurnClosers(log.events))).toEqual(['turn/end']);
  });

  it('已平衡（輪收了，哪怕結果沒配到）、空日誌：空陣列', () => {
    const log = crashed();
    log.append('turn/end', {});
    expect(interruptedTurnClosers(log.events)).toEqual([]);
    expect(interruptedTurnClosers([])).toEqual([]);
  });

  it('turn/failed 也是收工', () => {
    const log = crashed();
    log.append('turn/failed', { message: '壞了' });
    expect(interruptedTurnClosers(log.events)).toEqual([]);
  });

  it('開著的輪＋end-seed＋新一輪：不補（舊檔的形狀）', () => {
    const first = crashed();
    const log = new SessionLog('crash', { seed: first.events });
    log.append('turn/start', { kind: 'message', text: '再來' });
    log.append('turn/end', {});
    expect(interruptedTurnClosers(log.events)).toEqual([]);
  });

  it('舊檔尾巴「開著的輪＋end-seed、之後沒有新輪」：掃描不在 end-seed 重設，補結接在 end-seed 後面（照 dsh）', () => {
    const log = new SessionLog('crash', { seed: crashed().events });
    const last = log.events.at(-1)!;
    expect(last.type).toBe('session/end-seed');
    const closers = interruptedTurnClosers(log.events);
    expect(typesOf(closers)).toEqual(['tool/result', 'turn/end']);
    expect(closers[0]!.seq).toBe(last.seq + 1);
    expect((closers[0] as SessionEvent<'tool/result'>).data.callId).toBe('b');
  });

  it('舊檔「開著的輪＋end-seed」補過之後再掃：已平衡', () => {
    const log = new SessionLog('crash', { seed: crashed().events });
    const once = [...log.events, ...interruptedTurnClosers(log.events)];
    expect(interruptedTurnClosers(once)).toEqual([]);
  });

  it('end-seed 之前的另一輪已收、之後新輪開著：只補新輪的呼叫', () => {
    const log = new SessionLog('crash', { seed: crashed().events });
    log.append('turn/start', { kind: 'message', text: '再來' });
    log.append('assistant/message', { message: asking([['z', 'ls']]) });
    const results = interruptedTurnClosers(log.events).filter(
      (event) => event.type === 'tool/result',
    );
    expect(results.map((event) => (event as SessionEvent<'tool/result'>).data.callId)).toEqual([
      'z',
    ]);
  });
});

/** 一輪開著且各種殘局都有：已落定的、記過沒結果的、只在回覆裡要了的、沒收尾的模型呼叫。 */
function crashedMixed(): SessionLog {
  const log = new SessionLog('crash');
  log.append('turn/start', { kind: 'message', text: '做事' });
  const start = log.append('model/start', {});
  log.append('assistant/message', {
    message: asking([
      ['a', 'ls'],
      ['b', 'write_file'],
      ['c', 'cat'],
    ]),
    modelCall: start.seq,
  });
  // 刻意沒有 model/end：模型呼叫的結尾沒來得及寫，補結要補它。
  log.append('tool/call', { callId: 'a', name: 'ls', arguments: '{}' });
  log.append('tool/result', {
    callId: 'a',
    isError: false,
    message: toLoggedMessage(new ToolMessage({ content: 'x', tool_call_id: 'a', name: 'ls' })),
  });
  log.append('tool/call', { callId: 'b', name: 'write_file', arguments: '{}' });
  return log;
}

const messageTexts = (events: readonly SessionEvent[]) => {
  const replay = replayConversation(events);
  return replay.kind === 'replayed'
    ? replay.messages.map((message) => `${message.getType()}:${message.text}`)
    : replay.reason;
};

function runInvariant(log: SessionLog): InvariantError[] {
  const violations: InvariantError[] = [];
  createInvariantRunner({
    log,
    companions: [
      {
        packageName: CORE_INVARIANT_PACKAGE,
        installer: sessionInvariant,
        origin: { id: 'core-invariant#0', name: 'core-invariant' },
      },
    ],
    onViolation: (error) => violations.push(error),
    warn: (message) => {
      throw new Error(`不該有 warn：${message}`);
    },
  });
  return violations;
}

describe('補寫之後', () => {
  it('模型那一側逐字不變：補在日誌裡的結果與記憶體裡補的那句一樣', () => {
    const log = crashed();
    expect(messageTexts([...log.events, ...interruptedTurnClosers(log.events)])).toEqual(
      messageTexts(log.events),
    );
  });

  it('模型那一側逐字不變：還沒開始與結果不明兩種都在，也不重複補', () => {
    const log = crashedMixed();
    const closers = interruptedTurnClosers(log.events);
    expect(typesOf(closers)).toEqual(['tool/result', 'tool/result', 'model/end', 'turn/end']);
    const before = messageTexts(log.events);
    expect(messageTexts([...log.events, ...closers])).toEqual(before);
    // 兩種句子都真的在模型看得到的那串裡，各一次。
    const joined = Array.isArray(before) ? before.join('\n') : '';
    expect(joined.split(TOOL_OUTCOME_UNKNOWN_TEXT)).toHaveLength(2);
    expect(joined.split(TOOL_NOT_STARTED_TEXT)).toHaveLength(2);
  });

  it('舊檔形狀（補結在 end-seed 後面）模型那一側也不變、不重複', () => {
    const seeded = new SessionLog('crash', { seed: crashedMixed().events });
    const closers = interruptedTurnClosers(seeded.events);
    expect(typesOf(closers)).toEqual(['tool/result', 'tool/result', 'model/end', 'turn/end']);
    expect(messageTexts([...seeded.events, ...closers])).toEqual(messageTexts(seeded.events));
  });

  it('不變量不報違規：補結＋end-seed＋新一輪（含還沒開始的結果與 model/end）', () => {
    const first = crashedMixed();
    const resumed = new SessionLog('crash', {
      seed: [...first.events, ...interruptedTurnClosers(first.events)],
    });
    const violations = runInvariant(resumed);
    resumed.append('turn/start', { kind: 'message', text: '再來' });
    resumed.append('turn/end', {});
    expect(violations).toEqual([]);
  });

  it('不變量不報違規：舊檔形狀（開著的輪＋end-seed）補結接在後面，再接新一輪', () => {
    const old = new SessionLog('crash', { seed: crashedMixed().events });
    const resumed = new SessionLog('crash', {
      seed: [...old.events, ...interruptedTurnClosers(old.events)],
    });
    const violations = runInvariant(resumed);
    resumed.append('turn/start', { kind: 'message', text: '再來' });
    resumed.append('turn/end', {});
    expect(violations).toEqual([]);
  });

  it('不變量不報違規：舊檔「開著的輪＋end-seed＋新一輪」照舊（沒有補結）', () => {
    const resumed = new SessionLog('crash', { seed: crashedMixed().events });
    const violations = runInvariant(resumed);
    resumed.append('turn/start', { kind: 'message', text: '再來' });
    resumed.append('turn/end', {});
    expect(violations).toEqual([]);
  });

  it('不變量仍抓得到沒有前面 tool/call 的一般結果；只有「還沒開始」那個碼放行', () => {
    const log = new SessionLog('v');
    const violations = runInvariant(log);
    log.append('turn/start', { kind: 'message', text: 'x' });
    log.append('tool/result', {
      callId: 'ghost',
      isError: true,
      error: { name: 'E', code: 'OTHER' },
    });
    log.append('tool/result', {
      callId: 'late',
      isError: true,
      error: { name: 'ToolNotStartedError', code: TOOL_NOT_STARTED },
    });
    log.append('turn/end', {});
    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toContain('ghost');
  });

  it('帶過 end-seed 的開著的輪，不會讓下一輪之後的孤兒結果漏網', () => {
    const resumed = new SessionLog('crash', { seed: crashedMixed().events });
    const violations = runInvariant(resumed);
    resumed.append('turn/start', { kind: 'message', text: '再來' });
    resumed.append('tool/result', {
      callId: 'b',
      isError: true,
      error: { name: 'E', code: 'OTHER' },
    });
    resumed.append('turn/end', {});
    expect(violations).toHaveLength(1);
  });
});

/** 一個記下 append／close 的假存放處。 */
function fakeStore(events: readonly SessionEvent[], options: { failAppend?: boolean } = {}) {
  const appended: SessionEvent[][] = [];
  let closed = 0;
  const stored: StoredSession = {
    append: (batch) => {
      if (options.failAppend === true) return Promise.reject(new Error('寫不進去'));
      appended.push([...batch]);
      return Promise.resolve();
    },
    flush: () => Promise.resolve(),
    close: () => {
      closed += 1;
      return Promise.resolve();
    },
  };
  const resumed: ResumedStoredSession = {
    header: { version: 1, id: 'crash', createdAt: 0 },
    events,
    stored,
  };
  const store = { resume: () => Promise.resolve(resumed) } as unknown as SessionStore;
  return { store, appended, closed: () => closed };
}

describe('resumeClosingInterruptedTurn', () => {
  it('把補結寫進同一個把手，交回的 events 已含補結', async () => {
    const log = crashed();
    const fake = fakeStore(log.events);
    const resumed = await resumeClosingInterruptedTurn(fake.store, 'crash');

    expect(fake.appended).toHaveLength(1);
    expect(typesOf(fake.appended[0]!)).toEqual(['tool/result', 'turn/end']);
    expect(resumed.events).toHaveLength(log.events.length + 2);
    expect(resumed.events.map((event) => event.seq)).toEqual(resumed.events.map((_, at) => at));
  });

  it('冪等：補過的檔再續接一次，第二次不寫', async () => {
    const log = crashed();
    const first = await resumeClosingInterruptedTurn(fakeStore(log.events).store, 'crash');
    const second = fakeStore(first.events);
    await resumeClosingInterruptedTurn(second.store, 'crash');
    expect(second.appended).toHaveLength(0);
  });

  it('已平衡的檔：不碰把手', async () => {
    const log = new SessionLog('ok');
    log.append('turn/start', { kind: 'message', text: 'hi' });
    log.append('turn/end', {});
    const fake = fakeStore(log.events);
    await resumeClosingInterruptedTurn(fake.store, 'ok');
    expect(fake.appended).toHaveLength(0);
  });

  it('寫不進去：放掉把手再拋，不留租約', async () => {
    const fake = fakeStore(crashed().events, { failAppend: true });
    await expect(resumeClosingInterruptedTurn(fake.store, 'crash')).rejects.toThrow('寫不進去');
    expect(fake.closed()).toBe(1);
  });
});
