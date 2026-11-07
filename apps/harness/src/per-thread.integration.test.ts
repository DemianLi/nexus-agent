/**
 * per-thread 整支跑起來（[#2341](https://github.com/DemianLi/nexus-agent/issues/2341)）：`serve.ts --process-model per-thread` 換成真的監督行程，
 * 它起前台與每條 thread 的對話行程，wire 從前台的 port 打。模型換成腳本（`scripted-serve.ts` 那份 patch），讀不到 `.env`。
 *
 * 只在 Linux 跑，`NEXUS_SUPERVISOR_BIN` 指到 `nexus-supervisor`；沒設就跳過。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMuxFetch, createWireClient, EMBED_PATH_PREFIX, WIRE_MUX_PATH } from '@nexus/wire';
import type { AiEntry, ConversationState, MuxSocket, WireClient } from '@nexus/wire';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { EMBED_AUDIT_FILE } from './embed-audit.js';
import { EMBED_IDENTITIES_FILE } from './embed-identities.js';
import { EMBED_EXCHANGE_PATH } from './embed-login.js';
import { EMBED_SESSION_PATH } from './embed-session.js';
import { exchangeServeToken, fetchWithCookie, foldTurn } from './fixtures.js';
import type { ScriptedTurn } from './scripted-model.js';
import { scriptedPatchText } from './scripted-serve.js';
import { signalPid } from './test-pids.fixture.js';

const SUPERVISOR = process.env.NEXUS_SUPERVISOR_BIN;
const SERVE = fileURLToPath(new URL('./serve.ts', import.meta.url));
const TSX = import.meta.resolve('tsx');
const SOURCE_PATHS =
  process.env.TSX_TSCONFIG_PATH === undefined
    ? {}
    : { TSX_TSCONFIG_PATH: process.env.TSX_TSCONFIG_PATH };
const AUTHENTICATED_URL = /http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/g;

interface Running {
  readonly child: ChildProcess;
  readonly port: number;
  /** harness home。 */
  readonly home: string;
  log(): string;
  /** 第 `n` 個（從 1 起）印出來的登入網址；前台重啟一次印一個新的。 */
  loginUrl(n: number): Promise<string>;
}

const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  }
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        resolve(typeof address === 'object' && address !== null ? address.port : 0),
      );
    });
  });
}

async function start(
  turns: readonly ScriptedTurn[],
  extraRows = '',
  prepareHome?: (home: string) => Promise<void>,
  supervisorArgs: readonly string[] = [],
): Promise<Running> {
  const dir = await mkdtemp(join(tmpdir(), 'nexus-per-thread-'));
  roots.push(dir);
  const patch = join(dir, 'script.patch.yml');
  // 監督行程的旗標由啟動器組，測試要加的經一支 `exec` 包裝：pid 不變，`childrenRunning` 照樣找得到子行程。
  let supervisorBinary = SUPERVISOR!;
  if (supervisorArgs.length > 0) {
    supervisorBinary = join(dir, 'supervisor-wrapper.sh');
    const quoted = [SUPERVISOR!, ...supervisorArgs].map((arg) => `'${arg}'`).join(' ');
    await writeFile(supervisorBinary, `#!/bin/sh\nexec ${quoted} "$@"\n`, { mode: 0o755 });
  }
  await writeFile(
    patch,
    scriptedPatchText(
      turns,
      `- id: process-model\n  config:\n    mode: per-thread\n    supervisorBinary: ${supervisorBinary}\n${extraRows}`,
    ),
    'utf8',
  );
  const home = join(dir, 'home');
  const harnessHome = join(home, 'harness-home');
  await mkdir(harnessHome, { recursive: true, mode: 0o700 });
  await prepareHome?.(harnessHome);
  const port = await freePort();
  const child = spawn(
    process.execPath,
    ['--import', TSX, SERVE, '--port', String(port), '--patch', patch],
    {
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        NEXUS_AGENT_HOME: harnessHome,
        ...SOURCE_PATHS,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.push(child);
  let log = '';
  const listeners = new Set<() => void>();
  const onData = (chunk: Buffer): void => {
    log += chunk.toString('utf8');
    for (const listener of listeners) listener();
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  return {
    child,
    port,
    home: harnessHome,
    log: () => log,
    loginUrl: (n) =>
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`60 秒內沒看到第 ${String(n)} 個登入網址：\n${log}`));
        }, 60_000);
        const check = (): void => {
          const found = [...log.matchAll(AUTHENTICATED_URL)][n - 1]?.[0];
          if (found === undefined) return;
          clearTimeout(timer);
          listeners.delete(check);
          resolve(found);
        };
        listeners.add(check);
        child.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`監督行程結束了（exit ${String(code)}）：\n${log}`));
        });
        check();
      }),
  };
}

