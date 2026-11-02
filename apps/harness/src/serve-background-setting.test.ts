/**
 * 背景續行的開關走過 `serve` 真的接到組裝點（[#841](https://github.com/DemianLi/nexus-agent/issues/841)）：
 * 攔在 `createCliAgent` 上看 serve 交給它的 `backgroundSubagents`。
 *
 * 只有 serve 讀那一列——`runCli` 不讀（REPL 一行一輪，沒有可以叫醒的一輪），那一條釘在 `cli.test.ts`。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const seen = vi.hoisted(() => ({ calls: [] as unknown[] }));

vi.mock('./assembly-root.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./assembly-root.js')>();
  return {
    ...original,
    createCliAgent: (...args: Parameters<typeof original.createCliAgent>) => {
      seen.calls.push((args[0] as { backgroundSubagents?: unknown }).backgroundSubagents);
      return original.createCliAgent(...args);
    },
  };
});

import { serveClient } from './fixtures.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';

let running: RunningServe | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
  seen.calls.length = 0;
});

async function assembleOneThread(patches: readonly string[]): Promise<unknown> {
  running = await runServe({
    argv: ['--port', '0', ...patches.flatMap((patch) => ['--patch', patch])],
    log: () => undefined,
    env: {},
  });
  const client = await serveClient(running as RunningServe);
  const events = await client.openEvents('bg-setting');
  await client.runStart('bg-setting', '嗨');
  for (;;) {
    const next = await events.next();
    if (next.done === true) break;
    if (next.value.method === 'lifecycle') break;
  }
  // 啟動時的試裝配（`serve.ts` 的 `trial`）先跑一次，不帶背景續行；**最後一次才是這條 thread 的**。
  expect(seen.calls.length).toBeGreaterThanOrEqual(2);
  return seen.calls.at(-1);
}

describe('serve 讀背景續行那一列', () => {
  it('出貨預設：續行開著，上限 8', async () => {
    // 落盤開著（出貨預設）就帶冷復活的存放處（#1271）。
    expect(await assembleOneThread([])).toEqual({ maxActive: 8, cold: expect.any(Object) });
  });

  it('patch 改上限：組裝點收到那個值（3 不是 8，量得出這一列真的在講話）', async () => {
    expect(await assembleOneThread(['src/settings/background-limit.patch.yml'])).toEqual({
      maxActive: 3,
      cold: expect.any(Object),
    });
  });

  it('patch 關成 one-shot：不傳，組裝點回到基座的 task', async () => {
    expect(await assembleOneThread(['src/settings/background-one-shot.patch.yml'])).toBeUndefined();
  });
});
