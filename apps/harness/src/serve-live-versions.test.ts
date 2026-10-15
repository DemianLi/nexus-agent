/**
 * 快照裡「活著的設定版本」（[#1442](https://github.com/DemianLi/nexus-agent/issues/1442)）：量的是產品路徑
 * （`runServe` 加真的 wire client）——開幾條 thread、在中間用 home 層改設定，讀 home 底下那份 JSON 檔。
 *
 * 清單的單元層（哪些列綁、表怎麼增減、`current` 怎麼算）在 `plugin-live-versions.test.ts`。這一檔只問端到端：
 * 兩版並存（樹上的列與相容層的列各一次）、改回來是同一版、不綁的情況、秘密不進檔、只看歷史也算、子代理只綁 root、
 * 開機後快照不變。
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { foldTurn, serveClient } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { aiDone, idleWithContent, runServeDriver, settle } from './log-derived-history.fixture.js';
import type { Body, DriverRun, Reply, Script } from './log-derived-history.fixture.js';
import { seedHomePatch, writeJournalText } from './plugin-journal.fixture.js';
import { loadDefaultPlugins } from './plugin-config.js';
import { declarationSignature } from './plugin-row-state.js';
import { PLUGIN_SNAPSHOT_FILE_NAME } from './plugin-snapshot.js';
import type { PluginSnapshot, PluginSnapshotRow } from './plugin-snapshot.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';
import { hmacHashOf, loadConfigHashKey } from './session-header-metadata.js';

const temporary: string[] = [];
let running: RunningServe | undefined;

beforeAll(() => {
  vi.stubEnv('NVIDIA_API_KEY', 'nvapi-fake-for-live-versions');
});
afterAll(() => {
  vi.unstubAllEnvs();
});
afterEach(async () => {
  await running?.close();
  running = undefined;
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Home {
  readonly env: NodeJS.ProcessEnv;
  readonly dir: string;
  readonly snapshotPath: string;
  /** 把 home 層整份換成這份設定（測試專用，同 `serve-plugin-snapshot.test.ts`）。 */
  patch(body: string): void;
  snapshot(): PluginSnapshot;
  /** 檔案原文：比「沒有被重寫」用。 */
  text(): string;
}

function home(): Home {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-live-versions-serve-'));
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
    text: () => readFileSync(snapshotPath, 'utf8'),
  };
}

async function start(env: NodeJS.ProcessEnv): Promise<RunningServe> {
  const server = (await runServe({
    argv: ['--port', '0'],
    log: () => undefined,
    env,
  })) as RunningServe;
  running = server;
  return server;
}

/** 這條 thread 上說一句，讓它組裝一次；建不起來就回錯誤訊息。 */
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

const rowOf = (snapshot: PluginSnapshot, id: string): PluginSnapshotRow => {
  const row = snapshot.rows.find((candidate) => candidate.id === id);
  if (row === undefined) throw new Error(`快照上沒有 ${id}`);
  return row;
};

const ECHO_X = [
  '- id: echo',
  '  config:',
  '    prefix: x',
  '- id: todo',
  '  config:',
  '    allowParallelInProgress: false',
  '',
].join('\n');

