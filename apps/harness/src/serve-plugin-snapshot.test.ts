/**
 * serve 的「已儲存 vs 執行中」對照快照（[#1406](https://github.com/DemianLi/nexus-agent/issues/1406)）：量的是產品路徑
 * （`runServe` 加真的 wire client），在兩條對話之間改 home 層（#1412 起是變更紀錄），讀 home 底下那份 JSON 檔。
 *
 * 判準是「檔裡的列對得上 `--dump-config`」：同一個函式、同一個 home 層、同一組 `--patch`，列數與 id 一個都不能差。
 */

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { foldTurn, serveClient } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { seedHomePatch, writeJournalText } from './plugin-journal.fixture.js';
import { PLUGIN_SNAPSHOT_FILE_NAME } from './plugin-snapshot.js';
import type { PluginSnapshot } from './plugin-snapshot.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';

const temporary: string[] = [];
let running: RunningServe | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Home {
  readonly env: NodeJS.ProcessEnv;
  readonly dir: string;
  readonly snapshotPath: string;
  /**
   * 把 home 層整份換成這份設定。**測試專用，不是產品行為**：這一組量的是快照怎麼對照「已儲存」與「執行中」，
   * 不是寫入口；產品上紀錄只增不改（寫入口與它的驗證見 `plugin-change.test.ts`、`serve-thread-reread.test.ts`）。
   */
  patch(body: string): void;
  snapshot(): PluginSnapshot;
}

function home(): Home {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-plugin-snapshot-serve-'));
  temporary.push(dir);
  chmodSync(dir, 0o700);
  const snapshotPath = join(dir, PLUGIN_SNAPSHOT_FILE_NAME);
  return {
    env: { [HARNESS_HOME_ENV]: dir },
    dir,
    snapshotPath,
    patch(body) {
      seedHomePatch(dir, body);
    },
    snapshot: () => JSON.parse(readFileSync(snapshotPath, 'utf8')) as PluginSnapshot,
  };
}

async function start(env: NodeJS.ProcessEnv, lines: string[]): Promise<RunningServe> {
  const server = (await runServe({
    argv: ['--port', '0'],
    log: (line) => lines.push(line),
    env,
  })) as RunningServe;
  running = server;
  return server;
}

/** 在這條 thread 上說一句，讓它組裝一次（重讀一次清單）；建不起來就回錯誤訊息。 */
async function say(server: RunningServe, thread: string): Promise<string | undefined> {
  const client = await serveClient(server);
  const events = await client.openEvents(thread).catch((error: unknown) => error as Error);
  if (events instanceof Error) return events.message;
  try {
    const started = await client.runStart(thread, '說點什麼');
    if (started.type === 'error') return started.message;
    await foldTurn(events);
    return undefined;
  } finally {
    await events.return?.(undefined);
  }
}

/** `--dump-config` 印出來的列 id（同一個 home、同一組 patch）。 */
async function dumpedIds(env: NodeJS.ProcessEnv): Promise<string[]> {
  const lines: string[] = [];
  const result = await runServe({ argv: ['--dump-config'], log: (line) => lines.push(line), env });
  expect(result).toBeUndefined();
  const rows = parseYaml(lines.join('\n')) as { id?: string; name: string }[];
  return rows.map((row) => row.id ?? row.name);
}

