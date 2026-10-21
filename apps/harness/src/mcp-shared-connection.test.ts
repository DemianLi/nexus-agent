/**
 * serve 上一列 stdio MCP 同時活著幾個子行程（[#1677](https://github.com/DemianLi/nexus-agent/issues/1677) 第 1 步的量具，之後是驗收 A、D 的量具）。
 *
 * **量的是 server 那一側**：`pgrep -f -- <記號>` 數到的子行程，不是 client 自己說連了幾次。記號放在 server 的 `args` 裡。
 *
 * 起法照卡上第 1 步：直接 `runServe`，MCP 那一列寫進暫存 home 的 patch（`seedHomePatch`），env 給那個 home。不用 `--patch`
 * （之後驗收 C 要在執行中 `plugin config set` 那一列，`--patch` 插的列會蓋掉它），也不用 `startScriptedServe`（它傳 `env: {}`，
 * 會話日誌會解到預設的 home，而逐出非要落盤不可）。模型是預設的假模型，零憑證、零外部連線。
 *
 * 兩支夾具各量一次：[`mcp-fixture-server.ts`](./mcp-fixture-server.ts)（舊協定）與
 * `packages/nexus-plugin-mcp/src/modern-stdio-server.ts`（新協定，版本協商可能多起探測行程，所以讀數要等穩定）。
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { bodyLog, foldTurn, serveClient } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { seedHomePatch } from './plugin-journal.fixture.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';
import { signalPid } from './test-pids.fixture.js';

const LEGACY_SERVER = fileURLToPath(new URL('./mcp-fixture-server.ts', import.meta.url));
const MODERN_SERVER = fileURLToPath(
  new URL('../../../packages/nexus-plugin-mcp/src/modern-stdio-server.ts', import.meta.url),
);

const temporary: string[] = [];
const markers: string[] = [];
let running: RunningServe | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
  for (const marker of markers.splice(0))
    for (const pid of pidsOf(marker)) signalPid(pid, 'SIGKILL');
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 命令列含記號的行程；不經 shell（同 `idle-eviction.test.ts`）。 */
function pidsOf(marker: string): number[] {
  try {
    return execFileSync('pgrep', ['-f', '--', marker])
      .toString()
      .split('\n')
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

/**
 * 一次讀數：連續兩次相同的 pid 集合才算穩定（版本協商的探測行程會來了又走），峰值另外記。記 pid 不只記個數：
 * 「起來後」與「3 條 thread 後」都是 1 的話，要是**同一個** pid 才證明試組連上的那一份留給了 thread 用。
 */
interface Reading {
  readonly stable: number;
  readonly peak: number;
  readonly pids: readonly number[];
}

async function settle(marker: string, ms = 10_000): Promise<Reading> {
  const deadline = Date.now() + ms;
  let peak = 0;
  let previous: string | undefined;
  for (;;) {
    const pids = pidsOf(marker).sort((a, b) => a - b);
    peak = Math.max(peak, pids.length);
    if (pids.join(',') === previous) return { stable: pids.length, peak, pids };
    if (Date.now() > deadline) throw new Error(`行程一直在變：最後 ${pids.join(',')}`);
    previous = pids.join(',');
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

async function until(predicate: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** 一個私有 home：插一列 stdio MCP（`args` 帶記號），閒置逐出調到 50 毫秒。 */
function home(server: string, marker: string): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-mcp-shared-'));
  chmodSync(dir, 0o700);
  temporary.push(dir);
  markers.push(marker);
  seedHomePatch(
    dir,
    [
      '- id: thread-capacity',
      '  config:',
      '    idleEvictAfterMs: 50',
      '- insert:',
      '    - id: mcp-crm',
      "      name: '@nexus/plugin-mcp'",
      '      config:',
      '        serverName: crm',
      '        approval: { default: allow }',
      '        connection:',
      '          transport: stdio',
      `          command: ${JSON.stringify(process.execPath)}`,
      `          args: ['--import', 'tsx', ${JSON.stringify(server)}, ${JSON.stringify(marker)}]`,
      '',
    ].join('\n'),
  );
  return { [HARNESS_HOME_ENV]: dir };
}

/**
 * 開一條對話跑一輪，**握著下行**：逐出的條件之一是沒有人訂閱（`wire-handler.ts` 的 `subscriberCount === 0`），握著它這條
 * thread 就不會在量到之前被撤掉。回「放掉下行」的函式，放掉之後逐出掃得到。
 */
async function openThread(server: RunningServe, thread: string): Promise<() => Promise<void>> {
  const client = await serveClient(server);
  const controller = new AbortController();
  const events = await client.openEvents(thread, { signal: controller.signal });
  expect((await client.runStart(thread, '說點什麼')).type).toBe('success');
  await foldTurn(events);
  return async () => {
    controller.abort();
    await events.return?.(undefined).catch(() => undefined);
  };
}

describe.each([
  ['舊協定', LEGACY_SERVER],
  ['新協定', MODERN_SERVER],
])('一列 stdio MCP 的子行程數（%s 夾具）', (label, server) => {
  it('起來後、開 3 條 thread 後、全部逐出後、收掉後', async () => {
    const marker = `--marker-${randomUUID()}`;
    const lines: string[] = [];
    running = (await runServe({
      argv: ['--port', '0'],
      log: bodyLog(lines),
      env: home(server, marker),
    })) as RunningServe;
    const readings: Record<string, Reading> = {};

    readings['起來後'] = await settle(marker);
    const releases: (() => Promise<void>)[] = [];
    for (const thread of ['a', 'b', 'c']) releases.push(await openThread(running, thread));
    readings['3 條 thread 後'] = await settle(marker);
    for (const release of releases) await release();
    await until(() => lines.filter((line) => line.includes('[閒置逐出]')).length >= 3);
    readings['全部逐出後'] = await settle(marker);
    await running.close();
    running = undefined;
    readings['收掉後'] = await settle(marker);

    console.log(`#1677 ${label}：${JSON.stringify(readings)}`);
    // 改之前（c5fe199b 量到）：0／3／0／0，每條 thread 各起一個、逐出就收。
    // 改之後（驗收 A、D、D2）：試組連上的那一份留給 thread 用，逐出之後目前的版本照樣留著，收掉才關。
    expect(Object.fromEntries(Object.entries(readings).map(([at, r]) => [at, r.stable]))).toEqual({
      起來後: 1,
      '3 條 thread 後': 1,
      全部逐出後: 1,
      收掉後: 0,
    });
    expect(
      new Set(
        [readings['起來後'], readings['3 條 thread 後'], readings['全部逐出後']].map(
          (r) => r?.pids[0],
        ),
      ).size,
    ).toBe(1);
  }, 60_000);
});
