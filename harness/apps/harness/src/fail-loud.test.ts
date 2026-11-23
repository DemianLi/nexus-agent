/**
 * 行程層致命例外處理（[#1501](https://github.com/DemianLi/nexus-agent/issues/1501)），逐條照 dsh
 * `packages/boot/app-boot/tests/app-boot.spec.ts` 的 `installFailLoud` 那一組（`:362` 起，SHA `1517a4db`）。
 *
 * 用假的 `proc` 與假計時器，不碰真的行程。dsh 那組裡的「啟動稽核去重」沒有抄（見 `fail-loud.ts` 檔頭）。
 */

import { describe, expect, it, vi } from 'vitest';

import { FAIL_LOUD_RELEASE_TIMEOUT_MS, installFailLoud } from './fail-loud.js';
import type { FailLoudEvent, FailLoudProcess } from './fail-loud.js';

const NAME = 'nexus-agent serve';

type Handler = (err: unknown) => void;

function fakeProc(): FailLoudProcess & {
  handlers: Handler[];
  rejection: Handler;
  exception: Handler;
  written: string[];
  exits: number[];
} {
  const handlers: Handler[] = [];
  const registered = new Map<FailLoudEvent, Handler>();
  const written: string[] = [];
  const exits: number[] = [];
  return {
    handlers,
    written,
    exits,
    get rejection() {
      return registered.get('unhandledRejection')!;
    },
    get exception() {
      return registered.get('uncaughtException')!;
    },
    on: (event, handler) => {
      handlers.push(handler);
      registered.set(event, handler);
    },
    off: (event, handler) => {
      handlers.splice(handlers.indexOf(handler), 1);
      registered.delete(event);
    },
    stderr: {
      write: (chunk: string) => {
        written.push(chunk);
      },
    },
    exit: (code: number) => {
      exits.push(code);
    },
  };
}

