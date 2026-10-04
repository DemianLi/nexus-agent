/**
 * 把事件歸到模型呼叫（[#1021](https://github.com/DemianLi/nexus-agent/issues/1021)）。
 * 日誌都是照真實日誌的事件順序手寫的——歸屬不能靠位置，所以這裡刻意把會騙過位置的順序寫出來。
 */

import { AIMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { indexModelCalls } from './model-call-index.js';
import { toLoggedMessage } from './logged-message.js';
import { SessionLog } from './session-log.js';

/** 寫一顆 core 不認得種類的事件（owner 套件才宣告的那些）。 */
function foreign(log: SessionLog, type: string): void {
  (log as unknown as { append(type: string, data: unknown): unknown }).append(type, {});
}

const LLM_FAILURE = { message: '壞了', code: 'SERVER', status: 500 } as const;

/** 一則帶工具呼叫的回覆。 */
const reply = (modelCall: number | undefined, ...toolCallIds: string[]) => ({
  message: toLoggedMessage(
    new AIMessage({
      content: '好。',
      tool_calls: toolCallIds.map((id) => ({ id, name: 'read_file', args: {} })),
    }),
  ),
  ...(modelCall === undefined ? {} : { modelCall }),
});

const call = (callId: string) => ({ callId, name: 'read_file', arguments: '{}' });
const result = (callId: string) => ({ callId, isError: false });

/** 每一類事件的 seq，方便斷言。 */
const seqsOf = (events: readonly { seq: number }[]) => events.map((event) => event.seq);

describe('三個真實日誌的反例：位置會歸錯，識別不會', () => {
  it('標題請求落在主呼叫那一對起訖之間：它與它夾帶的重試事件都不算主呼叫的', () => {
    const log = new SessionLog('t1');
    log.append('model/start', {}); // 0
    // 標題請求的種類由 harness 宣告，core 的型別不認得；測試只要它是一顆夾在中間的外來事件。
    foreign(log, 'session/title-llm-request'); // 1
    // 標題請求若失敗重試，沒有主呼叫的識別（寫入點不在主呼叫的範圍裡）。位置會把它算成主呼叫的第一次重試。
    log.append('llm/retry', { retryId: 'title', retry: 1, maxRetries: 3, failure: LLM_FAILURE }); // 2
    log.append('model/usage', { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCall: 0 }); // 3
    log.append('assistant/message', reply(0)); // 4
    log.append('model/end', { modelCall: 0 }); // 5
    const { calls, unattributed } = indexModelCalls(log.events);
    expect(calls).toHaveLength(1);
    expect(seqsOf(calls[0]!.usage)).toEqual([3]);
    expect(seqsOf(calls[0]!.replies)).toEqual([4]);
    expect(calls[0]!.retries).toEqual([]);
    expect(calls[0]!.end?.seq).toBe(5);
    // 標題請求本身不是這支函式管的種類；那顆重試沒有識別，進 unattributed，不猜。
    expect(seqsOf(unattributed)).toEqual([2]);
  });

  it('佇列事件落在另一對起訖裡：兩次呼叫的內容互不沾染', () => {
    const log = new SessionLog('t2');
    log.append('model/start', {}); // 0
    log.append('assistant/message', reply(0)); // 1
    log.append('model/end', { modelCall: 0 }); // 2
    log.append('model/start', {}); // 3
    log.append('inbox/spliced', {
      kind: 'enqueue',
      item: { id: 'i', text: 'x', source: { kind: 'user' } },
    } as never); // 4
    log.append('model/usage', { inputTokens: 2, outputTokens: 2, totalTokens: 4, modelCall: 3 }); // 5
    log.append('assistant/message', reply(3)); // 6
    log.append('model/end', { modelCall: 3 }); // 7
    const { calls } = indexModelCalls(log.events);
    expect(calls.map((each) => each.modelCall)).toEqual([0, 3]);
    expect(seqsOf(calls[0]!.replies)).toEqual([1]);
    expect(calls[0]!.usage).toEqual([]);
    expect(seqsOf(calls[1]!.usage)).toEqual([5]);
    expect(seqsOf(calls[1]!.replies)).toEqual([6]);
  });

  it('量測寫在 model/end 之後：歸給它量的那一次，不是下一次', () => {
    const log = new SessionLog('t3');
    log.append('model/start', {}); // 0
    log.append('assistant/message', reply(0)); // 1
    log.append('model/end', { modelCall: 0 }); // 2
    // 這一顆量的是第 0 次送出之前的那份請求，卻落在 end 之後、第 3 顆 start 之前。
    log.append('context/measure', {
      approxTokens: 9,
      messageCount: 1,
      thresholds: [],
      modelCall: 0,
    }); // 3
    log.append('model/start', {}); // 4
    log.append('assistant/message', reply(4)); // 5
    log.append('model/end', { modelCall: 4 }); // 6
    log.append('context/measure', {
      approxTokens: 19,
      messageCount: 3,
      thresholds: [],
      modelCall: 4,
    }); // 7
    const { calls, unattributed } = indexModelCalls(log.events);
    expect(seqsOf(calls[0]!.measures)).toEqual([3]);
    expect(seqsOf(calls[1]!.measures)).toEqual([7]);
    expect(unattributed).toEqual([]);
  });
});

describe('重試、工具、被切斷的半段', () => {
  it('重試事件按識別歸給呼叫，同一次呼叫的重試共用一個 retryId', () => {
    const log = new SessionLog('r');
    log.append('model/start', {}); // 0
    log.append('llm/retry', {
      retryId: 'a',
      retry: 1,
      maxRetries: 3,
      failure: LLM_FAILURE,
      modelCall: 0,
    });
    log.append('llm/retry-started', { retryId: 'a', retry: 1, waitedMs: 5, modelCall: 0 });
    log.append('model/end', { modelCall: 0 });
    const { calls } = indexModelCalls(log.events);
    expect(calls[0]!.retries).toHaveLength(1);
    expect(calls[0]!.retryStarts).toHaveLength(1);
  });

  it('工具歸給發出它的那則回覆；供應商每則都從 call_0 起算也不串', () => {
    const log = new SessionLog('tools');
    log.append('model/start', {}); // 0
    log.append('assistant/message', reply(0, 'call_0')); // 1
    log.append('model/end', { modelCall: 0 }); // 2
    log.append('tool/call', call('call_0')); // 3
    log.append('tool/result', result('call_0')); // 4
    log.append('model/start', {}); // 5
    log.append('assistant/message', reply(5, 'call_0', 'call_1')); // 6：同一個 id 再用一次
    log.append('model/end', { modelCall: 5 }); // 7
    log.append('tool/call', call('call_0')); // 8
    log.append('tool/call', call('call_1')); // 9
    log.append('tool/result', result('call_1')); // 10
    log.append('tool/result', result('call_0')); // 11
    const { calls, unattributed } = indexModelCalls(log.events);
    expect(seqsOf(calls[0]!.toolCalls)).toEqual([3]);
    expect(seqsOf(calls[0]!.toolResults)).toEqual([4]);
    expect(seqsOf(calls[1]!.toolCalls)).toEqual([8, 9]);
    expect(seqsOf(calls[1]!.toolResults)).toEqual([10, 11]);
    expect(unattributed).toEqual([]);
  });

  it('被人按停止切斷的半段回覆歸給被切斷的那次，排在正常回覆之後', () => {
    const log = new SessionLog('cut');
    log.append('model/start', {}); // 0
    log.append('model/end', { modelCall: 0 }); // 1
    log.append('assistant/message', { ...reply(0), interrupted: true }); // 2：pump 在 end 之後補
    const { calls } = indexModelCalls(log.events);
    expect(calls[0]!.replies).toHaveLength(1);
    expect(calls[0]!.replies[0]!.data.interrupted).toBe(true);
  });
});

describe('舊日誌與歸不到的：標「—」，不猜', () => {
  it('這一版以前的日誌：start 成一筆但什麼都沒歸進去，其餘全進 unattributed', () => {
    const log = new SessionLog('legacy');
    log.append('model/start', {}); // 0
    log.append('model/usage', { inputTokens: 1, outputTokens: 1, totalTokens: 2 }); // 1
    log.append('assistant/message', reply(undefined, 'c1')); // 2
    log.append('model/end', {}); // 3
    log.append('tool/call', call('c1')); // 4
    log.append('tool/result', result('c1')); // 5
    const { calls, unattributed } = indexModelCalls(log.events);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ end: undefined, usage: [], replies: [], toolCalls: [] });
    expect(seqsOf(unattributed)).toEqual([1, 2, 3, 4, 5]);
  });

  it('舊回覆蓋掉同 id 較早的歸屬：工具不會落回更早一次呼叫', () => {
    const log = new SessionLog('mixed');
    log.append('model/start', {}); // 0
    log.append('assistant/message', reply(0, 'call_0')); // 1
    log.append('model/end', { modelCall: 0 }); // 2
    log.append('model/start', {}); // 3：升版前寫的，沒有識別
    log.append('assistant/message', reply(undefined, 'call_0')); // 4
    log.append('model/end', {}); // 5
    log.append('tool/call', call('call_0')); // 6
    const { calls, unattributed } = indexModelCalls(log.events);
    expect(calls[0]!.toolCalls).toEqual([]);
    expect(seqsOf(unattributed)).toContain(6);
  });

  it('指向不在這一段裡的 seq（分頁截掉前面）：不猜，進 unattributed', () => {
    const log = new SessionLog('page');
    log.append('model/start', {}); // 0
    log.append('model/end', { modelCall: 0 }); // 1
    log.append('model/usage', { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCall: 0 }); // 2
    const tail = log.events.slice(1);
    const { calls, unattributed } = indexModelCalls(tail);
    expect(calls).toEqual([]);
    expect(seqsOf(unattributed)).toEqual([1, 2]);
  });
});
