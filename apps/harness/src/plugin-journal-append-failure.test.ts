/**
 * 變更紀錄追加時寫滿整行、失敗截回寫前大小（[#1582](https://github.com/DemianLi/nexus-agent/issues/1582)，
 * 照 dsh `appendLines`／`rollbackAppend`）。
 *
 * 照 `jsonl-append-failure.test.ts`（#1506）的做法：只在「開紀錄檔」那一下包住把手。`writeFile` 在**包住的單次寫**之上
 * 迴圈寫到整行寫完，所以底層短寫對它無害；單次 `write` 就沒有這個保證，這正是短寫那條要分辨的。斷言一律回頭讀**檔案**
 * 與下一次追加：把手回報什麼不重要，下一個寫者讀得回來才重要。
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

/** 製造磁碟錯誤。除了 `shortWriteCap` 是持續的，其餘都是**一次性**的：用一次就清掉。 */
interface Fault {
  /** 底層每次寫最多寫這麼多位元組並回報短的計數、不拋錯（`write(2)` 空間不夠時的行為）。 */
  shortWriteCap?: number;
  /** 下一次 `writeFile` 寫了這麼多位元組之後拋 `ENOSPC`（殘留半行在檔裡）。 */
  writeThrowsAfter?: number;
  /** 追加把手的 `sync` 拋這個錯（寫已成功）。 */
  syncError?: Error;
  /** 截回用的 `r+` 把手的 `truncate` 拋這個錯。 */
  rollbackTruncateError?: Error;
  /** 截回用的 `r+` 把手上的 `sync` 次數；每次開紀錄檔的 flags。 */
  rollbackSyncs: number;
  opened: string[];
}

const state = vi.hoisted(() => ({ fault: undefined as Fault | undefined }));

function take<K extends keyof Fault>(fault: Fault, key: K): Fault[K] {
  const value = fault[key];
  delete fault[key];
  return value;
}

function enospc(): Error {
  return Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
}

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (path: string, flags?: string, mode?: number) => {
      const real = await actual.open(path, flags, mode);
      const fault = state.fault;
      if (fault === undefined || !String(path).endsWith('.jsonl')) return real;
      fault.opened.push(String(flags));
      const rollback = flags === 'r+';
      const writeSome = async (data: Buffer, offset: number, end: number): Promise<number> => {
        const cap = fault.shortWriteCap ?? end - offset;
        const { bytesWritten } = await real.write(data, offset, Math.min(cap, end - offset));
        return bytesWritten;
      };
      return new Proxy(real, {
        get(target, property) {
          if (property === 'write') {
            /** 單次寫、可能短寫、不補寫剩下的——`FileHandle.write` 的行為。只有被突變成這條路的產品碼才會呼叫。 */
            return async (data: string) => {
              const buffer = Buffer.from(data, 'utf8');
              return { bytesWritten: await writeSome(buffer, 0, buffer.length), buffer: data };
            };
          }
          if (property === 'writeFile') {
            return async (data: string) => {
              const buffer = Buffer.from(data, 'utf8');
              const failAfter = rollback ? undefined : take(fault, 'writeThrowsAfter');
              const end = failAfter ?? buffer.length;
              let offset = 0;
              while (offset < end) offset += await writeSome(buffer, offset, end);
              if (failAfter !== undefined) throw enospc();
            };
          }
          if (property === 'sync') {
            return async () => {
              if (rollback) fault.rollbackSyncs += 1;
              const error = rollback ? undefined : take(fault, 'syncError');
              if (error !== undefined) throw error;
              await target.sync();
            };
          }
          if (property === 'truncate') {
            return async (length?: number) => {
              const error = rollback ? take(fault, 'rollbackTruncateError') : undefined;
              if (error !== undefined) throw error;
              await target.truncate(length);
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === 'function'
            ? (value as (...a: unknown[]) => unknown).bind(target)
            : value;
        },
      }) as FileHandle;
    },
  };
});

const { appendJournalRecord, readJournal } = await import('./plugin-journal.js');
type JournalActor = import('./plugin-journal.js').JournalActor;
type JournalBody = import('./plugin-journal.js').JournalBody;

const ACTOR: JournalActor = {
  kind: 'host-account',
  effective: 'svc',
  invoker: 'alice',
  invokerSource: 'SUDO_USER',
};

const DISABLE_TODO: JournalBody = {
  op: 'disable',
  id: 'todo',
  name: '@nexus/plugin-todo',
  before: false,
  after: true,
};
const ENABLE_TODO = { ...DISABLE_TODO, op: 'enable', before: true, after: false } as JournalBody;

const temporary: string[] = [];
afterEach(() => {
  state.fault = undefined;
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

function journalPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'nexus-journal-append-'));
  chmodSync(root, 0o700);
  temporary.push(root);
  return join(root, 'j.jsonl');
}

function newFault(): Fault {
  const fault: Fault = { rollbackSyncs: 0, opened: [] };
  state.fault = fault;
  return fault;
}

/** 追加一筆；警告收進 `warnings`。 */
function append(path: string, warnings: string[], body: JournalBody = DISABLE_TODO) {
  return appendJournalRecord(
    path,
    { actor: ACTOR, warn: (message) => warnings.push(message) },
    () => body,
  );
}

