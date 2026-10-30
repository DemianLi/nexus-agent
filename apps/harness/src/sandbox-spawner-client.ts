/**
 * 常駐沙箱 spawner 的 client 與過渡版監控（[#1946](https://github.com/DemianLi/nexus-agent/issues/1946)）。一個行程一個
 * spawner，工具子行程都由它起。協定在 `sandbox-protocol.ts`。
 *
 * 一代（{@link startGeneration}）是一支 spawner 行程：還在跑的工具全綁在它身上，它結束時一起以 `sandbox-unavailable` 收場。
 * spawner 收到 stdin EOF 就殺掉所有工具，而工具另有 `PR_SET_PDEATHSIG`，所以 serve 怎麼結束都不留工具。
 *
 * {@link SpawnerSupervisor} 在舊的一代確認關閉之後才起新的一代，連續失敗時退避。預算用完就停，下一次工具呼叫才開新的預算。
 * 退避中的要求直接回 `sandbox-unavailable`，不等。
 *
 * @module
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import type { Socket } from 'node:net';
import { constants as osConstants, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Writable } from 'node:stream';

import { decodeEvent, encodeRequest, frame, stdioHeader, takeFrames } from './sandbox-protocol.js';
import type { SpawnMode, SpawnerEvent, SpawnerRequest } from './sandbox-protocol.js';
import type {
  ToolLaunchFailure,
  ToolLauncher,
  ToolProcess,
  ToolRequest,
  ToolResult,
} from './tool-process.js';

/** 第一次重試前等多久（毫秒）；之後每次加倍。 */
const INITIAL_DELAY_MS = 500;
/** 退避上限（毫秒），也是一代要連續活多久才算撐過這次故障。 */
const MAX_DELAY_MS = 30_000;
/** 一次故障最多重起幾次。 */
const MAX_ATTEMPTS = 10;
/** 等 `Ready` 多久（毫秒）。 */
const READY_TIMEOUT_MS = 10_000;
/** `sun_path` 放得下的最長 socket 路徑。 */
const MAX_SOCKET_PATH = 107;

/** 退避參數。 */
export interface SpawnerBackoff {
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly maxAttempts: number;
}

/** 送給 spawner 的環境：不繼承 serve 的，工具的環境由要求帶。 */
const SPAWNER_ENV: NodeJS.ProcessEnv = {};

const SIGNAL_NUMBERS = { SIGTERM: 15, SIGKILL: 9 } as const;

const SPAWN_MODES = {
  'read-only': 'read-only',
  'workspace-write': 'workspace-write',
  'danger-full-access': 'full-access',
} as const satisfies Record<ToolRequest['mode'], SpawnMode>;

function signalName(signo: number): string {
  const found = Object.entries(osConstants.signals).find(([, value]) => value === signo);
  return found?.[0] ?? `signal ${String(signo)}`;
}

/** 檔案路徑長度放不下時退到 `/tmp`：`TMPDIR` 可以很長。 */
function privateSocketDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-sb-'));
  if (join(dir, 's').length <= MAX_SOCKET_PATH) return dir;
  rmSync(dir, { recursive: true, force: true });
  return mkdtempSync('/tmp/nexus-sb-');
}

/** 一支活著的 spawner。 */
export interface SpawnerGeneration {
  readonly landlockAbi: number;
  /** 經這一代起一支工具。這一代已死時回 `sandbox-unavailable`；`Started` 或 `Failed` 之前不 settle。 */
  spawn(request: ToolRequest): Promise<ToolProcess | ToolLaunchFailure>;
}

/** {@link startGeneration} 的回呼。 */
export interface GenerationHooks {
  /** 這一代的行程已經關閉（Ready 之前失敗也算）。 */
  readonly onClosed: () => void;
  /** 工具起來了，但這台核心給不了完整的 Landlock。 */
  readonly onPartial: () => void;
  /** 給管理者看的診斷。 */
  readonly log: (line: string) => void;
}

interface InFlight {
  readonly settle: (result: ToolResult) => void;
  readonly started: (event: Extract<SpawnerEvent, { type: 'started' }>) => void;
  readonly conns: readonly Socket[];
}

/**
 * 起一支 spawner，等 `Ready`。
 *
 * @param binary - 執行檔路徑。
 * @param hooks - 見 {@link GenerationHooks}。
 * @param readyTimeoutMs - 等 `Ready` 的期限。
 * @returns 活著的一代；起不來時 reject，而且 `onClosed` 照樣會叫。
 */
