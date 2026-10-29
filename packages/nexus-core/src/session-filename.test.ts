/**
 * 會話檔名的唯一定義（#1857 驗收 B）：三個檔名、由 header 檔名認回基底、其餘的檔一律不認。舊兩檔佈局（#1872）另外用
 * 字面量釘住：已出貨的資料就是這幾個檔名，寫方目前的佈局換掉時它不能跟著變。
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  encodeSegment,
  generationLogFilename,
  legacyTwoFileSessionFilenames,
  parseGenerationLogFilename,
  parseLegacyTwoFileHeaderFilename,
  parseSessionHeaderFilename,
  sessionDirectoryName,
  sessionFilenames,
} from './session-filename.js';

describe('legacyTwoFileSessionFilenames', () => {
  it('已出貨的三個檔名：<base>.header.json、<base>.jsonl、<base>.lock', () => {
    expect(legacyTwoFileSessionFilenames('cli%2frun-1')).toEqual({
      header: 'cli%2frun-1.header.json',
      log: 'cli%2frun-1.jsonl',
      lock: 'cli%2frun-1.lock',
    });
  });
});

describe('parseLegacyTwoFileHeaderFilename', () => {
  it('只認 header 檔，跟 legacyTwoFileSessionFilenames 互逆', () => {
    expect(parseLegacyTwoFileHeaderFilename('cli%2frun-1.header.json')).toBe('cli%2frun-1');
    expect(
      parseLegacyTwoFileHeaderFilename(legacyTwoFileSessionFilenames('cli%2frun-1').header),
    ).toBe('cli%2frun-1');
    for (const filename of [
      'cli.jsonl',
      'cli.lock',
      'cli.header.json.0123456789ab.tmp',
      'cli.jsonl.0123456789ab.tmp',
    ]) {
      expect(parseLegacyTwoFileHeaderFilename(filename)).toBeUndefined();
    }
  });
});

describe('sessionFilenames', () => {
  it('由基底給出 header、日誌、鎖檔三個檔名', () => {
    expect(sessionFilenames('cli')).toEqual({
      header: 'cli.header.json',
      log: 'cli.jsonl',
      lock: 'cli.lock',
    });
  });

  it('基底原樣接上，不再編碼（編碼歸後端的 safeBaseName）', () => {
    expect(sessionFilenames('cli%2frun-1').header).toBe('cli%2frun-1.header.json');
  });
});

describe('parseSessionHeaderFilename', () => {
  it('header 檔認回基底，跟 sessionFilenames 互逆', () => {
    expect(parseSessionHeaderFilename('cli.header.json')).toBe('cli');
    const base = 'thread-1%2frun-2';
    expect(parseSessionHeaderFilename(sessionFilenames(base).header)).toBe(base);
  });

  it.each([
    ['日誌本文', 'cli.jsonl'],
    ['鎖檔', 'cli.lock'],
    ['當機殘留的 header 暫存檔', 'cli.header.json.0123456789ab.tmp'],
    ['當機殘留的日誌暫存檔', 'cli.jsonl.0123456789ab.tmp'],
    ['不相干的檔', 'notes.json'],
  ])('%s不認：%s', (_what, filename) => {
    expect(parseSessionHeaderFilename(filename)).toBeUndefined();
  });
});

describe('encodeSegment', () => {
  it('安全的碼元原樣，其餘（含 ~）寫成 ~XXXX', () => {
    expect(encodeSegment('cli')).toBe('cli');
    expect(encodeSegment('t1/bg-1')).toBe('t1~002Fbg-1');
    expect(encodeSegment('a~b')).toBe('a~007Eb');
    expect(encodeSegment('Alpha_1.x')).toBe('Alpha_1.x');
    expect(encodeSegment('中')).toBe('~4E2D');
  });

  it('. 與 .. 整段編碼，不會變成路徑穿越', () => {
    expect(encodeSegment('.')).toBe('~002E');
    expect(encodeSegment('..')).toBe('~002E~002E');
    expect(encodeSegment('...')).toBe('...');
  });

  it('孤立的代理碼元照碼元編碼；跟剛好長得像編碼結果的字串不撞', () => {
    expect(encodeSegment('\ud800x')).toBe('~D800x');
    expect(encodeSegment('~D800x')).not.toBe(encodeSegment('\ud800x'));
  });

  it('空字串拋錯', () => {
    expect(() => encodeSegment('')).toThrow();
  });

  it('任何碼元單獨或接在任何碼元後面，都編不出單獨的 ~，也編不出結尾的 ~', () => {
    for (let code = 0; code <= 0xffff; code += 1) {
      const char = String.fromCharCode(code);
      for (const raw of [char, `a${char}`, `${char}a`]) {
        const encoded = encodeSegment(raw);
        expect(encoded).not.toBe('~');
        expect(encoded.endsWith('~')).toBe(false);
      }
    }
  });
});

describe('sessionDirectoryName', () => {
  it('不超過 120 字元就是 encodeSegment(id)', () => {
    expect(sessionDirectoryName('t1/bg-1')).toBe(encodeSegment('t1/bg-1'));
    const atLimit = 'a'.repeat(120);
    expect(sessionDirectoryName(atLimit)).toBe(atLimit);
  });

  it('超過 120 字元取前 96 字元、接 -、再接完整 id 的 SHA-256 前 12 位', () => {
    const id = `${'a'.repeat(120)}/${'中'.repeat(40)}`;
    const digest = createHash('sha256').update(id).digest('hex').slice(0, 12);
    expect(sessionDirectoryName(id)).toBe(`${'a'.repeat(96)}-${digest}`);
    expect(sessionDirectoryName('a'.repeat(121))).toHaveLength(96 + 1 + 12);
  });

  it('截短後前綴一樣的兩個 id 靠摘要分開；只差大小寫的兩個長 id 也分開', () => {
    const prefix = 'p'.repeat(130);
    expect(sessionDirectoryName(`${prefix}x`)).not.toBe(sessionDirectoryName(`${prefix}y`));
    expect(sessionDirectoryName(`${prefix}X`).toLowerCase()).not.toBe(
      sessionDirectoryName(`${prefix}x`).toLowerCase(),
    );
  });

  it('最壞的碼元也進得去 255 位元組的單段上限', () => {
    expect(Buffer.byteLength(sessionDirectoryName('中'.repeat(1000)))).toBeLessThanOrEqual(255);
  });

  it('空 id 對到 ~', () => {
    expect(sessionDirectoryName('')).toBe('~');
  });
});

describe('generationLogFilename／parseGenerationLogFilename', () => {
  it('互逆；版本 0 是 session.jsonl', () => {
    expect(generationLogFilename(0)).toBe('session.jsonl');
    expect(generationLogFilename(51)).toBe('session.v51.jsonl');
    for (const version of [0, 1, 51, Number.MAX_SAFE_INTEGER]) {
      expect(parseGenerationLogFilename(generationLogFilename(version))).toBe(version);
    }
  });

  it.each([-1, -0, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
    '版本不是非負安全整數就拋：%s',
    (version) => {
      expect(() => generationLogFilename(version)).toThrow(TypeError);
    },
  );

  it.each([
    'session.v0.jsonl',
    'session.v01.jsonl',
    'session.V1.jsonl',
    'session.v1.backup.jsonl',
    'session.migration.deadbeef.tmp.jsonl',
    'session.v1.jsonl.zstd',
    'session.v9007199254740992.jsonl',
    'session.lock',
    'cli.jsonl',
  ])('不是正規世代檔名就不認：%s', (filename) => {
    expect(parseGenerationLogFilename(filename)).toBeUndefined();
  });
});
