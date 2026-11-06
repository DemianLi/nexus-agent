/**
 * 嵌入身分對應表（[#2370](https://github.com/DemianLi/nexus-agent/issues/2370)，#1827 D231）：啟動時的檢查、查表、跑著時重讀。
 * 接進 serve 的部分在 `serve-embed-login.test.ts`。
 */

import { chmodSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  EMBED_IDENTITIES_FILE,
  EmbedIdentityTable,
  IDENTITY_TABLE_STAT_INTERVAL_MS,
  MAX_IDENTITY_TABLE_BYTES,
} from './embed-identities.js';

const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const EMBEDDERS = ['crm', 'erp'];
const posixOnly = it.skipIf(process.platform === 'win32');

function tableFile(content: unknown, mode = 0o600): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-embed-identities-'));
  temporary.push(dir);
  const file = join(dir, EMBED_IDENTITIES_FILE);
  write(file, content, mode);
  return file;
}

function write(file: string, content: unknown, mode = 0o600): void {
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content), { mode });
  chmodSync(file, mode);
}

/** 讓下一次 stat 看得出檔變了（同一毫秒內改兩次時 mtime 可能一樣）。 */
function touchLater(file: string, seconds: number): void {
  const at = new Date(Date.now() + seconds * 1000);
  utimesSync(file, at, at);
}

const TABLE = {
  version: 1,
  mappings: [
    { embedder: 'crm', subject: 'alice', userId: 'alice' },
    { embedder: 'erp', subject: 'A12345', userId: 'alice' },
    { embedder: 'crm', subject: 'Bob', userId: 'bob.chen' },
  ],
};

describe('啟動時讀表', () => {
  it('合規的表：照原樣查，大小寫不同、別的嵌入方、不在表上的都是 not_mapped', () => {
    const table = EmbedIdentityTable.load(tableFile(TABLE), EMBEDDERS);
    expect(table.size).toBe(3);
    expect(table.resolve('crm', 'alice')).toEqual({ kind: 'accepted', userId: 'alice' });
    expect(table.resolve('erp', 'A12345')).toEqual({ kind: 'accepted', userId: 'alice' });
    expect(table.resolve('crm', 'Bob')).toEqual({ kind: 'accepted', userId: 'bob.chen' });
    for (const [embedder, subject] of [
      ['crm', 'bob'],
      ['erp', 'alice'],
      ['crm', 'carol'],
    ] as const) {
      expect(table.resolve(embedder, subject)).toEqual({ kind: 'rejected', reason: 'not_mapped' });
    }
  });

  it('空的 mappings 合規：誰都 not_mapped', () => {
    const table = EmbedIdentityTable.load(tableFile({ version: 1, mappings: [] }), EMBEDDERS);
    expect(table.size).toBe(0);
    expect(table.resolve('crm', 'alice')).toEqual({ kind: 'rejected', reason: 'not_mapped' });
  });

  it('檔不在：拋，講要由管理者寫、serve 不建', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-embed-identities-'));
    temporary.push(dir);
    const file = join(dir, EMBED_IDENTITIES_FILE);
    expect(() => EmbedIdentityTable.load(file, EMBEDDERS)).toThrow(
      /嵌入身分對應表 .*embed-identities\.json 不存在.*serve 不會替你建/u,
    );
  });

  posixOnly('權限過寬：拋，指名檔', () => {
    const file = tableFile(TABLE, 0o644);
    expect(() => EmbedIdentityTable.load(file, EMBEDDERS)).toThrow(file);
  });

  it('太大：拋', () => {
    const file = tableFile(' '.repeat(MAX_IDENTITY_TABLE_BYTES + 1));
    expect(() => EmbedIdentityTable.load(file, EMBEDDERS)).toThrow(/超過/u);
  });

  const secret = 'carol-secret-account';
  it.each([
    ['不是 JSON', '{', /不是合法的 JSON/u],
    ['頂層多欄位', { ...TABLE, extra: 1 }, /頂層/u],
    ['版本不對', { ...TABLE, version: 2 }, /version 要是 1/u],
    ['mappings 不是陣列', { version: 1, mappings: {} }, /mappings 要是陣列/u],
    [
      '一筆多欄位',
      { version: 1, mappings: [{ embedder: 'crm', subject: secret, userId: 'carol', note: 'x' }] },
      /第 1 筆要剛好是/u,
    ],
    [
      '不認得的嵌入方',
      { version: 1, mappings: [{ embedder: 'hr', subject: secret, userId: 'carol' }] },
      /第 1 筆的 embedder/u,
    ],
    [
      'subject 空',
      { version: 1, mappings: [{ embedder: 'crm', subject: '', userId: 'carol' }] },
      /第 1 筆的 subject/u,
    ],
    [
      'subject 太長',
      { version: 1, mappings: [{ embedder: 'crm', subject: 'a'.repeat(257), userId: 'carol' }] },
      /第 1 筆的 subject/u,
    ],
    [
      'userId 有大寫',
      { version: 1, mappings: [{ embedder: 'crm', subject: secret, userId: 'Carol' }] },
      /第 1 筆的 userId/u,
    ],
    [
      'userId 以點開頭',
      { version: 1, mappings: [{ embedder: 'crm', subject: secret, userId: '..' }] },
      /第 1 筆的 userId/u,
    ],
    [
      'userId 太長',
      { version: 1, mappings: [{ embedder: 'crm', subject: secret, userId: 'a'.repeat(65) }] },
      /第 1 筆的 userId/u,
    ],
    [
      '(embedder, subject) 重複',
      {
        version: 1,
        mappings: [
          { embedder: 'crm', subject: secret, userId: 'carol' },
          { embedder: 'erp', subject: secret, userId: 'carol' },
          { embedder: 'crm', subject: secret, userId: 'dave' },
        ],
      },
      /第 3 筆與第 1 筆的 embedder 與 subject 重複/u,
    ],
  ])('不合規（%s）：拋，指名檔與第幾筆，不帶 subject 的值', (_name, content, pattern) => {
    const file = tableFile(content);
    let message = '';
    try {
      EmbedIdentityTable.load(file, EMBEDDERS);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(pattern);
    expect(message).toContain(file);
    expect(message).not.toContain(secret);
  });
});

