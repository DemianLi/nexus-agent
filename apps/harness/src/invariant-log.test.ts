/**
 * 不變量的量測記錄（[#976](https://github.com/DemianLi/nexus-agent/issues/976)）。
 *
 * 分三組：**記錄器自己**（單元）、**CLI 那條路**（`runCli` 真的組裝）、**serve 那條路**（`runServe`
 * 真的組裝）。後兩組是卡上的驗收句：違規發生時檔裡有那一行**而且**有對應的「裝上了哪幾個」；
 * 關掉其中一個，那一欄少掉它；沒有違規的一輪只有「裝上了」，印出來的東西與原來逐字相同。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCli } from './cli.js';
import { foldTurn, serveClient } from './fixtures.js';
import { resolveInvariantLogPath } from './assembly-root.js';
import { harnessInvariantLogPath } from './harness-home.js';
import { createInvariantLog, MAX_MESSAGE_CHARS } from './invariant-log.js';
import type { InvariantLogLine } from './invariant-log.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';
import { WIRING_PROBE_PACKAGE } from './serve-session-wiring.fixture.js';

/** 出貨清單上有真檢查的八個，**寫死字串**：拿清單自己的結果比自己驗不出東西。 */
const SHIPPED_PACKAGES = [
  '@nexus/core',
  '@nexus/plugin-commands',
  '@nexus/plugin-goal',
  '@nexus/plugin-plan-mode',
  '@nexus/plugin-present',
  '@nexus/plugin-sandbox-policy',
  '@nexus/plugin-todo',
  '@nexus/plugin-workspace-changes',
];

/** 把落盤那一列關掉的夾具（#612）。絕對路徑：`runCli` 的 `cwd` 不一定是這個套件。 */
const PERSISTENCE_OFF_PATCH = fileURLToPath(
  new URL('./settings/persistence-off.patch.yml', import.meta.url),
);

const roots: string[] = [];
let running: RunningServe | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await running?.close();
  running = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'invariant-log-'));
  roots.push(home);
  return home;
}

function readLines(home: string): InvariantLogLine[] {
  const path = harnessInvariantLogPath({ NEXUS_AGENT_HOME: home });
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as InvariantLogLine);
}

function recorder() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    printer: {
      log: (line: string) => void out.push(line),
      error: (line: string) => void err.push(line),
    },
    stdout: () => out.join('\n'),
    stderr: () => err.join('\n'),
  };
}

describe('記錄器', () => {
  const fixedNow = () => new Date('2026-10-03T12:00:00.000Z');

  it('installed 與 violation 各 append 一行 JSON，順序照發生', () => {
    const home = tempHome();
    const path = join(home, 'nested', 'invariant-log.jsonl');
    const tap = createInvariantLog(path, { now: fixedNow });

    tap.installed?.({ sessionId: 's1', packages: ['@nexus/b', '@nexus/a'] });
    tap.violation?.({ sessionId: 's1', packageName: '@nexus/a', message: '壞了' });

    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        v: 1,
        ts: '2026-10-03T12:00:00.000Z',
        kind: 'installed',
        sessionId: 's1',
        // 排序過，所以讀的人不必管掛上的先後。
        packages: ['@nexus/a', '@nexus/b'],
      },
      {
        v: 1,
        ts: '2026-10-03T12:00:00.000Z',
        kind: 'violation',
        sessionId: 's1',
        package: '@nexus/a',
        message: '壞了',
      },
    ]);
  });

  it('目錄第一次寫入才建，檔案 0600、目錄 0700', () => {
    const home = tempHome();
    const dir = join(home, 'fresh');
    const path = join(dir, 'invariant-log.jsonl');
    createInvariantLog(path).installed?.({ sessionId: 's', packages: [] });

    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('packages 為空的 installed 照樣寫——分母不能憑空消失', () => {
    const path = join(tempHome(), 'log.jsonl');
    createInvariantLog(path, { now: fixedNow }).installed?.({ sessionId: 's', packages: [] });

    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      kind: 'installed',
      packages: [],
    });
  });

  it(`訊息超過 ${MAX_MESSAGE_CHARS} 個字元就截斷加 …，剛好不截；按字元算，不會切壞中文`, () => {
    const path = join(tempHome(), 'log.jsonl');
    const tap = createInvariantLog(path);
    tap.violation?.({
      sessionId: 's',
      packageName: '@nexus/a',
      message: '字'.repeat(MAX_MESSAGE_CHARS),
    });
    tap.violation?.({
      sessionId: 's',
      packageName: '@nexus/a',
      message: '😀'.repeat(MAX_MESSAGE_CHARS + 1),
    });

    const [exact, over] = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { message: string }).message);
    expect([...(exact ?? '')]).toHaveLength(MAX_MESSAGE_CHARS);
    expect(exact?.endsWith('…')).toBe(false);
    expect([...(over ?? '')]).toHaveLength(MAX_MESSAGE_CHARS + 1);
    expect(over?.endsWith('😀…')).toBe(true);
  });

  it('寫不進去只講一次，而且不拋——量測壞了不能影響產品', () => {
    const home = tempHome();
    // 把「目錄」換成一個普通檔：mkdir 與 append 都會失敗。
    const blocker = join(home, 'blocker');
    writeFileSync(blocker, 'x');
    const warned: string[] = [];
    const tap = createInvariantLog(join(blocker, 'invariant-log.jsonl'), {
      warn: (message) => warned.push(message),
    });

    expect(() => {
      tap.installed?.({ sessionId: 's', packages: ['@nexus/a'] });
      tap.violation?.({ sessionId: 's', packageName: '@nexus/a', message: 'x' });
      tap.violation?.({ sessionId: 's', packageName: '@nexus/a', message: 'y' });
    }).not.toThrow();
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('不變量記錄');
  });

  it('路徑解析：落在 harness home 底下', () => {
    expect(harnessInvariantLogPath({ NEXUS_AGENT_HOME: '/x/home' })).toBe(
      '/x/home/invariant-log.jsonl',
    );
  });
});

