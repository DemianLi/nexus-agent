import type { TokenMeterSpan } from '@nexus/wire';
import {
  TOKEN_METER_CALIBER,
  TOKEN_METER_PROJECTION,
  TOKEN_METER_VERSION,
  emptyConversation,
  reduceAll,
} from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { Script } from '@/test/conversation-frames';
import {
  meterLink,
  meterTurn,
  meterView,
  span,
  withMeter,
  withSubagentMeter,
} from '@/test/token-meter-fixtures';
import {
  call,
  digest,
  projectionFrame,
  turn,
  view,
  withTrajectory,
} from '@/test/trajectory-fixtures';
import {
  COST_STRUCTURED_LIMITS,
  DERIVED_CALIBER,
  METER_END_LABEL,
  caliberOf,
  costSubagents,
  costTurnRows,
  distributionRows,
  revealableSeqs,
  sameTurnRow,
  signedDuration,
  spanRows,
  subagentTitles,
  tokenMeterOf,
  tokensWithSubagents,
} from '@/lib/token-meter-view';

const base = () => {
  const script = new Script();
  return { script, state: reduceAll(emptyConversation(), [script.running(), script.completed()]) };
};

describe('閘門：只認 key、版本、沒拋過、形狀對的用量投影', () => {
  it('合格的值讀得到', () => {
    const { script, state } = base();
    const meter = meterView({ turns: [meterTurn(0)] });
    expect(tokenMeterOf(withMeter(state, script, meter).projections)).toEqual(meter);
  });

  it.each([
    [
      '版本不認得',
      (s: Script) =>
        projectionFrame(s, TOKEN_METER_PROJECTION, TOKEN_METER_VERSION + 1, meterView()),
    ],
    [
      '拋過（failed）',
      (s: Script) =>
        projectionFrame(s, TOKEN_METER_PROJECTION, TOKEN_METER_VERSION, null, { failed: true }),
    ],
    [
      '形狀不對：turns 不是陣列',
      (s: Script) =>
        projectionFrame(s, TOKEN_METER_PROJECTION, TOKEN_METER_VERSION, {
          ...meterView(),
          turns: 'x',
        }),
    ],
    [
      '形狀不對：session 缺格',
      (s: Script) =>
        projectionFrame(s, TOKEN_METER_PROJECTION, TOKEN_METER_VERSION, {
          ...meterView(),
          session: {},
        }),
    ],
    [
      '形狀不對：links 缺',
      (s: Script) =>
        projectionFrame(s, TOKEN_METER_PROJECTION, TOKEN_METER_VERSION, {
          ...meterView(),
          links: undefined,
        }),
    ],
    [
      '值是 null',
      (s: Script) => projectionFrame(s, TOKEN_METER_PROJECTION, TOKEN_METER_VERSION, null),
    ],
  ])('%s：當成沒有', (_label, frame) => {
    const { script, state } = base();
    expect(tokenMeterOf(reduceAll(state, [frame(script)]).projections)).toBeUndefined();
  });

  it('沒有任何投影：沒有', () => {
    expect(tokenMeterOf(base().state.projections)).toBeUndefined();
  });
});

