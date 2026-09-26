/**
 * 產品路徑上的 `GET /threads`——[#302](https://github.com/DemianLi/nexus-agent/issues/302)。
 *
 * 讀得對不對在 [`session-list.test.ts`](./session-list.test.ts)；這一檔問的是只有產品路徑上量得到的：
 *
 * 1. **列表一條 agent 都不建。** 量具是遙測披露那一行：`serve.ts` 只在**第一次 `createAgent`** 時印它
 *    （那一刻之前沒有人知道有沒有掛後端）。每一條都先證明量具會動——列完之後切過去一次，那一行就出現。
 * 2. **不拿寫租約。** 別的把手握著那一份時，續接會拋；列表照樣列得出來。
 * 3. **列出來的切得過去**，而且接回來的是那一份日誌，不是新開。
 */

import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { THREADS_PATH, createWireClient } from '@nexus/wire';
import type { ThreadListOutcome } from '@nexus/wire';
import type { SessionEvent } from '@nexus/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  exchangeServeToken,
  fetchWithCookie,
  foldTurn,
  loopbackRequest,
  serveClient,
  TEST_BROWSER_AUTH,
} from './fixtures.js';
import { openJsonlSessionStore, projectKey } from './jsonl-session-store.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';

let running: RunningServe | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'nexus-serve-list-'));
}

/** `root` 省略即不給 `--session-log`。 */
async function start(root: string | undefined, lines: string[] = []): Promise<RunningServe> {
  running = await runServe({
    argv: ['--port', '0', ...(root === undefined ? [] : ['--session-log', root])],
    log: (line) => lines.push(line),
    env: {},
  });
  return running as RunningServe;
}

async function stop(server: RunningServe): Promise<void> {
  await server.close();
  running = undefined;
}

/** 跑完一整輪。同 `serve-session-log.test.ts` 那一份。 */
async function driveTurn(server: RunningServe, threadId: string, prompt: string): Promise<void> {
  const client = await serveClient(server);
  const events = await client.openEvents(threadId);
  await client.runStart(threadId, prompt);
  await foldTurn(events);
  await events.return?.(undefined);
}

async function list(server: RunningServe): Promise<ThreadListOutcome> {
  return (await serveClient(server)).listThreads();
}

/** 這台 server 建過 agent 沒有。見檔頭第 1 件。 */
function agentBuilt(lines: readonly string[]): boolean {
  return lines.some((line) => line.startsWith('遙測：'));
}

function readEvents(body: string): readonly SessionEvent[] {
  return body
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SessionEvent);
}

