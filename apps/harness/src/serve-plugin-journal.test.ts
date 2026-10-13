/**
 * serve 讀變更紀錄那一層（[#1412](https://github.com/DemianLi/nexus-agent/issues/1412)）：量的是產品路徑
 * （`runServe` 加真的 wire client）。驗收表 E（未稽核的覆蓋層與舊檔）、G（啟動時壞掉的行）、H（沒有紀錄時不變）、
 * I（快照的「已儲存」反映紀錄）。
 */

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createCliAgent } from './assembly-root.js';
import { foldTurn, serveClient } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { toAgentInvocation } from './messages.js';
import { changePlugin } from './plugin-change.js';
import {
  loadDefaultPlugins,
  renderLayeredConfigDump,
  renderShippedConfigDump,
} from './plugin-config.js';
import {
  journalPathOf,
  readJournalText,
  seedHomePatch,
  writeJournalText,
} from './plugin-journal.fixture.js';
import { PLUGIN_SNAPSHOT_FILE_NAME } from './plugin-snapshot.js';
import type { PluginSnapshot } from './plugin-snapshot.js';
import type { ScriptedChatModel } from './scripted-model.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';

const temporary: string[] = [];
let running: RunningServe | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-serve-journal-'));
  chmodSync(dir, 0o700);
  temporary.push(dir);
  return { dir, env: { [HARNESS_HOME_ENV]: dir } };
}

async function start(
  env: NodeJS.ProcessEnv,
  lines: string[],
  extra: string[] = [],
): Promise<RunningServe> {
  const server = (await runServe({
    argv: ['--port', '0', ...extra],
    log: (line) => lines.push(line),
    env,
  })) as RunningServe;
  running = server;
  return server;
}

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

function snapshot(dir: string): PluginSnapshot {
  return JSON.parse(readFileSync(join(dir, PLUGIN_SNAPSHOT_FILE_NAME), 'utf8')) as PluginSnapshot;
}

describe('第一次啟動', () => {
  it('舊的 cordis.patch.yml 在：遷進紀錄、日誌記一行（不帶值）、舊檔改名；那一列照樣生效', async () => {
    const { dir, env } = home();
    const secret = 'secret-in-legacy-4d2b';
    const legacy = join(dir, 'cordis.patch.yml');
    writeFileSync(
      legacy,
      `- id: todo\n  disabled: true\n- id: live-model\n  config:\n    baseUrl: 'https://${secret}.example.invalid/v1'\n`,
    );
    chmodSync(legacy, 0o600);
    const lines: string[] = [];
    const server = await start(env, lines);
    expect(await say(server, 'a')).toBeUndefined();

    const migration = lines.filter((line) => line.includes('遷進變更紀錄'));
    expect(migration).toHaveLength(1);
    expect(migration[0]).toContain('2 條 patch');
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(journalPathOf(dir))).toBe(true);
    // 值在紀錄裡（明文、0600），不在伺服器日誌與快照裡。
    expect(readJournalText(dir)).toContain(secret);
    expect(lines.join('\n')).not.toContain(secret);
    expect(readFileSync(join(dir, PLUGIN_SNAPSHOT_FILE_NAME), 'utf8')).not.toContain(secret);
    const todo = snapshot(dir).rows.find((row) => row.id === 'todo');
    expect(todo?.saved.state).toBe('disabled');
    expect(snapshot(dir).layers?.journal).toMatchObject({ records: 2, lastSeq: 2 });
  }, 60000);

  it('沒有紀錄也沒有舊檔（驗收 H）：清單與出貨的逐字相同，日誌沒有任何跟紀錄有關的行', async () => {
    const { dir, env } = home();
    const lines: string[] = [];
    await start(env, lines);
    expect(lines.filter((line) => /變更紀錄|遷進|覆蓋層|cordis\.patch/u.test(line))).toEqual([]);
    // 空的紀錄檔是界線，不是一層：疊出來的跟只有出貨層的一個字不差。
    expect(readJournalText(dir)).toBe('');
    // 快照也沒有多出任何東西：`layers` 在沒有東西可講的時候整個不出現。
    expect(
      JSON.parse(readFileSync(join(dir, PLUGIN_SNAPSHOT_FILE_NAME), 'utf8')),
    ).not.toHaveProperty('layers');
    expect(renderLayeredConfigDump({ serve: true, env })).toBe(
      renderShippedConfigDump({ serve: true }),
    );
    const loaded = await loadDefaultPlugins({ serve: true, env });
    expect(loaded.layers).toEqual({
      journal: {
        path: journalPathOf(dir),
        exists: true,
        records: 0,
        lastSeq: null,
        pendingMigration: false,
      },
      overlays: [],
    });
    expect(snapshot(dir).summary['next-thread']).toBe(0);
    expect(snapshot(dir).rows.some((row) => row.unaudited === true)).toBe(false);
  }, 60000);
});