describe('spanRows：每一格都帶口徑表的鍵', () => {
  it('零值的選填格不畫，token 與呼叫數永遠畫（0 是真的答案）', () => {
    const rows = spanRows(span());
    const fields = rows.map(([field]) => field);
    expect(fields).toEqual([
      'inputTokens',
      'outputTokens',
      'tokensTotal',
      'steps',
      'toolCalls',
      'modelMs',
      'toolMs',
    ]);
    expect(rows.find(([f]) => f === 'inputTokens')?.[2]).toBe('0 token');
  });

  it('有呼叫沒報用量：token 三格標「下限」，並多一格講幾次沒報', () => {
    const rows = spanRows(span({ steps: 3, unknownSteps: 1, inputTokens: 100, outputTokens: 10 }));
    const byField = Object.fromEntries(rows.map(([f, , v]) => [f, v]));
    expect(byField.inputTokens).toBe('100 token（下限）');
    expect(byField.outputTokens).toBe('10 token（下限）');
    expect(byField.tokensTotal).toBe('110 token（下限）');
    expect(byField.unknownSteps).toBe('1 次');
  });

  it('沒有沒報用量的呼叫：不標下限', () => {
    const rows = spanRows(span({ steps: 1, inputTokens: 100 }));
    expect(rows.find(([f]) => f === 'inputTokens')?.[2]).toBe('100 token');
    expect(rows.some(([f]) => f === 'unknownSteps')).toBe(false);
  });

  it('失敗、重試、生摘要、等待各自在有值時才出現；摘要用量另列', () => {
    const rows = spanRows(
      span({
        steps: 4,
        failedSteps: 1,
        failedInputTokens: 30,
        failedOutputTokens: 3,
        inputTokens: 400,
        outputTokens: 40,
        retries: 2,
        retryWaitMs: 1500,
        waitMs: 2000,
        summaries: 1,
        summariesUnknown: 1,
        summaryInputTokens: 900,
        summaryOutputTokens: 90,
        toolCalls: 3,
        toolErrors: 1,
      }),
    );
    const byField = Object.fromEntries(rows.map(([f, , v]) => [f, v]));
    expect(byField.failedInputTokens).toBe('30 token');
    expect(byField.failedSteps).toBe('1 次');
    expect(byField.retries).toBe('2 次');
    expect(byField.retryWaitMs).toBe('1.5 秒');
    expect(byField.waitMs).toBe('2 秒');
    expect(byField.summaries).toBe('1 次');
    expect(byField.summariesUnknown).toBe('1 次');
    expect(byField.summaryInputTokens).toBe('900 token');
    // 摘要的用量不在輸入裡。
    expect(byField.inputTokens).toBe('400 token');
    expect(byField.toolErrors).toBe('1 次');
  });

  it('殘差只有一輪才有，而且負的照實寫、加標記，不夾 0', () => {
    const negative = meterTurn(0, { unaccountedMs: -1200 });
    const rows = spanRows(negative, negative);
    const row = rows.find(([f]) => f === 'unaccountedMs');
    expect(row?.[1]).toContain('前提被破壞');
    expect(row?.[2]).toBe('−1.2 秒');
    expect(spanRows(span()).some(([f]) => f === 'unaccountedMs')).toBe(false);
    const positive = meterTurn(1, { unaccountedMs: 250 });
    expect(spanRows(positive, positive).find(([f]) => f === 'unaccountedMs')?.[2]).toBe('0.3 秒');
  });

  it('殘差缺席（沒收尾的輪）就不畫那一格', () => {
    const open = { ...meterTurn(0), unaccountedMs: undefined };
    expect(spanRows(open, open).some(([f]) => f === 'unaccountedMs')).toBe(false);
  });

  it('畫得出來的每一格都有口徑句，而且口徑表的鍵都真的存在', () => {
    const everything = meterTurn(0, {
      failedSteps: 1,
      unknownSteps: 1,
      failedInputTokens: 1,
      failedOutputTokens: 1,
      summaries: 1,
      summariesUnknown: 1,
      summaryInputTokens: 1,
      summaryOutputTokens: 1,
      retries: 1,
      retryWaitMs: 1,
      toolErrors: 1,
      waitMs: 1,
      // 新 server 的形狀：失敗與生摘要也畫快取兩格（#724）。
      uncachedInputTokens: 1,
      cacheReadTokens: 1,
      cacheWriteTokens: 1,
      failedCacheReadTokens: 1,
      failedCacheWriteTokens: 1,
      summaryCacheReadTokens: 1,
      summaryCacheWriteTokens: 1,
    });
    const drawn = spanRows(everything, everything).map(([field]) => field);
    expect(drawn).toEqual(
      expect.arrayContaining([
        'failedCacheReadTokens',
        'failedCacheWriteTokens',
        'summaryCacheReadTokens',
        'summaryCacheWriteTokens',
      ]),
    );
    for (const [field] of spanRows(everything, everything)) {
      expect(caliberOf(field), field).toBeTypeOf('string');
    }
    for (const key of Object.keys(DERIVED_CALIBER))
      expect(TOKEN_METER_CALIBER[key]).toBeUndefined();
  });
});

