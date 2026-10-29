/**
 * 插件樹重組時新冒出的單列失敗（[#1766](https://github.com/DemianLi/nexus-agent/issues/1766)）：`sync` 不拋，把那一列判成
 * `dropped`，帶著掉在哪一步與原因；同樣的失敗不重試；使用者從伺服器日誌、快照看得到它掉了，紀錄裡有被接受的改動指到那一列時
 * 變更紀錄也記一筆 `failed`。
 *
 * 量具：一顆**遷出的函式插件**（有 `manifest` 匯出，所以在樹上），設定沒有 `ok: true` 時 `apply` 拋錯，每跑一次 `apply` 數一次。
 * 出貨清單上沒有會這樣壞的插件，所以只能用夾具。
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FIBER_STATE } from '@nexus/sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { createCordisRoot } from './cordis-root.js';
import type { CordisRoot } from './cordis-root.js';
import { foldTurn, serveClient } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { changePlugin, PluginChangeRejected } from './plugin-change.js';
import { loadPluginConfig } from './plugin-config.js';
import { appendRaw, journalPathOf, seedHomePatch } from './plugin-journal.fixture.js';
import { readJournal } from './plugin-journal.js';
import type { JournalRecord } from './plugin-journal.js';
import { pluginSnapshotPath } from './plugin-snapshot.js';
import type { PluginSnapshot } from './plugin-snapshot.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';

const temporary: string[] = [];
const roots: CordisRoot[] = [];
let running: RunningServe | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
  for (const root of roots.splice(0)) await root.dispose().catch(() => undefined);
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ECHO_MODULE = import.meta.resolve('@nexus/plugin-echo');
const REASON = '故意在 apply 裡壞掉';

let counterSeed = 0;

interface Probe {
  readonly dir: string;
  readonly module: string;
  /** `apply` 跑過幾次。 */
  applied(): number;
}

/** 暫存目錄裡一顆樹上的函式插件 `probe`：`Config` 收 `ok` 與可選的 `n`（讓宣告可以改），`ok` 不是 `true` 就在 `apply` 拋。 */
function probe(): Probe {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-tree-new-failure-'));
  temporary.push(dir);
  chmodSync(dir, 0o700);
  counterSeed += 1;
  const counter = JSON.stringify(
    `__treeNewFailure1766_${String(Date.now())}_${String(counterSeed)}`,
  );
  const module = join(dir, 'probe.mjs');
  writeFileSync(
    module,
    `import { z } from 'zod';
export const name = 'probe';
export const inject = { tools: { range: '^1.0.0' } };
export const Config = z.strictObject({ ok: z.boolean(), n: z.number().optional() });
export const manifest = {
  id: 'probe', version: '1.0.0', owner: 't',
  provides: [], consumes: [{ token: 'tools', range: '^1.0.0' }],
  config: Config, reload: { code: 'restart', config: 'next-thread' }, capabilities: [],
};
export function apply(ctx, config) {
  globalThis[${counter}] = (globalThis[${counter}] ?? 0) + 1;
  if (config.ok !== true) throw new Error(${JSON.stringify(REASON)});
}
`,
    { mode: 0o600 },
  );
  chmodSync(module, 0o600);
  return {
    dir,
    module,
    applied: () =>
      ((globalThis as Record<string, unknown>)[JSON.parse(counter) as string] as
        number | undefined) ?? 0,
  };
}

