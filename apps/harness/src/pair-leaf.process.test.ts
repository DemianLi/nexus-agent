/**
 * 一對裡的葉子整支跑起來（[#2769](https://github.com/DemianLi/nexus-agent/issues/2769)）：子行程起真的 `conversation-process.ts`
 * 加 `--pair-socket`，橋那一端是這個測試用 TS 寫的**假組合行程**（`pair-protocol.ts` 的編解碼；握手、登記、`attach` 的順序照
 * `pair_protocol.rs` 檔頭），不是真的 `nexus-composition`。真的組合行程對真的葉子在 `pair-conversation.integration.test.ts`
 * （要 Linux 與 `nexus-composition` 執行檔）。這支量的是葉子自己的行為：連橋、登記、收 `attach`、橋斷時結束，不要 Linux。
 *
 * 跑的是原始碼（`node --import tsx`），子行程環境同 `conversation-process.test.ts`。
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PAIR_ATTACH_METHOD,
  PAIR_PROTOCOL_VERSION,
  PairFrameReader,
  decodePairMessage,
  encodePairMessage,
} from '@nexus/host-bridge';
import type { PairMessage } from '@nexus/host-bridge';
import { afterEach, describe, expect, it } from 'vitest';

import { BRIDGE_LOST_EXIT_CODE } from './pair-leaf.js';
import { scriptedPatchText } from './scripted-serve.js';
import {
  decodeConversationReport,
  encodeConversationCommand,
  frame,
  PROTOCOL_VERSION,
  takeFrames,
} from './supervisor-protocol.js';
import type { ConversationReport } from './supervisor-protocol.js';

const ENTRY = fileURLToPath(new URL('./conversation-process.ts', import.meta.url));
const TSX = import.meta.resolve('tsx');
const SOURCE_PATHS =
  process.env.TSX_TSCONFIG_PATH === undefined
    ? {}
    : { TSX_TSCONFIG_PATH: process.env.TSX_TSCONFIG_PATH };
const AGENT_LOOP =
  process.env.NEXUS_TEST_AGENT_LOOP === undefined
    ? []
    : ['--agent-loop', process.env.NEXUS_TEST_AGENT_LOOP];
const THREAD = 'pair-leaf-e2e';
/** 一件一定會發生的事最多等這麼久；正常幾百毫秒，到了就是壞了。 */
const GUARD_MS = 30_000;

/** 假的組合行程：一條連線，記下葉子送來的每一框；`attach`、`cut` 由測試驅動。 */
class FakeComposition {
  readonly received: PairMessage[] = [];
  /** 等不到時附在錯誤訊息後面的：葉子的 stderr。 */
  diagnose: () => string = () => '';
  #server: Server;
  #socket: Socket | undefined;
  #waiters: (() => void)[] = [];
  #replied = false;
  #nextCall = 1;

  private constructor(server: Server) {
    this.#server = server;
  }

