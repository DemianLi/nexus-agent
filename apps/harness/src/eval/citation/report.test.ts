import { describe, expect, it } from 'vitest';
import { MODEL_TOOL_NAME } from './fixture.js';
import { disagreements, renderByQuestion, renderSummary, summarizeGroup } from './report.js';
import type { RunRecord } from './report.js';

function run(id: string, group: RunRecord['group'], overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id,
    group,
    question: 'Q',
    rep: 0,
    durationMs: 1,
    toolCalls: [MODEL_TOOL_NAME],
    status: 'idle',
    answer: '查到兩筆資料。',
    askText: '',
    ...overrides,
  };
}

describe('彙總', () => {
  const records: RunRecord[] = [
    run('a1', 'B', { answer: '來自 kb，見 [辦法](https://wiki.example.test/policy/42)' }),
    run('a2', 'B', { answer: '1. 填單\n2. 簽核' }),
    run('a3', 'B', {
      toolCalls: [MODEL_TOOL_NAME, 'ask_user_question'],
      status: 'awaiting-input',
      answer: '',
      askText: '要請哪一種假？',
    }),
    run('a4', 'B', { answer: '', error: '逾時' }),
  ];

  it('失敗的不進分母，另外列出', () => {
    const s = summarizeGroup(records, 'B');
    expect(s.total).toBe(3);
    expect(s.failed).toBe(1);
    expect(s.asked).toMatchObject({ k: 1, n: 3 });
    expect(s.namesSystem).toMatchObject({ k: 1, n: 3 });
    expect(s.markdownLinkToSource).toMatchObject({ k: 1, n: 3 });
  });

  it('捏造的分母排除沒有東西可判的；沒有人工標就不報人工', () => {
    const s = summarizeGroup(records, 'B');
    expect(s.fabricatedAuto).toMatchObject({ k: 1, n: 3 });
    expect(s.fabricatedManual).toBeUndefined();
  });

  it('人工標全了才報人工判與「沒有保留語氣」', () => {
    const labels = {
      a1: { fabricated: false },
      a2: { fabricated: true, hedged: true },
      a3: { fabricated: false },
    };
    const s = summarizeGroup(records, 'B', labels);
    expect(s.fabricatedManual).toMatchObject({ k: 1, n: 3 });
    expect(s.fabricatedUnhedged).toMatchObject({ k: 0, n: 3 });
    expect(disagreements(records, labels)).toEqual([]);
    expect(disagreements(records, { ...labels, a1: { fabricated: true } })).toEqual(['a1']);
  });

  it('斷言讀不到的文件載有內容：單獨計數，不算捏造', () => {
    const labels = {
      a1: { fabricated: false, claimsUnseenContent: true },
      a2: { fabricated: false },
      a3: { fabricated: false },
    };
    const s = summarizeGroup(records, 'B', labels);
    expect(s.claimsUnseenContent).toMatchObject({ k: 1, n: 3 });
    expect(s.fabricatedManual).toMatchObject({ k: 0, n: 3 });
  });

  it('只標了一部分就不報人工判', () => {
    const s = summarizeGroup(records, 'B', { a1: { fabricated: false } });
    expect(s.fabricatedManual).toBeUndefined();
  });

  it('輸出表格含區間與失敗行；某組沒有資料也不炸', () => {
    const text = renderSummary(records);
    expect(text).toContain('B（n=3）');
    expect(text).toContain('1/3 = 33%');
    expect(text).toContain('執行失敗（不進任何比例）：B 組 1 次');
    expect(text).toContain('A（n=0）');
  });

  it('各問法明細', () => {
    expect(renderByQuestion(records)).toContain('| Q | B | 3 | 1 | 1 | 1 | 1 |');
  });
});
