/**
 * 變更紀錄的測試夾具（[#1412](https://github.com/DemianLi/nexus-agent/issues/1412)）。
 *
 * 測試要的是「home 底下有某一份設定」，不是「第一次啟動時遷移」（那一條有專門的測試，`plugin-journal.test.ts`）。
 * 所以預先放設定的測試走 {@link seedHomePatch}：把那份 patch YAML 解析之後直接寫成紀錄檔，跟遷移的結果一樣、但沒有
 * 遷移那一行通知，也不必先起一次。之後要改設定的測試走真的寫入口（`plugin-change.ts`）；要寫「寫入口不會放行」的壞狀態
 * （驗證之後才壞掉的設定、被人手動改壞的紀錄）走 {@link appendRaw} 或 {@link writeJournalText}。
 */

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parsePatchList } from './plugin-config.js';
import { appendJournalRecord, PLUGIN_JOURNAL_FILE_NAME } from './plugin-journal.js';
import type { JournalActor, JournalBody, JournalRecord } from './plugin-journal.js';

/** 紀錄檔在 `home` 底下的路徑。 */
export function journalPathOf(home: string): string {
  return join(home, PLUGIN_JOURNAL_FILE_NAME);
}

/** 假裝跑過一次遷移：把 patch YAML 寫成紀錄檔（actor 是遷移），不留舊檔。 */
export function seedHomePatch(home: string, yaml: string): void {
  const source = join(home, 'cordis.patch.yml');
  const actor: JournalActor = {
    kind: 'migration',
    source,
    sha256: createHash('sha256').update(yaml).digest('hex'),
  };
  const records: JournalRecord[] = parsePatchList(yaml, source).map((patch, index) => ({
    v: 1,
    seq: index + 1,
    at: '2026-10-13T00:00:00.000Z',
    actor,
    op: 'patch',
    patch: patch as Record<string, unknown>,
  }));
  writeJournalText(home, records.map((record) => `${JSON.stringify(record)}\n`).join(''));
}

/** 整份換掉紀錄檔的內容（0600）。 */
export function writeJournalText(home: string, text: string): void {
  const path = journalPathOf(home);
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** 讀紀錄檔全文；不在回空字串。 */
export function readJournalText(home: string): string {
  const path = journalPathOf(home);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** 不經驗證追加一筆（測試要寫寫入口不會放行的狀態）。 */
export async function appendRaw(home: string, body: JournalBody): Promise<JournalRecord> {
  const record = await appendJournalRecord(
    journalPathOf(home),
    {
      actor: { kind: 'host-account', effective: 'test', invoker: null, invokerSource: null },
      now: () => new Date('2026-10-13T00:00:01.000Z'),
    },
    () => body,
  );
  if (record === undefined) throw new Error('appendRaw 沒有寫進去');
  return record;
}
