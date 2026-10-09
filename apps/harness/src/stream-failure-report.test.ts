/**
 * fetch 那一層什麼時候向重試那一顆回報「這一次嘗試的串流壞了」（[#520](https://github.com/DemianLi/nexus-agent/issues/520)）。
 *
 * 真的打假端點、走完 pump 的那一半在 `stream-retry.test.ts`。這裡把 SSE 位元組直接餵給 `withInbandStreamErrors` 與
 * `withStreamIdleTimeout`，數重試那一顆呼叫了 handler 幾次：回報了才會有第二次。分段的切法、混在內容裡的 `"error"` 字樣、
 * 下游先收手之後的收尾，這些在真端點上不容易穩定重現。
 */

import { createStreamRetryMiddleware } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import { withInbandStreamErrors, withStreamIdleTimeout } from './live-model.js';

const encoder = new TextEncoder();

const data = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
const content = (text: string): string =>
  data({ id: 'c', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
const envelope = (code: number): string => data({ error: { message: '上游出事了', code } });

/** 一個吐指定分段的 SSE fetch；`then` 決定吐完之後怎麼收（結束 / 擱著 / 出錯）。 */
function sseFetch(chunks: readonly string[], then: 'end' | 'hang' | 'error' = 'end'): typeof fetch {
  return async () => {
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(encoder.encode(chunks[index]!));
          index += 1;
          return;
        }
        if (then === 'end') controller.close();
        else if (then === 'error') controller.error(new TypeError('terminated'));
        else return new Promise<void>(() => {});
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
}

/** 讀完整份 body。 */
async function drain(response: Response): Promise<void> {
  const reader = response.body!.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done) return;
  }
}

/**
 * 在重試那一顆裡跑一次「發請求、把 body 讀完、然後這次呼叫失敗」；回傳 handler 被叫了幾次。
 * 讀 body 本身拋錯的（斷線、逾時）也是這一次呼叫的失敗。第二次以後直接成功。
 */
async function attemptsFor(
  upstream: typeof fetch,
  options: { idleMs?: number; consume?: (response: Response) => Promise<void> } = {},
): Promise<number> {
  const wrapped = withStreamIdleTimeout(options.idleMs ?? 5_000, withInbandStreamErrors(upstream));
  const middleware = createStreamRetryMiddleware({ maxRetries: 1, baseDelayMs: 1 }) as unknown as {
    wrapModelCall: (request: unknown, handler: () => Promise<unknown>) => Promise<unknown>;
  };
  let calls = 0;
  await middleware
    .wrapModelCall({ runtime: { configurable: {} } }, async () => {
      calls += 1;
      if (calls > 1) return 'ok';
      const response = await wrapped('http://upstream.invalid/v1');
      await (options.consume ?? drain)(response);
      // 模擬 SDK 看到錯誤事件之後把錯誤拋出來。
      throw new Error('這一次呼叫失敗了');
    })
    .catch(() => undefined);
  return calls;
}

describe('串流內的錯誤事件', () => {
  it('第一則事件之後的錯誤信封：回報，而且位元組原樣往下交', async () => {
    const received: string[] = [];
    const calls = await attemptsFor(sseFetch([content('甲'), envelope(503), 'data: [DONE]\n\n']), {
      consume: async (response) => {
        const decoder = new TextDecoder();
        const reader = response.body!.getReader();
        for (;;) {
          const next = await reader.read();
          if (next.done) return;
          received.push(decoder.decode(next.value));
        }
      },
    });
    expect(calls).toBe(2);
    expect(received.join('')).toBe(content('甲') + envelope(503) + 'data: [DONE]\n\n');
  });

  it('整份擠在同一段位元組裡（loopback 會這樣併段）：照樣認得', async () => {
    const calls = await attemptsFor(sseFetch([content('甲') + content('乙') + envelope(503)]));
    expect(calls).toBe(2);
  });

  it('錯誤事件被切在兩段中間、用 CRLF 分隔：照樣認得', async () => {
    const whole = envelope(503).replace(/\n/g, '\r\n');
    const calls = await attemptsFor(
      sseFetch([content('甲').replace(/\n/g, '\r\n'), whole.slice(0, 20), whole.slice(20)]),
    );
    expect(calls).toBe(2);
  });

  it('請求本身有問題的錯誤（400）：回報了，但標成重打沒用', async () => {
    expect(await attemptsFor(sseFetch([content('甲'), envelope(400)]))).toBe(1);
  });

  it('內容裡剛好有 "error" 字樣、錯誤欄位是 null：都不算錯誤信封', async () => {
    const calls = await attemptsFor(
      sseFetch([
        content('他說 "error" 這個字'),
        data({ id: 'c', error: null, choices: [] }),
        ': ping\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    expect(calls).toBe(1);
  });

  it('單一事件長到超過上限還沒收尾：放棄監看，之後的錯誤不再回報（回到 #520 之前的行為）', async () => {
    const unterminated = content('x'.repeat(1_100_000)).slice(0, -2);
    expect(await attemptsFor(sseFetch([content('甲'), unterminated, '\n\n' + envelope(503)]))).toBe(
      1,
    );
  });

  it('長但有收尾的事件：不影響監看，之後的錯誤照樣回報', async () => {
    const long = content('x'.repeat(1_100_000));
    expect(await attemptsFor(sseFetch([content('甲'), long, envelope(503)]))).toBe(2);
  });
});

describe('串流中途的讀取失敗', () => {
  it('吐了內容之後斷線：回報可重打', async () => {
    expect(await attemptsFor(sseFetch([content('甲')], 'error'))).toBe(2);
  });

  it('吐了內容之後停住超過閒置逾時：回報可重打', async () => {
    expect(await attemptsFor(sseFetch([content('甲')], 'hang'), { idleMs: 50 })).toBe(2);
  });

  it('下游先收手（SDK 看完錯誤就不讀了）：收尾時撞到的「Controller is already closed」不算斷線', async () => {
    const calls = await attemptsFor(sseFetch([content('甲')], 'hang'), {
      idleMs: 5_000,
      consume: async (response) => {
        const reader = response.body!.getReader();
        await reader.read();
        // 等一拍，讓下一次 pull 已經掛在上游的讀上（SDK 是一路讀下去的，收手時總有一次讀在飛）。
        await new Promise((resolve) => setTimeout(resolve, 10));
        // 這時候取消：上游的讀端因此回 done，我們這一側 close 一條已經關掉的串流。
        const pending = reader.read();
        await reader.cancel();
        await pending.catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    });
    expect(calls).toBe(1);
  });
});
