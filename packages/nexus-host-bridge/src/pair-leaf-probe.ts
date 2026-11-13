/**
 * 只給 `native/sandbox-spawner/host/tests/pair_leaf.rs` 起的葉子：用 {@link PairClient} 連真的組合行程那一端，把看到的事一行一筆
 * JSON 印到 stdout。不從 `index.ts` 匯出、不進 `lib/`（`pair-client.test.ts` 釘住）。
 *
 * 用法：`node --import tsx src/pair-leaf-probe.ts <socket> <method> [second]`。
 *
 * - 每次要退避重連印 `retry`；沒進去印 `failed`（`PairConnectError` 帶 `failure`，其餘帶 `name` 與 `message`）後結束。
 * - 驗過印 `connected`，登記 `probe-tool`／`probe-hook`，替組合行程做 `echo`（原樣回）與 `attach`（回 `{ bound: threadId }`）。
 * - 接著叫組合行程的 `<method>`：回來印 `result`，失敗印 `call_failed`（帶錯的 `name`）。
 * - 帶 `second` 時，上面那一次回來之後同一個行程再連一條，結局印 `second`。
 * - 連線斷了印 `closed`。stdin 關了就結束：起它的測試不在了，這個行程不會留著。
 *
 * @module
 */

import { PairClient, PairConnectError } from './pair-client.js';
import { PAIR_ATTACH_METHOD } from './pair-protocol.js';
import type { Json } from './protocol.js';

const [socketPath, method, extra] = process.argv.slice(2);
if (socketPath === undefined || method === undefined) {
  process.stderr.write('用法：pair-leaf-probe <socket> <method> [second]\n');
  process.exit(2);
}

function emit(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
}

function failureOf(error: unknown): Record<string, unknown> {
  return error instanceof PairConnectError
    ? { failure: error.failure }
    : { name: error instanceof Error ? error.name : 'unknown', message: String(error) };
}

process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
process.stdin.resume();

const STARTUP_DEADLINE_MS = 20_000;

try {
  const client = await PairClient.connect({
    socketPath,
    startupDeadlineMs: STARTUP_DEADLINE_MS,
    register: { tools: ['probe-tool'], hooks: ['probe-hook'] },
    methods: {
      echo: (payload) => payload,
      [PAIR_ATTACH_METHOD]: (payload) => {
        const threadId =
          typeof payload === 'object' && payload !== null && !Array.isArray(payload)
            ? (payload as { readonly [key: string]: Json }).threadId
            : undefined;
        return { bound: threadId ?? null };
      },
    },
    onRetry: (retry) => {
      emit('retry', { ...retry });
    },
  });
  emit('connected');
  void client.closed.then((reason) => {
    emit('closed', { ...reason });
  });
  try {
    emit('result', { ok: await client.call(method, { from: 'leaf' }) });
  } catch (error: unknown) {
    emit('call_failed', failureOf(error));
  }
  if (extra === 'second') {
    try {
      const second = await PairClient.connect({
        socketPath,
        startupDeadlineMs: STARTUP_DEADLINE_MS,
      });
      second.close();
      emit('second', { connected: true });
    } catch (error: unknown) {
      emit('second', failureOf(error));
    }
  }
} catch (error: unknown) {
  emit('failed', failureOf(error));
  process.exitCode = 1;
  process.stdin.pause();
}
