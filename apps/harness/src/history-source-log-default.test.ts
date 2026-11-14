/**
 * `history-source` 預設改 `log`（[#2362](https://github.com/DemianLi/nexus-agent/issues/2362)）：出貨那一列、入口預設、
 * 那一列關掉或掉下來、自己 copy 的清單、老日誌續接的預告與拋錯。
 *
 * 這一檔量**產品預設**，所以不吃 `history-source-state.setup.ts` 那兩個 mock。
 */

import { appendFile, cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { SESSION_LOG_FORMAT_VERSION } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('./assembly-root.js');
vi.unmock('./agent-factory.js');

import { createNexusAgent } from './agent-factory.js';
import { createCliAgent } from './assembly-root.js';
import { runCli } from './cli.js';
import { foldTurn, serveClient, shippedPlugins, shippedPluginsWithConfig } from './fixtures.js';
import { repositoryRoot } from './package-invariants.js';
import { loadPluginConfig } from './plugin-config.js';
import { runServe } from './serve-run.js';
import { collectToolCatalog } from './tool-catalog.js';
import type { RunningServe } from './serve-run.js';
import { DEFAULT_HISTORY_SOURCE, HISTORY_SOURCE_ROW_DEFAULT } from './settings/history-source.js';
import { assemblyDropsOf, startupWarning } from './startup-audit.js';

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'nexus-history-source-default-'));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** 出貨清單疊上一個 patch（`[{ id, ... }]`）之後，走產品組裝，回 `historySource` 與組裝掉的列。 */
async function assembleWith(
  patch: readonly object[],
  invocation: Parameters<typeof createCliAgent>[0] = { live: false },
) {
  const file = join(scratch, 'row.patch.yml');
  await writeFile(file, JSON.stringify(patch));
  const loaded = await loadPluginConfig({ overlays: [file] });
  const built = await createCliAgent(invocation, loaded.plugins, scratch);
  await built.dispose();
  return { loaded, built };
}

describe('預設', () => {
  it('兩個常數分得開：那一列沒寫是 log，裸組裝是 state', () => {
    expect(HISTORY_SOURCE_ROW_DEFAULT).toBe('log');
    expect(DEFAULT_HISTORY_SOURCE).toBe('state');
  });

  it('出貨清單經產品組裝（createCliAgent）：log', async () => {
    const built = await createCliAgent({ live: false }, await shippedPlugins(), scratch);
    await built.dispose();
    expect(built.historySource).toBe('log');
  });

  it('--history-source 贏過那一列與入口預設', async () => {
    const built = await createCliAgent(
      { live: false, historySource: 'state' },
      await shippedPlugins(),
      scratch,
    );
    await built.dispose();
    expect(built.historySource).toBe('state');
  });

  it('那一列明寫 state：state；明寫 shadow：shadow', async () => {
    for (const source of ['state', 'shadow'] as const) {
      const built = await createCliAgent(
        { live: false },
        await shippedPluginsWithConfig('history-source', { source }),
        scratch,
      );
      await built.dispose();
      expect(built.historySource).toBe(source);
    }
  });

  it('自己 copy 的清單寫 source: state：仍是 state（不會被預設蓋成 log）', async () => {
    const copied = await shippedPluginsWithConfig('history-source', { source: 'state' });
    const built = await createCliAgent({ live: false }, copied, scratch);
    await built.dispose();
    expect(built.historySource).toBe('state');
  });

  it('那一列沒寫 source（空的 config）：log', async () => {
    const built = await createCliAgent(
      { live: false },
      await shippedPluginsWithConfig('history-source', {}),
      scratch,
    );
    await built.dispose();
    expect(built.historySource).toBe('log');
  });

  it('關掉那一列（disabled: true）：log，而且沒有警告（部署方明講，不是掉了）', async () => {
    const { loaded, built } = await assembleWith([{ id: 'history-source', disabled: true }]);
    expect(built.historySource).toBe('log');
    expect(startupWarning(loaded, assemblyDropsOf(loaded, built.dropped), built.warnings)).toEqual(
      [],
    );
  });

  it('那一列掉了（config 驗不過）：仍是 log，而且印出「沒有掛上」那段警告', async () => {
    const { loaded, built } = await assembleWith([
      { id: 'history-source', config: { source: 'bogus' } },
    ]);
    expect(built.historySource).toBe('log');
    const lines = startupWarning(loaded, assemblyDropsOf(loaded, built.dropped), built.warnings);
    expect(lines[0]).toBe('警告：1 列沒有掛上，其餘照樣起來：');
    expect(lines[1]).toMatch(/^ {2}history-source（.+）設定驗不過：/u);
  });

  it('工具目錄的產品組裝掛著出貨的 log 列，不接日誌：明寫 state 才跑得完', async () => {
    await expect(collectToolCatalog(repositoryRoot())).resolves.not.toHaveLength(0);
  });

  it('裸 createNexusAgent（沒有入口預設）：state，不掛日誌也不拋', async () => {
    const { ScriptedChatModel } = await import('./scripted-model.js');
    const built = await createNexusAgent({
      model: new ScriptedChatModel({ turns: [{ content: '好。' }] }),
      plugins: [],
    });
    await built.dispose();
    expect(built.historySource).toBe('state');
  });
});

