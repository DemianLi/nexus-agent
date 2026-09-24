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
  toolDiff,
} from '@/lib/tool-diff';

/** #601：寫檔、改檔什麼時候畫 diff，以及 diff 怎麼算、怎麼切。 */

type Call = Pick<ToolEntry, 'name' | 'status' | 'input'>;
const write = (args: unknown, status: ToolEntry['status'] = 'done'): Call => ({
  name: 'write_file',
  status,
  input: JSON.stringify(args),
});
const edit = (args: unknown, status: ToolEntry['status'] = 'running'): Call => ({
  name: 'edit_file',
  status,
  input: JSON.stringify(args),
});
const lines = (count: number, prefix = 'l') =>
  Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`);

describe('toolDiff', () => {
  it('write_file 執行中與完成都是整檔新增', () => {
    for (const status of ['running', 'done'] as const) {
      expect(toolDiff(write({ file_path: '/a.md', content: 'x\n' }, status))).toEqual({
        path: '/a.md',
        oldText: null,
        newText: 'x\n',
      });
    }
  });

  it('edit_file 只在執行中畫；結束之後沒有 metadata，退回通用卡', () => {
    const args = { file_path: '/a.ts', old_string: 'a', new_string: 'b' };
    expect(toolDiff(edit(args))).toEqual({ path: '/a.ts', oldText: 'a', newText: 'b' });
    expect(toolDiff(edit(args, 'done'))).toBeUndefined();
    expect(toolDiff(edit({ ...args, old_string: '' }))?.oldText).toBeNull();
  });

  it('失敗一律退回通用卡', () => {
    expect(toolDiff(write({ file_path: '/a.md', content: 'x' }, 'failed'))).toBeUndefined();
    expect(
      toolDiff(edit({ file_path: '/a.ts', old_string: 'a', new_string: 'b' }, 'failed')),
    ).toBeUndefined();
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
    expect(toolDiff(call)).toBeUndefined();
  });

  it('別的工具沒有 diff', () => {
    expect(
      toolDiff({ name: 'read_file', status: 'done', input: '{"file_path":"/a"}' }),
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
    expect(diffRows('/a', hunks)).toHaveLength(258);
  });

  it('同一段裡相隔太遠的兩處改動分成兩個 hunk，中間一列 ⋯', () => {
    const before = lines(10);
    const after = [...before];
    after[0] = 'L1';
    after[9] = 'L10';
    const hunks = diffHunks({ path: '/a', oldText: before.join('\n'), newText: after.join('\n') });
    expect(hunks).toHaveLength(2);
    const rows = diffRows('/a', hunks);
    expect(rows[0]).toEqual({ kind: 'path', text: '/a' });
    expect(rows.filter((row) => row.kind === 'gap')).toHaveLength(1);
    expect(rows.find((row) => row.kind === 'del')).toEqual({ kind: 'del', text: 'l1' });
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
