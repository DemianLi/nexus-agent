/**
 * 變更紀錄本身（[#1412](https://github.com/DemianLi/nexus-agent/issues/1412)）：格式、折疊、追加、鎖、壞掉的行。
 *
 * 驗收表的 F（並發）、G（壞掉的行）在這裡；遷移在 `plugin-journal-migration.test.ts`，寫入口在 `plugin-change.test.ts`。
 * [#1414](https://github.com/DemianLi/nexus-agent/issues/1414) 的兩種只記不折的筆（`rejected`、`failed`）：驗收 H
 * 與「歸因到哪一筆」的判定。
 */

import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  appendJournalRecord,
  failureTriggerOf,
  foldJournal,
  hasFailedRecord,
  isAcceptedRecord,
  journalOverrideOf,
  parseJournal,
  PluginJournalError,
  readJournal,
  withFileLock,
} from './plugin-journal.js';
import type { JournalActor, JournalBody, JournalRecord } from './plugin-journal.js';

const run = promisify(execFile);
const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dir(): string {
  const root = mkdtempSync(join(tmpdir(), 'nexus-journal-'));
  chmodSync(root, 0o700);
  temporary.push(root);
  return root;
}

const ACTOR: JournalActor = {
  kind: 'host-account',
  effective: 'svc',
  invoker: 'alice',
  invokerSource: 'SUDO_USER',
};

const AT = '2026-10-13T00:00:00.000Z';

function record(seq: number, body: JournalBody): JournalRecord {
  return { v: 1, seq, at: AT, actor: ACTOR, ...body } as JournalRecord;
}

function lines(...records: JournalRecord[]): string {
  return records.map((entry) => `${JSON.stringify(entry)}\n`).join('');
}

const DISABLE_TODO: JournalBody = {
  op: 'disable',
  id: 'todo',
  name: '@nexus/plugin-todo',
  before: false,
  after: true,
};

describe('解析（驗收 G）', () => {
  it('最後一行沒有換行：略過，哪怕它剛好是合法的 JSON', () => {
    const complete = lines(record(1, DISABLE_TODO));
    const partial = JSON.stringify(
      record(2, { ...DISABLE_TODO, op: 'enable', before: true, after: false }),
    );
    const parsed = parseJournal(Buffer.from(complete + partial), 'j');
    expect(parsed.records).toHaveLength(1);
    expect(parsed.incompleteTail).toBe(true);
    expect(parsed.completeBytes).toBe(Buffer.byteLength(complete));
  });

  it('最後一行寫到一半（不是合法 JSON、沒有換行）：略過，不拋', () => {
    const complete = lines(record(1, DISABLE_TODO));
    const parsed = parseJournal(Buffer.from(`${complete}{"v":1,"seq":2,"at":"2026`), 'j');
    expect(parsed.records).toHaveLength(1);
    expect(parsed.incompleteTail).toBe(true);
  });

  it('中間一行壞掉：拋，指名第幾行', () => {
    const text = `${lines(record(1, DISABLE_TODO))}{壞掉\n${lines(record(3, DISABLE_TODO))}`;
    expect(() => parseJournal(Buffer.from(text), '/home/plugin-journal.jsonl')).toThrow(
      /\/home\/plugin-journal\.jsonl 第 2 行不是合法的 JSON/u,
    );
  });

  it('序號跳號、倒退、重複：拋，指名第幾行與應有的序號', () => {
    const gap = lines(record(1, DISABLE_TODO), record(3, DISABLE_TODO));
    expect(() => parseJournal(Buffer.from(gap), 'j')).toThrow(/第 2 行的序號是 3，應該是 2/u);
    const back = lines(record(1, DISABLE_TODO), record(2, DISABLE_TODO), record(1, DISABLE_TODO));
    expect(() => parseJournal(Buffer.from(back), 'j')).toThrow(/第 3 行的序號是 1，應該是 3/u);
  });

  it('多一個欄位、少一個欄位、空行：都是壞行', () => {
    const extra = `${JSON.stringify({ ...record(1, DISABLE_TODO), surprise: 1 })}\n`;
    expect(() => parseJournal(Buffer.from(extra), 'j')).toThrow(/第 1 行不是一筆合法的紀錄/u);
    const missing = `${JSON.stringify({ v: 1, seq: 1, op: 'disable' })}\n`;
    expect(() => parseJournal(Buffer.from(missing), 'j')).toThrow(/第 1 行不是一筆合法的紀錄/u);
    expect(() => parseJournal(Buffer.from(`${lines(record(1, DISABLE_TODO))}\n`), 'j')).toThrow(
      /第 2 行不是合法的 JSON（空行）/u,
    );
  });

  it('檔案不在：undefined；權限檢查在讀完之後、解析之前', () => {
    const root = dir();
    expect(readJournal(join(root, 'nope.jsonl'))).toBeUndefined();
    const path = join(root, 'j.jsonl');
    writeFileSync(path, lines(record(1, DISABLE_TODO)), { mode: 0o600 });
    expect(() =>
      readJournal(path, {
        check: () => {
          throw new Error('別人動得了');
        },
      }),
    ).toThrow('別人動得了');
  });
});

