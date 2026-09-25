// @vitest-environment node
import type { ToolEntry } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { highlightLines } from '@/lib/markdown/highlight';
import {
  cappedSearchRows,
  readCardOf,
  readWindowText,
  searchCardOf,
  searchRows,
  searchSummary,
} from '@/lib/tool-result-card';
import type { SearchCard } from '@/lib/tool-result-card';

/** #625：讀檔卡與搜尋卡從 `meta` 驗出什麼、什麼時候退回通用卡。`meta` 的形狀照 harness 的 `tool-result-meta.ts`。 */

type Call = Pick<ToolEntry, 'name' | 'status' | 'input' | 'meta'>;

const readMeta = {
  path: '/src/a.ts',
  offset: 11,
  lines: [
    { number: 11, text: 'const a = 1;' },
    { number: 12, text: 'const b = 2;' },
  ],
  totalLines: 40,
  lang: 'ts',
};
// 不用預設參數：`read(args, undefined)` 要真的是「沒有 meta」，不能被預設值補回去。
const read = (args: unknown, ...rest: [meta?: unknown, status?: ToolEntry['status']]): Call => ({
  name: 'read_file',
  status: rest[1] ?? 'done',
  input: JSON.stringify(args),
  meta: rest.length === 0 ? readMeta : rest[0],
});

describe('readCardOf', () => {
  it('行號、總行數、語言從 meta 取', () => {
    expect(readCardOf(read({ file_path: '/src/a.ts', offset: 10, limit: 2 }))).toEqual({
      path: '/src/a.ts',
      lines: readMeta.lines,
      totalLines: 40,
      lang: 'ts',
    });
  });

  it.each([
    ['沒給 offset', { file_path: '/src/a.ts' }],
    ['offset 是 0（deepagents 0 起算，從檔頭讀）', { file_path: '/src/a.ts', offset: 0 }],
    ['offset 是字串（deepagents 會 coerce）', { file_path: '/src/a.ts', offset: '10' }],
  ])('%s：照樣畫，不照抄 dsh 的 ≥1 整數檢查', (_, args) => {
    expect(readCardOf(read(args))).toBeDefined();
  });

  it.each([
    ['沒有 meta（格式 16 以前的日誌、超過上限）', read({ file_path: '/a' }, undefined)],
    ['執行中', read({ file_path: '/a' }, readMeta, 'running')],
    ['失敗', read({ file_path: '/a' }, readMeta, 'failed')],
    ['參數沒有路徑', read({}, readMeta)],
    ['參數路徑是空白', read({ file_path: ' ' }, readMeta)],
    ['別的工具', { ...read({ file_path: '/a' }), name: 'ls' }],
    ['offset 是 0', read({ file_path: '/a' }, { ...readMeta, offset: 0 })],
    ['totalLines 不是整數', read({ file_path: '/a' }, { ...readMeta, totalLines: 1.5 })],
    ['lines 不是陣列', read({ file_path: '/a' }, { ...readMeta, lines: 'x' })],
    ['lang 不是字串', read({ file_path: '/a' }, { ...readMeta, lang: 1 })],
    [
      '行號小於 offset',
      read({ file_path: '/a' }, { ...readMeta, lines: [{ number: 10, text: 'x' }] }),
    ],
    [
      '行號沒有遞增',
      read(
        { file_path: '/a' },
        {
          ...readMeta,
          lines: [
            { number: 12, text: 'x' },
            { number: 12, text: 'y' },
          ],
        },
      ),
    ],
    [
      '行號超過總行數',
      read({ file_path: '/a' }, { ...readMeta, lines: [{ number: 41, text: 'x' }] }),
    ],
    ['一行的字不是字串', read({ file_path: '/a' }, { ...readMeta, lines: [{ number: 11 }] })],
  ])('%s：走通用卡', (_, call) => {
    expect(readCardOf(call)).toBeUndefined();
  });
});

describe('readWindowText', () => {
  const card = (numbers: number[], totalLines: number) => ({
    path: '/a',
    lines: numbers.map((number) => ({ number, text: '' })),
    totalLines,
  });

  it('只讀了一部分時講讀到哪裡', () => {
    expect(readWindowText(card([11, 12, 13], 40))).toBe('第 11–13 行，共 40 行');
    expect(readWindowText(card([5], 40))).toBe('第 5 行，共 40 行');
  });

  it('整份都讀了、或一行都沒有時不講', () => {
    expect(readWindowText(card([1, 2], 2))).toBeUndefined();
    expect(readWindowText(card([], 0))).toBeUndefined();
  });
});

const grepMeta = {
  shape: 'matches',
  files: [
    { path: '/src/a.ts', matches: [{ lineNumber: 3, line: 'foo()' }] },
    {
      path: '/src/b.ts',
      matches: [
        { lineNumber: 1, line: 'foo' },
        { lineNumber: 9, line: 'bar(foo)' },
      ],
    },
  ],
  truncated: false,
  total: 3,
};
const grep = (args: unknown, ...rest: [meta?: unknown]): Call => ({
  name: 'grep',
  status: 'done',
  input: JSON.stringify(args),
  meta: rest.length === 0 ? grepMeta : rest[0],
});
const globMeta = { shape: 'paths', paths: ['/src/a.ts', '/src/b.ts'], truncated: true, total: 212 };
const glob = (args: unknown, ...rest: [meta?: unknown]): Call => ({
  name: 'glob',
  status: 'done',
  input: JSON.stringify(args),
  meta: rest.length === 0 ? globMeta : rest[0],
});

