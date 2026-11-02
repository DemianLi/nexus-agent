import { describe, expect, it } from 'vitest';

import { sseResponse } from './sse-response.js';

/**
 * `pull` 裡 `encode` 拋錯（[#1560](https://github.com/DemianLi/nexus-agent/issues/1560) N1384）：以前 `pull` reject、串流進入 errored，
 * `cancel()` 不會被叫，產生器停在 `yield`、`finally` 不跑。用一個會拋的假 `encode` 直接測這一層。
 */

/** 產生器：吐 `items`，`finally` 記下有沒有跑。 */
function source(items: readonly string[]) {
  const state = { finished: false };
  const generator = (async function* () {
    try {
      for (const item of items) yield item;
      // 吐完不結束：停在這裡等，像一條長期的下行。
      await new Promise<void>(() => {});
    } finally {
      state.finished = true;
    }
  })();
  return { generator, state };
}

describe('sseResponse', () => {
  it('encode 拋錯：產生器的 finally 跑了、記一行 warn（路徑與標籤、不含內容）、串流 errored', async () => {
    const secret = 'S3CRET-內容';
    const { generator, state } = source(['ok', secret]);
    const warned: string[] = [];
    const response = sseResponse(
      generator,
      (value) => {
        if (value === secret) throw new TypeError(`壞了，值是 ${secret}`.replace(secret, 'x'));
        return `data: ${value}\n\n`;
      },
      {
        where: 'thread t1',
        describe: (value) => (value === secret ? 'messages' : 'other'),
        warn: (message) => warned.push(message),
      },
    );
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    expect(decoder.decode((await reader.read()).value)).toBe(': connected\n\n');
    expect(decoder.decode((await reader.read()).value)).toBe('data: ok\n\n');
    await expect(reader.read()).rejects.toThrow('壞了');

    // 讀者拿到錯誤的時候，產生器的 finally 已經（或馬上）跑完：那是 `#subscribers.delete` 唯一的地方。
    for (let attempt = 0; attempt < 50 && !state.finished; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(state.finished).toBe(true);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('thread t1');
    expect(warned[0]).toContain('messages');
    expect(warned[0]).toContain('TypeError');
    expect(warned[0]).not.toContain(secret);
  });

  it('describe 自己拋也不弄壞 pull：退成固定標籤', async () => {
    const { generator, state } = source(['a']);
    const warned: string[] = [];
    const response = sseResponse(
      generator,
      () => {
        throw new Error('x');
      },
      {
        where: '全域下行',
        describe: () => {
          throw new Error('y');
        },
        warn: (message) => warned.push(message),
      },
    );
    const reader = response.body!.getReader();
    await reader.read(); // 開線註解
    await expect(reader.read()).rejects.toThrow('x');
    for (let attempt = 0; attempt < 50 && !state.finished; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(state.finished).toBe(true);
    expect(warned[0]).toContain('事件');
  });

  it('一切正常時照常送，讀者取消會叫 return', async () => {
    const { generator, state } = source(['a', 'b']);
    const response = sseResponse(generator, (value) => `data: ${value}\n\n`, {
      where: 'thread t1',
      describe: () => 'x',
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    await reader.read();
    expect(decoder.decode((await reader.read()).value)).toBe('data: a\n\n');
    expect(decoder.decode((await reader.read()).value)).toBe('data: b\n\n');
    await reader.cancel();
    for (let attempt = 0; attempt < 50 && !state.finished; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(state.finished).toBe(true);
  });
});
