/**
 * 對話行程的入口（[#2338](https://github.com/DemianLi/nexus-agent/issues/2338)，設計 `.docs/supervisor-1947-design-2026-11-03.md` §四、§5-2）：
 * 監督行程每條 thread 起一個，`node conversation-process.js --socket <path> [--host-socket <path>] [serve 的旗標…]`。
 *
 * - wire 只聽 `--socket` 那個 Unix socket，驗證用 {@link openPeerSocketAuth}：socket 所在目錄要是自己的、權限 0700，否則起不來。
 * - 控制面在 stdin／stdout（`conversation-control.ts`）。**stdout 只有框**：serve 的日誌交 stderr，起動期間與之後任何人寫
 *   `process.stdout` 也轉到 stderr，控制面拿的是轉之前那一支。
 * - stdin 讀到 EOF 跟 `SIGTERM` 走同一條收尾、回 0。
 * - 監督行程有起宿主時多帶 `--host-socket <path>`；收到控制通道 `hello` 帶的 token 之後才連宿主（`host-client.ts`）；stdin 讀到 EOF 時關掉，訊號那條不關（連線與計時器都 `unref`，不擋結束）。
 *
 * @module
 */

import { Writable } from 'node:stream';

import type { HostClient } from '@nexus/host-bridge';

import { ConversationControl } from './conversation-control.js';
import { connectHost, parseHostSocketArg } from './host-client.js';
import { openPeerSocketAuth } from './peer-socket-auth.js';
import { installServeProcessLifecycle, runServe } from './serve.js';

/** 控制面多久問一次閒不閒。 */
const POLL_MS = 1_000;
/** 綁定之後多久送一次心跳。 */
const HEARTBEAT_MS = 1_000;

/** 拆出 `--socket <path>`，其餘原樣交給 serve。 */
export function parseConversationArgs(argv: readonly string[]): {
  readonly socketPath: string;
  readonly serveArgv: readonly string[];
} {
  const index = argv.indexOf('--socket');
  const socketPath = index === -1 ? undefined : argv[index + 1];
  if (socketPath === undefined || socketPath.startsWith('--')) {
    throw new Error('對話行程要 --socket <path>');
  }
  return { socketPath, serveArgv: [...argv.slice(0, index), ...argv.slice(index + 2)] };
}

async function main(): Promise<void> {
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const frames = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      stdoutWrite(chunk, (error) => callback(error ?? null));
    },
  });
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;

  const lifecycle = installServeProcessLifecycle();
  try {
    const { socketPath, serveArgv: rest } = parseConversationArgs(process.argv.slice(2));
    const { hostSocket, rest: serveArgv } = parseHostSocketArg(rest);
    const auth = await openPeerSocketAuth(socketPath);
    // serve 起好之後才有 handler 可以交給控制面；在那之前來的請求看到的是還沒綁。
    const bound: { control?: ConversationControl } = {};
    const running = await runServe({
      argv: serveArgv,
      log: (line) => console.error(line),
      conversation: {
        socketPath,
        auth,
        boundThread: () => bound.control?.boundThread,
        onTurn: (threadId, phase) => bound.control?.turn(threadId, phase),
      },
    });
    if (running?.conversationHandler === undefined) {
      lifecycle.uninstall();
      return;
    }
    lifecycle.attach(running);
    let host: HostClient | undefined;
    const control = new ConversationControl({
      input: process.stdin,
      output: frames,
      handler: running.conversationHandler,
      now: Date.now,
      pollMs: POLL_MS,
      heartbeatMs: HEARTBEAT_MS,
      onEnd: () => {
        host?.close();
        lifecycle.stop();
      },
      warn: (message) => console.error(message),
      onHostToken: (token) => {
        host = connectHost({ hostSocket, token, log: (line) => console.error(line) });
      },
    });
    bound.control = control;
    control.ready();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
