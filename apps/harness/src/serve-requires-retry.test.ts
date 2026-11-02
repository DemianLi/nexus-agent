/**
 * 試組掉在 `requires` 的列，依賴的列回來之後不必重啟也能回來
 * （[#1426](https://github.com/DemianLi/nexus-agent/issues/1426)，驗收 A–E）：量的是產品路徑（`runServe` 加真的
 * wire client）。
 *
 * 量具：B（`dep-b`）提供一個能力、在紀錄裡有自己的一筆遷移 `insert`，所以寫入口關得掉也開得回；A（`dep-a`）靠
 * `--patch` 覆蓋層插進來、需要那個能力。**A 自己在紀錄裡沒有任何一筆**，所以 A 的宣告從頭到尾沒變。
 *
 * **怎麼判斷 A 有沒有被試過**：A 的 `apply` 每跑一次就往見證檔寫一行。相容層的 `requires` 檢查排在 `apply` 之後
 * （`packages/nexus-core/src/load.ts`），所以「試一次」就是真的跑一次 `apply` 再撤掉，見證檔的行數就是試了幾次。
 * 「這一條沒掛上」的日誌行（`[組裝] thread "<id>" 這一條沒掛上`）是組裝時掉了的證據；試了又沒有那一行，就是掛上了。
 */

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { foldTurn, serveClient } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { changePlugin } from './plugin-change.js';
import type { PluginChange } from './plugin-change.js';
import { journalPathOf, seedHomePatch } from './plugin-journal.fixture.js';
import { readJournal } from './plugin-journal.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';

const temporary: string[] = [];
let running: RunningServe | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

const CAPABILITY = 'dep-cap';

interface Home {
  readonly env: NodeJS.ProcessEnv;
  readonly dir: string;
  readonly overlay: string;
  /** A 的 `apply` 被跑了幾次。 */
  attempts(): number;
  change(change: PluginChange): Promise<number | undefined>;
}

function home(): Home {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-requires-retry-'));
  temporary.push(dir);
  chmodSync(dir, 0o700);
  const applied = join(dir, 'dep-a-applied.txt');
  const write = (name: string, lines: string[]): string => {
    const file = join(dir, name);
    writeFileSync(file, `${lines.join('\n')}\n`);
    chmodSync(file, 0o600);
    return file;
  };
  write('dep-b.ts', [
    'export default {',
    "  name: 'dep-b',",
    `  apply(registry) { registry.capabilities.provide('${CAPABILITY}'); },`,
    '};',
  ]);
  write('dep-a.ts', [
    "import { appendFileSync } from 'node:fs';",
    'export default {',
    "  name: 'dep-a',",
    `  requires: ['${CAPABILITY}'],`,
    '  apply() {',
    `    appendFileSync(${JSON.stringify(applied)}, 'x\\n');`,
    "    if (process.env.DEP_A_APPLY_FAIL === '1') throw new Error('故意在 dep-a 的 apply 裡壞掉');",
    '  },',
    '};',
  ]);
  const overlay = write('dep-overlay.yml', [
    '- insert:',
    '    - id: dep-a',
    "      name: './dep-a.ts'",
  ]);
  seedHomePatch(dir, "- insert:\n    - id: dep-b\n      name: './dep-b.ts'\n");
  const env = { [HARNESS_HOME_ENV]: dir };
  return {
    env,
    dir,
    overlay,
    attempts: () =>
      existsSync(applied) ? readFileSync(applied, 'utf8').split('\n').filter(Boolean).length : 0,
    change: async (change) => (await changePlugin(change, { env })).record?.seq,
  };
}

