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
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { bodyLog, foldTurn, serveClient } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { changePlugin } from './plugin-change.js';
import type { PluginChange } from './plugin-change.js';
import { seedHomePatch } from './plugin-journal.fixture.js';
import type { ScriptedTurn } from './scripted-model.js';
import { scriptedPatchText } from './scripted-serve.js';
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

// ---------------------------------------------------------------------------------------------------------------------------
// 驗收 B、C、C2、F、G：thread 真的叫到 MCP 工具，模型換成腳本（`scriptedPatchText` 那一列寫進同一份 home patch）。
// ---------------------------------------------------------------------------------------------------------------------------

/** 套件那一台（舊協定）：`FIXTURE_EXIT_IF_FILE` 那個檔存在時一啟動就退出，用來讓重連放棄。 */
const EXITABLE_SERVER = fileURLToPath(
  new URL('../../../packages/nexus-plugin-mcp/src/fixture-server.ts', import.meta.url),
);

/** patch 裡的一列 stdio MCP。 */
interface McpRow {
  readonly serverName: string;
  readonly server: string;
  readonly marker: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly reconnect?: { initialDelayMs: number; maxDelayMs: number; maxAttempts: number };
}

function rowConfig(row: McpRow): Record<string, unknown> {
  return {
    serverName: row.serverName,
    approval: { default: 'allow' },
    ...(row.reconnect !== undefined && { reconnect: row.reconnect }),
    connection: {
      transport: 'stdio',
      command: process.execPath,
      args: ['--import', 'tsx', row.server, row.marker],
      ...(row.env !== undefined && { env: row.env }),
    },
  };
}

/** 一個私有 home：腳本模型、閒置逐出 50 毫秒、這幾列 MCP（設定用 JSON 寫，YAML 的子集）。 */
function scriptedHome(rows: readonly McpRow[], turns: readonly ScriptedTurn[]) {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-mcp-shared-'));
  chmodSync(dir, 0o700);
  temporary.push(dir);
  for (const row of rows) markers.push(row.marker);
  const extra = [
    '- id: thread-capacity',
    '  config:',
    '    idleEvictAfterMs: 50',
    '- insert:',
    ...rows.flatMap((row) => [
      `    - id: mcp-${row.serverName}`,
      "      name: '@nexus/plugin-mcp'",
      `      config: ${JSON.stringify(rowConfig(row))}`,
    ]),
    '',
  ].join('\n');
  seedHomePatch(dir, scriptedPatchText(turns, extra));
  const env = { [HARNESS_HOME_ENV]: dir };
  return { dir, env, change: (change: PluginChange) => changePlugin(change, { env }) };
}

/** 一條握著下行的 thread：`say` 跑一輪、回這一輪工具那幾格的文字；`release` 放掉下行，之後逐出掃得到。 */
async function hold(server: RunningServe, thread: string) {
  const client = await serveClient(server);
  const controller = new AbortController();
  const events = await client.openEvents(thread, { signal: controller.signal });
  return {
    async say(): Promise<string> {
      expect((await client.runStart(thread, '動手')).type).toBe('success');
      const state = await foldTurn(events);
      return JSON.stringify(state.entries.filter((entry) => entry.kind === 'tool'));
    },
    async release(): Promise<void> {
      controller.abort();
      await events.return?.(undefined).catch(() => undefined);
    },
  };
}

/** 每一次 `say` 吃兩格：叫一次工具、收工。腳本每條 thread 從頭吃，所以同一條說幾次就要幾份。 */
function callTwice(name: string, args: Record<string, unknown>): ScriptedTurn[] {
  const once: ScriptedTurn[] = [{ content: '', toolCalls: [{ name, args }] }, { content: '收工' }];
  return [...once, ...once];
}

async function startServe(env: NodeJS.ProcessEnv, lines: string[]): Promise<RunningServe> {
  running = (await runServe({ argv: ['--port', '0'], log: bodyLog(lines), env })) as RunningServe;
  return running;
}

const readLines = (path: string): string[] =>
  existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : [];

describe('驗收 B：兩列不同 serverName', () => {
  it('開 3 條 thread：一列一個子行程，共 2 個', async () => {
    const one = { serverName: 'crm', server: LEGACY_SERVER, marker: `--marker-${randomUUID()}` };
    const two = { serverName: 'erp', server: LEGACY_SERVER, marker: `--marker-${randomUUID()}` };
    const h = scriptedHome([one, two], callTwice('mcp__crm__record_order', { item: 'x' }));
    const server = await startServe(h.env, []);
    const held = await Promise.all(['a', 'b', 'c'].map((thread) => hold(server, thread)));
    for (const thread of held) expect(await thread.say()).toContain('已登記：x');
    expect((await settle(one.marker)).stable).toBe(1);
    expect((await settle(two.marker)).stable).toBe(1);
  }, 60_000);
});