describe('活著的設定版本（#1442）', () => {
  it('兩版並存、改回來是同一版：樹上的列（echo）與相容層的列（todo）各做一次（驗收 A、B）', async () => {
    const h = home();
    const server = await start(h.env);
    expect(await say(server, 't1')).toBeUndefined();
    expect(await say(server, 't2')).toBeUndefined();

    const first = h.snapshot();
    for (const id of ['echo', 'todo']) {
      const live = rowOf(first, id).live;
      expect(live, id).toHaveLength(1);
      expect(live?.[0]).toMatchObject({ current: true, threads: ['t1', 't2'] });
      expect(live?.[0]?.version).toMatch(/^hmac-sha256:[0-9a-f]{16}$/u);
    }
    // 遷上樹的 skills（#1446）也是掛上的列、next-thread 那一類：自動進表，沒有為它加任何程式。
    expect(rowOf(first, 'skills').live?.[0]).toMatchObject({
      current: true,
      threads: ['t1', 't2'],
    });
    const oldVersion = {
      echo: rowOf(first, 'echo').live![0]!.version,
      todo: rowOf(first, 'todo').live![0]!.version,
    };

    // 改設定之後、開下一條 thread 之前：檔沒有被重寫，`current` 的時間點同 `saved`，還指著舊版。
    const before = h.text();
    h.patch(ECHO_X);
    expect(h.text()).toBe(before);

    expect(await say(server, 't3')).toBeUndefined();
    const second = h.snapshot();
    for (const id of ['echo', 'todo'] as const) {
      const live = rowOf(second, id).live;
      expect(live, id).toEqual([
        { version: oldVersion[id], current: false, threads: ['t1', 't2'] },
        {
          version: expect.stringMatching(/^hmac-sha256:[0-9a-f]{16}$/u),
          current: true,
          threads: ['t3'],
        },
      ]);
      expect(live?.[1]?.version).not.toBe(oldVersion[id]);
    }

    // 改回原值：下一條綁在舊版那一項，舊版變回 current，新版變成不是。
    h.patch('[]\n');
    expect(await say(server, 't4')).toBeUndefined();
    const third = h.snapshot();
    for (const id of ['echo', 'todo'] as const) {
      const live = rowOf(third, id).live;
      expect(
        live?.map((entry) => entry.threads),
        id,
      ).toEqual([['t1', 't2', 't4'], ['t3']]);
      expect(
        live?.map((entry) => entry.current),
        id,
      ).toEqual([true, false]);
      expect(live?.[0]?.version).toBe(oldVersion[id]);
    }
  }, 120_000);

  it('不綁的情況：起動期讀的列、停用的列、掉了的列；讀不起來而建不起來的 thread 也不綁（驗收 C）', async () => {
    const h = home();
    h.patch(
      [
        '- id: goal',
        '  disabled: true',
        '- id: todo',
        '  config:',
        "    allowParallelInProgress: '不是布林'",
        '',
      ].join('\n'),
    );
    const server = await start(h.env);
    expect(await say(server, 'ok')).toBeUndefined();
    const snapshot = h.snapshot();
    // 起動期讀的列：生效的是啟動那一份，不進表。
    for (const id of ['thread-title', 'live-model', 'browser-session']) {
      expect(rowOf(snapshot, id).live, id).toBeUndefined();
    }
    // 停用的列、設定驗不過掉了的列：這條 thread 沒掛上它們。
    expect(rowOf(snapshot, 'goal').live).toBeUndefined();
    expect(rowOf(snapshot, 'todo').live).toBeUndefined();
    // 掛上的列綁了。
    expect(rowOf(snapshot, 'echo').live?.[0]?.threads).toEqual(['ok']);

    // 組裝失敗（紀錄壞了讀不起來）的 thread：沒有綁，檔也沒被它改。
    writeJournalText(h.dir, '{這不是 JSON\n');
    const before = h.text();
    expect(await say(server, 'broken')).toBeDefined();
    expect(h.text()).toBe(before);
    expect(JSON.stringify(h.snapshot())).not.toContain('broken');
  }, 120_000);

  it('組裝時才掉的列（apply 拋）：這條 thread 不綁它，先前掛上的 thread 還握著舊版', async () => {
    const h = home();
    // 一顆假插件：設定沒有 `ok: true` 就在 `apply` 裡拋（同 `serve-thread-reread.test.ts` 的 probe）。
    const module = join(h.dir, 'probe.ts');
    writeFileSync(
      module,
      [
        'export default {',
        "  name: 'probe',",
        '  apply(_registry, config) {',
        "    if (config?.ok !== true) throw new Error('故意在 apply 裡壞掉');",
        '  },',
        '};',
        '',
      ].join('\n'),
    );
    chmodSync(module, 0o600);
    const probe = (ok: boolean): string =>
      [
        '- insert:',
        '    - id: probe',
        "      name: './probe.ts'",
        '      config:',
        `        ok: ${String(ok)}`,
        '',
      ].join('\n');
    h.patch(probe(true));
    const server = await start(h.env);
    expect(await say(server, 't1')).toBeUndefined();
    expect(rowOf(h.snapshot(), 'probe').live).toMatchObject([{ current: true, threads: ['t1'] }]);

    h.patch(probe(false));
    // 這一條照樣建得起來（那一列可少掛），只是 probe 這一列在 `apply` 掉了。
    expect(await say(server, 't2')).toBeUndefined();
    const live = rowOf(h.snapshot(), 'probe').live;
    expect(live?.flatMap((entry) => entry.threads)).toEqual(['t1']);
    expect(live?.[0]?.current).toBe(false);
    // 沒掉的列照綁。
    expect(rowOf(h.snapshot(), 'todo').live?.[0]?.threads).toEqual(['t1', 't2']);
  }, 120_000);

  it('停用之後開出下一條 thread：舊版沒有任何一版是 current，列得出還握著它的 thread（PM 審查第 3 項）', async () => {
    const h = home();
    const server = await start(h.env);
    expect(await say(server, 't1')).toBeUndefined();
    expect(rowOf(h.snapshot(), 'todo').live).toMatchObject([{ current: true, threads: ['t1'] }]);

    // 兩種「列不再掛上」：todo 是相容層的列、echo 是樹上的列，各停用一次。
    h.patch(['- id: todo', '  disabled: true', '- id: echo', '  disabled: true', ''].join('\n'));
    expect(await say(server, 't2')).toBeUndefined();
    const snapshot = h.snapshot();
    for (const id of ['todo', 'echo']) {
      const live = rowOf(snapshot, id).live;
      // t2 沒掛上這一列，所以沒有新的一版；t1 握著的那一版不是下一條新對話會拿到的。
      expect(live, id).toMatchObject([{ current: false, threads: ['t1'] }]);
      // operations.md 的 jq：`select(.current | not) | .threads[]`。
      expect(
        live?.filter((entry) => !entry.current).flatMap((entry) => entry.threads),
        id,
      ).toEqual(['t1']);
    }
    // 沒停用的列不受影響。
    expect(rowOf(snapshot, 'goal').live?.[0]).toMatchObject({
      current: true,
      threads: ['t1', 't2'],
    });
  }, 120_000);

  it('設定值不進檔：版本是帶鍵雜湊，秘密字串找不到（驗收 E）', async () => {
    const h = home();
    const secret = 'secret-prefix-1442-9f3a';
    h.patch(['- id: echo', '  config:', `    prefix: '${secret}'`, ''].join('\n'));
    const server = await start(h.env);
    expect(await say(server, 'a')).toBeUndefined();
    const text = h.text();
    expect(text).not.toContain(secret);
    const live = rowOf(JSON.parse(text) as PluginSnapshot, 'echo').live;
    expect(live?.[0]?.version).toMatch(/^hmac-sha256:[0-9a-f]{16}$/u);
    // 鍵的檔案是 serve 自己建的那一把（跟會話日誌 header 的 `configHash` 同一把）：
    // 版本就是「那一列宣告的簽章」用 `config-hash-key.json` 那把鍵算出來的帶鍵雜湊，換一把鍵就對不上。
    const key = await loadConfigHashKey({ env: h.env, cwd: process.cwd() });
    const loaded = await loadDefaultPlugins({ serve: true, env: h.env, warn: () => {} });
    const index = loaded.ids.indexOf('echo');
    const declared = loaded.entries[index]!;
    expect(live?.[0]?.version).toBe(
      hmacHashOf(declarationSignature('echo', declared.name, declared.config), key),
    );
    expect(live?.[0]?.version).not.toBe(
      hmacHashOf(
        declarationSignature('echo', declared.name, declared.config),
        Buffer.from('另一把鍵'),
      ),
    );
  }, 60_000);

  it('只看歷史、沒跑過一輪的 thread 也綁（驗收 F）', async () => {
    const h = home();
    const server = await start(h.env);
    const client = await serveClient(server);
    const events = await client.openEvents('only-read');
    try {
      expect(rowOf(h.snapshot(), 'todo').live?.[0]?.threads).toEqual(['only-read']);
    } finally {
      await events.return?.(undefined);
    }
  }, 60_000);

  it('開機後、還沒組裝任何 thread：快照每一列都沒有 live，鍵與以前相同（驗收 G）', async () => {
    const h = home();
    await start(h.env);
    const snapshot = h.snapshot();
    expect(snapshot.rows.length).toBeGreaterThan(40);
    for (const row of snapshot.rows) {
      expect(Object.keys(row).sort(), row.id).toEqual(['id', 'module', 'running', 'saved', 'sync']);
    }
    expect(Object.keys(snapshot).sort()).toEqual(['generatedAt', 'rows', 'summary', 'version']);
  }, 60_000);

  it('落盤關掉的啟動：不取鍵、不建鍵檔、快照照舊沒有 live', async () => {
    const h = home();
    h.patch('- id: session-persistence\n  disabled: true\n');
    const server = await start(h.env);
    expect(await say(server, 'a')).toBeUndefined();
    expect(JSON.stringify(h.snapshot())).not.toContain('"live"');
    expect(() => readFileSync(join(h.dir, 'config-hash-key.json'))).toThrow();
  }, 60_000);
});

