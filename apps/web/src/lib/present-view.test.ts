// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { basename, presentedFilesOf, presentSummary } from '@/lib/present-view';

/** `present` 的參數怎麼讀（#441 第一刀）。形狀照 dsh `tool-present`：`{ files: [{ path, description? }] }`。 */

describe('presentedFilesOf', () => {
  it('照宣告的順序讀出路徑與說明；空白說明當沒有', () => {
    expect(
      presentedFilesOf(
        JSON.stringify({
          files: [
            { path: 'out/report.md', description: '週報' },
            { path: '/abs/chart.png', description: '  ' },
          ],
        }),
      ),
    ).toEqual([{ path: 'out/report.md', description: '週報' }, { path: '/abs/chart.png' }]);
  });

  it('串流中途的半截參數、形狀不對：undefined，卡片退回參數原文', () => {
    expect(presentedFilesOf('{"files":[{"path":"out/re')).toBeUndefined();
    expect(presentedFilesOf('{"paths":["a"]}')).toBeUndefined();
    expect(presentedFilesOf('null')).toBeUndefined();
  });

  it('沒有路徑或路徑空白的那幾個略過（工具本體會拒絕它們）', () => {
    expect(
      presentedFilesOf(
        JSON.stringify({ files: [{ path: ' ' }, { description: 'x' }, 3, { path: 'a.txt' }] }),
      ),
    ).toEqual([{ path: 'a.txt' }]);
  });
});

describe('收著那一行', () => {
  it('一個檔講檔名；多個接起來再補總數；兩種分隔符都認', () => {
    expect(basename('C:\\work\\out.csv')).toBe('out.csv');
    expect(presentSummary([{ path: 'out/report.md' }])).toBe('report.md');
    expect(presentSummary([{ path: 'out/report.md' }, { path: 'C:\\x\\data.csv' }])).toBe(
      'report.md、data.csv（共 2 個）',
    );
    expect(presentSummary([])).toBe('沒有檔案');
  });
});
