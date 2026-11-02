/**
 * harness home 底下啟動時會讀的狀態檔，**v1 磁碟格式的封存夾具**，用今天出貨的讀取函式讀回
 * （[#1507](https://github.com/DemianLi/nexus-agent/issues/1507)，C126）。
 *
 * ## 規則（照 dsh `packages/session/session-projection-cache/README.zh.md:130`）
 *
 * 改這幾份檔的 schema 或版本時，**同一張 PR 要留著這份 v1 夾具**，並在旁邊的測試證明 v1 怎麼處置：讀相容、照當前版本重寫，
 * 或 backup-and-skip。就算選擇直接丟掉舊記錄，也要證明不會讓啟動失敗。dsh 的 backup-and-skip 只給可以丟掉的衍生資料
 * （`storage-domain/src/spec.ts:57-67`）；這幾份都是權威狀態，今天的處置全是「讀相容」，認不得的就大聲失敗、不覆寫。
 *
 * | 檔 | 出貨的讀取函式 | v1 的處置 |
 * | --- | --- | --- |
 * | `thread-organization.json` | `ThreadOrganization.open` | 讀相容，內容原樣 |
 * | `browser-session.json` | `loadOrCreateBrowserSessionSecret` | 讀相容，不覆寫 |
 * | `config-hash-key.json` | `loadConfigHashKey` | 讀相容，不覆寫 |
 * | `.credentials.yaml` | `createCredentialService().check()` | 讀相容，內容原樣 |
 * | `plugin-journal.jsonl` | `readJournal` ＋ `foldJournal` | 讀相容，每一種 `op` 至少一行 |
 *
 * 夾具在 `fixtures/home-state/v1/`，檔名同它們在 home 底下的名字；值都是假的（密鑰是 0..31、32..63 的位元組）。
 * 每份複製到暫存 home 再讀（權限 0600），夾具本身不會被動到。
 *
 * 之後要加 v2 時：新增 `fixtures/home-state/v2/`，**不動 v1**，這支測試對 v1 的斷言繼續留著。
 */

import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadOrCreateBrowserSessionSecret } from './browser-session-secret.js';
import { CREDENTIALS_FILE, createCredentialService } from './credentials.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { loadLaunchEnv } from './launch-env.js';
import {
  foldJournal,
  journalRecordSchema,
  PLUGIN_JOURNAL_FILE_NAME,
  readJournal,
} from './plugin-journal.js';
import type { JournalRecord } from './plugin-journal.js';
import { CONFIG_HASH_KEY_FILE, loadConfigHashKey } from './session-header-metadata.js';
import { THREAD_ORGANIZATION_FILE, ThreadOrganization } from './thread-organization.js';
import { assertOwnerOnlyMode } from './owner-only.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/home-state/v1/', import.meta.url));

let root: string;
let home: string;

/** 把整份 v1 夾具複製進暫存 home，每個檔 0600。 */
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'home-state-v1-'));
  home = join(root, 'home');
  mkdirSync(home, { mode: 0o700 });
  cpSync(FIXTURES, home, { recursive: true });
  for (const name of readdirSync(home)) chmodSync(join(home, name), 0o600);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const fixtureText = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');
const homeText = (name: string): string => readFileSync(join(home, name), 'utf8');