async function clientOf(url: string): Promise<WireClient> {
  const cookie = await exchangeServeToken(url);
  return createWireClient({ baseUrl: new URL(url).origin, fetch: fetchWithCookie(cookie) });
}

/** 下行走 WebSocket mux（#2262，網頁預設的那條），其餘走 HTTP。 */
async function muxClientOf(url: string): Promise<WireClient> {
  const cookie = await exchangeServeToken(url);
  const { origin, host } = new URL(url);
  const socketUrl = `${origin.replace('http:', 'ws:')}${WIRE_MUX_PATH}`;
  return createWireClient({
    baseUrl: origin,
    fetch: fetchWithCookie(cookie),
    streamFetch: createMuxFetch({
      url: socketUrl,
      createSocket: (target) =>
        new WebSocket(target, { headers: { cookie, origin, host } }) as unknown as MuxSocket,
      fallback: () => Promise.reject(new Error('不該退回 SSE')),
    }),
  });
}

/** 監督行程（就是我們起的那個 pid，`execve` 換了程式不換 pid）底下，命令列含 `entry` 的子行程。 */
function childrenRunning(parent: number, entry: string): number[] {
  const found: number[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/u.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (ppid !== parent) continue;
      const cmdline = readFileSync(`/proc/${name}/cmdline`, 'utf8');
      if (cmdline.includes(entry)) found.push(Number(name));
    } catch {
      // 行程剛走。
    }
  }
  return found;
}

/** 監督行程預設補一個還沒綁 thread 的預熱行程（`--warm 1`）。 */
const WARM = 1;

/** 等到命令列含 `entry` 的子行程恰好 `count` 個（預熱池是背景補的），回它們。 */
async function settled(parent: number, entry: string, count: number): Promise<number[]> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const found = childrenRunning(parent, entry);
    if (found.length === count || Date.now() > deadline) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const replies = (state: ConversationState): string[] =>
  state.entries
    .filter((entry): entry is AiEntry => entry.kind === 'ai' && !entry.streaming)
    .map((entry) => entry.text);

async function turn(client: WireClient, thread: string, text: string): Promise<ConversationState> {
  const events = await client.openEvents(thread);
  await client.runStart(thread, text);
  const state = await foldTurn(events);
  await events.return?.(undefined);
  return state;
}

