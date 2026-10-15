/**
 * 「組裝成功、續接失敗」的 thread 不進活著的設定版本那張表（[#1442](https://github.com/DemianLi/nexus-agent/issues/1442)，
 * PM 審查第 1 項）。
 *
 * `serve.ts` 在 `assembly.create` 與 `restoreConversation` 都成功之後才叫 `bindThread`。`read()` 在組裝之前就寫了快照、
 * 組裝成功但續接失敗時 agent 與租約都收掉、這條 thread 沒有起來，所以它不該出現在任何一版的 `threads` 裡。
 * 這一檔只問這一件事：把 `restoreConversation` 換成「要它拋就拋」，其餘走真的 `runServe` 與 wire client。
 *
 * 紅燈（見 PR 內文）：(a) 把 `bindThread` 搬到 `assembly.create` 之後、`restoreConversation` 之前；
 * (b) `read()` 之後先用 `[]` 綁一次。兩個都會讓下面「失敗那條」的斷言變紅。
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { foldTurn, serveClient } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { PLUGIN_SNAPSHOT_FILE_NAME } from './plugin-snapshot.js';
import type { PluginSnapshot } from './plugin-snapshot.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';

const gate = vi.hoisted(() => ({ fail: false, calls: 0 }));

vi.mock('./conversation-restore.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./conversation-restore.js')>();
  return {
    ...actual,
    restoreConversation: (...args: Parameters<typeof actual.restoreConversation>) => {
      gate.calls += 1;
      if (gate.fail) return Promise.reject(new Error('故意灌不回去（#1442 測試）'));
      return actual.restoreConversation(...args);
    },
  };
});

const temporary: string[] = [];
let running: RunningServe | undefined;

beforeAll(() => {
  vi.stubEnv('NVIDIA_API_KEY', 'nvapi-fake-for-live-versions');
});
afterAll(() => {
  vi.unstubAllEnvs();
});
afterEach(async () => {
  gate.fail = false;
  gate.calls = 0;
  await running?.close();
  running = undefined;
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function start(env: NodeJS.ProcessEnv): Promise<RunningServe> {
  const server = (await runServe({
    argv: ['--port', '0'],
    log: () => undefined,
    env,
  })) as RunningServe;
  running = server;
  return server;
}

/** 這條 thread 上說一句；建不起來就回錯誤訊息。 */
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

describe('續接失敗的 thread 不進表（#1442）', () => {
  it('read 成功、組裝成功、續接拋：那一條不在任何版本的 threads 裡，下一次重試成功才綁', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-live-restore-fail-'));
    temporary.push(dir);
    chmodSync(dir, 0o700);
    const env = { [HARNESS_HOME_ENV]: dir };
    const snapshot = (): PluginSnapshot =>
      JSON.parse(readFileSync(join(dir, PLUGIN_SNAPSHOT_FILE_NAME), 'utf8')) as PluginSnapshot;
    const threadsOf = (id: string): string[] =>
      (snapshot().rows.find((row) => row.id === id)?.live ?? []).flatMap((entry) => entry.threads);

    // 第一個行程：t1 說一輪，留下可以續接的日誌。
    const first = await start(env);
    expect(await say(first, 't1')).toBeUndefined();
    await first.close();
    running = undefined;

    // 第二個行程：t1 要續接，而續接拋。
    const server = await start(env);
    expect(await say(server, 'fresh')).toBeUndefined();
    expect(threadsOf('todo')).toEqual(['fresh']);

    gate.fail = true;
    const before = gate.calls;
    const failure = await say(server, 't1');
    expect(failure).toBeDefined();
    // 續接真的被叫到過（這條測的是「create 成功之後、restore 失敗」，不是別的失敗），
    // 而且 `read()` 已經照常寫過快照：檔還在、不是壞的。
    expect(gate.calls).toBeGreaterThan(before);
    for (const id of ['todo', 'echo', 'goal']) {
      expect(threadsOf(id), id).toEqual(['fresh']);
    }
    expect(JSON.stringify(snapshot())).not.toContain('"t1"');

    // 重試：續接這次成功，才綁。
    gate.fail = false;
    expect(await say(server, 't1')).toBeUndefined();
    expect(threadsOf('todo')).toEqual(['fresh', 't1']);
  }, 120_000);
});
