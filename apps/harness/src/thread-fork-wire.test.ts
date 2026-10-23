/**
 * `thread.fork`（[#1580](https://github.com/DemianLi/nexus-agent/issues/1580) 刀 2）：wire 這一層。
 *
 * 照 dsh `session.fork`：讀來源（活的讀記憶體、不在就冷讀）、換算切點、帶 seed 建子 thread、回新 id。這一檔問的是 handler 的判斷順序、
 * 名額、讀活的、清佇列；真落盤、列表、重啟在 `serve-thread-fork.test.ts`（真 `runServe`）。
 *
 * **零憑證、零外部連線**：agent 是空殼，冷讀由測試給。
 */

import { mkdtemp, open, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AIMessage } from '@langchain/core/messages';
import { afterEach, describe, expect, it } from 'vitest';

import {
  attachSessionPersistence,
  inheritedEventCount,
  SESSION_LOG_FORMAT_VERSION,
  SessionLog,
  toLoggedMessage,
} from '@nexus/core';
import type {
  ColdStoredSession,
  SessionEvent,
  SessionRegistry,
  SessionStore,
  StoredSession,
  StoredSessionHeader,
} from '@nexus/core';
import { createWireClient, THREAD_AT_CAPACITY } from '@nexus/wire';

import { emptyCommandPoint, loopbackRequest, TEST_BROWSER_AUTH } from './fixtures.js';
import { openJsonlSessionStore } from './jsonl-session-store.js';
import type { LogFileHandle, OpenLogFile } from './jsonl-session-store.js';
import { findSession } from './session-files.fixture.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';
import type { ThreadForkSeed, WireHandler } from './wire-handler.js';

const opened: WireHandler[] = [];
const temporary: string[] = [];

