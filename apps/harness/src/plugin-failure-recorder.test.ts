/**
 * serve 記 `failed` 的那一支（[#1414](https://github.com/DemianLi/nexus-agent/issues/1414)）：不建檔、去重鍵、
 * 一筆 patch 讓好幾列掛不上、跨行程只記一次、等鎖上限、不 reject。
 *
 * 量具是 `plugin-failure-recorder.ts` 本身，不起 serve：serve 那一側（三個發現點、必掛的列起不來之前先寫）在
 * `serve-plugin-failed-record.test.ts`。
 */

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createFailureRecorder } from './plugin-failure-recorder.js';
import type { FailedRow } from './plugin-failure-recorder.js';
import { journalPathOf, readJournalText, seedHomePatch } from './plugin-journal.fixture.js';
import { readJournal } from './plugin-journal.js';
import type { JournalRecord } from './plugin-journal.js';

const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-failure-recorder-'));
  chmodSync(dir, 0o700);
  temporary.push(dir);
  return dir;
}

function row(id: string, module = `@nexus/plugin-${id}`, message = `${id} 掛上時失敗`): FailedRow {
  return { id, module, stage: 'apply', message };
}

function recorderOf(dir: string, lines: string[] = [], waitMs?: number) {
  return createFailureRecorder({
    path: journalPathOf(dir),
    effective: 'svc',
    log: (line) => lines.push(line),
    ...(waitMs !== undefined && { waitMs }),
  });
}

function failedOf(dir: string): JournalRecord[] {
  return (readJournal(journalPathOf(dir))?.records ?? []).filter((entry) => entry.op === 'failed');
}

const TODO_DISABLED = '- id: todo\n  config:\n    allowParallelInProgress: false\n';

describe('不建檔、不多話', () => {
  it('紀錄檔不在：什麼都不寫、不建檔、不建鎖檔、一行日誌都不出', async () => {
    const dir = home();
    const lines: string[] = [];
    const recorder = recorderOf(dir, lines);
    recorder.note([row('todo')], 'startup');
    await recorder.flush();
    expect(existsSync(journalPathOf(dir))).toBe(false);
    expect(existsSync(`${journalPathOf(dir)}.lock`)).toBe(false);
    expect(lines).toEqual([]);
  });

  it('紀錄裡沒有任何一筆指到那一列（只被出貨設定或 --patch 影響）：紀錄逐位元組不變、沒有日誌', async () => {
    const dir = home();
    seedHomePatch(dir, '- id: skills\n  disabled: true\n');
    const bytes = readFileSync(journalPathOf(dir));
    const lines: string[] = [];
    const recorder = recorderOf(dir, lines);
    recorder.note([row('todo')], 'reread');
    await recorder.flush();
    expect(readFileSync(journalPathOf(dir)).equals(bytes)).toBe(true);
    expect(lines).toEqual([]);
  });
});

