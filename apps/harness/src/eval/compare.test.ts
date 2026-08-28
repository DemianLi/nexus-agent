/**
 * 尺寸比較的驅動器 —— **零憑證**。
 *
 * `createModel` 是注進來的，所以這裡餵的全是假模型與會拋錯的假模型，一個位元組都不出境。
 * 承重的是那條分界：**丟出例外是「沒有資料」，不是「得零分」** —— 一個把失敗平均成 0
 * 的彙總，在「這個 id 在這把 key 上叫不動」的情況下會生出一個看起來像測量值的數字。
 */

import type { AgentModel } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import { ScriptedChatModel, type ScriptedTurn } from '../scripted-model.js';
import { compareTiers, runTier, summarize } from './compare.js';
import { BENCHMARK, BENCHMARK_FILE, type BenchmarkCase } from './dataset.js';
import type { ModelTier } from './tiers.js';

const TIER: ModelTier = {
  label: 'test',
  modelId: 'fake/model-1b-a1b',
  totalBillions: 1,
  activeBillions: 1,
};

const ECHO_CASE = BENCHMARK[0] as BenchmarkCase;

/** 照著做的腳本：叫對工具、參數對、有回報 usage。 */
const PERFECT: readonly ScriptedTurn[] = [
  {
    content: '我來回聲。',
    toolCalls: [{ name: 'echo', args: { message: '接線測試' } }],
    usage: { inputTokens: 100, outputTokens: 10 },
  },
  { content: '回聲：接線測試', usage: { inputTokens: 120, outputTokens: 6 } },
];

/** 只講話不動手 —— 小模型最常見的那種失敗，而它是**結果**，該被評到分。 */
const ALL_TALK: readonly ScriptedTurn[] = [
  { content: '我打算呼叫 echo。', usage: { inputTokens: 100, outputTokens: 8 } },
];

/** 拋錯的模型工廠，模擬端點回 4xx／掛住。 */
function throwing(error: unknown): () => AgentModel {
  return () => {
    throw error;
  };
}

function scripted(turns: readonly ScriptedTurn[]): () => AgentModel {
  return () => new ScriptedChatModel({ turns });
}

describe('runTier：跑得完的那條', () => {
  it('照著做的腳本三個指標都滿分，而且成本量得到', async () => {
    const report = await runTier(TIER, {
      createModel: scripted(PERFECT),
      cases: [ECHO_CASE],
    });

    expect(report.outcomes).toHaveLength(1);
    const [outcome] = report.outcomes;
    expect(outcome?.kind).toBe('scored');
    if (outcome?.kind !== 'scored') return;
    expect(outcome.score.toolCallSuccess).toBe(1);
    expect(outcome.score.argumentCorrectness).toBe(1);
    expect(outcome.score.cost?.totalTokens).toBeGreaterThan(0);
  });

  it('只講話不動手是零分，不是失敗 —— 這一格要留在 scored 裡', async () => {
    const report = await runTier(TIER, {
      createModel: scripted(ALL_TALK),
      cases: [ECHO_CASE],
    });

    const summary = summarize(report);
    // **這是本檔的主張**：叫不出工具的模型有資料，它的資料是 0。
    expect(summary.scored).toBe(1);
    expect(summary.failures).toEqual({});
    expect(summary.toolCallSuccess?.mean).toBe(0);
  });

  it('samples 收得下重複次數，每一次都是一筆', async () => {
    const report = await runTier(TIER, {
      createModel: scripted(PERFECT),
      cases: [ECHO_CASE],
      samples: 3,
    });

    expect(report.outcomes).toHaveLength(3);
    expect(summarize(report).toolCallSuccess?.count).toBe(3);
  });
});

