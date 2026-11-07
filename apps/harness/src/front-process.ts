/**
 * per-thread 前台的入口（[#2341](https://github.com/DemianLi/nexus-agent/issues/2341)，設計 `.docs/supervisor-1947-design-2026-11-03.md` §3-2、§四）：
 * 監督行程起一個，`node front-process.js [serve 的旗標…]`，由 `process-launcher.ts` 組好參數。
 *
 * - 跟一般的 serve 一樣聽 port 或 `--unix-socket`、帶登入、網頁與營運端點，拿 home 鎖；指名 thread 的 wire 請求轉給對話行程（`front-wire.ts`）。
 * - 控制面在 stdin／stdout（`supervisor-client.ts`）。**stdout 只有框**：serve 的日誌與登入網址交 stderr，同 `conversation-process.ts`。
 * - stdin 讀到 EOF（監督行程走了）跟 `SIGTERM` 走同一條收尾。
 *
 * @module
 */

import { Writable } from 'node:stream';

import { FrontFeed } from './front-feed.js';
import { FrontPluginBindings } from './front-plugins.js';
import { FrontForwarder } from './front-forward.js';
import { FrontTurnFailures } from './front-turn-failures.js';
import { installServeProcessLifecycle, runServe } from './serve.js';
import { SupervisorClient } from './supervisor-client.js';

async function main(): Promise<void> {
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const frames = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      stdoutWrite(chunk, (error) => callback(error ?? null));
    },
  });
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;

  const lifecycle = installServeProcessLifecycle();
  const forwarder = new FrontForwarder();
  const warn = (message: string): void => console.error(message);
  const feed = new FrontFeed({ forwarder, warn });
  const plugins = new FrontPluginBindings({ forwarder, warn });
  const turnFailures = new FrontTurnFailures({ forwarder, warn });
  const supervisor = new SupervisorClient({
    input: process.stdin,
    output: frames,
    onUp: (threadId, socket) => {
      feed.up(threadId, socket);
      plugins.up(threadId, socket);
      turnFailures.up(threadId, socket);
    },
    onDown: (threadId, _cause, socket) => {
      feed.down(threadId);
      plugins.down(threadId);
      turnFailures.down(threadId);
      if (socket !== undefined) forwarder.forget(socket);
    },
    warn,
  });
  process.stdin.once('end', () => lifecycle.stop());
  try {
    const running = await runServe({
      argv: process.argv.slice(2),
      front: { supervisor, forwarder, feed, plugins, turnFailures },
    });
    if (running === undefined) {
      lifecycle.uninstall();
      return;
    }
    lifecycle.attach({
      ...running,
      close: async (options) => {
        try {
          await running.close(options);
        } finally {
          feed.close();
          plugins.close();
          turnFailures.close();
          forwarder.close();
        }
      },
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