// ── 子代理只綁 root（驗收 F2）────────────────────────────────────────────────────────────

const markerOf = (body: Body): string => {
  const first = body.messages.find((message) => message.role === 'user');
  return /CHILD-[A-Z0-9]+/.exec(JSON.stringify(first?.content ?? ''))?.[0] ?? 'ROOT';
};

const subagentCall = (id: string, description: string, tool = 'subagent'): Reply => ({
  tools: [{ id, name: tool, args: { description, subagent_type: 'general-purpose' } }],
});

/** 標題這類不帶工具的呼叫回固定字串；root 在第一次派工，子代理一次就做完。 */
const script = (tool: string): Script => {
  const counters = new Map<string, number>();
  return (_index, body) => {
    if ((body.tools?.length ?? 0) === 0) return { content: '標題' };
    const mark = markerOf(body);
    const k = counters.get(mark) ?? 0;
    counters.set(mark, k + 1);
    if (mark === 'ROOT') return k === 0 ? subagentCall('call_sub', 'CHILD-LV 做完回報', tool) : {};
    return { content: '子任務完成。' };
  };
};

function liveThreadsOf(run: DriverRun): string[] {
  const snapshot = JSON.parse(
    readFileSync(join(run.home, PLUGIN_SNAPSHOT_FILE_NAME), 'utf8'),
  ) as PluginSnapshot;
  return [
    ...new Set(snapshot.rows.flatMap((row) => (row.live ?? []).flatMap((entry) => entry.threads))),
  ];
}

describe('子代理只綁 root（#1442 驗收 F2）', () => {
  it('背景子代理：派出去、跑完之後，`live` 裡只有 root 的 thread id', async () => {
    const run = await runServeDriver(async (ctx) => {
      await ctx.client.runStart('alpha', '派一個子代理');
      await ctx.fold(idleWithContent);
      await settle(3000);
    }, script('subagent'));
    // 日誌裡確實有子代理那一份（`%2f`），不然這條什麼也沒量到。
    expect(run.logs.some((log) => log.file.includes('%2f'))).toBe(true);
    expect(liveThreadsOf(run)).toEqual(['alpha']);
  }, 90_000);

  it('前景子代理（task，one-shot）：同樣只有 root', async () => {
    const run = await runServeDriver(
      async (ctx) => {
        await ctx.client.runStart('alpha', '派前景');
        await ctx.fold(aiDone(2));
      },
      script('task'),
      [
        '- id: background-subagents',
        '  config:',
        '    backgroundMode: one-shot',
        '    maxActiveSubagents: 8',
      ].join('\n'),
    );
    expect(run.logs.some((log) => log.file.includes('%2f'))).toBe(true);
    expect(liveThreadsOf(run)).toEqual(['alpha']);
  }, 90_000);
});
