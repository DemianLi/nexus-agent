// @vitest-environment node
import type { ToolEntry } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import {
  OUTPUT_MAX_CHARS,
  OUTPUT_MAX_LINES,
  omittedLabel,
  outputOf,
  showsInput,
  toolOutput,
} from '@/lib/tool-output';

/** #601：通用卡的結果畫哪一段、哪些工具不畫參數。 */

function entry(overrides: Partial<ToolEntry>): ToolEntry {
  return {
    kind: 'tool',
    id: 't',
    callId: 'c',
    name: 'echo',
    input: '{}',
    status: 'done',
    attribution: { kind: 'root' },
    ...overrides,
  };
}
const lines = (count: number) => Array.from({ length: count }, (_, index) => `l${index + 1}`);

describe('showsInput', () => {
  it.each(['ls', 'read_file', 'glob', 'grep', 'write_file', 'edit_file', 'delete'])(
    '%s 只畫結果',
    (name) => {
      expect(showsInput(name)).toBe(false);
    },
  );

  it.each(['echo', 'run_javascript', 'task', 'mcp__x__y'])('%s 參數也畫', (name) => {
    expect(showsInput(name)).toBe(true);
  });
});

describe('toolOutput', () => {
  it('沒有結果文字、或是空字串時不畫', () => {
    expect(toolOutput(entry({}))).toBeUndefined();
    expect(toolOutput(entry({ text: '' }))).toBeUndefined();
  });

  it('失敗而且有紅字時不畫，紅字就是同一串', () => {
    expect(toolOutput(entry({ status: 'failed', text: 'boom', error: 'boom' }))).toBeUndefined();
  });

  it('失敗但沒有紅字時照畫', () => {
    expect(toolOutput(entry({ status: 'failed', text: 'boom' }))).toEqual({
      head: 'boom',
      tail: '',
      omitted: 0,
      omittedChars: 0,
    });
  });

  it.each([
    ['沒有結尾換行', ''],
    ['有結尾換行', '\n'],
  ])(`剛好 ${OUTPUT_MAX_LINES} 行不切（%s）`, (_, end) => {
    const text = lines(200).join('\n') + end;
    expect(toolOutput(entry({ text }))).toEqual({
      head: text,
      tail: '',
      omitted: 0,
      omittedChars: 0,
    });
  });

  it.each([
    ['沒有結尾換行', ''],
    ['有結尾換行', '\n'],
  ])('201 行切成頭尾各 100 行（%s）', (_, end) => {
    const output = toolOutput(entry({ text: lines(201).join('\n') + end }));
    expect(output).toEqual({
      head: lines(100).join('\n'),
      tail: lines(201).slice(101).join('\n'),
      omitted: 1,
      omittedChars: 0,
    });
  });
});

/** #950：行數沒超過、一行超長時，畫面上還要有字元上限。 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('outputOf 的字元上限', () => {
  const half = Math.ceil(OUTPUT_MAX_CHARS / 2);

  it('剛好等於上限不切', () => {
    const text = 'a'.repeat(OUTPUT_MAX_CHARS);
    expect(outputOf(text)).toEqual({ head: text, tail: '', omitted: 0, omittedChars: 0 });
  });

  it('多一個字就切成頭尾各半，中間記下沒畫幾個字', () => {
    const text = `${'h'.repeat(half)}${'m'.repeat(3)}${'t'.repeat(OUTPUT_MAX_CHARS - half + 1)}`;
    // 總長 = 上限 + 4：頭取前 half、尾取後 (上限 - half)，被丟掉的是中間 3 個加尾多出來的 1 個。
    expect(text.length).toBe(OUTPUT_MAX_CHARS + 4);
    const output = outputOf(text);
    expect(output.head).toBe('h'.repeat(half));
    expect(output.tail).toBe('t'.repeat(OUTPUT_MAX_CHARS - half));
    expect(output.omitted).toBe(0);
    expect(output.omittedChars).toBe(4);
  });

  it('夾大量空白的一整行也切（#950 的最壞形狀）', () => {
    const word = '字'.repeat(127);
    const text = Array.from({ length: 4300 }, () => `${word} `).join('');
    const output = outputOf(text);
    expect(output.head.length + output.tail.length).toBe(OUTPUT_MAX_CHARS);
    expect(output.omittedChars).toBe(text.length - OUTPUT_MAX_CHARS);
  });

  it('行數也超過時，頭尾各自超過各一半的那一邊被截在行的中間', () => {
    const big = 'x'.repeat(OUTPUT_MAX_CHARS);
    const all = [big, ...lines(OUTPUT_MAX_LINES + 48), big];
    const output = outputOf(all.join('\n'));
    const headFull = all.slice(0, 100).join('\n');
    const tailFull = all.slice(all.length - 100).join('\n');
    expect(output.omitted).toBe(50);
    expect(output.head).toBe('x'.repeat(half));
    expect(output.tail).toBe(tailFull.slice(tailFull.length - (OUTPUT_MAX_CHARS - half)));
    expect(output.omittedChars).toBe(
      headFull.length - half + (tailFull.length - (OUTPUT_MAX_CHARS - half)),
    );
  });

  it('只有一邊超過它那一半時，另一邊照原樣', () => {
    const all = [...lines(OUTPUT_MAX_LINES + 49), 'y'.repeat(OUTPUT_MAX_CHARS)];
    const output = outputOf(all.join('\n'));
    const tailFull = all.slice(all.length - 100).join('\n');
    expect(output.omitted).toBe(50);
    expect(output.head).toBe(lines(100).join('\n'));
    expect(output.tail).toBe('y'.repeat(OUTPUT_MAX_CHARS - half));
    expect(output.omittedChars).toBe(tailFull.length - (OUTPUT_MAX_CHARS - half));
  });

  it('不把代理對（emoji）從中間剖開', () => {
    // 前後各墊一個半形字，讓兩個切點都剛好落在代理對的中間。
    const text = `a${'😀'.repeat(OUTPUT_MAX_CHARS)}b`;
    const output = outputOf(text);
    for (const side of [output.head, output.tail]) {
      expect(side).not.toMatch(LONE_SURROGATE);
    }
    expect(output.head.length + output.tail.length + output.omittedChars).toBe(text.length);
  });
});

describe('omittedLabel', () => {
  const base = { head: '', tail: '' };
  it('只有行', () => {
    expect(omittedLabel({ ...base, omitted: 4800, omittedChars: 0 })).toBe('⋯ 中間 4800 行沒畫 ⋯');
  });
  it('只有字', () => {
    expect(omittedLabel({ ...base, omitted: 0, omittedChars: 527003 })).toBe(
      '⋯ 中間 527003 字沒畫 ⋯',
    );
  });
  it('行跟字都有', () => {
    expect(omittedLabel({ ...base, omitted: 3, omittedChars: 20 })).toBe(
      '⋯ 中間 3 行與 20 字沒畫 ⋯',
    );
  });
  it('都沒有時沒有說明', () => {
    expect(omittedLabel({ ...base, omitted: 0, omittedChars: 0 })).toBeUndefined();
  });
});
