/**
 * 收尾控制器（#599）。案例照 dsh 的 `apps/cli/tests/process-shutdown.spec.ts`（`477b4f4`）逐條抄。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProcessShutdown, PROCESS_SHUTDOWN_TIMEOUT_MS } from './process-shutdown.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('收尾控制器', () => {
  it('收完自然結束；收尾失敗就強制結束', async () => {
    const resolvedExit = vi.fn();
    const resolvedComplete = vi.fn();
    const resolved = createProcessShutdown(() => Promise.resolve(), resolvedExit, resolvedComplete);
    await resolved.shutdown(0);
    expect(resolvedComplete).toHaveBeenCalledOnce();
    expect(resolvedComplete).toHaveBeenCalledWith(0);
    expect(resolvedExit).not.toHaveBeenCalled();

    const rejectedExit = vi.fn();
    const rejectedComplete = vi.fn();
    const rejected = createProcessShutdown(
      () => Promise.reject(new Error('dispose failed')),
      rejectedExit,
      rejectedComplete,
    );
    await rejected.shutdown(1);
    expect(rejectedExit).toHaveBeenCalledOnce();
    expect(rejectedExit).toHaveBeenCalledWith(1);
    expect(rejectedComplete).not.toHaveBeenCalled();
  });

  it('預設的自然結束寫的是 process.exitCode', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    const shutdown = createProcessShutdown(() => Promise.resolve());

    try {
      await shutdown.shutdown(7);

      expect(process.exitCode).toBe(7);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  it('收尾到了上限就強制結束', async () => {
    vi.useFakeTimers();
    const disposal = deferred();
    const exit = vi.fn();
    const complete = vi.fn();
    const shutdown = createProcessShutdown(() => disposal.promise, exit, complete);
    const pending = shutdown.shutdown(0);

    await vi.advanceTimersByTimeAsync(PROCESS_SHUTDOWN_TIMEOUT_MS - 1);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);

    disposal.resolve();
    await pending;
    expect(exit).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
  });

  it('上限可以由呼叫端給', async () => {
    vi.useFakeTimers();
    const disposal = deferred();
    const exit = vi.fn();
    const shutdown = createProcessShutdown(() => disposal.promise, exit, vi.fn(), 25);
    const pending = shutdown.shutdown(0);

    await vi.advanceTimersByTimeAsync(24);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledOnce();

    disposal.resolve();
    await pending;
  });

  it('正常收尾卡住時，Ctrl-C 強制結束', async () => {
    const disposal = deferred();
    const exit = vi.fn();
    const complete = vi.fn();
    const shutdown = createProcessShutdown(() => disposal.promise, exit, complete);
    const pending = shutdown.shutdown(0);

    shutdown.interrupt(130);
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(130);

    disposal.resolve();
    await pending;
    expect(exit).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
  });

  it('訊號開始的收尾，收完強制結束', async () => {
    const disposal = deferred();
    const exit = vi.fn();
    const complete = vi.fn();
    const shutdown = createProcessShutdown(() => disposal.promise, exit, complete);

    shutdown.interrupt(143);
    disposal.resolve();
    await shutdown.shutdown(0);

    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(143);
    expect(complete).not.toHaveBeenCalled();
  });

  it('第一次訊號排空，第二次訊號強制結束', async () => {
    const disposal = deferred();
    const dispose = vi.fn(() => disposal.promise);
    const exit = vi.fn();
    const shutdown = createProcessShutdown(dispose, exit, vi.fn());

    shutdown.interrupt(143);
    await Promise.resolve();
    expect(dispose).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();

    shutdown.interrupt(130);
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(130);

    disposal.resolve();
    await shutdown.shutdown(0);
    expect(exit).toHaveBeenCalledOnce();
  });

  it('正常收尾叫兩次會合併，不算升級', async () => {
    const disposal = deferred();
    const exit = vi.fn();
    const complete = vi.fn();
    const shutdown = createProcessShutdown(() => disposal.promise, exit, complete);

    const first = shutdown.shutdown(0);
    const second = shutdown.shutdown(1);
    expect(second).toBe(first);
    expect(exit).not.toHaveBeenCalled();

    disposal.resolve();
    await first;
    expect(complete).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledWith(0);
    expect(exit).not.toHaveBeenCalled();
  });

  it('自然結束之後的訊號仍然強制結束', async () => {
    const exit = vi.fn();
    const complete = vi.fn();
    const shutdown = createProcessShutdown(() => Promise.resolve(), exit, complete);

    await shutdown.shutdown(0);
    shutdown.interrupt(130);

    expect(complete).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(130);
  });
});