describe('什麼時候不寫', () => {
  const env = { NEXUS_AGENT_HOME: '/h/home' };

  it('落盤關掉就不寫——跟會話日誌同一個承諾（#612：一個位元組都不寫）', () => {
    expect(resolveInvariantLogPath(undefined, false, '/cwd', env)).toBeUndefined();
  });

  it('落盤開著、沒有 --workspace：寫在 home 底下', () => {
    expect(resolveInvariantLogPath(undefined, true, '/cwd', env)).toBe(
      '/h/home/invariant-log.jsonl',
    );
  });

  it('home 在 --workspace 底下就不寫（不拋）——模型讀得到也改得動的地方不放記錄', () => {
    expect(resolveInvariantLogPath('/h', true, '/cwd', env)).toBeUndefined();
    // 工作區在別處就照寫。
    expect(resolveInvariantLogPath('/elsewhere', true, '/cwd', env)).toBe(
      '/h/home/invariant-log.jsonl',
    );
  });
});

describe('CLI 那條路', () => {
  it('**沒有違規的一輪只有 installed**：八個出貨的檢查都在，印出來的東西沒有任何 [不變量]', async () => {
    const home = tempHome();
    const { printer, stdout, stderr } = recorder();
    await runCli({
      argv: ['把這句話回聲一次。'],
      input: new PassThrough(),
      output: new PassThrough(),
      printer,
      env: { NEXUS_AGENT_HOME: home },
    });

    const lines = readLines(home);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.kind === 'installed')).toBe(true);
    // root 日誌那一份一定在；子代理的日誌若有另外的 runner 也各一行，所以只問「每一行都是這八個」。
    for (const line of lines) {
      expect(line.kind === 'installed' && line.packages).toEqual(SHIPPED_PACKAGES);
    }
    expect(stderr()).not.toContain('[不變量]');
    expect(stdout()).not.toContain('[不變量]');
  });

  it('**違規發生時檔裡有那一行，而且有對應的 installed**；印出來的前綴與原來逐字相同', async () => {
    const home = tempHome();
    const { printer, stderr } = recorder();
    await runCli({
      argv: ['--patch', 'src/cli-invariant-violation.patch.yml', '說點什麼'],
      input: new PassThrough(),
      output: new PassThrough(),
      printer,
      env: { NEXUS_AGENT_HOME: home },
    });

    const lines = readLines(home);
    const installed = lines.filter((line) => line.kind === 'installed');
    const violations = lines.filter((line) => line.kind === 'violation');
    expect(installed).not.toHaveLength(0);
    // 出貨八個加上這顆吵鬧的假 package。
    expect(installed[0]).toMatchObject({
      packages: [...SHIPPED_PACKAGES, '@nexus/noisy'].sort(),
    });
    expect(violations.length).toBeGreaterThan(0);
    for (const line of violations) {
      expect(line).toMatchObject({ package: '@nexus/noisy' });
      expect(line.kind === 'violation' && line.message).toContain(
        'invariant violated by "@nexus/noisy": 看到 ',
      );
    }
    // 假配套入口對每個事件都報，所以印出來那兩條（stderr 測試驗過的）在記錄裡也都有。
    const messages = violations.map((line) => line.kind === 'violation' && line.message);
    expect(messages).toContain('invariant violated by "@nexus/noisy": 看到 turn/start');
    expect(messages).toContain('invariant violated by "@nexus/noisy": 看到 turn/end');
    // 同一個會話：違規那行的 sessionId 對得上某一行 installed。
    const installedIds = new Set(installed.map((line) => line.sessionId));
    for (const line of violations) expect(installedIds.has(line.sessionId)).toBe(true);
    // 印出來的與記下來的筆數一致，前綴不變。
    expect(
      stderr()
        .split('\n')
        .filter((line) => line.startsWith('[不變量] ')),
    ).toHaveLength(violations.length);
  });

  it('**落盤關掉就不寫**：home 連目錄都不建，違規照舊印出來', async () => {
    const home = tempHome();
    const homeDir = join(home, 'never-created');
    const { printer, stderr } = recorder();
    await runCli({
      argv: [
        '--patch',
        PERSISTENCE_OFF_PATCH,
        '--patch',
        'src/cli-invariant-violation.patch.yml',
        '說點什麼',
      ],
      input: new PassThrough(),
      output: new PassThrough(),
      printer,
      env: { NEXUS_AGENT_HOME: homeDir },
    });

    expect(existsSync(homeDir)).toBe(false);
    // 前提：違規真的發生過，所以「沒有檔」不是因為根本沒有東西可記。
    expect(stderr()).toContain('[不變量] invariant violated by "@nexus/noisy"');
  });

  it('**分母是量出來的**：關掉 todo 的配套入口，installed 那一欄就少掉它', async () => {
    const home = tempHome();
    const { printer } = recorder();
    await runCli({
      argv: ['--patch', 'src/invariant-log-todo-off.patch.yml', '說點什麼'],
      input: new PassThrough(),
      output: new PassThrough(),
      printer,
      env: { NEXUS_AGENT_HOME: home },
    });

    const installed = readLines(home).filter((line) => line.kind === 'installed');
    expect(installed).not.toHaveLength(0);
    for (const line of installed) {
      expect(line.kind === 'installed' && line.packages).not.toContain('@nexus/plugin-todo');
      expect(line.kind === 'installed' && line.packages).toContain('@nexus/core');
    }
  });
});

