import { describe, expect, it } from 'vitest';

import { reportDetail, reportLine, reportTitle } from './report';

describe('送出沒成的文案', () => {
  it('沒送出去：標題加原因；併成一句用冒號', () => {
    const report = { kind: 'rejected', message: '伺服器忙線' } as const;
    expect(reportTitle(report)).toBe('這一句沒送出去');
    expect(reportDetail(report)).toBe('伺服器忙線');
    expect(reportLine(report)).toBe('這一句沒送出去：伺服器忙線');
  });

  it('不確定有沒有送到：兩種畫法的標點各照各的', () => {
    const report = { kind: 'uncertain', message: 'Failed to fetch' } as const;
    expect(reportTitle(report)).toBe('不確定這一句有沒有送到');
    expect(reportDetail(report)).toBe('原樣再按一次送出，不會重複。（Failed to fetch）');
    expect(reportLine(report)).toBe(
      '不確定這一句有沒有送到，原樣再按一次送出不會重複。（Failed to fetch）',
    );
  });

  it('取消上傳', () => {
    const report = { kind: 'cancelled', message: '附件還在，再按送出會重新上傳。' } as const;
    expect(reportTitle(report)).toBe('已取消上傳');
    expect(reportDetail(report)).toBe('附件還在，再按送出會重新上傳。');
  });
});
