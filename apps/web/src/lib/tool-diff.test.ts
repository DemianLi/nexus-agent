// @vitest-environment node
import type { ToolEntry } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import {
  cappedRows,
  contentLines,
  diffHunks,
  diffRows,
  diffTotals,
  MAX_DIFF_EDIT_LENGTH,
  toolDiffs,
  toolDiffView,
} from '@/lib/tool-diff';

/** #601、#625：寫檔、改檔什麼時候畫 diff、畫哪一份，以及 diff 怎麼算、怎麼切。 */

type Call = Pick<ToolEntry, 'name' | 'status' | 'input' | 'meta'>;
const write = (args: unknown, status: ToolEntry['status'] = 'done', meta?: unknown): Call => ({
  name: 'write_file',
  status,
  input: JSON.stringify(args),
  meta,
});
const edit = (args: unknown, status: ToolEntry['status'] = 'running', meta?: unknown): Call => ({
  name: 'edit_file',
  status,
  input: JSON.stringify(args),
  meta,
});
const lines = (count: number, prefix = 'l') =>
  Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`);

describe('toolDiffs', () => {
  const editArgs = { file_path: '/a.ts', old_string: 'a', new_string: 'b' };
  /** harness 的 `DiffResultMeta`：實際套用的那幾段，比參數那一段多出上下文，`replace_all` 會有好幾段。 */
  const applied = {
    diffs: [
      { path: '/a.ts', oldText: 'x\na\ny\n', newText: 'x\nb\ny\n' },
      { path: '/a.ts', oldText: 'p\na\nq\n', newText: 'p\nb\nq\n' },
    ],
  };

  it('write_file 執行中，以及完成而沒有 meta（格式 16 以前的日誌）：參數算的整檔新增', () => {
    for (const status of ['running', 'done'] as const) {
      expect(toolDiffs(write({ file_path: '/a.md', content: 'x\n' }, status))).toEqual([
        { path: '/a.md', oldText: null, newText: 'x\n' },
      ]);
    }
  });

  it('write_file 覆寫舊檔：畫 meta 裡跟舊檔比的 diff，不是整檔新增', () => {
    const meta = {
      operation: 'update',
      diffs: [{ path: '/a.md', oldText: 'old\n', newText: 'new\n' }],
    };
    expect(toolDiffs(write({ file_path: '/a.md', content: 'new\n' }, 'done', meta))).toEqual(
      meta.diffs,
    );
  });

  it('write_file 新建（meta 的 diffs 是空的）：退回參數算的整檔新增', () => {
    const meta = { operation: 'create', diffs: [] };
    expect(toolDiffs(write({ file_path: '/a.md', content: 'x\n' }, 'done', meta))).toEqual([
      { path: '/a.md', oldText: null, newText: 'x\n' },
    ]);
  });

  it('edit_file 執行中從參數算；old_string 是空字串時算新增', () => {
    expect(toolDiffs(edit(editArgs))).toEqual([{ path: '/a.ts', oldText: 'a', newText: 'b' }]);
    expect(toolDiffs(edit({ ...editArgs, old_string: '' }))?.[0]?.oldText).toBeNull();
  });

  it('edit_file 完成而有 meta：畫實際套用的每一段', () => {
    expect(toolDiffs(edit(editArgs, 'done', applied))).toEqual(applied.diffs);
  });

  it('edit_file 完成而沒有 meta，或 diffs 是空的：退回通用卡', () => {
    expect(toolDiffs(edit(editArgs, 'done'))).toBeUndefined();
    expect(toolDiffs(edit(editArgs, 'done', { diffs: [] }))).toBeUndefined();
  });

  it.each([
    ['diffs 不是陣列', { diffs: 'x' }],
    ['一段沒有 path', { diffs: [{ oldText: 'a', newText: 'b' }] }],
    ['oldText 是數字', { diffs: [{ path: '/a.ts', oldText: 1, newText: 'b' }] }],
    ['newText 是 null', { diffs: [{ path: '/a.ts', oldText: 'a', newText: null }] }],
    ['meta 是陣列', [{ path: '/a.ts', oldText: 'a', newText: 'b' }]],
  ])('meta 形狀不對（%s）：edit 走通用卡、write 退回參數，不畫半套', (_, meta) => {
    expect(toolDiffs(edit(editArgs, 'done', meta))).toBeUndefined();
    expect(toolDiffs(write({ file_path: '/a.md', content: 'x' }, 'done', meta))).toEqual([
      { path: '/a.md', oldText: null, newText: 'x' },
    ]);
  });

  it('合計的 +N −M 算的是實際套用的那幾段', () => {
    expect(toolDiffView(edit(editArgs, 'done', applied))?.totals).toEqual({
      added: 2,
      removed: 2,
    });
  });

  it('失敗一律退回通用卡', () => {
    expect(toolDiffs(write({ file_path: '/a.md', content: 'x' }, 'failed'))).toBeUndefined();
    expect(toolDiffs(edit(editArgs, 'failed', applied))).toBeUndefined();
  });

  it.each([
    ['content 不是字串', write({ file_path: '/a.md', content: 42 })],
    ['沒有路徑', write({ content: 'x' })],
    ['路徑是空白', write({ file_path: '  ', content: 'x' })],
    ['參數不是物件', write(['/a.md', 'x'])],
    ['參數解不開', { name: 'write_file', status: 'done', input: '{"file_path":"/a' } as Call],
    ['old_string 不是字串', edit({ file_path: '/a.ts', old_string: 1, new_string: 'b' })],
    ['new_string 缺席', edit({ file_path: '/a.ts', old_string: 'a' })],
    [
      'replace_all 不是布林',
      edit({ file_path: '/a.ts', old_string: 'a', new_string: 'b', replace_all: 'yes' }),
    ],
  ])('%s：不畫半套', (_, call) => {
    expect(toolDiffs(call)).toBeUndefined();
  });

  it('別的工具沒有 diff', () => {
    expect(
      toolDiffs({ name: 'read_file', status: 'done', input: '{"file_path":"/a"}' }),
    ).toBeUndefined();
  });
});

describe('diff 的算法', () => {
  it('結尾那一個換行是行尾，不是多一行；中間的空行留著', () => {
    expect(contentLines('')).toEqual([]);
    expect(contentLines('a\nb\n')).toEqual(['a', 'b']);
    expect(contentLines('a\nb')).toEqual(['a', 'b']);
    expect(contentLines('a\n\nb\n')).toEqual(['a', '', 'b']);
  });

  it('整檔新增：+N −0', () => {
    const hunks = diffHunks({ path: '/a', oldText: null, newText: 'a\nb\nc\n' });
    expect(diffTotals(hunks)).toEqual({ added: 3, removed: 0 });
  });

  it('一行替換：+1 −1，不算上下文', () => {
    const hunks = diffHunks({ path: '/a', oldText: 'x\ny\nz', newText: 'x\nY\nz' });
    expect(diffTotals(hunks)).toEqual({ added: 1, removed: 1 });
  });

  it(`改動超過 ${MAX_DIFF_EDIT_LENGTH} 處時整段替換，hunk 的數字補齊`, () => {
    const oldText = lines(300, 'old').join('\n');
    const newText = lines(300, 'new').join('\n');
    const hunks = diffHunks({ path: '/a', oldText, newText });
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ oldStart: 1, oldLines: 300, newStart: 1, newLines: 300 });
    expect(diffTotals(hunks)).toEqual({ added: 300, removed: 300 });
  });

  it('257 行的新檔也走整段替換，+N 仍是行數', () => {
    const hunks = diffHunks({ path: '/a', oldText: null, newText: lines(257).join('\n') });
    expect(diffTotals(hunks)).toEqual({ added: 257, removed: 0 });
    expect(diffRows([{ path: '/a', hunks }])).toHaveLength(258);
  });

  it('同一段裡相隔太遠的兩處改動分成兩個 hunk，中間一列 ⋯', () => {
    const before = lines(10);
    const after = [...before];
    after[0] = 'L1';
    after[9] = 'L10';
    const hunks = diffHunks({ path: '/a', oldText: before.join('\n'), newText: after.join('\n') });
    expect(hunks).toHaveLength(2);
    const rows = diffRows([{ path: '/a', hunks }]);
    expect(rows[0]).toEqual({ kind: 'path', text: '/a' });
    expect(rows.filter((row) => row.kind === 'gap')).toHaveLength(1);
    expect(rows.find((row) => row.kind === 'del')).toEqual({ kind: 'del', text: 'l1' });
  });
});

describe('多段的 diff 怎麼排', () => {
  it('換檔時先一列路徑；同一檔的下一段之前一列 ⋯', () => {
    const fragment = (path: string, from: string, to: string) => ({
      path,
      hunks: diffHunks({ path, oldText: from, newText: to }),
    });
    const rows = diffRows([
      fragment('/a', 'x\n', 'y\n'),
      fragment('/a', 'p\n', 'q\n'),
      fragment('/b', 'm\n', 'n\n'),
    ]);
    expect(rows.map((row) => `${row.kind}:${row.text}`)).toEqual([
      'path:/a',
      'del:x',
      'add:y',
      'gap:⋯',
      'del:p',
      'add:q',
      'path:/b',
      'del:m',
      'add:n',
    ]);
  });
});

describe('cappedRows', () => {
  it('9 列以內整段畫', () => {
    expect(cappedRows(lines(9), 9)).toEqual({ head: lines(9), tail: [], hidden: 0 });
  });

  it('超過就取頭 5、尾 4', () => {
    const { head, tail, hidden } = cappedRows(lines(12), 9);
    expect(head).toEqual(lines(5));
    expect(tail).toEqual(['l9', 'l10', 'l11', 'l12']);
    expect(hidden).toBe(3);
  });
});