describe('installFailLoud', () => {
  it('Error 的 rejection：寫一行帶標籤、帶堆疊的診斷，以 1 結束', () => {
    const proc = fakeProc();
    installFailLoud(NAME, proc);
    const error = new Error('boom');
    proc.rejection(error);
    expect(proc.written).toHaveLength(1);
    expect(proc.written[0]).toContain(`${NAME}: fatal load failure: `);
    expect(proc.written[0]).toContain(error.stack);
    expect(proc.exits).toEqual([1]);
  });

  // 一次安裝只報一顆（第一顆就是死因），所以每個格式案例各自裝。
  it('非 Error 的 rejection 照樣印；沒有 stack 的 Error 退回 message', () => {
    const plain = fakeProc();
    installFailLoud(NAME, plain);
    plain.rejection('plain failure');
    expect(plain.written[0]).toContain('plain failure');
    expect(plain.exits).toEqual([1]);

    const stackless = new Error('no stack');
    delete (stackless as { stack?: string }).stack;
    const bare = fakeProc();
    installFailLoud(NAME, bare);
    bare.rejection(stackless);
    expect(bare.written[0]).toContain('no stack');
    expect(bare.exits).toEqual([1]);
  });

  it('回傳的解除函式拿掉兩個 handler；預設的 proc 是真的 process', () => {
    const proc = fakeProc();
    const uninstall = installFailLoud(NAME, proc);
    expect(proc.handlers).toHaveLength(2);
    uninstall();
    expect(proc.handlers).toHaveLength(0);
    // 預設那一支：裝到真的行程、馬上解除，這一檔不留 handler，也絕不會結束測試行程。
    const before = [
      process.listenerCount('unhandledRejection'),
      process.listenerCount('uncaughtException'),
    ];
    const uninstallReal = installFailLoud(NAME);
    expect(process.listenerCount('unhandledRejection')).toBe(before[0]! + 1);
    expect(process.listenerCount('uncaughtException')).toBe(before[1]! + 1);
    uninstallReal();
    expect(process.listenerCount('unhandledRejection')).toBe(before[0]);
    expect(process.listenerCount('uncaughtException')).toBe(before[1]);
  });

  it('等 release 跑完才結束：收尾進行中退出碼還沒送出', async () => {
    const proc = fakeProc();
    const order: string[] = [];
    installFailLoud(NAME, proc, async () => {
      await Promise.resolve();
      order.push('released');
    });
    proc.rejection(new Error('sibling entry rejected'));
    expect(proc.written[0]).toContain(`${NAME}: fatal load failure: `);
    expect(proc.exits).toEqual([]);
    await vi.waitFor(() => {
      expect(proc.exits).toEqual([1]);
    });
    expect(order).toEqual(['released']);
  });

  it('release 拒絕也照樣以 1 結束', async () => {
    const proc = fakeProc();
    installFailLoud(NAME, proc, () => Promise.reject(new Error('dispose failed')));
    proc.rejection(new Error('boom'));
    await vi.waitFor(() => {
      expect(proc.exits).toEqual([1]);
    });
  });

  it('release 永不 settle：FAIL_LOUD_RELEASE_TIMEOUT_MS（2000ms）之後仍以 1 結束', async () => {
    expect(FAIL_LOUD_RELEASE_TIMEOUT_MS).toBe(2_000);
    vi.useFakeTimers();
    try {
      const proc = fakeProc();
      installFailLoud(NAME, proc, () => new Promise<void>(() => {}));
      proc.rejection(new Error('boom'));
      expect(proc.exits).toEqual([]);
      await vi.advanceTimersByTimeAsync(FAIL_LOUD_RELEASE_TIMEOUT_MS - 1);
      expect(proc.exits).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(proc.exits).toEqual([1]);
    } finally {
      vi.useRealTimers();
    }
  });

  // 失敗常常成串來；而且收尾自己的 disposer 也可能拒絕。只有第一顆是診斷，handler 要一直裝著，
  // 不然後來的一顆會變成沒人接的、在收尾中途殺掉行程。
  it('release 期間只報第一顆；後來的 rejection 與例外被吞，handler 一直裝著', async () => {
    const proc = fakeProc();
    let released = false;
    installFailLoud(NAME, proc, async () => {
      await Promise.resolve();
      released = true;
    });
    proc.rejection(new Error('first rejection'));
    proc.rejection(new Error('second rejection'));
    proc.exception(new Error('exception during teardown'));
    expect(proc.handlers).toHaveLength(2);
    expect(proc.written).toHaveLength(1);
    expect(proc.written[0]).toContain('first rejection');
    await vi.waitFor(() => {
      expect(proc.exits).toEqual([1]);
    });
    expect(released).toBe(true);
  });

  it('未捕捉的例外：標籤不同，診斷帶可列舉的屬性（code／syscall／path），以 1 結束', () => {
    const proc = fakeProc();
    installFailLoud(NAME, proc);
    const error = Object.assign(
      new Error("ENOENT: no such file or directory, open '/tmp/x/out.log'"),
      {
        errno: -2,
        code: 'ENOENT',
        syscall: 'open',
        path: '/tmp/x/out.log',
      },
    );
    proc.exception(error);
    expect(proc.written).toHaveLength(1);
    expect(proc.written[0]).toContain(`${NAME}: fatal uncaught exception: `);
    expect(proc.written[0]).toContain(error.stack);
    expect(proc.written[0]).toContain("code: 'ENOENT'");
    expect(proc.written[0]).toContain("syscall: 'open'");
    expect(proc.written[0]).toContain("path: '/tmp/x/out.log'");
    expect(proc.exits).toEqual([1]);
  });

  it('診斷帶 cause 鏈', () => {
    const proc = fakeProc();
    installFailLoud(NAME, proc);
    proc.exception(new Error('wrapper', { cause: new Error('root cause') }));
    expect(proc.written[0]).toContain('[cause]: Error: root cause');
    expect(proc.exits).toEqual([1]);
  });

  it('未捕捉的例外一樣等 release', async () => {
    const proc = fakeProc();
    let released = false;
    installFailLoud(NAME, proc, async () => {
      await Promise.resolve();
      released = true;
    });
    proc.exception(new Error('listener threw'));
    expect(proc.written[0]).toContain('fatal uncaught exception');
    expect(proc.exits).toEqual([]);
    await vi.waitFor(() => {
      expect(proc.exits).toEqual([1]);
    });
    expect(released).toBe(true);
  });

  it('診斷先於 release：release 卡住時死因已經在 stderr', () => {
    vi.useFakeTimers();
    try {
      const proc = fakeProc();
      installFailLoud(NAME, proc, () => new Promise<void>(() => {}));
      proc.rejection(new Error('死因'));
      expect(proc.written).toHaveLength(1);
      expect(proc.written[0]).toContain('死因');
      expect(proc.exits).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