describe('spanRows：四桶（#724）', () => {
  const buckets = (over: Partial<TokenMeterSpan> = {}) =>
    span({
      steps: 2,
      inputTokens: 1_000,
      uncachedInputTokens: 200,
      cacheReadTokens: 700,
      cacheWriteTokens: 100,
      outputTokens: 50,
      ...over,
    });
  const byField = (rows: ReturnType<typeof spanRows>) =>
    Object.fromEntries(rows.map(([f, , v]) => [f, v]));

  it('有未快取那一格：輸入只算未快取，快取讀、快取寫另列，合計四項相加，帶命中率', () => {
    const rows = spanRows(buckets());
    expect(rows.slice(0, 6).map(([f, l, v]) => [f, l, v])).toEqual([
      ['uncachedInputTokens', '輸入', '200 token'],
      ['cacheReadTokens', '快取讀', '700 token'],
      ['cacheWriteTokens', '快取寫', '100 token'],
      ['outputTokens', '輸出', '50 token'],
      ['tokensTotalBuckets', '合計', '1,050 token'],
      ['cacheHitRate', '快取命中率', '70.0%'],
    ]);
  });

  it('span 的 inputTokens 改成只算未快取：畫面逐格不變（#724 的釘子）', () => {
    const full = spanRows(buckets({ inputTokens: 1_000 }));
    const uncachedOnly = spanRows(buckets({ inputTokens: 200 }));
    expect(uncachedOnly).toEqual(full);
    // 逐輪也一樣：turn 是 span 加上起訖。
    const turn = meterTurn(0, buckets({ inputTokens: 1_000 }));
    expect(costTurnRows(meterView({ turns: [turn] }), new Set()).at(0)?.fields).toEqual(
      costTurnRows(meterView({ turns: [{ ...turn, inputTokens: 200 }] }), new Set()).at(0)?.fields,
    );
  });

  it('快取桶缺席（有呼叫沒報細節）：那一列寫沒記、合計不含它並標下限、命中率寫沒記，不是 0', () => {
    const only = byField(spanRows(buckets({ cacheWriteTokens: undefined })));
    expect(only.cacheReadTokens).toBe('700 token');
    expect(only.cacheWriteTokens).toBe('沒記');
    expect(only.tokensTotalBuckets).toBe('950 token（下限）');
    expect(only.cacheHitRate).toBe('沒記');
    const neither = byField(
      spanRows(buckets({ cacheReadTokens: undefined, cacheWriteTokens: undefined })),
    );
    expect(neither.cacheReadTokens).toBe('沒記');
    expect(neither.cacheWriteTokens).toBe('沒記');
    expect('cacheHitRate' in neither).toBe(false);
  });

  it('記了、一次都沒命中：命中率 0.0%，快取讀寫 0 照寫', () => {
    const rows = byField(spanRows(buckets({ cacheReadTokens: 0, cacheWriteTokens: 300 })));
    expect(rows.cacheReadTokens).toBe('0 token');
    expect(rows.cacheHitRate).toBe('0.0%');
  });

  it('有呼叫沒報用量：四桶那幾格都標下限', () => {
    const rows = byField(spanRows(buckets({ unknownSteps: 1 })));
    expect(rows.uncachedInputTokens).toBe('200 token（下限）');
    expect(rows.cacheReadTokens).toBe('700 token（下限）');
    expect(rows.tokensTotalBuckets).toBe('1,050 token（下限）');
  });

  it('舊 server（沒有未快取那一格）：照舊讀 inputTokens，不畫快取列、不畫命中率', () => {
    const rows = spanRows(span({ steps: 1, inputTokens: 100, outputTokens: 10 }));
    expect(rows.map(([f]) => f).slice(0, 3)).toEqual([
      'inputTokens',
      'outputTokens',
      'tokensTotal',
    ]);
    expect(rows.some(([f]) => f === 'cacheHitRate')).toBe(false);
  });

  it('每一格都找得到口徑，而且口徑不在投影的口徑表裡的（畫面自己算的）有自己的句子', () => {
    for (const [field] of spanRows(buckets())) {
      expect(caliberOf(field), field).toBeTypeOf('string');
    }
  });
});

