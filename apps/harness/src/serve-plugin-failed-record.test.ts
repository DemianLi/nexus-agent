/**
 * serve 把掛不上的列記進變更紀錄（[#1414](https://github.com/DemianLi/nexus-agent/issues/1414)）：量的是產品路徑
 * （`runServe` 加真的 wire client），驗收表 C–G。
 *
 * 量具同 `serve-thread-reread.test.ts`：一顆插進清單的假插件，`apply` 裡設定沒有 `ok: true` 就拋；它在紀錄裡有一筆
 * 遷移來的 `insert`，所以「那一列在紀錄裡有被接受的改動」成立。記錄器自己的規則（去重鍵、等鎖、不建檔）在
 * `plugin-failure-recorder.test.ts`。
 */

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { foldTurn, serveClient } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { changePlugin } from './plugin-change.js';
import type { PluginChange } from './plugin-change.js';
import { appendRaw, journalPathOf, seedHomePatch } from './plugin-journal.fixture.js';
import { readJournal } from './plugin-journal.js';
import type { JournalBody, JournalRecord } from './plugin-journal.js';
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
  seed(body: string): void;
  change(change: PluginChange): Promise<number | undefined>;
  raw(body: JournalBody): Promise<JournalRecord>;
}

function home(failUnlessOk = true): Home {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-serve-failed-'));
  temporary.push(dir);
  chmodSync(dir, 0o700);
  const module = join(dir, 'probe.ts');
  writeFileSync(
    module,
    [
      'export default {',
      "  name: 'probe',",
      '  apply(_registry, config) {',
      `    if (${String(failUnlessOk)} && config?.ok !== true) throw new Error('故意在 apply 裡壞掉');`,
      '  },',
      '};',
      '',
    ].join('\n'),
  );
  chmodSync(module, 0o600);
  const env = { [HARNESS_HOME_ENV]: dir };
  return {
    env,
    dir,
    seed: (body) => seedHomePatch(dir, body),
    change: async (change) => (await changePlugin(change, { env })).record?.seq,
    raw: (body) => appendRaw(dir, body),
  };
}