describe('記一筆 failed（驗收 C、D）', () => {
  it('帶觸發那一筆的 seq、stage、原因原文；actor 是 serve 與有效帳號；日誌不帶原因', async () => {
    const dir = home();
    seedHomePatch(dir, TODO_DISABLED);
    const lines: string[] = [];
    const recorder = recorderOf(dir, lines);
    recorder.note(
      [row('todo', '@nexus/plugin-todo', '密碼是 hunter2-不該進日誌')],
      'thread-assembly',
    );
    await recorder.flush();
    const [entry, ...rest] = failedOf(dir);
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({
      op: 'failed',
      seq: 2,
      id: 'todo',
      triggerSeq: 1,
      stage: 'apply',
      reason: '密碼是 hunter2-不該進日誌',
      actor: { kind: 'serve', effective: 'svc' },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('第 2 筆 failed');
    expect(lines[0]).not.toContain('hunter2');
  });

  it('同一次改動只記一次：再通知十次、換一支記錄器（等於重啟）也不再多記', async () => {
    const dir = home();
    seedHomePatch(dir, TODO_DISABLED);
    const first = recorderOf(dir);
    for (let index = 0; index < 10; index += 1) first.note([row('todo')], 'thread-assembly');
    await first.flush();
    const restarted = recorderOf(dir);
    restarted.note([row('todo')], 'startup');
    await restarted.flush();
    expect(failedOf(dir)).toHaveLength(1);
  });

  it('那一列又被改了一次（新的 seq）又掛不上：多記一筆，指向新的 seq', async () => {
    const dir = home();
    seedHomePatch(dir, TODO_DISABLED);
    const recorder = recorderOf(dir);
    recorder.note([row('todo')], 'reread');
    await recorder.flush();
    // 之後有人又改了這一列（直接追加，等同寫入口寫的一筆 config-set）。
    const path = journalPathOf(dir);
    const changed = {
      v: 1,
      seq: 3,
      at: '2026-10-13T00:00:02.000Z',
      actor: { kind: 'host-account', effective: 'op', invoker: null, invokerSource: null },
      op: 'config-set',
      id: 'todo',
      name: '@nexus/plugin-todo',
      before: null,
      after: { allowParallelInProgress: false, extra: 1 },
    };
    writeFileSync(path, `${readJournalText(dir)}${JSON.stringify(changed)}\n`, { mode: 0o600 });
    recorder.note([row('todo')], 'reread');
    await recorder.flush();
    expect(failedOf(dir).map((entry) => entry.op === 'failed' && entry.triggerSeq)).toEqual([1, 3]);
  });

  it('一筆 insert 同時讓好幾列掛不上：每一列各記一筆，帶同一個 triggerSeq（PM：鍵是列 id 加 seq）', async () => {
    const dir = home();
    seedHomePatch(
      dir,
      [
        '- insert:',
        '    - id: probe-a',
        "      name: './a.ts'",
        '    - id: probe-b',
        "      name: './b.ts'",
        '    - name: ./anon.ts',
      ].join('\n'),
    );
    const recorder = recorderOf(dir);
    recorder.note(
      [
        row('probe-a', 'file:///x/a.ts'),
        row('probe-b', 'file:///x/b.ts'),
        row('probe-b', 'file:///x/b.ts'),
      ],
      'startup',
    );
    await recorder.flush();
    const failed = failedOf(dir);
    expect(failed.map((entry) => entry.op === 'failed' && [entry.id, entry.triggerSeq])).toEqual([
      ['probe-a', 1],
      ['probe-b', 1],
    ]);
  });
});

describe('並發與等鎖', () => {
  it('兩個 serve 同時看到同一件事：鎖裡再查一次，只記一筆', async () => {
    const dir = home();
    seedHomePatch(dir, TODO_DISABLED);
    const one = recorderOf(dir);
    const two = recorderOf(dir);
    one.note([row('todo')], 'reread');
    two.note([row('todo')], 'reread');
    await Promise.all([one.flush(), two.flush()]);
    expect(failedOf(dir)).toHaveLength(1);
    expect((readJournal(journalPathOf(dir))?.records ?? []).map((entry) => entry.seq)).toEqual([
      1, 2,
    ]);
  });

  it('鎖被別人拿著：不超過上限就放棄，日誌記一句沒寫成（同一件事只講一次），不 reject', async () => {
    const dir = home();
    seedHomePatch(dir, TODO_DISABLED);
    // 一個活著的持有者：自己的 PID（接手只接「行程已不在」的）。
    const lock = `${journalPathOf(dir)}.lock`;
    writeFileSync(lock, `${String(process.pid)}\n`, { mode: 0o600 });
    const lines: string[] = [];
    const recorder = recorderOf(dir, lines, 300);
    const started = Date.now();
    recorder.note([row('todo')], 'thread-assembly');
    recorder.note([row('todo')], 'thread-assembly');
    await expect(recorder.flush()).resolves.toBeUndefined();
    // 兩次通知各等 300 毫秒上限；絕不是寫入口的 30 秒。
    expect(Date.now() - started).toBeLessThan(5000);
    expect(failedOf(dir)).toHaveLength(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('沒寫成');
    expect(lines[0]).toContain('todo');
    expect(lines[0]).not.toContain('掛上時失敗');
    // 鎖放開之後，下一次通知就寫得進去。
    rmSync(lock);
    recorder.note([row('todo')], 'thread-assembly');
    await recorder.flush();
    expect(failedOf(dir)).toHaveLength(1);
  });

  it('預設等鎖上限是 dsh 的 2 秒', async () => {
    const dir = home();
    seedHomePatch(dir, TODO_DISABLED);
    const lock = `${journalPathOf(dir)}.lock`;
    writeFileSync(lock, `${String(process.pid)}\n`, { mode: 0o600 });
    const lines: string[] = [];
    const recorder = recorderOf(dir, lines);
    const started = Date.now();
    recorder.note([row('todo')], 'startup');
    await recorder.flush();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(1500);
    expect(elapsed).toBeLessThan(6000);
    expect(lines.join('\n')).toContain('沒寫成');
  });

  it('紀錄壞了：不 reject、不多講（讀清單那一步已經拋過）', async () => {
    const dir = home();
    seedHomePatch(dir, TODO_DISABLED);
    writeFileSync(journalPathOf(dir), `${readJournalText(dir)}not json\n`, { mode: 0o600 });
    const lines: string[] = [];
    const recorder = recorderOf(dir, lines);
    recorder.note([row('todo')], 'reread');
    await expect(recorder.flush()).resolves.toBeUndefined();
    expect(lines).toEqual([]);
  });
});
