/**
 * CSV 那兩件小事。**這一份存在的理由是「寫出去讀得回來」**——這條路的驗收句是讀檔驗內容，
 * 而用 `split(',')` 寫出來的檔案在沒有逗號的測試資料上永遠是綠的。
 */

import { describe, expect, it } from 'vitest';

import { formatCsvRow, parseCsvLine, quoteCsvField } from './csv.js';

describe('quoteCsvField', () => {
  it('乾淨的值不加引號', () => {
    expect(quoteCsvField('阿明')).toBe('阿明');
  });

  it('逗號、引號、換行都要加引號，引號還要加倍', () => {
    expect(quoteCsvField('甲,乙')).toBe('"甲,乙"');
    expect(quoteCsvField('他說"好"')).toBe('"他說""好"""');
    expect(quoteCsvField('上\n下')).toBe('"上\n下"');
    expect(quoteCsvField('上\r下')).toBe('"上\r下"');
  });
});

describe('組出來的一行切得回來', () => {
  it.each([
    [['阿明', '週二']],
    [['甲,乙', '丙']],
    [['他說"好"', '']],
    [['上\n下', '左,右', '""']],
    [['', '', '']],
  ])('%j', (values) => {
    // **這是承重的那一條**：往返對得起來，欄位才不會在讀檔驗收時錯開一格。
    expect(parseCsvLine(formatCsvRow(values))).toEqual(values);
  });
});

describe('parseCsvLine', () => {
  it('空字串是一個空欄位，不是零個', () => {
    // 零個的話「檔案有表頭但只有一欄」與「檔案沒有表頭」會長得一樣。
    expect(parseCsvLine('')).toEqual(['']);
  });

  it('引號裡的逗號不切', () => {
    expect(parseCsvLine('a,"b,c",d')).toEqual(['a', 'b,c', 'd']);
  });
});
