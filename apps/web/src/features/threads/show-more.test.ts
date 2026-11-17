// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { shownCount, showMore } from '@/features/threads/show-more';

/** 側欄每組先畫幾條（#2960）。列用位置代表：`mustShow` 收的是第幾條（從 1 數）要一定看得到。 */

const items = (count: number) => Array.from({ length: count }, (_, index) => index + 1);
const none = () => false;
const only =
  (...positions: number[]) =>
  (item: number) =>
    positions.includes(item);

describe('shownCount', () => {
  it('沒按過：先 10 條；不到 10 條就全部', () => {
    expect(shownCount(items(35), none, undefined)).toBe(10);
    expect(shownCount(items(7), none, undefined)).toBe(7);
  });

  it('35 條：10 → 按一次 30 → 再按一次 35（全部顯示完）', () => {
    const list = items(35);
    const first = shownCount(list, none, undefined);
    const second = shownCount(list, none, showMore(first));
    const third = shownCount(list, none, showMore(second));
    expect([first, second, third]).toEqual([10, 30, 35]);
  });

  it('第 40 條一定要看得到：不用按就延伸到 40', () => {
    expect(shownCount(items(80), only(40), undefined)).toBe(40);
  });

  it('自動延伸最多到 50：第 50 條包得到，第 51、60 條要靠按', () => {
    expect(shownCount(items(80), only(50), undefined)).toBe(50);
    expect(shownCount(items(80), only(51), undefined)).toBe(10);
    expect(shownCount(items(80), only(60), undefined)).toBe(10);
  });

  it('前 50 條裡有好幾條一定要看得到：延伸到最後那一條', () => {
    expect(shownCount(items(80), only(12, 30, 70), undefined)).toBe(30);
  });

  it('按過之後的水位與自動延伸取兩者大的', () => {
    expect(shownCount(items(80), only(40), 30)).toBe(40);
    expect(shownCount(items(80), only(40), 60)).toBe(60);
  });
});

describe('showMore', () => {
  it('每按一次多 20 條', () => {
    expect(showMore(10)).toBe(30);
    expect(showMore(40)).toBe(60);
  });
});
