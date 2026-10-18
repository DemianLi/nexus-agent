/**
 * serve 行程裡的 thread 數上限（[#1476](https://github.com/DemianLi/nexus-agent/issues/1476)，保險絲第 2 級）：
 * `threadFor` 在 `threads.get` 沒命中之後、`createAgent` 之前比 `threads.size`。
 *
 * 這一檔用**真的 wire handler＋真的最小 agent**（`createNexusAgent`＋腳本模型），`createAgent` 換成可控的閘門，
 * 問的是計數的語意（驗收 A–E）：數 `threads.size` 含建構中、建失敗釋放、同 id 並行只佔一個、拒收不呼叫 `createAgent`。
 * 從 serve 組裝起的接線在 `serve-thread-capacity.test.ts`（驗收 F）。
 *
 * 偏離登記：thread 數上限是「產品需求超出 dsh」，見 `settings/thread-capacity.ts` 的檔頭。
 */

import { createWireClient, historyPath, THREAD_AT_CAPACITY, THREADS_PATH } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { emptyCommandPoint, foldTurn, loopbackRequest, TEST_BROWSER_AUTH } from './fixtures.js';
import { PrunedMemorySaver } from './pruned-memory-saver.js';
import { ScriptedChatModel } from './scripted-model.js';
import { composeAttachSessions } from './session-attach.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';
import type { ThreadAgent, WireHandlerOptions } from './wire-handler.js';

const BASE = 'http://capacity.test';
const JSON_HEADERS = { 'content-type': 'application/json' };

/** 一條 thread 的 agent：真的最小 agent，說一句「好」就收。 */
async function realAgent(): Promise<ThreadAgent> {
  const built = await createNexusAgent({
    model: new ScriptedChatModel({ turns: [{ content: '好' }] }),
    checkpointer: new PrunedMemorySaver(),
    plugins: [],
  });
  return {
    agent: built.agent as unknown as PumpAgent,
    commands: emptyCommandPoint(),
    attachSessions: composeAttachSessions(built),
    dispose: built.dispose,
  };
}

/** 可以手動放行或讓它失敗的一道閘。 */
interface Gate {
  readonly promise: Promise<void>;
  open(): void;
  fail(reason: Error): void;
}

function gate(): Gate {
  let open: () => void = () => undefined;
  let fail: (reason: Error) => void = () => undefined;
  const promise = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  // 沒人等的閘失敗時不要變成沒人接的 rejection。
  promise.catch(() => undefined);
  return { promise, open, fail };
}

interface Rig {
  readonly handler: ReturnType<typeof createWireHandler>;
  /** `createAgent` 被叫過的 thread id，照順序。 */
  readonly calls: string[];
  /** 講過的話，照順序。 */
  readonly warnings: string[];
  /** 這些 thread 的閘；沒登記的 thread 直接建。 */
  readonly gates: Map<string, Gate>;
}

function rig(maxThreads: number | undefined, extra: Partial<WireHandlerOptions> = {}): Rig {
  const calls: string[] = [];
  const warnings: string[] = [];
  const gates = new Map<string, Gate>();
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    ...(maxThreads === undefined ? {} : { maxThreads }),
    warn: (message) => warnings.push(message),
    createAgent: async (threadId) => {
      calls.push(threadId);
      await gates.get(threadId)?.promise;
      return realAgent();
    },
    ...extra,
  });
  return { handler, calls, warnings, gates };
}

interface Outcome {
  readonly type: string;
  readonly error?: string;
  readonly message?: string;
}

/** 讀一條 thread 的歷史：會經 `threadFor`，是不用跑模型就能叫一條 thread 組起來的最短路。 */
async function touch(r: Rig, thread: string): Promise<Outcome> {
  const response = await r.handler.handle(
    loopbackRequest(`${BASE}${historyPath(thread)}`, { method: 'GET', headers: JSON_HEADERS }),
  );
  return (await response.json()) as Outcome;
}

