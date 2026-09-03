/**
 * **用量記錄器**——[#153](https://github.com/DemianLi/nexus-agent/issues/153) 在 core 這一側
 * 的驗收。這裡量的是**規則**：什麼樣的數字收、什麼樣的不收、寫不進去的時候會怎樣。
 *
 * 真的跑一場對話、真的落進 root 與 subagent 各自的日誌，由
 * `apps/harness/src/model-usage.test.ts` 量。
 */

import { AIMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import { createModelUsageRecorder, readModelUsage } from './model-usage.js';
import type { SessionLookup } from './registry.js';
import { SessionLog } from './session-log.js';

/** 把 middleware 的 `wrapModelCall` 挖出來。 */
function hookOf(middleware: unknown): (request: unknown, handler: unknown) => Promise<unknown> {
  const hook = (middleware as { wrapModelCall?: unknown }).wrapModelCall;
  if (typeof hook !== 'function') throw new Error('這個 middleware 沒有 wrapModelCall');
  return hook as (request: unknown, handler: unknown) => Promise<unknown>;
}

/** 一顆帶指定 `usage_metadata` 的回應。 */
function reply(usage?: Record<string, unknown>): AIMessage {
  return new AIMessage({
    content: '好。',
    ...(usage === undefined ? {} : { usage_metadata: usage as never }),
  });
}

/** 跑一次模型呼叫，回傳這一次進了日誌的東西。 */
async function record(
  usage: Record<string, unknown> | undefined,
  lookup: SessionLookup,
): Promise<unknown> {
  const middleware = createModelUsageRecorder({ forCall: () => lookup });
  const response = reply(usage);
  const returned = await hookOf(middleware)(
    { runtime: { configurable: { checkpoint_ns: 'model_request:x' } } },
    () => response,
  );
  // **回應要原樣傳回去。** 這顆 middleware 只讀不改；改了就是在動模型的輸出。
  expect(returned).toBe(response);
  return returned;
}

describe('readModelUsage', () => {
  it('三個數字都對就照供應商報的收，一個都不重算', () => {
    // `total` 刻意不等於 `input + output`：收下來的必須是報回來的 100，不是我們算的 90。
    expect(
      readModelUsage(reply({ input_tokens: 30, output_tokens: 60, total_tokens: 100 })),
    ).toEqual({ inputTokens: 30, outputTokens: 60, totalTokens: 100 });
  });

  it('0 是合法的數量', () => {
    expect(readModelUsage(reply({ input_tokens: 0, output_tokens: 0, total_tokens: 0 }))).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
  });

  it.each([
    ['沒有 usage_metadata', undefined],
    ['少一欄', { input_tokens: 1, output_tokens: 2 }],
    ['負數', { input_tokens: -1, output_tokens: 2, total_tokens: 3 }],
    ['小數', { input_tokens: 1.5, output_tokens: 2, total_tokens: 3.5 }],
    ['NaN', { input_tokens: Number.NaN, output_tokens: 2, total_tokens: 2 }],
    ['Infinity', { input_tokens: 1, output_tokens: Number.POSITIVE_INFINITY, total_tokens: 2 }],
    ['超出安全整數', { input_tokens: 2 ** 53, output_tokens: 0, total_tokens: 2 ** 53 }],
    ['字串', { input_tokens: '1', output_tokens: 2, total_tokens: 3 }],
  ])('%s 就整筆不要——不補 0、不補預設值', (_label, usage) => {
    expect(readModelUsage(reply(usage as Record<string, unknown> | undefined))).toBeUndefined();
  });

  /**
   * **總量矛盾這一條照 dsh 的 `normalizeUsage`**：`total - output` 要是一個數量、而且不小於
   * 已知的 prompt。小於就是報回來的數字自己對不起來，那種寧可沒有。
   *
   * 注意 `ScriptedChatModel` 的 `total` 是它自己 `input + output` 加的，所以**假模型永遠
   * 走不到這條路徑**——只有手搭訊息測得到，這就是這一組存在的理由。
   */
  it.each([
    ['總量小於 input + output', { input_tokens: 50, output_tokens: 50, total_tokens: 80 }],
    ['總量小於 output', { input_tokens: 0, output_tokens: 50, total_tokens: 10 }],
  ])('%s 就整筆不要', (_label, usage) => {
    expect(readModelUsage(reply(usage as Record<string, unknown>))).toBeUndefined();
  });

  it('總量比 input + output 大是可以的——供應商有沒被細分出來的桶', () => {
    expect(
      readModelUsage(reply({ input_tokens: 10, output_tokens: 20, total_tokens: 45 })),
    ).toEqual({ inputTokens: 10, outputTokens: 20, totalTokens: 45 });
  });
});

describe('這顆 middleware 記得進去的時候', () => {
  it('報了就記一筆，數字原樣', async () => {
    const log = new SessionLog('s');
    await record(
      { input_tokens: 11, output_tokens: 22, total_tokens: 33 },
      {
        kind: 'ok',
        address: { kind: 'root' },
        log,
      },
    );
    expect(log.events.map((event) => event.type)).toEqual(['model/usage']);
    expect(log.events[0]?.data).toEqual({ inputTokens: 11, outputTokens: 22, totalTokens: 33 });
  });

  it('沒報就一筆都沒有——不是三個 0，是整顆事件不存在', async () => {
    const log = new SessionLog('s');
    await record(undefined, { kind: 'ok', address: { kind: 'root' }, log });
    expect(log.events).toEqual([]);
  });

  it('數字驗不過也一筆都沒有', async () => {
    const log = new SessionLog('s');
    await record(
      { input_tokens: 50, output_tokens: 50, total_tokens: 80 },
      {
        kind: 'ok',
        address: { kind: 'root' },
        log,
      },
    );
    expect(log.events).toEqual([]);
  });
});

/**
 * **這顆 middleware 坐在 request path 上，所以它一條都不准拋。**
 *
 * 這一組是絆索：拿掉 `model-usage.ts` 裡那個 try/catch、或把非 `ok` 改成拋，紅的就是
 * 這裡。而它們在真流量上不是理論——`not-attached` 是**常態**（絕大多數組裝點沒有
 * `attachSession`），`ambiguous` 在 `serve.ts` 一次組裝配多條 thread 時是真的。
 */
describe('寫不進去的時候，它不准扳倒模型呼叫', () => {
  it.each([
    ['沒接上會話註冊表', { kind: 'not-attached' } as const],
    ['認不出這次呼叫', { kind: 'unknown-caller' } as const],
    ['綁著不只一張註冊表', { kind: 'ambiguous', count: 2 } as const],
  ])('%s：不記、不拋，回應照樣傳回去', async (_label, lookup) => {
    await expect(
      record({ input_tokens: 1, output_tokens: 2, total_tokens: 3 }, lookup),
    ).resolves.toBeInstanceOf(AIMessage);
  });

  it('append 自己拋也吃掉——不然一次寫日誌失敗就是一次模型呼叫死掉', async () => {
    const log = new SessionLog('s');
    const append = vi.spyOn(log, 'append').mockImplementation(() => {
      throw new Error('日誌拒收');
    });
    await expect(
      record(
        { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
        {
          kind: 'ok',
          address: { kind: 'root' },
          log,
        },
      ),
    ).resolves.toBeInstanceOf(AIMessage);
    expect(append).toHaveBeenCalledOnce();
  });

  it('模型自己拋的照樣往外拋——被吃掉的只有記錄這一步', async () => {
    const middleware = createModelUsageRecorder({
      forCall: () => ({ kind: 'ok', address: { kind: 'root' }, log: new SessionLog('s') }),
    });
    await expect(
      hookOf(middleware)({ runtime: { configurable: {} } }, () => {
        throw new Error('模型掛了');
      }),
    ).rejects.toThrow('模型掛了');
  });
});

describe('身分從執行期的 configurable 推', () => {
  it('傳給 forCall 的是包了一層 configurable 的那個形狀', async () => {
    const forCall = vi.fn<(config: unknown) => SessionLookup>(() => ({ kind: 'not-attached' }));
    const middleware = createModelUsageRecorder({ forCall });
    const configurable = { checkpoint_ns: 'tools:a|model_request:b', thread_id: 't' };
    await hookOf(middleware)({ runtime: { configurable } }, () =>
      reply({ input_tokens: 1, output_tokens: 2, total_tokens: 3 }),
    );
    expect(forCall).toHaveBeenCalledWith({ configurable });
  });

  it('沒報用量就連問都不問——省掉一次沒有用途的查表', async () => {
    const forCall = vi.fn<(config: unknown) => SessionLookup>(() => ({ kind: 'not-attached' }));
    const middleware = createModelUsageRecorder({ forCall });
    await hookOf(middleware)({ runtime: { configurable: {} } }, () => reply());
    expect(forCall).not.toHaveBeenCalled();
  });
});
