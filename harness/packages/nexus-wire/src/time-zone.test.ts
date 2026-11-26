import { describe, expect, it } from 'vitest';

import { canonicalClientTimeZone } from './time-zone.js';

describe('canonicalClientTimeZone', () => {
  it('UTC 與正規的 IANA 名原樣收下', () => {
    expect(canonicalClientTimeZone('UTC')).toBe('UTC');
    expect(canonicalClientTimeZone('Asia/Taipei')).toBe('Asia/Taipei');
  });

  it('別名收斂成同一個名字，而且收斂後的名字再正規化一次不變（冪等）', () => {
    // 「正規名」是這個執行期的 `Intl` 說了算（Node 25 把 Asia/Kolkata 收成 Asia/Calcutta，別的版本可能反過來），
    // 所以斷言的是性質，不是哪個字串。
    const viaOld = canonicalClientTimeZone('Asia/Calcutta');
    const viaNew = canonicalClientTimeZone('Asia/Kolkata');
    expect(viaOld).toBeDefined();
    expect(viaNew).toBe(viaOld);
    expect(canonicalClientTimeZone(viaOld as string)).toBe(viaOld);
  });

  it.each([
    ['空字串', ''],
    ['前後有空白', ' Asia/Taipei'],
    ['後面有空白', 'Asia/Taipei '],
    ['沒有 Area/Location 結構', 'Taipei'],
    ['小寫的 utc', 'utc'],
    ['偏移量寫法', '+08:00'],
    ['格式像但系統不認得', 'Mars/Olympus_Mons'],
    ['夾帶控制字元', 'Asia/Taipei\n'],
  ])('%s：回 undefined', (_label, value) => {
    expect(canonicalClientTimeZone(value)).toBeUndefined();
  });
});