describe('GET /threads', () => {
  it('重開之後列得出以前的 thread：由新到舊、標題是第一句話，列表一條 agent 都不建', async () => {
    const root = await tmp();
    const first = await start(root);
    await driveTurn(first, 'alpha', '先開的那條');
    await driveTurn(first, 'beta', '後開的那條');
    await stop(first);

    const lines: string[] = [];
    const second = await start(root, lines);
    const listed = await list(second);
    expect(listed).toEqual({
      kind: 'ok',
      result: {
        unreadable: 0,
        items: [
          expect.objectContaining({
            threadId: 'beta',
            title: '後開的那條',
            running: false,
            blank: false,
          }),
          expect.objectContaining({
            threadId: 'alpha',
            title: '先開的那條',
            running: false,
            blank: false,
          }),
        ],
      },
    });
    expect(agentBuilt(lines)).toBe(false);

    // 量具會動：切過去一次，agent 就建了。
    await driveTurn(second, 'alpha', '接著講');
    expect(agentBuilt(lines)).toBe(true);
    // 標題還是第一句；剛講過話的那條排到最前面。
    const again = await list(second);
    expect(
      again.kind === 'ok' && again.result.items.map((item) => [item.threadId, item.title]),
    ).toEqual([
      ['alpha', '先開的那條'],
      ['beta', '後開的那條'],
    ]);
    await stop(second);

    // 切過去接的是那一份：同一個檔接著寫，中間一顆 end-seed。
    const events = readEvents(
      await readFile(join(root, projectKey(process.cwd()), 'alpha.jsonl'), 'utf8'),
    );
    expect(events.filter((event) => event.type === 'turn/start')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'session/end-seed')).toHaveLength(1);
  });

  it('別的把手握著那一份：照樣列得出來，也沒有建 agent', async () => {
    const root = await tmp();
    const first = await start(root);
    await driveTurn(first, 'alpha', '握著的那條');
    await stop(first);
    const holder = await openJsonlSessionStore({
      directory: join(root, projectKey(process.cwd())),
    }).resume('alpha');

    try {
      const lines: string[] = [];
      const second = await start(root, lines);
      const listed = await list(second);
      expect(listed.kind === 'ok' && listed.result.items.map((item) => item.threadId)).toEqual([
        'alpha',
      ]);
      expect(agentBuilt(lines)).toBe(false);
      // 對照組：真的去接，撞上握著的把手。
      await expect(driveTurn(second, 'alpha', '接不回來')).rejects.toThrow();
      await stop(second);
    } finally {
      await holder.stored.close();
    }
  });

  /**
   * **翻面來的**（#444）：以前沒給旗標就只在記憶體裡、列表講「列不出來」。預設落盤之後，零設定的
   * serve 重開也列得出上一次的 thread——web 那端看到的差別就是這一條。
   */
  it('沒給 --session-log：預設落在 harness home，重開之後照樣列得出來', async () => {
    const first = await start(undefined);
    await driveTurn(first, 'alpha', '零設定那條');
    await stop(first);

    const second = await start(undefined);
    const listed = await list(second);
    expect(listed.kind === 'ok' && listed.result.items.map((item) => item.threadId)).toEqual([
      'alpha',
    ]);
  });

  it('組裝時沒接落盤（手搭的 handler）：講「列不出來」，不是一份空清單', async () => {
    const handler = createWireHandler({
      auth: TEST_BROWSER_AUTH,
      createAgent: async () => {
        throw new Error('列表不該建 agent');
      },
    });
    const wireFetch: typeof globalThis.fetch = async (input, init) =>
      handler.handle(loopbackRequest(input as string, init));
    const client = createWireClient({ baseUrl: 'http://wire.test', fetch: wireFetch });
    try {
      const listed = await client.listThreads();
      expect(listed.kind).toBe('rejected');
      expect(listed.kind === 'rejected' && listed.message).toContain('沒接落盤');
    } finally {
      await handler.close();
    }
  });

  it('還沒有任何 thread：一份空清單', async () => {
    const server = await start(await tmp());
    expect(await list(server)).toEqual({ kind: 'ok', result: { items: [], unreadable: 0 } });
  });

  /**
   * **`GET` 也要帶 JSON 的 content-type**：不帶就是一個不發 preflight 的跨來源 simple request，而這份回應是
   * 每一條 thread 第一句話的開頭（`THREADS_PATH` 的說明）。
   */
  it('載體層：沒帶或帶 simple request 認得的 content-type 是 415，別的 method 是 404', async () => {
    const server = await start(await tmp());
    // 沒有會話 cookie 的話連 415 都輪不到：401 排在媒體型別閘門之前（#424）。
    expect((await fetch(`${server.url}${THREADS_PATH}`)).status).toBe(401);
    const authed = fetchWithCookie(await exchangeServeToken(server.authenticatedUrl));
    expect((await authed(`${server.url}${THREADS_PATH}`)).status).toBe(415);
    // `text/plain` 是 CORS 放行、不發 preflight 的三個值之一：擋得住它，閘門才不是裝飾。
    expect(
      (await authed(`${server.url}${THREADS_PATH}`, { headers: { 'content-type': 'text/plain' } }))
        .status,
    ).toBe(415);
    expect(
      (
        await authed(`${server.url}${THREADS_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await authed(`${server.url}${THREADS_PATH}`, {
          headers: { 'content-type': 'application/json' },
        })
      ).status,
    ).toBe(200);
  });
});

/**
 * `running` 那一格。**產品路徑上量不到**：假模型一輪當場跑完，列表打過去的時候早就停了。所以換一顆停在半路的
 * agent，走同一個 handler——標記來自 handler 手上活著的 thread，跟 serve 怎麼組裝無關。
 */
describe('running 標記', () => {
  it('正在跑的那條標 running，沒開過的不標，也不為了標記去建它', async () => {
    let created = 0;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent: PumpAgent = {
      // 一顆事件都不吐，放行之前停在第一個 `next()`。
      streamEvents: async () => ({
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            await held;
            return { done: true as const, value: undefined };
          },
        }),
      }),
      getState: async () => ({ values: {} }),
      updateState: async () => undefined,
    };
    const handler = createWireHandler({
      auth: TEST_BROWSER_AUTH,
      createAgent: async () => {
        created += 1;
        return {
          agent,
          commands: { find: () => undefined, list: () => [] },
          dispose: async () => undefined,
        };
      },
      listThreads: async () => ({
        unreadable: 0,
        items: [
          { threadId: 'busy', updatedAt: 2, blank: false, title: '跑著的' },
          { threadId: 'cold', updatedAt: 1, blank: false, title: '沒開過的' },
        ],
      }),
    });
    const wireFetch: typeof globalThis.fetch = async (input, init) =>
      handler.handle(loopbackRequest(input as string, init));
    const client = createWireClient({ baseUrl: 'http://wire.test', fetch: wireFetch });

    try {
      await client.runStart('busy', '開始跑');
      await vi.waitFor(async () => {
        const listed = await client.listThreads();
        expect(
          listed.kind === 'ok' && listed.result.items.map((item) => [item.threadId, item.running]),
        ).toEqual([
          ['busy', true],
          ['cold', false],
        ]);
      });
      expect(created).toBe(1);

      release();
      await vi.waitFor(async () => {
        const listed = await client.listThreads();
        expect(listed.kind === 'ok' && listed.result.items[0]?.running).toBe(false);
      });
      expect(created).toBe(1);
    } finally {
      release();
      await handler.close();
    }
  });
});
