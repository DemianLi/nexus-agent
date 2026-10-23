/**
 * 工具結果暫存的啟動清掃**放到背景**（#1553 N0952，照 dsh `spill-local/src/index.ts:90-101`），在兩個入口的產品路徑上量。
 *
 * `cleanupToolResultStash` 換成一顆受控、還沒 resolve 的 promise（只換這一支，模組其餘照舊），量四件事：
 *
 * 1. **不等**：清掃沒收斂，serve 已經在回應、CLI 已經跑完那一輪。
 * 2. **收尾等它**：serve 的 `close()`、CLI 的 `runCli`、以及 serve 在清掃之後才起不來的那條路，都在清掃收斂之後才結束。
 * 3. **停用**：`cleanupPeriodDays: 0` 一次都不叫，收尾照常。
 * 4. **清掃拒絕**：照 dsh 講一聲（伺服器日誌的 warn），serve 照常起來、收尾不拋。
 *
 * 每一條都先斷言替身真的被叫到，替身沒接上就不會空綠。
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assemblyWitness, resetAssemblyWitness } from './assembly-witness.fixture.js';
import { runCli } from './cli.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';

const sweep = vi.hoisted(() => ({ cleanup: vi.fn<() => Promise<number>>() }));

vi.mock('./tool-result-stash.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./tool-result-stash.js')>()),
  cleanupToolResultStash: sweep.cleanup,
}));

const WITNESS = fileURLToPath(new URL('./assembly-witness.patch.yml', import.meta.url));

/** 一顆由測試決定什麼時候 resolve 的清掃。 */
function heldSweep(): { readonly release: () => void } {
  let release!: () => void;
  const held = new Promise<number>((resolve) => {
    release = () => resolve(0);
  });
  sweep.cleanup.mockReturnValue(held);
  return { release };
}

/** `promise` 在 `ms` 毫秒內有沒有了結。 */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const settled = await Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]);
  clearTimeout(timer);
  return settled;
}

let running: RunningServe | undefined;
let release: (() => void) | undefined;

afterEach(async () => {
  release?.();
  release = undefined;
  await running?.close();
  running = undefined;
  sweep.cleanup.mockReset();
});

async function startServe(
  extra: readonly string[] = [],
  log: (line: string) => void = () => undefined,
): Promise<RunningServe> {
  return (await runServe({
    argv: ['--port', '0', ...extra],
    log,
    env: {},
  })) as RunningServe;
}

describe('serve：啟動清掃在背景', () => {
  it('清掃還沒收斂，serve 已經在回應；close() 等清掃收斂才結束', async () => {
    const held = heldSweep();
    release = held.release;

    const starting = startServe();
    // 把 `await` 放回啟動那一行，這一格就等不到 serve 起來。
    expect(await settlesWithin(starting, 30_000)).toBe(true);
    running = await starting;
    expect(sweep.cleanup).toHaveBeenCalledTimes(1);
    expect((await fetch(`${running.url}/livez`)).status).toBe(200);

    const closing = running.close();
    running = undefined;
    // 拿掉 disposer 裡的 `await`，close() 就不等清掃。
    expect(await settlesWithin(closing, 1_500)).toBe(false);
    held.release();
    await closing;
  }, 60_000);

  it('啟動在清掃之後才失敗（port 被占）：等清掃收斂才往外拋', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const port = (blocker.address() as AddressInfo).port;
    try {
      const held = heldSweep();
      release = held.release;
      resetAssemblyWitness();

      const starting = runServe({
        argv: ['--port', String(port), '--patch', WITNESS],
        log: () => undefined,
        env: {},
      });
      // 試組排在清掃之後、綁 port 之前：組過一次，就只差綁 port 那一步失敗。
      await vi.waitFor(
        () => {
          expect(assemblyWitness.applied).toBe(1);
        },
        { timeout: 30_000, interval: 20 },
      );
      expect(sweep.cleanup).toHaveBeenCalledTimes(1);
      // 拿掉 disposer 裡的 `await`，綁不上 port 就直接拋出去，不等清掃。
      expect(await settlesWithin(starting, 1_500)).toBe(false);
      held.release();
      await expect(starting).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  }, 60_000);

  it('cleanupPeriodDays: 0 一次都不叫，起來、收尾照常', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nexus-stash-sweep-'));
    const patch = join(dir, 'no-cleanup.patch.yml');
    await writeFile(
      patch,
      '- id: tool-result-stash\n  config:\n    cleanupPeriodDays: 0\n',
      'utf8',
    );
    // 萬一真的叫了，也不讓它卡住收尾：斷言抓的是次數。
    sweep.cleanup.mockResolvedValue(0);

    running = await startServe(['--patch', patch]);
    expect((await fetch(`${running.url}/livez`)).status).toBe(200);
    await running.close();
    running = undefined;
    expect(sweep.cleanup).not.toHaveBeenCalled();
  }, 60_000);

  it('清掃拒絕：伺服器日誌講一聲，serve 照常起來、收尾不拋', async () => {
    sweep.cleanup.mockRejectedValue(new Error('探針：清掃壞掉'));
    const lines: string[] = [];

    running = await startServe([], (line) => void lines.push(line));
    expect(sweep.cleanup).toHaveBeenCalledTimes(1);
    expect((await fetch(`${running.url}/livez`)).status).toBe(200);
    await expect(running.close()).resolves.toBeUndefined();
    running = undefined;
    expect(lines.some((line) => line.includes('[暫存] 背景清掃失敗：探針：清掃壞掉'))).toBe(true);
  }, 60_000);
});

describe('cli：啟動清掃在背景', () => {
  it('那一輪不等清掃；runCli 等清掃收斂才結束', async () => {
    const held = heldSweep();
    release = held.release;
    const lines: string[] = [];
    const record = (...parts: unknown[]): void => void lines.push(parts.join(' '));

    const done = runCli({
      argv: ['背景清掃的那一輪'],
      input: new PassThrough(),
      output: new PassThrough(),
      printer: { log: record, error: record },
      env: {},
    });
    // 把 `await` 放回啟動那一行，這一輪就不會開始。
    await vi.waitFor(
      () => {
        expect(lines.some((line) => line.includes('> 背景清掃的那一輪'))).toBe(true);
      },
      { timeout: 30_000, interval: 20 },
    );
    expect(sweep.cleanup).toHaveBeenCalledTimes(1);
    // 拿掉 disposer 裡的 `await`，這一輪跑完 runCli 就結束，不等清掃。
    expect(await settlesWithin(done, 3_000)).toBe(false);
    held.release();
    await done;
  }, 60_000);
});
