/**
 * serve 每條 thread 組裝時重讀清單（#1405）：量的是產品路徑（`runServe` 加真的 wire client），在兩條對話之間改設定。
 *
 * **#1412 之後「改設定」走真的寫入口**（`plugin-change.ts`）：home 的 `cordis.patch.yml` 不再是一層，這一層是只增不改的
 * 變更紀錄。要寫「寫入口不會放行」的壞狀態（驗證之後才壞掉的設定、被人手動改壞的紀錄）走 `appendRaw`／`writeJournalText`。
 * 寫入口的試掛（#2073）在這裡換成不掛：正式環境的寫入口是另一個行程，同一個行程裡試掛的 `apply` 會寫進同一個見證檔；
 * 試掛本身量在 `plugin-change-trial.test.ts`。
 *
 * 量具是一顆插進清單的假插件：每次 `apply` 把拿到的設定寫進一個見證檔，模組被求值一次就在另一個見證檔記一筆。
 */

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { bodyLog, foldTurn, serveClient } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { projectKey } from './jsonl-session-store.js';
import { changePlugin } from './plugin-change.js';
import type { PluginChange, PluginChangeResult } from './plugin-change.js';
import type { JournalBody, JournalRecord } from './plugin-journal.js';
import {
  appendRaw,
  readJournalText,
  seedHomePatch,
  writeJournalText,
} from './plugin-journal.fixture.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';
import { sessionHeaderOf } from './session-files.fixture.js';

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
  /** 起始的設定：寫成紀錄檔（等同第一次啟動時遷移的結果），要在 `runServe` 之前呼叫。 */
  seed(body: string): void;
  /** 走真的寫入口改一列（驗證、鎖、fsync 都在）。 */
  change(change: PluginChange): Promise<PluginChangeResult>;
  /** 不經驗證追加一筆。 */
  raw(body: JournalBody): Promise<JournalRecord>;
  /** 整份換掉紀錄檔的文字。 */
  text(body?: string): string;
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
  const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
  const env = { [HARNESS_HOME_ENV]: dir };
  return {
    env,
    dir,
    applied: () => read(appliedPath).split('\n').filter(Boolean),
    evaluations: () => read(evaluatedPath).length,
    seed: (body) => seedHomePatch(dir, body),
    change: (change) => changePlugin(change, { env, trial: async () => [] }),
    raw: (body) => appendRaw(dir, body),
    text(body) {
      if (body !== undefined) writeJournalText(dir, body);
      return readJournalText(dir);
    },
  };
}

/** 插一列假插件，帶這份設定（起始設定用）。 */
function probeRow(config: string, extra = ''): string {
  return `- insert:\n    - id: probe\n      name: './probe.ts'\n${config}${extra}`;
}

async function start(env: NodeJS.ProcessEnv, lines: string[]): Promise<RunningServe> {
  const server = (await runServe({
    argv: ['--port', '0'],
    log: bodyLog(lines),
    env,
  })) as RunningServe;
  running = server;
  return server;
}

