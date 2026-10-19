/**
 * **模型呼叫的起訖**——[#266](https://github.com/DemianLi/nexus-agent/issues/266) 在 core 這一側
 * 的規則：什麼時候記、記不進去會怎樣。真的跑一場之後日誌裡有什麼，在
 * `apps/harness/src/session-stats.test.ts`。
 */

import { AIMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { describe, expect, it, vi } from 'vitest';
import { pastLogDepthCap } from './fixtures.js';
import { fromLoggedMessage, toLoggedMessage } from './logged-message.js';
import { createModelCallRecorder } from './model-calls.js';
import type { SessionLookup } from './registry.js';
import { SessionLog } from './session-log.js';
import type { SessionEventMap } from './session-log.js';
import { INTERRUPTED_REPLY_MARKER, TURN_CANCEL_CONFIG_KEY } from './turn-cancel.js';

/** 把 middleware 的 `wrapModelCall` 挖出來。 */
function hookOf(middleware: unknown): (request: unknown, handler: unknown) => Promise<unknown> {
  const hook = (middleware as { wrapModelCall?: unknown }).wrapModelCall;
  if (typeof hook !== 'function') throw new Error('這個 middleware 沒有 wrapModelCall');
  return hook as (request: unknown, handler: unknown) => Promise<unknown>;
}

const REQUEST = { runtime: { configurable: { checkpoint_ns: 'model_request:x' } } };

function run(lookup: SessionLookup, handler: () => unknown): Promise<unknown> {
  return hookOf(createModelCallRecorder({ forCall: () => lookup }))(REQUEST, handler);
}

const typesOf = (log: SessionLog) => log.events.map((event) => event.type);

/** 找到了 root 那一份。 */
const ok = (log: SessionLog): SessionLookup => ({ kind: 'ok', address: { kind: 'root' }, log });

describe('記什麼', () => {
  it('呼叫前一顆 model/start、之後一顆 model/end，回應原樣傳回', async () => {
    const log = new SessionLog('calls');
    const response = new AIMessage('好。');
    const seen: string[] = [];
    const returned = await run(ok(log), () => {
      seen.push(...typesOf(log));
      return response;
    });
    expect(returned).toBe(response);
    // handler 跑的時候開頭那顆已經在了：開頭記在呼叫之前，不是之後補。
    expect(seen).toEqual(['model/start']);
    // 回覆夾在起訖中間，順序同 dsh：回覆在前，它派發的工具事件在 `model/end` 之後（#305）。
    expect(typesOf(log)).toEqual(['model/start', 'assistant/message', 'model/end']);
    // 起訖與回覆互相指回：識別就是 `model/start` 的 `seq`（#1021）。
    expect(log.events.map((event) => event.data)).toEqual([
      {},
      { message: toLoggedMessage(response), modelCall: 0 },
      { modelCall: 0 },
    ]);
  });

  /** #305：推得回同一則——文字、`tool_calls`、供應商塞在 `additional_kwargs` 的推理都在。 */
  it('記的那一則推得回來：文字、tool_calls、reasoning_content 都在', async () => {
    const log = new SessionLog('calls');
    const response = new AIMessage({
      content: '我看一下。',
      additional_kwargs: { reasoning_content: '先列目錄' },
      tool_calls: [{ id: 'c1', name: 'ls', args: { path: '.' }, type: 'tool_call' }],
    });
    await run(ok(log), () => response);
    const data = log.events[1]!.data as SessionEventMap['assistant/message'];
    expect('interrupted' in data).toBe(false);
    const back = fromLoggedMessage(data.message) as AIMessage;
    expect(back.text).toBe('我看一下。');
    expect(back.tool_calls).toEqual(response.tool_calls);
    expect(back.additional_kwargs).toEqual({ reasoning_content: '先列目錄' });
  });

  /**
   * 會讓 `append` 拋的那條路從源頭拿掉了：建構時明著傳 `undefined` 的欄位（`id`），`toDict()` 照樣
   * 列成 key，而 `snapshotJsonValue` 對 `undefined` 當場拋——那樣會安靜地少一則回覆。
   */
  it('明著傳 undefined 的欄位不會讓那一則記不進去', async () => {
    const log = new SessionLog('calls');
    await run(ok(log), () => new AIMessage({ content: '好。', id: undefined }));
    expect(typesOf(log)).toEqual(['model/start', 'assistant/message', 'model/end']);
  });

  /** 子代理被中止時回的那則是合成的，不是回覆：dsh 那側沒有看得見內容的那一步沒有這一顆。 */
  it('合成的中止空訊息不記', async () => {
    const log = new SessionLog('calls');
    const stop = new AIMessage({
      content: '',
      additional_kwargs: { [INTERRUPTED_REPLY_MARKER]: true },
    });
    await run(ok(log), () => stop);
    expect(typesOf(log)).toEqual(['model/start', 'model/end']);
  });

  it('回的不是 AIMessage（`Command`）就不記回覆', async () => {
    const log = new SessionLog('calls');
    await run(ok(log), () => new Command({ update: {} }));
    expect(typesOf(log)).toEqual(['model/start', 'model/end']);
  });

  /** 卡上的驗收句 2：失敗的那一步也要落下結尾，錯誤照樣往外拋。 */
  it('模型拋了：model/end 照樣落下，錯誤原樣拋出去', async () => {
    const log = new SessionLog('calls');
    const boom = new Error('模型不見了');
    await expect(
      run(ok(log), () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(typesOf(log)).toEqual(['model/start', 'model/end']);
  });
});

describe('找不到日誌：不記，呼叫照跑', () => {
  it.each<[string, SessionLookup]>([
    ['not-attached', { kind: 'not-attached' }],
    ['unknown-caller', { kind: 'unknown-caller' }],
    ['ambiguous', { kind: 'ambiguous', count: 2 }],
  ])('%s：一顆都不記，呼叫照跑', async (_label, lookup) => {
    const response = new AIMessage('好。');
    await expect(run(lookup, () => response)).resolves.toBe(response);
  });
});

/**
 * [#1702](https://github.com/DemianLi/nexus-agent/issues/1702)：記不進去這次呼叫就失敗，不吞——照 dsh 請求 header 的寫入
 * （`agent.ts:637-650`，寫不進去就不送請求）與收尾（`:484-510`）。失敗路徑上收尾也記不進去，兩個錯一起拋、原錯在前
 * （`:495-499`）。
 */
describe('記不進去：這次呼叫失敗', () => {
  it('開頭記不進去：請求不送出，append 的錯原樣往外拋', async () => {
    const log = new SessionLog('calls');
    const broken = new Error('寫不進去');
    vi.spyOn(log, 'append').mockImplementationOnce(() => {
      throw broken;
    });
    const handler = vi.fn(() => new AIMessage('好。'));
    await expect(run(ok(log), handler)).rejects.toBe(broken);
    expect(handler).not.toHaveBeenCalled();
    expect(typesOf(log)).toEqual([]);
  });

  it('成功之後結尾記不進去：append 的錯往外拋，回應不傳回', async () => {
    const log = new SessionLog('calls');
    const real = log.append.bind(log);
    const broken = new Error('寫不進去');
    vi.spyOn(log, 'append').mockImplementation(((type: never, data: never) => {
      if (type === 'model/end') throw broken;
      return real(type, data);
    }) as typeof log.append);
    await expect(run(ok(log), () => new AIMessage('好。'))).rejects.toBe(broken);
    expect(typesOf(log)).toEqual(['model/start', 'assistant/message']);
  });

  it('模型拋了、結尾也記不進去：AggregateError，原錯在前也是 cause', async () => {
    const log = new SessionLog('calls');
    const real = log.append.bind(log);
    const broken = new Error('寫不進去');
    vi.spyOn(log, 'append').mockImplementation(((type: never, data: never) => {
      if (type === 'model/end') throw broken;
      return real(type, data);
    }) as typeof log.append);
    const boom = new Error('模型不見了');
    const error = await run(ok(log), () => {
      throw boom;
    }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([boom, broken]);
    expect((error as AggregateError).cause).toBe(boom);
    expect(typesOf(log)).toEqual(['model/start']);
  });
});

/**
 * [#1665](https://github.com/DemianLi/nexus-agent/issues/1665)：回覆被日誌那一關拒收，照 dsh 這次呼叫失敗（`assistant-stream.ts:83-88`，
 * `687f282e`），不是吞掉。吞掉的話回應照樣進 state、日誌上卻沒有。
 */
describe('回覆記不進去：這次呼叫失敗', () => {
  it('原錯往外拋，回覆不在日誌上，結尾記 error', async () => {
    const log = new SessionLog('calls');
    const response = new AIMessage({
      content: '',
      tool_calls: [{ id: 'c1', name: 't', args: { v: pastLogDepthCap() }, type: 'tool_call' }],
    });
    const error = await run(ok(log), () => response).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(TypeError);
    // 原錯原樣：帶事件種類、路徑與層數，`turn/failed` 拿到的就是這句。
    expect((error as Error).message).toMatch(
      /^會話事件的 assistant\/message 的 data\.message\..* 是第 601 層巢狀，超過上限 600 層$/,
    );
    expect(typesOf(log)).toEqual(['model/start', 'model/end']);
    expect(log.events.at(-1)!.data).toEqual({ modelCall: 0, outcome: 'error' });
  });

  it('反例：收得下的回覆照常記、照常傳回', async () => {
    const log = new SessionLog('calls');
    const response = new AIMessage({
      content: '',
      tool_calls: [{ id: 'c1', name: 't', args: { v: 'shallow' }, type: 'tool_call' }],
    });
    await expect(run(ok(log), () => response)).resolves.toBe(response);
    expect(typesOf(log)).toEqual(['model/start', 'assistant/message', 'model/end']);
  });
});

/** [#1022](https://github.com/DemianLi/nexus-agent/issues/1022)：`model/end` 帶沒有正常回來的方式。 */
describe('model/end.outcome', () => {
  const endOf = (log: SessionLog) => log.events.at(-1)!.data;

  it('正常回來沒有這一格', async () => {
    const log = new SessionLog('calls');
    await run(ok(log), () => new AIMessage('好。'));
    expect(endOf(log)).toEqual({ modelCall: 0 });
  });

  it('拋錯是 error', async () => {
    const log = new SessionLog('calls');
    await expect(
      run(ok(log), () => {
        throw new Error('掛了');
      }),
    ).rejects.toThrow('掛了');
    expect(endOf(log)).toEqual({ modelCall: 0, outcome: 'error' });
  });

  it('中止訊號舉起來了就是 aborted——不管拋的是什麼', async () => {
    const log = new SessionLog('calls');
    const controller = new AbortController();
    controller.abort();
    const request = {
      runtime: {
        configurable: {
          checkpoint_ns: 'model_request:x',
          [TURN_CANCEL_CONFIG_KEY]: controller.signal,
        },
      },
    };
    await expect(
      hookOf(createModelCallRecorder({ forCall: () => ok(log) }))(request, () => {
        throw new Error('隨便什麼');
      }),
    ).rejects.toThrow();
    expect(endOf(log)).toEqual({ modelCall: 0, outcome: 'aborted' });
  });

  it('子代理被中止回的合成收尾（不拋）：不記回覆，outcome 是 aborted', async () => {
    const log = new SessionLog('calls');
    await run(
      ok(log),
      () => new AIMessage({ content: '', additional_kwargs: { [INTERRUPTED_REPLY_MARKER]: true } }),
    );
    expect(typesOf(log)).toEqual(['model/start', 'model/end']);
    expect(endOf(log)).toEqual({ modelCall: 0, outcome: 'aborted' });
  });
});