describe('快照的「已儲存」反映紀錄（驗收 I）', () => {
  it('寫入口停用一列、改一列起動期讀的設定：下一條 thread 之後，檔把它們標 next-thread／restart', async () => {
    const { dir, env } = home();
    const lines: string[] = [];
    const server = await start(env, lines);
    expect(await say(server, 'a')).toBeUndefined();

    await changePlugin({ op: 'disable', id: 'todo' }, { env });
    await changePlugin(
      {
        op: 'config-set',
        id: 'thread-title',
        config: { maxWords: 3, maxBytes: 40, maxTitleBytes: 80 },
      },
      { env },
    );
    expect(await say(server, 'b')).toBeUndefined();
    const byId = new Map(snapshot(dir).rows.map((row) => [row.id, row] as const));
    expect(byId.get('todo')).toMatchObject({ saved: { state: 'disabled' }, sync: 'next-thread' });
    expect(byId.get('thread-title')?.sync).toBe('restart');
    expect(snapshot(dir).layers?.journal).toMatchObject({ records: 2, lastSeq: 2 });
    // 寫入的那兩筆的值，不進日誌。
    expect(lines.filter((line) => line.includes('maxTitleBytes'))).toEqual([]);
  }, 60000);
});

describe('--patch 是不經過紀錄的路（驗收 E）', () => {
  it('日誌與快照標出它蓋到哪幾列；開關回 overridden、改設定被拒', async () => {
    const { dir, env } = home();
    const overlay = join(dir, 'ops.yml');
    writeFileSync(overlay, '- id: todo\n  disabled: true\n- id: goal\n  config:\n    n: 1\n');
    chmodSync(overlay, 0o600);
    const lines: string[] = [];
    const server = await start(env, lines, ['--patch', overlay]);
    expect(await say(server, 'a')).toBeUndefined();

    const notice = lines.filter((line) => line.includes('有未稽核的覆蓋層在作用'));
    expect(notice).toHaveLength(1);
    expect(notice[0]).toContain(overlay);
    expect(notice[0]).toContain('todo');
    expect(notice[0]).toContain('goal');

    const snap = snapshot(dir);
    expect(snap.layers?.overlays).toEqual([{ file: overlay, rows: ['todo', 'goal'] }]);
    const marked = snap.rows.filter((row) => row.unaudited === true).map((row) => row.id);
    expect([...marked].sort()).toEqual(['goal', 'todo']);

    // 寫入口帶同一組 --patch：啟用 todo 被 overlay 蓋回停用 → overridden（照寫）。
    const enable = await changePlugin({ op: 'enable', id: 'todo' }, { env, patches: [overlay] });
    expect(enable).toMatchObject({ outcome: 'recorded', effect: 'overridden' });
    // 同一個寫入再問一次，日誌那句不重複。
    expect(await say(server, 'b')).toBeUndefined();
    expect(lines.filter((line) => line.includes('有未稽核的覆蓋層在作用'))).toHaveLength(1);
  }, 60000);
});

describe('舊檔又出現（加 3）', () => {
  it('伺服器日誌記一次「看到、沒讀」，快照標出來，伺服器照常起', async () => {
    const { dir, env } = home();
    const lines: string[] = [];
    const first = await start(env, lines);
    await first.close();
    running = undefined;
    const planted = join(dir, 'cordis.patch.yml');
    writeFileSync(planted, '- id: todo\n  disabled: true\n');
    chmodSync(planted, 0o600);

    const second: string[] = [];
    const server = await start(env, second);
    expect(await say(server, 'a')).toBeUndefined();
    expect(await say(server, 'b')).toBeUndefined();
    const seen = second.filter((line) => line.includes('沒讀'));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain(planted);
    expect(snapshot(dir).layers?.journal?.ignoredLegacyPatch).toBe(planted);
    expect(snapshot(dir).rows.find((row) => row.id === 'todo')?.saved.state).toBe('mounted');
    expect(existsSync(planted)).toBe(true);
  }, 60000);
});

describe('壞掉的紀錄（驗收 G）', () => {
  it('啟動時：起不來，訊息指名第幾行；最後一行沒寫完不影響啟動', async () => {
    const { dir, env } = home();
    seedHomePatch(dir, '- id: todo\n  disabled: true\n- id: goal\n  disabled: true\n');
    const good = readJournalText(dir);
    // 半行：略過，起得來。
    writeJournalText(dir, `${good}{"v":1,"seq":3,"at":"2026-`);
    const server = await start(env, []);
    expect(await say(server, 'a')).toBeUndefined();
    await server.close();
    running = undefined;

    // 中間壞一行：起不來，指名第 2 行。
    const [first] = good.split('\n');
    writeJournalText(dir, `${first ?? ''}\n{壞掉\n${good.split('\n')[1] ?? ''}\n`);
    await expect(runServe({ argv: ['--port', '0'], log: () => undefined, env })).rejects.toThrow(
      /plugin-journal\.jsonl 第 2 行不是合法的 JSON/u,
    );
  }, 60000);
});

describe('列從紀錄導出', () => {
  it('停用的列不在 CLI 組裝綁的工具裡（驗收 A 的工具那一半），出貨的那一列沒被動', async () => {
    const { env } = home();
    const bound = async (): Promise<readonly string[]> => {
      const { plugins } = await loadDefaultPlugins({ env });
      const built = await createCliAgent({ live: false }, plugins);
      try {
        await built.agent.invoke(toAgentInvocation('說點什麼'), {
          configurable: { thread_id: 'j' },
        });
        return (built.model as ScriptedChatModel).boundToolNames;
      } finally {
        await built.dispose();
      }
    };
    const before = await bound();
    await changePlugin({ op: 'disable', id: 'todo' }, { env });
    const after = await bound();
    expect(before.filter((name) => !after.includes(name)).length).toBeGreaterThan(0);
    expect(after.filter((name) => !before.includes(name))).toEqual([]);
  }, 60000);
});