describe('其他格式', () => {
  it('signedDuration：負數寫負號', () => {
    expect(signedDuration(-1200)).toBe('−1.2 秒');
    expect(signedDuration(1200)).toBe('1.2 秒');
  });

  it('收尾方式多一格「停在核准點」，其餘沿用軌跡的字', () => {
    expect(METER_END_LABEL.paused).toBe('停在核准點');
    expect(METER_END_LABEL.completed).toBe('完成');
    expect(METER_END_LABEL.interrupted).toBe('意外中斷');
  });

  it('依模型、依工具：缺快照的模型寫明不明，超過名額的併成「其他」', () => {
    const { models, tools } = distributionRows(
      span({
        models: [
          { model: 'm-a', steps: 2, inputTokens: 1000, outputTokens: 10 },
          { model: null, steps: 1, inputTokens: 5, outputTokens: 1 },
        ],
        modelsOther: { steps: 3, inputTokens: 7, outputTokens: 1 },
        tools: [{ name: 'ls', calls: 4, errors: 1 }],
        toolsOther: { calls: 2, errors: 0 },
      }),
    );
    expect(models.map(([label]) => label)).toEqual([
      'm-a',
      '（沒有請求快照，模型不明）',
      '其他模型',
    ]);
    expect(models[0]?.[1]).toBe('2 次・輸入 1,000／輸出 10');
    expect(tools).toEqual([
      ['ls', '4 次（1 次失敗）'],
      ['其他工具', '2 次'],
    ]);
  });
});

describe('逐輪的列', () => {
  it('編號是 index + 1、key 與 seq 對得上觀測分頁的 turn-<seq>；不認得的起因原樣顯示', () => {
    const meter = meterView({
      turns: [
        meterTurn(0, { seq: 5 }),
        meterTurn(1, { seq: 105, kind: 'goal' }),
        meterTurn(2, { seq: 205, kind: 'x-new' }),
      ],
    });
    const rows = costTurnRows(meter, new Set([5, 205]));
    expect(rows.map((row) => [row.key, row.seq, row.number])).toEqual([
      ['turn-5', 5, 1],
      ['turn-105', 105, 2],
      ['turn-205', 205, 3],
    ]);
    expect(rows.map((row) => row.kindLabel)).toEqual(['人的訊息', '目標排的輪', 'x-new']);
    expect(rows.map((row) => row.revealable)).toEqual([true, false, true]);
  });

  it('沒收尾的輪寫「進行中」，停在核准點的寫「停在核准點」', () => {
    const open = { ...meterTurn(0), end: undefined, wallMs: undefined, endTime: undefined };
    const rows = costTurnRows(
      meterView({ turns: [open, meterTurn(1, { end: 'paused' })] }),
      new Set(),
    );
    expect(rows.map((row) => row.endLabel)).toEqual(['進行中', '停在核准點']);
    expect(rows[0]?.wall).toBe('—');
  });

  it('列只放原始值：同內容、全新物件的整份 view，每列 sameTurnRow 成立；內容變了就不成立', () => {
    const meter = meterView({ turns: [meterTurn(0), meterTurn(1)] });
    const first = costTurnRows(meter, new Set([0]));
    const second = costTurnRows(structuredClone(meter), new Set([0]));
    expect(second).not.toBe(first);
    first.forEach((row, i) => expect(sameTurnRow(row, second[i]!)).toBe(true));
    const changed = costTurnRows(
      meterView({ turns: [meterTurn(0), meterTurn(1, { inputTokens: 101 })] }),
      new Set([0]),
    );
    expect(sameTurnRow(first[0]!, changed[0]!)).toBe(true);
    expect(sameTurnRow(first[1]!, changed[1]!)).toBe(false);
    // 觀測分頁那一輪被摺走了：鈕要跟著變。
    const gone = costTurnRows(meter, new Set());
    expect(sameTurnRow(first[0]!, gone[0]!)).toBe(false);
  });
});

