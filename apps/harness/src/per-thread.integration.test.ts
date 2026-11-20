/**
 * per-thread 整支跑起來（[#2341](https://github.com/DemianLi/nexus-agent/issues/2341)）：`serve.ts --process-model per-thread` 換成真的監督行程，
 * 它起前台與每條 thread 的對話行程，wire 從前台的 port 打。模型換成腳本（`scripted-serve.ts` 那份 patch），讀不到 `.env`。
 *
 * 只在 Linux 跑，`NEXUS_SUPERVISOR_BIN` 指到 `nexus-supervisor`；沒設就跳過。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { TOOL_NOT_STARTED_TEXT, TOOL_OUTCOME_UNKNOWN_TEXT } from '@nexus/core';
import { DEFAULT_REBIND_WAIT_MS } from '@nexus/plugin-mcp';
import {
  createMuxFetch,
  createWireClient,
  decodeSseData,
  EMBED_PATH_PREFIX,
  emptyConversation,
  isApprovalPending,
  reduceConversation,
  uniformDecisions,
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
import { CREDENTIALS_FILE } from './credentials.js';
import { approvalAt, exchangeServeToken, fetchWithCookie, foldTurn } from './fixtures.js';
import {
  fakeEndpoint,
  isMainCall,
  liveModelPatch,
  mainOnly,
} from './log-derived-history.fixture.js';
import type { Body, FakeEndpoint, Reply, WireMessage } from './log-derived-history.fixture.js';
import { FrontForwarder } from './front-forward.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { composeEntries, defaultSources } from './plugin-config.js';
import { appendRaw, journalPathOf, seedHomePatch } from './plugin-journal.fixture.js';
import { readJournal } from './plugin-journal.js';
import { PLUGIN_SNAPSHOT_FILE_NAME } from './plugin-snapshot.js';
import { HOST_PLUGINS_FILE, SUPERVISOR_AUDIT_FILE } from './process-launcher.js';
import type { ScriptedTurn } from './scripted-model.js';
import { scriptedPatchText } from './scripted-serve.js';
import {
  decodeConversationReport,
  encodeConversationCommand,
  frame,
  PROTOCOL_VERSION,
  takeFrames,
} from './supervisor-protocol.js';
import { signalPid } from './test-pids.fixture.js';

const SUPERVISOR = process.env.NEXUS_SUPERVISOR_BIN;
/** `nexus-composition` 的執行檔：一對（#2769）的整合測試要它；沒設就跳過。 */
const COMPOSITION = process.env.NEXUS_COMPOSITION_BIN;
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
  /**
   * 啟動器寫完 `host-plugins.json`、換成監督行程之前，包裝腳本先跑的一段 shell（`$NEXUS_AGENT_HOME` 是 harness home）。
   * 啟動器每次啟動都整份重寫清單，測試放在 home 的檔到不了宿主；要讓宿主讀到特定內容，只能在這裡之後蓋。
   */
  readonly beforeSupervisor?: string;
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
  if (supervisorArgs.length > 0 || options.beforeSupervisor !== undefined) {
    supervisorBinary = join(dir, 'supervisor-wrapper.sh');
    const quoted = [SUPERVISOR!, ...supervisorArgs].map((arg) => `'${arg}'`).join(' ');
    await writeFile(
      supervisorBinary,
      `#!/bin/sh\n${options.beforeSupervisor ?? ''}\nexec ${quoted} "$@"\n`,
      { mode: 0o755 },
    );
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

/** 前台的 plugin 對照快照上列著的 thread：前台收到 `up` 之後綁上的才列，收到 `down` 就拿掉。 */
async function liveThreadsOf(home: string): Promise<string[]> {
  const rows = (
    JSON.parse(await readFile(join(home, PLUGIN_SNAPSHOT_FILE_NAME), 'utf8')) as {
      rows: { live?: { threads: string[] }[] }[];
    }
  ).rows;
  return [...new Set(rows.flatMap((row) => row.live ?? []).flatMap(({ threads }) => threads))];
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

  it('列表讀前台的索引（#725）：日誌是對話行程寫的，講完、改名之後立刻列就看得到', async () => {
    const running = await start([{ content: '回覆。' }]);
    const client = await clientOf(await running.loginUrl(1));
    const listed = async () => {
      const outcome = await client.listThreads();
      if (outcome.kind !== 'ok') throw new Error(`列表失敗：${outcome.message}`);
      return outcome.result.items;
    };
    // 不 poll：前台的存放處看不到對話行程的寫入，靠轉送與全域下行標起來、重讀前請對話行程排空。
    // 漏了其中一環就要等 30 秒的背景重掃，這裡立刻就紅。
    await turn(client, 'thread-a', '第一條');
    expect((await listed()).map(({ threadId }) => threadId)).toEqual(['thread-a']);
    await turn(client, 'thread-b', '第二條');
    expect((await listed()).map(({ threadId }) => threadId)).toEqual(['thread-b', 'thread-a']);
    expect(await client.threadRename('thread-a', '改過的名字')).toMatchObject({
      kind: 'ok',
      result: { ok: true },
    });
    expect((await listed()).find(({ threadId }) => threadId === 'thread-a')?.title).toBe(
      '改過的名字',
    );
  }, 180_000);

  it('plugin 對照快照：前台列出對話行程裡活著的 thread（只看過歷史的也算），行程收掉就拿掉', async () => {
    const running = await start([{ content: '回覆。' }], '', undefined, [
      '--read-only-idle-ms',
      '1500',
    ]);
    const client = await clientOf(await running.loginUrl(1));
    const liveThreads = (): Promise<string[]> => liveThreadsOf(running.home);
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
      ['flush', 'POST'],
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

  it('搜之前排空的來回：活著的對話行程 0、1、4 條各搜 20 次，印出多花多少', async () => {
    // 量測用新起的一台：講過話的 thread 下行關掉後監督行程不收它，前面幾支留下的行程會混進「活著幾條」。
    // 只讀開的下行開著時行程不被收，關掉才收，所以用它控制活著的條數。
    const running = await start(
      [{ content: '回覆。' }],
      `- id: thread-search\n  config:\n    openAt: startup\n`,
    );
    const supervisor = running.child.pid!;
    const client = await clientOf(await running.loginUrl(1));
    const timed = async (): Promise<string> => {
      const took: number[] = [];
      for (let i = 0; i < 20; i += 1) {
        const began = performance.now();
        const outcome = await client.searchThreads('replymarker');
        took.push(performance.now() - began);
        if (outcome.kind !== 'ok') throw new Error(outcome.message);
      }
      took.sort((a, b) => a - b);
      return `中位數 ${String(Math.round(took[10]!))} ms、p95 ${String(Math.round(took[18]!))} ms`;
    };
    const flushCost: string[] = [];
    expect(await settled(supervisor, 'conversation-process', WARM)).toHaveLength(WARM);
    flushCost.push(`活著 0 條：${await timed()}`);
    const held: AbortController[] = [];
    for (const live of [1, 4]) {
      while (held.length < live) {
        const line = new AbortController();
        await client.openEvents(`thread-flush-${String(held.length)}`, { signal: line.signal });
        held.push(line);
      }
      expect(await settled(supervisor, 'conversation-process', live + WARM)).toHaveLength(
        live + WARM,
      );
      flushCost.push(`活著 ${String(live)} 條：${await timed()}`);
    }
    for (const line of held) line.abort();
    console.log(`[#2689 排空來回] ${flushCost.join('；')}`);
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

  it('宿主讀到的 host-plugins.json 壞了：宿主起不來，整台以 5 結束、stderr 寫明宿主設定壞了', async () => {
    // 啟動器會整份重寫 home 裡的清單，所以壞檔要在它寫完之後、監督行程起宿主之前蓋上去（包裝腳本）。
    const running = await start([], '', undefined, [], {
      beforeSupervisor: `printf '%s' '{ 不是 JSON' > "$NEXUS_AGENT_HOME/${HOST_PLUGINS_FILE}"`,
    });
    const code = await new Promise<number | null>((resolve) => running.child.once('exit', resolve));
    expect(code).toBe(5);
    expect(running.log()).toContain('宿主設定壞了');
  }, 180_000);

  it('home 底下的 host-plugins.json 是手放的壞檔：啟動器照環境重寫，整台照常起來', async () => {
    const running = await start([{ content: '好。' }], '', async (home) => {
      await writeFile(join(home, HOST_PLUGINS_FILE), '{ 不是 JSON', 'utf8');
    });
    const client = await clientOf(await running.loginUrl(1));
    expect(replies(await turn(client, 'thread-p', '你好'))).toEqual(['好。']);
    expect(running.log()).not.toContain('宿主設定壞了');
  }, 180_000);

  it('host-plugins.json 的位置被一個目錄佔住、清單寫不進去：serve 起不來，錯誤指名那個檔', async () => {
    const running = await start([], '', async (home) => {
      await mkdir(join(home, HOST_PLUGINS_FILE));
    });
    const code = await new Promise<number | null>((resolve) => running.child.once('exit', resolve));
    expect(code).not.toBe(0);
    expect(running.log()).toContain('寫不了宿主的插件清單');
    expect(running.log()).toContain(HOST_PLUGINS_FILE);
  }, 180_000);
});

/**
 * per-thread 下 MCP 連線在宿主那邊（#3000）。**這是 CI 上唯一證明對話行程走宿主的測試**：其他 per-thread 測試都沒掛 MCP，綠燈說明不了這件事。
 *
 * 量在行程樹上：stdio server 的子行程只有一個（兩條 thread 共用），它的父行程是宿主，不是任何一個對話行程。
 */
describe.skipIf(SUPERVISOR === undefined)('per-thread：MCP 經宿主連', () => {
  const FIXTURE = fileURLToPath(new URL('./mcp-fixture-server.ts', import.meta.url));
  const callOnce = (): ScriptedTurn[] => [
    { content: '', toolCalls: [{ name: 'mcp__crm__record_order', args: { item: 'x' } }] },
    { content: '收工' },
  ];

  const rowFor = (
    marker: string,
    env?: Record<string, unknown>,
    approval: 'allow' | 'ask' = 'allow',
  ): string =>
    [
      '- insert:',
      '    - id: mcp-crm',
      "      name: '@nexus/plugin-mcp'",
      `      config: ${JSON.stringify({
        serverName: 'crm',
        approval: { default: approval },
        connection: {
          transport: 'stdio',
          command: process.execPath,
          args: ['--import', TSX, FIXTURE, marker],
          ...(env !== undefined && { env }),
        },
      })}`,
      '',
    ].join('\n');

  const toolText = (state: ConversationState): string =>
    JSON.stringify(state.entries.filter((entry) => entry.kind === 'tool'));

  /** 命令列含記號的行程，與它們的父行程。 */
  function withMarker(marker: string): { pid: number; ppid: number }[] {
    const found: { pid: number; ppid: number }[] = [];
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/u.test(name)) continue;
      try {
        if (!readFileSync(`/proc/${name}/cmdline`, 'utf8').includes(marker)) continue;
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
        found.push({
          pid: Number(name),
          ppid: Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]),
        });
      } catch {
        // 行程已經結束。
      }
    }
    return found;
  }

  it('兩條 thread 叫同一列：只有一個 server 子行程，它是宿主的子行程；宿主被殺重起後，同一條 thread 還叫得到', async () => {
    const marker = `--marker-${String(Date.now())}-${String(process.pid)}`;
    const running = await start([...callOnce(), ...callOnce(), ...callOnce()], rowFor(marker));
    try {
      const supervisor = running.child.pid!;
      const client = await clientOf(await running.loginUrl(1));
      // 前台的試組不連線（#3031）：還沒有 thread 叫它之前，整台沒有任何一個 server。
      expect(withMarker(marker)).toEqual([]);
      expect(toolText(await turn(client, 'thread-m1', '動手'))).toContain('已登記：x');
      expect(toolText(await turn(client, 'thread-m2', '動手'))).toContain('已登記：x');
      const [host] = childrenRunning(supervisor, 'nexus-host');
      expect(host).toBeDefined();
      const servers = withMarker(marker).filter((item) => item.ppid === host);
      expect(servers).toHaveLength(1);
      // 整台只有宿主底下那一個：前台底下沒有（前台的試組有門面，不經連線池連）。
      expect(withMarker(marker)).toHaveLength(1);
      const fronts = childrenRunning(supervisor, 'front-process');
      expect(withMarker(marker).filter((item) => fronts.includes(item.ppid))).toEqual([]);
      const conversations = childrenRunning(supervisor, 'conversation-process');
      expect(withMarker(marker).filter((item) => conversations.includes(item.ppid))).toEqual([]);
      expect(childrenRunning(supervisor, 'conversation-process')).not.toContain(servers[0]?.ppid);

      signalPid(host!, 'SIGKILL');
      await expect
        .poll(
          () => childrenRunning(supervisor, 'nexus-host').filter((pid) => pid !== host).length,
          {
            timeout: 30_000,
          },
        )
        .toBe(1);
      // 宿主重起：對話行程重連、重新 open；同一條 thread 再叫一次拿得到結果。
      expect(toolText(await turn(client, 'thread-m1', '再動手'))).toContain('已登記：x');
    } catch (error) {
      // 對話行程起不來時，原因只記在監督行程的稽核檔與對話行程的 stderr：失敗訊息帶出來，不然只看得到「crash」。
      const audit = await readFile(join(running.home, SUPERVISOR_AUDIT_FILE), 'utf8').catch(
        () => '（沒有稽核檔）',
      );
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n--- serve 輸出 ---\n${running.log()}\n--- 監督行程稽核 ---\n${audit}`,
        { cause: error },
      );
    }
  }, 180_000);

  it('憑證值出現在工具結果裡時被遮：受管憑證經宿主起的 server 環境交進去，成功結果回出來時不含原值', async () => {
    const secret = 'zq8t7-managed-0123456789';
    const termMarker = `--marker-${String(Date.now())}-${String(process.pid)}`;
    const row = rowFor(termMarker, { MCP_TOKEN: { credential: 'NEXUS_TEST_T7' } });
    const running = await start(
      [
        {
          content: '',
          toolCalls: [{ name: 'mcp__crm__read_env', args: { names: ['MCP_TOKEN'] } }],
        },
        { content: '收工' },
      ],
      row,
      async (home) => {
        const file = join(home, CREDENTIALS_FILE);
        await writeFile(file, `version: 1\nrefs:\n  NEXUS_TEST_T7: ${secret}\n`, { mode: 0o600 });
      },
    );
    const client = await clientOf(await running.loginUrl(1));
    const text = toolText(await turn(client, 'thread-m1', '動手'));
    expect(text).toContain('MCP_TOKEN=[redacted]');
    expect(text).not.toContain(secret);
  }, 180_000);

  it('停機整條路：對監督行程送 SIGTERM，整台結束碼 0、宿主結束碼 0，server 收到 SIGTERM 且已不在，稽核裡沒有送過 SIGKILL 的 sweep', async () => {
    const termDir = await mkdtemp(join(tmpdir(), 'nexus-mcp-term-'));
    roots.push(termDir);
    const marker = `--marker-${String(Date.now())}-${String(process.pid)}`;
    const running = await start(callOnce(), rowFor(marker, { FIXTURE_TERM_DIR: termDir }));
    const exit = new Promise<number | null>((resolve) => {
      running.child.once('exit', (code) => {
        resolve(code);
      });
    });
    const client = await clientOf(await running.loginUrl(1));
    expect(toolText(await turn(client, 'thread-m1', '動手'))).toContain('已登記：x');
    const serverPid = Number(await readFile(join(termDir, 'pid'), 'utf8'));
    running.child.kill('SIGTERM');
    expect(await exit).toBe(0);
    const audit = (await readFile(join(running.home, SUPERVISOR_AUDIT_FILE), 'utf8'))
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const host = audit.find((line) => line['role'] === 'host' && line['event'] === undefined);
    expect(host).toMatchObject({ exit_code: 0, signal: null });
    expect(await readFile(join(termDir, 'term'), 'utf8')).toBe('SIGTERM');
    expect(() => process.kill(serverPid, 0)).toThrow();
    const swept = audit.filter((line) => line['event'] === 'sweep');
    expect(swept.every((line) => (line['signalled'] as number[]).length === 0)).toBe(true);
  }, 180_000);

  it('宿主被殺、補不回來：下一次工具呼叫等到重新綁定的期限就回斷線，這一輪照常講完', async () => {
    const marker = `--marker-${String(Date.now())}-${String(process.pid)}`;
    // 宿主重起前的等待拉到比測試長：被殺之後整個測試期間都沒有宿主，呼叫只能等到期限。
    const running = await start([...callOnce(), ...callOnce()], rowFor(marker), undefined, [
      '--host-backoff-ms',
      '120000',
    ]);
    const supervisor = running.child.pid!;
    const client = await clientOf(await running.loginUrl(1));
    expect(toolText(await turn(client, 'thread-w', '動手'))).toContain('已登記：x');
    const lines = (text: string): number => running.log().split(text).length - 1;
    await settled(supervisor, 'conversation-process', 1 + WARM);
    await expect.poll(() => lines('[宿主] 連上了'), { timeout: 20_000 }).toBe(1 + WARM);
    const [host] = childrenRunning(supervisor, 'nexus-host');
    expect(host).toBeDefined();
    signalPid(host!, 'SIGKILL');
    // 等對話行程都看到斷線才叫工具：搶在那之前送出的呼叫會以「送出後連線斷了」收尾，走不到等綁定的期限。
    await expect.poll(() => lines('[宿主] 斷線'), { timeout: 20_000 }).toBe(1 + WARM);

    const started = Date.now();
    const state = await turn(client, 'thread-w', '再動手');
    const elapsed = Date.now() - started;
    const tools = state.entries.filter((entry) => entry.kind === 'tool');
    expect(tools).toHaveLength(1);
    expect(toolText(state)).toContain('server is disconnected');
    expect(replies(state)).toContain('收工');
    expect(childrenRunning(supervisor, 'nexus-host')).toEqual([]);
    // 期限從呼叫進來算一次：等綁定與等宿主連線不疊加，所以整輪落在一倍到兩倍之間。
    expect(elapsed).toBeGreaterThanOrEqual(DEFAULT_REBIND_WAIT_MS - 500);
    expect(elapsed).toBeLessThan(2 * DEFAULT_REBIND_WAIT_MS);
  }, 180_000);

  it('要問的工具經宿主連照樣先問：核准前 server 沒收到呼叫，核准後才收到、結果回得來', async () => {
    const logDir = await mkdtemp(join(tmpdir(), 'nexus-mcp-calls-'));
    roots.push(logDir);
    const callLog = join(logDir, 'calls.log');
    const marker = `--marker-${String(Date.now())}-${String(process.pid)}`;
    const running = await start(callOnce(), rowFor(marker, { FIXTURE_CALL_LOG: callLog }, 'ask'));
    const client = await clientOf(await running.loginUrl(1));
    const thread = 'thread-ask';
    const events = await client.openEvents(thread);
    await client.runStart(thread, '動手');
    let state = emptyConversation();
    const until = async (done: (state: ConversationState) => boolean): Promise<void> => {
      while (!done(state)) {
        const next = await events.next();
        if (next.done === true) throw new Error('下行斷了，還沒走到');
        state = reduceConversation(state, next.value);
      }
    };
    const finished = (now: ConversationState): boolean =>
      now.status === 'idle' && replies(now).includes('收工');
    // 沒被問就一路跑完的走錯路也要停得下來，由下面的斷言指出，不等到逾時。
    await until((now) => now.pendings.some(isApprovalPending) || finished(now));
    const approval = approvalAt(state.pendings);
    expect(approval.actions.map((action) => action.name)).toEqual(['mcp__crm__record_order']);
    expect(existsSync(callLog)).toBe(false);

    expect(
      await client.inputRespond(thread, {
        namespace: [...approval.namespace],
        interrupt_id: approval.interruptId,
        response: uniformDecisions(approval, 'approve'),
      }),
    ).not.toHaveProperty('error');
    await until(finished);
    await events.return?.(undefined);
    expect(toolText(state)).toContain('已登記：x');
    expect(readFileSync(callLog, 'utf8')).toBe('record_order\n');
  }, 180_000);
});

/**
 * native 下對話只從日誌推（[#2360](https://github.com/DemianLi/nexus-agent/issues/2360)），per-thread 那一半：single 的在 `native-log-restore.test.ts`。
 *
 * 對話行程換了一個（pid 不同），行程內的快取就一定是空的；下一輪模型收到的請求帶著前一個行程那一輪的人話（那一輪答完了的連同回覆），就是從日誌灌回的。
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

    /** 主呼叫裡最後一則人話含 `prompt` 的那一次，回它每一則（系統以外）。 */
    function messagesFor(upstream: FakeEndpoint, prompt: string): WireMessage[] {
      const body = upstream.bodies.findLast(
        (candidate) => isMainCall(candidate) && textOf(candidate.messages.at(-1)!).includes(prompt),
      );
      if (body === undefined) throw new Error(`模型沒收到「${prompt}」那一次`);
      return body.messages.filter((message) => message.role !== 'system');
    }

    /** {@link messagesFor} 的每一則寫成「角色:文字」。 */
    function requestFor(upstream: FakeEndpoint, prompt: string): string[] {
      return messagesFor(upstream, prompt).map((message) => `${message.role}:${textOf(message)}`);
    }

    async function upstream(
      hold?: (body: Body) => boolean,
      script: (k: number) => Reply = (k) => ({ content: `第 ${k} 次回覆` }),
    ): Promise<FakeEndpoint> {
      const endpoint = await fakeEndpoint(mainOnly(script), true, hold);
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

    /** 監督行程的稽核紀錄裡這個 pid 結束的那一行（事件行與還沒寫完的殘行不算）；還沒寫就是 `undefined`。 */
    function auditOf(home: string, pid: number): Record<string, unknown> | undefined {
      let text: string;
      try {
        text = readFileSync(join(home, SUPERVISOR_AUDIT_FILE), 'utf8');
      } catch {
        return undefined;
      }
      for (const line of text.split('\n')) {
        let record: Record<string, unknown>;
        try {
          record = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (record.event === undefined && record.pid === pid) return record;
      }
      return undefined;
    }

    const argvOf = (pid: number): string[] =>
      readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8').split('\0');

    it.skipIf(COMPOSITION === undefined)(
      '一對：葉子在等模型時被殺，留著的組合行程補新葉子，下一句從日誌接上（#2806）',
      async () => {
        const THREAD = 'thread-pair-kill';
        // 第一次主呼叫扣住不回：葉子停在等模型，日誌上有那句人話與開著的 `model/start`。扣住的那一刻由這裡看到，不靠等時間。
        let waiting = true;
        let reached!: () => void;
        const held = new Promise<void>((resolve) => {
          reached = resolve;
        });
        const model = await upstream((body) => {
          if (!waiting || !isMainCall(body)) return false;
          waiting = false;
          reached();
          return true;
        });
        const running = await start([], '', undefined, ['--composition', COMPOSITION!], {
          liveBaseUrl: model.baseURL,
          serveArgs: NATIVE,
        });
        const supervisor = running.child.pid!;
        const client = await clientOf(await running.loginUrl(1));
        // 送第一句之前只有預熱的那一對；綁上這條 thread 的就是它的葉子（下面用稽核那一行的 `thread` 核對）。
        const warm = await settled(supervisor, 'conversation-process', WARM);
        expect(warm).toHaveLength(WARM);
        const killed = warm[0]!;
        const compositions = childrenRunning(supervisor, 'nexus-composition');
        expect(compositions).toHaveLength(WARM);

        const downlink = new AbortController();
        await client.openEvents(THREAD, { signal: downlink.signal });
        await client.runStart(THREAD, '暗號是藍鯨');
        await Promise.race([
          held,
          new Promise<never>((_resolve, reject) =>
            setTimeout(
              () => reject(new Error(`60 秒內模型沒收到第一次主呼叫：\n${running.log()}`)),
              60_000,
            ).unref(),
          ),
        ]);
        // 前台收到 `down` 會了結這條 thread 所有在等的 `ensure`，連 `down` 之後才問的也算。所以下一句要等前台處理過舊葉子的 `down` 才送：
        // 快照先列出這條，殺掉之後等它被拿掉。
        await expect.poll(() => liveThreadsOf(running.home), { timeout: 30_000 }).toEqual([THREAD]);
        expect(signalPid(killed, 'SIGKILL')).toBe(true);
        await expect.poll(() => liveThreadsOf(running.home), { timeout: 30_000 }).toEqual([]);

        // 監督行程收屍時先寫稽核那一行才送 `down`：前台處理過 `down`，這一行就已經在了。收完屍之後的 `ensure` 才會補葉子。
        const record = auditOf(running.home, killed);
        expect(record).toMatchObject({
          role: 'conversation',
          thread: THREAD,
          cause: 'crash',
          exit_code: null,
          signal: 9,
        });
        const bridge = `c${String(record?.pair)}.p.sock`;
        downlink.abort();

        // 扣住的那一次不進 `bodies`、不佔 `mainOnly` 的號，所以這一句拿到的是第 0 次回覆。
        expect(replies(await turn(client, THREAD, '剛才的暗號是什麼'))).toEqual(['第 0 次回覆']);
        // 被殺的那一輪沒有回覆，續接補上的收尾不進模型：系統訊息以外，模型看到的是兩句人話，前一句來自日誌。
        expect(requestFor(model, '剛才的暗號是什麼')).toEqual([
          expect.stringContaining('暗號是藍鯨'),
          expect.stringContaining('剛才的暗號是什麼'),
        ]);

        // 補的是葉子，不是整對：組合行程一個都沒換，新葉子接在同一條橋後面。
        expect(
          childrenRunning(supervisor, 'conversation-process').filter((pid) =>
            argvOf(pid).some((arg) => arg.endsWith(`/${bridge}`)),
          ),
        ).toHaveLength(1);
        for (const pid of compositions) {
          expect(auditOf(running.home, pid)).toBeUndefined();
        }
        expect(childrenRunning(supervisor, 'nexus-composition')).toEqual(
          expect.arrayContaining(compositions),
        );
      },
      240_000,
    );

    /**
     * 外掛的工具：建一個檔、然後不返回。純物件、不 import 任何套件（只在執行時載入 node 內建）：home 在暫存目錄，從那裡解析不到 `zod` 與 `@langchain/core`。
     * 檔出現的時候 `tool/call` 已經落盤（工具本體之前先排空這條 thread 的日誌），所以可以看著它殺（耐久檢查點開著時，預設如此）。
     * `parameters` 要自帶 `$schema` 且鍵序同上線的位元組（`@nexus/tool-adapter` 轉一圈比對，不同就拒；`additionalProperties: false` 由它補）。
     */
    const HANG_PROBE = [
      'export default {',
      "  name: 'probe',",
      '  apply(registry, config) {',
      '    registry.tools.register({',
      "      name: 'hang',",
      "      description: '建一個檔，然後不返回。',",
      '      parameters: {',
      "        $schema: 'https://json-schema.org/draft/2020-12/schema',",
      "        type: 'object',",
      '        properties: {},',
      '      },',
      '      async execute() {',
      "        const { writeFileSync } = await import('node:fs');",
      "        writeFileSync(config.marker, '');",
      '        return new Promise(() => {});',
      '      },',
      '    });',
      '  },',
      '};',
      '',
    ].join('\n');

    it.skipIf(COMPOSITION === undefined)(
      '一對：葉子在跑工具時被殺，補上的結果說「結果不明」，工具不重跑（#2806）',
      async () => {
        const THREAD = 'thread-pair-kill-in-tool';
        // 第一次主呼叫叫 `hang`，之後回文字；工具那一輪沒有第二次主呼叫，所以第二句拿到的是第 1 次回覆。
        const model = await upstream(undefined, (k) =>
          k === 0
            ? { tools: [{ id: 'call-hang', name: 'hang', args: {} }] }
            : { content: `第 ${k} 次回覆` },
        );
        let marker = '';
        const running = await start(
          [],
          '',
          async (home) => {
            marker = join(home, 'hang.marker');
            await writeFile(join(home, 'probe.ts'), HANG_PROBE, { mode: 0o600 });
            seedHomePatch(
              home,
              `- insert:\n    - id: probe\n      name: './probe.ts'\n      config:\n        marker: ${marker}\n`,
            );
          },
          ['--composition', COMPOSITION!],
          { liveBaseUrl: model.baseURL, serveArgs: NATIVE },
        );
        const supervisor = running.child.pid!;
        const client = await clientOf(await running.loginUrl(1));
        const warm = await settled(supervisor, 'conversation-process', WARM);
        expect(warm).toHaveLength(WARM);
        const killed = warm[0]!;
        const compositions = childrenRunning(supervisor, 'nexus-composition');
        expect(compositions).toHaveLength(WARM);

        const downlink = new AbortController();
        await client.openEvents(THREAD, { signal: downlink.signal });
        await client.runStart(THREAD, '暗號是藍鯨，然後呼叫 hang');
        // 檔出現就是工具本體已經開始跑。沒出現先看葉子的 stderr（工具有沒有載入、模型有沒有叫它、會不會停在核准閘門）。
        try {
          await expect.poll(() => existsSync(marker), { timeout: 60_000 }).toBe(true);
        } catch (error: unknown) {
          throw new Error(`60 秒內工具沒開始跑：\n${running.log()}`, { cause: error });
        }
        // 刪掉它：之後再出現就是續接把工具重跑了。
        rmSync(marker);

        // 前台收到 `down` 會了結這條 thread 所有在等的 `ensure`，所以下一句要等前台處理過舊葉子的 `down`。
        await expect.poll(() => liveThreadsOf(running.home), { timeout: 30_000 }).toEqual([THREAD]);
        expect(signalPid(killed, 'SIGKILL')).toBe(true);
        await expect.poll(() => liveThreadsOf(running.home), { timeout: 30_000 }).toEqual([]);

        const record = auditOf(running.home, killed);
        expect(record).toMatchObject({
          role: 'conversation',
          thread: THREAD,
          cause: 'crash',
          exit_code: null,
          signal: 9,
        });
        const bridge = `c${String(record?.pair)}.p.sock`;
        downlink.abort();

        expect(replies(await turn(client, THREAD, '剛才的暗號是什麼'))).toEqual(['第 1 次回覆']);
        // `tool/call` 落了盤，續接補的是「結果不明」，不是「沒開始」。
        const messages = messagesFor(model, '剛才的暗號是什麼');
        expect(messages.map((message) => message.role)).toEqual([
          'user',
          'assistant',
          'tool',
          'user',
        ]);
        expect(textOf(messages[0]!)).toContain('暗號是藍鯨');
        const calls = messages[1]!.tool_calls as { function: { name: string } }[] | undefined;
        expect(calls?.map((call) => call.function.name)).toEqual(['hang']);
        expect(textOf(messages[2]!)).toContain(TOOL_OUTCOME_UNKNOWN_TEXT);
        expect(textOf(messages[2]!)).not.toContain(TOOL_NOT_STARTED_TEXT);
        expect(textOf(messages[3]!)).toContain('剛才的暗號是什麼');
        expect(existsSync(marker)).toBe(false);

        expect(
          childrenRunning(supervisor, 'conversation-process').filter((pid) =>
            argvOf(pid).some((arg) => arg.endsWith(`/${bridge}`)),
          ),
        ).toHaveLength(1);
        for (const pid of compositions) {
          expect(auditOf(running.home, pid)).toBeUndefined();
        }
        expect(childrenRunning(supervisor, 'nexus-composition')).toEqual(
          expect.arrayContaining(compositions),
        );
      },
      240_000,
    );
  },
);

describe.skipIf(SUPERVISOR === undefined || COMPOSITION === undefined)(
  'per-thread：一對（組合行程加葉子，#2769）',
  () => {
    it('前台的請求經組合行程轉到葉子，這一輪照常答；葉子帶 --pair-socket，組合行程在監督行程底下', async () => {
      const running = await start([{ content: '經橋綁上的回覆。' }], '', undefined, [
        '--composition',
        COMPOSITION!,
      ]);
      const supervisor = running.child.pid!;
      const client = await clientOf(await running.loginUrl(1));

      expect(replies(await turn(client, 'thread-pair', '你好'))).toEqual(['經橋綁上的回覆。']);

      const leaves = childrenRunning(supervisor, 'conversation-process');
      expect(leaves.length).toBeGreaterThan(0);
      for (const pid of leaves) {
        expect(readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8').split('\0')).toContain(
          '--pair-socket',
        );
      }
      expect(childrenRunning(supervisor, 'nexus-composition').length).toBeGreaterThan(0);
    }, 180_000);
  },
);

const COLD_START_SAMPLES = 5;

/**
 * 起一個對話行程（不經監督行程），量從 `spawn` 到收到 `ready` 的毫秒數，量完收掉。
 * 跑的是原始碼（`node --import tsx`），模型是腳本、沒有外掛，環境只有 `PATH`、暫存的 home 與 {@link SOURCE_PATHS}。
 */
async function coldStartMs(loop: 'default' | 'native'): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), 'nexus-cold-start-'));
  roots.push(dir);
  const sockets = join(dir, 'sockets');
  await mkdir(sockets, { mode: 0o700 });
  const patch = join(dir, 'script.patch.yml');
  await writeFile(patch, scriptedPatchText([{ content: '回覆。' }]), 'utf8');
  const home = join(dir, 'home');
  const startedAt = performance.now();
  const child = spawn(
    process.execPath,
    [
      '--import',
      TSX,
      fileURLToPath(new URL('./conversation-process.ts', import.meta.url)),
      '--socket',
      join(sockets, 'wire.sock'),
      '--patch',
      patch,
      ...(loop === 'native' ? ['--agent-loop', 'native'] : []),
    ],
    {
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        NEXUS_AGENT_HOME: join(home, 'harness-home'),
        ...SOURCE_PATHS,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  children.push(child);
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const exited = new Promise<never>((_resolve, reject) =>
    child.once('exit', (code) =>
      reject(new Error(`對話行程先結束了（exit ${String(code)}）：\n${stderr}`)),
    ),
  );
  const ready = new Promise<number>((resolve) => {
    let pending: Buffer = Buffer.alloc(0);
    child.stdout?.on('data', (chunk: Buffer) => {
      const taken = takeFrames(Buffer.concat([pending, chunk]));
      pending = taken.rest;
      for (const payload of taken.frames) {
        if (decodeConversationReport(payload).type === 'ready')
          resolve(performance.now() - startedAt);
      }
    });
  });
  child.stdin?.write(
    frame(
      encodeConversationCommand({
        type: 'hello',
        version: PROTOCOL_VERSION,
        token: '00112233445566778899aabbccddeeff',
      }),
    ),
  );
  const elapsed = await Promise.race([
    ready,
    exited,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`60 秒內沒有 ready：\n${stderr}`)), 60_000).unref(),
    ),
  ]);
  child.stdin?.end();
  await new Promise((resolve) => child.once('exit', resolve));
  return elapsed;
}

/**
 * 冷起動量測（#2852）：給監督行程的 `--start-timeout-ms` 預設值一個有出處的數字。只印、不設門檻；樣本沒等到 `ready`（行程先結束或 60 秒逾時）就失敗。
 * 每個 loop 依序起 {@link COLD_START_SAMPLES} 個、各用新的暫存目錄，照順序印原始數字。tsx 的轉譯快取在 `/tmp/tsx-<uid>`（子行程沒有 `TMPDIR`），
 * 跨樣本、跨次都保留，所以沒有一個樣本是全冷的；第一個之後還多吃到同一輪的檔案快取。條件跟同檔其他測試一樣：只在有監督行程執行檔的 job 跑。
 */
describe.skipIf(SUPERVISOR === undefined)('per-thread：對話行程冷起動量測（#2852）', () => {
  for (const loop of ['default', 'native'] as const) {
    it(`loop=${loop}：起行程到 ready，依序 ${String(COLD_START_SAMPLES)} 次`, async () => {
      const samples: number[] = [];
      for (let index = 0; index < COLD_START_SAMPLES; index += 1) {
        samples.push(Math.round(await coldStartMs(loop)));
      }
      console.log(
        `[#2852 冷起動] arch=${process.arch} loop=${loop} 起行程到 ready（依序，ms）[${samples.join(',')}]`,
      );
      expect(samples).toHaveLength(COLD_START_SAMPLES);
    }, 300_000);
  }
});