export function startGeneration(
  binary: string,
  hooks: GenerationHooks,
  readyTimeoutMs = READY_TIMEOUT_MS,
): Promise<SpawnerGeneration> {
  const dir = privateSocketDir();
  const socket = join(dir, 's');
  const removeDir = (): void => rmSync(dir, { recursive: true, force: true });
  process.once('exit', removeDir);
  const child = spawn(binary, ['--listen', socket], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: SPAWNER_ENV,
  });
  // 閒著的 spawner 不該讓 CLI 結束不了；有工具在跑時控制通道要撐著事件迴圈，事件才收得到。
  child.unref();
  const events = child.stdout as unknown as Socket;
  (child.stdin as unknown as Socket).unref();
  (child.stderr as unknown as Socket).unref();
  events.unref();
  // spawner 掛掉時寫入會 EPIPE；結局由 'close' 收，這裡只防未處理的 error。
  child.stdin.on('error', () => {});

  const inFlight = new Map<number, InFlight>();
  let nextId = 1;
  let pending: Buffer = Buffer.alloc(0);
  let stderrTail = '';
  let dead = false;

  const send = (request: SpawnerRequest): void => {
    if (!dead) (child.stdin as Writable).write(frame(encodeRequest(request)));
  };

  return new Promise<SpawnerGeneration>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('等 spawner 的 Ready 逾時'));
      child.kill('SIGKILL');
    }, readyTimeoutMs);

    const generation = (landlockAbi: number): SpawnerGeneration => ({
      landlockAbi,
      spawn: (request) => {
        if (dead) return Promise.resolve<ToolLaunchFailure>('sandbox-unavailable');
        const id = nextId++;
        events.ref();
        send({
          type: 'spawn',
          id,
          mode: SPAWN_MODES[request.mode],
          pipes: 0b110,
          cwd: request.cwd,
          readable: request.readable,
          writable: request.writable,
          argv: [request.executable, ...request.args],
          env: Object.entries(request.env).flatMap(([name, value]) =>
            value === undefined ? [] : [`${name}=${value}`],
          ),
        });
        const stdout = createConnection(socket);
        const stderr = createConnection(socket);
        stdout.write(stdioHeader(id, 1));
        stderr.write(stdioHeader(id, 2));
        const conns = [stdout, stderr];
        for (const conn of conns) conn.on('error', () => conn.destroy());
        return new Promise<ToolProcess | ToolLaunchFailure>((settleStart) => {
          let finish!: (result: ToolResult) => void;
          const done = new Promise<ToolResult>((settleDone) => (finish = settleDone));
          inFlight.set(id, {
            conns,
            settle: (result) => {
              inFlight.delete(id);
              if (inFlight.size === 0) events.unref();
              if (result.kind === 'failed') {
                for (const conn of conns) conn.destroy();
                settleStart(result.reason);
                finish(result);
                return;
              }
              void Promise.all(conns.map(closedOf)).then(() => finish(result));
            },
            started: (event) => {
              if (event.partial) hooks.onPartial();
              let running = true;
              void done.then(() => (running = false));
              settleStart({
                pid: event.pid,
                stdout,
                stderr,
                kill: (signal) => {
                  if (running) send({ type: 'signal', id, signo: SIGNAL_NUMBERS[signal] });
                },
                done,
              });
            },
          });
        });
      },
    });

    const onEvent = (event: SpawnerEvent): void => {
      switch (event.type) {
        case 'ready':
          clearTimeout(timer);
          resolve(generation(event.landlockAbi));
          return;
        case 'unavailable':
          hooks.log(`沙箱 spawner 起不來：${event.detail}（errno ${String(event.errno)}）`);
          return;
        case 'started':
          inFlight.get(event.id)?.started(event);
          return;
        case 'failed': {
          if (event.kind === 'sandbox-unavailable' || event.kind === 'protocol') {
            hooks.log(`沙箱 spawner 拒絕起工具：${event.kind}，${event.detail}`);
          }
          const reason: ToolLaunchFailure =
            event.kind === 'sandbox-unavailable'
              ? 'sandbox-unavailable'
              : event.kind === 'start-dir'
                ? 'start-dir'
                : event.kind === 'exec' && event.errno === 2
                  ? 'not-found'
                  : 'launch-failed';
          inFlight.get(event.id)?.settle({ kind: 'failed', reason });
          return;
        }
        case 'exited':
          inFlight.get(event.id)?.settle({
            kind: 'exited',
            code: event.signal === 0 ? event.code : null,
            signal: event.signal === 0 ? null : signalName(event.signal),
          });
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      try {
        const { frames, rest } = takeFrames(Buffer.concat([pending, chunk]));
        pending = Buffer.from(rest);
        for (const payload of frames) onEvent(decodeEvent(payload));
      } catch (error) {
        hooks.log(`沙箱 spawner 的事件看不懂：${(error as Error).message}`);
        child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-400);
    });
    child.once('error', (error) => {
      hooks.log(`沙箱 spawner 起不來：${error.message}`);
    });
    child.once('close', (code, signal) => {
      dead = true;
      clearTimeout(timer);
      process.removeListener('exit', removeDir);
      removeDir();
      for (const entry of [...inFlight.values()]) {
        entry.settle({ kind: 'failed', reason: 'sandbox-unavailable' });
      }
      if (stderrTail.trim() !== '') hooks.log(`沙箱 spawner 的 stderr：${stderrTail.trim()}`);
      reject(new Error(`spawner 結束了（exit ${String(code)}，訊號 ${String(signal)}）`));
      hooks.onClosed();
    });
  });
}

