/**
 * 區間、一題換算與失敗成本（[#1002](https://github.com/DemianLi/nexus-agent/issues/1002)）的端到端驗收：
 * 真的跑 `runTier`（假模型、零憑證），再看彙總與報表。
 */

import type { AgentModel } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import { LoopingChatModel } from '../looping-model.js';
import { ScriptedChatModel, type ScriptedTurn } from '../scripted-model.js';
import { HumanMessage } from '@langchain/core/messages';
import { runBenchmarkCase, UsageTally } from './runner.js';
import { benchmarkPlugins } from './assembly.js';
import { restrictTo } from './compare.js';
import { summarize, runTier, evalModelRounds, EVAL_RECURSION_LIMIT } from './compare.js';
import { intervalLines, summaryLines, tokenTotalsLine } from './compare-report.js';
import type { BenchmarkCase } from './dataset.js';
import type { MeasuredModel } from './tiers.js';

const TIER: MeasuredModel = {
  label: 'test',
  modelId: 'fake/model',
  measuredOn: '2026-01-01',
  note: '假的 —— 這個檔案不連外。',
};

/** 六條一模一樣難的題，只差 id。 */
const CASES: readonly BenchmarkCase[] = Array.from({ length: 6 }, (_, index) => ({
  id: `c${index}`,
  prompt: '回聲 a',
  expected: { toolCalls: [{ name: 'echo', args: { message: 'a' } }], mentions: ['a'] },
}));

const PASS: readonly ScriptedTurn[] = [
  {
    content: '',
    toolCalls: [{ name: 'echo', args: { message: 'a' } }],
    usage: { inputTokens: 100, outputTokens: 10 },
  },
  { content: 'a', usage: { inputTokens: 120, outputTokens: 5 } },
];

/** 只講話不動手：工具與參數那兩欄是 0，這題不成功。 */
const FAIL: readonly ScriptedTurn[] = [
  { content: '我想回聲', usage: { inputTokens: 100, outputTokens: 4 } },
];

/**
 * 由「這是第幾題的第幾次」決定這一次過不過。
 *
 * 同題的取樣依序進來，所以計數器記在題目 id 上。
 */
function byCaseAndSample(passes: (caseIndex: number, sample: number) => boolean) {
  const seen = new Map<string, number>();
  return (_modelId: string, testCase: BenchmarkCase): AgentModel => {
    const sample = seen.get(testCase.id) ?? 0;
    seen.set(testCase.id, sample + 1);
    const index = Number(testCase.id.slice(1));
    return new ScriptedChatModel({ turns: passes(index, sample) ? PASS : FAIL });
  };
}

async function summaryOf(passes: (caseIndex: number, sample: number) => boolean, samples: number) {
  const report = await runTier(TIER, {
    createModel: byCaseAndSample(passes),
    cases: CASES,
    samples,
  });
  return summarize(report);
}

describe('端到端：區間隨「換一題」變寬、不被「同題重跑」單獨撐大', () => {
  it('換一題結果就變：三題全過、三題全不過 → 區間寬', async () => {
    const summary = await summaryOf((index) => index < 3, 3);
    const interval = summary.caseStats.success?.interval;
    expect(summary.successes).toBe(9);
    expect(summary.scored).toBe(18);
    expect(interval).toBeDefined();
    expect((interval?.high ?? 0) - (interval?.low ?? 0)).toBeGreaterThan(0.3);
  });

  it('同題重跑結果就變：每題三次裡過一次 → 區間塌成一點，而範圍是 0–1', async () => {
    const summary = await summaryOf((_index, sample) => sample === 0, 3);
    const stats = summary.caseStats.success;
    // 18 次執行裡 6 次成功，每一題的成功率都是 1/3。
    expect(summary.successes).toBe(6);
    expect(stats?.mean).toBeCloseTo(1 / 3, 10);
    expect(stats?.interval?.low).toBeCloseTo(1 / 3, 10);
    expect(stats?.interval?.high).toBeCloseTo(1 / 3, 10);
    // 範圍（最小到最大）把重跑變異全算進去了：這就是它不能當誤差棒的原因。
    expect(summary.toolCallSuccess?.min).toBe(0);
    expect(summary.toolCallSuccess?.max).toBe(1);
  });

  it('前者比後者寬', async () => {
    const wide = await summaryOf((index) => index < 3, 3);
    const steady = await summaryOf((_index, sample) => sample === 0, 3);
    const w = (s: typeof wide): number =>
      (s.caseStats.success?.interval?.high ?? 0) - (s.caseStats.success?.interval?.low ?? 0);
    expect(w(wide)).toBeGreaterThan(w(steady));
  });
});