describe('驗收 C、C2：執行中改那一列的設定', () => {
  /**
   * 版本記號是 `FIXTURE_CALL_LOG`：server 每被叫一次 `record_order` 就往那個檔附加一行。改設定時把它指到另一個檔，新的那一份
   * 連線寫新檔、舊的寫舊檔——所以哪一個檔多了一行，就是那一次呼叫打到哪一份。
   */
  it('新 thread 連到新的一份、開著的照舊用舊的；舊 thread 逐出之後舊的一份照 A′ 留到 serve 結束', async () => {
    const marker = `--marker-${randomUUID()}`;
    const dir = mkdtempSync(join(tmpdir(), 'nexus-mcp-version-'));
    temporary.push(dir);
    const v1 = join(dir, 'v1.log');
    const v2 = join(dir, 'v2.log');
    const row = { serverName: 'crm', server: LEGACY_SERVER, marker, env: { FIXTURE_CALL_LOG: v1 } };
    const h = scriptedHome([row], callTwice('mcp__crm__record_order', { item: 'x' }));
    const lines: string[] = [];
    const server = await startServe(h.env, lines);

    const a = await hold(server, 'a');
    const b = await hold(server, 'b');
    expect(await a.say()).toContain('已登記：x');
    expect(await b.say()).toContain('已登記：x');
    expect(readLines(v1)).toHaveLength(2);
    expect((await settle(marker)).stable).toBe(1);

    const written = await h.change({
      op: 'config-set',
      id: 'mcp-crm',
      config: rowConfig({ ...row, env: { FIXTURE_CALL_LOG: v2 } }),
    });
    expect(written).toMatchObject({ outcome: 'recorded', effect: 'next-thread' });

    // 先確認 #1405 的重讀在下一條 thread 生效（打到新檔），再數子行程。
    const c = await hold(server, 'c');
    expect(await c.say()).toContain('已登記：x');
    expect(readLines(v2)).toHaveLength(1);
    expect(readLines(v1)).toHaveLength(2);
    expect((await settle(marker)).stable).toBe(2);
    // 開著的舊 thread 照舊打到舊的那一份。
    expect(await a.say()).toContain('已登記：x');
    expect(readLines(v1)).toHaveLength(3);
    expect(readLines(v2)).toHaveLength(1);

    // C2：兩條舊 thread 逐出。A′：不數使用者、不回收，舊的一份留到 serve 結束。
    await a.release();
    await b.release();
    await until(() => lines.filter((line) => line.includes('[閒置逐出]')).length >= 2);
    expect((await settle(marker)).stable).toBe(2);
    await c.release();
  }, 60_000);
});

describe('驗收 F：殺掉共用的那個子行程', () => {
  it('只起 1 個新的；兩條 thread 在重連之後都叫得動；重連進度記在伺服器日誌', async () => {
    const marker = `--marker-${randomUUID()}`;
    const row = {
      serverName: 'crm',
      server: LEGACY_SERVER,
      marker,
      reconnect: { initialDelayMs: 40, maxDelayMs: 160, maxAttempts: 5 },
    };
    const h = scriptedHome([row], callTwice('mcp__crm__record_order', { item: 'x' }));
    const lines: string[] = [];
    const server = await startServe(h.env, lines);
    const a = await hold(server, 'a');
    const b = await hold(server, 'b');
    expect(await a.say()).toContain('已登記：x');
    const before = (await settle(marker)).pids;
    expect(before).toHaveLength(1);

    for (const pid of before) signalPid(pid, 'SIGKILL');
    await until(() => lines.some((line) => line.startsWith('mcp-client(crm): reconnected')));
    const after = (await settle(marker)).pids;
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(before[0]);
    expect(await a.say()).toContain('已登記：x');
    expect(await b.say()).toContain('已登記：x');
    expect(lines.filter((line) => line.startsWith('mcp-client(crm): reconnected'))).toHaveLength(1);
  }, 60_000);
});

describe('驗收 G：重連放棄之後（Q5 (b)）', () => {
  it('開著的 thread 叫到的是「已放棄」；下一條新 thread 重開一份、叫得動', async () => {
    const marker = `--marker-${randomUUID()}`;
    const dir = mkdtempSync(join(tmpdir(), 'nexus-mcp-giveup-'));
    temporary.push(dir);
    const flag = join(dir, 'down');
    const row = {
      serverName: 'srv',
      server: EXITABLE_SERVER,
      marker,
      env: { FIXTURE_EXIT_IF_FILE: flag },
      reconnect: { initialDelayMs: 20, maxDelayMs: 40, maxAttempts: 2 },
    };
    const h = scriptedHome([row], callTwice('mcp__srv__fetch_release_note', { topic: '版本' }));
    const lines: string[] = [];
    const server = await startServe(h.env, lines);
    const a = await hold(server, 'a');
    expect(await a.say()).toContain('版本｜');

    writeFileSync(flag, '');
    for (const pid of (await settle(marker)).pids) signalPid(pid, 'SIGKILL');
    await until(() => lines.some((line) => line.includes('giving up after 2 consecutive')));
    unlinkSync(flag);

    const b = await hold(server, 'b');
    expect(await b.say()).toContain('版本｜');
    expect(await a.say()).toContain('reconnection was given up');
    expect((await settle(marker)).stable).toBe(1);
  }, 60_000);
});

describe('起動失敗也收池', () => {
  /**
   * 綁 port 在試組之後（試組已經從池連上那一份）：port 被佔走，serve 起不來，那個子行程也要跟著收掉，不能活過 `runServe`。
   */
  it('試組之後才失敗（port 被佔）：子行程數回到 0', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const address = blocker.address();
    if (address === null || typeof address === 'string') throw new Error('拿不到 port');
    try {
      const marker = `--marker-${randomUUID()}`;
      const lines: string[] = [];
      const outcome = await runServe({
        argv: ['--port', String(address.port)],
        log: bodyLog(lines),
        env: home(LEGACY_SERVER, marker),
      }).catch((error: unknown) => error);
      expect(outcome === undefined || outcome instanceof Error).toBe(true);
      expect((await settle(marker)).stable).toBe(0);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  }, 60_000);
});