/** 在這條 thread 上說一句，跑完一輪；建不起來就回錯誤訊息。 */
async function say(server: RunningServe, thread: string): Promise<string | undefined> {
  const client = await serveClient(server);
  // 建不起來的 thread，開下行那一步就被拒，原因在 serve 的日誌。
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

async function header(dir: string, thread: string): Promise<{ configHash?: string }> {
  return (await sessionHeaderOf(join(dir, 'sessions', projectKey(process.cwd())), thread)).header;
}

describe('serve 每條 thread 重讀清單（#1405）', () => {
  it('兩條對話之間改了一列的設定：第二條拿到新值，開著的第一條不變；模組只求值一次', async () => {
    const h = home();
    h.seed(probeRow('      config:\n        tag: one\n'));
    const server = await start(h.env, []);
    expect(await say(server, 'a')).toBeUndefined();
    const written = await h.change({ op: 'config-set', id: 'probe', config: { tag: 'two' } });
    expect(written).toMatchObject({ outcome: 'recorded', effect: 'next-thread' });
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
    h.seed(probeRow('      config:\n        tag: one\n'));
    const server = await start(h.env, []);
    expect(await say(server, 'a')).toBeUndefined();
    expect(await h.change({ op: 'disable', id: 'probe' })).toMatchObject({ outcome: 'recorded' });
    expect(await say(server, 'b')).toBeUndefined();
    expect(h.applied()).toHaveLength(2);
  }, 60000);

  it('會話 header 記的是那條對話自己那份清單', async () => {
    const h = home();
    h.seed(probeRow('      config:\n        tag: one\n'));
    const server = await start(h.env, []);
    expect(await say(server, 'a')).toBeUndefined();
    await h.change({ op: 'config-set', id: 'probe', config: { tag: 'two' } });
    expect(await say(server, 'b')).toBeUndefined();
    const a = await header(h.dir, 'a');
    const b = await header(h.dir, 'b');
    expect(a.configHash).toMatch(/^hmac-sha256:/u);
    expect(b.configHash).toMatch(/^hmac-sha256:/u);
    expect(b.configHash).not.toBe(a.configHash);
  }, 60000);

  it('清單讀不起來：只有那一條建不起來，伺服器照常，改好之後下一條建得起來', async () => {
    const h = home();
    h.seed(probeRow('      config:\n        tag: one\n'));
    const lines: string[] = [];
    const server = await start(h.env, lines);
    const good = h.text();
    // 紀錄中間壞了一行（後面還有合法的一筆）：讀端拋、指名第幾行。
    h.text(`${good}{這不是 JSON\n${good.split('\n')[0] ?? ''}\n`);
    const refused = await say(server, 'a');
    expect(refused).toContain('原因記在 serve 的日誌');
    expect(refused).not.toContain('plugin-journal.jsonl');
    expect(lines.join('\n')).toContain('plugin-journal.jsonl');
    expect(lines.join('\n')).toMatch(/第 \d+ 行/u);
    // 救援：備份、把壞行拿掉。
    h.text(good);
    await h.change({ op: 'config-set', id: 'probe', config: { tag: 'two' } });
    expect(await say(server, 'b')).toBeUndefined();
    expect(h.applied()).toEqual(['{"tag":"one"}', '{"tag":"two"}']);
  }, 60000);

  it('必掛的列掉了：只有那一條建不起來，日誌裡的原因同啟動那一次', async () => {
    const h = home();
    const lines: string[] = [];
    const server = await start(h.env, lines);
    // 寫入口不會放行這個值；驗證之後才壞掉（例如手動改紀錄、或下一版收緊了設定格式）的狀態用 raw 造。
    await h.raw({
      op: 'config-set',
      id: 'browser-session',
      name: '#settings/browser-session',
      before: null,
      after: { maxAgeDays: 0 },
    });
    const refused = await say(server, 'a');
    expect(refused).toContain('原因記在 serve 的日誌');
    expect(lines.join('\n')).toMatch(/起不來/u);
    expect(lines.join('\n')).toContain('browser-session');
    // 恢復成繼承值之後，下一條建得起來。
    expect(await h.change({ op: 'config-reset', id: 'browser-session' })).toMatchObject({
      outcome: 'recorded',
    });
    expect(await say(server, 'b')).toBeUndefined();
  }, 60000);

  it('啟動時讀一次的列改了：寫入口回報 restart，伺服器日誌記一次「已儲存，待重啟」', async () => {
    const h = home();
    const lines: string[] = [];
    const server = await start(h.env, lines);
    expect(await say(server, 'a')).toBeUndefined();
    expect(lines.filter((line) => line.startsWith('[清單]'))).toEqual([]);
    const written = await h.change({
      op: 'config-set',
      id: 'thread-title',
      config: { maxWords: 3, maxBytes: 40 },
    });
    expect(written).toMatchObject({ outcome: 'recorded', effect: 'restart' });
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
    await h.raw({
      op: 'config-set',
      id: 'todo',
      name: '@nexus/plugin-todo',
      before: null,
      after: { allowParallelInProgress: '不是布林' },
    });
    expect(await say(server, 'a')).toBeUndefined();
    expect(await say(server, 'b')).toBeUndefined();
    const dropped = lines.filter((line) => line.startsWith('[清單] 這一列沒掛上'));
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toContain('todo');
  }, 60000);

  it('試組掉了的列：設定沒變就不再試，設定一改下一條重新試它', async () => {
    const h = home(true);
    h.seed(probeRow('      config:\n        ok: false\n'));
    const server = await start(h.env, []);
    expect(await say(server, 'a')).toBeUndefined();
    // 只有試組那一次。
    expect(h.applied()).toEqual(['{"ok":false}']);
    await h.change({ op: 'config-set', id: 'probe', config: { ok: true } });
    expect(await say(server, 'b')).toBeUndefined();
    expect(h.applied()).toEqual(['{"ok":false}', '{"ok":true}']);
  }, 60000);

  it('沒寫 id 的列試組掉了：設定一改下一條照樣重新試它（鍵要含那一列的宣告）', async () => {
    const h = home(true);
    const anonymous = (config: string): string => `- insert:\n    - name: './probe.ts'\n${config}`;
    h.seed(anonymous('      config:\n        ok: false\n'));
    const server = await start(h.env, []);
    expect(await say(server, 'a')).toBeUndefined();
    expect(h.applied()).toEqual(['{"ok":false}']);
    // 沒有 id 的列寫入口指不到：這一條只換整份起始設定（測試用），量的是重試的鍵。
    seedHomePatch(h.dir, anonymous('      config:\n        ok: true\n'));
    expect(await say(server, 'b')).toBeUndefined();
    expect(h.applied()).toEqual(['{"ok":false}', '{"ok":true}']);
  }, 60000);

  it('試組掉了的列改成另一個壞值：只重試一次，之後的對話不再試', async () => {
    const h = home(true);
    h.seed(probeRow('      config:\n        note: 1\n'));
    const server = await start(h.env, []);
    await h.change({ op: 'config-set', id: 'probe', config: { note: 2 } });
    expect(await say(server, 'a')).toBeUndefined();
    expect(await say(server, 'b')).toBeUndefined();
    expect(h.applied()).toEqual(['{"note":1}', '{"note":2}']);
  }, 60000);

  it('讀清單的警告只記一次，進伺服器日誌', async () => {
    const h = home();
    const lines: string[] = [];
    const server = await start(h.env, lines);
    // 寫入口不會為不存在的 id 追加；紀錄被手動改成這樣時，疊層照 dsh 警告後跳過。
    await h.raw({ op: 'disable', id: 'no-such-row', name: 'x', before: false, after: true });
    expect(await say(server, 'a')).toBeUndefined();
    expect(await say(server, 'b')).toBeUndefined();
    expect(lines.filter((line) => line.includes('no-such-row'))).toEqual([
      '[清單] patch：找不到 id 為 "no-such-row" 的條目，這一條跳過。',
    ]);
  }, 60000);

  it('重讀時關核准閘門：那一條建不起來', async () => {
    const h = home();
    const lines: string[] = [];
    const server = await start(h.env, lines);
    await h.raw({
      op: 'disable',
      id: 'approval-gate',
      name: '@nexus/core/approval-gate',
      before: false,
      after: true,
    });
    expect(await say(server, 'a')).toContain('原因記在 serve 的日誌');
    expect(lines.join('\n')).toContain('approval-gate');
  }, 60000);
});
