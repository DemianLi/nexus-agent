/**
 * serve 行程層的收尾：訊號與致命例外**共用同一份、記住自己的 dispose**
 * （[#1501](https://github.com/DemianLi/nexus-agent/issues/1501) 驗收 3）。
 *
 * 用假的 `proc` 與假的 `RunningServe`，只問兩件事：`close()` 跑了幾次、先到的是誰的退出碼。
 * 真的行程接線（有沒有裝、收尾真的跑了、標籤那一行）在 `serve-shutdown.test.ts` 的子行程那一組。
 */

import { describe, expect, it, vi } from 'vitest';

import type { FailLoudEvent } from './fail-loud.js';
import { PROCESS_SHUTDOWN_TIMEOUT_MS } from './process-shutdown.js';
import { installServeProcessLifecycle } from './serve.js';
import type { RunningServe, ServeProcess } from './serve.js';

type Handler = (arg?: unknown) => void;

function fakeProc() {
  const handlers = new Map<string, Handler[]>();
  const written: string[] = [];
  const exits: number[] = [];
  const proc = {
    exitCode: undefined as number | string | null | undefined,
    on(event: FailLoudEvent | 'SIGTERM' | 'SIGINT', handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    off(event: FailLoudEvent, handler: Handler) {
      handlers.set(
        event,
        (handlers.get(event) ?? []).filter((h) => h !== handler),
      );
    },
    stderr: {
      write: (chunk: string) => {
        written.push(chunk);
      },
    },
    exit: (code: number) => {
      exits.push(code);
    },
  } as unknown as ServeProcess & { exitCode: number | string | null | undefined };
  const fire = (event: string, arg?: unknown): void => {
    for (const handler of handlers.get(event) ?? []) handler(arg);
  };
  return { proc, written, exits, fire, handlers };
}

/** `close()` 卡在閘門上，直到 `release()`；數它被叫了幾次。 */
function fakeRunning(options: { fail?: Error } = {}) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = { closes: 0 };
  const running = {
    url: 'http://127.0.0.1:0',
    authenticatedUrl: 'http://127.0.0.1:0/?token=x',
    close: async () => {
      state.closes += 1;
      await gate;
      if (options.fail !== undefined) throw options.fail;
    },
  } as RunningServe;
  return { running, state, release };
}

