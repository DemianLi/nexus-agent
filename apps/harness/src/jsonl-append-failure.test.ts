/**
 * 會話日誌每批追加都寫滿並 fsync，失敗時截回寫前大小——
 * [#1506](https://github.com/DemianLi/nexus-agent/issues/1506) 的驗收 A 到 G2。
 *
 * **每一條都用真的 JSONL 後端寫到臨時目錄**，只在「開日誌檔」那一下（`openLog`，只給測試換）包住把手，
 * 讓寫到一半拋錯、短寫、sync 拋錯、截回拋錯、落盤與關檔拋錯這幾條真的磁碟上量不到的路走得到。
 * 斷言一律回頭讀**檔案**與**續接讀回的事件**：把手回報什麼不重要，下一個行程讀得回來才重要。
 */

import { mkdtemp, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SESSION_LOG_FORMAT_VERSION,
  SessionAlreadyExistsError,
  SessionLog,
  SessionPersistenceCoordinator,
} from '@nexus/core';
import type { SessionEvent, StoredSession, StoredSessionHeader } from '@nexus/core';

import { openJsonlSessionStore } from './jsonl-session-store.js';
import type { LogFileHandle, OpenLogFile } from './jsonl-session-store.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-append-failure-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function header(id: string): StoredSessionHeader {
  return { version: SESSION_LOG_FORMAT_VERSION, id, createdAt: 1, cwd: '/tmp' };
}

function event(seq: number): SessionEvent {
  return { type: 'model/usage', seq, time: 1, data: {} } as unknown as SessionEvent;
}

/** `from` 起算 `count` 顆連續的事件。 */
function batch(from: number, count = 2): SessionEvent[] {
  return Array.from({ length: count }, (_, index) => event(from + index));
}

/** 製造磁碟錯誤的把手。除了 `shortWriteCap` 是持續的，其餘都是**一次性**的：用一次就清掉。 */
interface Fault {
  /** 下一次 `writeFile` 寫了這麼多位元組之後拋 `ENOSPC`（殘留半批在檔案裡）。 */
  writeThrowsAfter?: number;
  /** 底層每次 `write` 最多寫這麼多位元組並回傳短的計數、不拋錯（`write(2)` 空間不夠時的行為）。 */
  shortWriteCap?: number;
  /** 追加把手的 `sync` 拋這個錯（寫已成功）。 */
  syncError?: Error;
  /** 截回用的 `r+` 把手的 `truncate` 拋這個錯。 */
  rollbackTruncateError?: Error;
  /** 追加把手的 `datasync`／`close` 拋這個錯。 */
  datasyncError?: Error;
  closeError?: Error;
  /** 下一次 `open(<日誌>, 'wx')` 在開檔之前就拋這個錯（header 已經發佈了）。 */
  wxError?: Error;
  /** 卡住追加把手的 `datasync`，直到這個 promise resolve。 */
  datasyncGate?: Promise<void>;
  /** 追加把手上的 `sync` 次數；`datasync` 次數；`r+` 截回把手上的 `sync` 次數；每次開檔的 flags。 */
  syncs: number;
  datasyncs: number;
  rollbackSyncs: number;
  opened: string[];
}

function newFault(): Fault {
  return { syncs: 0, datasyncs: 0, rollbackSyncs: 0, opened: [] };
}

function enospc(): Error {
  return Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
}

/** 取出並清掉一次性的 fault。 */
function take<K extends keyof Fault>(fault: Fault, key: K): Fault[K] {
  const value = fault[key];
  delete fault[key];
  return value;
}

/**
 * 包住真把手。`writeFile` 照 Node 的行為在**包住的 `write` 之上**迴圈寫到整批寫完——所以底層短寫
 * （`shortWriteCap`）對它無害；單次 `write(string)` 就沒有這個保證，這正是 B 要分辨的。
 */
