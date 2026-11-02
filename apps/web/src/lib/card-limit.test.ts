// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { CARD_LINE_MAX_CHARS, CARD_MAX_CHARS, fitRowCount } from '@/lib/card-limit';

/** #961：diff 卡與搜尋卡展開後畫幾列。 */

const sized = (...lengths: number[]) => lengths.map((length) => 'x'.repeat(length));
const weigh = (row: string) => row.length;

describe('fitRowCount', () => {
  it('全部在預算內就全畫', () => {
    expect(fitRowCount(sized(10, 20, 30), weigh, 100, 100)).toBe(3);
  });

  it('剛好用完預算算在內，多一個字元就不畫那一列', () => {
    expect(fitRowCount(sized(40, 60), weigh, 100, 100)).toBe(2);
    expect(fitRowCount(sized(40, 61), weigh, 100, 100)).toBe(1);
  });

  it('一列最多只算 lineMax：超長的一列不會把後面的列全擠掉', () => {
    expect(fitRowCount(sized(1_000_000, 10, 10), weigh, 50, 100)).toBe(3);
  });

  it('第一列一定畫；空陣列是 0', () => {
    expect(fitRowCount(sized(500), weigh, 500, 10)).toBe(1);
    expect(fitRowCount([], weigh, 100, 100)).toBe(0);
  });

  it('預設值是 CARD_LINE_MAX_CHARS 與 CARD_MAX_CHARS：每列恰好上限、剛好畫滿預算', () => {
    const count = CARD_MAX_CHARS / CARD_LINE_MAX_CHARS;
    const rows = sized(...Array.from({ length: count + 5 }, () => CARD_LINE_MAX_CHARS * 3));
    expect(fitRowCount(rows, weigh)).toBe(count);
  });
});
