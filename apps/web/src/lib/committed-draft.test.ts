import { describe, expect, it } from 'vitest';

import { retainedSuffix } from '@/lib/committed-draft';

/** 命令收下之後草稿留下什麼（#1941，照 dsh `facade.ts:715-722`）。 */
describe('retainedSuffix', () => {
  it.each([
    ['草稿就是送出的那一行 → 清空', '/compact', '/compact', ''],
    ['在途期間後面多打了字 → 只留多打的那段', '/compact 下一句', '/compact', ' 下一句'],
    ['草稿不以送出的那一行開頭 → 清空', '別的字 /compact', '/compact', ''],
    ['草稿已經是空的 → 清空', '', '/compact', ''],
  ])('%s', (_label, current, sent, kept) => {
    expect(retainedSuffix(current, sent)).toBe(kept);
  });
});
