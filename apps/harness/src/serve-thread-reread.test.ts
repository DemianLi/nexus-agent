/**
 * serve 每條 thread 組裝時重讀清單（#1405）：量的是產品路徑（`runServe` 加真的 wire client），在兩條對話之間改 home 層的
 * `cordis.patch.yml`。
 *
 * 量具是一顆插進清單的假插件：每次 `apply` 把拿到的設定寫進一個見證檔，模組被求值一次就在另一個見證檔記一筆。
 */

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { foldTurn, serveClient } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { projectKey } from './jsonl-session-store.js';
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
  /** 每次 `apply` 拿到的設定，一行一筆。 */
  applied(): string[];
  /** 模組被求值了幾次。 */
  evaluations(): number;
  /** 換掉 home 層的 patch。 */
  patch(body: string): void;
}

/**
 * 一個私有的 harness home，裡面放那顆假插件。`failUnlessOk` 為真時，設定裡沒有 `ok: true` 就在 `apply` 裡拋。
 */
function home(failUnlessOk = false): Home {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-thread-reread-'));
  temporary.push(dir);
  chmodSync(dir, 0o700);
  const appliedPath = join(dir, 'applied.txt');
  const evaluatedPath = join(dir, 'evaluated.txt');
  const module = join(dir, 'probe.ts');
  writeFileSync(
    module,
    [
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(evaluatedPath)}, 'x');`,
      'export default {',
      "  name: 'probe',",
      '  apply(_registry, config) {',
      `    appendFileSync(${JSON.stringify(appliedPath)}, JSON.stringify(config ?? null) + '\\n');`,
      `    if (${String(failUnlessOk)} && config?.ok !== true) throw new Error('故意在 apply 裡壞掉');`,
      '  },',
      '};',
      '',
    ].join('\n'),
  );
  chmodSync(module, 0o600);
  const patchPath = join(dir, 'cordis.patch.yml');
  const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
  return {
    env: { [HARNESS_HOME_ENV]: dir },
    dir,
    applied: () => read(appliedPath).split('\n').filter(Boolean),
    evaluations: () => read(evaluatedPath).length,
    patch(body) {
      writeFileSync(patchPath, body);
      chmodSync(patchPath, 0o600);
    },
  };
}

/** 插一列假插件，帶這份設定。 */
function probeRow(config: string, extra = ''): string {
  return `- insert:\n    - id: probe\n      name: './probe.ts'\n${config}${extra}`;
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

/** 在這條 thread 上說一句，跑完一輪；建不起來就回錯誤訊息。 */
async function say(server: RunningServe, thread: string): Promise<string | undefined> {
  const client = await serveClient(server);
  // 建不起來的 thread，開下行那一步就被拒，錯誤帶著原因。
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

function header(dir: string, thread: string): { configHash?: string; plugins?: unknown[] } {
  const path = join(dir, 'sessions', projectKey(process.cwd()), `${thread}.header.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as { configHash?: string; plugins?: unknown[] };
}