function faulty(fault: Fault): OpenLogFile {
  return async (path, flags, mode) => {
    const wxError = flags === 'wx' ? take(fault, 'wxError') : undefined;
    if (wxError !== undefined) throw wxError;
    const real = await open(path, flags, mode);
    fault.opened.push(flags);
    const rollback = flags === 'r+';
    const writeSome = async (data: Buffer, offset: number): Promise<number> => {
      const cap = fault.shortWriteCap ?? data.length;
      const { bytesWritten } = await real.write(data, offset, Math.min(cap, data.length - offset));
      return bytesWritten;
    };
    const handle = {
      stat: () => real.stat(),
      /** 單次寫、可能短寫、不補寫剩下的——`FileHandle.write` 的行為。只有被突變成這條路的產品碼才會呼叫。 */
      write: async (data: string) => {
        const buffer = Buffer.from(data, 'utf8');
        return { bytesWritten: await writeSome(buffer, 0), buffer: data };
      },
      writeFile: async (data: string) => {
        const buffer = Buffer.from(data, 'utf8');
        const failAfter = rollback ? undefined : take(fault, 'writeThrowsAfter');
        const end = failAfter ?? buffer.length;
        let offset = 0;
        while (offset < end) {
          offset += await writeSome(buffer.subarray(0, end), offset);
        }
        if (failAfter !== undefined) throw enospc();
      },
      sync: async () => {
        if (rollback) fault.rollbackSyncs += 1;
        else fault.syncs += 1;
        const error = rollback ? undefined : take(fault, 'syncError');
        if (error !== undefined) throw error;
        await real.sync();
      },
      datasync: async () => {
        fault.datasyncs += 1;
        const gate = take(fault, 'datasyncGate');
        if (gate !== undefined) await gate;
        const error = take(fault, 'datasyncError');
        if (error !== undefined) throw error;
        await real.datasync();
      },
      truncate: async (length?: number) => {
        const error = rollback ? take(fault, 'rollbackTruncateError') : undefined;
        if (error !== undefined) throw error;
        await real.truncate(length);
      },
      close: async () => {
        const error = rollback ? undefined : take(fault, 'closeError');
        await real.close();
        if (error !== undefined) throw error;
      },
    };
    return handle as unknown as LogFileHandle;
  };
}

function logPath(id: string): string {
  return join(dir, `${id}.jsonl`);
}

async function sizeOf(id: string): Promise<number> {
  return (await stat(logPath(id))).size;
}

/** 目錄裡屬於 `id` 的檔（header、日誌、鎖檔、暫存檔都算）。 */
async function filesOf(id: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.startsWith(`${id}.`)).sort();
}

/** 另開一個後端把 `id` 續接讀回來（讀完就關，放掉租約）。 */
async function readBack(id: string): Promise<readonly SessionEvent[]> {
  const resumed = await openJsonlSessionStore({ directory: dir }).resume(id);
  await resumed.stored.close();
  return resumed.events;
}

function seqsOf(events: readonly SessionEvent[]): number[] {
  return events.map((e) => e.seq);
}

function create(id: string, fault: Fault): StoredSession {
  return openJsonlSessionStore({ directory: dir, openLog: faulty(fault) }).create(header(id));
}

describe('A 寫到一半拋錯：整批不在，重送後讀得回來', () => {
  it('第一批寫了十幾個位元組（在某一行中間）就拋：拒絕、這份會話的檔一個都不在、重送成功', async () => {
    const fault = newFault();
    const stored = create('a', fault);

    fault.writeThrowsAfter = 17;
    await expect(stored.append(batch(0))).rejects.toThrow('ENOSPC');
    // 第一批同時是第一次實體化：整個撤掉，不是截成空檔（#1580 刀 2a 審查 B1，見下面 H）。
    expect(await filesOf('a')).toEqual([]);

    await stored.append(batch(0));
    await stored.close();
    expect(seqsOf(await readBack('a'))).toEqual([0, 1]);
  });

  it('前面已經有一批：失敗的那批截回前一批的結尾，不是檔頭', async () => {
    const fault = newFault();
    const stored = create('a', fault);
    await stored.append(batch(0));
    const afterFirst = await sizeOf('a');
    expect(afterFirst).toBeGreaterThan(0);

    fault.writeThrowsAfter = 40;
    await expect(stored.append(batch(2))).rejects.toThrow('ENOSPC');
    expect(await sizeOf('a')).toBe(afterFirst);

    await stored.append(batch(2));
    await stored.close();
    expect(seqsOf(await readBack('a'))).toEqual([0, 1, 2, 3]);
  });

  it('續接來的把手：寫前大小取檔案現在的大小（續接截尾之後），不是記憶體裡的累計', async () => {
    const first = create('a', newFault());
    await first.append(batch(0));
    await first.close();
    // 檔尾黏上半行：續接讀方不算它，把手第一次寫入之前會把它截掉。
    const handle = await open(logPath('a'), 'a');
    await handle.write('{"type":"model/us');
    await handle.close();

    const fault = newFault();
    const resumed = await openJsonlSessionStore({
      directory: dir,
      openLog: faulty(fault),
    }).resume('a');
    expect(resumed.events).toHaveLength(2);
    const clean = (await readFile(logPath('a'), 'utf8')).lastIndexOf('{"type":"model/us');
    fault.writeThrowsAfter = 20;
    await expect(resumed.stored.append(batch(2))).rejects.toThrow('ENOSPC');
    expect(await sizeOf('a')).toBe(clean);

    await resumed.stored.append(batch(2));
    await resumed.stored.close();
    expect(seqsOf(await readBack('a'))).toEqual([0, 1, 2, 3]);
  });
});

