/**
 * per-thread 整支跑起來（[#2341](https://github.com/DemianLi/nexus-agent/issues/2341)）：`serve.ts --process-model per-thread` 換成真的監督行程，
 * 它起前台與每條 thread 的對話行程，wire 從前台的 port 打。模型換成腳本（`scripted-serve.ts` 那份 patch），讀不到 `.env`。
 *
 * 只在 Linux 跑，`NEXUS_SUPERVISOR_BIN` 指到 `nexus-supervisor`；沒設就跳過。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import {
  createMuxFetch,
  createWireClient,
  decodeSseData,
  EMBED_PATH_PREFIX,
  WIRE_CHANNELS,
  WIRE_MUX_PATH,
} from '@nexus/wire';
import type { AiEntry, ConversationState, MuxSocket, WireClient } from '@nexus/wire';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { EMBED_AUDIT_FILE } from './embed-audit.js';
import { EMBED_IDENTITIES_FILE } from './embed-identities.js';
import { EMBED_EXCHANGE_PATH } from './embed-login.js';
import { EMBED_SESSION_PATH } from './embed-session.js';
import { exchangeServeToken, fetchWithCookie, foldTurn } from './fixtures.js';
import { fakeEndpoint, hasTools, liveModelPatch, mainOnly } from './log-derived-history.fixture.js';
import type { FakeEndpoint, WireMessage } from './log-derived-history.fixture.js';
import { FrontForwarder } from './front-forward.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { composeEntries, defaultSources } from './plugin-config.js';
import { appendRaw, journalPathOf, seedHomePatch } from './plugin-journal.fixture.js';
import { readJournal } from './plugin-journal.js';
import { PLUGIN_SNAPSHOT_FILE_NAME } from './plugin-snapshot.js';
import { HOST_PLUGINS_FILE } from './process-launcher.js';
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

/** {@link start} 的其餘選項。 */
interface StartOptions {
  /** 沿用這個目錄（同一個 home、同一份落盤）：重啟整台用。省略是開新的。 */
  readonly dir?: string;
  /** 模型換成這個假 OpenAI 端點（`--live`），不用腳本；看得到每一次請求的 body。 */
  readonly liveBaseUrl?: string;
  /** 加在 serve 後面的旗標，對話行程也收（`CONVERSATION_FLAGS`）。 */
  readonly serveArgs?: readonly string[];
}

async function start(
  turns: readonly ScriptedTurn[],
  extraRows = '',
  prepareHome?: (home: string) => Promise<void>,
  supervisorArgs: readonly string[] = [],
  options: StartOptions = {},
): Promise<Running> {
  const dir = options.dir ?? (await mkdtemp(join(tmpdir(), 'nexus-per-thread-')));
  if (options.dir === undefined) roots.push(dir);
  const patch = join(dir, 'script.patch.yml');
  // 監督行程的旗標由啟動器組，測試要加的經一支 `exec` 包裝：pid 不變，`childrenRunning` 照樣找得到子行程。
  // 啟動器在 `supervisorBinary` 旁邊找宿主，所以包裝旁邊也要有一個。
  let supervisorBinary = SUPERVISOR!;
  if (supervisorArgs.length > 0) {
    supervisorBinary = join(dir, 'supervisor-wrapper.sh');
    const quoted = [SUPERVISOR!, ...supervisorArgs].map((arg) => `'${arg}'`).join(' ');
    await writeFile(supervisorBinary, `#!/bin/sh\nexec ${quoted} "$@"\n`, { mode: 0o755 });
    await symlink(join(dirname(SUPERVISOR!), 'nexus-host'), join(dir, 'nexus-host'));
  }
  const rows = `- id: process-model\n  config:\n    mode: per-thread\n    supervisorBinary: ${supervisorBinary}\n${extraRows}`;
  await writeFile(
    patch,
    options.liveBaseUrl === undefined
      ? scriptedPatchText(turns, rows)
      : liveModelPatch(options.liveBaseUrl, rows),
    'utf8',
  );
  const home = join(dir, 'home');
  const harnessHome = join(home, 'harness-home');
  await mkdir(harnessHome, { recursive: true, mode: 0o700 });
  await prepareHome?.(harnessHome);
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [
      '--import',
      TSX,
      SERVE,
      '--port',
      String(port),
      '--patch',
      patch,
      ...(options.liveBaseUrl === undefined ? [] : ['--live']),
      ...(options.serveArgs ?? []),
    ],
    {
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        NEXUS_AGENT_HOME: harnessHome,
        ...(options.liveBaseUrl !== undefined && { NVIDIA_API_KEY: 'nvapi-fake-for-per-thread' }),
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

/** 量前台的併發（#2341 驗收）：設成要開幾條串流才跑，量完印數字，不斷言門檻。 */
const MEASURE_STREAMS = Number(process.env.NEXUS_MEASURE_FRONT ?? '0');

/** `/proc/<pid>/stat` 的 utime＋stime，單位是 clock tick（Linux 是 100 Hz）。 */
function cpuTicks(pid: number): number {
  const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return Number(fields[11]) + Number(fields[12]);
}

function socketOf(pid: number): string | undefined {
  const argv = readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8').split('\0');
  const index = argv.indexOf('--socket');
  return index === -1 ? undefined : argv[index + 1];
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))] ?? Number.NaN;
}