async function start(h: Home, lines: string[]): Promise<RunningServe> {
  const server = (await runServe({
    argv: ['--port', '0', '--patch', h.overlay],
    log: (line) => lines.push(line),
    env: h.env,
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

/** 這一條 thread 組裝時 A 沒掛上的日誌行。 */
function assemblyDropLines(lines: readonly string[], thread: string): string[] {
  return lines.filter(
    (line) => line.includes(`thread "${thread}" 這一條沒掛上`) && line.includes('dep-a'),
  );
}

function journalOps(dir: string): string[] {
  return (readJournal(journalPathOf(dir))?.records ?? []).map((entry) => entry.op);
}

describe('試組掉在 requires 的列，依賴的列回來後不必重啟（#1426）', () => {
  it('A 重現、B 回來：B 一開始就關著，打開它之後的下一條 thread，A 試一次、掛上', async () => {
    const h = home();
    // B 在啟動之前就關著（seq 2）；A 的宣告從頭到尾沒變。
    expect(await h.change({ op: 'disable', id: 'dep-b' })).toBe(2);
    const lines: string[] = [];
    const server = await start(h, lines);
    // 啟動試組：A 試了一次、掉在 requires。
    expect(h.attempts()).toBe(1);
    expect(lines.join('\n')).toContain('dep-a');
    expect(await say(server, 'a')).toBeUndefined();
    // 沒有新的寫入：不重試。
    expect(h.attempts()).toBe(1);

    // 用寫入口打開 B（seq 3），開一條新的 thread。
    expect(await h.change({ op: 'enable', id: 'dep-b' })).toBe(3);
    expect(await say(server, 'b')).toBeUndefined();
    // A 回來了：重試了一次、這一條沒有「沒掛上」的日誌行。
    expect(h.attempts()).toBe(2);
    expect(assemblyDropLines(lines, 'b')).toEqual([]);
    // 之後的 thread 照常掛它：不再是「已知掉了」。
    expect(await say(server, 'c')).toBeUndefined();
    expect(assemblyDropLines(lines, 'c')).toEqual([]);
    // 紀錄裡沒有被多記一筆 failed：A 這一路沒有「新掉」。
    expect(journalOps(h.dir)).not.toContain('failed');
  }, 120000);

  it('C 不每條重試：B 關著、沒有新的寫入，連開三條 thread，A 只在啟動試組那一次被試過', async () => {
    const h = home();
    expect(await h.change({ op: 'disable', id: 'dep-b' })).toBe(2);
    const lines: string[] = [];
    const server = await start(h, lines);
    expect(h.attempts()).toBe(1);
    for (const thread of ['t1', 't2', 't3']) {
      expect(await say(server, thread)).toBeUndefined();
    }
    expect(h.attempts()).toBe(1);
    // 日誌只印啟動試組那一次，三條 thread 各自都沒有「沒掛上」的行。
    for (const thread of ['t1', 't2', 't3']) expect(assemblyDropLines(lines, thread)).toEqual([]);
    expect(lines.filter((line) => line.includes('dep-a')).length).toBeGreaterThan(0);
  }, 120000);

  it('D 不相干的寫入只多試一次：B 還關著，改一筆別的列，下一條 thread A 試一次、又掉；再開一條不再試', async () => {
    const h = home();
    expect(await h.change({ op: 'disable', id: 'dep-b' })).toBe(2);
    const lines: string[] = [];
    const server = await start(h, lines);
    expect(await say(server, 'a')).toBeUndefined();
    expect(h.attempts()).toBe(1);

    // 一筆不相干的、被接受的改動（seq 3）。
    expect(await h.change({ op: 'disable', id: 'skills' })).toBe(3);
    expect(await say(server, 'b')).toBeUndefined();
    expect(h.attempts()).toBe(2);
    expect(assemblyDropLines(lines, 'b')).toHaveLength(1);

    // 再開一條：用新的鍵記住了，不再試。
    expect(await say(server, 'c')).toBeUndefined();
    expect(h.attempts()).toBe(2);
    expect(assemblyDropLines(lines, 'c')).toEqual([]);
    // 重試又掉不算「新掉」（它啟動時就掉了）：不另外記 failed。
    expect(journalOps(h.dir)).not.toContain('failed');
  }, 120000);

  it('E 其他階段不變：試組掉在 apply 的列，有新的寫入也不重試（照 #1405 Q2）', async () => {
    const h = home();
    const previous = process.env['DEP_A_APPLY_FAIL'];
    process.env['DEP_A_APPLY_FAIL'] = '1';
    try {
      const lines: string[] = [];
      // B 開著：A 的 requires 過得了，掉的原因是 apply。
      const server = await start(h, lines);
      expect(h.attempts()).toBe(1);
      expect(await say(server, 'a')).toBeUndefined();
      expect(h.attempts()).toBe(1);

      expect(await h.change({ op: 'disable', id: 'skills' })).toBe(2);
      expect(await say(server, 'b')).toBeUndefined();
      expect(await say(server, 'c')).toBeUndefined();
      // 紀錄有了新的被接受的改動，A 掉在 apply：不重試。
      expect(h.attempts()).toBe(1);
      expect(assemblyDropLines(lines, 'b')).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env['DEP_A_APPLY_FAIL'];
      else process.env['DEP_A_APPLY_FAIL'] = previous;
    }
  }, 120000);
});
