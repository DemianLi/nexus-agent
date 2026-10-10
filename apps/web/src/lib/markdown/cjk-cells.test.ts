import { describe, expect, it } from 'vitest';

import { CJK_SHORT_MAX, cjkCellFit } from './cjk-cells';

describe('cjkCellFit：表格格子裡的中文是短值還是長描述（#1332）', () => {
  it.each([
    '王小明',
    '歐陽志強',
    '財務會計處',
    '待更新',
    '人',
    'IT 部門',
    '第 3 季',
    '  正常  ',
    'ステータス', // 片假名
    '六個字剛好啦',
  ])(`${CJK_SHORT_MAX} 個字以內、含中日文字的是短值：%s`, (text) => {
    expect(cjkCellFit(text)).toBe('short');
  });

  it.each([
    '七個字就不算短了',
    '每月五號前同步出勤與請假資料，異動需經部門主管簽核後才會生效',
    '舊版請購系統已停用',
    'Alice 負責人事系統',
  ])('超過的是長描述：%s', (text) => {
    expect(cjkCellFit(text)).toBe('prose');
  });

  it.each([
    '',
    '   ',
    '1,284',
    'NT$1,200',
    'Alice Chen',
    'Done',
    'https://intranet.example.com/hr/attendance',
    '—',
    '２０２６', // 全形數字不是漢字
  ])('沒有中日文字的不管（照 #1330 的行為）：%s', (text) => {
    expect(cjkCellFit(text)).toBeUndefined();
  });

  it('連續空白當一格算、頭尾空白不算（模型常在格子裡多打空白）', () => {
    expect(cjkCellFit('人資部     門')).toBe('short');
    expect(cjkCellFit('  待更新的資料  ')).toBe('short'); // 剛好六個字
  });
});