describe('serve 那條路', () => {
  const PATCH = new URL('./serve-session-wiring.patch.yml', import.meta.url).pathname;

  it('thread 的 installed 與探針的違規都進了同一個檔，sessionId 是 threadId，console.error 照舊', async () => {
    const home = tempHome();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    running = await runServe({
      argv: ['--port', '0', '--patch', PATCH],
      log: () => undefined,
      env: { NEXUS_AGENT_HOME: home },
    });
    const client = await serveClient(running as RunningServe);
    const events = await client.openEvents('log-thread');
    await client.runStart('log-thread', '嗨');
    await foldTurn(events);

    const lines = readLines(home);
    const installed = lines.filter((line) => line.kind === 'installed');
    const violations = lines.filter((line) => line.kind === 'violation');
    expect(installed.some((line) => line.sessionId === 'log-thread')).toBe(true);
    for (const line of installed) {
      expect(line.kind === 'installed' && line.packages).toEqual(
        [...SHIPPED_PACKAGES, WIRING_PROBE_PACKAGE].sort(),
      );
    }
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toMatchObject({ sessionId: 'log-thread', package: WIRING_PROBE_PACKAGE });
    // 違規本身仍然走 runner 預設的 console.error，沒有被旁路取代。
    expect(spy.mock.calls.map((call) => String(call[0]))).toContain(
      `invariant violated by "${WIRING_PROBE_PACKAGE}": 看到 turn/start`,
    );
  });

  it('落盤關掉就不寫：沒有記錄檔，違規照舊走 console.error', async () => {
    // serve 啟動時本來就會在 home 建瀏覽器會話密鑰，所以這裡問的是記錄檔，不是 home。
    const homeDir = tempHome();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    running = await runServe({
      argv: ['--port', '0', '--patch', PERSISTENCE_OFF_PATCH, '--patch', PATCH],
      log: () => undefined,
      env: { NEXUS_AGENT_HOME: homeDir },
    });
    const client = await serveClient(running as RunningServe);
    const events = await client.openEvents('off-thread');
    await client.runStart('off-thread', '嗨');
    await foldTurn(events);

    expect(existsSync(harnessInvariantLogPath({ NEXUS_AGENT_HOME: homeDir }))).toBe(false);
    expect(spy.mock.calls.map((call) => String(call[0]))).toContain(
      `invariant violated by "${WIRING_PROBE_PACKAGE}": 看到 turn/start`,
    );
  });
});
