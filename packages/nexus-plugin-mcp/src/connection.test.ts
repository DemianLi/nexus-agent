/**
 * 失敗的嘗試等得到子行程關掉（[#1835](https://github.com/DemianLi/nexus-agent/issues/1835)）：{@link connectGeneration} 交出 close 訊號、
 * {@link attemptsOn} 的 `abandon` 等它。用假的 adapter client，不起子行程。實殺子行程的那兩條（`reconnect.test.ts`、`pool.test.ts`）
 * 分不出 `abandon` 有沒有等——`client.close()` 本身就收得掉子行程；這裡釘的是「等」的那一半。
 */

import type { MultiServerMCPClient } from '@langchain/mcp-adapters';
import { describe, expect, it } from 'vitest';
import { attemptsOn, connectGeneration } from './connection.js';
import type { SdkClient } from './connection.js';
import { mcpConfigSchema } from './index.js';

const config = mcpConfigSchema.parse({
  serverName: 'srv',
  connection: { transport: 'stdio', command: 'unused' },
  maxInstructionBytes: 40,
});

/** 一個假的 SDK client：指引加上 server 署名後超過 40 位元組，所以 `connectGeneration` 在拿到它之後才拋。 */
function fakeSdk(): SdkClient {
  return {
    getInstructions: () => '字'.repeat(10),
    listTools: () => Promise.resolve({ tools: [] }),
    listResources: () => Promise.resolve({}),
    listResourceTemplates: () => Promise.resolve({}),
    readResource: () => Promise.resolve({}),
  };
}

function fakeClient(
  getTools: () => Promise<unknown[]>,
  sdk: () => SdkClient | undefined,
  onClose: () => void = () => {},
): MultiServerMCPClient {
  return {
    getTools,
    getClient: () => Promise.resolve(sdk()),
    close: () => {
      onClose();
      return Promise.resolve();
    },
  } as unknown as MultiServerMCPClient;
}

/** 讓已排進佇列的 promise 回呼都跑完。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('connectGeneration 交出 close 訊號', () => {
  it('拿到 SDK client 之後才拋：已經交出 closed，等到 SDK 的 onclose 才落定', async () => {
    const sdk = fakeSdk();
    let closed: Promise<void> | undefined;
    await expect(
      connectGeneration(
        fakeClient(
          () => Promise.resolve([]),
          () => sdk,
        ),
        config,
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

  it('握手就失敗（tools/list 拋）：拿不到 SDK client，不交出任何東西', async () => {
    let called = false;
    await expect(
      connectGeneration(
        fakeClient(() => Promise.reject(new Error('handshake failed')), fakeSdk),
        config,
        () => {
          called = true;
        },
      ),
    ).rejects.toThrow('handshake failed');
    expect(called).toBe(false);
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
  it('嘗試在拿到 SDK client 之後才失敗：先關整個 client，再等到那次的 onclose 才落定', async () => {
    const sdk = fakeSdk();
    let closes = 0;
    const attempts = attemptsOn(
      fakeClient(
        () => Promise.resolve([]),
        () => sdk,
        () => {
          closes += 1;
        },
      ),
      config,
    );
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
    const attempts = attemptsOn(
      fakeClient(
        () => (handshake ? Promise.resolve([]) : Promise.reject(new Error('handshake failed'))),
        fakeSdk,
      ),
      config,
    );
    await expect(attempts.connect()).rejects.toThrow('maxInstructionBytes');
    handshake = false;
    await expect(attempts.connect()).rejects.toThrow('handshake failed');
    expect(await settled(attempts.abandon())).toBe(true);
  });
});
