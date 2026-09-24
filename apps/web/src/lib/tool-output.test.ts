// @vitest-environment node
import type { ToolEntry } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { OUTPUT_MAX_LINES, showsInput, toolOutput } from '@/lib/tool-output';

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
  it.each(['ls', 'read_file', 'glob', 'grep', 'write_file', 'edit_file'])('%s 只畫結果', (name) => {
    expect(showsInput(name)).toBe(false);
  });

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
    });
  });

  it.each([
    ['沒有結尾換行', ''],
    ['有結尾換行', '\n'],
  ])(`剛好 ${OUTPUT_MAX_LINES} 行不切（%s）`, (_, end) => {
    const text = lines(200).join('\n') + end;
    expect(toolOutput(entry({ text }))).toEqual({ head: text, tail: '', omitted: 0 });
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
    });
  });
});