const FIXTURES = fileURLToPath(new URL('./fixtures/session-format/', import.meta.url));
const FIXTURE_CWD = '/private/var/tmp/nexus-session-format-cwd';

/** 老日誌：每份在 CLI 上寫得出 `cli` 這條會話、而且推不回模型歷史的夾具（`expected.json` 的 `replay.kind`）。 */
const UNREPLAYABLE_CLI = ['v2', 'v3', 'v4', 'v8'] as const;
/** 對照：推得回來的。 */
const REPLAYABLE_CLI = [
  'v9',
  'v10',
  'v12',
  'v13',
  'v14',
  'v49',
  'v52',
  'v53',
  'v54',
  'v55',
  'v56',
] as const;

/** 以 `--history-source log` 續接一份夾具，回標準錯誤與標準輸出合起來的文字。 */
async function resumeFixture(name: string, source: 'log' | 'state'): Promise<string> {
  const dir = join(scratch, name);
  await cp(join(FIXTURES, name), dir, { recursive: true });
  const lines: string[] = [];
  const input = new PassThrough();
  input.end('還在嗎\n/exit\n');
  await runCli({
    argv: ['--resume', dir, '--history-source', source],
    cwd: FIXTURE_CWD,
    input,
    output: new PassThrough(),
    printer: { log: (line) => void lines.push(line), error: (line) => void lines.push(line) },
  });
  return lines.join('\n');
}

const FORECAST = '第一輪會失敗';
const THROWN = '這條對話的日誌推不回模型歷史';

describe('老日誌續接：log 下「預告」與「第一次模型呼叫真的拋」逐份對得上', () => {
  it.each(UNREPLAYABLE_CLI)(
    '%s：印了預告，也真的拋，訊息列出兩條出路與另開一條對話',
    async (name) => {
      const out = await resumeFixture(name, 'log');
      expect(out).toContain(FORECAST);
      expect(out).toContain(THROWN);
      expect(out).toContain('source: state');
      expect(out).toContain('--history-source state');
      expect(out).toContain('另開一條對話');
      expect(out).not.toContain('對話從空的開始');
    },
  );

  it.each(REPLAYABLE_CLI)('%s：推得回來，沒有預告，也沒有拋', async (name) => {
    const out = await resumeFixture(name, 'log');
    expect(out).not.toContain(FORECAST);
    expect(out).not.toContain(THROWN);
  });

  it.each(UNREPLAYABLE_CLI)('%s：state 下維持「對話從空的開始」，不預告、不拋', async (name) => {
    const out = await resumeFixture(name, 'state');
    expect(out).toContain('對話從空的開始');
    expect(out).not.toContain(FORECAST);
    expect(out).not.toContain(THROWN);
  });
});

