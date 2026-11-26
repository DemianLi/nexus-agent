/**
 * **續接交出的事件接成 seed 時不拷**（[#2117](https://github.com/DemianLi/nexus-agent/issues/2117)）：store 解出來就凍一次、
 * 標成可共用（`shareStoredEvents`），`SessionLog` 驗信封、資料規則與 `seq`，不拷不凍。大日誌逐顆深拷、凍是打開 thread 時的
 * 長同步段（#2117 量測：s230 上 4.6 秒）。
 *
 * 釘的是物件身分：日誌裡的事件就是 store 交出的那一個。三條讀法（新讀、冷讀快取命中、舊兩檔遷移）加上補收尾各一條。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resumeClosingInterruptedTurn, SESSION_LOG_FORMAT_VERSION, SessionLog } from '@nexus/core';
import type { SessionEvent } from '@nexus/core';

import {
  legacyTwoFilePathsIn,
  openJsonlSessionStore,
  sessionPathsIn,
} from './jsonl-session-store.js';
import { LEGACY_TWO_FILE_FORMAT_VERSION } from './session-files.fixture.js';

const ID = 'shared-seed';
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-shared-seed-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const HEADER = { version: SESSION_LOG_FORMAT_VERSION, id: ID, createdAt: 1, cwd: '/tmp' };

function line(seq: number, type = 'model/usage'): string {
  return `${JSON.stringify({ type, seq, time: 1, data: {} })}\n`;
}

/** 收好尾的一輪：續接算不出補結。 */
const CLOSED_TURN = [line(0, 'turn/start'), line(1), line(2, 'turn/end')].join('');
/** 開著的一輪：續接會補 `turn/end`。 */
const OPEN_TURN = [line(0, 'turn/start'), line(1), line(2)].join('');

async function plant(body: string): Promise<void> {
  const paths = sessionPathsIn(dir, ID);
  await mkdir(paths.sessionDirectory);
  await writeFile(paths.log, `${JSON.stringify({ type: 'session', ...HEADER })}\n${body}`);
  await writeFile(paths.tombstone, `${JSON.stringify({ type: 'session', ...HEADER })}\n`);
}

const store = () => openJsonlSessionStore({ directory: dir, warn: () => {} });

/** seed 的每一顆都原封不動進了日誌。 */
function expectAdoptedAsIs(seed: readonly SessionEvent[]): void {
  const log = new SessionLog(ID, { seed });
  expect(seed.length).toBeGreaterThan(0);
  for (const [index, event] of seed.entries()) expect(log.events[index]).toBe(event);
}

describe('續接交出的事件當 seed', () => {
  it('新讀', async () => {
    await plant(CLOSED_TURN);
    const resumed = await store().resume(ID);
    try {
      expectAdoptedAsIs(resumed.events);
    } finally {
      await resumed.stored.close();
    }
  });

  it('冷讀快取命中', async () => {
    await plant(CLOSED_TURN);
    const sessions = store();
    const read = await (await sessions.open(ID, 'read')).read();
    const resumed = await sessions.resume(ID);
    try {
      expect(resumed.events).toBe(read);
      expectAdoptedAsIs(resumed.events);
    } finally {
      await resumed.stored.close();
    }
  });

  it('舊兩檔遷移', async () => {
    const paths = legacyTwoFilePathsIn(dir, ID);
    await writeFile(
      paths.header,
      JSON.stringify({ ...HEADER, version: LEGACY_TWO_FILE_FORMAT_VERSION }),
    );
    await writeFile(paths.log, CLOSED_TURN);
    const resumed = await store().resume(ID);
    try {
      expectAdoptedAsIs(resumed.events);
    } finally {
      await resumed.stored.close();
    }
  });

  it('補了收尾的', async () => {
    await plant(OPEN_TURN);
    const resumed = await resumeClosingInterruptedTurn(store(), ID);
    try {
      expect(resumed.events.at(-1)?.type).toBe('turn/end');
      expectAdoptedAsIs(resumed.events);
    } finally {
      await resumed.stored.close();
    }
  });
});
