/**
 * 會話檔名的唯一定義（#1857 驗收 B）：三個檔名、由 header 檔名認回基底、其餘的檔一律不認。舊兩檔佈局（#1872）另外用
 * 字面量釘住：已出貨的資料就是這幾個檔名，寫方目前的佈局換掉時它不能跟著變。
 */

import { describe, expect, it } from 'vitest';

import {
  legacyTwoFileSessionFilenames,
  parseLegacyTwoFileHeaderFilename,
  parseSessionHeaderFilename,
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
