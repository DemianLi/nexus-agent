/**
 * 失敗的嘗試等得到子行程關掉（[#1835](https://github.com/DemianLi/nexus-agent/issues/1835)）：{@link connectGeneration} 交出 close 訊號、
 * {@link attemptsOn} 的 `abandon` 等它。用假的 SDK client，不起子行程。實殺子行程的那兩條（`reconnect.test.ts`、`pool.test.ts`）
 * 分不出 `abandon` 有沒有等——`client.close()` 本身就收得掉子行程；這裡釘的是「等」的那一半。
 */

import type { Client } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { attemptsOn, connectGeneration } from './connection.js';
import { mcpConfigSchema } from './index.js';

const config = mcpConfigSchema.parse({
  serverName: 'srv',
  connection: { transport: 'stdio', command: 'unused' },
  maxInstructionBytes: 40,
});

/**
 * 一個假的、已經連上的 SDK client：指引加上 server 署名後超過 40 位元組，所以 `connectGeneration` 在拿到它之後才拋。
 * `listTools` 給了就換掉。
 */
function fakeClient(
  onClose: () => void = () => {},
  listTools: () => Promise<unknown> = () => Promise.resolve({ tools: [] }),
): Client {
  return {
    getProtocolEra: () => 'modern',
    getInstructions: () => '字'.repeat(10),
    listTools,
    close: () => {
      onClose();
      return Promise.resolve();
    },
  } as unknown as Client;
}

/** 讓已排進佇列的 promise 回呼都跑完。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('connectGeneration 交出 close 訊號', () => {
  it('連上之後才拋：已經交出 closed，等到 SDK 的 onclose 才落定', async () => {
    const sdk = fakeClient();
    let closed: Promise<void> | undefined;
    await expect(
      connectGeneration(
        () => Promise.resolve(sdk),
        config,
        false,
        (signal) => {
          closed = signal;
        },
      ),
    ).rejects.toThrow('server instructions exceed maxInstructionBytes (40)');
    if (closed === undefined) throw new Error('沒有交出 closed');
    expect(await settled(closed)).toBe(false);
    sdk.onclose?.();
    expect(await settled(closed)).toBe(true);
  });

  it('握手就失敗：沒有連上的 client，不交出任何東西', async () => {
    let called = false;
    await expect(
      connectGeneration(
        () => Promise.reject(new Error('handshake failed')),
        config,
        false,
        () => {
          called = true;
        },
      ),
    ).rejects.toThrow('handshake failed');
    expect(called).toBe(false);
  });

  it('連上之後 tools/list 才拋：已經交出 closed，錯誤句帶 server 名字', async () => {
    let closed: Promise<void> | undefined;
    await expect(
      connectGeneration(
        () => Promise.resolve(fakeClient(undefined, () => Promise.reject(new Error('boom')))),
        config,
        false,
        (signal) => {
          closed = signal;
        },
      ),
    ).rejects.toThrow('Failed to load tools from server "srv": Error: boom');
    expect(closed).toBeDefined();
  });
});

/** `promise` 目前落定了沒（先讓佇列跑完）。 */
async function settled(promise: Promise<void>): Promise<boolean> {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  await flush();
  return done;
}

describe('attemptsOn 的 abandon', () => {
  it('嘗試在連上之後才失敗：先關那次開的 client，再等到它的 onclose 才落定', async () => {
    let closes = 0;
    const sdk = fakeClient(() => {
      closes += 1;
    });
    const attempts = attemptsOn(config, false, new Map(), (track) => {
      track(sdk);
      return Promise.resolve(sdk);
    });
    await expect(attempts.connect()).rejects.toThrow('maxInstructionBytes');
    closes = 0;

    const abandoning = attempts.abandon();
    expect(await settled(abandoning)).toBe(false);
    expect(closes).toBe(1);
    sdk.onclose?.();
    expect(await settled(abandoning)).toBe(true);
  });

  it('每次嘗試重新記：上一次的子行程還沒關，這一次握手就失敗，不去等上一次的', async () => {
    let handshake = true;
    const attempts = attemptsOn(config, false, new Map(), (track) => {
      if (!handshake) return Promise.reject(new Error('handshake failed'));
      const sdk = fakeClient();
      track(sdk);
      return Promise.resolve(sdk);
    });
    await expect(attempts.connect()).rejects.toThrow('maxInstructionBytes');
    handshake = false;
    await expect(attempts.connect()).rejects.toThrow('handshake failed');
    expect(await settled(attempts.abandon())).toBe(true);
  });
});
