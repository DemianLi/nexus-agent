/**
 * 只給 `native/sandbox-spawner/host/tests/pair_leaf.rs` 的量測起：一條接一條連組合行程那一端，每條都會在收下時被拒，
 * 數客戶端寫了 `hello` 之後還讀不讀得到 `rejected`（#2737）。直接用 `node:net`，不經 `PairClient`，寫入時機由這支決定。
 * 不從 `index.ts` 匯出、不進 `lib/`。
 *
 * 用法：`node --import tsx src/pair-reject-probe.ts <socket> <timing> <count>`，`timing`：
 *
 * - `immediate`：`connect` 事件當下就寫 `hello`。
 * - `read-first`：讓過一輪讀取（巢狀 `setImmediate`）再寫；那之前已經收到 `close` 就不寫（只收到 FIN 的半關狀態照樣寫）。
 * - `late`：`connect` 之後等 {@link LATE_MS} 才寫。開 `allowHalfOpen`：收到對端的 FIN 之後這一端不跟著收掉寫入端，照樣會呼叫 `write`。
 *
 * 先印一行 `env`（node 版本、核心版本、架構），跑完印一行 `cell`：
 *
 * - `rejected`：解出完整一框 `rejected`，`code` 是 `retry_later`。
 * - `error`：沒解出那一框就收到 socket 的 `error`，照 errno 分。解出別的框或解不出來也算在這裡，鍵是 `unexpected`。
 * - `empty`：沒解出那一框、也沒有 `error` 就關了。
 * - `timeout`：{@link CONNECTION_TIMEOUT_MS} 內沒有結論。
 * - `wrote`：有呼叫到 `write` 的條數；`writeFailed`：這一條有結論之前 `write` 的 callback 報錯的條數，照 errno 分，跟上面四類獨立計。
 *
 * 一開頭連續 {@link ABORT_AFTER_TIMEOUTS} 條都是 `timeout` 就不再連，`cell` 帶 `aborted`。stdin 關了就結束。
 *
 * @module
 */

import { connect } from 'node:net';
import { arch, release } from 'node:os';

import {
  decodePairMessage,
  encodePairMessage,
  PAIR_PROTOCOL_VERSION,
  PairFrameReader,
} from './pair-protocol.js';

const TIMINGS = ['immediate', 'read-first', 'late'] as const;
type Timing = (typeof TIMINGS)[number];

const LATE_MS = 20;
const CONNECTION_TIMEOUT_MS = 5000;
const ABORT_AFTER_TIMEOUTS = 20;

type Outcome =
  | { readonly kind: 'rejected' | 'empty' | 'timeout' }
  | { readonly kind: 'error'; readonly code: string };

interface Attempt {
  readonly outcome: Outcome;
  readonly wrote: boolean;
  readonly writeError: string | undefined;
}

const [socketPath, timingArg, countArg] = process.argv.slice(2);
const timing = TIMINGS.find((name) => name === timingArg);
const count = Number(countArg);
if (socketPath === undefined || timing === undefined || !Number.isInteger(count) || count < 1) {
  process.stderr.write('用法：pair-reject-probe <socket> <immediate|read-first|late> <count>\n');
  process.exit(2);
}

function emit(event: string, fields: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
}

function errno(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

function attempt(path: string, when: Timing): Promise<Attempt> {
  return new Promise((resolve) => {
    const socket = connect({ path, allowHalfOpen: when === 'late' });
    const reader = new PairFrameReader();
    let verdict: Outcome | undefined;
    let failure: string | undefined;
    let wrote = false;
    let writeError: string | undefined;
    let settled = false;
    let lateTimer: NodeJS.Timeout | undefined;

    const settle = (outcome: Outcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(lateTimer);
      socket.destroy();
      resolve({ outcome, wrote, writeError });
    };
    const deadline = setTimeout(() => {
      settle({ kind: 'timeout' });
    }, CONNECTION_TIMEOUT_MS);

    const write = (): void => {
      if (settled || socket.destroyed) return;
      wrote = true;
      socket.write(
        encodePairMessage({ type: 'hello', version: PAIR_PROTOCOL_VERSION }),
        (error) => {
          if (error != null) writeError = errno(error);
          if (when === 'late') socket.end();
        },
      );
    };

    socket.on('connect', () => {
      if (when === 'immediate') write();
      else if (when === 'read-first') setImmediate(() => setImmediate(write));
      else lateTimer = setTimeout(write, LATE_MS);
    });
    socket.on('data', (chunk: Buffer) => {
      if (verdict !== undefined) return;
      try {
        for (const frame of reader.push(chunk)) {
          const message = decodePairMessage(frame);
          verdict =
            message.type === 'rejected' && message.code === 'retry_later'
              ? { kind: 'rejected' }
              : { kind: 'error', code: 'unexpected' };
          break;
        }
      } catch {
        verdict = { kind: 'error', code: 'unexpected' };
      }
    });
    socket.on('error', (error) => {
      failure ??= errno(error);
    });
    socket.on('close', () => {
      settle(
        verdict ?? (failure === undefined ? { kind: 'empty' } : { kind: 'error', code: failure }),
      );
    });
  });
}

process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
process.stdin.resume();

emit('env', { node: process.version, kernel: release(), arch: arch() });

const tally = { rejected: 0, empty: 0, timeout: 0, wrote: 0 };
const errors: Record<string, number> = {};
const writeFailed: Record<string, number> = {};
let total = 0;
let aborted: string | undefined;

for (; total < count; total += 1) {
  const { outcome, wrote, writeError } = await attempt(socketPath, timing);
  if (wrote) tally.wrote += 1;
  if (writeError !== undefined) writeFailed[writeError] = (writeFailed[writeError] ?? 0) + 1;
  if (outcome.kind === 'error') errors[outcome.code] = (errors[outcome.code] ?? 0) + 1;
  else tally[outcome.kind] += 1;
  if (tally.timeout === total + 1 && tally.timeout === ABORT_AFTER_TIMEOUTS) {
    total += 1;
    aborted = `開頭連續 ${String(ABORT_AFTER_TIMEOUTS)} 條都是 timeout`;
    break;
  }
}

emit('cell', {
  timing,
  total,
  rejected: tally.rejected,
  error: errors,
  empty: tally.empty,
  timeout: tally.timeout,
  wrote: tally.wrote,
  writeFailed,
  ...(aborted === undefined ? {} : { aborted }),
});
process.stdin.pause();
