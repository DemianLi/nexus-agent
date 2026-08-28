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

  it('期望零筆呼叫時是 undefined 而不是 1——克制題不該送滿分進平均', () => {
    const restraint: BenchmarkCase = {
      id: 'restraint',
      prompt: '不要用工具',
      expected: { toolCalls: [], mentions: ['7'] },
    };
    // **這是加了 `no-tool-needed` 之後最容易靜靜壞掉的地方。** 回 1 的話，這一欄
    // 每個模型都被無條件加一分滿分，而彙總看起來只會像是「大家都變好了」。
    expect(scoreToolCallSuccess(restraint, run([], '7'))).toBeUndefined();
    // 就算模型忍不住叫了工具，這一欄照樣沒有可判的——訊號在「多叫」那一欄。
    const noisy = run([{ name: 'ls', args: {} }], '7');
    expect(scoreToolCallSuccess(restraint, noisy)).toBeUndefined();
    expect(countExtraToolCalls(restraint, noisy)).toBe(1);
    expect(countExtraToolCalls(restraint, run([], '7'))).toBe(0);
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

  it('資料集一個鍵都沒列時是 undefined 而不是 1', () => {
    const keyless: BenchmarkCase = {
      id: 'keyless',
      prompt: 'x',
      expected: { toolCalls: [{ name: 'ls', args: {} }] },
    };
    // 工具那一欄仍然判得動（有一筆該叫的），只有參數那一欄沒有可判的——兩欄各自認定。
    expect(scoreToolCallSuccess(keyless, run([{ name: 'ls', args: {} }]))).toBe(1);
    expect(scoreArgumentCorrectness(keyless, run([{ name: 'ls', args: {} }]))).toBeUndefined();
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
    // **四個欄位一個都不該在。** 缺席的理由各不相同（沒有可判的／沒要求／沒回報），
    // 但填進去的後果一樣：一個看起來像測量值的數字。
    expect(score).toEqual({ caseId: 'bare', extraToolCalls: 0 });
    for (const key of ['toolCallSuccess', 'argumentCorrectness', 'mentions', 'cost']) {
      expect(key in score).toBe(false);
    }
  });

  it('判得動的那幾欄照樣填', () => {
    const score = scoreCase(CASE, run(PERFECT.toolCalls, '甲與乙'));
    expect(score.toolCallSuccess).toBe(1);
    expect(score.argumentCorrectness).toBe(1);
    expect(score.mentions).toBe(1);
  });
});

describe('資料集本身', () => {
  it('id 不重複——回饋都掛在它上面', () => {
    const ids = BENCHMARK.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('每一條都真的有東西可判——工具或回覆，至少要有一樣', () => {
    // 期望零筆呼叫的克制題是**刻意**允許的，但它必須靠 `mentions` 判得動；
    // 兩樣都沒有的題目跑起來永遠滿分，那是一條進了資料集卻不判任何事的題目。
    for (const entry of BENCHMARK) {
      const judgeable =
        entry.expected.toolCalls.length > 0 || (entry.expected.mentions?.length ?? 0) > 0;
      expect(judgeable, `${entry.id} 沒有任何可判的東西`).toBe(true);
      expect(entry.prompt.trim()).not.toBe('');
    }
  });

  it('難題那半真的存在——參數那一欄要有東西可扣', () => {
    // #84 量到工具名字那一欄五階全平、參數那一欄在 11B 掉到 0.19，所以這一批新題目
    // 的重點是**參數**。這條釘住「資料集裡至少有一條題目的參數鍵多到夠扣分」——
    // 全部退回成一兩個鍵的淺題時它會紅。
    const keyCounts = BENCHMARK.map((entry) =>
      entry.expected.toolCalls.reduce((sum, call) => sum + Object.keys(call.args).length, 0),
    );
    expect(Math.max(...keyCounts)).toBeGreaterThanOrEqual(5);
    // 至少有一條題目期望零筆工具呼叫（克制），也至少有一條期望三個以上（多步驟）。
    expect(BENCHMARK.some((entry) => entry.expected.toolCalls.length === 0)).toBe(true);
    expect(BENCHMARK.some((entry) => entry.expected.toolCalls.length >= 3)).toBe(true);
  });
});