describe('serve 的對照快照檔（#1406）', () => {
  it('啟動就寫一份：列數與 id 同 --dump-config，每一列都是 same，日誌記一行摘要與路徑', async () => {
    const h = home();
    const lines: string[] = [];
    await start(h.env, lines);
    expect(existsSync(h.snapshotPath)).toBe(true);
    const snapshot = h.snapshot();
    const ids = await dumpedIds(h.env);
    expect(ids.length).toBeGreaterThan(40);
    expect(snapshot.rows.map((row) => row.id)).toEqual(ids);
    expect(snapshot.summary).toEqual({ same: ids.length, 'next-thread': 0, restart: 0 });
    expect(snapshot.rows.every((row) => row.running.state === row.saved.state)).toBe(true);
    const summary = lines.filter((line) => line.startsWith('[對照快照]'));
    expect(summary).toHaveLength(1);
    expect(summary[0]).toContain(h.snapshotPath);
  }, 60000);

  it('兩條對話之間改 home 層：重讀後的檔把起動期讀的列標 restart、組裝期的標 next-thread', async () => {
    const h = home();
    const lines: string[] = [];
    const server = await start(h.env, lines);
    expect(await say(server, 'a')).toBeUndefined();
    expect(h.snapshot().summary).toMatchObject({ restart: 0, 'next-thread': 0 });

    h.patch(
      [
        '- id: thread-title',
        '  config:',
        '    maxWords: 3',
        '    maxBytes: 40',
        '- id: todo',
        '  disabled: true',
        '- insert:',
        '    - id: extra-echo',
        "      name: '@nexus/plugin-echo'",
        '',
      ].join('\n'),
    );
    expect(await say(server, 'b')).toBeUndefined();
    const snapshot = h.snapshot();
    const byId = new Map(snapshot.rows.map((row) => [row.id, row] as const));
    expect(byId.get('thread-title')?.sync).toBe('restart');
    expect(byId.get('todo')?.sync).toBe('next-thread');
    expect(byId.get('todo')?.saved).toEqual({ state: 'disabled' });
    expect(byId.get('extra-echo')).toMatchObject({
      running: { state: 'absent' },
      saved: { state: 'mounted' },
      sync: 'next-thread',
    });
    expect(snapshot.summary).toEqual({
      same: snapshot.rows.length - 3,
      'next-thread': 2,
      restart: 1,
    });
    // 列數與 id 仍同 --dump-config（新插進來的列接在最後）。
    expect(snapshot.rows.map((row) => row.id)).toEqual(await dumpedIds(h.env));
    // 日誌那一行只在 sync 變了才記：啟動一行、這一次一行。
    expect(lines.filter((line) => line.startsWith('[對照快照]'))).toHaveLength(2);
  }, 60000);

  it('改回去之後下一條對話：檔回到全部 same', async () => {
    const h = home();
    const server = await start(h.env, []);
    h.patch('- id: todo\n  disabled: true\n');
    expect(await say(server, 'a')).toBeUndefined();
    expect(h.snapshot().summary['next-thread']).toBe(1);
    h.patch('[]\n');
    expect(await say(server, 'b')).toBeUndefined();
    const snapshot = h.snapshot();
    expect(snapshot.summary).toEqual({ same: snapshot.rows.length, 'next-thread': 0, restart: 0 });
  }, 60000);

  it('設定值與 drop 原文不進檔：一列帶秘密字串的設定、一列寫壞的設定', async () => {
    const h = home();
    const server = await start(h.env, []);
    const secret = 'secret-token-9f3a';
    h.patch(
      [
        '- id: live-model',
        '  config:',
        `    baseUrl: 'https://${secret}.example.invalid/v1'`,
        '- id: todo',
        '  config:',
        `    allowParallelInProgress: '${secret}-bad'`,
        '',
      ].join('\n'),
    );
    expect(await say(server, 'a')).toBeUndefined();
    const text = readFileSync(h.snapshotPath, 'utf8');
    expect(text).not.toContain(secret);
    const snapshot = JSON.parse(text) as PluginSnapshot;
    const byId = new Map(snapshot.rows.map((row) => [row.id, row] as const));
    // 秘密所在的那一列確實進了對照，只是值不在裡面。
    expect(byId.get('live-model')?.sync).toBe('restart');
    expect(byId.get('todo')?.saved).toEqual({ state: 'dropped', dropStage: 'config' });
    expect(byId.get('todo')?.sync).toBe('next-thread');
  }, 60000);

  it('清單讀不起來的那一條對話：檔照舊，是上一次讀得起來的那一份', async () => {
    const h = home();
    const server = await start(h.env, []);
    const before = readFileSync(h.snapshotPath, 'utf8');
    writeJournalText(h.dir, '{這不是 JSON\n');
    expect(await say(server, 'a')).toBeDefined();
    expect(readFileSync(h.snapshotPath, 'utf8')).toBe(before);
  }, 60000);
});
