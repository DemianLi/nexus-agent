/**
 * 後台插拔的寫入口（[#1412](https://github.com/DemianLi/nexus-agent/issues/1412)）：驗收表 A–D、F、I 與加 4／5、
 * PM 2026-10-13 的第 4、5 點；以及 [#1414](https://github.com/DemianLi/nexus-agent/issues/1414) 的驗收 A、B、H
 * （被拒絕的變更也進紀錄）。
 */

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createCliAgent } from './assembly-root.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { toAgentInvocation } from './messages.js';
import { changePlugin, hostActor, PluginChangeRejected } from './plugin-change.js';
import type { PluginChange } from './plugin-change.js';
import { composeEntries, defaultSources, loadDefaultPlugins } from './plugin-config.js';
import { appendRaw, journalPathOf, writeJournalText } from './plugin-journal.fixture.js';
import { foldJournal, readJournal } from './plugin-journal.js';
import { PLUGIN_SNAPSHOT_FILE_NAME } from './plugin-snapshot.js';
import type { ScriptedChatModel } from './scripted-model.js';

const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-plugin-change-'));
  chmodSync(dir, 0o700);
  temporary.push(dir);
  return { dir, env: { [HARNESS_HOME_ENV]: dir } };
}

const FIXED = () => new Date('2026-10-13T08:00:00.000Z');

/** CLI 那條組裝綁到的工具：同 `runCli` 的載入、同一支 `createCliAgent`。 */
async function boundTools(env: NodeJS.ProcessEnv): Promise<readonly string[]> {
  const { plugins } = await loadDefaultPlugins({ env });
  const built = await createCliAgent({ live: false }, plugins);
  try {
    await built.agent.invoke(toAgentInvocation('說點什麼'), {
      configurable: { thread_id: 'plugin-change' },
    });
    return (built.model as ScriptedChatModel).boundToolNames;
  } finally {
    await built.dispose();
  }
}