describe('B 短寫不拋錯：照樣整批寫完', () => {
  it('底層每次只寫七個位元組也不丟任何一個：兩批都讀得回', async () => {
    const fault = newFault();
    const stored = create('b', fault);
    fault.shortWriteCap = 7;

    await stored.append(batch(0));
    await stored.append(batch(2));
    await stored.close();

    expect(seqsOf(await readBack('b'))).toEqual([0, 1, 2, 3]);
  });
});

describe('C sync 失敗：截回、不前進、重送成功', () => {
  it('寫成功而 sync 拋：拒絕的是原錯，檔案截回寫前大小，同一批重送成功', async () => {
    const fault = newFault();
    const stored = create('c', fault);
    await stored.append(batch(0));
    const before = await sizeOf('c');

    const failure = new Error('EIO: sync failed');
    fault.syncError = failure;
    await expect(stored.append(batch(2))).rejects.toBe(failure);
    expect(await sizeOf('c')).toBe(before);
    // 截回也 sync 過（rollback 的 r+ 把手）。
    expect(fault.rollbackSyncs).toBe(1);

    // seq 沒前進：同一批（從 2 起）重送得進去。
    await stored.append(batch(2));
    await stored.close();
    expect(seqsOf(await readBack('c'))).toEqual([0, 1, 2, 3]);
  });
});

describe('D 回滾也失敗：兩個錯都報', () => {
  it('寫拋錯、截回的 truncate 也拋錯：拒絕的是 AggregateError，errors 裡有兩個，訊息指名是哪個檔', async () => {
    const fault = newFault();
    const stored = create('d', fault);
    // 先寫成一批：第一批失敗走的是撤掉實體化（H），不截回。
    await stored.append(batch(0));
    const truncateFailure = new Error('EIO: truncate failed');
    fault.writeThrowsAfter = 10;
    fault.rollbackTruncateError = truncateFailure;

    const error: unknown = await stored.append(batch(2)).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(AggregateError);
    const { errors, message } = error as AggregateError;
    expect(errors).toHaveLength(2);
    expect(String((errors[0] as Error).message)).toContain('ENOSPC');
    expect(errors[1]).toBe(truncateFailure);
    expect(message).toContain(logPath('d'));
    await stored.close().catch(() => undefined);
  });
});

describe('E 每批 sync', () => {
  it('每一次 append resolve 之前剛好 sync 一次；把手已開著時 flush 不多一次 datasync', async () => {
    const fault = newFault();
    const stored = create('e', fault);

    await stored.append(batch(0));
    expect(fault.syncs).toBe(1);
    await stored.append(batch(2));
    expect(fault.syncs).toBe(2);
    await stored.append(batch(4, 1));
    expect(fault.syncs).toBe(3);

    await stored.flush();
    await stored.flush();
    expect(fault.datasyncs).toBe(0);
    await stored.close();
    // 收尾只做一次。
    expect(fault.datasyncs).toBe(1);
  });

  it('這次 flush 才觸發實體化的（一筆都還沒寫），照舊 datasync', async () => {
    const fault = newFault();
    const stored = create('e2', fault);
    await stored.flush();
    expect(fault.datasyncs).toBe(1);
    await stored.flush();
    expect(fault.datasyncs).toBe(1);
    await stored.close();
  });

  it('追加失敗、把手收掉再重開之後，flush 也不多一次 datasync', async () => {
    const fault = newFault();
    const stored = create('e3', fault);
    await stored.append(batch(0));
    fault.writeThrowsAfter = 10;
    await expect(stored.append(batch(2))).rejects.toThrow('ENOSPC');
    await stored.flush();
    expect(fault.datasyncs).toBe(0);
    await stored.close();
  });

  it('失敗路徑照 dsh 開關把手：失敗那批用 r+ 截回，下一批用 a 重開', async () => {
    const fault = newFault();
    const stored = create('e4', fault);
    await stored.append(batch(0));
    fault.writeThrowsAfter = 10;
    await expect(stored.append(batch(2))).rejects.toThrow('ENOSPC');
    await stored.append(batch(2));
    await stored.close();
    expect(fault.opened).toEqual(['wx', 'r+', 'a']);
  });
});

