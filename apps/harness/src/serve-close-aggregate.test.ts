/**
 * serve 的收尾序列：一步失敗，其餘照跑，全部跑完才拋（[#1511](https://github.com/DemianLi/nexus-agent/issues/1511) 驗收 7）。
 *
 * `runServe` 沒有能讓 `handler.close()` 拒絕的接縫，所以這份測試把 `createWireHandler` 與 `createFailureRecorder` 換成**透傳的包裝**：
 * 其餘一律是真的（真的 `runServe`、真的 server），只在 `close()` 上動手腳——包一層讓它拒絕，並記下 `failureRecorder.flush()` 有沒有被叫到。
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  handlerCloseError: undefined as Error | undefined,
  handlerCloses: 0,
  recorderFlushes: 0,
}));

vi.mock('./wire-handler.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./wire-handler.js')>();
  return {
    ...original,
    createWireHandler: (...args: Parameters<typeof original.createWireHandler>) => {
      const handler = original.createWireHandler(...args);
      return {
        ...handler,
        close: async () => {
          hooks.handlerCloses += 1;
          await handler.close();
          if (hooks.handlerCloseError !== undefined) throw hooks.handlerCloseError;
        },
      };
    },
  };
});

vi.mock('./plugin-failure-recorder.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./plugin-failure-recorder.js')>();
  return {
    ...original,
    createFailureRecorder: (...args: Parameters<typeof original.createFailureRecorder>) => {
      const recorder = original.createFailureRecorder(...args);
      return {
        ...recorder,
        flush: async () => {
          hooks.recorderFlushes += 1;
          await recorder.flush();
        },
      };
    },
  };
});

import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';

let running: RunningServe | undefined;
afterEach(async () => {
  hooks.handlerCloseError = undefined;
  hooks.handlerCloses = 0;
  hooks.recorderFlushes = 0;
  await running?.close().catch(() => undefined);
  running = undefined;
});

describe('serve 收尾序列（#1511）', () => {
  it('handler.close() 拒絕：running.close() 也拒絕，而且後面的 failureRecorder.flush() 照跑', async () => {
    const started = await runServe({ argv: ['--port', '0'], log: () => undefined, env: {} });
    if (started === undefined) throw new Error('runServe 沒有起來');
    running = started;
    const before = hooks.recorderFlushes;
    hooks.handlerCloseError = new Error('thread "t" 收尾失敗：磁碟滿了');

    await expect(started.close()).rejects.toThrow('磁碟滿了');

    expect(hooks.handlerCloses).toBe(1);
    expect(hooks.recorderFlushes).toBeGreaterThan(before);
    running = undefined;
  });

  it('啟動失敗（port 被占）而且 handler.close() 也拒絕：浮上來的是原本的啟動錯誤，不是收尾的錯', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const { port } = blocker.address() as AddressInfo;
    hooks.handlerCloseError = new Error('收尾的錯不該蓋掉啟動錯誤');
    try {
      const error: unknown = await runServe({
        argv: ['--port', String(port)],
        log: () => undefined,
        env: {},
      }).then(
        () => undefined,
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain('收尾的錯不該蓋掉啟動錯誤');
      expect(hooks.handlerCloses).toBe(1);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