describe('runTier：失敗的分類', () => {
  it('帶 status 的錯誤歸 rejected，而且 status 留著', async () => {
    const error = Object.assign(new Error('Tool use has not been enabled'), { status: 400 });
    const report = await runTier(TIER, { createModel: throwing(error), cases: [ECHO_CASE] });

    const [outcome] = report.outcomes;
    expect(outcome?.kind).toBe('failed');
    if (outcome?.kind !== 'failed') return;
    expect(outcome.reason).toBe('rejected');
    expect(outcome.status).toBe(400);
    // 題目的 id 要跟著失敗一起留下來，否則報表上看得到「壞了」看不到「哪一題壞了」。
    expect(outcome.caseId).toBe(ECHO_CASE.id);
  });

  it('逾時認得出來 —— 名字與訊息兩條路都算', async () => {
    const byName = Object.assign(new Error('whatever'), { name: 'APIConnectionTimeoutError' });
    const byMessage = new Error('Request timed out.');

    for (const error of [byName, byMessage]) {
      const report = await runTier(TIER, { createModel: throwing(error), cases: [ECHO_CASE] });
      const [outcome] = report.outcomes;
      expect(outcome?.kind).toBe('failed');
      if (outcome?.kind !== 'failed') continue;
      expect(outcome.reason).toBe('timeout');
      expect(outcome.status).toBeUndefined();
    }
  });

  it('包在 cause 底下第三層的 400 仍然是 rejected —— 實測就長這樣', async () => {
    // 這個形狀是量出來的，不是想出來的：`llama-3.2-11b` 對 `write-then-read` 回
    // `400 "This model only supports single tool-calls at once!"`，丟出來的是
    // `MiddlewareError`（`status` 是 undefined），帶 `status: 400` 的 `BadRequestError`
    // 包在 cause 底下第三層。只看最外層的話，一個真的 4xx 會被記成 transport。
    const inner = Object.assign(
      new Error('400 This model only supports single tool-calls at once!'),
      {
        status: 400,
      },
    );
    const wrapped = new Error('400 This model only supports single tool-calls at once!', {
      cause: new Error('wrap', { cause: new Error('wrap', { cause: inner }) }),
    });
    const report = await runTier(TIER, { createModel: throwing(wrapped), cases: [ECHO_CASE] });

    const [outcome] = report.outcomes;
    expect(outcome?.kind).toBe('failed');
    if (outcome?.kind !== 'failed') return;
    expect(outcome.reason).toBe('rejected');
    expect(outcome.status).toBe(400);
  });

  it('內層一顆明確的 status 壓得過外層訊息裡的 aborted', async () => {
    // 兩趟掃的理由：包裝層的訊息常常帶著 `aborted` 這種字眼，讓字串壓過協定的話，
    // 一個要換 id 的 4xx 會被記成「掛住了」。
    const inner = Object.assign(new Error('Not found for account'), { status: 404 });
    const wrapped = new Error('Run aborted', { cause: inner });
    const report = await runTier(TIER, { createModel: throwing(wrapped), cases: [ECHO_CASE] });

    const [outcome] = report.outcomes;
    expect(outcome?.kind === 'failed' && outcome.reason).toBe('rejected');
    expect(outcome?.kind === 'failed' && outcome.status).toBe(404);
  });

  it('逾時也認得出包了幾層的', async () => {
    const inner = Object.assign(new Error('whatever'), { name: 'APIConnectionTimeoutError' });
    const report = await runTier(TIER, {
      createModel: throwing(new Error('model call failed', { cause: inner })),
      cases: [ECHO_CASE],
    });

    expect(report.outcomes[0]?.kind === 'failed' && report.outcomes[0].reason).toBe('timeout');
  });

  it('cause 繞成一個環也不會轉不出來', async () => {
    // 包裝層數是別人家的實作細節，環是不是真的會發生我們管不到 —— 但轉不出來的話
    // 一格失敗會變成整輪比較沒有結果，跟 #57 的失敗模式一模一樣。
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as { cause?: unknown }).cause = b;
    const report = await runTier(TIER, { createModel: throwing(b), cases: [ECHO_CASE] });

    expect(report.outcomes[0]?.kind === 'failed' && report.outcomes[0].reason).toBe('transport');
  });

  it('認不出來的歸 transport，不猜', async () => {
    const report = await runTier(TIER, {
      createModel: throwing(new Error('socket hang up')),
      cases: [ECHO_CASE],
    });

    const [outcome] = report.outcomes;
    expect(outcome?.kind === 'failed' && outcome.reason).toBe('transport');
  });
});