describe('F 走協調器的整條路', () => {
  it('背景窗口的第一次 append 寫到一半失敗：warn 一行、暫停、整批保留；flush 重試成功；續接讀得回', async () => {
    const fault = newFault();
    const stored = create('f', fault);
    const log = new SessionLog('f');
    const warn = vi.fn();
    const coordinator = new SessionPersistenceCoordinator({ log, stored, warn, windowMs: 5 });

    fault.writeThrowsAfter = 12;
    log.append('turn/start', { kind: 'message', text: 'p' });
    log.append('turn/end', { reason: 'completed' } as never);
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledTimes(1);
    });
    expect(String(warn.mock.calls[0]?.[0])).toContain('ENOSPC');
    expect(coordinator.paused).toBe(true);
    expect(coordinator.pending).toBe(2);
    expect(await filesOf('f')).toEqual([]);

    await coordinator.flush();
    expect(coordinator.paused).toBe(false);
    expect(coordinator.pending).toBe(0);
    await coordinator.dispose();

    const events = await readBack('f');
    expect(seqsOf(events)).toEqual([0, 1]);
    expect(events.map((e) => e.type)).toEqual(['turn/start', 'turn/end']);
  });
});

describe('G 串行化', () => {
  it('flush 的 datasync 還沒回來時進來的 append 排在後面：失敗回滾不會把 flush 腳下的把手關掉', async () => {
    const fault = newFault();
    const stored = create('g', fault);
    let release!: () => void;
    fault.datasyncGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // 一份全新的會話：這次 flush 才觸發實體化，所以真的 datasync，而且被卡在閘門上。
    const flushing = stored.flush();
    await vi.waitFor(() => {
      expect(fault.datasyncs).toBe(1);
    });
    fault.writeThrowsAfter = 10;
    const appending = stored.append(batch(0));
    const appended = appending.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    // 閘門還關著：append 一個位元組都不該動。
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await sizeOf('g')).toBe(0);
    expect(fault.syncs).toBe(0);

    release();
    await expect(flushing).resolves.toBeUndefined();
    expect(String(((await appended) as Error).message)).toContain('ENOSPC');

    await stored.append(batch(0));
    await stored.close();
    expect(seqsOf(await readBack('g'))).toEqual([0, 1]);
  });

  it('兩個 append 同時進來：依序落盤，第二批照第一批之後的 seq 驗', async () => {
    const stored = create('g2', newFault());
    await Promise.all([stored.append(batch(0)), stored.append(batch(2))]);
    await stored.close();
    expect(seqsOf(await readBack('g2'))).toEqual([0, 1, 2, 3]);
  });

  it('close 之前排進去的 append 先跑完；close 之後進來的拒絕', async () => {
    const stored = create('g3', newFault());
    const appending = stored.append(batch(0));
    const closing = stored.close();
    await expect(stored.append(batch(2))).rejects.toThrow('已經關掉了');
    await appending;
    await closing;
    expect(seqsOf(await readBack('g3'))).toEqual([0, 1]);
    // 冪等：第二次拿到同一個結果。
    await expect(stored.close()).resolves.toBeUndefined();
  });
});

describe('G2 close 的兩個錯都留', () => {
  async function ownedAgain(id: string): Promise<void> {
    // 租約放掉了：另一個後端接得了同一份。
    const resumed = await openJsonlSessionStore({ directory: dir }).resume(id);
    await resumed.stored.close();
  }

  it('datasync 與 handle.close 都拋：AggregateError，兩個錯都在 errors 裡；租約照放', async () => {
    const fault = newFault();
    const stored = create('h', fault);
    await stored.append(batch(0));
    const datasyncFailure = new Error('EIO: datasync failed');
    const closeFailure = new Error('EIO: close failed');
    fault.datasyncError = datasyncFailure;
    fault.closeError = closeFailure;

    const error: unknown = await stored.close().then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([datasyncFailure, closeFailure]);
    await ownedAgain('h');
  });

  it('只有 datasync 失敗：拒絕的就是那個錯本身；租約照放', async () => {
    const fault = newFault();
    const stored = create('h2', fault);
    await stored.append(batch(0));
    const datasyncFailure = new Error('EIO: datasync failed');
    fault.datasyncError = datasyncFailure;

    await expect(stored.close()).rejects.toBe(datasyncFailure);
    await ownedAgain('h2');
  });

  it('只有關檔失敗：拒絕的就是那個錯本身；租約照放', async () => {
    const fault = newFault();
    const stored = create('h3', fault);
    await stored.append(batch(0));
    const closeFailure = new Error('EIO: close failed');
    fault.closeError = closeFailure;

    await expect(stored.close()).rejects.toBe(closeFailure);
    await ownedAgain('h3');
  });
});