afterEach(async () => {
  for (const handler of opened.splice(0)) await handler.close();
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

type HandlerOptions = Parameters<typeof createWireHandler>[0];

function reply(id: string, text: string) {
  return toLoggedMessage(new AIMessage({ content: text, id }));
}

function header(id: string): StoredSessionHeader {
  return { version: SESSION_LOG_FORMAT_VERSION, id, createdAt: 1, cwd: '/w' };
}

/** 來源：兩輪，回覆 `m1`、`m2`。`thirdOpen` 時再開第三輪、回覆 `m3`、還沒收。 */
function sourceEvents(options: { thirdOpen?: boolean } = {}): SessionEvent[] {
  const log = new SessionLog('src');
  log.append('turn/start', { kind: 'message', text: '一' });
  log.append('assistant/message', { message: reply('m1', '好') });
  log.append('turn/end', {});
  log.append('turn/start', { kind: 'message', text: '二' });
  log.append('assistant/message', { message: reply('m2', '好') });
  log.append('turn/end', {});
  if (options.thirdOpen === true) {
    log.append('turn/start', { kind: 'message', text: '三' });
    log.append('assistant/message', { message: reply('m3', '寫到一半') });
  }
  return [...log.events];
}

function cold(id: string, events: readonly SessionEvent[]): ColdStoredSession {
  return { header: header(id), storedFormatVersion: SESSION_LOG_FORMAT_VERSION, events };
}

interface Rig {
  readonly forks: { readonly threadId: string; readonly fork: ThreadForkSeed }[];
  /** 子 thread 的落盤接線收掉（`dispose`，關把手）幾次。 */
  disposedPersistence: number;
}

function rig(
  options: Partial<Omit<HandlerOptions, 'auth'>> & {
    readonly seeds?: Readonly<Record<string, readonly SessionEvent[]>>;
    /** 前幾次分叉的組裝要失敗。 */
    readonly failForks?: number;
    /** 前幾次分叉的第一次排空要失敗（寫不進磁碟）。 */
    readonly failFlushes?: number;
    /** 哪一條 thread 的日誌被排空了一次。 */
    readonly onFlush?: (threadId: string) => void;
  } = {},
) {
  const record: Rig = { forks: [], disposedPersistence: 0 };
  let next = 0;
  let flushes = 0;
  const { seeds, failForks = 0, failFlushes = 0, onFlush, ...rest } = options;
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    newThreadId: () => `child-${String((next += 1))}`,
    createAgent: async (threadId: string, fork?: ThreadForkSeed) => {
      if (fork !== undefined) {
        record.forks.push({ threadId, fork });
        if (record.forks.length <= failForks) throw new Error('組裝失敗');
      }
      const rootSeed = fork?.seed ?? seeds?.[threadId];
      return {
        agent: {} as PumpAgent,
        commands: emptyCommandPoint(),
        dispose: async () => {},
        attachSessions: () => ({ detach: async () => {} }),
        ...(rootSeed !== undefined && { rootSeed }),
        // 落盤替身：排空走 `sessions.onFlush`，同 `attachSessionPersistence` 的接法。只有子 thread 的會失敗、記收掉幾次。
        attachPersistence: (sessions: SessionRegistry) => {
          const off = sessions.onFlush(async () => {
            onFlush?.(threadId);
            if (fork === undefined) return;
            flushes += 1;
            if (flushes <= failFlushes) throw new Error('磁碟滿了');
          });
          return {
            flush: async () => {},
            dispose: async () => {
              if (fork !== undefined) record.disposedPersistence += 1;
              off();
            },
          };
        },
      };
    },
    ...rest,
  });
  opened.push(handler);
  const fetch = async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
    handler.handle(loopbackRequest(input as string, init));
  const client = createWireClient({ baseUrl: 'http://fork.test', fetch });
  let nextId = 1;
  const raw = async (thread: string, method: string, params?: unknown) => {
    const response = await fetch(`http://fork.test/threads/${thread}/commands/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: nextId++, method, ...(params !== undefined && { params }) }),
    });
    return (await response.json()) as Record<string, unknown>;
  };
  return { handler, client, raw, record };
}

/** 前 `failAppends` 次 `append` 直接拋錯、不交給真的把手（所以不會實體化）；其餘照真的 jsonl store。 */
function flakyStore(inner: SessionStore, failAppends: number): SessionStore {
  let left = failAppends;
  const wrap = (stored: StoredSession): StoredSession =>
    new Proxy(stored, {
      get(target, key) {
        if (key === 'append') {
          return async (events: readonly SessionEvent[]) => {
            if (left > 0) {
              left -= 1;
              throw new Error('磁碟滿了');
            }
            await target.append(events);
          };
        }
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    });
  return new Proxy(inner, {
    get(target, key) {
      if (key === 'create') return (header: StoredSessionHeader) => wrap(target.create(header));
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
}

/**
 * 開日誌照真的開（header 已經發佈、日誌已經 `wx` 建出來），**第一個新日誌把手的第一次 `writeFile`** 才拋 ENOSPC：
 * 這才是「實體化了、第一批寫不進去」（#1580 刀 2a 審查 B1）。
 */
function firstLogWriteFails(): OpenLogFile {
  let left = 1;
  return async (path, flags, mode) => {
    const handle = await open(path, flags, mode);
    if (flags !== 'wx') return handle as unknown as LogFileHandle;
    return new Proxy(handle, {
      get(target, key) {
        if (key === 'writeFile' && left > 0) {
          return async () => {
            left -= 1;
            throw Object.assign(new Error('ENOSPC: no space left on device, write'), {
              code: 'ENOSPC',
            });
          };
        }
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    }) as unknown as LogFileHandle;
  };
}

/**
 * 第一次 `open(<日誌>, 'wx')` 就拋 EMFILE：header 已經 `link` 發佈、日誌沒開成，實體化在寫入之前就失敗（#1580 刀 2a 審查）。
 * 之後照真的開。
 */
function firstLogOpenFails(): OpenLogFile {
  let left = 1;
  return async (path, flags, mode) => {
    if (flags === 'wx' && left > 0) {
      left -= 1;
      throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
    }
    return (await open(path, flags, mode)) as unknown as LogFileHandle;
  };
}

/**
 * 子 thread 接**真的**落盤（`attachSessionPersistence`＋暫存目錄上的 jsonl store）：量「組裝失敗磁碟上不留檔」只能用真的，
 * 替身的 `dispose` 不排空，量不出收尾會不會把 seed 寫出去。
 */
async function realRig(options: {
  readonly failAppends?: number;
  readonly failTitles?: number;
  readonly openLog?: OpenLogFile;
}) {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-fork-real-'));
  temporary.push(directory);
  const store = flakyStore(
    openJsonlSessionStore({
      directory,
      ...(options.openLog !== undefined && { openLog: options.openLog }),
    }),
    options.failAppends ?? 0,
  );
  let titles = options.failTitles ?? 0;
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    // 每次都是同一個 id：失敗那一次要是在後端留下任何東西（pending、檔），重試的 `create` 就會撞上它。
    newThreadId: () => 'child',
    readStoredThread: async (id) => (id === 'src' ? cold('src', sourceEvents()) : undefined),
    maxThreads: 1,
    createAgent: async (_threadId: string, fork?: ThreadForkSeed) => ({
      agent: {} as PumpAgent,
      commands: emptyCommandPoint(),
      dispose: async () => {},
      attachSessions: () => ({ detach: async () => {} }),
      ...(fork !== undefined && { rootSeed: fork.seed }),
      attachPersistence: (sessions: SessionRegistry) =>
        attachSessionPersistence(sessions, store, {
          cwd: '/w',
          ...(fork !== undefined && {
            rootLineage: { parentSession: fork.sourceHeader.id, isSeeded: true },
          }),
        }),
      // 接上落盤之後、第一次排空之前會失敗的一步。
      attachTitle: () => {
        if (titles > 0) {
          titles -= 1;
          throw new Error('標題接不上');
        }
        return Object.assign(async () => {}, { busy: () => false });
      },
    }),
  });
  opened.push(handler);
  const fetch = async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
    handler.handle(loopbackRequest(input as string, init));
  return { directory, handler, client: createWireClient({ baseUrl: 'http://fork.test', fetch }) };
}

describe('thread.fork', () => {
  it('冷的來源：換算到指名那一輪的 turn/end，帶 seed 建子 thread、回新 id；來源不為它建 agent', async () => {
    const events = sourceEvents();
    const { client, record, handler } = rig({
      readStoredThread: async (id) => (id === 'src' ? cold('src', events) : undefined),
    });
    const outcome = await client.threadFork('src', 'm1');
    expect(outcome).toEqual({ kind: 'ok', result: { ok: true, value: { threadId: 'child-1' } } });
    expect(record.forks).toHaveLength(1);
    const { threadId, fork } = record.forks[0]!;
    expect(threadId).toBe('child-1');
    expect(fork.sourceHeader.id).toBe('src');
    // 第一輪是 seq 0–2：前綴照抄（seq 不改），接 inherited 標記。
    expect(fork.seed.slice(0, 3)).toEqual(events.slice(0, 3));
    expect(fork.seed[3]).toMatchObject({
      type: 'session/end-seed',
      seq: 3,
      data: { inherited: true },
    });
    expect(fork.seed).toHaveLength(4);
    expect(inheritedEventCount(fork.seed)).toBe(3);
    // 只有子 thread 在行程裡：冷的來源沒佔名額。
    expect(handler.threadCount()).toBe(1);
  });

  it('判斷順序：沒落盤 not_supported → 參數 invalid_argument → 看不到 thread_not_found → 分不出去 fork_unavailable', async () => {
    const bare = rig();
    expect(await bare.raw('src', 'thread.fork', { messageId: 'm1' })).toMatchObject({
      type: 'error',
      error: 'not_supported',
    });

    const { raw, client, record, handler } = rig({
      readStoredThread: async (id) => (id === 'src' ? cold('src', sourceEvents()) : undefined),
    });
    for (const params of [{}, { messageId: 3 }, { messageId: '' }]) {
      expect(await raw('src', 'thread.fork', params)).toMatchObject({
        type: 'error',
        error: 'invalid_argument',
      });
    }
    // 兩個條件同時不成立時，排在前面的那個贏：參數壞＋來源不存在 → 參數。
    expect(await raw('ghost', 'thread.fork', {})).toMatchObject({
      type: 'error',
      error: 'invalid_argument',
    });
    expect(await client.threadFork('ghost', 'm1')).toEqual({
      kind: 'ok',
      result: { ok: false, error: { code: 'thread_not_found' } },
    });
    expect(await client.threadFork('src', 'nope')).toEqual({
      kind: 'ok',
      result: { ok: false, error: { code: 'fork_unavailable' } },
    });
    expect(record.forks).toEqual([]);
    expect(handler.threadCount()).toBe(0);
  });

  it('那一輪失敗收尾、或還沒收尾：fork_unavailable，不建任何東西', async () => {
    const failed = new SessionLog('src');
    failed.append('turn/start', { kind: 'message', text: '一' });
    failed.append('assistant/message', { message: reply('m1', '先查') });
    failed.append('turn/failed', { message: '模型掛了' });
    const { client, record, handler } = rig({
      readStoredThread: async (id) =>
        id === 'failed'
          ? cold('failed', failed.events)
          : id === 'open'
            ? cold('open', sourceEvents({ thirdOpen: true }))
            : undefined,
    });
    expect(await client.threadFork('failed', 'm1')).toMatchObject({
      result: { ok: false, error: { code: 'fork_unavailable' } },
    });
    expect(await client.threadFork('open', 'm3')).toMatchObject({
      result: { ok: false, error: { code: 'fork_unavailable' } },
    });
    expect(record.forks).toEqual([]);
    expect(handler.threadCount()).toBe(0);
  });

  it('活的來源讀記憶體：尾巴還沒落盤時，冷讀那份沒有的那一輪也分得出去', async () => {
    const live = sourceEvents();
    // 冷讀只讀到第一輪（落盤有批次窗口，尾巴還在記憶體）。
    const onDisk = live.slice(0, 3);
    const { client, record } = rig({
      seeds: { src: live },
      readStoredThread: async (id) => (id === 'src' ? cold('src', onDisk) : undefined),
    });
    // 把來源開起來（經 `threadFor`，pump 的日誌從 seed 長出來）。
    const events = await client.openEvents('src');
    await events.return?.(undefined);
    expect(await client.threadFork('src', 'm2')).toMatchObject({
      result: { ok: true, value: { threadId: 'child-1' } },
    });
    // 切點是第二輪的 turn/end（seq 5），前綴是記憶體那一份。
    expect(inheritedEventCount(record.forks[0]!.fork.seed)).toBe(6);
  });

  it('活的來源還沒實體化（磁碟上沒有）：先排空它、讀得到 header，再讀記憶體', async () => {
    const live = sourceEvents();
    let materialized = false;
    const { client, record } = rig({
      seeds: { src: live },
      onFlush: (threadId) => {
        if (threadId === 'src') materialized = true;
      },
      // 排空之前磁碟上沒有這一條；排空之後 header 在，事件照落盤窗口還沒寫（空的）。
      readStoredThread: async (id) => (id === 'src' && materialized ? cold('src', []) : undefined),
    });
    const events = await client.openEvents('src');
    await events.return?.(undefined);
    expect(await client.threadFork('src', 'm2')).toMatchObject({
      result: { ok: true, value: { threadId: 'child-1' } },
    });
    expect(materialized).toBe(true);
    expect(inheritedEventCount(record.forks[0]!.fork.seed)).toBe(6);
  });

  it('名額滿：thread_at_capacity（協定層），不建子 thread、名額數不變', async () => {
    const { client, raw, record, handler } = rig({
      maxThreads: 1,
      seeds: { src: sourceEvents() },
      readStoredThread: async (id) => (id === 'src' ? cold('src', sourceEvents()) : undefined),
    });
    const events = await client.openEvents('src');
    await events.return?.(undefined);
    expect(handler.threadCount()).toBe(1);
    expect(await raw('src', 'thread.fork', { messageId: 'm1' })).toMatchObject({
      type: 'error',
      error: THREAD_AT_CAPACITY,
    });
    // 名額滿＋切不出來：切點在名額之前判，回 fork_unavailable，不是 thread_at_capacity。
    expect(await client.threadFork('src', 'nope')).toEqual({
      kind: 'ok',
      result: { ok: false, error: { code: 'fork_unavailable' } },
    });
    expect(record.forks).toEqual([]);
    expect(handler.threadCount()).toBe(1);
  });

  it('組裝失敗：回錯、名額回到原數；下一次照常佔得到', async () => {
    const options = {
      maxThreads: 1,
      readStoredThread: async (id: string) =>
        id === 'src' ? cold('src', sourceEvents()) : undefined,
    };
    const { raw, client, record, handler } = rig({ ...options, failForks: 1 });
    expect(await raw('src', 'thread.fork', { messageId: 'm1' })).toMatchObject({
      type: 'error',
      error: 'unknown_error',
    });
    expect(record.forks).toHaveLength(1);
    expect(handler.threadCount()).toBe(0);
    // 名額上限是 1：失敗那一次沒有還的話，這一次會是 thread_at_capacity。
    expect(await client.threadFork('src', 'm1')).toMatchObject({
      result: { ok: true, value: { threadId: 'child-2' } },
    });
    expect(handler.threadCount()).toBe(1);
  });

  it('第一次排空寫不進去：回錯、子 thread 收掉（關把手）不登記、名額回到原數；下一次照常', async () => {
    const { raw, client, record, handler } = rig({
      maxThreads: 1,
      failFlushes: 1,
      readStoredThread: async (id) => (id === 'src' ? cold('src', sourceEvents()) : undefined),
    });
    const refused = await raw('src', 'thread.fork', { messageId: 'm1' });
    expect(refused).toMatchObject({ type: 'error', error: 'unknown_error' });
    expect(String(refused['message'])).toContain('磁碟滿了');
    expect(record.disposedPersistence).toBe(1);
    expect(handler.threadCount()).toBe(0);
    expect(await client.threadFork('src', 'm1')).toMatchObject({
      result: { ok: true, value: { threadId: 'child-2' } },
    });
    expect(handler.threadCount()).toBe(1);
  });

  for (const [name, failure] of [
    ['接上落盤之後的一步失敗', () => ({ failTitles: 1 })],
    ['第一次排空在交給把手之前就被拒（還沒實體化）', () => ({ failAppends: 1 })],
    ['第一次排空實體化了、第一批寫不進去（B1）', () => ({ openLog: firstLogWriteFails() })],
    [
      '第一次排空實體化到一半（header 發佈了、日誌開不成）',
      () => ({ openLog: firstLogOpenFails() }),
    ],
  ] as const) {
    it(`真的落盤、${name}：磁碟上不留子 thread 的檔、名額回到原數；同一個 id 重試成功，檔才出現`, async () => {
      const { directory, handler, client } = await realRig(failure());
      const refused = await client.threadFork('src', 'm1');
      expect(refused).toMatchObject({ kind: 'rejected', code: 'unknown_error' });
      expect(handler.threadCount()).toBe(0);
      // 丟掉之後窗口不會再開：等過一個預設窗口（10ms）的好幾倍，還是沒有檔。
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await readdir(directory)).toEqual([]);

      const outcome = await client.threadFork('src', 'm1');
      if (outcome.kind !== 'ok' || !outcome.result.ok) throw new Error(JSON.stringify(outcome));
      expect(outcome.result.value.threadId).toBe('child');
      expect(handler.threadCount()).toBe(1);
      const child = await findSession(directory, 'child');
      expect(child?.header).toMatchObject({ parentSession: 'src', isSeeded: true });
    });
  }

  it('切點上還排著的件（Q2 (a)）：seed 在 inherited 標記之後補取消全部的 inbox/spliced', async () => {
    const log = new SessionLog('src');
    log.append('turn/start', { kind: 'message', text: '一' });
    log.append('assistant/message', { message: reply('m1', '好') });
    log.append('inbox/spliced', {
      target: 'next-turn',
      start: 0,
      inserted: [{ id: 'q1', text: '下一句', source: { kind: 'user' } }],
    });
    log.append('turn/end', {});
    const { client, record } = rig({
      readStoredThread: async (id) => (id === 'src' ? cold('src', log.events) : undefined),
    });
    expect(await client.threadFork('src', 'm1')).toMatchObject({ result: { ok: true } });
    const seed = record.forks[0]!.fork.seed;
    expect(seed.slice(-2).map((event) => event.type)).toEqual([
      'session/end-seed',
      'inbox/spliced',
    ]);
    expect(seed.at(-1)).toMatchObject({
      seq: seed.length - 1,
      data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' },
    });
    // 切點仍是那顆標記。
    expect(inheritedEventCount(seed)).toBe(4);
  });

  it('切點上 next-step 也還排著（Q2 (a)）：兩條各補一顆取消，不只清 next-turn', async () => {
    // `next-step` 的件在一輪收尾時可能還留著（`thread-pump.ts` 的 `#takeSteps`）。
    const log = new SessionLog('src');
    log.append('turn/start', { kind: 'message', text: '一' });
    log.append('assistant/message', { message: reply('m1', '好') });
    log.append('inbox/spliced', {
      target: 'next-step',
      start: 0,
      inserted: [
        { id: 's1', text: '順便看這個', source: { kind: 'user' } },
        { id: 's2', text: '還有這個', source: { kind: 'user' } },
      ],
    });
    log.append('inbox/spliced', {
      target: 'next-turn',
      start: 0,
      inserted: [{ id: 'q1', text: '下一句', source: { kind: 'user' } }],
    });
    log.append('turn/end', {});
    const { client, record } = rig({
      readStoredThread: async (id) => (id === 'src' ? cold('src', log.events) : undefined),
    });
    expect(await client.threadFork('src', 'm1')).toMatchObject({ result: { ok: true } });
    const seed = record.forks[0]!.fork.seed;
    const marker = seed.findIndex((event) => event.type === 'session/end-seed');
    const added = seed.slice(marker + 1);
    expect(added.map((event) => (event.data as { target: string }).target).sort()).toEqual([
      'next-step',
      'next-turn',
    ]);
    expect(
      added.find((event) => (event.data as { target: string }).target === 'next-step'),
    ).toMatchObject({
      data: { start: 0, removedCount: 2, inserted: [], outcome: 'canceled' },
    });
    expect(inheritedEventCount(seed)).toBe(marker);
  });
});