function write(dir: string, name: string, source: string): string {
  const path = join(dir, name);
  writeFileSync(path, source, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

describe('樹上：重組時一列新掉', () => {
  /** 出貨檔是 probe（`ok: true`）加 echo；`load` 給了 probe 的設定就疊一層 `--patch` 蓋掉它。同一棵樹上讀清單，就是一次重組。 */
  async function setup() {
    const p = probe();
    const shipped = write(
      p.dir,
      'cordis.yml',
      `- id: probe\n  name: 'file://${p.module}'\n  config:\n    ok: true\n- id: echo\n  name: '${ECHO_MODULE}'\n`,
    );
    const root = createCordisRoot();
    roots.push(root);
    const load = (config?: Record<string, unknown>) =>
      loadPluginConfig(
        {
          shipped,
          overlays:
            config === undefined
              ? []
              : [write(p.dir, 'patch.yml', `- id: probe\n  config: ${JSON.stringify(config)}\n`)],
          warn: () => {},
        },
        { tree: root.tree },
      );
    return { p, root, load };
  }

  it('設定改成讓 apply 拋錯的值：讀清單照常回來，那一列掉在 apply、原因帶插件的錯；別列照樣掛著', async () => {
    const { p, root, load } = await setup();
    const before = await load();
    expect(before.dropped).toEqual([]);
    expect(p.applied()).toBe(1);

    const after = await load({ ok: false });
    expect(after.dropped.map(({ id, stage }) => ({ id, stage }))).toEqual([
      { id: 'probe', stage: 'apply' },
    ]);
    expect(after.dropped[0]?.message).toContain(REASON);
    const tree = await root.tree.context();
    // 同一次重組裡別列不受牽連。
    expect(tree.loader.resolve('include:echo').fiber?.ctx.fiber.state).toBe(FIBER_STATE.ACTIVE);
  }, 60000);

  it('同樣的失敗不算新：宣告沒變，再讀幾次清單 apply 都不再跑、每次報同一個原因；宣告一改就重試一次', async () => {
    const { p, load } = await setup();
    await load();
    await load({ ok: false });
    expect(p.applied()).toBe(2);
    for (let index = 0; index < 3; index += 1) {
      const again = await load({ ok: false });
      expect(again.dropped.map(({ id, stage, message }) => ({ id, stage, message }))).toEqual([
        { id: 'probe', stage: 'apply', message: expect.stringContaining(REASON) as string },
      ]);
    }
    expect(p.applied()).toBe(2);

    await load({ ok: false, n: 2 });
    expect(p.applied()).toBe(3);
  }, 60000);
});

type Failed = Extract<JournalRecord, { op: 'failed' }>;

function failedOf(dir: string): Failed[] {
  return (readJournal(journalPathOf(dir))?.records ?? []).filter(
    (entry): entry is Failed => entry.op === 'failed',
  );
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`等不到：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
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

describe('serve：寫入口接受的設定讓樹上那一列在 apply 掉', () => {
  // 寫入口試掛這一筆（#2073），樹上那一列在 apply 掉就當場拒收。
  it('寫入口當場拒收：紀錄裡沒有被接受的那一筆，thread 照常', async () => {
    const p = probe();
    const env = { [HARNESS_HOME_ENV]: p.dir };
    seedHomePatch(
      p.dir,
      `- insert:\n    - id: probe\n      name: 'file://${p.module}'\n      config:\n        ok: true\n`,
    );
    const server = (await runServe({ argv: ['--port', '0'], log: () => {}, env })) as RunningServe;
    running = server;
    expect(await say(server, 'warm')).toBeUndefined();

    const error = await changePlugin(
      { op: 'config-set', id: 'probe', config: { ok: false } },
      { env },
    ).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PluginChangeRejected);
    expect((error as Error).message).toContain('"probe"（apply）');
    expect((error as Error).message).toContain(REASON);
    const records = readJournal(journalPathOf(p.dir))?.records ?? [];
    expect(records.map((record) => record.op)).toEqual(['patch', 'rejected']);

    for (const thread of ['a', 'b']) expect(await say(server, thread)).toBeUndefined();
    expect(failedOf(p.dir)).toEqual([]);
  }, 120000);

  // 寫入口看不到的失敗（例如只在 serve 環境裡掉的列）照舊到 thread 組裝時才掉：繞過寫入口直接追加那一筆。
  it('紀錄裡的設定讓它在 apply 掉：下一條 thread 照樣建得起來；伺服器日誌記一次、紀錄記一筆 failed、快照上那一列掉在 apply', async () => {
    const p = probe();
    const env = { [HARNESS_HOME_ENV]: p.dir };
    seedHomePatch(
      p.dir,
      `- insert:\n    - id: probe\n      name: 'file://${p.module}'\n      config:\n        ok: true\n`,
    );
    const lines: string[] = [];
    const server = (await runServe({
      argv: ['--port', '0'],
      log: (line) => lines.push(line),
      env,
    })) as RunningServe;
    running = server;
    expect(await say(server, 'warm')).toBeUndefined();

    const { seq } = await appendRaw(p.dir, {
      op: 'config-set',
      id: 'probe',
      name: `file://${p.module}`,
      before: { ok: true },
      after: { ok: false },
    });

    for (const thread of ['a', 'b', 'c']) expect(await say(server, thread)).toBeUndefined();

    await waitFor(() => failedOf(p.dir).length === 1, 'failed 那一筆');
    expect(failedOf(p.dir)[0]).toMatchObject({
      id: 'probe',
      triggerSeq: seq,
      stage: 'apply',
      reason: expect.stringContaining(REASON) as string,
    });
    const logged = lines.filter((line) => line.includes('這一列沒掛上') && line.includes('probe'));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(REASON);
    const snapshot = JSON.parse(readFileSync(pluginSnapshotPath(env), 'utf8')) as PluginSnapshot;
    expect(snapshot.rows.find((row) => row.id === 'probe')?.saved).toEqual({
      state: 'dropped',
      dropStage: 'apply',
    });
    // 三條 thread、apply 只多跑一次：同樣的失敗不重試。
    expect(p.applied()).toBe(2);
    expect(failedOf(p.dir)).toHaveLength(1);
  }, 120000);
});
