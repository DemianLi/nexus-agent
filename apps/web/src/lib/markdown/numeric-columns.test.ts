import { describe, expect, it } from 'vitest';

import { isNumericCell, numericColumns } from './numeric-columns';

describe('isNumericCell：一格是不是數字（#1330）', () => {
  it.each([
    '0',
    '42',
    '1,234',
    '12,345,678',
    '3.14',
    '.5',
    '1,234.56',
    '-7',
    '+7',
    '−7', // U+2212 減號
    '12%',
    '-3.5%',
    '$1,200',
    '-$1,200',
    'NT$1,200',
    'US$ 9.99',
    '€30',
    '¥500',
    '£4.20',
    '  42  ',
  ])('數字：%s', (text) => {
    expect(isNumericCell(text)).toBe(true);
  });

  it.each([
    '',
    '人事',
    '12 天',
    '3.5 GB',
    '120 萬',
    '1,2', // 千分位要三位一組
    '12,34',
    '12.', // 小數點後沒有數字
    '1.2.3',
    '%',
    '$',
    '-',
    '１２３', // 全形數字不算
    '2026-09-01',
    'v1.2',
    '12%%',
  ])('不是數字：%s', (text) => {
    expect(isNumericCell(text)).toBe(false);
  });
});

describe('numericColumns：哪幾欄整欄是數字（#1330）', () => {
  it('全數字的欄判成數字，混了文字的欄不是', () => {
    expect(
      numericColumns(
        [
          ['人事', '1,200', '12%', '3 天'],
          ['財務', '-35', '7.5%', '5'],
        ],
        4,
      ),
    ).toEqual([false, true, true, false]);
  });

  it('空格與佔位符（-、—、–、N/A）不算數，也不讓一欄變成非數字', () => {
    expect(
      numericColumns(
        [
          ['人事', '', '—'],
          ['財務', '12', '-'],
          ['採購', '–', 'N/A'],
        ],
        3,
      ),
    ).toEqual([false, true, false]);
  });

  it('一欄全是空格或佔位符：沒有數字，不判', () => {
    expect(
      numericColumns(
        [
          ['', '-'],
          ['', '—'],
        ],
        2,
      ),
    ).toEqual([false, false]);
  });

  it('只有表頭、沒有資料列：每欄都不是數字', () => {
    expect(numericColumns([], 3)).toEqual([false, false, false]);
  });

  it('列比欄短（少的格子當空）、比欄長（多的不看）', () => {
    expect(numericColumns([['1'], ['2', '3', 'x']], 2)).toEqual([true, true]);
  });
});
