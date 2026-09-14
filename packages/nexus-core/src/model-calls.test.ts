/**
 * **模型呼叫的起訖**——[#266](https://github.com/DemianLi/nexus-agent/issues/266) 在 core 這一側
 * 的規則：什麼時候記、記不進去會怎樣。真的跑一場之後日誌裡有什麼，在
 * `apps/harness/src/session-stats.test.ts`。
 */

import { AIMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { describe, expect, it, vi } from 'vitest';
import { fromLoggedMessage, toLoggedMessage } from './logged-message.js';
import { createModelCallRecorder } from './model-calls.js';
import type { SessionLookup } from './registry.js';
import { SessionLog } from './session-log.js';
import type { SessionEventMap } from './session-log.js';
import { INTERRUPTED_REPLY_MARKER } from './turn-cancel.js';

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
    expect(log.events.map((event) => event.data)).toEqual([
      {},
      { message: toLoggedMessage(response) },
      {},
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

describe('記不進去不能扳倒模型呼叫', () => {
  it.each<[string, SessionLookup]>([
    ['not-attached', { kind: 'not-attached' }],
    ['unknown-caller', { kind: 'unknown-caller' }],
    ['ambiguous', { kind: 'ambiguous', count: 2 }],
  ])('%s：一顆都不記，呼叫照跑', async (_label, lookup) => {
    const response = new AIMessage('好。');
    await expect(run(lookup, () => response)).resolves.toBe(response);
  });

  /** 半對的事件比沒有更糟：開頭沒記成，結尾也不記，不變量才不會讀成寫錯了。 */
  it('開頭記不進去：結尾也不記，呼叫照跑', async () => {
    const log = new SessionLog('calls');
    const append = vi.spyOn(log, 'append').mockImplementationOnce(() => {
      throw new Error('寫不進去');
    });
    const response = new AIMessage('好。');
    await expect(run(ok(log), () => response)).resolves.toBe(response);
    expect(append).toHaveBeenCalledTimes(1);
  });

  it('結尾記不進去：回應照樣傳回', async () => {
    const log = new SessionLog('calls');
    const real = log.append.bind(log);
    vi.spyOn(log, 'append').mockImplementation(((type: never, data: never) => {
      if (type === 'model/end') throw new Error('寫不進去');
      return real(type, data);
    }) as typeof log.append);
    const response = new AIMessage('好。');
    await expect(run(ok(log), () => response)).resolves.toBe(response);
    expect(typesOf(log)).toEqual(['model/start', 'assistant/message']);
  });

  it('回覆記不進去：回應照樣傳回，結尾照記', async () => {
    const log = new SessionLog('calls');
    const real = log.append.bind(log);
    vi.spyOn(log, 'append').mockImplementation(((type: never, data: never) => {
      if (type === 'assistant/message') throw new Error('寫不進去');
      return real(type, data);
    }) as typeof log.append);
    const response = new AIMessage('好。');
    await expect(run(ok(log), () => response)).resolves.toBe(response);
    expect(typesOf(log)).toEqual(['model/start', 'model/end']);
  });
});