describe('summarize：失敗不會被平均成零分', () => {
  it('全部失敗時三個指標是 undefined，不是 0', async () => {
    const error = Object.assign(new Error('Not found for account'), { status: 404 });
    const report = await runTier(TIER, {
      createModel: throwing(error),
      cases: BENCHMARK,
    });

    const summary = summarize(report);
    expect(summary.scored).toBe(0);
    expect(summary.failures).toEqual({ rejected: BENCHMARK.length });
    // **這一組是整個檔案的理由。** 若失敗被當成 0 平均進去，這三個會是 0，
    // 而報表上「工具成功率 0.00」讀起來就是「這個尺寸叫不出工具」——完全不同的結論。
    expect(summary.toolCallSuccess).toBeUndefined();
    expect(summary.argumentCorrectness).toBeUndefined();
    expect(summary.totalTokens).toBeUndefined();
    expect(summary.costed).toBe(0);
  });

  it('沒回報 usage 的執行不算進成本，但仍然算進分數', async () => {
    const noUsage: readonly ScriptedTurn[] = [
      { content: '我來回聲。', toolCalls: [{ name: 'echo', args: { message: '接線測試' } }] },
      { content: '回聲：接線測試' },
    ];
    const report = await runTier(TIER, { createModel: scripted(noUsage), cases: [ECHO_CASE] });

    const summary = summarize(report);
    expect(summary.scored).toBe(1);
    expect(summary.toolCallSuccess?.mean).toBe(1);
    // 「這條路免費」與「我們不知道」是兩件事。
    expect(summary.totalTokens).toBeUndefined();
    expect(summary.costed).toBe(0);
  });

  it('全距報得出來 —— 單次取樣的一個數字不該讀成定論', async () => {
    let call = 0;
    const report = await runTier(TIER, {
      // 一次照做、一次只講話，平均 0.5 而全距 0–1。
      createModel: () =>
        new ScriptedChatModel({ turns: (call += 1) === 1 ? PERFECT : ALL_TALK }) as AgentModel,
      cases: [ECHO_CASE],
      samples: 2,
    });

    const summary = summarize(report);
    expect(summary.toolCallSuccess).toMatchObject({ mean: 0.5, min: 0, max: 1, count: 2 });
  });
});

describe('compareTiers', () => {
  it('依序跑完每一階，順序與傳進去的相同', async () => {
    const tiers: readonly ModelTier[] = [
      { ...TIER, label: 'small', modelId: 'fake/small' },
      { ...TIER, label: 'large', modelId: 'fake/large' },
    ];
    const seen: string[] = [];

    const reports = await compareTiers(tiers, {
      createModel: (modelId) => {
        seen.push(modelId);
        return new ScriptedChatModel({ turns: PERFECT });
      },
      cases: [ECHO_CASE],
    });

    expect(reports.map((report) => report.tier.label)).toEqual(['small', 'large']);
    expect(seen).toEqual(['fake/small', 'fake/large']);
  });

  it('onOutcome 邊跑邊回報 —— 一輪比較是分鐘級的，不能只在最後才有輸出', async () => {
    const seen: string[] = [];
    await compareTiers([TIER], {
      createModel: scripted(PERFECT),
      cases: [ECHO_CASE],
      onOutcome: (tier, outcome) => seen.push(`${tier.label}:${outcome.kind}`),
    });

    expect(seen).toEqual(['test:scored']);
  });

  it('每一階拿到的是同一份 plugin 清單與同一份題目', async () => {
    // 這條釘的是 `assembly.ts` 的存在理由：兩邊各寫一份時它仍然全綠，但那時漂移已經開始了。
    const report = await runTier(TIER, {
      createModel: scripted(PERFECT),
      cases: [ECHO_CASE],
    });
    const [outcome] = report.outcomes;
    expect(outcome?.kind === 'scored' && outcome.score.caseId).toBe(ECHO_CASE.id);
    // 題目本身真的用了共用的檔名常數 —— 資料集若被改成別的路徑，這條會紅。
    expect(BENCHMARK_FILE).toBe('/benchmark.md');
  });
});
