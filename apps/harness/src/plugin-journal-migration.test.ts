/**
 * 第一次啟動時把 home 的 `cordis.patch.yml` 遷進變更紀錄（[#1412](https://github.com/DemianLi/nexus-agent/issues/1412)
 * Q2、加 1、加 3、加 8，與 PM 2026-10-13 加的兩條）。驗收表 E。
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { HARNESS_HOME_ENV } from './harness-home.js';
import {
  loadDefaultPlugins,
  PluginConfigError,
  prepareJournal,
  renderLayeredConfigDump,
  USER_PATCH_FILENAME,
} from './plugin-config.js';
import { readJournal } from './plugin-journal.js';
import { journalPathOf } from './plugin-journal.fixture.js';

const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) {
    if (existsSync(dir)) chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

function home(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-journal-migrate-'));
  chmodSync(dir, 0o700);
  temporary.push(dir);
  return { dir, env: { [HARNESS_HOME_ENV]: dir } };
}

function legacy(dir: string, body: string, mode = 0o600): string {
  const path = join(dir, USER_PATCH_FILENAME);
  writeFileSync(path, body);
  chmodSync(path, mode);
  return path;
}

function migratedFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.startsWith(`${USER_PATCH_FILENAME}.migrated-`));
}

/** 一顆放在 home 底下、以相對路徑 insert 進來的外掛，它掛上時在見證檔記一筆。 */
function probeModule(dir: string): void {
  mkdirSync(join(dir, 'plugins', 'probe'), { recursive: true });
  const module = join(dir, 'plugins', 'probe', 'index.ts');
  writeFileSync(module, "export default { name: 'probe', apply() {} };\n");
  chmodSync(module, 0o600);
  chmodSync(join(dir, 'plugins'), 0o700);
  chmodSync(join(dir, 'plugins', 'probe'), 0o700);
}

