/**
 * `permission-presets` 的 `apply` 拋（組合表壞了）在**宿主稽核**那一層的驗收（[#1491](https://github.com/DemianLi/nexus-agent/issues/1491)
 * 執行條件 2）：樹上那一列 apply 拋 → 組裝時變成 `dropped` → 必掛稽核接住。三處入口各一條：CLI 啟動、serve 起動、serve 中途換設定後組 thread。
 *
 * 前例是 `system-prompt-on-tree.test.ts` 的同類 describe。插件層的 `index.test.ts` 只量「那一列起不來」，量不到宿主有沒有把它記下來、轉成
 * 對的錯誤型別；而 serve 記「這一列掉了」只認 `AssemblyDropError`，斷言因此看**錯誤型別與紀錄**，不只比訊息。
 */

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from './cli.js';
import { foldTurn, serveClient } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { changePlugin } from './plugin-change.js';
import { appendRaw, journalPathOf } from './plugin-journal.fixture.js';
import { readJournal } from './plugin-journal.js';
import type { JournalBody, JournalRecord } from './plugin-journal.js';
import { scriptedPatchText } from './scripted-serve.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';
import { StartupError } from './startup-audit.js';

const temporary: string[] = [];
let running: RunningServe | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(dir, 0o700);
  temporary.push(dir);
  return dir;
}

/** 組合表是空的：`apply` 當場拋（`assertPresetConfig`），不是 schema 驗不過。 */
const EMPTY_TABLE = { presets: {} };
const EMPTY_TABLE_MESSAGE = '組合表是空的';

const BAD_CONFIG: JournalBody = {
  op: 'config-set',
  id: 'permission-presets',
  name: '@nexus/plugin-permission-presets',
  before: null,
  after: EMPTY_TABLE,
};

type Failed = Extract<JournalRecord, { op: 'failed' }>;