describe('報表印出「一題 = X 個百分點」', () => {
  it('六題一次：100/6 = 16.7，逐欄各印一行，方法與 n 都在字裡', async () => {
    const summary = await summaryOf((index) => index < 4, 1);
    const text = summaryLines(summary, []).join('\n');

    // 手算：六題，一題 = 100/6 = 16.666… → 16.7。這題成功、工具成功率、參數正確性、
    // 回覆提到四欄每一欄都判得動六題，所以四行都是 16.7。
    expect(text.match(/一題 = 16\.7 個百分點/g)).toHaveLength(4);
    expect(text).toContain('95% 區間');
    expect(text).toContain('以 6 題為單位重抽 2000 次');
  });

  it('最小到最大改叫「範圍」，不再是沒有名字的括號', async () => {
    const summary = await summaryOf((index) => index < 4, 1);
    const text = summaryLines(summary, []).join('\n');
    expect(text).toContain('（範圍 0.00–1.00）');
    expect(text).not.toMatch(/\(\d\.\d\d–\d\.\d\d\)/);
  });

  it('只有判得動的題數進分母：不是每一欄都是題目總數', async () => {
    // 一題不期望任何工具呼叫、也沒有 mentions 以外的可判欄：工具與參數那兩欄判不動它。
    const restraint: BenchmarkCase = {
      id: 'c9',
      prompt: '不要用工具',
      expected: { toolCalls: [], mentions: ['a'] },
    };
    const report = await runTier(TIER, {
      createModel: byCaseAndSample(() => true),
      cases: [...CASES.slice(0, 3), restraint],
    });
    const stats = summarize(report).caseStats;
    expect(stats.toolCallSuccess?.cases).toBe(3);
    expect(stats.toolCallSuccess?.pointsPerCase).toBeCloseTo(33.33, 1);
    expect(stats.mentions?.cases).toBe(4);
    expect(stats.mentions?.pointsPerCase).toBe(25);
  });
});

describe('失敗那幾次的 token 也進成本', () => {
  const ERROR_AFTER_ONE_CALL: readonly ScriptedTurn[] = [
    {
      content: '',
      toolCalls: [{ name: 'echo', args: { message: 'a' } }],
      usage: { inputTokens: 300, outputTokens: 20 },
    },
    { content: '', error: '端點掛了' },
  ];

  it('含失敗的一輪：合計等於每一次執行的 token 加總，評到分的與失敗的分開列', async () => {
    const scripts = [PASS, ERROR_AFTER_ONE_CALL, FAIL, ERROR_AFTER_ONE_CALL];
    let next = 0;
    const report = await runTier(TIER, {
      createModel: () => new ScriptedChatModel({ turns: scripts[next++ % scripts.length] ?? [] }),
      cases: CASES.slice(0, 4),
    });
    const summary = summarize(report);

    // 腳本裡寫死的用量，不經過任何被測的程式碼：
    //   PASS  = (100+10) + (120+5) = 235
    //   FAIL  = 100+4 = 104
    //   ERROR = 300+20 = 320，兩次
    expect(summary.scored).toBe(2);
    expect(summary.failures).toEqual({ transport: 2 });
    expect(summary.tokenTotals).toEqual({
      scored: 235 + 104,
      failed: 320 * 2,
      all: 235 + 104 + 320 * 2,
      failedRuns: 2,
      failedReported: 2,
    });
    // 原本的平均仍然只算評到分的，沒有被失敗的執行拉動。
    expect(summary.totalTokens?.mean).toBeCloseTo((235 + 104) / 2, 10);
  });

  it('被迴圈上限切掉的那一輪：已經花掉的 token 一輪一輪都記到', async () => {
    const report = await runTier(TIER, {
      createModel: () => new LoopingChatModel(),
      cases: CASES.slice(0, 1),
    });
    const outcome = report.outcomes[0];
    expect(outcome?.kind).toBe('failed');
    if (outcome?.kind !== 'failed') return;
    expect(outcome.reason).toBe('budget');

    // 每一輪模型呼叫 `looping-model.ts` 回報 100＋10 = 110；上限 40 約 13 輪（見 compare.ts）。
    // 實測 2026-10-04：13 輪、1430（輸入 1300＋輸出 130），與 `evalModelRounds` 一致。
    const rounds = evalModelRounds(EVAL_RECURSION_LIMIT);
    expect(outcome.usage?.totalTokens).toBe(110 * rounds);
  });

  it('一次都沒記到就是 undefined，不是零；合計那一行不憑空出現', async () => {
    const report = await runTier(TIER, {
      createModel: () => new ScriptedChatModel({ turns: [{ content: '', error: '一開口就拋' }] }),
      cases: CASES.slice(0, 2),
    });
    for (const outcome of report.outcomes) {
      expect(outcome.kind).toBe('failed');
      if (outcome.kind === 'failed') expect(outcome.usage).toBeUndefined();
    }
    const summary = summarize(report);
    expect(summary.tokenTotals).toBeUndefined();
    expect(summaryLines(summary, []).join('\n')).not.toContain('token 合計');
  });

  it('報表有一行 token 合計，三個數字與下限的說明都在', async () => {
    const scripts = [PASS, ERROR_AFTER_ONE_CALL];
    let next = 0;
    const report = await runTier(TIER, {
      createModel: () => new ScriptedChatModel({ turns: scripts[next++ % scripts.length] ?? [] }),
      cases: CASES.slice(0, 2),
    });
    const text = summaryLines(summarize(report), []).join('\n');
    expect(text).toContain(
      'token 合計  評到分 235 ＋ 失敗 320（1 次失敗中 1 次有記到，是下限） ＝ 555',
    );
  });
});