describe('第一次啟動遷移', () => {
  it('createWhenAbsent: false（一次性 CLI）：沒有舊檔就什麼都不寫，連 home 目錄都不建；有舊檔照遷', async () => {
    const { dir, env } = home();
    const missing = join(dir, 'not-yet');
    const absent = await prepareJournal({
      env: { [HARNESS_HOME_ENV]: missing },
      createWhenAbsent: false,
    });
    expect(absent.status).toBe('absent');
    expect(existsSync(missing)).toBe(false);

    legacy(dir, '- id: todo\n  disabled: true\n');
    const migrated = await prepareJournal({ env, createWhenAbsent: false });
    expect(migrated).toMatchObject({ status: 'migrated', migrated: 1 });
  });

  it('每條 patch 一筆、actor 是遷移（帶來源與雜湊）；舊檔改名成 .migrated-<時間>、0600', async () => {
    const { dir, env } = home();
    const body = '- id: todo\n  disabled: true\n- id: goal\n  config:\n    a: 1\n';
    // 原本的權限不一定是 0600：群組可讀但不可寫是 `assertPrivateFile` 放行的。
    const path = legacy(dir, body, 0o640);

    const result = await prepareJournal({ env, now: () => new Date('2026-10-13T01:02:03.456Z') });
    expect(result).toMatchObject({ status: 'migrated', migrated: 2 });

    const contents = readJournal(journalPathOf(dir));
    expect(contents?.records.map((entry) => entry.op)).toEqual(['patch', 'patch']);
    expect(contents?.records[0]).toMatchObject({
      seq: 1,
      at: '2026-10-13T01:02:03.456Z',
      actor: { kind: 'migration', source: path, sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) },
      patch: { id: 'todo', disabled: true },
    });

    expect(existsSync(path)).toBe(false);
    const [renamed] = migratedFiles(dir);
    expect(renamed).toBeDefined();
    // 加 8：舊檔裡同樣有秘密，改名時一併設成 0600。
    expect(statSync(join(dir, renamed ?? '')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, renamed ?? ''), 'utf8')).toBe(body);
    expect(statSync(journalPathOf(dir)).mode & 0o777).toBe(0o600);

    // 遷移前後清單一樣：舊檔不在了，這一層從紀錄來。
    const loaded = await loadDefaultPlugins({ env });
    const todo = loaded.entries.find((entry) => entry.id === 'todo');
    expect(todo?.disabled).toBe(true);
    expect(loaded.layers.journal).toMatchObject({ exists: true, records: 2, lastSeq: 2 });
    expect(loaded.layers.journal?.ignoredLegacyPatch).toBeUndefined();
  });

  it('相對路徑的 insert：遷移時換成絕對路徑，檔案改名之後那顆照樣載得到', async () => {
    const { dir, env } = home();
    probeModule(dir);
    legacy(dir, "- insert:\n    - id: probe\n      name: './plugins/probe/index.ts'\n");

    await prepareJournal({ env });
    const [first] = readJournal(journalPathOf(dir))?.records ?? [];
    const patch = first && first.op === 'patch' ? first.patch : undefined;
    const name = (patch?.['insert'] as { name: string }[] | undefined)?.[0]?.name;
    // 絕對的 file URL，不再以 patch 檔所在位置為基準。
    expect(name).toMatch(/^file:\/\/\/.*\/plugins\/probe\/index\.ts$/u);

    const loaded = await loadDefaultPlugins({ env });
    const row = loaded.entries.find((entry) => entry.id === 'probe');
    expect(row?.name).toBe(name);
    expect(loaded.dropped.find((drop) => drop.id === 'probe')).toBeUndefined();
    const mounted = [...loaded.rows.values()].some((entry) => entry.id === 'probe');
    expect(mounted).toBe(true);
  });

  it('遷移之後又出現 cordis.patch.yml：警告、不讀、不自動再遷，紀錄逐位元組不變', async () => {
    const { dir, env } = home();
    legacy(dir, '- id: todo\n  disabled: true\n');
    await prepareJournal({ env });
    const journalBefore = readFileSync(journalPathOf(dir));

    const planted = legacy(dir, '- id: goal\n  disabled: true\n- id: skills\n  disabled: true\n');
    const warnings: string[] = [];
    const again = await prepareJournal({ env });
    expect(again.status).toBe('present');

    const loaded = await loadDefaultPlugins({ env, warn: (message) => warnings.push(message) });
    // 不讀：goal 沒被停用；紀錄裡原本的 todo 還是停用。
    expect(loaded.entries.find((entry) => entry.id === 'goal')?.disabled).not.toBe(true);
    expect(loaded.entries.find((entry) => entry.id === 'todo')?.disabled).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(planted);
    expect(warnings[0]).toContain('沒讀');
    expect(loaded.layers.journal?.ignoredLegacyPatch).toBe(planted);

    // 不自動再遷：紀錄沒變、檔案還在原地、沒有第二份 .migrated。
    expect(readFileSync(journalPathOf(dir)).equals(journalBefore)).toBe(true);
    expect(existsSync(planted)).toBe(true);
    expect(migratedFiles(dir)).toHaveLength(1);

    // `--dump-config` 印的樹也沒有它。
    expect(renderLayeredConfigDump({ env, warn: () => undefined })).not.toMatch(
      /id: goal\n\s+disabled: true/u,
    );
  });

  it('從來沒有 patch 的新 home：第一次啟動建空的紀錄檔當界線，之後丟進來的檔一樣只警告', async () => {
    const { dir, env } = home();
    expect(await prepareJournal({ env })).toMatchObject({ status: 'created' });
    expect(statSync(journalPathOf(dir)).size).toBe(0);

    const planted = legacy(dir, '- id: todo\n  disabled: true\n');
    expect(await prepareJournal({ env })).toMatchObject({ status: 'present' });
    const warnings: string[] = [];
    const loaded = await loadDefaultPlugins({ env, warn: (message) => warnings.push(message) });
    expect(loaded.entries.find((entry) => entry.id === 'todo')?.disabled).not.toBe(true);
    expect(warnings).toHaveLength(1);
    expect(existsSync(planted)).toBe(true);
  });

  it('還沒起過、紀錄檔不在：舊檔照遷移前的行為被讀（待遷移），--dump-config 看得到', async () => {
    const { dir, env } = home();
    legacy(dir, '- id: todo\n  disabled: true\n');
    const loaded = await loadDefaultPlugins({ env });
    expect(loaded.entries.find((entry) => entry.id === 'todo')?.disabled).toBe(true);
    expect(loaded.layers.journal).toMatchObject({ exists: false, pendingMigration: true });
    // 只讀不遷：沒有建紀錄檔，舊檔還在。
    expect(existsSync(journalPathOf(dir))).toBe(false);
    expect(existsSync(join(dir, USER_PATCH_FILENAME))).toBe(true);
  });
});

