/**
 * 離線掃描（`readSessionLogs`）跟寫方同時動的兩種情形（#1857 審查）：掃描改走後端的讀取接縫（`readSessionEntry`）之後，
 * 這兩條是刻意的行為，各一格釘住。
 *
 * - header 在讀目錄與讀檔之間不見了：跳過那一份，不讓整次掃描失敗（同 `list`）。單檔佈局挑定的世代檔在讀本文之前不見了也一樣。
 * - 讀日誌本文的當下有人在寫：照穩定快照讀，第二次還在變就截到讀前的大小（dsh `readStableSnapshot`）。
 *
 * 真的磁碟上造不出「剛好在那一下」，所以照 `jsonl-session-store-header-replace.test.ts` 的做法 mock `node:fs/promises`，
 * 在 `readFile` 之前、`stat` 與 `readFile` 上放注入點。
 */

import type { BigIntStats } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  generationLogFilename,
  SESSION_LOG_FORMAT_VERSION,
  sessionDirectoryName,
} from '@nexus/core';
import type { SessionEvent } from '@nexus/core';

interface Injection {
  /** `readFile` 讀這個路徑之前執行。 */
  beforeReadFile?: (path: string) => Promise<void>;
  /** 這個路徑的 `stat`／`readFile`（不帶 encoding）照劇本走。 */
  unstable?: {
    readonly path: string;
    /** 每次 `readFile` 回的位元組。 */
    readonly bytes: Buffer;
    /** 第 n 次 `stat` 回的大小與修改時間（奈秒）。 */
    readonly stats: readonly (readonly [size: number, mtimeNs: bigint])[];
    statCalls: number;
  };
}

let inject: Injection = {};

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    stat: async (path: unknown, options?: unknown) => {
      const real = await actual.stat(path as never, options as never);
      const script = inject.unstable;
      if (script !== undefined && path === script.path) {
        const [size, mtimeNs] = script.stats[script.statCalls++]!;
        return { ...real, size: BigInt(size), mtimeNs, ctimeNs: mtimeNs } as unknown as BigIntStats;
      }
      return real;
    },
    readFile: async (path: unknown, options?: unknown) => {
      await inject.beforeReadFile?.(String(path));
      const script = inject.unstable;
      if (script !== undefined && path === script.path && options === undefined)
        return script.bytes;
      return actual.readFile(path as never, options as never);
    },
  };
});

const { createJsonlSessionStore, legacyTwoFilePathsIn, sessionPathsIn } =
  await import('../jsonl-session-store.js');
const { LEGACY_TWO_FILE_FORMAT_VERSION } = await import('../session-files.fixture.js');
const { readSessionLogs } = await import('./session-scan.js');

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nexus-scan-race-'));
  inject = {};
});

afterEach(async () => {
  inject = {};
  await rm(root, { recursive: true, force: true });
});

function event(seq: number): SessionEvent {
  return { type: 'model/usage', seq, time: 1, data: {} } as unknown as SessionEvent;
}

/** 經後端寫一份 `count` 筆的會話，回它所在的 run 目錄。 */
async function written(id: string, count: number): Promise<string> {
  const store = createJsonlSessionStore({ rootDir: root });
  const stored = store.create({ version: SESSION_LOG_FORMAT_VERSION, id, createdAt: 0 });
  await stored.append(Array.from({ length: count }, (_, seq) => event(seq)));
  await stored.close();
  return store.directory;
}

describe('離線掃描跟寫方同時動', () => {
  it('header 在讀目錄與讀檔之間不見了：跳過那一份，其餘照讀，不算讀不懂', async () => {
    const run = await written('cli', 2);
    const ghost = legacyTwoFilePathsIn(run, 'ghost').header;
    await writeFile(
      ghost,
      JSON.stringify({ version: LEGACY_TWO_FILE_FORMAT_VERSION, id: 'ghost', createdAt: 0 }),
    );
    // 掃描列目錄時它還在，讀它的那一下才不見。
    inject.beforeReadFile = async (path) => {
      if (path === ghost) await rm(ghost);
    };

    const { logs, unreadable } = await readSessionLogs([root]);
    expect(logs.map((log) => log.header.id)).toEqual(['cli']);
    expect(unreadable).toEqual([]);
  });

  it('單檔佈局挑定的世代檔在讀本文之前不見了：跳過那一份，其餘照讀，不算讀不懂', async () => {
    const run = await written('cli', 2);
    const ghostDir = join(run, sessionDirectoryName('ghost'));
    await mkdir(ghostDir);
    const ghost = join(ghostDir, generationLogFilename(SESSION_LOG_FORMAT_VERSION));
    const header = {
      type: 'session',
      version: SESSION_LOG_FORMAT_VERSION,
      id: 'ghost',
      createdAt: 0,
    };
    await writeFile(ghost, `${JSON.stringify(header)}\n${JSON.stringify(event(0))}\n`);
    // header 行讀得到，讀本文的那一下才不見。
    inject.beforeReadFile = async (path) => {
      if (path === ghost) await rm(ghost);
    };

    const { logs, unreadable } = await readSessionLogs([root]);
    expect(logs.map((log) => log.header.id)).toEqual(['cli']);
    expect(unreadable).toEqual([]);
  });

  it('讀本文的當下有人在寫、第二次還在變：截到讀前的大小，不收進寫到一半的那幾行', async () => {
    const run = await written('cli', 2);
    const log = sessionPathsIn(run, 'cli').log;
    const { readFile } =
      await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const real = await readFile(log);
    // 讀的當下，寫方又追加了完整的一筆（有換行）。不截的話，它會被當成第三筆讀進來。
    const appended = Buffer.from(`${JSON.stringify(event(2))}\n`);
    inject.unstable = {
      path: log,
      bytes: Buffer.concat([real, appended]),
      // 讀前、第一次讀後（變了，大小還沒動）、第二次讀後（又變了，多了那一行）。
      stats: [
        [real.byteLength, 100n],
        [real.byteLength, 200n],
        [real.byteLength + appended.byteLength, 300n],
      ],
      statCalls: 0,
    };

    const { logs, unreadable } = await readSessionLogs([root]);
    expect(unreadable).toEqual([]);
    expect(logs.map((entry) => entry.events.map((e) => e.seq))).toEqual([[0, 1]]);
    expect(inject.unstable.statCalls).toBe(3);
  });
});