describe('searchCardOf', () => {
  it('grep 的命中照檔案分組', () => {
    expect(searchCardOf(grep({ pattern: 'foo' }))).toEqual({
      kind: 'matches',
      files: grepMeta.files,
      truncated: false,
      total: 3,
    });
  });

  it('grep 的檔案過濾照 deepagents 叫 glob、可以是 null', () => {
    expect(searchCardOf(grep({ pattern: 'foo', glob: null }))).toBeDefined();
    expect(searchCardOf(grep({ pattern: 'foo', glob: '*.ts', path: '/src' }))).toBeDefined();
  });

  it('glob 的路徑清單', () => {
    expect(searchCardOf(glob({ pattern: '**/*.ts' }))).toEqual({
      kind: 'paths',
      paths: globMeta.paths,
      truncated: true,
      total: 212,
    });
  });

  it.each([
    ['grep 沒有 meta（非 content 模式、舊日誌）', grep({ pattern: 'foo' }, undefined)],
    ['grep 的 pattern 是空字串', grep({ pattern: '' })],
    ['glob 的 pattern 是空白', glob({ pattern: ' ' })],
    ['path 是空白', grep({ pattern: 'foo', path: ' ' })],
    ['glob 過濾是數字', grep({ pattern: 'foo', glob: 1 })],
    ['grep 拿到 paths 形狀', grep({ pattern: 'foo' }, globMeta)],
    ['glob 拿到 matches 形狀', glob({ pattern: '*' }, grepMeta)],
    ['truncated 不是布林', grep({ pattern: 'foo' }, { ...grepMeta, truncated: 'no' })],
    ['total 是負數', grep({ pattern: 'foo' }, { ...grepMeta, total: -1 })],
    [
      '命中的行號是 0',
      grep(
        { pattern: 'foo' },
        { ...grepMeta, files: [{ path: '/a', matches: [{ lineNumber: 0, line: 'x' }] }] },
      ),
    ],
    ['路徑不是字串', glob({ pattern: '*' }, { ...globMeta, paths: [1] })],
  ])('%s：走通用卡', (_, call) => {
    expect(searchCardOf(call)).toBeUndefined();
  });

  it('失敗、執行中都走通用卡', () => {
    expect(searchCardOf({ ...grep({ pattern: 'foo' }), status: 'failed' })).toBeUndefined();
    expect(searchCardOf({ ...grep({ pattern: 'foo' }), status: 'running' })).toBeUndefined();
  });
});

describe('searchSummary', () => {
  const matches = (truncated: boolean, total: number): SearchCard => ({
    kind: 'matches',
    files: grepMeta.files,
    truncated,
    total,
  });

  it('沒截斷時是個數；截斷時「顯示 X／共 N」寫在同一句，total 是截之前的總數', () => {
    expect(searchSummary(matches(false, 3))).toBe('3 處符合 · 2 個檔案');
    expect(searchSummary(matches(true, 50))).toBe('顯示 3／共 50 處符合 · 2 個檔案');
    expect(searchSummary({ kind: 'paths', paths: ['/a'], truncated: false, total: 1 })).toBe(
      '1 個路徑',
    );
    expect(searchSummary({ kind: 'paths', paths: ['/a'], truncated: true, total: 212 })).toBe(
      '顯示 1／共 212 個路徑',
    );
  });

  it('沒有結果', () => {
    expect(searchSummary({ kind: 'paths', paths: [], truncated: false, total: 0 })).toBe(
      '沒有符合的結果',
    );
  });
});

describe('cappedSearchRows', () => {
  const card = (counts: number[]): SearchCard => ({
    kind: 'matches',
    files: counts.map((count, file) => ({
      path: `/f${file}`,
      matches: Array.from({ length: count }, (_, at) => ({
        lineNumber: at + 1,
        line: `m${at + 1}`,
      })),
    })),
    truncated: false,
    total: counts.reduce((sum, count) => sum + count, 0),
  });
  const label = (row: ReturnType<typeof searchRows>[number]) =>
    row.type === 'file'
      ? `F${row.path}`
      : row.type === 'match'
        ? `${row.fileIndex}:${row.lineNumber}`
        : row.path;

  it('8 列以內整段畫', () => {
    const rows = searchRows(card([3, 3]));
    expect(cappedSearchRows(rows, 8)).toEqual({ head: rows, tail: [], hidden: 0 });
  });

  it('尾段從另一個檔的命中中間開始：補上那個檔的標題，頂掉尾段第一列，總數仍是 8', () => {
    const rows = searchRows(card([3, 6]));
    const { head, tail, hidden } = cappedSearchRows(rows, 8);
    expect(head.map(label)).toEqual(['F/f0', '0:1', '0:2', '0:3']);
    expect(tail.map(label)).toEqual(['F/f1', '1:4', '1:5', '1:6']);
    expect(head.length + tail.length).toBe(8);
    expect(hidden).toBe(3);
  });

  it('那個檔的標題已經在頭段（單一大檔）：不重複', () => {
    const rows = searchRows(card([12]));
    const { head, tail } = cappedSearchRows(rows, 8);
    expect(head.map(label)).toEqual(['F/f0', '0:1', '0:2', '0:3']);
    expect(tail.map(label)).toEqual(['0:9', '0:10', '0:11', '0:12']);
  });
});

describe('highlightLines', () => {
  it('整段一起高亮：跨行的區塊註解第二行仍是註解色，行數跟輸入一樣', () => {
    const lines = highlightLines('/* 一\n二 */\nconst a = 1;\n', 'ts');
    expect(lines).toHaveLength(3);
    const second = lines?.[1];
    expect(second?.map((span) => span.text).join('')).toBe('二 */');
    expect(second?.every((span) => span.style.color === 'var(--shiki-token-comment)')).toBe(true);
  });

  it('不認得的語言回 undefined（畫純文字）', () => {
    expect(highlightLines('x', 'fish')).toBeUndefined();
    expect(highlightLines('x', undefined)).toBeUndefined();
  });
});