describe('折疊：一列一條覆蓋項，照 dsh', () => {
  const NAME = '@nexus/plugin-todo';

  it('停用再啟用同一列：只剩一條，disabled 是 false', () => {
    const patches = foldJournal([
      DISABLE_TODO,
      { op: 'enable', id: 'todo', name: NAME, before: true, after: false },
    ]);
    expect(patches).toEqual([{ id: 'todo', disabled: false }]);
  });

  it('同一列改設定兩次：後一次蓋掉前一次，不長筆數', () => {
    const patches = foldJournal([
      { op: 'config-set', id: 'todo', name: NAME, before: null, after: { a: 1 } },
      { op: 'config-set', id: 'todo', name: NAME, before: { a: 1 }, after: { b: 2 } },
    ]);
    expect(patches).toEqual([{ id: 'todo', name: NAME, config: { b: 2 } }]);
  });

  it('開關與設定落在同一條覆蓋項上', () => {
    const patches = foldJournal([
      DISABLE_TODO,
      { op: 'config-set', id: 'todo', name: NAME, before: null, after: { a: 1 } },
    ]);
    expect(patches).toEqual([{ id: 'todo', disabled: true, config: { a: 1 } }]);
  });

  it('恢復成繼承值：拿掉 config 覆蓋，不是抄一份；只剩 id／name 的整條拿掉，disabled 留著', () => {
    const set: JournalBody = {
      op: 'config-set',
      id: 'todo',
      name: NAME,
      before: null,
      after: { a: 1 },
    };
    const reset: JournalBody = {
      op: 'config-reset',
      id: 'todo',
      name: NAME,
      before: { a: 1 },
      // 紀錄裡記著當時的繼承值，折疊不能用它。
      after: { shipped: 'default-at-that-time' },
    };
    expect(foldJournal([set, reset])).toEqual([]);
    expect(foldJournal([DISABLE_TODO, set, reset])).toEqual([{ id: 'todo', disabled: true }]);
  });

  it('遷移來的 patch 原樣保留位置；後來的操作改它最後一條相符的覆蓋項，不動 insert', () => {
    const patches = foldJournal([
      { op: 'patch', patch: { insert: [{ id: 'extra', name: 'file:///x.ts' }] } },
      { op: 'patch', patch: { id: 'extra', config: { n: 1 } } },
      { op: 'config-set', id: 'extra', name: 'file:///x.ts', before: { n: 1 }, after: { n: 2 } },
    ]);
    expect(patches).toEqual([
      { insert: [{ id: 'extra', name: 'file:///x.ts' }] },
      { id: 'extra', config: { n: 2 } },
    ]);
    expect(
      journalOverrideOf([{ op: 'patch', patch: { id: 'x', config: { a: 1 } } }], 'x', 'n'),
    ).toEqual({
      config: { a: 1 },
    });
  });

  it('name 斷言對不上的覆蓋項不是同一列：另起一條', () => {
    const patches = foldJournal([
      { op: 'patch', patch: { id: 'todo', name: '@other/module', config: { a: 1 } } },
      { op: 'config-set', id: 'todo', name: NAME, before: null, after: { b: 2 } },
    ]);
    expect(patches).toHaveLength(2);
  });

  it('name 是空字串的覆蓋項：折疊與 journalOverrideOf 同一個答案——都不當成這一列的（不是「沒寫」）', () => {
    const records: JournalBody[] = [
      { op: 'patch', patch: { id: 'todo', name: '', config: { a: 1 } } },
      { op: 'config-set', id: 'todo', name: NAME, before: null, after: { b: 2 } },
    ];
    expect(foldJournal(records)).toHaveLength(2);
    expect(journalOverrideOf(records, 'todo', NAME)).toEqual({ config: { b: 2 } });
  });

  it('不改輸入', () => {
    const body: JournalBody = { op: 'patch', patch: { id: 'a', config: { x: { y: 1 } } } };
    const before = JSON.stringify(body);
    const [out] = foldJournal([body, DISABLE_TODO]);
    (out?.['config'] as { x: { y: number } }).x.y = 99;
    expect(JSON.stringify(body)).toBe(before);
  });
});

