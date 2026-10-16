/**
 * 閒置逐出走完**serve 的組裝**（[#1484](https://github.com/DemianLi/nexus-agent/issues/1484)，驗收 B、E、G 的接線那一半）。
 *
 * `idle-eviction.test.ts` 直接把 `idleEvictMs` 傳給 wire handler，量的是逐出的語意；那種測法拿掉 `serve.ts` 把設定交給
 * handler 的那幾行也照樣綠。這一檔從 `runServe` 起——home 層放一份把 `thread-capacity` 的 `idleEvictAfterMs` 設小的 patch——
 * 量「設定列 → `startupSetting` → `createWireHandler` → 掃描 → 撤 → 重寫快照」整條線：
 *
 * - **接線**：閒置夠久真的被撤（伺服器日誌有 `[閒置逐出]`），撤完 `plugin-snapshot.json` 不再列它握著的設定版本。
 * - **B 等價於重啟**：同一組操作（說一輪、`/permission read-only`），一邊撤掉再開、一邊重啟 serve 再開，開出來的歷史與權限模式一樣。
 * - **沒落盤就不逐出**，而且啟動日誌明說「已設但不生效」。
 *
 * 輪詢間隔的下限是 1 秒，所以這一檔的每一條要等一兩秒。**零憑證、零外部連線**：模型是預設的假模型。
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WireClient } from '@nexus/wire';
import { emptyConversation, reduceAll } from '@nexus/wire';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { foldTurn, serveClient } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { seedHomePatch } from './plugin-journal.fixture.js';
import { PLUGIN_SNAPSHOT_FILE_NAME } from './plugin-snapshot.js';
import type { PluginSnapshot } from './plugin-snapshot.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';

const temporary: string[] = [];
const running: RunningServe[] = [];

beforeAll(() => {
  vi.stubEnv('NVIDIA_API_KEY', 'nvapi-fake-for-idle-eviction');
});
afterAll(() => {
  vi.unstubAllEnvs();
});
afterEach(async () => {
  for (const server of running.splice(0)) await server.close();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

const EVICT_PATCH = '- id: thread-capacity\n  config:\n    idleEvictAfterMs: 50\n';

interface Home {
  readonly env: NodeJS.ProcessEnv;
  readonly dir: string;
  readonly workspace: string;
  snapshot(): PluginSnapshot;
}

function home(patch?: string): Home {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-idle-evict-'));
  chmodSync(dir, 0o700);
  const workspace = mkdtempSync(join(tmpdir(), 'nexus-idle-evict-ws-'));
  temporary.push(dir, workspace);
  if (patch !== undefined) seedHomePatch(dir, patch);
  return {
    env: { [HARNESS_HOME_ENV]: dir },
    dir,
    workspace,
    snapshot: () =>
      JSON.parse(readFileSync(join(dir, PLUGIN_SNAPSHOT_FILE_NAME), 'utf8')) as PluginSnapshot,
  };
}

async function start(h: Home, lines: string[]): Promise<RunningServe> {
  const server = (await runServe({
    argv: ['--port', '0', '--workspace', h.workspace],
    log: (line) => void lines.push(line),
    env: h.env,
  })) as RunningServe;
  running.push(server);
  return server;
}

async function stop(server: RunningServe): Promise<void> {
  running.splice(running.indexOf(server), 1);
  await server.close();
}

async function until(predicate: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!predicate()) throw new Error('等太久了');
}

/** 開一條下行、說一輪、切成唯讀，然後放掉下行。回來時這條 thread 沒有任何東西在握著它。 */
async function setup(client: WireClient, thread: string): Promise<void> {
  const controller = new AbortController();
  const events = await client.openEvents(thread, { signal: controller.signal });
  expect((await client.runStart(thread, '記住暗號是藍鯨')).type).toBe('success');
  await foldTurn(events);
  const switched = await client.slashRun(thread, '/permission read-only');
  expect(switched).toMatchObject({ kind: 'success' });
  // 真的 server 在連線斷掉時中止的就是這個 signal。
  controller.abort();
  await events.return?.(undefined).catch(() => undefined);
}