describe('兩步之間當掉：紀錄先落盤、舊檔最後才改名（PM 2026-10-13）', () => {
  it('紀錄 rename 進位之後、舊檔改名之前失敗：下次啟動走「警告、不讀」，不重複遷也不漏', async () => {
    const { dir, env } = home();
    const path = legacy(dir, '- id: todo\n  disabled: true\n- id: goal\n  disabled: true\n');
    const warnings: string[] = [];

    const first = await prepareJournal({
      env,
      warn: (message) => warnings.push(message),
      afterJournalWritten: () => {
        throw new Error('注入：兩步之間當掉');
      },
    });
    expect(first.status).toBe('unavailable');
    expect(warnings.join('\n')).toContain('內容已經遷進');
    // 舊檔沒被改名；紀錄已在、內容完整。
    expect(existsSync(path)).toBe(true);
    expect(migratedFiles(dir)).toHaveLength(0);
    expect(readJournal(journalPathOf(dir))?.records).toHaveLength(2);

    // 下次啟動：紀錄在、舊檔還在 → 警告、不讀；不重複遷（筆數不變）、不漏（改動在紀錄裡）。
    const second = await prepareJournal({ env });
    expect(second.status).toBe('present');
    expect(readJournal(journalPathOf(dir))?.records).toHaveLength(2);
    const loadWarnings: string[] = [];
    const loaded = await loadDefaultPlugins({ env, warn: (message) => loadWarnings.push(message) });
    expect(loaded.entries.find((entry) => entry.id === 'todo')?.disabled).toBe(true);
    expect(loaded.entries.find((entry) => entry.id === 'goal')?.disabled).toBe(true);
    expect(loadWarnings).toHaveLength(1);
    expect(loadWarnings[0]).toContain('沒讀');
    expect(existsSync(path)).toBe(true);
  });

  it('寫紀錄那一步就失敗（紀錄檔不在）：舊檔照舊被讀，改動不漏，下次再試', async () => {
    const { dir, env } = home();
    legacy(dir, '- id: todo\n  disabled: true\n');
    // home 唯讀：建不出紀錄檔與鎖檔。
    chmodSync(dir, 0o500);
    const probeWritable = (): boolean => {
      try {
        writeFileSync(join(dir, '.probe'), '');
        rmSync(join(dir, '.probe'));
        return true;
      } catch {
        return false;
      }
    };
    if (probeWritable()) return; // root：唯讀擋不住，這一條在那種環境沒有意義。
    const warnings: string[] = [];
    const result = await prepareJournal({ env, warn: (message) => warnings.push(message) });
    expect(result.status).toBe('unavailable');
    expect(warnings.join('\n')).toContain('照舊當這一層讀');
    const loaded = await loadDefaultPlugins({ env });
    expect(loaded.entries.find((entry) => entry.id === 'todo')?.disabled).toBe(true);
    chmodSync(dir, 0o700);
    expect(await prepareJournal({ env })).toMatchObject({ status: 'migrated', migrated: 1 });
  });
});

describe('同時第一次啟動', () => {
  it('六個同時進來：只有一個遷，其餘看到 present；紀錄筆數等於 patch 條數（沒有遷兩次）', async () => {
    const { dir, env } = home();
    legacy(
      dir,
      '- id: todo\n  disabled: true\n- id: goal\n  disabled: true\n- id: skills\n  disabled: true\n',
    );
    const results = await Promise.all(Array.from({ length: 6 }, () => prepareJournal({ env })));
    expect(results.filter((entry) => entry.status === 'migrated')).toHaveLength(1);
    expect(results.filter((entry) => entry.status === 'present')).toHaveLength(5);
    expect(readJournal(journalPathOf(dir))?.records).toHaveLength(3);
    expect(migratedFiles(dir)).toHaveLength(1);
  });
});

describe('舊檔壞了', () => {
  it('YAML 壞掉：照舊整個拋，指名那個檔；沒建紀錄檔、舊檔不動', async () => {
    const { dir, env } = home();
    const path = legacy(dir, '- id: [這不是 YAML\n');
    await expect(prepareJournal({ env })).rejects.toThrow(PluginConfigError);
    await expect(prepareJournal({ env })).rejects.toThrow(/cordis\.patch\.yml/u);
    expect(existsSync(journalPathOf(dir))).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe('- id: [這不是 YAML\n');
  });

  it('別人寫得動的舊檔：權限被拒，照舊起不來', async () => {
    const { dir, env } = home();
    legacy(dir, '[]\n', 0o666);
    await expect(prepareJournal({ env })).rejects.toThrow(/群組或其他人可寫/u);
    expect(existsSync(journalPathOf(dir))).toBe(false);
  });

  it('紀錄檔被別人動得了：讀端拒絕（跟舊的 patch 檔同一條理由）', async () => {
    const { dir, env } = home();
    await prepareJournal({ env });
    chmodSync(journalPathOf(dir), 0o666);
    await expect(loadDefaultPlugins({ env })).rejects.toThrow(/變更紀錄.*群組或其他人可寫/u);
  });
});

describe('搬家', () => {
  it('把整個 home 搬到別的路徑：遷移來的絕對 file URL 指回原位，不會靜靜載錯', async () => {
    // insert 的模組絕對路徑不跟著 home 走：這是「遷移時換成絕對路徑」的已知代價，由 operations.md 說明。
    const { dir, env } = home();
    probeModule(dir);
    legacy(dir, "- insert:\n    - id: probe\n      name: './plugins/probe/index.ts'\n");
    await prepareJournal({ env });
    const moved = `${dir}-moved`;
    temporary.push(moved);
    renameSync(dir, moved);
    const loaded = await loadDefaultPlugins({ env: { [HARNESS_HOME_ENV]: moved } });
    // 模組載不進來 → 那一列掉了，訊息指名它，不是載到別的東西。
    expect(loaded.dropped.find((drop) => drop.id === 'probe')?.stage).toBe('module');
  });
});
