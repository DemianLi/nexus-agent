/**
 * 閒置逐出走完**serve 的組裝**（[#1484](https://github.com/DemianLi/nexus-agent/issues/1484)，驗收 B、E、G 的接線那一半）。
 *
 * `idle-eviction.test.ts` 直接把 `idleEvictMs` 傳給 wire handler，量的是逐出的語意；那種測法拿掉 `serve.ts` 把設定交給
 * handler 的那幾行也照樣綠。這一檔從 `runServe` 起——home 層放一份把 `thread-capacity` 的 `idleEvictAfterMs` 設小的 patch——
 * 量「設定列 → `startupSetting` → `createWireHandler` → 掃描 → 撤 → 重寫快照」整條線：
 *
 * - **接線**：閒置夠久真的被撤（伺服器日誌有 `[閒置逐出]`），撤完 `plugin-snapshot.json` 不再列它握著的設定版本。
 * - **B 等價於重啟**：同一組操作（說一輪、`/permission read-only`），一邊撤掉再開、一邊重啟 serve 再開，開出來的歷史與權限模式一樣。
 * - **goal 撤掉再開 ＝ 重啟再開**（#1486）：目標從落盤的日誌折回來，授權不持久（`/goal` 看得到的狀態兩邊一樣）。
 * - **沒落盤就不逐出**，而且啟動日誌明說「沒有落盤，不逐出」（#1619 起出廠就有 T，措辭不暗示管理者設錯了）。
 *
 * 輪詢間隔的下限是 1 秒，所以這一檔的每一條要等一兩秒。**零憑證、零外部連線**：模型是預設的假模型。
 */

import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WireClient } from '@nexus/wire';
import { emptyConversation, reduceAll } from '@nexus/wire';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { bodyLog, foldTurn, levelsOf, serveClient } from './fixtures.js';
import { HARNESS_HOME_ENV, HARNESS_SESSIONS_DIR_NAME } from './harness-home.js';
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