describe('記帳的觀察者', () => {
  it('串流路徑（逐字塊聚合成的訊息）一樣量得到用量', async () => {
    // 真模型在 web 走串流、在 eval 走 invoke；但基座一旦裝了串流 handler，invoke 也會被導到
    // 串流那條路（見 scripted-model.ts 的 `_streamResponseChunks`）。兩條路的訊息型別不同
    // （AIMessage 與 AIMessageChunk），觀察者兩邊都要認得。
    const seen: number[] = [];
    const tally = new UsageTally((usage) => seen.push(usage.totalTokens));
    const model = new ScriptedChatModel({ turns: PASS });
    for await (const chunk of await model.stream([new HumanMessage('x')], {
      callbacks: [tally],
    })) {
      void chunk;
    }
    expect(seen).toEqual([110]);
  });
});

describe('兩本帳是同一把尺量的', () => {
  it('回呼累計的用量等於最終訊息串加總的用量（評到分的與失敗的才能加在一起）', async () => {
    // 評到分的 token 從最終訊息串加總，失敗的從每次呼叫結束時累計；合計那一行把兩邊相加。
    // 這條證明在同一次成功的執行上，兩種算法量到一樣的數字。**只用腳本模型驗過**：真模型
    // 走的 handleLLMEnd 沒有跑過（需要憑證），子代理與側呼叫若繼承了回呼，兩邊會分開。
    let tallied = 0;
    const run = await runBenchmarkCase(CASES[0] as BenchmarkCase, {
      model: new ScriptedChatModel({ turns: PASS }),
      plugins: benchmarkPlugins(),
      onUsage: (usage) => {
        tallied += usage.totalTokens;
      },
    });
    expect(run.usage?.totalTokens).toBe(235);
    expect(tallied).toBe(run.usage?.totalTokens);
  });
});

describe('survey 的版面：全部與難題兩組各自的區間', () => {
  // 三條簡單題、四條難題，期望都一樣（只差 id）；簡單題全過、難題兩過兩不過。
  const named = (prefix: string, count: number): BenchmarkCase[] =>
    Array.from({ length: count }, (_, index) => ({
      ...(CASES[0] as BenchmarkCase),
      id: `${prefix}${index}`,
    }));
  const easy = named('e', 3);
  const hard = named('h', 4);

  it('難題只有四題，區間比全部那組寬', async () => {
    const report = await runTier(TIER, {
      createModel: (_id, testCase) => {
        const pass = testCase.id.startsWith('e') || Number(testCase.id.slice(1)) < 2;
        return new ScriptedChatModel({ turns: pass ? PASS : FAIL });
      },
      cases: [...easy, ...hard],
    });
    const allSummary = summarize(report);
    const hardSummary = summarize(restrictTo(report, new Set(hard.map((entry) => entry.id))));

    const text = intervalLines(allSummary.caseStats.success, hardSummary.caseStats.success).join(
      '\n',
    );
    expect(text).toContain('全部 題均');
    expect(text).toContain('難題 題均');
    expect(text).toContain('以 7 題為單位重抽');
    expect(text).toContain('以 4 題為單位重抽');
    const width = (s: typeof allSummary): number =>
      (s.caseStats.success?.interval?.high ?? 0) - (s.caseStats.success?.interval?.low ?? 0);
    expect(width(hardSummary)).toBeGreaterThan(width(allSummary));
    expect(tokenTotalsLine(allSummary)).toContain('評到分');
  });
});