function failedOf(dir: string): Failed[] {
  return (readJournal(journalPathOf(dir))?.records ?? []).filter(
    (entry): entry is Failed => entry.op === 'failed',
  );
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

describe('apply 拋 → 稽核接住（三處入口）', () => {
  it('CLI 啟動：丟 StartupError，名單裡有 permission-presets（stage 是 apply），原因逐字在', async () => {
    const dir = scratch('nexus-presets-audit-cli-');
    const workspace = scratch('nexus-presets-audit-ws-');
    const patch = join(dir, 'bad.patch.yml');
    writeFileSync(patch, JSON.stringify([{ id: 'permission-presets', config: EMPTY_TABLE }]));
    const quiet = { log: () => undefined, error: () => undefined };

    const error = await runCli({
      argv: [
        '--workspace',
        workspace,
        '--session-log',
        join(dir, 'sessions'),
        '--patch',
        patch,
        '說點什麼',
      ],
      input: new PassThrough(),
      output: new PassThrough(),
      printer: quiet,
      env: { [HARNESS_HOME_ENV]: dir },
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(StartupError);
    const drops = (error as StartupError).dropped.filter(
      (drop) => drop.id === 'permission-presets',
    );
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({ stage: 'apply' });
    expect(drops[0]?.message).toContain(EMPTY_TABLE_MESSAGE);
  }, 60000);

  it('serve 起動：丟 StartupError，紀錄檔記一筆 permission-presets（stage 是 apply），在拋之前已寫進去', async () => {
    const dir = scratch('nexus-presets-audit-serve-');
    const workspace = scratch('nexus-presets-audit-ws-');
    const bad = await appendRaw(dir, BAD_CONFIG);

    const error = await runServe({
      argv: ['--port', '0', '--workspace', workspace],
      log: () => undefined,
      env: { [HARNESS_HOME_ENV]: dir },
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(StartupError);
    expect(
      (error as StartupError).dropped.filter((drop) => drop.id === 'permission-presets'),
    ).toHaveLength(1);
    expect(failedOf(dir)).toHaveLength(1);
    expect(failedOf(dir)[0]).toMatchObject({
      id: 'permission-presets',
      triggerSeq: bad.seq,
      stage: 'apply',
    });
  }, 60000);

  it('serve 中途換設定後組 thread：那條建不起來，紀錄檔記一筆；改回來之後下一條建得起來', async () => {
    const dir = scratch('nexus-presets-audit-live-');
    const workspace = scratch('nexus-presets-audit-ws-');
    const env = { [HARNESS_HOME_ENV]: dir };
    running = (await runServe({
      argv: ['--port', '0', '--workspace', workspace],
      log: () => undefined,
      env,
    })) as RunningServe;
    expect(await say(running, 'warm')).toBeUndefined();

    const bad = await appendRaw(dir, BAD_CONFIG);
    const refused = await say(running, 'a');
    expect(refused).toContain('permission-presets');
    expect(refused).toContain(EMPTY_TABLE_MESSAGE);
    expect(failedOf(dir)).toHaveLength(1);
    expect(failedOf(dir)[0]).toMatchObject({
      id: 'permission-presets',
      triggerSeq: bad.seq,
      stage: 'apply',
    });

    await changePlugin({ op: 'config-reset', id: 'permission-presets' }, { env });
    expect(await say(running, 'b')).toBeUndefined();
  }, 120000);
});

/** 根對話派一個背景子代理，之後都是普通回覆（子代理與根對話共用同一顆腳本模型，輪到誰誰吃）。 */
const DISPATCH_TURNS = [
  {
    content: '委派。',
    toolCalls: [
      {
        name: 'subagent',
        args: { description: '幹活', subagent_type: 'general-purpose', run_in_background: true },
      },
    ],
  },
  { content: '子代理做完了。' },
  { content: '收到。' },
  { content: '好。' },
] as const;

/** 起動前就在變更紀錄裡的表：加回了全開那一組（`--patch` 疊的層比變更紀錄外面，後面的換表蓋不過它，所以走紀錄）。 */
const WITH_FULL_ACCESS = {
  presets: {
    'read-only': { sandbox: 'read-only', approval: 'ask' },
    'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
    'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
  },
};

/** 部署方在 serve 還開著時把全開那一組從表裡拿掉：整份重寫，只留兩組。 */
const WITHOUT_FULL_ACCESS = {
  presets: {
    'read-only': { sandbox: 'read-only', approval: 'ask' },
    'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
  },
};

/** 子代理那份日誌的事件，依序；等到它的第一輪收尾（`turn/end`）才回（背景子代理的日誌在 root 那一輪收尾之後才寫完）。 */
async function subagentEvents(
  sessionLog: string,
  thread: string,
): Promise<{ type: string; data: unknown }[]> {
  for (let tries = 0; tries < 400; tries += 1) {
    const [project] = readdirSync(sessionLog);
    const directory = join(sessionLog, project ?? '');
    const body = readdirSync(directory).find(
      (name) => name.startsWith(`${thread}%2fbg-`) && name.endsWith('.jsonl'),
    );
    if (body !== undefined) {
      const events = readFileSync(join(directory, body), 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as { type: string; data: unknown });
      if (events.some((event) => event.type === 'turn/end')) return events;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('子代理的日誌等太久了');
}

describe('開著的 thread 照舊表，新開的 thread 用新表（D4、E1、G5）', () => {
  it('serve 開著時把全開那組從表裡拿掉：A 的目錄、/permission 與子代理日誌照舊表，B 用新表，日誌上的組合彼此不動', async () => {
    const dir = scratch('nexus-presets-live-table-');
    const workspace = scratch('nexus-presets-live-table-ws-');
    const sessionLog = join(dir, 'sessions');
    const patch = join(dir, 'scripted.patch.yml');
    writeFileSync(patch, scriptedPatchText(DISPATCH_TURNS));
    const env = { [HARNESS_HOME_ENV]: dir };
    await changePlugin(
      { op: 'config-set', id: 'permission-presets', config: WITH_FULL_ACCESS },
      { env },
    );
    running = (await runServe({
      argv: [
        '--port',
        '0',
        '--workspace',
        workspace,
        '--session-log',
        sessionLog,
        '--patch',
        patch,
      ],
      log: () => undefined,
      env,
    })) as RunningServe;
    const client = await serveClient(running);
    const optionsOf = async (thread: string): Promise<string[]> => {
      const catalog = await client.permissionCatalog(thread);
      if (catalog.kind !== 'ok') throw new Error(`目錄沒拿到：${JSON.stringify(catalog)}`);
      return catalog.result.value.catalog.options.map((option) => option.value);
    };

    // A 在換表之前開，並且切到全開（表換掉之後它仍然站在那一組上）。
    expect(await optionsOf('a')).toEqual(['read-only', 'workspace-write', 'danger-full-access']);
    expect(await client.slashRun('a', '/permission danger-full-access')).toMatchObject({
      kind: 'success',
    });

    await changePlugin(
      { op: 'config-set', id: 'permission-presets', config: WITHOUT_FULL_ACCESS },
      { env },
    );

    // A 開著的 thread：目錄與 /permission 都還是舊表（第 3 組還在），目前仍是全開。
    expect(await optionsOf('a')).toEqual(['read-only', 'workspace-write', 'danger-full-access']);
    const aSays = await client.slashRun('a', '/permission');
    expect(aSays.kind === 'success' && aSays.text).toContain('目前的權限組合：danger-full-access');
    // B 換表之後才開：新表只有兩組，切全開被拒，起始是 workspace-write。
    expect(await optionsOf('b')).toEqual(['read-only', 'workspace-write']);
    expect(await client.slashRun('b', '/permission danger-full-access')).toMatchObject({
      kind: 'error',
    });
    const bBefore = await client.slashRun('b', '/permission');
    expect(bBefore.kind === 'success' && bBefore.text).toContain('目前的權限組合：workspace-write');

    // A 派一個子代理：子代理日誌上的組名由 A 那一刻折進來的參與者寫，用的是舊表——新表不認全開，會什麼都不寫。
    const events = await client.openEvents('a');
    await client.runStart('a', '請派一個子代理');
    await foldTurn(events);
    await events.return?.(undefined);
    const sub = await subagentEvents(sessionLog, 'a');
    expect(sub.find((event) => event.type === 'sandbox/mode')?.data).toMatchObject({
      mode: 'danger-full-access',
      source: 'delegation',
    });
    expect(sub.find((event) => event.type === 'permission/preset')?.data).toEqual({
      preset: 'danger-full-access',
    });

    // 另一條 thread 的日誌上的組合不動：A 切走之後 B 還是 workspace-write，A 自己切得過去、B 的 /permission 回覆不變。
    // （/permission 的回覆是從日誌折出來的，量不到 fence；真的 fence 見下一條測試。）
    expect(await client.slashRun('a', '/permission read-only')).toMatchObject({ kind: 'success' });
    const bAfter = await client.slashRun('b', '/permission');
    expect(bAfter.kind === 'success' && bAfter.text).toBe(
      bBefore.kind === 'success' && bBefore.text,
    );
    expect(bAfter.kind === 'success' && bAfter.text).toContain('目前的權限組合：workspace-write');
  }, 120000);
});

describe('換表之後兩條 thread 的 fence 互不影響', () => {
  it('A 在舊表上切到 read-only、換表後開 B：A 寫工作區內的檔被擋，B 寫同一處成功', async () => {
    const dir = scratch('nexus-presets-live-fence-');
    const workspace = scratch('nexus-presets-live-fence-ws-');
    const patch = join(dir, 'scripted.patch.yml');
    writeFileSync(
      patch,
      scriptedPatchText([
        {
          content: '',
          toolCalls: [{ name: 'write_file', args: { file_path: '/note.txt', content: '寫了' } }],
        },
        { content: '好。' },
      ]),
    );
    const env = { [HARNESS_HOME_ENV]: dir };
    await changePlugin(
      { op: 'config-set', id: 'permission-presets', config: WITH_FULL_ACCESS },
      { env },
    );
    running = (await runServe({
      argv: ['--port', '0', '--workspace', workspace, '--patch', patch],
      log: () => undefined,
      env,
    })) as RunningServe;
    const client = await serveClient(running);
    const target = join(workspace, 'note.txt');
    const speak = async (thread: string): Promise<void> => {
      const events = await client.openEvents(thread);
      const started = await client.runStart(thread, '寫一個檔');
      expect(started.type).not.toBe('error');
      await foldTurn(events);
      await events.return?.(undefined);
    };

    expect(await client.slashRun('a', '/permission read-only')).toMatchObject({ kind: 'success' });
    await changePlugin(
      { op: 'config-set', id: 'permission-presets', config: WITHOUT_FULL_ACCESS },
      { env },
    );

    // A 先跑：唯讀，擋下。檔案沒有出現。
    await speak('a');
    expect(existsSync(target)).toBe(false);
    // B 是換表之後才開的新 thread：workspace-write，同一個呼叫寫得進去（反例：不是這個環境本來就寫不了）。
    await speak('b');
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('寫了');
  }, 120000);
});
