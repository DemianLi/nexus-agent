/**
 * 日誌尾端的壞行照 dsh 可復原丟棄（[#1508](https://github.com/DemianLi/nexus-agent/issues/1508)）。
 *
 * 斷電後尾端可能多出一行「有換行、但讀不懂」的完整行。壞行之後沒有收尾（`turn/end`／`turn/failed`）就是當機留下
 * 的尾巴：丟掉，由續接補「中斷」；壞行之後有收尾，那是壞檔，照樣拒絕。位元組偏移算在 Buffer 上，截斷之後 sync 再
 * 講一行；唯讀的讀方永遠不截、不講。
 *
 * 都用真的 `openJsonlSessionStore` 與臨時目錄。**截斷跟著第一次寫入走**（dsh 的 first new append 之前），所以
 * 要看得到截斷的夾具，前綴裡必須有一顆沒收尾的 `turn/start`：補結才算得出來、才會寫。
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  resumeClosingInterruptedTurn,
  SESSION_LOG_FORMAT_VERSION,
  SessionCorruptionError,
  SessionEventUnsupportedError,
} from '@nexus/core';
import type { StoredSessionHeader } from '@nexus/core';

import {
  legacyTwoFilePathsIn,
  openJsonlSessionStore,
  parseJsonlSessionBody,
  sessionPathsIn,
} from './jsonl-session-store.js';
import type { LogFileHandle, OpenLogFile } from './jsonl-session-store.js';
import { LEGACY_TWO_FILE_FORMAT_VERSION } from './session-files.fixture.js';

const ID = 'torn-thread';
let dir: string;
let warnings: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-torn-tail-'));
  warnings = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function header(): StoredSessionHeader {
  return { version: SESSION_LOG_FORMAT_VERSION, id: ID, createdAt: 1, cwd: '/tmp' };
}

/** 世代檔的第一行（含換行）：事件行的位元組偏移都要加上它的長度。 */
const HEADER_LINE = `${JSON.stringify({ type: 'session', ...header() })}\n`;
const HEADER_BYTES = Buffer.byteLength(HEADER_LINE);