describe('追加', () => {
  it('建檔 0600、序號從 1、帶時間與 actor；驗證（prepare）拋了就一個位元組都不寫', async () => {
    const root = dir();
    const path = join(root, 'j.jsonl');
    const first = await appendJournalRecord(
      path,
      { actor: ACTOR, now: () => new Date(AT) },
      () => DISABLE_TODO,
    );
    expect(first).toMatchObject({ seq: 1, at: AT, actor: ACTOR, op: 'disable', id: 'todo' });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const before = readFileSync(path);

    await expect(
      appendJournalRecord(path, { actor: ACTOR }, () => {
        throw new Error('驗不過');
      }),
    ).rejects.toThrow('驗不過');
    expect(readFileSync(path).equals(before)).toBe(true);

    // prepare 回 undefined：什麼都不寫。
    expect(await appendJournalRecord(path, { actor: ACTOR }, () => undefined)).toBeUndefined();
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it('prepare 拿到的是鎖裡讀到的現有紀錄', async () => {
    const root = dir();
    const path = join(root, 'j.jsonl');
    await appendJournalRecord(path, { actor: ACTOR }, () => DISABLE_TODO);
    let seen = 0;
    await appendJournalRecord(path, { actor: ACTOR }, (records) => {
      seen = records.length;
      return { ...DISABLE_TODO, op: 'enable', before: true, after: false } as JournalBody;
    });
    expect(seen).toBe(1);
  });

  it('現有紀錄壞了：不在壞掉的檔後面追加', async () => {
    const root = dir();
    const path = join(root, 'j.jsonl');
    writeFileSync(path, `${lines(record(1, DISABLE_TODO))}{壞\n`, { mode: 0o600 });
    const before = readFileSync(path);
    await expect(appendJournalRecord(path, { actor: ACTOR }, () => DISABLE_TODO)).rejects.toThrow(
      PluginJournalError,
    );
    expect(readFileSync(path).equals(before)).toBe(true);
  });
});

describe('並發（驗收 F）', () => {
  it('同一個行程裡 25 個寫入同時進來：25 筆都在、序號嚴格遞增、沒有遺失', async () => {
    const root = dir();
    const path = join(root, 'j.jsonl');
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        appendJournalRecord(path, { actor: ACTOR }, () => ({
          op: 'config-set',
          id: `row-${String(index)}`,
          name: 'm',
          before: null,
          after: { index },
        })),
      ),
    );
    expect(results.every((entry) => entry !== undefined)).toBe(true);
    const contents = readJournal(path);
    expect(contents?.records.map((entry) => entry.seq)).toEqual(
      Array.from({ length: 25 }, (_, index) => index + 1),
    );
    const ids = new Set(contents?.records.map((entry) => ('id' in entry ? entry.id : '')));
    expect(ids.size).toBe(25);
  });

  it('三個行程各寫 8 筆：24 筆都在、序號 1..24、沒有半筆', async () => {
    const root = dir();
    const path = join(root, 'j.jsonl');
    const child = fileURLToPath(new URL('./plugin-journal.child.fixture.ts', import.meta.url));
    await Promise.all(
      ['a', 'b', 'c'].map((tag) =>
        run(process.execPath, ['--import', 'tsx', child, path, tag, '8'], { timeout: 60_000 }),
      ),
    );
    const contents = readJournal(path);
    expect(contents?.incompleteTail).toBe(false);
    expect(contents?.records.map((entry) => entry.seq)).toEqual(
      Array.from({ length: 24 }, (_, index) => index + 1),
    );
    for (const tag of ['a', 'b', 'c']) {
      const mine = contents?.records.filter(
        (entry) => 'id' in entry && entry.id.startsWith(`${tag}-`),
      );
      expect(mine).toHaveLength(8);
    }
  }, 90_000);

  it('讀端不取鎖：持鎖期間照讀，從不讀到半筆', async () => {
    const root = dir();
    const path = join(root, 'j.jsonl');
    await appendJournalRecord(path, { actor: ACTOR }, () => DISABLE_TODO);
    let readDuring: number | undefined;
    await withFileLock(path, async () => {
      readDuring = readJournal(path)?.records.length;
    });
    expect(readDuring).toBe(1);
  });

  it('持有者行程不在了：接手那把鎖', async () => {
    const root = dir();
    const path = join(root, 'j.jsonl');
    // 一個確定不存在的 PID。
    writeFileSync(`${path}.lock`, '2147483646\n');
    const written = await appendJournalRecord(
      path,
      { actor: ACTOR, waitMs: 5_000 },
      () => DISABLE_TODO,
    );
    expect(written?.seq).toBe(1);
  });

  it('持有者還活著：等到逾時，訊息指名鎖檔', async () => {
    const root = dir();
    const path = join(root, 'j.jsonl');
    writeFileSync(`${path}.lock`, `${String(process.pid)}\n`);
    await expect(withFileLock(path, async () => 1, { waitMs: 150 })).rejects.toThrow(/等不到/u);
    rmSync(`${path}.lock`);
  });
});