describe('serve 行程層收尾共用一份 dispose', () => {
  it('SIGTERM 收尾進行中來一顆致命：close() 只跑一次，退出碼以先到的 SIGTERM 為準（0）', async () => {
    const { proc, written, exits, fire } = fakeProc();
    const { running, state, release } = fakeRunning();
    installServeProcessLifecycle(proc).attach(running);

    fire('SIGTERM');
    fire('unhandledRejection', new Error('fatal probe'));
    expect(written).toHaveLength(1);
    expect(written[0]).toContain('nexus-agent serve: fatal load failure: ');
    release();
    await vi.waitFor(() => {
      expect(exits.length).toBeGreaterThan(0);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(state.closes).toBe(1);
    // 兩邊等同一顆 dispose；訊號先開始收尾，它的 `.then` 先掛在那顆 promise 上，先叫 `exit`。
    expect(exits[0]).toBe(0);
  });

  it('SIGINT 收尾進行中來一顆致命：退出碼是 130', async () => {
    const { proc, exits, fire } = fakeProc();
    const { running, state, release } = fakeRunning();
    installServeProcessLifecycle(proc).attach(running);

    fire('SIGINT');
    fire('uncaughtException', new Error('fatal probe'));
    release();
    await vi.waitFor(() => {
      expect(exits.length).toBeGreaterThan(0);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(state.closes).toBe(1);
    expect(exits[0]).toBe(130);
  });

  it('只有致命：印一行帶標籤的診斷、走 close()、以 1 結束', async () => {
    const { proc, written, exits, fire } = fakeProc();
    const { running, state, release } = fakeRunning();
    installServeProcessLifecycle(proc).attach(running);

    fire('uncaughtException', new Error('fatal probe'));
    expect(written).toHaveLength(1);
    expect(written[0]).toContain('nexus-agent serve: fatal uncaught exception: ');
    expect(written[0]).toContain('fatal probe');
    expect(exits).toEqual([]);
    release();
    await vi.waitFor(() => {
      expect(exits).toEqual([1]);
    });
    expect(state.closes).toBe(1);
  });

  it('close() 拒絕：致命退出照樣以 1 結束', async () => {
    const { proc, exits, fire } = fakeProc();
    const { running, release } = fakeRunning({ fail: new Error('收尾失敗') });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      installServeProcessLifecycle(proc).attach(running);
      fire('unhandledRejection', new Error('fatal probe'));
      release();
      await vi.waitFor(() => {
        expect(exits).toEqual([1]);
      });
      expect(error).toHaveBeenCalledWith('收尾失敗');
    } finally {
      error.mockRestore();
    }
  });

  it.each([
    ['SIGTERM', 'SIGTERM'],
    ['SIGINT', 'SIGINT'],
  ])(
    '%s 之後 close() 拒絕：以 1 結束，監管程式看得出有東西沒收好（#2196）',
    async (_label, signal) => {
      const { proc, exits, fire } = fakeProc();
      const { running, release } = fakeRunning({ fail: new Error('2 條 thread 收尾失敗') });
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        installServeProcessLifecycle(proc).attach(running);
        fire(signal);
        release();
        await vi.waitFor(() => {
          expect(exits).toEqual([1]);
        });
        expect(error).toHaveBeenCalledWith('2 條 thread 收尾失敗');
      } finally {
        error.mockRestore();
      }
    },
  );

  it('close() 成功：SIGTERM 照舊是 0、SIGINT 照舊是 130', async () => {
    for (const [signal, code] of [
      ['SIGTERM', 0],
      ['SIGINT', 130],
    ] as const) {
      const { proc, exits, fire } = fakeProc();
      const { running, release } = fakeRunning();
      installServeProcessLifecycle(proc).attach(running);
      fire(signal);
      release();
      await vi.waitFor(() => {
        expect(exits).toEqual([code]);
      });
    }
  });

  it('5 秒逾時：以訊號的碼結束，之後 close() 才拒絕也不改碼', async () => {
    vi.useFakeTimers();
    const { proc, exits, fire } = fakeProc();
    const { running, release } = fakeRunning({ fail: new Error('逾時之後才失敗') });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      installServeProcessLifecycle(proc).attach(running);
      fire('SIGTERM');
      await vi.advanceTimersByTimeAsync(PROCESS_SHUTDOWN_TIMEOUT_MS);
      expect(exits).toEqual([0]);
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(exits).toEqual([0]);
    } finally {
      error.mockRestore();
      vi.useRealTimers();
    }
  });

  it('收尾中第二次訊號：當場以訊號的碼結束，不等 close() 的結果', async () => {
    const { proc, exits, fire } = fakeProc();
    const { running, release } = fakeRunning({ fail: new Error('之後才失敗') });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      installServeProcessLifecycle(proc).attach(running);
      fire('SIGTERM');
      await Promise.resolve();
      fire('SIGTERM');
      expect(exits).toEqual([0]);
      release();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(exits).toEqual([0]);
    } finally {
      error.mockRestore();
    }
  });

  it('runServe 還沒回來（沒有 attach）就致命：沒有東西可收，直接以 1 結束', async () => {
    const { proc, written, exits, fire } = fakeProc();
    installServeProcessLifecycle(proc);

    fire('unhandledRejection', new Error('啟動途中'));
    expect(written[0]).toContain('啟動途中');
    await vi.waitFor(() => {
      expect(exits).toEqual([1]);
    });
  });

  it('uninstall 只拿掉 fail-loud 的兩個 handler，訊號的還在', () => {
    const { proc, handlers } = fakeProc();
    const lifecycle = installServeProcessLifecycle(proc);
    expect(handlers.get('unhandledRejection')).toHaveLength(1);
    expect(handlers.get('SIGTERM')).toHaveLength(1);
    lifecycle.uninstall();
    expect(handlers.get('unhandledRejection')).toHaveLength(0);
    expect(handlers.get('uncaughtException')).toHaveLength(0);
    expect(handlers.get('SIGTERM')).toHaveLength(1);
    expect(handlers.get('SIGINT')).toHaveLength(1);
  });
});