function probeRow(ok: boolean): string {
  return `- insert:\n    - id: probe\n      name: './probe.ts'\n      config:\n        ok: ${String(ok)}\n`;
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

describe('寫入口改的設定讓那一列 apply 掛不上（驗收 C、D）', () => {
  it('記一筆 failed（觸發的 seq、stage、原因）；再開十條 thread、重啟都不再多記；再改一次又掛，指向新的 seq', async () => {
    const h = home();
    h.seed(probeRow(true));
    const lines: string[] = [];
    let server = await start(h.env, lines);
    expect(await say(server, 'warm')).toBeUndefined();
    expect(failedOf(h.dir)).toEqual([]);

    const first = await h.change({ op: 'config-set', id: 'probe', config: { ok: false } });
    expect(first).toBe(2);
    expect(await say(server, 'a')).toBeUndefined();
    await waitFor(() => failedOf(h.dir).length === 1, '第一筆 failed');
    expect(failedOf(h.dir)[0]).toMatchObject({
      op: 'failed',
      seq: 3,
      id: 'probe',
      triggerSeq: 2,
      stage: 'apply',
      reason: expect.stringContaining('故意在 apply 裡壞掉') as string,
      actor: { kind: 'serve' },
    });

    for (let index = 0; index < 10; index += 1) {
      expect(await say(server, `more-${String(index)}`)).toBeUndefined();
    }
    await server.close();
    running = undefined;
    server = await start(h.env, lines);
    expect(await say(server, 'after-restart')).toBeUndefined();
    await server.close();
    running = undefined;
    expect(failedOf(h.dir)).toHaveLength(1);

    // 驗收 D：再改一次那一列，又掛不上。
    server = await start(h.env, lines);
    const second = await h.change({ op: 'config-set', id: 'probe', config: { ok: false, n: 2 } });
    expect(second).toBe(4);
    expect(await say(server, 'again')).toBeUndefined();
    await waitFor(() => failedOf(h.dir).length === 2, '第二筆 failed');
    expect(failedOf(h.dir)[1]).toMatchObject({ seq: 5, id: 'probe', triggerSeq: 4 });
    // 清單沒有因為這兩筆改變：折出來的就是 insert 加最後一次 config-set。
    await server.close();
    running = undefined;
  }, 120000);

  it('改了又改回啟動那一份的宣告（不重試、也不會再掉）：那一次的 failed 照樣記，指向新的 seq', async () => {
    const h = home();
    h.seed(probeRow(false));
    const lines: string[] = [];
    const server = await start(h.env, lines);
    // 啟動試組掉了：紀錄裡有一筆遷移來的 insert（seq 1）指到它。
    await waitFor(() => failedOf(h.dir).length === 1, '啟動試組的 failed');
    expect(failedOf(h.dir)[0]).toMatchObject({ id: 'probe', triggerSeq: 1, stage: 'apply' });

    expect(await h.change({ op: 'config-set', id: 'probe', config: { ok: true } })).toBe(3);
    expect(await say(server, 'fixed')).toBeUndefined();
    // 改回去：疊出來的宣告跟啟動那一份一樣，讀清單的記憶把它標成已知掉了、不重試。
    expect(await h.change({ op: 'config-set', id: 'probe', config: { ok: false } })).toBe(4);
    expect(await say(server, 'reverted')).toBeUndefined();
    await waitFor(() => failedOf(h.dir).length === 2, '改回去之後的 failed');
    expect(failedOf(h.dir)[1]).toMatchObject({ id: 'probe', triggerSeq: 4, stage: 'apply' });
  }, 120000);
});

describe('只被出貨設定或 --patch 影響的列（驗收 E）', () => {
  it('掛不上、紀錄裡沒有任何改動指到它：紀錄逐位元組不變，日誌照舊', async () => {
    const h = home();
    // 紀錄裡有別的東西，讓「逐位元組不變」比的是一份有內容的檔。
    await h.change({ op: 'disable', id: 'skills' });
    const overlay = join(h.dir, 'overlay.yml');
    writeFileSync(
      overlay,
      "- insert:\n    - id: probe-overlay\n      name: './probe.ts'\n      config:\n        ok: false\n",
    );
    chmodSync(overlay, 0o600);
    const before = readFileSync(journalPathOf(h.dir));
    const lines: string[] = [];
    const server = await start(h.env, lines, ['--patch', overlay]);
    expect(await say(server, 'a')).toBeUndefined();
    await server.close();
    running = undefined;
    expect(readFileSync(journalPathOf(h.dir)).equals(before)).toBe(true);
    expect(failedOf(h.dir)).toEqual([]);
    // 日誌照今天：試組那一段指名它。
    expect(lines.join('\n')).toContain('probe-overlay');
    expect(lines.filter((line) => line.includes('[變更紀錄]'))).toEqual([]);
  }, 60000);
});

describe('三個發現點與必掛的列（驗收 F）', () => {
  it('讀清單時新掉的（設定驗不過）：記一筆 failed，stage 是 config', async () => {
    const h = home(false);
    const server = await start(h.env, []);
    const bad = await h.raw({
      op: 'config-set',
      id: 'todo',
      name: '@nexus/plugin-todo',
      before: null,
      after: { allowParallelInProgress: '不是布林' },
    });
    expect(await say(server, 'a')).toBeUndefined();
    await waitFor(() => failedOf(h.dir).length === 1, '讀清單時新掉的 failed');
    expect(failedOf(h.dir)[0]).toMatchObject({
      id: 'todo',
      triggerSeq: bad.seq,
      stage: 'config',
    });
    expect(await say(server, 'b')).toBeUndefined();
    await server.close();
    running = undefined;
    expect(failedOf(h.dir)).toHaveLength(1);
  }, 60000);

  it('啟動時必掛的列因紀錄掉了：伺服器起不來，而那一筆在拋之前已經寫進去', async () => {
    const h = home(false);
    await h.raw({
      op: 'config-set',
      id: 'browser-session',
      name: '#settings/browser-session',
      before: null,
      after: { maxAgeDays: 0 },
    });
    await expect(
      runServe({ argv: ['--port', '0'], log: () => undefined, env: h.env }),
    ).rejects.toThrow(/起不來/u);
    // 沒有 waitFor：起不來之前就已經寫完。
    expect(failedOf(h.dir)).toHaveLength(1);
    expect(failedOf(h.dir)[0]).toMatchObject({
      id: 'browser-session',
      triggerSeq: 1,
      stage: 'config',
    });
  }, 60000);

  it('這一條 thread 組裝時必掛的列因紀錄掉了：那條建不起來，伺服器照常，那一筆在拋之前已經寫進去', async () => {
    const h = home(false);
    const server = await start(h.env, []);
    const bad = await h.raw({
      op: 'config-set',
      id: 'browser-session',
      name: '#settings/browser-session',
      before: null,
      after: { maxAgeDays: 0 },
    });
    const refused = await say(server, 'a');
    expect(refused).toMatch(/起不來/u);
    expect(failedOf(h.dir)).toHaveLength(1);
    expect(failedOf(h.dir)[0]).toMatchObject({ id: 'browser-session', triggerSeq: bad.seq });
    // 照常：恢復之後下一條建得起來。
    await h.change({ op: 'config-reset', id: 'browser-session' });
    expect(await say(server, 'b')).toBeUndefined();
  }, 60000);
});

describe('組裝時才掉的必掛列（apply 那一步，驗收 F）', () => {
  const BAD_PREFIX: JournalBody = {
    op: 'config-set',
    id: 'system-prompt',
    name: '@nexus/plugin-system-prompt',
    before: null,
    after: { personaPrefix: '你是 {{nope}}' },
  };

  it('啟動試組：起不來，而那一筆（stage 是 apply）在拋之前已經寫進去', async () => {
    const h = home(false);
    await h.raw(BAD_PREFIX);
    await expect(
      runServe({ argv: ['--port', '0'], log: () => undefined, env: h.env }),
    ).rejects.toThrow(/起不來/u);
    expect(failedOf(h.dir)).toHaveLength(1);
    expect(failedOf(h.dir)[0]).toMatchObject({
      id: 'system-prompt',
      triggerSeq: 1,
      stage: 'apply',
    });
  }, 60000);

  it('這一條 thread 組裝時：那條建不起來，伺服器照常，那一筆在拋之前已經寫進去', async () => {
    const h = home(false);
    const server = await start(h.env, []);
    const bad = await h.raw(BAD_PREFIX);
    const refused = await say(server, 'a');
    expect(refused).toMatch(/組裝失敗.*system-prompt/su);
    expect(failedOf(h.dir)).toHaveLength(1);
    expect(failedOf(h.dir)[0]).toMatchObject({
      id: 'system-prompt',
      triggerSeq: bad.seq,
      stage: 'apply',
    });
    await h.change({ op: 'config-reset', id: 'system-prompt' });
    expect(await say(server, 'b')).toBeUndefined();
  }, 60000);
});

describe('寫不進去不擋 thread（驗收 G）', () => {
  it('鎖被別人拿著超過 2 秒：thread 照樣建得起來，日誌記一句沒寫成；放鎖之後下一條補上', async () => {
    const h = home();
    h.seed(probeRow(true));
    const lines: string[] = [];
    const server = await start(h.env, lines);
    expect(await h.change({ op: 'config-set', id: 'probe', config: { ok: false } })).toBe(2);

    const lock = `${journalPathOf(h.dir)}.lock`;
    // 活著的持有者：自己的 PID（接手只接「行程已不在」的）。
    writeFileSync(lock, `${String(process.pid)}\n`, { mode: 0o600 });
    const started = Date.now();
    expect(await say(server, 'a')).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(20000);
    await waitFor(() => lines.some((line) => line.includes('沒寫成')), '沒寫成那一句', 8000);
    expect(failedOf(h.dir)).toEqual([]);
    const complaints = lines.filter((line) => line.includes('沒寫成'));
    expect(complaints).toHaveLength(1);
    // 原因原文只進紀錄，這一句的日誌不帶它。
    expect(complaints[0]).not.toContain('故意在 apply 裡壞掉');

    rmSync(lock);
    expect(await say(server, 'b')).toBeUndefined();
    await waitFor(() => failedOf(h.dir).length === 1, '放鎖之後補上的 failed');
    expect(existsSync(lock)).toBe(false);
  }, 120000);
});