describe('觀測分頁能定位到哪些輪', () => {
  it('軌跡的 turns 與 digests 都算；沒有軌跡就是空的', () => {
    const { script, state } = base();
    expect([...revealableSeqs(state)]).toEqual([]);
    const withView = withTrajectory(
      state,
      script,
      view([turn(5, { calls: [call(1)] })], { digests: [digest(1), digest(2)] }),
    );
    expect([...revealableSeqs(withView)].sort((a, b) => a - b)).toEqual([100, 200, 500]);
  });
});

describe('子代理：從 root 的 links 接回 subagentProjections', () => {
  it('每個 link 各自過閘門；投影還沒到的是 undefined，不是 0', () => {
    const { script, state } = base();
    const root = meterView({
      links: [
        meterLink('bg-1', { turn: 0 }),
        meterLink('fg-1', { mode: 'one-shot', turn: 0 }),
        meterLink('late'),
      ],
    });
    let next = withMeter(state, script, root);
    next = withSubagentMeter(next, script, 'bg-1', meterView({ turns: [meterTurn(0)] }));
    next = withSubagentMeter(
      next,
      script,
      'fg-1',
      meterView({ outside: span({ steps: 2, inputTokens: 50 }) }),
    );
    const rootView = tokenMeterOf(next.projections)!;
    const subagents = costSubagents(next, rootView);
    expect(subagents.map((s) => [s.runId, s.mode, s.turn, s.view === undefined])).toEqual([
      ['bg-1', 'continuable', 0, false],
      ['fg-1', 'one-shot', 0, false],
      ['late', 'continuable', undefined, true],
    ]);
    // 前景的 turns 是空的，數字全在 outside，session 仍是對的。
    expect(subagents[1]?.view?.session.inputTokens).toBe(50);
  });

  it('子代理那一格壞掉（版本不認得）只影響它自己', () => {
    const { script, state } = base();
    let next = withMeter(state, script, meterView({ links: [meterLink('a'), meterLink('b')] }));
    next = reduceAll(next, [
      projectionFrame(script, TOKEN_METER_PROJECTION, TOKEN_METER_VERSION + 1, meterView(), {
        session: 'a',
      }),
    ]);
    next = withSubagentMeter(next, script, 'b', meterView({ outside: span({ steps: 1 }) }));
    const subagents = costSubagents(next, tokenMeterOf(next.projections)!);
    expect(subagents.map((s) => s.view === undefined)).toEqual([true, false]);
  });

  it('含子代理的 token 只加 token；有一個沒數字、有呼叫沒報、有更早的沒列出，都是下限', () => {
    const root = meterView({ outside: span({ inputTokens: 100, outputTokens: 10 }), links: [] });
    const some = (input: number, unknown = 0) => ({
      runId: `r${input}`,
      callId: `c${input}`,
      mode: 'continuable' as const,
      turn: undefined,
      view: meterView({
        outside: span({ inputTokens: input, outputTokens: 1, unknownSteps: unknown }),
      }),
    });
    expect(tokensWithSubagents(root, [some(50), some(5)])).toEqual({
      total: 167,
      complete: true,
    });
    expect(tokensWithSubagents(root, [some(50, 1)]).complete).toBe(false);
    const pending = {
      runId: 'p',
      callId: 'cp',
      mode: 'continuable' as const,
      turn: undefined,
      view: undefined,
    };
    expect(tokensWithSubagents(root, [some(50), pending])).toMatchObject({
      total: 161,
      complete: false,
    });
    expect(tokensWithSubagents({ ...root, linksOmitted: 2 }, [some(50)]).complete).toBe(false);
    expect(
      tokensWithSubagents(meterView({ outside: span({ unknownSteps: 1 }) }), []).complete,
    ).toBe(false);
  });

  it('四桶：各自四項相加，不讀 inputTokens；有快取桶沒記就是下限', () => {
    const four = (inputTokens: number, over: Partial<TokenMeterSpan> = {}) =>
      span({
        inputTokens,
        uncachedInputTokens: 20,
        cacheReadTokens: 70,
        cacheWriteTokens: 10,
        outputTokens: 5,
        ...over,
      });
    const sub = (id: string, outside: TokenMeterSpan) => ({
      runId: id,
      callId: `c-${id}`,
      mode: 'continuable' as const,
      turn: undefined,
      view: meterView({ outside }),
    });
    const root = (inputTokens: number) => meterView({ outside: four(inputTokens), links: [] });
    // root 105、子代理 105：inputTokens 是完整 prompt 或只算未快取，合計都一樣。
    expect(tokensWithSubagents(root(100), [sub('a', four(100))])).toEqual({
      total: 210,
      complete: true,
    });
    expect(tokensWithSubagents(root(20), [sub('a', four(20))])).toEqual({
      total: 210,
      complete: true,
    });
    expect(
      tokensWithSubagents(root(100), [sub('a', four(100, { cacheWriteTokens: undefined }))])
        .complete,
    ).toBe(false);
  });
});