describe('寫到一半當掉之後（加 9）', () => {
  it('下一次寫入先截掉那半行再追加、stderr 記一句；讀端在這之前就略過它，啟動不受影響', async () => {
    const root = dir();
    const path = join(root, 'j.jsonl');
    const complete = lines(record(1, DISABLE_TODO));
    const crashed = JSON.stringify(record(2, DISABLE_TODO)).slice(0, 40);
    writeFileSync(path, complete + crashed, { mode: 0o600 });

    // 當掉之後、下一次寫入之前：讀端看到的是第 1 筆。
    expect(readJournal(path)?.records).toHaveLength(1);

    const warnings: string[] = [];
    const written = await appendJournalRecord(
      path,
      { actor: ACTOR, warn: (message) => warnings.push(message) },
      () => ({ ...DISABLE_TODO, op: 'enable', before: true, after: false }) as JournalBody,
    );
    expect(written?.seq).toBe(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('沒有寫完');

    const contents = readJournal(path);
    expect(contents?.incompleteTail).toBe(false);
    expect(contents?.records.map((entry) => entry.op)).toEqual(['disable', 'enable']);
    // 不是黏成一行壞資料：每一行都是完整的 JSON。
    for (const line of readFileSync(path, 'utf8').trimEnd().split('\n')) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

describe('rejected、failed：只記不折（#1414 驗收 H）', () => {
  const REJECTED: JournalBody = {
    op: 'rejected',
    requested: 'disable',
    id: 'browser-session',
    reason: '關不掉',
  };
  const FAILED: JournalBody = {
    op: 'failed',
    id: 'todo',
    triggerSeq: 1,
    stage: 'apply',
    reason: '掛上時失敗',
  };
  const SERVE: JournalActor = { kind: 'serve', effective: 'svc' };

  const BASE: JournalBody[] = [
    DISABLE_TODO,
    { op: 'config-set', id: 'limit', name: '@nexus/plugin-limit', before: null, after: { n: 1 } },
    { op: 'enable', id: 'todo', name: '@nexus/plugin-todo', before: true, after: false },
    { op: 'config-reset', id: 'limit', name: '@nexus/plugin-limit', before: { n: 1 }, after: null },
    { op: 'patch', patch: { id: 'skills', disabled: true } },
  ];

  it('夾在中間：折出來的清單跟沒有它們時相同；序號照樣從 1 連續', () => {
    // 一筆「寫了就會讓 todo 停用」的 rejected 夾在 enable 之前：被折進去的話最後 todo 會是停用。
    const noisy: JournalBody[] = [
      BASE[0] as JournalBody,
      { ...REJECTED, id: 'todo', requested: 'disable' },
      BASE[1] as JournalBody,
      { ...FAILED, id: 'limit', triggerSeq: 3 },
      BASE[2] as JournalBody,
      { ...REJECTED, requested: 'config-reset', id: 'limit' },
      BASE[3] as JournalBody,
      BASE[4] as JournalBody,
    ];
    expect(foldJournal(noisy)).toEqual(foldJournal(BASE));
    expect(journalOverrideOf(noisy, 'todo', '@nexus/plugin-todo')).toEqual(
      journalOverrideOf(BASE, 'todo', '@nexus/plugin-todo'),
    );
    const text = noisy
      .map((body, index) =>
        record(index + 1, body).op === 'failed'
          ? { ...record(index + 1, body), actor: SERVE }
          : record(index + 1, body),
      )
      .map((entry) => `${JSON.stringify(entry)}\n`)
      .join('');
    const parsed = parseJournal(Buffer.from(text), 'journal');
    expect(parsed.records.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(foldJournal(parsed.records)).toEqual(foldJournal(BASE));
  });

  it('failed 指向的必須是更早、被接受的那一筆：指向自己、未來、rejected 都是壞掉的檔', () => {
    const point = (triggerSeq: number, ...before: JournalRecord[]): string =>
      lines(...before, { ...record(before.length + 1, { ...FAILED, triggerSeq }), actor: SERVE });
    expect(() => parseJournal(Buffer.from(point(1, record(1, DISABLE_TODO))), 'j')).not.toThrow();
    expect(() => parseJournal(Buffer.from(point(2, record(1, DISABLE_TODO))), 'j')).toThrow(
      /指向第 2 筆/u,
    );
    expect(() => parseJournal(Buffer.from(point(5, record(1, DISABLE_TODO))), 'j')).toThrow(
      /還不存在/u,
    );
    expect(() => parseJournal(Buffer.from(point(1, record(1, REJECTED))), 'j')).toThrow(
      /不是被接受的改動/u,
    );
  });

  it('多一個欄位（把要寫入的值塞進 rejected）算壞掉的檔', () => {
    const text = lines(record(1, { ...REJECTED, after: { secret: 1 } } as unknown as JournalBody));
    expect(() => parseJournal(Buffer.from(text), 'j')).toThrow(PluginJournalError);
  });

  it('寫端：rejected 與 failed 都佔序號，鎖裡讀到的是現有那份', async () => {
    const root = dir();
    const path = join(root, 'plugin-journal.jsonl');
    const first = await appendJournalRecord(path, { actor: ACTOR }, () => DISABLE_TODO);
    const second = await appendJournalRecord(path, { actor: ACTOR }, () => REJECTED);
    const third = await appendJournalRecord(path, { actor: SERVE }, (records) => {
      expect(records.map((entry) => entry.op)).toEqual(['disable', 'rejected']);
      return FAILED;
    });
    expect([first?.seq, second?.seq, third?.seq]).toEqual([1, 2, 3]);
    expect(readJournal(path)?.records.map((entry) => entry.op)).toEqual([
      'disable',
      'rejected',
      'failed',
    ]);
  });
});

describe('isAcceptedRecord：哪些 op 算被接受的（#1423）', () => {
  // 逐一列舉：每一種 op 一列，新增 op 時 `JournalRecord['op']` 的聯集會逼這張表補一格。
  const EXPECTED: Record<JournalRecord['op'], boolean> = {
    disable: true,
    enable: true,
    'config-set': true,
    'config-reset': true,
    patch: true,
    rejected: false,
    failed: false,
  };

  it.each(Object.entries(EXPECTED))('%s → %s', (op, accepted) => {
    expect(isAcceptedRecord({ op: op as JournalRecord['op'] })).toBe(accepted);
  });
});

describe('failureTriggerOf：失敗記在哪一筆上（#1414 Q2）', () => {
  const CONTEXT = { discoveredAt: 'reread' } as const;
  const TODO = { id: 'todo', module: '@nexus/plugin-todo' };
  const patchOf = (seq: number, patch: Record<string, unknown>): JournalRecord =>
    record(seq, { op: 'patch', patch });

  it('最後一筆碰到那一列、被接受的紀錄；rejected 與 failed 不算', () => {
    const records = [
      record(1, DISABLE_TODO),
      record(2, { op: 'config-set', id: 'other', name: 'x', before: null, after: {} }),
      record(3, { op: 'rejected', requested: 'config-set', id: 'todo', reason: 'x' }),
      record(4, { op: 'failed', id: 'todo', triggerSeq: 1, stage: 'apply', reason: 'x' }),
    ];
    expect(failureTriggerOf(records, TODO, CONTEXT)).toBe(1);
    expect(failureTriggerOf(records, { id: 'nobody', module: 'x' }, CONTEXT)).toBeUndefined();
  });

  it('紀錄裡沒有任何一筆指到它：不記（只被出貨設定或 --patch 影響）', () => {
    expect(failureTriggerOf([], TODO, CONTEXT)).toBeUndefined();
    expect(
      failureTriggerOf([record(1, { ...DISABLE_TODO, id: 'skills' })], TODO, CONTEXT),
    ).toBeUndefined();
  });

  it('遷移來的 patch 也算：改既有列、insert 有 id 的列、insert 沒寫 id 的列用模組名比', () => {
    const records = [
      patchOf(1, { id: 'todo', config: { a: 1 } }),
      patchOf(2, {
        insert: [
          { id: 'probe-a', name: 'file:///p/a.ts' },
          { id: 'probe-b', name: 'file:///p/b.ts' },
          { name: 'file:///p/anon.ts' },
        ],
      }),
    ];
    expect(failureTriggerOf(records, TODO, CONTEXT)).toBe(1);
    // 同一筆 insert 讓好幾列掛不上：每一列各自指到它。
    expect(failureTriggerOf(records, { id: 'probe-a', module: 'file:///p/a.ts' }, CONTEXT)).toBe(2);
    expect(failureTriggerOf(records, { id: 'probe-b', module: 'file:///p/b.ts' }, CONTEXT)).toBe(2);
    // 沒寫 id：載入器補的是 `<name>#<n>`，用模組名對。
    expect(failureTriggerOf(records, { id: 'x#0', module: 'file:///p/anon.ts' }, CONTEXT)).toBe(2);
  });

  it('跟折疊共用 name 斷言：斷言的模組名對不上的 patch、config-set 不算碰到它', () => {
    const records = [
      patchOf(1, { id: 'todo', name: '@nexus/another', disabled: true }),
      record(2, { op: 'config-set', id: 'todo', name: '@nexus/another', before: null, after: {} }),
    ];
    expect(failureTriggerOf(records, TODO, CONTEXT)).toBeUndefined();
    // config-reset 照折疊的規矩，不看 name。
    const withReset = [
      ...records,
      record(3, {
        op: 'config-reset',
        id: 'todo',
        name: '@nexus/another',
        before: {},
        after: null,
      }),
    ];
    expect(failureTriggerOf(withReset, TODO, CONTEXT)).toBe(3);
  });

  describe('依賴的列被關掉、掉在 requires（#1423）', () => {
    const A = { id: 'probe-a', module: './a.ts' };
    const FRESH_REQUIRES = {
      discoveredAt: 'thread-assembly',
      stage: 'requires',
      newlyDropped: true,
    } as const;
    // 紀錄裡沒有任何一筆指到 A；最新一筆被接受的是別的列的改動。
    const OTHERS = [
      record(1, DISABLE_TODO),
      record(2, { op: 'rejected', requested: 'config-set', id: 'todo', reason: 'x' }),
      record(3, { op: 'failed', id: 'skills', triggerSeq: 1, stage: 'apply', reason: 'x' }),
    ];

    it('四件事同時成立：歸因到紀錄裡最新一筆被接受的（rejected、failed 不算）', () => {
      // seq 3 是 failed、seq 2 是 rejected，都不算；最新被接受的是 seq 1。
      expect(failureTriggerOf(OTHERS, A, FRESH_REQUIRES)).toBe(1);
      expect(failureTriggerOf(OTHERS, A, { ...FRESH_REQUIRES, discoveredAt: 'reread' })).toBe(1);
      // 遷移來的 patch 也算被接受的。
      const withPatch = [
        ...OTHERS,
        record(4, { op: 'patch', patch: { id: 'skills', disabled: true } }),
      ];
      expect(failureTriggerOf(withPatch, A, FRESH_REQUIRES)).toBe(4);
    });

    it('少任何一件都不套：啟動試組、不是新掉、不是 requires、沒帶場面', () => {
      expect(
        failureTriggerOf(OTHERS, A, { ...FRESH_REQUIRES, discoveredAt: 'startup' }),
      ).toBeUndefined();
      expect(
        failureTriggerOf(OTHERS, A, { ...FRESH_REQUIRES, newlyDropped: false }),
      ).toBeUndefined();
      const { newlyDropped: _omitted, ...withoutFlag } = FRESH_REQUIRES;
      expect(failureTriggerOf(OTHERS, A, withoutFlag)).toBeUndefined();
      for (const stage of ['module', 'config', 'apply'] as const) {
        expect(failureTriggerOf(OTHERS, A, { ...FRESH_REQUIRES, stage })).toBeUndefined();
      }
      // 舊的呼叫端不帶 stage：照現行規則。
      expect(
        failureTriggerOf(OTHERS, A, { discoveredAt: 'thread-assembly', newlyDropped: true }),
      ).toBeUndefined();
    });

    it('這一列自己有被接受的改動：照現行規則歸因到它自己那一筆，不被「最新一筆」取代', () => {
      const own = [
        record(1, { op: 'patch', patch: { id: 'probe-a', disabled: false } }),
        ...OTHERS.map((r, i) => ({ ...r, seq: i + 2 }) as JournalRecord),
      ];
      expect(failureTriggerOf(own, A, FRESH_REQUIRES)).toBe(1);
      expect(failureTriggerOf(own, A, { discoveredAt: 'reread', stage: 'apply' })).toBe(1);
    });

    it('紀錄是空的：沒有任何一筆可歸因，不記', () => {
      expect(failureTriggerOf([], A, FRESH_REQUIRES)).toBeUndefined();
    });
  });

  it('hasFailedRecord：鍵是列 id 加歸因到的 seq', () => {
    const records = [
      record(1, DISABLE_TODO),
      { ...record(2, { op: 'failed', id: 'todo', triggerSeq: 1, stage: 'apply', reason: 'x' }) },
    ];
    expect(hasFailedRecord(records, 'todo', 1)).toBe(true);
    expect(hasFailedRecord(records, 'todo', 3)).toBe(false);
    expect(hasFailedRecord(records, 'skills', 1)).toBe(false);
  });
});