describe('H 第一批就寫不進去：撤掉這次實體化（#1580 刀 2a 審查 B1）', () => {
  // 對照 dsh `materializePosix`（`session-persistence-jsonl/src/index.ts:1282-1321`）：第一批與發佈是同一次 `link`，
  // 寫失敗時正式路徑上什麼都沒有。改動之前這裡會留下 header＋0 位元組的日誌＋鎖檔。

  it('寫一半拋 ENOSPC：header、日誌、鎖檔都不在；列表看不到；關掉之後同一個 id 建得回來', async () => {
    const fault = newFault();
    const store = openJsonlSessionStore({ directory: dir, openLog: faulty(fault) });
    const stored = store.create(header('x'));

    fault.writeThrowsAfter = 9;
    await expect(stored.append(batch(0))).rejects.toThrow('ENOSPC');

    expect(await filesOf('x')).toEqual([]);
    expect((await store.list()).sessions).toEqual([]);
    // 把手還開著：這個 id 仍然是它的。
    expect(() => store.create(header('x'))).toThrow(/x/);
    await stored.close();

    const again = store.create(header('x'));
    await again.append(batch(0));
    await again.close();
    expect(seqsOf(await readBack('x'))).toEqual([0, 1]);
  });

  it('同一個把手重送：從頭實體化一次（header 再 link 一次，不撞 EEXIST），續接讀得回', async () => {
    const fault = newFault();
    const stored = create('y', fault);
    fault.syncError = new Error('EIO: sync failed');
    await expect(stored.append(batch(0))).rejects.toThrow('EIO');
    expect(await filesOf('y')).toEqual([]);

    await stored.append(batch(0));
    await stored.close();
    expect(seqsOf(await readBack('y'))).toEqual([0, 1]);
    expect(fault.opened).toEqual(['wx', 'wx']);
  });

  it('撤的途中也失敗（關把手拋錯）：AggregateError，原錯在第一個；其餘步驟照走，檔照樣不在', async () => {
    const fault = newFault();
    const stored = create('z', fault);
    const closeFailure = new Error('EIO: close failed');
    fault.writeThrowsAfter = 9;
    fault.closeError = closeFailure;

    const error: unknown = await stored.append(batch(0)).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(AggregateError);
    const { errors, message } = error as AggregateError;
    expect(errors).toHaveLength(2);
    expect(String((errors[0] as Error).message)).toContain('ENOSPC');
    expect(errors[1]).toBe(closeFailure);
    expect(message).toContain(dir);
    expect(await filesOf('z')).toEqual([]);
    await stored.close();
  });

  it('先 flush 實體化過（空會話已經列得出來）再寫失敗：照舊截回，不撤', async () => {
    const fault = newFault();
    const stored = create('w', fault);
    await stored.flush();
    fault.writeThrowsAfter = 9;
    await expect(stored.append(batch(0))).rejects.toThrow('ENOSPC');
    expect(await filesOf('w')).toEqual(['w.header.json', 'w.jsonl', 'w.lock']);
    expect(await sizeOf('w')).toBe(0);
    await stored.close();
  });
});

describe('I 第一次實體化做到一半就關：header 發佈了、日誌沒開成（#1580 刀 2a 審查）', () => {
  it('wx 拋 EMFILE 之後不重試就 close：header、日誌、鎖檔都不在；列表看不到；同一個 id 建得回來', async () => {
    const fault = newFault();
    const store = openJsonlSessionStore({ directory: dir, openLog: faulty(fault) });
    const stored = store.create(header('u'));

    fault.wxError = Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
    await expect(stored.append(batch(0))).rejects.toThrow('EMFILE');
    // 前提：header 真的發佈了（這正是改動之前會留下來的那個）。
    expect(await filesOf('u')).toContain('u.header.json');
    await stored.close();

    expect(await filesOf('u')).toEqual([]);
    expect((await store.list()).sessions).toEqual([]);
    const again = store.create(header('u'));
    await again.append(batch(0));
    await again.close();
    expect(seqsOf(await readBack('u'))).toEqual([0, 1]);
  });

  it('header 撞名（link 回 EEXIST，那份是別人的）之後 close：別人的 header 原封不動', async () => {
    const store = openJsonlSessionStore({ directory: dir });
    const stored = store.create(header('v'));
    // `create` 之後才出現的同名：另一個行程搶先發佈了。
    const theirs = `${JSON.stringify({ ...header('v'), createdAt: 99 })}\n`;
    await writeFile(join(dir, 'v.header.json'), theirs);

    await expect(stored.append(batch(0))).rejects.toThrow(SessionAlreadyExistsError);
    await stored.close();

    expect(await readFile(join(dir, 'v.header.json'), 'utf8')).toBe(theirs);
  });
});