/** 開出來的樣子：歷史折出來的每一則（人話、回覆、工具卡）與目前的權限模式。 */
async function observe(client: WireClient, thread: string, workspace: string) {
  const page = await client.threadHistory(thread);
  if (page.kind !== 'ok') throw new Error(`歷史拿不到：${page.message}`);
  const entries = reduceAll(emptyConversation(), page.result.events).entries.map((entry) => {
    switch (entry.kind) {
      case 'human':
        return `human:${entry.text}`;
      case 'ai':
        return `ai:${entry.text}`;
      case 'tool':
        return `tool:${entry.name}:${entry.status}`;
      default:
        return entry.kind;
    }
  });
  const permission = await client.slashRun(thread, '/permission');
  if (permission.kind !== 'success') throw new Error(`權限讀不到：${JSON.stringify(permission)}`);
  // 兩邊的工作區是各自的暫存目錄，路徑不同不是要比的東西。
  return { entries, permission: (permission.text ?? '').replaceAll(workspace, '<工作區>') };
}

const evictedLine = (lines: readonly string[], thread: string): boolean =>
  lines.some((line) => line.startsWith(`[閒置逐出] thread "${thread}"`));

describe('閒置逐出從 serve 組裝起（#1484）', () => {
  it('接線：設了就撤；撤完快照不再列它握著的設定版本；再開一次是重新組裝', async () => {
    const h = home(EVICT_PATCH);
    const lines: string[] = [];
    const server = await start(h, lines);
    expect(lines.some((line) => line.startsWith('thread 閒置逐出：閒置 50 毫秒'))).toBe(true);
    const client = await serveClient(server);
    await setup(client, 't1');
    // 前提：撤之前快照列著它。
    const echoBefore = h.snapshot().rows.find((row) => row.id === 'echo');
    expect(echoBefore?.live?.[0]?.threads).toContain('t1');

    await until(() => evictedLine(lines, 't1'));
    // 撤完才重寫快照（占位放掉之前），所以等它出現。
    await until(() => {
      const row = h.snapshot().rows.find((candidate) => candidate.id === 'echo');
      return !(row?.live ?? []).some((version) => version.threads.includes('t1'));
    });

    // 撤掉的 thread 再開：重新組裝，歷史與權限模式還在。
    const reopened = await observe(client, 't1', h.workspace);
    expect(reopened.entries.some((entry) => entry.startsWith('human:記住暗號'))).toBe(true);
    expect(reopened.permission).toContain('read-only');
  });

  it('B：撤掉再開 ＝ 重啟再開（同一組操作，歷史與權限模式一樣）', async () => {
    // 撤掉的那一邊。
    const evictHome = home(EVICT_PATCH);
    const lines: string[] = [];
    const evictServer = await start(evictHome, lines);
    const evictClient = await serveClient(evictServer);
    await setup(evictClient, 'alpha');
    await until(() => evictedLine(lines, 'alpha'));
    const afterEviction = await observe(evictClient, 'alpha', evictHome.workspace);

    // 重啟的那一邊：不設逐出，說完就收掉整台 serve，再起一台開同一條 thread。
    const restartHome = home();
    const first = await start(restartHome, []);
    await setup(await serveClient(first), 'alpha');
    await stop(first);
    const second = await start(restartHome, []);
    const afterRestart = await observe(await serveClient(second), 'alpha', restartHome.workspace);

    // 前提：兩邊都有東西可比（不是兩個空的相等）。
    expect(afterRestart.entries.length).toBeGreaterThan(1);
    expect(afterRestart.permission).toContain('read-only');
    expect(afterEviction).toEqual(afterRestart);
  });

  it('沒落盤：設了 idleEvictAfterMs 也不逐出，啟動日誌明說不生效', async () => {
    const h = home(`${EVICT_PATCH}- id: session-persistence\n  disabled: true\n`);
    const lines: string[] = [];
    const server = await start(h, lines);
    expect(lines.filter((line) => line.startsWith('thread 閒置逐出：'))).toEqual([
      expect.stringContaining('沒有開會話日誌'),
    ]);
    const client = await serveClient(server);
    const events = await client.openEvents('t1');
    expect((await client.runStart('t1', '說一句')).type).toBe('success');
    await foldTurn(events);
    await events.return?.(undefined);
    // 輪詢間隔 1 秒：等兩次以上，真的有在掃的話早就撤了。
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(lines.some((line) => line.startsWith('[閒置逐出]'))).toBe(false);
  });
});