/** 讓一條 serve thread 的日誌變成「一輪叫過模型卻沒有回覆」的老格式（同 `conversation-restore.test.ts` 的 CLI 版）。 */
async function ageServeThread(root: string, threadId: string): Promise<void> {
  const files = (await readdir(root, { recursive: true })).filter((name) =>
    name.endsWith(`${threadId}/session.v${String(SESSION_LOG_FORMAT_VERSION)}.jsonl`),
  );
  expect(files).toHaveLength(1);
  const file = join(root, files[0]!);
  // 第一行是 header，不佔 seq。
  const next = (await readFile(file, 'utf8')).trim().split('\n').length - 1;
  const tail = [
    { type: 'turn/start', data: { kind: 'message', text: '舊的一輪' } },
    { type: 'model/start', data: {} },
    { type: 'model/end', data: {} },
    { type: 'turn/end', data: {} },
  ];
  await appendFile(
    file,
    `${tail.map((event, index) => JSON.stringify({ ...event, seq: next + index, time: 1 })).join('\n')}\n`,
  );
}

describe('serve：老日誌 thread 在 log 下，客戶端實際收到什麼', () => {
  let running: RunningServe | undefined;

  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  async function start(root: string, lines: string[], extra: string[] = []): Promise<RunningServe> {
    const server = await runServe({
      argv: ['--port', '0', '--session-log', root, ...extra],
      log: (line) => void lines.push(line),
      env: {},
    });
    running = server;
    return server as RunningServe;
  }

  async function say(server: RunningServe, threadId: string, prompt: string) {
    const client = await serveClient(server);
    const events = await client.openEvents(threadId);
    await client.runStart(threadId, prompt);
    const state = await foldTurn(events);
    await events.return?.(undefined);
    return state;
  }

  it('推得回來的 thread（沒動它）：log 下接得上、這一輪完成', async () => {
    const root = join(scratch, 'serve-logs');
    const first = await start(root, []);
    expect((await say(first, 'alpha', '第一句')).status).not.toBe('failed');
    await first.close();
    running = undefined;

    const lines: string[] = [];
    const second = await start(root, lines);
    expect((await say(second, 'alpha', '還在嗎')).status).not.toBe('failed');
    expect(lines.join('\n')).toContain('[會話日誌] thread "alpha" 接回來了：對話照日誌推回模型');
  });

  it('推不回來的 thread：客戶端收到失敗與完整的出路訊息；預告寫進伺服器日誌', async () => {
    const root = join(scratch, 'serve-logs');
    const first = await start(root, []);
    await say(first, 'alpha', '第一句');
    await first.close();
    running = undefined;
    await ageServeThread(root, 'alpha');

    const lines: string[] = [];
    const second = await start(root, lines);
    const state = await say(second, 'alpha', '還在嗎');

    expect(state.status).toBe('failed');
    expect(state.error).toContain('這條對話的日誌推不回模型歷史（reply-missing，第 ');
    expect(state.error).toContain('source: state');
    expect(state.error).toContain('--history-source state');
    expect(state.error).toContain('另開一條對話');
    expect(state.errorCode).toBe('UNKNOWN');
    const server = lines.join('\n');
    expect(server).toContain(
      '[會話日誌] thread "alpha" 接回來了：這條對話推不回模型歷史，第一輪會失敗：',
    );
    expect(server).toMatch(/thread "alpha" run ".+" 失敗（日誌第 \d+ 筆）：UNKNOWN/u);
  });

  it('同一條推不回來的 thread，那一列寫 source: state（serve 沒有旗標）：從空的開始，這一輪不失敗', async () => {
    const root = join(scratch, 'serve-logs');
    const first = await start(root, []);
    await say(first, 'alpha', '第一句');
    await first.close();
    running = undefined;
    await ageServeThread(root, 'alpha');

    const lines: string[] = [];
    const patch = join(scratch, 'state.patch.yml');
    await writeFile(patch, JSON.stringify([{ id: 'history-source', config: { source: 'state' } }]));
    const second = await start(root, lines, ['--patch', patch]);
    expect((await say(second, 'alpha', '還在嗎')).status).not.toBe('failed');
    expect(lines.join('\n')).toContain('對話從空的開始');
  });
});