describe('home 狀態檔 v1 夾具', () => {
  it('夾具目錄剛好是這五份：多一份或少一份，都要在這裡有對應的讀回斷言', () => {
    expect(readdirSync(FIXTURES).sort()).toEqual(
      [
        CREDENTIALS_FILE,
        'browser-session.json',
        CONFIG_HASH_KEY_FILE,
        PLUGIN_JOURNAL_FILE_NAME,
        THREAD_ORGANIZATION_FILE,
      ].sort(),
    );
  });

  it('thread-organization.json：讀得回來，釘選與封存各是夾具裡寫的那幾筆，檔案不動', async () => {
    const organization = await ThreadOrganization.open(home);
    expect(organization.pinnedThreadIds).toEqual(['thread-pin-b', 'thread-pin-a']);
    expect(organization.archivedThreadIds).toEqual([
      'thread-archived-1',
      'thread-archived-2',
      'thread-archived-3',
    ]);
    expect(organization.isArchived('thread-archived-2')).toBe(true);
    expect(organization.isArchived('thread-pin-a')).toBe(false);
    expect(homeText(THREAD_ORGANIZATION_FILE)).toBe(fixtureText(THREAD_ORGANIZATION_FILE));
  });

  it('browser-session.json：讀的是夾具裡那一把（不是新建的），檔案不動', async () => {
    const secret = await loadOrCreateBrowserSessionSecret(home);
    expect([...secret]).toEqual([...Array(32).keys()]);
    expect(homeText('browser-session.json')).toBe(fixtureText('browser-session.json'));
  });

  it('config-hash-key.json：讀的是夾具裡那一把（不是新建的），檔案不動', async () => {
    const key = await loadConfigHashKey({ env: { [HARNESS_HOME_ENV]: home }, cwd: root });
    expect([...key]).toEqual([...Array(32).keys()].map((index) => index + 32));
    expect(homeText(CONFIG_HASH_KEY_FILE)).toBe(fixtureText(CONFIG_HASH_KEY_FILE));
  });

  it('.credentials.yaml：check 不拋，兩把 key 解得出夾具裡寫的值，沒有警告，檔案不動', () => {
    const warned: string[] = [];
    const launchEnv = loadLaunchEnv({ cwd: root, home, target: {}, warn: () => undefined });
    const credentials = createCredentialService({
      home,
      launchEnv,
      store: true,
      warn: (line) => warned.push(line),
    });
    expect(() => credentials.check()).not.toThrow();
    expect(credentials.resolve('NVIDIA_API_KEY')).toEqual({
      value: 'nvapi-fixture-not-a-real-key',
      source: 'file',
      path: join(home, CREDENTIALS_FILE),
    });
    expect(credentials.resolve('GATEWAY_KEY')?.value).toBe('fixture-gateway-not-a-real-key');
    expect(credentials.resolve('NOT_IN_THE_FILE')).toBeUndefined();
    expect(warned).toEqual([]);
    expect(homeText(CREDENTIALS_FILE)).toBe(fixtureText(CREDENTIALS_FILE));
  });

  describe('plugin-journal.jsonl', () => {
    const read = () =>
      readJournal(join(home, PLUGIN_JOURNAL_FILE_NAME), {
        check: (path) => assertOwnerOnlyMode('變更紀錄', path, 0o600),
      });

    it('讀得回來：每一行一筆、序號 1..N、沒有略過的尾巴，內容等於夾具裡寫的', () => {
      const contents = read();
      const written = fixtureText(PLUGIN_JOURNAL_FILE_NAME)
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line) as JournalRecord);
      expect(contents?.incompleteTail).toBe(false);
      expect(contents?.records).toEqual(written);
      expect(contents?.records.map((record) => record.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(homeText(PLUGIN_JOURNAL_FILE_NAME)).toBe(fixtureText(PLUGIN_JOURNAL_FILE_NAME));
    });

    it('每一種 op 至少一行：schema 多一種 op 而夾具沒有，這條紅', () => {
      const inSchema = journalRecordSchema.options.map((option) => option.shape.op.value).sort();
      const inFixture = [...new Set((read()?.records ?? []).map((record) => record.op))].sort();
      expect(inFixture).toEqual(inSchema);
      expect(inSchema).toEqual([
        'config-reset',
        'config-set',
        'disable',
        'enable',
        'failed',
        'patch',
        'rejected',
        'self-disabled',
      ]);
    });

    it('三種 actor 都有，折出來的清單是夾具寫的那一份（rejected／failed／self-disabled 不折）', () => {
      const records = read()?.records ?? [];
      expect(new Set(records.map((record) => record.actor.kind))).toEqual(
        new Set(['host-account', 'serve', 'migration']),
      );
      expect(foldJournal(records)).toEqual([{ id: 'todo', disabled: false }]);
    });
  });
});
