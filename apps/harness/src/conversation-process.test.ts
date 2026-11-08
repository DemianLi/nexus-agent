/**
 * 對話行程整支跑起來（[#2338](https://github.com/DemianLi/nexus-agent/issues/2338)）：子行程起 `conversation-process.ts`，模型換成腳本
 * （`scripted-serve.ts` 那份 patch），控制面在 stdin／stdout，wire 經 Unix socket 打。情境同 `apps/web/e2e/conversation.e2e.ts`
 * （#1602）：一般回覆串完、核准中斷按核准後這一輪結束；另外量控制面的框、stdout 只有框、分叉回 `not_supported`、EOF 回 0。
 *
 * 跑的是原始碼（`node --import tsx`），同 `entry-main.test.ts`。子行程的環境只有 `PATH`、暫存的 home 與 {@link SOURCE_PATHS}，讀不到 `.env`。
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { appendDecision, createWireClient, uniformDecisions } from '@nexus/wire';
import type { AiEntry, ConversationState, WireClient } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { approvalAt, foldTurn } from './fixtures.js';
import type { ScriptedTurn } from './scripted-model.js';
import { scriptedPatchText } from './scripted-serve.js';
import {
  decodeConversationReport,
  encodeConversationCommand,
  frame,
  PROTOCOL_VERSION,
  takeFrames,
} from './supervisor-protocol.js';
import type { ConversationCommand, ConversationReport } from './supervisor-protocol.js';

const ENTRY = fileURLToPath(new URL('./conversation-process.ts', import.meta.url));
/** cwd 是暫存目錄，`--import tsx` 照 cwd 解析會找不到，給絕對位置。 */
const TSX = import.meta.resolve('tsx');
const THREAD = 'conversation-e2e';
/**
 * vitest 主行程設的 `TSX_TSCONFIG_PATH`（`vitest.shared.ts` 的 `sourceHook`）：子行程的 tsx 照它把 `@nexus/*` 解到 `src/`。
 * 環境是自己給的，不帶的話會解到 `lib/`，乾淨的樹（CI）上沒有 `lib/`。
 */
const SOURCE_PATHS =
  process.env.TSX_TSCONFIG_PATH === undefined
    ? {}
    : { TSX_TSCONFIG_PATH: process.env.TSX_TSCONFIG_PATH };
/** `vitest.native.config.ts` 設的：子行程跑哪個 agent loop（#2356）。沒設就照出廠。 */
const AGENT_LOOP =
  process.env.NEXUS_TEST_AGENT_LOOP === undefined
    ? []
    : ['--agent-loop', process.env.NEXUS_TEST_AGENT_LOOP];

/** 經 Unix socket 的 `fetch`：wire client 照常用，只是連線走 `socketPath`。 */
function socketFetch(socketPath: string): typeof globalThis.fetch {
  return async (input, init) => {
    const outgoing = new Request(input, init);
    const body = outgoing.body === null ? undefined : Buffer.from(await outgoing.arrayBuffer());
    const url = new URL(outgoing.url);
    return new Promise<Response>((resolve, reject) => {
      const req = request(
        {
          socketPath,
          method: outgoing.method,
          path: `${url.pathname}${url.search}`,
          headers: Object.fromEntries(outgoing.headers),
        },
        (res) => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (value !== undefined)
              headers.set(name, Array.isArray(value) ? value.join(', ') : value);
          }
          const status = res.statusCode ?? 0;
          const stream = status === 204 || status === 304 ? null : Readable.toWeb(res);
          resolve(new Response(stream as globalThis.ReadableStream | null, { status, headers }));
        },
      );
      req.on('error', reject);
      outgoing.signal.addEventListener('abort', () => req.destroy(outgoing.signal.reason as Error));
      req.end(body);
    });
  };
}

interface Running {
  readonly child: ChildProcess;
  readonly client: WireClient;
  /** 下一則控制面回報（略過心跳）。 */
  next(): Promise<ConversationReport>;
  send(command: ConversationCommand): void;
  /** 到目前為止 stdout 解完框之後剩下的位元組數。 */
  leftover(): number;
  stderr(): string;
  /** 關 stdin、等行程結束，回退出碼。 */
  end(): Promise<number | null>;
}

const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function start(turns: readonly ScriptedTurn[]): Promise<Running> {
  const dir = await mkdtemp(join(tmpdir(), 'nexus-conversation-process-'));
  roots.push(dir);
  const sockets = join(dir, 'sockets');
  await mkdir(sockets, { mode: 0o700 });
  const socketPath = join(sockets, 'wire.sock');
  const patch = join(dir, 'script.patch.yml');
  await writeFile(patch, scriptedPatchText(turns), 'utf8');
  const home = join(dir, 'home');
  const child = spawn(
    process.execPath,
    ['--import', TSX, ENTRY, '--socket', socketPath, '--patch', patch, ...AGENT_LOOP],
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
  child.stdin?.write(
    frame(
      encodeConversationCommand({
        type: 'hello',
        version: PROTOCOL_VERSION,
        token: '00112233445566778899aabbccddeeff',
      }),
    ),
  );
  let pending: Buffer = Buffer.alloc(0);
  const reports: ConversationReport[] = [];
  const waiters: ((report: ConversationReport) => void)[] = [];
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    const taken = takeFrames(Buffer.concat([pending, chunk]));
    pending = taken.rest;
    for (const payload of taken.frames) {
      const report = decodeConversationReport(payload);
      if (report.type === 'heartbeat' || report.type === 'hello') continue;
      const waiter = waiters.shift();
      if (waiter === undefined) reports.push(report);
      else waiter(report);
    }
  });
  const exited = new Promise<number | null>((resolve) =>
    child.once('exit', (code) => resolve(code)),
  );
  const next = (): Promise<ConversationReport> => {
    const ready = reports.shift();
    if (ready !== undefined) return Promise.resolve(ready);
    return Promise.race([
      new Promise<ConversationReport>((resolve) => waiters.push(resolve)),
      exited.then((code) => {
        throw new Error(`對話行程先結束了（exit ${String(code)}）：\n${stderr}`);
      }),
    ]);
  };
  return {
    child,
    client: createWireClient({ baseUrl: 'http://localhost', fetch: socketFetch(socketPath) }),
    next,
    send: (command) => child.stdin?.write(frame(encodeConversationCommand(command))),
    leftover: () => pending.length,
    stderr: () => stderr,
    end: async () => {
      child.stdin?.end();
      return exited;
    },
  };
}

