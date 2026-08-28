import { describe, expect, it } from 'vitest';
import { BENCHMARK, type BenchmarkCase } from './dataset.js';
import type { BenchmarkRun, ObservedToolCall } from './runner.js';
import {
  countExtraToolCalls,
  readCost,
  scoreArgumentCorrectness,
  scoreCase,
  scoreMentions,
  scoreToolCallSuccess,
} from './scorers.js';

/**
 * 評分器自己的對照組。
 *
 * **一組只餵「全對」的測試，證明不了評分器在扣分**——`() => 1` 也會全綠。所以每個指標
 * 都成對出現：一筆該滿分的，一筆刻意壞掉的，而且斷言的是**兩者不相等**加上壞掉那筆的
 * 確切數值。這是 `stream-parity.test.ts` 立下的那條規矩用在評分器上。
 */

const CASE: BenchmarkCase = {
  id: 'fixture',
  prompt: '無關緊要',
  expected: {
    toolCalls: [
      { name: 'echo', args: { message: '甲' } },
      { name: 'write_file', args: { file_path: '/a.md', content: '甲' } },
    ],
    mentions: ['甲', '乙'],
  },
};

function run(toolCalls: readonly ObservedToolCall[], finalText = '甲與乙'): BenchmarkRun {
  return { caseId: 'fixture', toolCalls, finalText };
}

const PERFECT = run([
  { name: 'echo', args: { message: '甲' } },
  { name: 'write_file', args: { file_path: '/a.md', content: '甲' } },
]);

describe('工具呼叫成功率', () => {
  it('都叫了且順序對是滿分', () => {
    expect(scoreToolCallSuccess(CASE, PERFECT)).toBe(1);
  });

  it('少叫一個就扣一半', () => {
    const partial = run([{ name: 'echo', args: { message: '甲' } }]);
    expect(scoreToolCallSuccess(CASE, partial)).toBe(0.5);
  });

  it('一個都沒叫是零', () => {
    expect(scoreToolCallSuccess(CASE, run([]))).toBe(0);
  });

  it('順序反了只認得回第一筆——順序是承重的', () => {
    const reversed = run([
      { name: 'write_file', args: { file_path: '/a.md', content: '甲' } },
      { name: 'echo', args: { message: '甲' } },
    ]);
    // `echo` 對到觀測的第 1 筆，游標推到之後，`write_file` 就再也對不到了。
    expect(scoreToolCallSuccess(CASE, reversed)).toBe(0.5);
  });

  it('中間插一次無關的呼叫不影響——比的是子序列不是逐位相等', () => {
    const noisy = run([
      { name: 'echo', args: { message: '甲' } },
      { name: 'ls', args: {} },
      { name: 'write_file', args: { file_path: '/a.md', content: '甲' } },
    ]);
    expect(scoreToolCallSuccess(CASE, noisy)).toBe(1);
    // 但它確實多叫了一次，而那件事記在另一個指標上。
    expect(countExtraToolCalls(CASE, noisy)).toBe(1);
    expect(countExtraToolCalls(CASE, PERFECT)).toBe(0);
  });
});

describe('參數正確性', () => {
  it('三個鍵全中是滿分', () => {
    expect(scoreArgumentCorrectness(CASE, PERFECT)).toBe(1);
  });

  it('一個鍵寫錯就掉下來，而且成功率不動', () => {
    const wrongArgs = run([
      { name: 'echo', args: { message: '錯的' } },
      { name: 'write_file', args: { file_path: '/a.md', content: '甲' } },
    ]);
    // 工具全叫了，錯的只有參數——兩個指標因此必須分得開。
    expect(scoreToolCallSuccess(CASE, wrongArgs)).toBe(1);
    expect(scoreArgumentCorrectness(CASE, wrongArgs)).toBeCloseTo(2 / 3, 10);
  });

  it('沒對上的呼叫，它的鍵全部計為錯', () => {
    const missing = run([{ name: 'echo', args: { message: '甲' } }]);
    // `write_file` 沒叫，它那兩個鍵不可能對。
    expect(scoreArgumentCorrectness(CASE, missing)).toBeCloseTo(1 / 3, 10);
  });

  it('資料集沒列的鍵不看——多帶一個可選參數不算錯', () => {
    const extraKey = run([
      { name: 'echo', args: { message: '甲', 語氣: '平靜' } },
      { name: 'write_file', args: { file_path: '/a.md', content: '甲' } },
    ]);
    expect(scoreArgumentCorrectness(CASE, extraKey)).toBe(1);
  });

  it('物件參數比的是結構不是同一個參照', () => {
    const nested: BenchmarkCase = {
      id: 'nested',
      prompt: '無關緊要',
      expected: { toolCalls: [{ name: 'f', args: { opts: { a: 1, b: [2, 3] } } }] },
    };
    expect(
      scoreArgumentCorrectness(nested, run([{ name: 'f', args: { opts: { a: 1, b: [2, 3] } } }])),
    ).toBe(1);
    expect(
      scoreArgumentCorrectness(nested, run([{ name: 'f', args: { opts: { a: 1, b: [2, 9] } } }])),
    ).toBe(0);
  });
});

describe('回覆內容', () => {
  it('提到一半就是一半', () => {
    expect(scoreMentions(CASE, run(PERFECT.toolCalls, '只有甲'))).toBe(0.5);
    expect(scoreMentions(CASE, run(PERFECT.toolCalls, '甲與乙'))).toBe(1);
  });

  it('資料集沒要求時是 undefined 而不是 1', () => {
    const silent: BenchmarkCase = { id: 's', prompt: 'x', expected: { toolCalls: [] } };
    // 「這條沒有要求」與「這條全對」在彙總時是兩件事。
    expect(scoreMentions(silent, run([], ''))).toBeUndefined();
  });
});

describe('token 成本', () => {
  it('模型沒回報時是 undefined 而不是零', () => {
    expect(readCost(PERFECT)).toBeUndefined();
  });

  it('回報了就原樣拿得到', () => {
    const withUsage: BenchmarkRun = {
      ...PERFECT,
      usage: { inputTokens: 11, outputTokens: 5, totalTokens: 16 },
    };
    expect(readCost(withUsage)).toEqual({ inputTokens: 11, outputTokens: 5, totalTokens: 16 });
  });
});

describe('成績單', () => {
  it('缺席的欄位不出現，而不是填一個看起來像分數的值', () => {
    const score = scoreCase(
      { id: 'bare', prompt: 'x', expected: { toolCalls: [] } },
      run([], '什麼都沒說'),
    );
    expect(score).toEqual({
      caseId: 'bare',
      toolCallSuccess: 1,
      argumentCorrectness: 1,
      extraToolCalls: 0,
    });
    expect('mentions' in score).toBe(false);
    expect('cost' in score).toBe(false);
  });
});

describe('資料集本身', () => {
  it('id 不重複——回饋都掛在它上面', () => {
    const ids = BENCHMARK.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('每一條都真的有東西可判', () => {
    for (const entry of BENCHMARK) {
      expect(entry.expected.toolCalls.length).toBeGreaterThan(0);
      expect(entry.prompt.trim()).not.toBe('');
    }
  });
});