describe('子代理叫什麼', () => {
  const entries = (...calls: [callId: string, input: string, name?: string][]) => {
    const script = new Script();
    return reduceAll(emptyConversation(), [
      script.running(),
      ...calls.flatMap(([callId, input, name]) => [
        script.started(callId, name ?? 'subagent', JSON.parse(input) as Record<string, unknown>),
        script.finished(callId, '好'),
      ]),
      script.completed(),
    ]).entries;
  };
  const sub = (runId: string, callId: string, mode: 'one-shot' | 'continuable') => ({
    runId,
    callId,
    mode,
    turn: undefined,
    view: undefined,
  });

  it('背景的用 meta 帶的名字；前景的讀派它那顆呼叫的 subagent_type；都沒有就各自的退路，不編名字', () => {
    const all = entries(
      ['fg', '{"subagent_type":"researcher","description":"x"}'],
      ['fg2', '{"description":"沒給型別"}'],
      ['bad', '{}'],
    ).map((entry) =>
      entry.kind === 'tool' && entry.callId === 'bad' ? { ...entry, input: 'not json' } : entry,
    );
    const titles = subagentTitles(
      all,
      [
        sub('bg-1', 'c-bg', 'continuable'),
        sub('fg-1', 'fg', 'one-shot'),
        sub('fg-2', 'fg2', 'one-shot'),
        sub('fg-3', 'bad', 'one-shot'),
        sub('gone', 'unloaded', 'continuable'),
      ],
      new Map([['bg-1', 'writer']]),
    );
    expect([...titles]).toEqual([
      ['bg-1', 'writer'],
      ['fg-1', 'researcher'],
      ['fg-2', '子代理'],
      ['fg-3', '子代理'],
      ['gone', '背景子代理'],
    ]);
  });

  it('不是委派工具的呼叫就算 callId 對得上也不讀', () => {
    const titles = subagentTitles(
      entries(['x', '{"subagent_type":"sneaky"}', 'read_file']),
      [sub('r', 'x', 'one-shot')],
      new Map(),
    );
    expect(titles.get('r')).toBe('子代理');
  });
});