/** 等到 `createAgent` 被叫過 n 次。 */
async function untilCalls(r: Rig, n: number): Promise<void> {
  for (let i = 0; i < 200 && r.calls.length < n; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(r.calls).toHaveLength(n);
}

describe('thread 數上限（#1476）', () => {
  it('A：上限 N，第 N 條建得起來，第 N+1 條回專用碼；createAgent 只被叫 N 次，拒收不留痕跡', async () => {
    const r = rig(2);
    expect((await touch(r, 't1')).type).toBe('success');
    expect((await touch(r, 't2')).type).toBe('success');

    const refused = await touch(r, 't3');
    expect(refused).toMatchObject({ type: 'error', error: THREAD_AT_CAPACITY });
    // 專用碼、不加「這條 thread 建不起來」的前綴；message 寫出上限與下一步。
    expect(refused.message).not.toContain('建不起來');
    expect(refused.message).toContain('2／2');
    expect(refused.message).toContain('重啟');
    expect(r.calls).toEqual(['t1', 't2']);

    // 拒收不留紀錄：再來一次還是被拒、還是沒叫 createAgent（`threads` 上沒有 t3，否則第二次會命中它）。
    expect(await touch(r, 't3')).toMatchObject({ type: 'error', error: THREAD_AT_CAPACITY });
    expect(r.calls).toEqual(['t1', 't2']);
  });

  it('A：已在行程裡的 thread 不受影響，滿了照常讀', async () => {
    const r = rig(1);
    expect((await touch(r, 't1')).type).toBe('success');
    expect((await touch(r, 'other')).error).toBe(THREAD_AT_CAPACITY);
    expect((await touch(r, 't1')).type).toBe('success');
    expect(r.calls).toEqual(['t1']);
  });

  it('每次拒收講一行：含 thread、目前數量與上限', async () => {
    const r = rig(1);
    await touch(r, 't1');
    expect(r.warnings).toEqual([]);
    await touch(r, 'x');
    await touch(r, 'y');
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings[0]).toContain('"x"');
    expect(r.warnings[0]).toMatch(/已有 1 條.*上限 1/u);
    expect(r.warnings[1]).toContain('"y"');
  });

  it('B：拒收之後，前 N 條照常能跑一輪', async () => {
    const r = rig(2);
    const client = createWireClient({
      baseUrl: BASE,
      fetch: async (input, init) => r.handler.handle(loopbackRequest(input as string, init)),
    });
    const e1 = await client.openEvents('t1');
    const e2 = await client.openEvents('t2');
    await expect(client.openEvents('t3')).rejects.toThrow();
    expect(await touch(r, 't3')).toMatchObject({ error: THREAD_AT_CAPACITY });

    for (const [thread, events] of [
      ['t1', e1],
      ['t2', e2],
    ] as const) {
      expect((await client.runStart(thread, '說一句')).type).toBe('success');
      const state = await foldTurn(events);
      expect(JSON.stringify(state)).toContain('好');
      await events.return?.(undefined);
    }
    expect(r.calls).toEqual(['t1', 't2']);
  });

  it('C：建構中佔名額；其中一條建失敗後名額釋放，下一條建得起來', async () => {
    const r = rig(2);
    r.gates.set('t1', gate());
    r.gates.set('t2', gate());
    const p1 = touch(r, 't1');
    const p2 = touch(r, 't2');
    await untilCalls(r, 2);

    // N 條都卡在 createAgent：第 N+1 條被拒，而且沒叫 createAgent。
    expect(await touch(r, 't3')).toMatchObject({ type: 'error', error: THREAD_AT_CAPACITY });
    expect(r.calls).toEqual(['t1', 't2']);

    // t1 建失敗 → 從表上刪掉 → 名額回來。
    r.gates.get('t1')?.fail(new Error('模擬建構失敗'));
    const failed = await p1;
    expect(failed).toMatchObject({ type: 'error', error: 'unknown_error' });
    expect(failed.message).toContain('模擬建構失敗');

    expect((await touch(r, 't3')).type).toBe('success');
    // t2 仍在建構中、t3 已建好 → 又滿了。
    expect(await touch(r, 't4')).toMatchObject({ error: THREAD_AT_CAPACITY });
    r.gates.get('t2')?.open();
    expect((await p2).type).toBe('success');
    expect(r.calls).toEqual(['t1', 't2', 't3']);
  });

  it('D：同一個新 id 的兩個並行請求只佔一個名額', async () => {
    const r = rig(2);
    r.gates.set('t1', gate());
    const a = touch(r, 't1');
    const b = touch(r, 't1');
    await untilCalls(r, 1);
    // 另一個 id 還進得來（t1 只佔一個），第三個 id 才被拒。
    expect((await touch(r, 't2')).type).toBe('success');
    expect(await touch(r, 't3')).toMatchObject({ error: THREAD_AT_CAPACITY });
    r.gates.get('t1')?.open();
    expect((await a).type).toBe('success');
    expect((await b).type).toBe('success');
    expect(r.calls).toEqual(['t1', 't2']);
  });

  it('E：沒設上限就是不限，行為與沒有這個選項一樣', async () => {
    const r = rig(undefined);
    for (const thread of ['a', 'b', 'c', 'd', 'e']) {
      expect((await touch(r, thread)).type).toBe('success');
    }
    expect(r.calls).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(r.warnings).toEqual([]);
  });

  it('不經 threadFor 的路（列表）在滿了之後不受影響', async () => {
    const r = rig(1, { listThreads: async () => ({ items: [], unreadable: 0 }) });
    await touch(r, 't1');
    expect(await touch(r, 't2')).toMatchObject({ error: THREAD_AT_CAPACITY });
    const listed = await r.handler.handle(
      loopbackRequest(`${BASE}${THREADS_PATH}`, { method: 'GET', headers: JSON_HEADERS }),
    );
    expect(((await listed.json()) as Outcome).type).toBe('success');
  });
});

describe('threadCount：記憶體警告寫的「現在幾條」（#1493）', () => {
  it('跟 threadFor 檢查上限用的同一個數：建構中的算，建失敗放掉，已建好的不重複算', async () => {
    const r = rig(5);
    expect(r.handler.threadCount()).toBe(0);
    r.gates.set('t1', gate());
    const building = touch(r, 't1');
    await untilCalls(r, 1);
    // 還在 createAgent：已經佔著名額，數得到。
    expect(r.handler.threadCount()).toBe(1);
    r.gates.get('t1')?.fail(new Error('模擬建構失敗'));
    await building;
    expect(r.handler.threadCount()).toBe(0);

    expect((await touch(r, 't2')).type).toBe('success');
    expect((await touch(r, 't3')).type).toBe('success');
    expect(r.handler.threadCount()).toBe(2);
    // 已在行程裡的 thread 再碰一次不會多算。
    expect((await touch(r, 't2')).type).toBe('success');
    expect(r.handler.threadCount()).toBe(2);
  });
});
