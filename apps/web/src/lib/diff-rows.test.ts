import type { WorkspaceDiffHunk } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import {
  MAX_RENDERED_LINES,
  hunkHeader,
  hunkRows,
  renderedHunks,
  splitRowKind,
  splitRows,
} from '@/lib/diff-rows';

/** 把 diff 排成要畫的列（#443 web 第二刀，同 dsh `ReviewTab` 的三個純函式）。 */

function hunk(lines: string[], oldStart = 10, newStart = 20): WorkspaceDiffHunk {
  return {
    oldStart,
    oldLines: lines.filter((line) => line[0] !== '+').length,
    newStart,
    newLines: lines.filter((line) => line[0] !== '-').length,
    lines,
  };
}

describe('單欄', () => {
  it('上下文兩側都算，刪除只算左側，新增只算右側', () => {
    expect(hunkRows(hunk([' a', '-b', '-c', '+C', ' d']))).toEqual([
      { kind: 'context', old: 10, new: 20, text: 'a' },
      { kind: 'del', old: 11, new: undefined, text: 'b' },
      { kind: 'del', old: 12, new: undefined, text: 'c' },
      { kind: 'add', old: undefined, new: 21, text: 'C' },
      { kind: 'context', old: 13, new: 22, text: 'd' },
    ]);
  });

  it('標頭照 unified diff 寫', () => {
    expect(hunkHeader(hunk([' a', '-b', '+c']))).toBe('@@ -10,2 +20,2 @@');
  });
});

describe('左右對照', () => {
  it('刪除比新增多：逐列配對，多出來的刪除右側留空', () => {
    const rows = splitRows(hunk(['-a', '-b', '-c', '+A', ' x']));
    expect(rows).toEqual([
      { left: { no: 10, text: 'a', kind: 'del' }, right: { no: 20, text: 'A', kind: 'add' } },
      { left: { no: 11, text: 'b', kind: 'del' } },
      { left: { no: 12, text: 'c', kind: 'del' } },
      {
        left: { no: 13, text: 'x', kind: 'context' },
        right: { no: 21, text: 'x', kind: 'context' },
      },
    ]);
    expect(rows.map(splitRowKind)).toEqual(['del', 'del', 'del', 'context']);
  });

  it('新增比刪除多、以及收尾的新增：左側留空', () => {
    const rows = splitRows(hunk([' x', '+A', '+B']));
    expect(rows.map((row) => [row.left?.no, row.right?.no])).toEqual([
      [10, 20],
      [undefined, 21],
      [undefined, 22],
    ]);
    expect(rows.map(splitRowKind)).toEqual(['context', 'add', 'add']);
  });

  it('上下文把前後兩段隔開，不跨段配對', () => {
    const rows = splitRows(hunk(['-a', ' x', '+B']));
    expect(rows.map((row) => [row.left?.text, row.right?.text])).toEqual([
      ['a', undefined],
      ['x', 'x'],
      [undefined, 'B'],
    ]);
  });
});

describe(`最多畫 ${MAX_RENDERED_LINES} 行`, () => {
  const lines = (count: number) => Array.from({ length: count }, (_, at) => ` ${at}`);

  it('剛好在上限：原樣、沒有截斷', () => {
    const hunks = [hunk(lines(MAX_RENDERED_LINES - 1)), hunk(lines(1))];
    const result = renderedHunks(hunks);
    expect(result.truncated).toBe(false);
    expect(result.hunks[0]).toBe(hunks[0]);
    expect(result.hunks[1]).toBe(hunks[1]);
  });

  it('超過一行：切在最後那個 hunk 的中間', () => {
    const result = renderedHunks([hunk(lines(MAX_RENDERED_LINES - 2)), hunk(lines(3))]);
    expect(result.truncated).toBe(true);
    expect(result.hunks.map((kept) => kept.lines.length)).toEqual([MAX_RENDERED_LINES - 2, 2]);
  });

  it('上限剛好用完在 hunk 邊界：後面的整個不畫，也算截斷', () => {
    const result = renderedHunks([hunk(lines(MAX_RENDERED_LINES)), hunk(lines(1))]);
    expect(result.truncated).toBe(true);
    expect(result.hunks).toHaveLength(1);
  });
});