/** 起好、綁好：`ready` 再 `bind`、等 `bound`。 */
async function bound(turns: readonly ScriptedTurn[]): Promise<Running> {
  const running = await start(turns);
  expect(await running.next()).toEqual({ type: 'ready' });
  running.send({ type: 'bind', threadId: THREAD });
  expect(await running.next()).toEqual({ type: 'bound', threadId: THREAD });
  return running;
}

/** 這一輪的回報，略過閒置那幾則（輪詢的時機不固定）。 */
async function nextTurnReport(running: Running): Promise<ConversationReport> {
  for (;;) {
    const report = await running.next();
    if (report.type === 'turn') return report;
  }
}

const replies = (state: ConversationState): string[] =>
  state.entries
    .filter((entry): entry is AiEntry => entry.kind === 'ai' && !entry.streaming)
    .map((entry) => entry.text);

describe('對話行程經 Unix socket 跑一整段對話', () => {
  it('一般回覆串完；控制面送一輪的開始與結束，stdout 只有框，日誌在 stderr，EOF 回 0', async () => {
    const reply = '這是一段分好幾塊串過來的腳本回覆。';
    const running = await bound([{ content: reply, tokenDelayMs: 20 }]);
    const events = await running.client.openEvents(THREAD);
    await running.client.runStart(THREAD, '你好');
    const state = await foldTurn(events);
    await events.return?.(undefined);
    expect(replies(state)).toEqual([reply]);
    expect(await nextTurnReport(running)).toEqual({ type: 'turn', phase: 'begin' });
    expect(await nextTurnReport(running)).toEqual({ type: 'turn', phase: 'end' });
    expect(await running.end()).toBe(0);
    expect(running.leftover()).toBe(0);
    expect(running.stderr()).toContain('nexus-agent 對話行程在');
  }, 120_000);

  it('核准中斷，按核准後這一輪結束', async () => {
    const running = await bound([
      {
        content: '我把這一筆寫進去。',
        toolCalls: [
          { name: 'submit_record', args: { file_path: '/visitors.csv', record: { 姓名: '阿明' } } },
        ],
      },
      { content: '已經寫進 /visitors.csv。' },
    ]);
    const events = await running.client.openEvents(THREAD);
    await running.client.runStart(THREAD, '幫我登記阿明');
    let state = await foldTurn(events);
    const pending = approvalAt(state.pendings);
    expect(pending.namespace).toEqual([]);
    await running.client.inputRespond(THREAD, {
      namespace: [...pending.namespace],
      interrupt_id: pending.interruptId,
      response: uniformDecisions(pending, 'approve'),
    });
    state = await foldTurn(events, appendDecision(state, pending.interruptId, 'approve'));
    await events.return?.(undefined);
    expect(replies(state)).toContain('已經寫進 /visitors.csv。');
    expect(state.pendings).toEqual([]);
    expect(await running.end()).toBe(0);
  }, 120_000);

  it('分叉：回 not_supported，新 thread 要另起一個行程', async () => {
    const running = await bound([{ content: '第一輪。' }]);
    const events = await running.client.openEvents(THREAD);
    await running.client.runStart(THREAD, '你好');
    const state = await foldTurn(events);
    await events.return?.(undefined);
    const root = state.entries.find((entry): entry is AiEntry => entry.kind === 'ai');
    if (root === undefined) throw new Error('沒有回覆可以分叉');
    const outcome = await running.client.threadFork(THREAD, root.id);
    expect(outcome).toEqual({
      kind: 'rejected',
      code: 'not_supported',
      message: expect.any(String),
    });
    expect(await running.end()).toBe(0);
  }, 120_000);

  it('socket 目錄不是 0700：起不來、退出碼 1', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nexus-conversation-process-'));
    roots.push(dir);
    const sockets = join(dir, 'sockets');
    await mkdir(sockets, { mode: 0o755 });
    const child = spawn(
      process.execPath,
      ['--import', TSX, ENTRY, '--socket', join(sockets, 'wire.sock')],
      {
        cwd: dir,
        env: { PATH: process.env.PATH ?? '', HOME: dir, ...SOURCE_PATHS },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    children.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    expect(code).toBe(1);
    expect(stderr).toContain('要恰好 700');
    expect(stdout).toBe('');
  }, 60_000);
});