async function start(h: Home, lines: string[], raw?: string[]): Promise<RunningServe> {
  const server = (await runServe({
    argv: ['--port', '0', '--workspace', h.workspace],
    log: bodyLog(lines, raw),
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

/** 這條 thread 的 root 日誌（落盤的那一份）上，依序每一顆事件的型別與資料。 */
function rootLogEvents(h: Home, thread: string): { type: string; data: unknown }[] {
  const sessions = join(h.dir, HARNESS_SESSIONS_DIR_NAME);
  const [project] = readdirSync(sessions);
  const directory = join(sessions, project ?? '');
  const body = readdirSync(directory).find(
    (name) => name === `${thread}.jsonl` || name.startsWith(`${encodeURIComponent(thread)}.jsonl`),
  );
  if (body === undefined)
    throw new Error(`找不到 ${thread} 的日誌：${readdirSync(directory).join('、')}`);
  return readFileSync(join(directory, body), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { type: string; data: unknown });
}

const evictedLine = (lines: readonly string[], thread: string): boolean =>
  lines.some((line) => line.startsWith(`[閒置逐出] thread "${thread}"`));

describe('閒置逐出從 serve 組裝起（#1484）', () => {
  it('接線：設了就撤；撤完快照不再列它握著的設定版本；再開一次是重新組裝', async () => {
    const h = home(EVICT_PATCH);
    const lines: string[] = [];
    const raw: string[] = [];
    const server = await start(h, lines, raw);
    expect(lines.some((line) => line.startsWith('thread 閒置逐出：閒置 50 毫秒'))).toBe(true);
    const client = await serveClient(server);
    await setup(client, 't1');
    // 前提：撤之前快照列著它。
    const echoBefore = h.snapshot().rows.find((row) => row.id === 'echo');
    expect(echoBefore?.live?.[0]?.threads).toContain('t1');

    await until(() => evictedLine(lines, 't1'));
    // 等級：正常撤出記憶體是 info，不是 warn（#1534）；門檻調到 warn 的主機不為它出一行。
    expect(levelsOf(raw, '[閒置逐出] thread "t1"')).toEqual(['I']);
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

    // 重啟的那一邊：出廠的 2 小時（測試裡碰不到），說完就收掉整台 serve，再起一台開同一條 thread。
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

  it('E2：設了 defaultPreset 的部署，撤掉再開不重套預設組（fresh 判成 false）：重建後日誌沒有往別的值走、沒有再選組或改核准，權限模式仍是切過去的那一組', async () => {
    // 沒設 defaultPreset 的話，重套與不重套算出來的值一樣（都從日誌的值推），分不出 `fresh`；設了 `workspace-write`，
    // `fresh` 判成 true 就會把這條 thread 拉回 `workspace-write`。
    const h = home(
      `${EVICT_PATCH}- id: permission-presets\n  config:\n    defaultPreset: workspace-write\n`,
    );
    const lines: string[] = [];
    const client = await serveClient(await start(h, lines));
    await setup(client, 'alpha');
    const count = (events: readonly { type: string }[], type: string): number =>
      events.filter((event) => event.type === type).length;
    const evictions = (): number =>
      lines.filter((line) => line.startsWith('[閒置逐出] thread "alpha"')).length;
    // 落盤是批次的：撤掉（收尾）之後才讀得到完整的日誌。
    await until(() => evictions() >= 1);
    const before = rootLogEvents(h, 'alpha');
    // 前提：切過去之後日誌上真的有一顆讓這件事分得出勝負的東西（起始釘一顆、切換再一顆，最後一顆是唯讀）。
    expect(count(before, 'sandbox/mode')).toBeGreaterThanOrEqual(2);
    expect(before.filter((event) => event.type === 'sandbox/mode').at(-1)?.data).toMatchObject({
      mode: 'read-only',
    });

    const reopened = await observe(client, 'alpha', h.workspace);
    expect(reopened.permission).toContain('read-only');
    // 重建出來的 thread 再閒置一次、再被撤：它如果多寫了什麼，這時候才落盤。
    await until(() => evictions() >= 2);
    const after = rootLogEvents(h, 'alpha');
    // 重建出來的 thread 接上時，沙箱的參與者會照控制器的值再釘一顆 `sandbox/mode`（每次接上都釘，不是這一步的事）；
    // 要看的是**值**：重建之後沒有任何一顆往別的值走，也沒有人再選一次組、再改一次核准。
    const rebuilt = after.slice(before.length);
    expect(
      rebuilt.filter((event) => event.type === 'sandbox/mode').map((event) => event.data),
    ).not.toContainEqual(expect.objectContaining({ mode: 'workspace-write' }));
    expect(count(rebuilt, 'permission/preset')).toBe(0);
    expect(count(rebuilt, 'approval/policy')).toBe(0);
    expect(after.filter((event) => event.type === 'sandbox/mode').at(-1)?.data).toMatchObject({
      mode: 'read-only',
    });
  });

  it('goal：撤掉再開 ＝ 重啟再開（目標從落盤的日誌折回來；授權不持久，所以兩邊 /goal 讀到的一樣）', async () => {
    // 同一組操作：說一輪、建目標、暫停它（只有 active 且 armed 的目標擋逐出；暫停之後才撤得掉）。
    // serve 預設開續行排程器：目標一建出來就一輪接一輪地跑。`/goal pause` 跑著的時候也收（#1516，`runWhileBusy`），而且當場中止那一輪，
    // 所以直接打一次就好，不必賭兩輪之間的縫（以前這裡要重打到被接受為止，CI 慢時才過得了）。
    const goalSetup = async (client: WireClient, thread: string): Promise<void> => {
      const controller = new AbortController();
      const events = await client.openEvents(thread, { signal: controller.signal });
      expect((await client.runStart(thread, '開個頭')).type).toBe('success');
      await foldTurn(events);
      expect(await client.slashRun(thread, '/goal 把藍鯨計畫做完')).toMatchObject({
        kind: 'success',
      });
      expect(await client.slashRun(thread, '/goal pause')).toMatchObject({ kind: 'success' });
      controller.abort();
      await events.return?.(undefined).catch(() => undefined);
    };
    // 暫停前續行排程器跑了幾輪不是要比的東西（看機器快慢），其餘每一行都要一樣。
    const goalText = async (client: WireClient, thread: string): Promise<string> => {
      const shown = await client.slashRun(thread, '/goal');
      if (shown.kind !== 'success') throw new Error(`/goal 讀不到：${JSON.stringify(shown)}`);
      return (shown.text ?? '').replace(/輪次：\d+\//u, '輪次：N/');
    };

    // 撤掉的那一邊。
    const evictHome = home(EVICT_PATCH);
    const lines: string[] = [];
    const evictClient = await serveClient(await start(evictHome, lines));
    await goalSetup(evictClient, 'alpha');
    await until(() => evictedLine(lines, 'alpha'));
    const afterEviction = await goalText(evictClient, 'alpha');

    // 重啟的那一邊：出廠的 2 小時（測試裡碰不到），說完就收掉整台 serve，再起一台開同一條 thread。
    const restartHome = home();
    const first = await start(restartHome, []);
    await goalSetup(await serveClient(first), 'alpha');
    await stop(first);
    const afterRestart = await goalText(await serveClient(await start(restartHome, [])), 'alpha');

    // 前提：兩邊都真的折回了那個目標與它的暫停（不是兩個「沒有目標」相等）。
    expect(afterRestart).toContain('把藍鯨計畫做完');
    expect(afterRestart).toContain('狀態：暫停');
    expect(afterRestart).toContain('續行授權：未授權');
    expect(afterEviction).toBe(afterRestart);
  });

  it('沒落盤（#1619 驗收 E）：出廠值的部署，啟動日誌說「沒有落盤，不逐出」，不暗示設錯了', async () => {
    const lines: string[] = [];
    await start(home('- id: session-persistence\n  disabled: true\n'), lines);
    expect(lines.filter((line) => line.startsWith('thread 閒置逐出：'))).toEqual([
      'thread 閒置逐出：沒有落盤，不逐出（會話日誌只在記憶體裡，撤掉的 thread 回不來）',
    ]);
  });

  it('沒落盤：設了很短的 idleEvictAfterMs 也不逐出，啟動日誌同一句', async () => {
    const h = home(`${EVICT_PATCH}- id: session-persistence\n  disabled: true\n`);
    const lines: string[] = [];
    const server = await start(h, lines);
    expect(lines.filter((line) => line.startsWith('thread 閒置逐出：'))).toEqual([
      'thread 閒置逐出：沒有落盤，不逐出（會話日誌只在記憶體裡，撤掉的 thread 回不來）',
    ]);
    const client = await serveClient(server);
    // 下行要真的斷：`events.return()` 只放掉 reader、不關連線，訂閱者還掛著的話這條 thread 本來就不會被撤，測試就是空的。
    // 真的頁籤關掉時中止的就是這個 signal（同 `setup()`）。
    const controller = new AbortController();
    const events = await client.openEvents('t1', { signal: controller.signal });
    expect((await client.runStart('t1', '說一句')).type).toBe('success');
    await foldTurn(events);
    controller.abort();
    await events.return?.(undefined).catch(() => undefined);
    // 輪詢間隔 1 秒：等兩次以上，真的有在掃的話早就撤了。
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(lines.some((line) => line.startsWith('[閒置逐出]'))).toBe(false);
  });
});