describe('serve 每條 thread 重讀清單（#1405）', () => {
  it('兩條對話之間改了一列的設定：第二條拿到新值，開著的第一條不變；模組只求值一次', async () => {
    const h = home();
    h.patch(probeRow('      config:\n        tag: one\n'));
    const server = await start(h.env, []);
    expect(await say(server, 'a')).toBeUndefined();
    h.patch(probeRow('      config:\n        tag: two\n'));
    expect(await say(server, 'b')).toBeUndefined();
    // 第一條還開著，再說一句不重組。
    expect(await say(server, 'a')).toBeUndefined();
    // 試組、a、b。
    expect(h.applied()).toEqual(['{"tag":"one"}', '{"tag":"one"}', '{"tag":"two"}']);
    // 不換程式碼版本：同一個 specifier 第二次拿到的是同一個模組。
    expect(h.evaluations()).toBe(1);
  }, 60000);

  it('兩條對話之間關掉一列：第二條不掛它', async () => {
    const h = home();
    h.patch(probeRow('      config:\n        tag: one\n'));
    const server = await start(h.env, []);
    expect(await say(server, 'a')).toBeUndefined();
    h.patch(`${probeRow('      config:\n        tag: one\n')}- id: probe\n  disabled: true\n`);
    expect(await say(server, 'b')).toBeUndefined();
    expect(h.applied()).toHaveLength(2);
  }, 60000);

  it('會話 header 記的是那條對話自己那份清單', async () => {
    const h = home();
    h.patch(probeRow('      config:\n        tag: one\n'));
    const server = await start(h.env, []);
    expect(await say(server, 'a')).toBeUndefined();
    h.patch(probeRow('      config:\n        tag: two\n'));
    expect(await say(server, 'b')).toBeUndefined();
    const a = header(h.dir, 'a');
    const b = header(h.dir, 'b');
    expect(a.configHash).toMatch(/^hmac-sha256:/u);
    expect(b.configHash).toMatch(/^hmac-sha256:/u);
    expect(b.configHash).not.toBe(a.configHash);
  }, 60000);

  it('清單讀不起來：只有那一條建不起來，伺服器照常，改好之後下一條建得起來', async () => {
    const h = home();
    h.patch(probeRow('      config:\n        tag: one\n'));
    const server = await start(h.env, []);
    h.patch('- id: [這不是 YAML\n');
    const refused = await say(server, 'a');
    expect(refused).toBeDefined();
    expect(refused).toContain('cordis.patch.yml');
    h.patch(probeRow('      config:\n        tag: two\n'));
    expect(await say(server, 'b')).toBeUndefined();
    expect(h.applied()).toEqual(['{"tag":"one"}', '{"tag":"two"}']);
  }, 60000);

  it('必掛的列掉了：只有那一條建不起來，訊息同啟動那一次', async () => {
    const h = home();
    const server = await start(h.env, []);
    h.patch('- id: browser-session\n  config:\n    maxAgeDays: 0\n');
    const refused = await say(server, 'a');
    expect(refused).toMatch(/起不來/u);
    expect(refused).toContain('browser-session');
    h.patch('[]\n');
    expect(await say(server, 'b')).toBeUndefined();
  }, 60000);

  it('啟動時讀一次的列改了：伺服器日誌記一次「已儲存，待重啟」', async () => {
    const h = home();
    const lines: string[] = [];
    const server = await start(h.env, lines);
    expect(await say(server, 'a')).toBeUndefined();
    expect(lines.filter((line) => line.startsWith('[清單]'))).toEqual([]);
    h.patch('- id: thread-title\n  config:\n    maxWords: 3\n    maxBytes: 40\n');
    expect(await say(server, 'b')).toBeUndefined();
    expect(await say(server, 'c')).toBeUndefined();
    expect(lines.filter((line) => line.startsWith('[清單]'))).toEqual([
      '[清單] 「thread-title」改了，已儲存，待重啟：這一列在啟動時讀一次，新對話照舊用啟動時的值',
    ]);
  }, 60000);

  it('兩條對話之間把一列可少掛的設定寫壞：那一列不掛，伺服器日誌只記一次', async () => {
    const h = home();
    const lines: string[] = [];
    const server = await start(h.env, lines);
    h.patch("- id: todo\n  config:\n    allowParallelInProgress: '不是布林'\n");
    expect(await say(server, 'a')).toBeUndefined();
    expect(await say(server, 'b')).toBeUndefined();
    const dropped = lines.filter((line) => line.startsWith('[清單] 這一列沒掛上'));
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toContain('todo');
  }, 60000);

  it('試組掉了的列：設定沒變就不再試，設定一改下一條重新試它', async () => {
    const h = home(true);
    h.patch(probeRow('      config:\n        ok: false\n'));
    const server = await start(h.env, []);
    expect(await say(server, 'a')).toBeUndefined();
    // 只有試組那一次。
    expect(h.applied()).toEqual(['{"ok":false}']);
    h.patch(probeRow('      config:\n        ok: true\n'));
    expect(await say(server, 'b')).toBeUndefined();
    expect(h.applied()).toEqual(['{"ok":false}', '{"ok":true}']);
  }, 60000);
});