const sizeOf = (path: string) => statSync(path).size;
const opsOf = (path: string) => readJournal(path)?.records.map((entry) => entry.op);

describe('短寫不拋錯：照樣整行寫完', () => {
  it('底層每次只寫七個位元組：兩筆都回報成功、都在檔裡，第二筆不觸發截半行', async () => {
    const path = journalPath();
    const fault = newFault();
    fault.shortWriteCap = 7;
    const warnings: string[] = [];

    expect((await append(path, warnings))?.seq).toBe(1);
    expect((await append(path, warnings, ENABLE_TODO))?.seq).toBe(2);

    expect(warnings).toEqual([]);
    expect(readJournal(path)?.incompleteTail).toBe(false);
    expect(opsOf(path)).toEqual(['disable', 'enable']);
  });
});

describe('寫到一半拋錯：截回寫前大小再拋', () => {
  it('前面已有一筆：拒絕、檔案等於寫之前；下一筆不觸發截半行、序號接著 2', async () => {
    const path = journalPath();
    const warnings: string[] = [];
    await append(path, warnings);
    const before = readFileSync(path);
    const fault = newFault();

    fault.writeThrowsAfter = 20;
    await expect(append(path, warnings, ENABLE_TODO)).rejects.toThrow('ENOSPC');
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(fault.rollbackSyncs).toBe(1);

    expect((await append(path, warnings, ENABLE_TODO))?.seq).toBe(2);
    expect(warnings).toEqual([]);
    expect(opsOf(path)).toEqual(['disable', 'enable']);
  });

  it('第一筆、檔是這次才建的：截回 0 位元組；下一筆照常是第 1 筆', async () => {
    const path = journalPath();
    const fault = newFault();
    const warnings: string[] = [];

    fault.writeThrowsAfter = 12;
    await expect(append(path, warnings)).rejects.toThrow('ENOSPC');
    expect(sizeOf(path)).toBe(0);

    expect((await append(path, warnings))?.seq).toBe(1);
    expect(warnings).toEqual([]);
  });

  it('檔尾原本有當掉的半行：先截掉它（講一次），寫失敗截回的是截掉半行之後的大小，不是讀到的原大小', async () => {
    const path = journalPath();
    const warnings: string[] = [];
    await append(path, warnings);
    const complete = readFileSync(path);
    writeFileSync(path, Buffer.concat([complete, Buffer.from('{"v":1,"seq":2,"at"')]));
    const fault = newFault();

    fault.writeThrowsAfter = 20;
    await expect(append(path, warnings, ENABLE_TODO)).rejects.toThrow('ENOSPC');
    expect(warnings).toHaveLength(1);
    expect(readFileSync(path).equals(complete)).toBe(true);

    expect((await append(path, warnings, ENABLE_TODO))?.seq).toBe(2);
    expect(warnings).toHaveLength(1);
  });
});

describe('sync 失敗：截回、拋原錯', () => {
  it('寫成功而 sync 拋：拒絕的是原錯，檔案截回寫前大小、截回也 fsync 過；下一筆序號接著 2', async () => {
    const path = journalPath();
    const warnings: string[] = [];
    await append(path, warnings);
    const before = sizeOf(path);
    const fault = newFault();

    const failure = new Error('EIO: sync failed');
    fault.syncError = failure;
    await expect(append(path, warnings, ENABLE_TODO)).rejects.toBe(failure);
    expect(sizeOf(path)).toBe(before);
    expect(fault.rollbackSyncs).toBe(1);

    expect((await append(path, warnings, ENABLE_TODO))?.seq).toBe(2);
    expect(warnings).toEqual([]);
  });

  it('照 dsh 開關把手：失敗那筆另開 r+ 截回，下一筆照常 a+', async () => {
    const path = journalPath();
    const fault = newFault();
    const warnings: string[] = [];
    await append(path, warnings);
    fault.syncError = new Error('EIO: sync failed');
    await expect(append(path, warnings, ENABLE_TODO)).rejects.toThrow('EIO');
    await append(path, warnings, ENABLE_TODO);
    expect(fault.opened).toEqual(['a+', 'a+', 'r+', 'a+']);
  });
});

describe('截回也失敗：兩個錯都報，半行由下一個寫者截掉', () => {
  it('寫拋錯、截回的 truncate 也拋：AggregateError 帶兩個錯、指名哪個檔；下一筆截掉半行並警告、序號接著 2', async () => {
    const path = journalPath();
    const warnings: string[] = [];
    await append(path, warnings);
    const fault = newFault();
    const truncateFailure = new Error('EIO: truncate failed');
    fault.writeThrowsAfter = 20;
    fault.rollbackTruncateError = truncateFailure;

    const error: unknown = await append(path, warnings, ENABLE_TODO).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(AggregateError);
    const { errors, message } = error as AggregateError;
    expect(errors).toHaveLength(2);
    expect(String((errors[0] as Error).message)).toContain('ENOSPC');
    expect(errors[1]).toBe(truncateFailure);
    expect(message).toContain(path);
    expect(readJournal(path)?.incompleteTail).toBe(true);

    expect((await append(path, warnings, ENABLE_TODO))?.seq).toBe(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('沒有寫完');
    expect(opsOf(path)).toEqual(['disable', 'enable']);
  });
});