describe('失敗、生摘要、依模型也列三桶（#724）', () => {
  const fieldsOf = (rows: ReturnType<typeof spanRows>) =>
    Object.fromEntries(rows.map(([f, , v]) => [f, v]));
  const base = {
    steps: 3,
    failedSteps: 1,
    uncachedInputTokens: 200,
    inputTokens: 200,
    outputTokens: 20,
  };

  it('失敗的輸入是未快取的，快取讀寫各一格；缺席寫「沒記」，不是 0', () => {
    const rows = spanRows(
      span({
        ...base,
        failedInputTokens: 30,
        failedOutputTokens: 3,
        failedCacheReadTokens: 70,
      }),
    );
    expect(rows.find(([f]) => f === 'failedInputTokens')?.[1]).toBe(
      '其中失敗或中止的輸入（未快取）',
    );
    const byField = fieldsOf(rows);
    expect(byField.failedInputTokens).toBe('30 token');
    expect(byField.failedCacheReadTokens).toBe('70 token');
    expect(byField.failedCacheWriteTokens).toBe('沒記');
    expect(byField.failedOutputTokens).toBe('3 token');
  });

  it('失敗的呼叫全走快取（未快取是 0）也畫出來；沒有失敗就一格都不畫', () => {
    const cachedOnly = fieldsOf(
      spanRows(span({ ...base, failedCacheReadTokens: 500, failedCacheWriteTokens: 0 })),
    );
    expect(cachedOnly.failedInputTokens).toBe('0 token');
    expect(cachedOnly.failedCacheReadTokens).toBe('500 token');
    expect(cachedOnly.failedCacheWriteTokens).toBe('0 token');
    const none = spanRows(span(base)).map(([f]) => f);
    expect(none.some((f) => f.startsWith('failed') && f !== 'failedSteps')).toBe(false);
  });

  it('生摘要另列：未快取、快取讀、快取寫、輸出；沒報的快取格寫「沒記」', () => {
    const byField = fieldsOf(
      spanRows(
        span({
          ...base,
          summaries: 2,
          summaryInputTokens: 40,
          summaryOutputTokens: 9,
          summaryCacheReadTokens: 800,
        }),
      ),
    );
    expect(byField.summaryInputTokens).toBe('40 token');
    expect(byField.summaryCacheReadTokens).toBe('800 token');
    expect(byField.summaryCacheWriteTokens).toBe('沒記');
    expect(byField.summaryOutputTokens).toBe('9 token');
  });

  it('生摘要的快取讀沒報、寫有報：各自判斷，讀畫「沒記」、寫畫數字', () => {
    const byField = fieldsOf(
      spanRows(span({ ...base, summaries: 1, summaryInputTokens: 4, summaryCacheWriteTokens: 12 })),
    );
    expect(byField.summaryCacheReadTokens).toBe('沒記');
    expect(byField.summaryCacheWriteTokens).toBe('12 token');
  });

  it('舊 server（沒有未快取那一格）：失敗與摘要照舊，不畫快取兩格', () => {
    const rows = spanRows(
      span({
        steps: 2,
        inputTokens: 400,
        failedInputTokens: 30,
        failedOutputTokens: 3,
        summaries: 1,
        summaryInputTokens: 900,
        summaryOutputTokens: 90,
        failedCacheReadTokens: 5,
      }),
    );
    const fields = rows.map(([f]) => f);
    expect(fields).not.toContain('failedCacheReadTokens');
    expect(fields).not.toContain('summaryCacheReadTokens');
    expect(rows.find(([f]) => f === 'failedInputTokens')?.[1]).toBe('其中失敗或中止的輸入');
  });

  it('依模型的列：新 server 列出快取讀寫（缺席寫「沒記」），其他模型同；舊 server 照舊', () => {
    const { models } = distributionRows(
      span({
        uncachedInputTokens: 10,
        models: [
          {
            model: 'm-a',
            steps: 2,
            inputTokens: 1000,
            outputTokens: 10,
            cacheReadTokens: 7000,
            cacheWriteTokens: 0,
          },
          { model: 'm-b', steps: 1, inputTokens: 5, outputTokens: 1, cacheReadTokens: 3 },
        ],
        modelsOther: { steps: 3, inputTokens: 7, outputTokens: 1 },
      }),
    );
    expect(models.map(([, text]) => text)).toEqual([
      '2 次・輸入 1,000／快取讀 7,000／快取寫 0／輸出 10',
      '1 次・輸入 5／快取讀 3／快取寫 沒記／輸出 1',
      '3 次・輸入 7／快取讀 沒記／快取寫 沒記／輸出 1',
    ]);
    const legacy = distributionRows(
      span({ models: [{ model: 'm-a', steps: 2, inputTokens: 1000, outputTokens: 10 }] }),
    );
    expect(legacy.models[0]?.[1]).toBe('2 次・輸入 1,000／輸出 10');
  });

  it('口徑兩句不再說輸入含快取讀取', () => {
    expect(COST_STRUCTURED_LIMITS.scope).toContain('輸入只算未快取');
    expect(COST_STRUCTURED_LIMITS.scope).not.toContain('含失敗與中止的呼叫、含快取讀取');
    expect(DERIVED_CALIBER.tokensTotal).toContain('舊 server');
  });
});