  static async listen(path: string): Promise<FakeComposition> {
    const server = createServer();
    const fake = new FakeComposition(server);
    server.on('connection', (socket) => fake.#accept(socket));
    await new Promise<void>((resolve) => server.listen(path, resolve));
    return fake;
  }

  #accept(socket: Socket): void {
    this.#socket = socket;
    const reader = new PairFrameReader();
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      for (const payload of reader.push(chunk)) {
        const message = decodePairMessage(payload);
        this.received.push(message);
        // 驗過葉子（真的組合行程在這裡核 SO_PEERCRED 的 pid）才回 hello。
        if (message.type === 'hello' && !this.#replied) {
          this.#replied = true;
          this.#write({ type: 'hello', version: PAIR_PROTOCOL_VERSION });
        }
        for (const waiter of this.#waiters.splice(0)) waiter();
      }
    });
  }

  #write(message: PairMessage): void {
    const body = encodePairMessage(message);
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    this.#socket?.write(Buffer.concat([head, body]));
  }

  /** 等到葉子送來符合的一框（已經收到的也算）。 */
  async until(match: (message: PairMessage) => boolean): Promise<PairMessage> {
    const deadline = Date.now() + GUARD_MS;
    for (;;) {
      const found = this.received.find(match);
      if (found !== undefined) return found;
      if (Date.now() > deadline) {
        throw new Error(
          `等不到葉子送來的框，收到：${JSON.stringify(this.received)}\n${this.diagnose()}`,
        );
      }
      await new Promise<void>((resolve) => {
        this.#waiters.push(resolve);
        setTimeout(resolve, 200).unref();
      });
    }
  }

  /** 叫葉子 `attach`，等它的 result。 */
  async attach(threadId: string): Promise<PairMessage> {
    const id = this.#nextCall++;
    this.#write({
      type: 'call',
      side: 'm',
      id,
      parent: null,
      method: PAIR_ATTACH_METHOD,
      payload: { threadId },
    });
    return this.until((message) => message.type === 'result' && message.id === id);
  }

  /** 橋斷了：關這條連線。 */
  cut(): void {
    this.#socket?.destroy();
  }

  async close(): Promise<void> {
    this.#socket?.destroy();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}

interface Leaf {
  readonly child: ChildProcess;
  readonly bridge: FakeComposition;
  /** 控制面上到目前為止的回報（不含心跳與 hello）。 */
  reports(): ConversationReport[];
  heartbeats(): number;
  stderr(): string;
  exited(): Promise<number | null>;
}

const roots: string[] = [];
const children: ChildProcess[] = [];
const bridges: FakeComposition[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function start(): Promise<Leaf> {
  const dir = await mkdtemp(join(tmpdir(), 'nexus-pair-leaf-'));
  roots.push(dir);
  const sockets = join(dir, 'sockets');
  await mkdir(sockets, { mode: 0o700 });
  const bridge = await FakeComposition.listen(join(sockets, 'p.sock'));
  bridges.push(bridge);
  const patch = join(dir, 'script.patch.yml');
  await writeFile(patch, scriptedPatchText([{ content: '好' }]), 'utf8');
  const home = join(dir, 'home');
  const child = spawn(
    process.execPath,
    [
      '--import',
      TSX,
      ENTRY,
      '--socket',
      join(sockets, 'l.sock'),
      '--pair-socket',
      join(sockets, 'p.sock'),
      '--patch',
      patch,
      ...AGENT_LOOP,
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
  bridge.diagnose = () => stderr;
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
  let heartbeats = 0;
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    const taken = takeFrames(Buffer.concat([pending, chunk]));
    pending = taken.rest;
    for (const payload of taken.frames) {
      const report = decodeConversationReport(payload);
      if (report.type === 'heartbeat') heartbeats += 1;
      else if (report.type !== 'hello') reports.push(report);
    }
  });
  const exited = new Promise<number | null>((resolve) =>
    child.once('exit', (code) => resolve(code)),
  );
  return {
    child,
    bridge,
    reports: () => [...reports],
    heartbeats: () => heartbeats,
    stderr: () => stderr,
    exited: () =>
      Promise.race([
        exited,
        new Promise<never>((_resolve, reject) =>
          setTimeout(
            () => reject(new Error(`葉子 ${String(GUARD_MS)} 毫秒內沒結束：\n${stderr}`)),
            GUARD_MS,
          ).unref(),
        ),
      ]),
  };
}

/** 輪詢到條件成立；到了時限就丟出 `message`。 */
async function until(condition: () => boolean, message: () => string): Promise<void> {
  const deadline = Date.now() + GUARD_MS;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(message());
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('葉子連橋（假的組合行程）', { timeout: 90_000 }, () => {
  it('連上就 hello、登記空的 tools 與 hooks；attach 綁完回 result，控制面送 bound、心跳不停', async () => {
    const leaf = await start();
    await leaf.bridge.until((message) => message.type === 'hello');
    const register = await leaf.bridge.until((message) => message.type === 'register');
    expect(register).toEqual({ type: 'register', tools: [], hooks: [] });

    const result = await leaf.bridge.attach(THREAD);
    expect(result).toEqual({ type: 'result', side: 'm', id: 1, ok: { bound: THREAD } });
    await until(
      () => leaf.reports().some((report) => report.type === 'bound'),
      () => `控制面沒送 bound：${JSON.stringify(leaf.reports())}\n${leaf.stderr()}`,
    );
    expect(leaf.reports()).toContainEqual({ type: 'bound', threadId: THREAD });
    const before = leaf.heartbeats();
    await until(
      () => leaf.heartbeats() > before,
      () => `bind 之後沒有心跳\n${leaf.stderr()}`,
    );
  });

  it('attach 別條 thread（已綁）回錯，不改綁', async () => {
    const leaf = await start();
    await leaf.bridge.until((message) => message.type === 'register');
    await leaf.bridge.attach(THREAD);
    const second = await leaf.bridge.attach('另一條');
    expect(second.type).toBe('result');
    expect(second).toMatchObject({ error: { code: 'service_error' } });
  });

  it('還沒 attach 橋就斷：葉子立刻以橋斷的結束碼結束，stderr 一行原因', async () => {
    const leaf = await start();
    await leaf.bridge.until((message) => message.type === 'register');
    leaf.bridge.cut();
    expect(await leaf.exited()).toBe(BRIDGE_LOST_EXIT_CODE);
    expect(leaf.stderr()).toContain('還沒 attach 成功');
  });

  it('已綁且閒著時橋斷：葉子結束，結束碼同上', async () => {
    const leaf = await start();
    await leaf.bridge.until((message) => message.type === 'register');
    await leaf.bridge.attach(THREAD);
    // 控制面每秒問一次閒不閒；等 handler 開好、閒了再斷，這樣走的是「已綁且閒」那一支。
    await until(
      () => leaf.reports().some((report) => report.type === 'idle'),
      () => `沒等到 idle：${JSON.stringify(leaf.reports())}\n${leaf.stderr()}`,
    );
    leaf.bridge.cut();
    expect(await leaf.exited()).toBe(BRIDGE_LOST_EXIT_CODE);
    expect(leaf.stderr()).toContain('橋斷了');
  });
});