/** 一行事件（含換行）。 */
function line(seq: number, type = 'model/usage', extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ type, seq, time: 1, data: {}, ...extra })}\n`;
}

/** `[turn/start(0), usage(1), usage(2)]`：一輪開著、沒收尾，續接會補 `turn/end`。 */
const OPEN_TURN = [line(0, 'turn/start'), line(1), line(2)].join('');
const BAD_LINE = '{壞掉\n';

function bytesOf(parts: readonly (string | Buffer)[]): Buffer {
  return Buffer.concat(parts.map((part) => Buffer.from(part)));
}

/**
 * 手寫一份這一版的世代檔，樣子同寫方建的：會話目錄裡的世代檔是 {@link HEADER_LINE} 加上 `parts`，舊路徑放墓碑。
 * 續接截尾巴截的是這一種；舊兩檔續接時遷移，不截（見 {@link plantLegacy}）。
 */
async function plant(...parts: (string | Buffer)[]): Promise<void> {
  const paths = sessionPathsIn(dir, ID);
  await mkdir(paths.sessionDirectory);
  await writeFile(paths.log, Buffer.concat([Buffer.from(HEADER_LINE), bytesOf(parts)]));
  await writeFile(paths.tombstone, HEADER_LINE);
}

/** 世代檔的全部位元組（含 header 行）。 */
function logBytes(): Promise<Buffer> {
  return readFile(sessionPathsIn(dir, ID).log);
}

/** 手寫一份舊兩檔（版本 {@link LEGACY_TWO_FILE_FORMAT_VERSION}）：只讀、只拒的測試用，讀方照讀，續接先遷移。 */
async function plantLegacy(...parts: (string | Buffer)[]): Promise<void> {
  const paths = legacyTwoFilePathsIn(dir, ID);
  await writeFile(
    paths.header,
    JSON.stringify({ ...header(), version: LEGACY_TWO_FILE_FORMAT_VERSION }),
  );
  await writeFile(paths.log, bytesOf(parts));
}

function legacyLogBytes(): Promise<Buffer> {
  return readFile(legacyTwoFilePathsIn(dir, ID).log);
}

function store(extra: { openLog?: OpenLogFile } = {}) {
  return openJsonlSessionStore({
    directory: dir,
    warn: (message) => warnings.push(message),
    ...extra,
  });
}

/** 世代檔的本文（header 行之後）整份 strict 解析：乾淨就回事件，有任何壞行就拋。 */
async function strictEvents() {
  return parseJsonlSessionBody(ID, (await logBytes()).subarray(HEADER_BYTES), {
    version: SESSION_LOG_FORMAT_VERSION,
    recovery: 'strict',
  });
}

describe('壞尾可復原', () => {
  it('壞行加上它之後沒收尾的行：續接不拋，補結寫下去時截掉，整份 strict 讀得乾淨，講一行', async () => {
    const tail = BAD_LINE + line(3);
    await plant(OPEN_TURN, tail);

    const { events, stored } = await resumeClosingInterruptedTurn(store(), ID);
    expect(events.map((e) => [e.seq, e.type])).toEqual([
      [0, 'turn/start'],
      [1, 'model/usage'],
      [2, 'model/usage'],
      [3, 'turn/end'],
    ]);
    await stored.close();

    const { events: onDisk, validBytes } = await strictEvents();
    expect(onDisk.map((e) => e.type)).toEqual([
      'turn/start',
      'model/usage',
      'model/usage',
      'turn/end',
    ]);
    expect(validBytes).toBe((await logBytes()).byteLength - HEADER_BYTES);
    expect((await logBytes()).subarray(0, HEADER_BYTES + OPEN_TURN.length).toString()).toBe(
      HEADER_LINE + OPEN_TURN,
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(ID);
    expect(warnings[0]).toContain(`${Buffer.byteLength(tail)} 個位元組`);
    expect(warnings[0]).toContain(`第 ${HEADER_BYTES + Buffer.byteLength(OPEN_TURN)} 個位元組`);
  });

  it('純撕裂的半行也照講，並截掉', async () => {
    const torn = '{"type":"model/usage","se';
    await plant(OPEN_TURN, torn);
    const { stored } = await resumeClosingInterruptedTurn(store(), ID);
    await stored.close();
    expect((await strictEvents()).events).toHaveLength(4);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`${Buffer.byteLength(torn)} 個位元組`);
  });

  it('截斷之後先 sync（開 r+）才開 a 續寫', async () => {
    await plant(OPEN_TURN, BAD_LINE);
    const order: string[] = [];
    const openLog: OpenLogFile = async (path, flags, mode) => {
      const { open } = await import('node:fs/promises');
      const real = (await open(path, flags, mode)) as unknown as LogFileHandle;
      // 開 r+ 的當下檔案已經截好了：先 sync 再截的話，sync 保不住截斷。
      order.push(`open ${flags} size=${(await real.stat()).size}`);
      return new Proxy(real, {
        get(target, property) {
          if (property === 'sync') {
            return async () => {
              order.push(`sync ${flags}`);
              return target.sync();
            };
          }
          const member = Reflect.get(target, property, target) as unknown;
          return typeof member === 'function' ? member.bind(target) : member;
        },
      });
    };
    const { stored } = await resumeClosingInterruptedTurn(store({ openLog }), ID);
    await stored.close();
    expect(order.slice(0, 3)).toEqual([
      `open r+ size=${HEADER_BYTES + Buffer.byteLength(OPEN_TURN)}`,
      'sync r+',
      `open a size=${HEADER_BYTES + Buffer.byteLength(OPEN_TURN)}`,
    ]);
  });
});

/** 兩種佈局：世代檔的第 1 行是 header 行，行號比舊兩檔多 1。 */
const LAYOUTS = [
  { name: '世代檔', put: plant, bytes: logBytes, offset: 1 },
  { name: '舊兩檔', put: plantLegacy, bytes: legacyLogBytes, offset: 0 },
];

describe.each(LAYOUTS)('壞行之後有收尾，$name：拒絕', ({ put, bytes, offset }) => {
  it.each(['turn/end', 'turn/failed'])(
    '壞行之後接完整的 %s：resume 與預設 read 都拋，檔案原樣',
    async (closer) => {
      await put(OPEN_TURN, BAD_LINE, line(4, closer));
      const before = await bytes();
      const message = new RegExp(`第 ${4 + offset} 行不是 JSON`, 'u');

      await expect(store().resume(ID)).rejects.toBeInstanceOf(SessionCorruptionError);
      await expect(store().resume(ID)).rejects.toThrow(message);
      const reader = await store().open(ID, 'read');
      await expect(reader.read()).rejects.toThrow(message);

      expect((await bytes()).equals(before)).toBe(true);
      expect(warnings).toEqual([]);
    },
  );

  it.each(['turn/end', 'turn/failed'])(
    '壞行本身就是 parse 得了的 %s（seq 錯）：立即拋，檔案原樣',
    async (closer) => {
      await put(OPEN_TURN, line(9, closer));
      const before = await bytes();
      await expect(store().resume(ID)).rejects.toThrow(
        new RegExp(`第 ${4 + offset} 行的 seq 是 9，應該是 3`, 'u'),
      );
      const reader = await store().open(ID, 'read');
      await expect(reader.read()).rejects.toBeInstanceOf(SessionCorruptionError);
      expect((await bytes()).equals(before)).toBe(true);
      expect(warnings).toEqual([]);
    },
  );

  it('壞行之後的收尾沒有換行（撕裂）：不算收尾，丟掉', async () => {
    await put(OPEN_TURN, BAD_LINE, '{"type":"turn/end","seq":4');
    const reader = await store().open(ID, 'read');
    expect((await reader.read()).map((e) => e.seq)).toEqual([0, 1, 2]);
  });
});

describe('准入先於復原', () => {
  it.each(LAYOUTS)(
    '$name，壞行之後接一行不認得、沒標 ignorable 的種類：拋 SessionEventUnsupportedError，不是靜靜截掉',
    async ({ put, bytes }) => {
      await put(OPEN_TURN, BAD_LINE, line(4, 'future/thing'));
      const before = await bytes();

      await expect(store().resume(ID)).rejects.toBeInstanceOf(SessionEventUnsupportedError);
      const reader = await store().open(ID, 'read');
      await expect(reader.read()).rejects.toBeInstanceOf(SessionEventUnsupportedError);
      expect((await bytes()).equals(before)).toBe(true);
      expect(warnings).toEqual([]);
    },
  );

  it.each(LAYOUTS)('$name，標了 ignorable 的不認得種類，壞行之後照丟', async ({ put }) => {
    await put(OPEN_TURN, BAD_LINE, line(4, 'future/thing', { ignorable: true }));
    const reader = await store().open(ID, 'read');
    expect((await reader.read()).map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it('同一行既 seq 對不上又不認得：recoverable 先報不認得，strict 先報壞檔（既有順序不動）', () => {
    const body = Buffer.from(line(0) + line(5, 'future/thing'));
    expect(() =>
      parseJsonlSessionBody(ID, body, {
        version: SESSION_LOG_FORMAT_VERSION,
        recovery: 'recoverable',
      }),
    ).toThrow(SessionEventUnsupportedError);
    expect(() =>
      parseJsonlSessionBody(ID, body, { version: SESSION_LOG_FORMAT_VERSION, recovery: 'strict' }),
    ).toThrow(SessionCorruptionError);
  });
});

describe('位元組偏移算在 Buffer 上', () => {
  /** 一行好行，字串值裡夾一個非法 UTF-8 位元組：解碼成字串時 1 個位元組會變 3 個（U+FFFD）。 */
  function lineWithInvalidByte(): Buffer {
    return Buffer.concat([
      Buffer.from('{"type":"turn/start","seq":0,"time":1,"data":{"x":"'),
      Buffer.from([0xff]),
      Buffer.from('"}}\n'),
    ]);
  }

  it('validBytes 等於好行實際結束的位元組，不是解碼後多算的', () => {
    const good = lineWithInvalidByte();
    const tornTail = Buffer.from('{"type":"model/usage","se');
    const { events, validBytes } = parseJsonlSessionBody(ID, Buffer.concat([good, tornTail]), {
      version: SESSION_LOG_FORMAT_VERSION,
      recovery: 'recoverable',
    });
    expect(events).toHaveLength(1);
    expect(validBytes).toBe(good.byteLength);
    // 反證：先解碼成字串再算 byteLength，會多出 2 個位元組。
    expect(Buffer.byteLength(good.toString('utf8'))).toBe(good.byteLength + 2);
  });

  it('續接之後續寫一次再關，整份 strict 解析乾淨，前綴原樣', async () => {
    const good = lineWithInvalidByte();
    await plant(good, '{"type":"model/usage","se');
    const { stored } = await resumeClosingInterruptedTurn(store(), ID);
    await stored.close();

    const bytes = await logBytes();
    expect(bytes.subarray(0, HEADER_BYTES).toString()).toBe(HEADER_LINE);
    expect(bytes.subarray(HEADER_BYTES, HEADER_BYTES + good.byteLength).equals(good)).toBe(true);
    const { events, validBytes } = await strictEvents();
    expect(events.map((e) => e.type)).toEqual(['turn/start', 'turn/end']);
    expect(validBytes).toBe(bytes.byteLength - HEADER_BYTES);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`第 ${HEADER_BYTES + good.byteLength} 個位元組`);
  });
});

describe('唯讀與沒有寫入的續接不截、不講', () => {
  it('open(id, "read").read()：檔案大小不變、warn 零次', async () => {
    await plant(OPEN_TURN, BAD_LINE, line(4));
    const size = (await stat(sessionPathsIn(dir, ID).log)).size;
    const reader = await store().open(ID, 'read');
    expect((await reader.read()).map((e) => e.seq)).toEqual([0, 1, 2]);
    expect((await stat(sessionPathsIn(dir, ID).log)).size).toBe(size);
    expect(warnings).toEqual([]);
  });

  it('續接了但一筆都沒寫：尾巴留在檔上（下一次讀方照樣不算它），沒講', async () => {
    // 前綴已收尾 → 補不出任何結 → 沒有第一次寫入。
    const balanced = line(0, 'turn/start') + line(1, 'turn/end');
    await plant(balanced, BAD_LINE);
    const before = await logBytes();
    const { events, stored } = await resumeClosingInterruptedTurn(store(), ID);
    expect(events).toHaveLength(2);
    await stored.close();
    expect((await logBytes()).equals(before)).toBe(true);
    expect(warnings).toEqual([]);
  });
});