async function reject(change: PluginChange, env: NodeJS.ProcessEnv, patches?: string[]) {
  return changePlugin(change, {
    env,
    ...(patches !== undefined && { patches }),
  }).then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('停用、啟用（驗收 A）', () => {
  it('停用一列可少掛的插件：紀錄多一筆帶序號、時間、actor、操作、id、前後值；下一次組裝沒有那顆的工具；回報 next-thread', async () => {
    const { dir, env } = home();
    const before = await boundTools(env);
    const todoTools = before.filter((name) => /todo/u.test(name));
    expect(todoTools.length).toBeGreaterThan(0);

    const result = await changePlugin(
      { op: 'disable', id: 'todo' },
      {
        env,
        now: FIXED,
        actor: {
          kind: 'host-account',
          effective: 'svc',
          invoker: 'alice',
          invokerSource: 'SUDO_USER',
        },
      },
    );
    expect(result).toMatchObject({
      outcome: 'recorded',
      effect: 'next-thread',
      fields: ['disabled'],
      path: journalPathOf(dir),
    });
    expect(result.record).toEqual({
      v: 1,
      seq: 1,
      at: '2026-10-13T08:00:00.000Z',
      actor: {
        kind: 'host-account',
        effective: 'svc',
        invoker: 'alice',
        invokerSource: 'SUDO_USER',
      },
      op: 'disable',
      id: 'todo',
      name: '@nexus/plugin-todo',
      before: false,
      after: true,
    });

    const after = await boundTools(env);
    for (const name of todoTools) expect(after).not.toContain(name);

    // 啟用：回來。
    const enabled = await changePlugin({ op: 'enable', id: 'todo' }, { env, now: FIXED });
    expect(enabled).toMatchObject({ outcome: 'recorded', effect: 'next-thread' });
    expect(enabled.record).toMatchObject({ seq: 2, op: 'enable', before: true, after: false });
    expect(await boundTools(env)).toEqual(before);
  });

  it('已經是那個狀態：沒改變任何東西，不寫、紀錄逐位元組不變', async () => {
    const { dir, env } = home();
    await changePlugin({ op: 'disable', id: 'todo' }, { env });
    const bytes = readFileSync(journalPathOf(dir));
    const again = await changePlugin({ op: 'disable', id: 'todo' }, { env });
    expect(again.outcome).toBe('unchanged');
    expect(again.notes.join('')).toContain('已經是停用');
    expect(readFileSync(journalPathOf(dir)).equals(bytes)).toBe(true);
  });
});

describe('改設定、恢復成繼承值（驗收 B、C）', () => {
  it('組裝期讀的設定：下一條 thread 拿到新值（next-thread）；起動期讀的：回報 restart', async () => {
    const { env } = home();
    const assembly = await changePlugin(
      { op: 'config-set', id: 'recursion-limit', config: { limit: 7 } },
      { env },
    );
    expect(assembly).toMatchObject({
      outcome: 'recorded',
      effect: 'next-thread',
      fields: ['limit'],
    });
    const loaded = await loadDefaultPlugins({ env });
    expect(loaded.entries.find((entry) => entry.id === 'recursion-limit')?.config).toEqual({
      limit: 7,
    });

    const startup = await changePlugin(
      { op: 'config-set', id: 'thread-title', config: { maxWords: 3, maxBytes: 40 } },
      { env },
    );
    expect(startup).toMatchObject({ outcome: 'recorded', effect: 'restart' });
  });

  it('恢復成繼承值：回到出貨值；出貨預設換了就跟著變（沒有被釘住）', async () => {
    const { dir, env } = home();
    await changePlugin(
      { op: 'config-set', id: 'todo', config: { allowParallelInProgress: false } },
      { env },
    );
    const reset = await changePlugin({ op: 'config-reset', id: 'todo' }, { env });
    expect(reset).toMatchObject({ outcome: 'recorded', effect: 'next-thread' });
    // 紀錄裡記了被拿掉的那份與當時的繼承值（給人看）；折疊拿掉覆蓋，沒有抄一份。
    const contents = readJournal(journalPathOf(dir));
    expect(foldJournal(contents?.records ?? [])).toEqual([]);
    const loaded = await loadDefaultPlugins({ env });
    expect(loaded.entries.find((entry) => entry.id === 'todo')?.config).toEqual({
      allowParallelInProgress: true,
    });

    // 換一份出貨預設：用自己的出貨檔，同一份紀錄折上去。
    const shippedV1 = join(dir, 'shipped-v1.yml');
    const shippedV2 = join(dir, 'shipped-v2.yml');
    writeFileSync(
      shippedV1,
      "- id: row\n  name: '@nexus/plugin-todo'\n  config:\n    allowParallelInProgress: true\n",
    );
    writeFileSync(
      shippedV2,
      "- id: row\n  name: '@nexus/plugin-todo'\n  config:\n    allowParallelInProgress: false\n",
    );
    await appendRaw(dir, {
      op: 'config-set',
      id: 'row',
      name: '@nexus/plugin-todo',
      before: null,
      after: { allowParallelInProgress: false },
    });
    await appendRaw(dir, {
      op: 'config-reset',
      id: 'row',
      name: '@nexus/plugin-todo',
      before: { allowParallelInProgress: false },
      // 當時的繼承值是 true；折疊不看它。
      after: { allowParallelInProgress: true },
    });
    const journal = { path: journalPathOf(dir) };
    const v1 = composeEntries({ shipped: shippedV1, journal });
    const v2 = composeEntries({ shipped: shippedV2, journal });
    expect(v1[0]?.config).toEqual({ allowParallelInProgress: true });
    // 下一版出貨改了預設值，跟著變——沒有被前一次的覆蓋釘在 true。
    expect(v2[0]?.config).toEqual({ allowParallelInProgress: false });
  });

  it('新值等於繼承值：照 dsh 拿掉那一列的覆蓋，記成恢復（帶 requested），回報說了', async () => {
    const { dir, env } = home();
    await changePlugin(
      { op: 'config-set', id: 'todo', config: { allowParallelInProgress: false } },
      { env },
    );
    const equal = await changePlugin(
      { op: 'config-set', id: 'todo', config: { allowParallelInProgress: true } },
      { env },
    );
    expect(equal.record).toMatchObject({ op: 'config-reset', requested: 'config-set', seq: 2 });
    expect(equal.notes.join('')).toContain('已記成「恢復成繼承值」');
    const loaded = await loadDefaultPlugins({ env });
    expect(loaded.entries.find((entry) => entry.id === 'todo')?.config).toEqual({
      allowParallelInProgress: true,
    });
    // 本來就沒有覆蓋、又等於繼承值：什麼都不寫。
    const bytes = readFileSync(journalPathOf(dir));
    const noop = await changePlugin(
      { op: 'config-set', id: 'todo', config: { allowParallelInProgress: true } },
      { env },
    );
    expect(noop.outcome).toBe('unchanged');
    expect(readFileSync(journalPathOf(dir)).equals(bytes)).toBe(true);
  });
});

describe('寫入前先驗，驗不過拒絕並追加一筆 rejected（#1412 驗收 D、#1414 驗收 A）', () => {
  const CASES: readonly { name: string; change: PluginChange; message: RegExp }[] = [
    {
      name: '不存在的 id',
      change: { op: 'disable', id: 'no-such-row' },
      message: /沒有 id 為 "no-such-row" 的列/u,
    },
    {
      name: 'config 驗不過',
      change: { op: 'config-set', id: 'todo', config: { allowParallelInProgress: '不是布林' } },
      message: /todo/u,
    },
    {
      name: '停用必掛的 browser-session',
      change: { op: 'disable', id: 'browser-session' },
      message: /browser-session.*關不掉|關不掉.*browser-session/su,
    },
    {
      name: '停用 approval-gate',
      change: { op: 'disable', id: 'approval-gate' },
      message: /approval-gate.*關不掉|關不掉.*approval-gate/su,
    },
  ];

  it.each(CASES)(
    '$name：照樣拒絕，舊檔是新檔的前綴、後面恰好多一行 rejected；折出來的清單不變、不留鎖檔',
    async ({ change, message }) => {
      const { dir, env } = home();
      // 先放一筆，讓「前綴」比的是一份有內容的檔。
      await changePlugin({ op: 'disable', id: 'skills' }, { env, now: FIXED });
      const bytes = readFileSync(journalPathOf(dir));
      const listBefore = composeEntries(
        defaultSources({ serve: true, env, warn: () => undefined }),
      );
      const error = await changePlugin(change, {
        env,
        now: FIXED,
        actor: {
          kind: 'host-account',
          effective: 'svc',
          invoker: 'alice',
          invokerSource: 'SUDO_USER',
        },
      }).then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(PluginChangeRejected);
      expect((error as Error).message).toMatch(message);
      expect((error as PluginChangeRejected).seq).toBe(2);

      const after = readFileSync(journalPathOf(dir));
      // 位元組：舊檔是前綴，後面恰好一整行。
      expect(after.subarray(0, bytes.length).equals(bytes)).toBe(true);
      const appended = after.subarray(bytes.length).toString('utf8');
      expect(appended.endsWith('\n')).toBe(true);
      expect(appended.split('\n').filter((line) => line !== '')).toHaveLength(1);

      const records = readJournal(journalPathOf(dir))?.records ?? [];
      expect(records.map((entry) => entry.seq)).toEqual([1, 2]);
      const last = records[1];
      expect(last).toMatchObject({
        op: 'rejected',
        seq: 2,
        requested: change.op,
        id: change.id,
        reason: (error as Error).message,
        actor: { kind: 'host-account', effective: 'svc', invoker: 'alice' },
      });
      // 不帶要寫入的值：這一筆只有信封加這三格。
      expect(Object.keys(last ?? {}).sort()).toEqual(
        ['actor', 'at', 'id', 'op', 'reason', 'requested', 'seq', 'v'].sort(),
      );
      // 它不折：清單與沒有它時相同。
      expect(foldJournal(records)).toEqual(foldJournal(records.slice(0, 1)));
      expect(composeEntries(defaultSources({ serve: true, env, warn: () => undefined }))).toEqual(
        listBefore,
      );
      expect(existsSync(`${journalPathOf(dir)}.lock`)).toBe(false);
    },
  );

  it('要寫入的設定值一個位元組都不進紀錄', async () => {
    const { dir, env } = home();
    const secret = 'secret-value-7c1e';
    const error = await reject(
      { op: 'config-set', id: 'todo', config: { allowParallelInProgress: secret } },
      env,
    );
    expect(error).toBeInstanceOf(PluginChangeRejected);
    expect((error as Error).message).toContain('"todo"');
    expect(readFileSync(journalPathOf(dir), 'utf8')).not.toContain(secret);
  });

  it('連續被拒絕兩次：各佔一個序號，序號從 1 連續，之後的正常變更接在後面', async () => {
    const { dir, env } = home();
    await reject({ op: 'disable', id: 'no-such-row' }, env);
    await reject({ op: 'disable', id: 'browser-session' }, env);
    const ok = await changePlugin({ op: 'disable', id: 'todo' }, { env });
    expect(ok.record?.seq).toBe(3);
    const records = readJournal(journalPathOf(dir))?.records ?? [];
    expect(records.map((entry) => `${String(entry.seq)}:${entry.op}`)).toEqual([
      '1:rejected',
      '2:rejected',
      '3:disable',
    ]);
  });

  it('id 是空字串：照樣記，不被 schema 吞掉', async () => {
    const { dir, env } = home();
    const error = await reject({ op: 'disable', id: '' }, env);
    expect(error).toBeInstanceOf(PluginChangeRejected);
    expect(readJournal(journalPathOf(dir))?.records[0]).toMatchObject({
      op: 'rejected',
      id: '',
      requested: 'disable',
    });
  });

  it('沒有改變任何東西（已經是那個狀態）不是拒絕：紀錄逐位元組不變（#1414 驗收 B）', async () => {
    const { dir, env } = home();
    await changePlugin({ op: 'disable', id: 'todo' }, { env });
    const bytes = readFileSync(journalPathOf(dir));
    const result = await changePlugin({ op: 'disable', id: 'todo' }, { env });
    expect(result.outcome).toBe('unchanged');
    expect(readFileSync(journalPathOf(dir)).equals(bytes)).toBe(true);
  });

  it('紀錄壞了（還沒進到驗證）：不在壞掉的檔後面追加，也不記', async () => {
    const { dir, env } = home();
    await changePlugin({ op: 'disable', id: 'skills' }, { env });
    writeJournalText(dir, `${readFileSync(journalPathOf(dir), 'utf8')}not json\n`);
    const bytes = readFileSync(journalPathOf(dir));
    const error = await reject({ op: 'disable', id: 'no-such-row' }, env);
    expect(error).toBeDefined();
    expect(error).not.toBeInstanceOf(PluginChangeRejected);
    expect(readFileSync(journalPathOf(dir)).equals(bytes)).toBe(true);
  });
});

describe('被 --patch 蓋掉（Q2，照 dsh 的兩種處置）', () => {
  function overlay(dir: string, body: string): string {
    const path = join(dir, 'overlay.yml');
    writeFileSync(path, body);
    chmodSync(path, 0o600);
    return path;
  }

  it('開關：照寫、回報 overridden', async () => {
    const { dir, env } = home();
    const path = overlay(dir, '- id: todo\n  disabled: false\n');
    const result = await changePlugin({ op: 'disable', id: 'todo' }, { env, patches: [path] });
    expect(result).toMatchObject({ outcome: 'recorded', effect: 'overridden' });
    expect(result.warnings.join('\n')).toContain('被 --patch 蓋掉');
    // 紀錄真的寫了。
    expect(readJournal(journalPathOf(dir))?.records).toHaveLength(1);
  });

  it('設定：寫入前就拒絕，記成一筆 rejected', async () => {
    const { dir, env } = home();
    // 出貨值是 true；--patch 把它釘成 false，所以想寫 true 以外的值都會被它蓋掉。
    const path = overlay(dir, '- id: todo\n  config:\n    allowParallelInProgress: false\n');
    await changePlugin({ op: 'disable', id: 'skills' }, { env, patches: [path] });
    const error = await reject(
      { op: 'config-set', id: 'todo', config: { allowParallelInProgress: 'x' } },
      env,
      [path],
    );
    expect(error).toBeInstanceOf(PluginChangeRejected);
    expect((error as Error).message).toContain('被 --patch 蓋掉');
    expect(readJournal(journalPathOf(dir))?.records.map((entry) => entry.op)).toEqual([
      'disable',
      'rejected',
    ]);
  });
});

describe('誰、寫到哪（加 4、加 5）', () => {
  it('sudo 前的帳號標成自報，註明取自哪個環境變數；有效帳號是作業系統給的', () => {
    expect(hostActor({ SUDO_USER: 'alice', LOGNAME: 'root' }, () => 'svc')).toEqual({
      kind: 'host-account',
      effective: 'svc',
      invoker: 'alice',
      invokerSource: 'SUDO_USER',
    });
    expect(hostActor({ LOGNAME: 'bob' }, () => 'bob')).toMatchObject({
      invoker: 'bob',
      invokerSource: 'LOGNAME',
    });
    expect(hostActor({}, () => 'svc')).toEqual({
      kind: 'host-account',
      effective: 'svc',
      invoker: null,
      invokerSource: null,
    });
  });

  it('那個 home 沒有 plugin-snapshot.json：警告但不擋；有的話不警告', async () => {
    const { dir, env } = home();
    const first = await changePlugin({ op: 'disable', id: 'todo' }, { env });
    expect(first.outcome).toBe('recorded');
    expect(first.snapshotPresent).toBe(false);
    expect(first.warnings.join('\n')).toContain('plugin-snapshot.json');
    expect(first.warnings.join('\n')).toContain(dir);

    writeFileSync(join(dir, PLUGIN_SNAPSHOT_FILE_NAME), '{}\n');
    const second = await changePlugin({ op: 'enable', id: 'todo' }, { env });
    expect(second.snapshotPresent).toBe(true);
    expect(second.warnings.join('\n')).not.toContain('plugin-snapshot.json');
  });

  it.each(['sandbox-policy', 'permission-presets'])(
    '停用 %s：警告「有 --workspace 時之後每條新 thread 都建不起來」，照寫',
    async (id) => {
      const { env } = home();
      const result = await changePlugin({ op: 'disable', id }, { env });
      expect(result.outcome).toBe('recorded');
      expect(result.warnings.join('\n')).toContain('--workspace');
      expect(result.warnings.join('\n')).toContain('建不起來');
    },
  );
});

describe('兩個寫入口同時寫（驗收 F）', () => {
  it('四個行程內的寫入同時進來：四筆都在、序號嚴格遞增', async () => {
    const { dir, env } = home();
    const ids = ['todo', 'skills', 'plan-mode', 'feedback'];
    await Promise.all(ids.map((id) => changePlugin({ op: 'disable', id }, { env })));
    const records = readJournal(journalPathOf(dir))?.records ?? [];
    expect(records.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
    expect(new Set(records.map((entry) => ('id' in entry ? entry.id : ''))).size).toBe(4);
  });
});

describe('重播（驗收 I）', () => {
  it('從空的紀錄一筆一筆折，每一步的結果都跟那一刻 serve 用的清單相同', async () => {
    const { dir, env } = home();
    const steps: PluginChange[] = [
      { op: 'disable', id: 'todo' },
      { op: 'config-set', id: 'recursion-limit', config: { limit: 9 } },
      { op: 'enable', id: 'todo' },
      { op: 'config-set', id: 'recursion-limit', config: { limit: 11 } },
      { op: 'disable', id: 'skills' },
      { op: 'config-reset', id: 'recursion-limit' },
    ];
    const text = (): string => readFileSync(journalPathOf(dir), 'utf8');
    for (const [index, step] of steps.entries()) {
      await changePlugin(step, { env });
      const live = composeEntries(defaultSources({ serve: true, env, warn: () => undefined }));
      // 另一個 home：只有前 index+1 行，等於「從空的一筆一筆折」。
      const replay = home();
      const prefix = text()
        .split('\n')
        .slice(0, index + 1)
        .join('\n');
      writeJournalText(replay.dir, `${prefix}\n`);
      const replayed = composeEntries(
        defaultSources({ serve: true, env: replay.env, warn: () => undefined }),
      );
      expect(replayed).toEqual(live);
    }
  });
});