describe('has：驗嵌入 cookie 用', () => {
  it('(embedder, subject) 現在對到的正是那個 userId 才算', () => {
    const table = EmbedIdentityTable.load(tableFile(TABLE), EMBEDDERS);
    expect(table.has({ embedder: 'crm', subject: 'alice', userId: 'alice' })).toBe(true);
    expect(table.has({ embedder: 'crm', subject: 'alice', userId: 'bob.chen' })).toBe(false);
    expect(table.has({ embedder: 'crm', subject: 'carol', userId: 'carol' })).toBe(false);
  });
});

describe('跑著時重讀', () => {
  function running(file: string) {
    let now = 0;
    const warnings: string[] = [];
    const table = EmbedIdentityTable.load(file, EMBEDDERS, {
      warn: (message) => warnings.push(message),
      monotonicNow: () => now,
    });
    return {
      table,
      warnings,
      advance: (ms = IDENTITY_TABLE_STAT_INTERVAL_MS) => {
        now += ms;
      },
    };
  }

  it('改表不用重啟：stat 間隔內沿用，過了間隔、檔變了才重讀', () => {
    const file = tableFile(TABLE);
    const { table, advance } = running(file);
    write(file, { version: 1, mappings: [{ embedder: 'crm', subject: 'carol', userId: 'carol' }] });
    touchLater(file, 5);
    expect(table.resolve('crm', 'carol').kind).toBe('rejected');
    advance(IDENTITY_TABLE_STAT_INTERVAL_MS - 1);
    expect(table.resolve('crm', 'carol').kind).toBe('rejected');
    advance(1);
    expect(table.resolve('crm', 'carol')).toEqual({ kind: 'accepted', userId: 'carol' });
    expect(table.resolve('crm', 'alice')).toEqual({ kind: 'rejected', reason: 'not_mapped' });
    expect(table.has({ embedder: 'crm', subject: 'alice', userId: 'alice' })).toBe(false);
  });

  it('改壞：一律 identity_table_invalid，has 也是 false；修好之後自動恢復；壞與好各講一次', () => {
    const file = tableFile(TABLE);
    const { table, warnings, advance } = running(file);
    write(file, '{');
    touchLater(file, 5);
    advance();
    expect(table.resolve('crm', 'alice')).toEqual({
      kind: 'rejected',
      reason: 'identity_table_invalid',
    });
    expect(table.has({ embedder: 'crm', subject: 'alice', userId: 'alice' })).toBe(false);
    expect(table.size).toBeUndefined();
    advance();
    table.resolve('crm', 'alice');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('不是合法的 JSON');

    write(file, TABLE);
    touchLater(file, 10);
    advance();
    expect(table.resolve('crm', 'alice')).toEqual({ kind: 'accepted', userId: 'alice' });
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain('恢復');
  });

  it('被刪：一律拒；放回來恢復', () => {
    const file = tableFile(TABLE);
    const { table, advance } = running(file);
    unlinkSync(file);
    advance();
    expect(table.resolve('crm', 'alice').kind).toBe('rejected');
    write(file, TABLE);
    advance();
    expect(table.resolve('crm', 'alice')).toEqual({ kind: 'accepted', userId: 'alice' });
  });

  posixOnly('權限被放寬：一律拒（內容沒變也一樣）；改回 0600 恢復', () => {
    const file = tableFile(TABLE);
    const { table, advance } = running(file);
    chmodSync(file, 0o644);
    advance();
    expect(table.resolve('crm', 'alice')).toEqual({
      kind: 'rejected',
      reason: 'identity_table_invalid',
    });
    chmodSync(file, 0o600);
    advance();
    expect(table.resolve('crm', 'alice')).toEqual({ kind: 'accepted', userId: 'alice' });
  });

  it('檔沒變就不重讀：重讀失敗的訊息不會每個請求都講一次', () => {
    const file = tableFile(TABLE);
    const { table, warnings, advance } = running(file);
    write(file, { version: 9, mappings: [] });
    touchLater(file, 5);
    for (let index = 0; index < 5; index += 1) {
      advance();
      table.resolve('crm', 'alice');
    }
    expect(warnings).toHaveLength(1);
  });
});