describe.skipIf(SUPERVISOR === undefined)('per-thread：監督行程、前台與對話行程', () => {
  it('一條 thread 一個對話行程；前台被殺，監督行程重起它，對話行程不斷、下一輪照常', async () => {
    const running = await start([{ content: '第一輪的回覆。' }, { content: '第二輪的回覆。' }]);
    const supervisor = running.child.pid!;
    const client = await clientOf(await running.loginUrl(1));

    expect(replies(await turn(client, 'thread-a', '你好'))).toEqual(['第一輪的回覆。']);
    const conversations = await settled(supervisor, 'conversation-process', 1 + WARM);
    expect(conversations).toHaveLength(1 + WARM);

    const [front] = childrenRunning(supervisor, 'front-process');
    expect(front).toBeDefined();
    signalPid(front!, 'SIGKILL');
    const again = await clientOf(await running.loginUrl(2));
    expect(childrenRunning(supervisor, 'front-process')).not.toContain(front);
    expect(childrenRunning(supervisor, 'conversation-process')).toEqual(conversations);

    // 腳本吃到第二輪：是同一個對話行程、同一份組裝接著答，不是重起的。
    expect(replies(await turn(again, 'thread-a', '再一輪'))).toEqual(['第二輪的回覆。']);
    expect(childrenRunning(supervisor, 'conversation-process')).toEqual(conversations);
  }, 180_000);

  it('下行走 WebSocket mux：經前台轉給對話行程，一輪照常串完', async () => {
    const running = await start([{ content: '經 mux 串過來的回覆。', tokenDelayMs: 10 }]);
    const client = await muxClientOf(await running.loginUrl(1));
    expect(replies(await turn(client, 'thread-mux', '你好'))).toEqual(['經 mux 串過來的回覆。']);
  }, 180_000);

  it('兩條 thread 各一個對話行程', async () => {
    const running = await start([{ content: '回覆。' }]);
    const client = await clientOf(await running.loginUrl(1));
    expect(replies(await turn(client, 'thread-a', '你好'))).toEqual(['回覆。']);
    expect(replies(await turn(client, 'thread-b', '你好'))).toEqual(['回覆。']);
    expect(await settled(running.child.pid!, 'conversation-process', 2 + WARM)).toHaveLength(
      2 + WARM,
    );
  }, 180_000);

  it('只讀開的下行：開著就不照只讀的閒置時間收，關掉之後才收', async () => {
    const running = await start([{ content: '回覆。' }], '', undefined, [
      '--read-only-idle-ms',
      '1500',
    ]);
    const supervisor = running.child.pid!;
    const client = await clientOf(await running.loginUrl(1));
    const downlink = new AbortController();
    await client.openEvents('thread-ro', { signal: downlink.signal });
    const opened = await settled(supervisor, 'conversation-process', 1 + WARM);
    expect(opened).toHaveLength(1 + WARM);

    // 只讀閒置 1.5 秒＋對話行程每秒回報一次：4 秒內沒收，就是開著的下行讓它不回報閒置。
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    expect(childrenRunning(supervisor, 'conversation-process')).toEqual(opened);

    // 對照：下行一關，同一個行程照只讀的閒置時間收掉。
    downlink.abort();
    const after = await settled(supervisor, 'conversation-process', WARM);
    expect(after).toHaveLength(WARM);
  }, 180_000);

  it('講過話的 thread：下行收掉前台送 release，監督行程不收它（只收只讀開的）', async () => {
    const running = await start([{ content: '回覆。' }], '', undefined, [
      '--read-only-idle-ms',
      '1500',
    ]);
    const supervisor = running.child.pid!;
    const client = await clientOf(await running.loginUrl(1));
    // 下行用 signal 收：沒讀完就 `return()` 的產生器不會取消本文，連線還開著。
    const downlink = new AbortController();
    const events = await client.openEvents('thread-run', { signal: downlink.signal });
    await client.runStart('thread-run', '你好');
    expect(replies(await foldTurn(events))).toEqual(['回覆。']);
    downlink.abort();
    const spoken = await settled(supervisor, 'conversation-process', 1 + WARM);
    expect(spoken).toHaveLength(1 + WARM);
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    expect(childrenRunning(supervisor, 'conversation-process')).toEqual(spoken);
  }, 180_000);

  it('全域下行與列表的在跑：前台從對話行程接過來，跟 single 一樣', async () => {
    const running = await start([
      { content: '慢慢串的一段回覆，好讓列表問得到它在跑。', tokenDelayMs: 150 },
    ]);
    const client = await clientOf(await running.loginUrl(1));
    const feedLine = new AbortController();
    const feed = await client.openThreadFeed(feedLine.signal);
    const statuses: boolean[] = [];
    void (async () => {
      for await (const frame of feed) {
        if (frame.type === 'status' && frame.threadId === 'thread-live')
          statuses.push(frame.running);
      }
    })().catch(() => {});
    const runningInList = async (): Promise<boolean | undefined> => {
      const outcome = await client.listThreads();
      if (outcome.kind !== 'ok') return undefined;
      return outcome.result.items.find(({ threadId }) => threadId === 'thread-live')?.running;
    };

    const downlink = new AbortController();
    const events = await client.openEvents('thread-live', { signal: downlink.signal });
    await client.runStart('thread-live', '你好');
    await expect.poll(() => statuses, { timeout: 20_000 }).toContain(true);
    await expect.poll(runningInList, { timeout: 20_000 }).toBe(true);

    expect(replies(await foldTurn(events))).toEqual(['慢慢串的一段回覆，好讓列表問得到它在跑。']);
    await expect.poll(() => statuses.at(-1), { timeout: 20_000 }).toBe(false);
    await expect.poll(runningInList, { timeout: 20_000 }).toBe(false);
    downlink.abort();
    feedLine.abort();
  }, 180_000);

  it('沒有行程的 thread：run.cancel 照 single 回受理、不起行程；評分要寫日誌，起一個', async () => {
    const running = await start([{ content: '回覆。' }]);
    const supervisor = running.child.pid!;
    const client = await clientOf(await running.loginUrl(1));
    const idle = await settled(supervisor, 'conversation-process', WARM);
    expect(idle).toHaveLength(WARM);

    expect(await client.runCancel('thread-cold')).toMatchObject({
      type: 'success',
      result: { accepted: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(childrenRunning(supervisor, 'conversation-process')).toEqual(idle);

    expect(await client.feedbackList('thread-cold')).toMatchObject({ kind: 'ok' });
    expect(await settled(supervisor, 'conversation-process', 1 + WARM)).toHaveLength(1 + WARM);
  }, 180_000);

  it('封存由前台寫：問對話行程在跑什麼、請它停，之後那個行程的閘門就擋', async () => {
    const slow = '慢慢串的一段很長的回覆，'.repeat(20);
    const running = await start([
      { content: slow, tokenDelayMs: 100 },
      { content: '封存之後不該跑出來的回覆。' },
    ]);
    const url = await running.loginUrl(1);
    const client = await clientOf(url);
    const events = await client.openEvents('thread-archive');
    await client.runStart('thread-archive', '你好');
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(await client.threadArchive('thread-archive')).toMatchObject({
      kind: 'ok',
      result: { ok: false, error: { code: 'thread_active', activity: ['turn'] } },
    });
    expect(await client.threadArchive('thread-archive', { stopActivity: true })).toMatchObject({
      kind: 'ok',
      result: { ok: true, value: { archivedThreadIds: ['thread-archive'] } },
    });
    // 對話行程的內部路由只在 0700 的 socket 上：從前台的入口打，主機擁有者也打不到。
    const internal = await fetchWithCookie(await exchangeServeToken(url))(
      `${new URL(url).origin}/internal/threads/thread-archive/activity`,
    );
    expect(internal.status).toBe(404);
    // 停是真的停了：這一輪照腳本要串 24 秒，沒停的話這裡會拿到整段。
    expect(replies(await foldTurn(events))).not.toContain(slow);
    await events.return?.(undefined);

    expect(replies(await turn(client, 'thread-archive', '再一輪'))).not.toContain(
      '封存之後不該跑出來的回覆。',
    );
  }, 180_000);

  describe('嵌入版（身分由前台往下傳）', () => {
    const EMBED_ROWS =
      '- id: embed-login\n  config:\n    embedders:\n      - id: crm\n    ticketTtlSeconds: 60\n';
    const TABLE = {
      version: 1,
      mappings: [
        { embedder: 'crm', subject: 'alice', userId: 'alice' },
        { embedder: 'crm', subject: 'bob', userId: 'bob' },
      ],
    };

    async function startEmbedded(turns: readonly ScriptedTurn[]): Promise<Running> {
      return start(turns, EMBED_ROWS, async (home) => {
        await writeFile(join(home, EMBED_IDENTITIES_FILE), JSON.stringify(TABLE), { mode: 0o600 });
      });
    }

    async function embedCookie(running: Running, subject: string): Promise<string> {
      const base = `http://127.0.0.1:${String(running.port)}`;
      const credential = (
        await readFile(join(running.home, 'embed-credential-crm'), 'utf8')
      ).trim();
      const exchanged = await fetch(`${base}${EMBED_EXCHANGE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
        body: JSON.stringify({ subject, sessionId: `s-${subject}` }),
      });
      expect(exchanged.status).toBe(200);
      const { ticket } = (await exchanged.json()) as { ticket: string };
      const redeemed = await fetch(`${base}${EMBED_SESSION_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticket }),
      });
      expect(redeemed.status).toBe(200);
      return redeemed.headers.get('set-cookie')!.split(';', 1)[0]!;
    }

    function embedClient(running: Running, cookie: string): WireClient {
      const origin = `http://127.0.0.1:${String(running.port)}`;
      return createWireClient({
        baseUrl: `${origin}${EMBED_PATH_PREFIX}`,
        fetch: fetchWithCookie(cookie),
      });
    }

    async function auditLines(home: string): Promise<Record<string, unknown>[]> {
      return (await readFile(join(home, EMBED_AUDIT_FILE), 'utf8'))
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    }

    it('嵌入身分開的 thread 歸那個人：本人跑得了一輪，別人打開被拒、記 access', async () => {
      const running = await startEmbedded([{ content: '嵌入版的回覆。' }]);
      await running.loginUrl(1);
      const alice = embedClient(running, await embedCookie(running, 'alice'));
      expect(replies(await turn(alice, 'e-owned', '你好'))).toEqual(['嵌入版的回覆。']);

      const bob = embedClient(running, await embedCookie(running, 'bob'));
      expect(await bob.threadHistory('e-owned')).toMatchObject({
        kind: 'rejected',
        code: 'thread_not_owned',
      });
      await vi.waitFor(
        async () => {
          const access = (await auditLines(running.home)).filter((line) => line.event === 'access');
          expect(access).toEqual([
            expect.objectContaining({
              threadId: 'e-owned',
              userId: 'bob',
              reason: 'thread_not_owned',
            }),
          ]);
        },
        { timeout: 5_000 },
      );
    }, 180_000);

    it('撤權（#2489）：從表上拿掉之後，經前台轉送的下行 2 秒內被切掉，稽核記 opened 與 cut', async () => {
      const running = await startEmbedded([{ content: '回覆。' }]);
      await running.loginUrl(1);
      const cookie = await embedCookie(running, 'alice');
      const origin = `http://127.0.0.1:${String(running.port)}`;
      const response = await fetch(`${origin}/embed/threads/e-revoke/stream`, {
        method: 'POST',
        headers: { origin, cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ channels: ['messages', 'lifecycle'] }),
      });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(': connected\n\n');

      const table = join(running.home, EMBED_IDENTITIES_FILE);
      await writeFile(table, JSON.stringify({ version: 1, mappings: [] }), { mode: 0o600 });
      const later = new Date(Date.now() + 5_000);
      await utimes(table, later, later);
      const revokedAt = performance.now();
      await expect(
        (async () => {
          for (;;) {
            const { done } = await reader.read();
            if (done) return;
          }
        })(),
      ).resolves.toBeUndefined();
      expect(performance.now() - revokedAt).toBeLessThan(2_000);
      await vi.waitFor(
        async () => {
          const streams = (await auditLines(running.home)).filter(
            (line) => line.event === 'stream',
          );
          expect(streams).toEqual([
            expect.objectContaining({ outcome: 'opened', threadId: 'e-revoke', userId: 'alice' }),
            expect.objectContaining({ outcome: 'cut', threadId: 'e-revoke', reason: 'not_mapped' }),
          ]);
        },
        { timeout: 5_000 },
      );
    }, 180_000);
  });
});