function closedOf(conn: Socket): Promise<void> {
  return conn.destroyed
    ? Promise.resolve()
    : new Promise((resolve) => conn.once('close', () => resolve()));
}

/** {@link SpawnerSupervisor} 的參數。 */
export interface SpawnerSupervisorOptions {
  readonly binary: string;
  readonly log: (line: string) => void;
  readonly backoff?: SpawnerBackoff;
  /** 測試接縫：換掉起一代的方式。 */
  readonly start?: typeof startGeneration;
}

/** 過渡版監控，活在 serve 裡；第 3 段搬進主機級的樹（#1948）。 */
export class SpawnerSupervisor {
  readonly #binary: string;
  readonly #log: (line: string) => void;
  readonly #backoff: SpawnerBackoff;
  readonly #start: typeof startGeneration;
  /** 正在起或活著的一代。 */
  #current: Promise<SpawnerGeneration> | undefined;
  #retry: NodeJS.Timeout | undefined;
  #failedAttempts = 0;
  /** 這一代 Ready 的時刻；還沒 Ready 是 `undefined`。 */
  #connectedAt: number | undefined;
  #partialNoticed = false;

  constructor(options: SpawnerSupervisorOptions) {
    this.#binary = options.binary;
    this.#log = options.log;
    this.#backoff = options.backoff ?? {
      initialDelayMs: INITIAL_DELAY_MS,
      maxDelayMs: MAX_DELAY_MS,
      maxAttempts: MAX_ATTEMPTS,
    };
    this.#start = options.start ?? startGeneration;
  }

  /** 接到工具接縫上的進入點。 */
  readonly launch: ToolLauncher = async (request) => {
    if (this.#retry !== undefined) return 'sandbox-unavailable';
    try {
      this.#current ??= this.#connect();
      return await (await this.#current).spawn(request);
    } catch {
      return 'sandbox-unavailable';
    }
  };

  #connect(): Promise<SpawnerGeneration> {
    const generation = this.#start(this.#binary, {
      log: this.#log,
      onPartial: () => this.#notePartial(generation),
      onClosed: () => this.#generationDown(),
    });
    // 重起的那一代沒有人 await：失敗由 onClosed 收，這裡只防未處理的 rejection。
    generation.then(
      () => (this.#connectedAt = Date.now()),
      () => {},
    );
    return generation;
  }

  #notePartial(generation: Promise<SpawnerGeneration>): void {
    if (this.#partialNoticed) return;
    this.#partialNoticed = true;
    void generation.then(({ landlockAbi }) =>
      this.#log(
        `沙箱：這台核心的 Landlock ABI 是 ${String(landlockAbi)}，只有部分強制（完整強制要 ABI 6）；工具照跑`,
      ),
    );
  }

  /** 舊的一代確認關閉了：現在才能決定下一步。 */
  #generationDown(): void {
    const { initialDelayMs, maxDelayMs, maxAttempts } = this.#backoff;
    const lived = this.#connectedAt !== undefined && Date.now() - this.#connectedAt >= maxDelayMs;
    if (lived) this.#failedAttempts = 0;
    this.#connectedAt = undefined;
    this.#current = undefined;
    this.#failedAttempts += 1;
    if (this.#failedAttempts > maxAttempts) {
      this.#log(`沙箱 spawner 重起 ${String(maxAttempts)} 次都失敗，停止重啟；下一次工具呼叫再試`);
      this.#failedAttempts = 0;
      return;
    }
    const delayMs = Math.min(maxDelayMs, initialDelayMs * 2 ** (this.#failedAttempts - 1));
    this.#log(
      `沙箱 spawner 結束了，${String(delayMs)}ms 後重起（第 ${String(this.#failedAttempts)}/${String(maxAttempts)} 次）`,
    );
    this.#retry = setTimeout(() => {
      this.#retry = undefined;
      this.#current = this.#connect();
    }, delayMs);
    this.#retry.unref();
  }
}
