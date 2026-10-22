/**
 * 會話檔名的唯一定義（#1857 驗收 B）：三個檔名、由 header 檔名認回基底、其餘的檔一律不認。
 */

import { describe, expect, it } from 'vitest';

import { parseSessionHeaderFilename, sessionFilenames } from './session-filename.js';

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