describe.skipIf(SUPERVISOR === undefined || MEASURE_STREAMS === 0)(
  'per-thread：前台併發量測',
  () => {
    it('每輪約 2400 顆、開到指定條數：前台 CPU 與每顆經前台多出來的時間', async () => {
      const running = await start([{ content: 'x'.repeat(2400), tokenDelayMs: 2 }]);
      const supervisor = running.child.pid!;
      const client = await clientOf(await running.loginUrl(1));
      const forwarder = new FrontForwarder();
      const abort = new AbortController();
      const threads = Array.from({ length: MEASURE_STREAMS }, (_, i) => `thread-load-${String(i)}`);
      const body = JSON.stringify({ channels: [...WIRE_CHANNELS] });
      const openDirect = (thread: string, socket: string) =>
        forwarder.forward(
          new Request(`http://localhost/threads/${thread}/stream`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
            signal: abort.signal,
          }),
          socket,
        );

      /** 一條線上每一顆到的時間。 */
      const follow = async (stream: AsyncIterable<unknown>, times: number[]): Promise<void> => {
        for await (const _frame of stream) times.push(performance.now());
      };
      const lines: {
        viaFront: number[];
        direct: number[];
        control: number[];
        done: Promise<unknown>;
      }[] = [];
      for (const thread of threads) {
        const front = await client.openEvents(thread, { signal: abort.signal });
        // 這條綁到哪個 socket 監督行程沒講出來：每個對話行程都試，綁著的那一個才回 event-stream。
        let bound: { socket: string; body: ReadableStream<Uint8Array> } | undefined;
        for (let attempt = 0; bound === undefined && attempt < 50; attempt += 1) {
          for (const pid of childrenRunning(supervisor, 'conversation-process')) {
            const socket = socketOf(pid);
            if (socket === undefined) continue;
            const response = await openDirect(thread, socket).catch(() => undefined);
            if (
              response?.body != null &&
              response.headers.get('content-type')?.startsWith('text/event-stream') === true
            ) {
              bound = { socket, body: response.body };
              break;
            }
            await response?.body?.cancel();
          }
          if (bound === undefined) await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(bound).toBeDefined();
        // 對照組：同一個 socket 再直接開一條，兩條直連之間的差是量具本身（這支測試的事件圈、排程）的雜訊。
        const controlBody = (await openDirect(thread, bound!.socket)).body!;
        const line = { viaFront: [], direct: [], control: [] } as Omit<
          (typeof lines)[number],
          'done'
        >;
        lines.push({
          ...line,
          done: Promise.all([
            follow(front, line.viaFront).catch(() => {}),
            follow(decodeSseData(bound!.body), line.direct).catch(() => {}),
            follow(decodeSseData(controlBody), line.control).catch(() => {}),
          ]),
        });
      }
      const [frontPid] = childrenRunning(supervisor, 'front-process');
      const loop = monitorEventLoopDelay({ resolution: 1 });
      loop.enable();
      const ticksBefore = cpuTicks(frontPid!);
      const began = performance.now();
      await Promise.all(threads.map((thread) => client.runStart(thread, '開始')));
      // 停的條件：每條的三條線收到一樣多顆（而且超過 2000）、一秒沒有新的；最多等 120 秒。
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const last = Math.max(...lines.flatMap(({ viaFront }) => viaFront.slice(-1)));
        const even = lines.every(
          ({ viaFront, direct, control }) =>
            viaFront.length > 2000 &&
            viaFront.length === direct.length &&
            direct.length === control.length,
        );
        if (even && performance.now() - last > 1_000) break;
        if (performance.now() - began > 120_000) break;
      }
      const cpu = (cpuTicks(frontPid!) - ticksBefore) / 100;
      loop.disable();
      const lastFrame = Math.max(...lines.flatMap(({ viaFront }) => viaFront.slice(-1)));
      const wall = (lastFrame - began) / 1_000;
      const diff = (a: number[], b: number[]) => a.slice(0, b.length).map((at, i) => at - b[i]!);
      const hops = lines.flatMap(({ viaFront, direct }) => diff(viaFront, direct));
      const noise = lines.flatMap(({ control, direct }) => diff(control, direct));
      const ms = (values: number[]) =>
        `p50 ${percentile(values, 50).toFixed(3)}、p99 ${percentile(values, 99).toFixed(3)}、最大 ${percentile(values, 100).toFixed(3)} ms`;
      console.log(
        `[C3 併發量測] 條數 ${String(MEASURE_STREAMS)}；` +
          `每條顆數 ${JSON.stringify(lines.map(({ viaFront, direct, control }) => [viaFront.length, direct.length, control.length]))}；` +
          `前台 CPU ${cpu.toFixed(2)} 秒／牆鐘 ${wall.toFixed(2)} 秒＝${((cpu / wall) * 100).toFixed(1)}% 一核；` +
          `經前台多出來的時間 ${ms(hops)}（${String(hops.length)} 顆）；對照（兩條直連之差）${ms(noise)}；` +
          `量測端事件圈延遲 p99 ${(loop.percentile(99) / 1e6).toFixed(1)} ms、最大 ${(loop.max / 1e6).toFixed(1)} ms`,
      );
      abort.abort();
      await Promise.all(lines.map(({ done }) => done));
      forwarder.close();
    }, 600_000);
  },
);

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

  it('前台被殺時有一輪在跑：舊的 cookie 照樣列得出來、全域下行重開得了，新前台從對話行程接回在跑與跑完', async () => {
    const reply = `慢慢串的回覆${'，還在串'.repeat(10)}。`;
    const running = await start([{ content: reply, tokenDelayMs: 80 }]);
    const supervisor = running.child.pid!;
    const client = await clientOf(await running.loginUrl(1));
    const downlink = new AbortController();
    await client.openEvents('thread-r', { signal: downlink.signal });
    await client.runStart('thread-r', '你好');

    const [front] = childrenRunning(supervisor, 'front-process');
    signalPid(front!, 'SIGKILL');
    await running.loginUrl(2);

    // 網頁手上的是重啟之前那顆 cookie：瀏覽器重連時不會重新登入。
    const runningInList = async (): Promise<boolean | undefined> => {
      const outcome = await client.listThreads();
      if (outcome.kind !== 'ok') return undefined;
      return outcome.result.items.find(({ threadId }) => threadId === 'thread-r')?.running;
    };
    const feedLine = new AbortController();
    const feed = await client.openThreadFeed(feedLine.signal);
    const statuses: boolean[] = [];
    void (async () => {
      for await (const frame of feed) {
        if (frame.type === 'status' && frame.threadId === 'thread-r') statuses.push(frame.running);
      }
    })().catch(() => {});
    // 狀態不補送（`openThreadFeed` 的契約）：線開好之後的「在跑」從列表拿，跑完那一顆由新前台的線送。
    await expect.poll(runningInList, { timeout: 20_000 }).toBe(true);
    await expect.poll(() => statuses.at(-1), { timeout: 30_000 }).toBe(false);
    await expect.poll(runningInList, { timeout: 20_000 }).toBe(false);

    const history = await client.threadHistory('thread-r');
    expect(history.kind).toBe('ok');
    expect(JSON.stringify(history)).toContain('還在串');
    downlink.abort();
    feedLine.abort();
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

  it('plugin 對照快照：前台列出對話行程裡活著的 thread（只看過歷史的也算），行程收掉就拿掉', async () => {
    const running = await start([{ content: '回覆。' }], '', undefined, [
      '--read-only-idle-ms',
      '1500',
    ]);
    const client = await clientOf(await running.loginUrl(1));
    const snapshot = join(running.home, PLUGIN_SNAPSHOT_FILE_NAME);
    const liveThreads = async (): Promise<string[]> => {
      const rows = (
        JSON.parse(await readFile(snapshot, 'utf8')) as {
          rows: { live?: { threads: string[] }[] }[];
        }
      ).rows;
      return [...new Set(rows.flatMap((row) => row.live ?? []).flatMap(({ threads }) => threads))];
    };
    expect(await liveThreads()).toEqual([]);

    expect((await client.threadHistory('thread-p')).kind).toBe('ok');
    await expect.poll(liveThreads, { timeout: 15_000 }).toEqual(['thread-p']);
    // 只讀的閒置時間一到，監督行程收掉那個行程（`down`）：快照不再列它。
    await expect.poll(liveThreads, { timeout: 15_000 }).toEqual([]);
  }, 180_000);

  it('對話行程的內部路由不經前台：帶擁有者 cookie 打前台的 activity／plugins／stop 落到靜態檔（404／405），行程照常', async () => {
    const running = await start([{ content: '回覆。' }, { content: '第二輪。' }]);
    const url = await running.loginUrl(1);
    const client = await clientOf(url);
    // 先讓這條的行程起來：前台若把這幾條轉下去，對話行程會當擁有者答。
    expect(replies(await turn(client, 'thread-i', '你好'))).toEqual(['回覆。']);
    const fetchAsOwner = fetchWithCookie(await exchangeServeToken(url));
    const { origin } = new URL(url);
    for (const [action, method] of [
      ['activity', 'GET'],
      ['plugins', 'GET'],
      ['stop', 'POST'],
      ['turn-failures', 'GET'],
      ['fork-seed', 'POST'],
      ['fork-adopt', 'POST'],
    ] as const) {
      const response = await fetchAsOwner(`${origin}/internal/threads/thread-i/${action}`, {
        method,
      });
      const body = await response.text();
      // 不是 `/threads` 底下的路徑，前台交給靜態檔：GET 找不到檔是 404，POST 是 405。
      expect({ action, status: response.status, body }).toEqual({
        action,
        status: method === 'GET' ? 404 : 405,
        body: expect.not.stringMatching(/activity|bindings/u) as string,
      });
    }
    expect(replies(await turn(client, 'thread-i', '再一輪'))).toEqual(['第二輪。']);
    const history = await client.threadHistory('thread-i');
    expect(JSON.stringify(history)).toContain('再一輪');
  }, 180_000);

  it('掉列紀錄：同一列在兩個對話行程都掛不上，紀錄裡只有一筆 failed', async () => {
    const probe = [
      'export default {',
      "  name: 'probe',",
      '  apply(_registry, config) {',
      "    if (config?.ok !== true) throw new Error('故意在 apply 裡壞掉');",
      '  },',
      '};',
      '',
    ].join('\n');
    let harnessHome = '';
    const running = await start([{ content: '回覆。' }], '', async (home) => {
      harnessHome = home;
      await writeFile(join(home, 'probe.ts'), probe, { mode: 0o600 });
      seedHomePatch(
        home,
        "- insert:\n    - id: probe\n      name: './probe.ts'\n      config:\n        ok: true\n",
      );
    });
    const client = await clientOf(await running.loginUrl(1));
    expect(replies(await turn(client, 'thread-warm', '你好'))).toEqual(['回覆。']);
    const failed = (): number =>
      (readJournal(journalPathOf(harnessHome))?.records ?? []).filter(({ op }) => op === 'failed')
        .length;
    expect(failed()).toBe(0);

    // 繞過寫入口追加一筆讓 probe 掛不上的設定（同 `serve-plugin-failed-record.test.ts` 的 `setProbe`）。
    const env = { [HARNESS_HOME_ENV]: harnessHome };
    const name = composeEntries(defaultSources({ serve: true, env })).find(
      ({ id }) => id === 'probe',
    )?.name;
    expect(name).toBeDefined();
    await appendRaw(harnessHome, {
      op: 'config-set',
      id: 'probe',
      name: name!,
      before: { ok: true },
      after: { ok: false },
    });
    const [a, b] = await Promise.all([
      turn(client, 'thread-x', '你好'),
      turn(client, 'thread-y', '你好'),
    ]);
    expect([replies(a), replies(b)]).toEqual([['回覆。'], ['回覆。']]);
    expect(await settled(running.child.pid!, 'conversation-process', 3 + WARM)).toHaveLength(
      3 + WARM,
    );
    await expect.poll(failed, { timeout: 10_000 }).toBe(1);
    expect(replies(await turn(client, 'thread-z', '你好'))).toEqual(['回覆。']);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(failed()).toBe(1);
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

  it('搜尋與 @ 會話候選只讀磁碟：照樣找得到剛講完的，落後多久印出來', async () => {
    const ROUNDS = 5;
    // 每條 thread 一個新的對話行程，腳本各自從第一輪吃起：回覆都一樣，命中照 threadId 分。回覆一字 20 毫秒慢慢串，
    // 才看得出串到一半的那一則搜不搜得到。
    const reply = `回覆 replymarker ${'後面還在串'.repeat(10)}`;
    const running = await start(
      [{ content: reply, tokenDelayMs: 20 }],
      `- id: thread-search\n  config:\n    openAt: startup\n`,
    );
    const client = await clientOf(await running.loginUrl(1));
    const until = async <T>(probe: () => Promise<T | undefined>): Promise<number> => {
      const began = performance.now();
      for (;;) {
        if ((await probe()) !== undefined) return performance.now() - began;
        if (performance.now() - began > 15_000) throw new Error('15 秒內沒看到');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    // 串流中的那條日誌一直在寫，前台冷讀它時穩定觀察可能兩次都對不上：ThreadSearch 拋 `persistence-failed`，線上只回
    // `unknown_error`、原因只進 serve 日誌，所以從日誌的 `[搜尋]` 行分辨。single 也會，只是前台要冷讀那個檔，窗口比較長。
    // 這種當作還沒搜到；其餘原因照丟。日誌經 pipe 進來，可能比回應晚到：每次失敗都等到多出一行才判。
    // 上限 1/20 遠高於實測（2 顆 CPU 約 5,400 次裡 2 次），只擋不穩退化成常態。
    const tally = { searches: 0, unstable: 0 };
    const searchLines = (): string[] =>
      running
        .log()
        .split('\n')
        .filter((line) => line.includes('[搜尋]'));
    const hit = (query: string, threadId: string) => async () => {
      tally.searches += 1;
      const seen = searchLines().length;
      const outcome = await client.searchThreads(query);
      if (outcome.kind !== 'ok') {
        const began = performance.now();
        while (searchLines().length === seen && performance.now() - began < 5_000) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const fresh = searchLines().slice(seen);
        if (fresh.length > 0 && fresh.every((line) => line.includes('一直在變'))) {
          tally.unstable += 1;
          return undefined;
        }
        throw new Error(`${outcome.message}\n${searchLines().join('\n')}`);
      }
      return outcome.result.items.find((item) => item.threadId === threadId);
    };
    const candidate = (from: string, threadId: string) => async () => {
      const outcome = await client.sessionReferences(from, '');
      if (outcome.kind !== 'ok') throw new Error(outcome.message);
      if (!outcome.result.available) throw new Error('候選沒開');
      return outcome.result.candidates.find(({ sessionId }) => sessionId === threadId);
    };

    const lags = { userMessage: [] as number[], reply: [] as number[], reference: [] as number[] };
    for (let i = 0; i < ROUNDS; i += 1) {
      const threadId = `thread-lag-${String(i)}`;
      const downlink = new AbortController();
      const events = await client.openEvents(threadId, { signal: downlink.signal });
      await client.runStart(threadId, `問題 asked${String(i)}marker`);
      const [userMessage, reference] = await Promise.all([
        until(hit(`asked${String(i)}marker`, threadId)),
        until(candidate('thread-lag-observer', threadId)),
      ]);
      const began = performance.now();
      const [replyHit, endedAt] = await Promise.all([
        until(hit('replymarker', threadId)),
        foldTurn(events).then((state) => {
          expect(replies(state)).toEqual([reply]);
          return performance.now() - began;
        }),
      ]);
      lags.userMessage.push(userMessage);
      lags.reference.push(reference);
      lags.reply.push(replyHit - endedAt);
      downlink.abort();
    }
    const round = (values: number[]) => values.map((value) => Math.round(value));
    console.log(
      `[C3 落後量測] 送出後搜得到使用者那句 ${JSON.stringify(round(lags.userMessage))} ms；` +
        `回覆在一輪結束之後幾毫秒搜得到（負的是還在串就搜得到）${JSON.stringify(round(lags.reply))} ms；` +
        `送出後別條 thread 的 @ 候選看得到 ${JSON.stringify(round(lags.reference))} ms；` +
        `搜尋 ${String(tally.searches)} 次，對帳不穩 ${String(tally.unstable)} 次`,
    );
    expect(tally.unstable).toBeLessThan(tally.searches / 20);
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

describe.skipIf(SUPERVISOR === undefined)('per-thread：對話行程連宿主', () => {
  const count = (log: string, text: string) => log.split(text).length - 1;

  it('對話行程用監督行程給的 socket 與 token 連上宿主；宿主被殺，重起之後對話行程自己重連，對話不斷', async () => {
    const running = await start([{ content: '第一輪。' }, { content: '第二輪。' }]);
    const supervisor = running.child.pid!;
    const client = await clientOf(await running.loginUrl(1));
    expect(replies(await turn(client, 'thread-h', '你好'))).toEqual(['第一輪。']);
    const conversations = await settled(supervisor, 'conversation-process', 1 + WARM);
    await expect
      .poll(() => count(running.log(), '[宿主] 連上了'), { timeout: 20_000 })
      .toBe(1 + WARM);

    const [host] = childrenRunning(supervisor, 'nexus-host');
    expect(host).toBeDefined();
    signalPid(host!, 'SIGKILL');
    await expect
      .poll(() => count(running.log(), '[宿主] 斷線'), { timeout: 20_000 })
      .toBe(1 + WARM);
    await expect
      .poll(() => count(running.log(), '[宿主] 連上了'), { timeout: 30_000 })
      .toBe(2 * (1 + WARM));
    expect(childrenRunning(supervisor, 'nexus-host')).not.toContain(host);
    expect(childrenRunning(supervisor, 'conversation-process')).toEqual(conversations);
    expect(replies(await turn(client, 'thread-h', '再一輪'))).toEqual(['第二輪。']);
  }, 180_000);

  it('home 底下的 host-plugins.json 壞了：宿主起不來，整台以 5 結束、stderr 寫明宿主設定壞了', async () => {
    const running = await start([], '', async (home) => {
      await writeFile(join(home, HOST_PLUGINS_FILE), '{ 不是 JSON', 'utf8');
    });
    const code = await new Promise<number | null>((resolve) => running.child.once('exit', resolve));
    expect(code).toBe(5);
    expect(running.log()).toContain('宿主設定壞了');
  }, 180_000);
});

/**
 * native 下對話只從日誌推（[#2360](https://github.com/DemianLi/nexus-agent/issues/2360)），per-thread 那一半：single 的在 `native-log-restore.test.ts`。
 *
 * 對話行程換了一個（pid 不同），行程內的快取就一定是空的；下一輪模型收到的請求帶著前一個行程那一輪的人話與回覆，就是從日誌灌回的。
 * 模型是假 OpenAI 端點（`--live`），請求在這個測試行程裡看得到。
 */
describe.skipIf(SUPERVISOR === undefined)(
  'per-thread --agent-loop native：換了對話行程，對話從日誌來',
  () => {
    const NATIVE = ['--agent-loop', 'native'];

    function textOf(message: WireMessage): string {
      if (typeof message.content === 'string') return message.content;
      if (!Array.isArray(message.content)) return JSON.stringify(message.content ?? '');
      return (message.content as { type?: unknown; text?: unknown }[])
        .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
        .join('');
    }

    /** 主呼叫裡最後一則人話含 `prompt` 的那一次，回它每一則（系統以外）的角色與文字。 */
    function requestFor(upstream: FakeEndpoint, prompt: string): string[] {
      const body = upstream.bodies.findLast(
        (candidate) => hasTools(candidate) && textOf(candidate.messages.at(-1)!).includes(prompt),
      );
      if (body === undefined) throw new Error(`模型沒收到「${prompt}」那一次`);
      return body.messages
        .filter((message) => message.role !== 'system')
        .map((message) => `${message.role}:${textOf(message)}`);
    }

    async function upstream(): Promise<FakeEndpoint> {
      const endpoint = await fakeEndpoint(
        mainOnly((k) => ({ content: `第 ${k} 次回覆` })),
        true,
      );
      cleanupEndpoints.push(endpoint);
      return endpoint;
    }
    const cleanupEndpoints: FakeEndpoint[] = [];
    afterEach(async () => {
      for (const endpoint of cleanupEndpoints.splice(0)) await endpoint.close();
    });

    it('重啟續聊：整台收掉再用同一個 home 起來，新的對話行程從日誌灌回，模型收到重啟之前那一輪', async () => {
      const model = await upstream();
      const first = await start([], '', undefined, [], {
        liveBaseUrl: model.baseURL,
        serveArgs: NATIVE,
      });
      const firstClient = await clientOf(await first.loginUrl(1));
      await turn(firstClient, 'thread-n', '暗號是藍鯨');
      const before = childrenRunning(first.child.pid!, 'conversation-process');
      expect(before.length).toBeGreaterThan(0);
      first.child.kill('SIGTERM');
      await new Promise((resolve) => first.child.once('exit', resolve));

      const dir = dirname(dirname(first.home));
      const second = await start([], '', undefined, [], {
        dir,
        liveBaseUrl: model.baseURL,
        serveArgs: NATIVE,
      });
      const client = await clientOf(await second.loginUrl(1));
      await turn(client, 'thread-n', '剛才的暗號是什麼');
      // 新的一台、新的對話行程：前一台的行程都已經不在。
      expect(
        childrenRunning(second.child.pid!, 'conversation-process').some((pid) =>
          before.includes(pid),
        ),
      ).toBe(false);
      expect(requestFor(model, '剛才的暗號是什麼')).toEqual([
        expect.stringContaining('暗號是藍鯨'),
        'assistant:第 0 次回覆',
        expect.stringContaining('剛才的暗號是什麼'),
      ]);
    }, 240_000);

    it('閒置逐出後回來：監督行程照 idleEvictAfterMs 收掉對話行程，再開起新的一個，從日誌灌回', async () => {
      const model = await upstream();
      const running = await start(
        [],
        '- id: thread-capacity\n  config:\n    idleEvictAfterMs: 1500\n',
        undefined,
        [],
        { liveBaseUrl: model.baseURL, serveArgs: NATIVE },
      );
      const supervisor = running.child.pid!;
      const client = await clientOf(await running.loginUrl(1));
      // 下行用 signal 收：沒讀完就 `return()` 的產生器不會取消本文，連線還開著，行程就不閒。
      const downlink = new AbortController();
      const events = await client.openEvents('thread-e', { signal: downlink.signal });
      await client.runStart('thread-e', '暗號是虎鯨');
      await foldTurn(events);
      downlink.abort();
      // 綁著它的那一個加上補上的預熱行程；收掉之後只剩預熱的，少掉的那一個就是綁著它的。
      const spoken = await settled(supervisor, 'conversation-process', 1 + WARM);
      expect(spoken).toHaveLength(1 + WARM);
      await expect
        .poll(() => childrenRunning(supervisor, 'conversation-process').length, {
          timeout: 30_000,
        })
        .toBe(WARM);
      const evicted = spoken.filter(
        (pid) => !childrenRunning(supervisor, 'conversation-process').includes(pid),
      );
      expect(evicted).toHaveLength(1);

      await turn(client, 'thread-e', '撤之前的暗號是什麼');
      expect(childrenRunning(supervisor, 'conversation-process')).not.toContain(evicted[0]);
      expect(requestFor(model, '撤之前的暗號是什麼')).toEqual([
        expect.stringContaining('暗號是虎鯨'),
        'assistant:第 0 次回覆',
        expect.stringContaining('撤之前的暗號是什麼'),
      ]);
    }, 240_000);
  },
);
