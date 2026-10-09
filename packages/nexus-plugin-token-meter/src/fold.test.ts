/**
 * 用量投影的折疊（[#1028](https://github.com/DemianLi/nexus-agent/issues/1028)）。
 *
 * **每個數字都是手算的**：事件是手造的，`time` 與 `seq` 明寫，算式寫在旁邊。手造事件證不到「失敗那一筆真的有人寫進日誌」，
 * 那一半（拿掉 #1022 的失敗進帳會紅）在 `apps/harness/src/token-meter-wire.test.ts`，那裡的日誌是真的組裝產生的。
 * 對帳測試把折出來的數字跟 core 的 `sessionStats`、`tokenUsage` 逐項對一遍——「不另造總帳」靠這個證明。
 */

import { createProjectionFold, deriveSessionStats, deriveTokenUsage } from '@nexus/core';
import type { SessionEvent } from '@nexus/core';
import {
  TOKEN_METER_LINKS_CAP,
  TOKEN_METER_MODELS_CAP,
  TOKEN_METER_TOOL_NAMES_CAP,
  TOKEN_METER_TURNS_KEEP,
} from '@nexus/wire';
import type { TokenMeterView } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import {
  applyTokenMeter,
  initialTokenMeter,
  tokenMeterPlugin,
  tokenMeterUnit,
  viewTokenMeter,
} from './index.js';

type Draft = readonly [time: number, type: string, data: unknown];

/** 手造一串事件：`seq` 從 0 起連號，`time` 明寫。 */
function log(...drafts: readonly Draft[]): SessionEvent[] {
  return drafts.map(
    ([time, type, data], seq) => ({ seq, time, type, data }) as unknown as SessionEvent,
  );
}

function fold(events: readonly SessionEvent[]): TokenMeterView {
  let state = initialTokenMeter();
  for (const event of events) state = applyTokenMeter(state, event);
  return viewTokenMeter(state);
}

const header = (model: string) => ({ header: { config: { model } }, reason: 'initial' });
const usage = (inputTokens: number, outputTokens: number, outcome?: 'error' | 'aborted') => ({
  inputTokens,
  outputTokens,
  totalTokens: inputTokens + outputTokens,
  ...(outcome === undefined ? {} : { outcome }),
});
const call = (callId: string, name: string) => ({ callId, name, arguments: '{}' });
const result = (callId: string, isError = false) => ({ callId, isError });

/**
 * 主場景（root）。時間單位 ms。
 *
 * 第 0 輪（邏輯輪，含一次核准暫停）：
 * ```
 *  t=0    turn/start message
 *  t=10   model/start            ┐ 呼叫 A：成功，模型 m-a
 *  t=11   request/header m-a     │
 *  t=12   model/usage 100/20     │
 *  t=40   model/end              ┘ 40-10 = 30
 *  t=40   tool/call c1 read, c2 read, c3 write
 *  t=41   interrupt/raised       （c3 要核准）
 *  t=50   tool/result c1 ok      c1 = [40,50]
 *  t=60   tool/result c2 error   c2 = [40,60]
 *  t=70   turn/end               （有 interrupt/raised ⇒ paused）
 *  t=170  turn/start resume      等待 170-70 = 100
 *  t=170  tool/call c3 write
 *  t=175  tool/result c3 ok      c3 = [170,175]
 *  t=180  model/start            ┐ 呼叫 B：失敗，m-a
 *  t=190  llm/retry-started 25   │ 退避 25
 *  t=238  model/usage 7/0 error  │
 *  t=240  model/end error        ┘ 240-180 = 60，扣退避 25 ⇒ 35
 *  t=250  model/start            ┐ 呼叫 C：成功，模型換成 m-b
 *  t=251  request/header m-b     │
 *  t=252  compaction/summary 300/40  （另列）
 *  t=280  model/usage 500/60     │
 *  t=290  model/end              ┘ 290-250 = 40
 *  t=300  turn/end               ⇒ completed
 * ```
 * 輪外（t=310–330）：一次 m-b 的呼叫，11/2，模型時間 330-310 = 20。
 * 第 1 輪：t=400 開、呼叫 D（t=410–420，沒有 usage ⇒ 用量未知）、t=430 `turn/failed`。
 */
function mainLog(): SessionEvent[] {
  return log(
    [0, 'turn/start', { kind: 'message', text: 'hi' }],
    [10, 'model/start', {}],
    [11, 'request/header', { ...header('m-a'), modelCall: 1 }],
    [12, 'model/usage', { ...usage(100, 20), modelCall: 1 }],
    [40, 'model/end', { modelCall: 1 }],
    [40, 'tool/call', call('c1', 'read')],
    [40, 'tool/call', call('c2', 'read')],
    [40, 'tool/call', call('c3', 'write')],
    [41, 'interrupt/raised', { interruptId: 'i1' }],
    [45, 'subagent/catalog', { childId: 't/bg-1', callId: 'c-agent', mode: 'continuable' }],
    [50, 'tool/result', result('c1')],
    [60, 'tool/result', result('c2', true)],
    [70, 'turn/end', {}],
    [170, 'turn/start', { kind: 'resume' }],
    [170, 'tool/call', call('c3', 'write')],
    [175, 'tool/result', result('c3')],
    [180, 'model/start', {}],
    [190, 'llm/retry-started', { retryId: 'r', retry: 1, waitedMs: 25 }],
    [238, 'model/usage', { ...usage(7, 0, 'error'), modelCall: 5 }],
    [240, 'model/end', { outcome: 'error' }],
    [250, 'model/start', {}],
    [251, 'request/header', header('m-b')],
    [
      252,
      'compaction/summary',
      { cutoffIndex: 1, messagesBefore: 3, filePath: null, usage: usage(300, 40) },
    ],
    [280, 'model/usage', usage(500, 60)],
    [290, 'model/end', {}],
    [300, 'turn/end', {}],
    [310, 'model/start', {}],
    [320, 'model/usage', usage(11, 2)],
    [330, 'model/end', {}],
    [400, 'turn/start', { kind: 'message', text: '再來' }],
    [410, 'model/start', {}],
    [420, 'model/end', {}],
    [430, 'turn/failed', { message: '壞了' }],
  );
}

describe('手算的主場景', () => {
  const view = fold(mainLog());
  const turn0 = view.turns[0]!;
  const turn1 = view.turns[1]!;

  it('兩個邏輯輪：resume 併回前一輪，不另開', () => {
    expect(view.totalTurns).toBe(2);
    expect(view.turns.map((turn) => [turn.index, turn.kind, turn.end])).toEqual([
      [0, 'message', 'completed'],
      [1, 'message', 'failed'],
    ]);
  });

  it('第 0 輪：步數、失敗、用量（成功＋失敗，摘要另列）', () => {
    // 步：A、B、C 各一個 model/end。
    expect(turn0.steps).toBe(3);
    expect(turn0.failedSteps).toBe(1);
    expect(turn0.unknownSteps).toBe(0); // 三次都有 usage
    // 輸入：100 + 7 + 500 = 607；輸出：20 + 0 + 60 = 80。失敗那筆 7/0 已含在裡面。
    expect([turn0.inputTokens, turn0.outputTokens]).toEqual([607, 80]);
    expect([turn0.failedInputTokens, turn0.failedOutputTokens]).toEqual([7, 0]);
    // 摘要那一次的 300/40 另列，不在上面。
    expect([turn0.summaries, turn0.summariesUnknown]).toEqual([1, 0]);
    expect([turn0.summaryInputTokens, turn0.summaryOutputTokens]).toEqual([300, 40]);
  });

  it('第 0 輪：模型 id 在 model/end 與 model/usage 當下才讀（request/header 落在 model/start 之後）', () => {
    // A：header(m-a) 在 usage 與 end 之前 ⇒ m-a。B：沒新 header ⇒ 還是 m-a。C：header(m-b) 在 usage 之前 ⇒ m-b。
    expect(turn0.models).toEqual([
      { model: 'm-a', steps: 2, inputTokens: 107, outputTokens: 20 }, // 100+7、20+0
      { model: 'm-b', steps: 1, inputTokens: 500, outputTokens: 60 },
    ]);
  });

  it('第 0 輪：工具次數依名分佈（核准後重記的 c3 只算一次）', () => {
    // c1、c2 是 read（c2 錯），c3 是 write；c3 第一次的 tool/call 沒有結果、不算。
    expect([turn0.toolCalls, turn0.toolErrors]).toEqual([3, 1]);
    expect(turn0.tools).toEqual([
      { name: 'read', calls: 2, errors: 1 },
      { name: 'write', calls: 1, errors: 0 },
    ]);
  });

  it('第 0 輪：三段時間與殘差對得上牆鐘', () => {
    // 模型：A 40-10=30；B 240-180=60 扣退避 25 ⇒ 35；C 290-250=40。合計 105。退避 25。
    expect(turn0.modelMs).toBe(105);
    expect([turn0.retries, turn0.retryWaitMs]).toEqual([1, 25]);
    // 工具各自：c1 10、c2 20、c3 5 ⇒ 35。聯集：[40,50]∪[40,60] = 20，加 [170,175] = 5 ⇒ 25。
    expect(turn0.toolSumMs).toBe(35);
    expect(turn0.toolMs).toBe(25);
    // 等待：turn/end(70) 到 resume 的 turn/start(170) = 100。
    expect(turn0.waitMs).toBe(100);
    // 牆鐘：最後一顆 turn/end(300) - 開輪(0) = 300。
    // 殘差 = 300 - 模型 105 - 工具 25 - 重試退避 25 - 核准等待 100 = 45。
    // 逐項列出那 45 ms 的空隙：[0,10] 開輪到第一次呼叫 10；[60,70] 最後一個工具到收尾 10；
    // [175,180] 工具到下一次呼叫 5；[240,250] 呼叫 B 到 C 10；[290,300] 呼叫 C 到收尾 10 ⇒ 10+10+5+10+10 = 45。
    expect(turn0.wallMs).toBe(300);
    expect(turn0.unaccountedMs).toBe(45);
  });

  it('第 1 輪：沒有 usage 的呼叫 ⇒ 用量未知，不是 0；turn/failed 收尾', () => {
    expect([turn1.steps, turn1.unknownSteps, turn1.inputTokens]).toEqual([1, 1, 0]);
    expect(turn1.models).toEqual([{ model: 'm-b', steps: 1, inputTokens: 0, outputTokens: 0 }]);
    expect(turn1.modelMs).toBe(10); // 420-410
    expect([turn1.wallMs, turn1.unaccountedMs]).toEqual([30, 20]); // 430-400；30-10
  });

  it('輪外：不在任何輪裡的呼叫落在 outside', () => {
    expect(view.outside.steps).toBe(1);
    expect([view.outside.inputTokens, view.outside.outputTokens]).toEqual([11, 2]);
    expect(view.outside.modelMs).toBe(20); // 330-310
  });

  it('會話總計 ＝ 輪外 ＋ 每一輪（逐輪加總對得回總計）', () => {
    const { session } = view;
    expect(session.steps).toBe(3 + 1 + 1);
    expect(session.unknownSteps).toBe(1);
    expect([session.inputTokens, session.outputTokens]).toEqual([607 + 0 + 11, 80 + 0 + 2]);
    expect(session.modelMs).toBe(105 + 10 + 20);
    expect(session.toolMs).toBe(25);
    expect(session.waitMs).toBe(100);
    expect(session.tools).toEqual([
      { name: 'read', calls: 2, errors: 1 },
      { name: 'write', calls: 1, errors: 0 },
    ]);
    // 會話總計的列序是「輪外、窗口外、各輪」併起來的順序，不保證是第一次出現的順序，所以先排。
    expect(
      [...session.models].sort((a, b) => String(a.model).localeCompare(String(b.model))),
    ).toEqual([
      { model: 'm-a', steps: 2, inputTokens: 107, outputTokens: 20 },
      { model: 'm-b', steps: 3, inputTokens: 511, outputTokens: 62 }, // C、D、輪外那次
    ]);
  });

  it('派出去的子代理連結：runId、callId、mode、派它的那一輪', () => {
    expect(view.links).toEqual([
      { runId: 'bg-1', callId: 'c-agent', mode: 'continuable', turn: 0 },
    ]);
  });
});

describe('對帳：不另造總帳', () => {
  const events = mainLog();
  const view = fold(events);

  it('逐輪模型時間 + 退避 ＝ sessionStats 的 llmMs；各自工具加總 ＝ toolMs；步數對得上', () => {
    const stats = deriveSessionStats(events);
    expect(view.session.modelMs + view.session.retryWaitMs).toBe(stats.llmMs);
    expect(view.session.toolSumMs).toBe(stats.toolMs);
    expect(view.session.steps).toBe(stats.steps);
  });

  it('輸入、輸出 token ＝ tokenUsage 總帳（失敗那筆兩邊都算）', () => {
    const totals = deriveTokenUsage(events);
    expect(view.session.inputTokens).toBe(totals.inputTokens);
    expect(view.session.outputTokens).toBe(totals.outputTokens);
  });
});

describe('子代理那一份：沒有 turn/start，數字全在 outside', () => {
  // 子代理 t=0 起：一次呼叫 m-c 50/5，兩個平行工具 [10,14]、[10,16]，一次沒有 usage 的呼叫。
  const child = fold(
    log(
      [0, 'model/start', {}],
      [1, 'request/header', header('m-c')],
      [2, 'model/usage', usage(50, 5)],
      [10, 'model/end', {}],
      [10, 'tool/call', call('a', 'read')],
      [10, 'tool/call', call('b', 'grep')],
      [14, 'tool/result', result('a')],
      [16, 'tool/result', result('b')],
      [20, 'model/start', {}],
      [26, 'model/end', { outcome: 'aborted' }],
    ),
  );

  it('沒有輪；全部在 outside；session 等於 outside', () => {
    expect(child.turns).toEqual([]);
    expect(child.totalTurns).toBe(0);
    expect(child.session).toEqual(child.outside);
  });

  it('步數、用量未知、工具聯集與各自加總', () => {
    expect([child.outside.steps, child.outside.failedSteps, child.outside.unknownSteps]).toEqual([
      2, 1, 1,
    ]);
    expect([child.outside.inputTokens, child.outside.outputTokens]).toEqual([50, 5]);
    expect(child.outside.modelMs).toBe(10 + 6); // 10-0、26-20
    // 聯集 [10,16] = 6；各自 4 + 6 = 10。
    expect([child.outside.toolMs, child.outside.toolSumMs]).toEqual([6, 10]);
    expect(child.outside.tools.map((row) => row.name)).toEqual(['read', 'grep']);
  });
});

describe('邊角', () => {
  it('不相干的事件回同一個參照（通道靠這個省掉下游工作）', () => {
    const state = initialTokenMeter();
    expect(applyTokenMeter(state, log([0, 'session/title', { title: 'x' }])[0]!)).toBe(state);
  });

  it('沒有 request/header 的舊日誌：模型 id 是 null，不猜', () => {
    const view = fold(
      log([0, 'model/start', {}], [1, 'model/usage', usage(1, 1)], [2, 'model/end', {}]),
    );
    expect(view.session.models).toEqual([
      { model: null, steps: 1, inputTokens: 1, outputTokens: 1 },
    ]);
  });

  it('生摘要沒報用量：計入 summariesUnknown，不是 0 token 的一筆', () => {
    const view = fold(
      log([0, 'compaction/summary', { cutoffIndex: 1, messagesBefore: 2, filePath: null }]),
    );
    expect([view.session.summaries, view.session.summariesUnknown]).toEqual([1, 1]);
    expect([view.session.summaryInputTokens, view.session.summaryOutputTokens]).toEqual([0, 0]);
  });

  it('resume 之前沒有收尾過（行程中途死了）：沒有可量的等待', () => {
    const view = fold(
      log(
        [0, 'turn/start', { kind: 'message' }],
        [500, 'turn/start', { kind: 'resume' }],
        [510, 'turn/end', {}],
      ),
    );
    expect(view.turns[0]?.waitMs).toBe(0);
    expect(view.totalTurns).toBe(1);
  });

  it('只有 resume、沒有前一輪（日誌被截過）：當成新的一輪開，不丟事件', () => {
    const view = fold(
      log([0, 'turn/start', { kind: 'resume' }], [5, 'model/start', {}], [9, 'model/end', {}]),
    );
    expect(view.totalTurns).toBe(1);
    expect(view.turns[0]?.modelMs).toBe(4);
  });

  it('callId 叫 constructor：不會讀到繼承來的東西', () => {
    const view = fold(
      log(
        [0, 'tool/call', call('constructor', 'read')],
        [4, 'tool/result', result('constructor')],
        [5, 'tool/result', result('toString')],
      ),
    );
    expect(view.session.toolCalls).toBe(1);
    expect(view.session.toolSumMs).toBe(4);
  });

  it('session/end-seed 清掉還開著的呼叫與工具：重啟後的結果不跟崩潰前的開頭配對', () => {
    const view = fold(
      log(
        [0, 'model/start', {}],
        [1, 'tool/call', call('a', 'read')],
        [2, 'session/end-seed', {}],
        [9000, 'tool/result', result('a')],
        [9001, 'model/end', {}],
      ),
    );
    // 沒配到的工具不算；沒配到 model/start 的 model/end 算一步但不計時。
    expect(view.session.toolCalls).toBe(0);
    expect(view.session.steps).toBe(1);
    expect(view.session.modelMs).toBe(0);
  });

  it('中止的輪（reason aborted）與撞到上限的輪', () => {
    const view = fold(
      log(
        [0, 'turn/start', { kind: 'message' }],
        [1, 'turn/end', { reason: { kind: 'aborted', cause: { kind: 'user' } } }],
        [2, 'turn/start', { kind: 'message' }],
        [3, 'turn/end', { reason: { kind: 'max-tokens' } }],
        [4, 'turn/start', { kind: 'message' }],
        [5, 'turn/end', { reason: { kind: 'blocked' } }],
      ),
    );
    expect(view.turns.map((turn) => turn.end)).toEqual(['aborted', 'max-tokens', 'blocked']);
  });

  it('停在核准點、還沒 resume：end 是 paused', () => {
    const view = fold(
      log(
        [0, 'turn/start', { kind: 'message' }],
        [1, 'interrupt/raised', { interruptId: 'i' }],
        [2, 'turn/end', {}],
      ),
    );
    expect(view.turns[0]?.end).toBe('paused');
  });
});

describe('窗口與上限：總數不因摺掉而變小', () => {
  it('超過窗口的輪併進 earlier，會話總計不變', () => {
    const drafts: Draft[] = [];
    const turns = TOKEN_METER_TURNS_KEEP + 5;
    for (let i = 0; i < turns; i += 1) {
      const t = i * 10;
      drafts.push(
        [t, 'turn/start', { kind: 'message' }],
        [t + 1, 'model/start', {}],
        [t + 2, 'model/usage', usage(10, 1)],
        [t + 5, 'model/end', {}],
        [t + 6, 'turn/end', {}],
      );
    }
    const view = fold(log(...drafts));
    expect(view.turns).toHaveLength(TOKEN_METER_TURNS_KEEP);
    expect(view.turns[0]?.index).toBe(5);
    expect(view.earlier?.turns).toBe(5);
    expect(view.earlier?.inputTokens).toBe(50);
    expect(view.totalTurns).toBe(turns);
    expect(view.session.inputTokens).toBe(10 * turns);
    expect(view.session.steps).toBe(turns);
    expect(view.session.modelMs).toBe(4 * turns);
  });

  it('工具名超過名額：多的併進 toolsOther，次數仍準', () => {
    const drafts: Draft[] = [];
    const names = TOKEN_METER_TOOL_NAMES_CAP + 3;
    for (let i = 0; i < names; i += 1) {
      drafts.push(
        [i * 2, 'tool/call', call(`c${i}`, `tool-${i}`)],
        [i * 2 + 1, 'tool/result', result(`c${i}`, i % 2 === 1)],
      );
    }
    const { session } = fold(log(...drafts));
    expect(session.tools).toHaveLength(TOKEN_METER_TOOL_NAMES_CAP);
    // 多出來的 tool-12、13、14：各一次，奇數的錯 ⇒ calls 3、errors 1。
    expect(session.toolsOther).toEqual({ calls: 3, errors: 1 });
    expect(session.toolCalls).toBe(names);
  });

  it('子代理連結超過上限：留最新的，其餘記進 linksOmitted', () => {
    const drafts: Draft[] = [];
    const total = TOKEN_METER_LINKS_CAP + 4;
    for (let i = 0; i < total; i += 1) {
      drafts.push([
        i,
        'subagent/catalog',
        { childId: `t/bg-${i}`, callId: `c${i}`, mode: 'one-shot' },
      ]);
    }
    const view = fold(log(...drafts));
    expect(view.links).toHaveLength(TOKEN_METER_LINKS_CAP);
    expect(view.links[0]?.runId).toBe('bg-4');
    expect(view.linksOmitted).toBe(4);
  });

  it('同一個子代理的目錄重複寫：只留一筆', () => {
    const data = { childId: 't/bg-1', callId: 'c', mode: 'one-shot' };
    expect(
      fold(log([0, 'subagent/catalog', data], [1, 'subagent/catalog', data])).links,
    ).toHaveLength(1);
  });
});

describe('快取分桶（#724）', () => {
  /** 格式 36 起的用量：`inputTokens` 是未快取那桶，快取兩格各自選填。 */
  const bucketed = (
    inputTokens: number,
    extra: { cacheReadTokens?: number; cacheWriteTokens?: number } = {},
  ) => ({
    inputTokens,
    outputTokens: 1,
    totalTokens: inputTokens + 1 + (extra.cacheReadTokens ?? 0) + (extra.cacheWriteTokens ?? 0),
    ...extra,
  });
  const oneCall = (time: number, data: unknown): Draft[] => [
    [time, 'model/start', {}],
    [time + 1, 'model/usage', data],
    [time + 2, 'model/end', {}],
  ];

  it('兩桶都報：inputTokens 只算未快取桶（等於 uncachedInputTokens），讀、寫各自加總，三桶相加才是完整 prompt', () => {
    const view = fold(
      log(
        [0, 'turn/start', { kind: 'message' }],
        ...oneCall(1, bucketed(30, { cacheReadTokens: 64, cacheWriteTokens: 100 })),
        ...oneCall(10, bucketed(5, { cacheReadTokens: 200, cacheWriteTokens: 0 })),
        [20, 'turn/end', {}],
      ),
    );
    const turn = view.turns[0]!;
    // 手算：未快取 30＋5、讀 64＋200、寫 100＋0；完整 prompt 194＋205＝399。
    expect([turn.uncachedInputTokens, turn.cacheReadTokens, turn.cacheWriteTokens]).toEqual([
      35, 264, 100,
    ]);
    expect(turn.inputTokens).toBe(35);
    expect(turn.inputTokens + turn.cacheReadTokens! + turn.cacheWriteTokens!).toBe(399);
    expect(view.session).toMatchObject({
      uncachedInputTokens: 35,
      cacheReadTokens: 264,
      cacheWriteTokens: 100,
      inputTokens: 35,
    });
  });

  it('快取寫是 0 也是「報了」：key 在、值是 0；沒報才缺席', () => {
    const wrote0 = fold(
      log(...oneCall(1, bucketed(10, { cacheReadTokens: 20, cacheWriteTokens: 0 }))),
    );
    expect(wrote0.outside).toMatchObject({ cacheReadTokens: 20, cacheWriteTokens: 0 });
    const readOnly = fold(log(...oneCall(1, bucketed(10, { cacheReadTokens: 20 }))));
    expect(readOnly.outside.cacheReadTokens).toBe(20);
    expect(readOnly.outside).not.toHaveProperty('cacheWriteTokens');
  });

  it('沒有快取細節（舊日誌、供應商沒給）：未快取桶就是整個 prompt，快取兩格缺席而不是 0', () => {
    const view = fold(log(...oneCall(1, usage(500, 5))));
    expect(view.outside.uncachedInputTokens).toBe(500);
    expect(view.outside).not.toHaveProperty('cacheReadTokens');
    expect(view.outside).not.toHaveProperty('cacheWriteTokens');
    // 還沒有任何用量事件：同樣缺席。
    expect(fold([]).session).not.toHaveProperty('cacheReadTokens');
    expect(fold([]).session.uncachedInputTokens).toBe(0);
  });

  it('一段裡只要有一次呼叫沒報就整格缺席；全報的那一輪仍然有，會話總計因混了而缺席', () => {
    const view = fold(
      log(
        [0, 'turn/start', { kind: 'message' }],
        ...oneCall(1, bucketed(10, { cacheReadTokens: 90 })),
        ...oneCall(10, usage(40, 1)), // 這一次沒報快取
        [20, 'turn/end', {}],
        [30, 'turn/start', { kind: 'message' }],
        ...oneCall(31, bucketed(7, { cacheReadTokens: 3 })),
        [40, 'turn/end', {}],
      ),
    );
    expect(view.turns[0]).not.toHaveProperty('cacheReadTokens');
    // 未快取桶不受影響：沒報細節的那次整個 prompt 就是未快取。
    expect(view.turns[0]?.uncachedInputTokens).toBe(50);
    expect(view.turns[1]?.cacheReadTokens).toBe(3);
    expect(view.session).not.toHaveProperty('cacheReadTokens');
    expect(view.session.uncachedInputTokens).toBe(57);
  });

  it('窗口外併成的 earlier 照同一條規則：全報才有', () => {
    const drafts: Draft[] = [];
    const turns = TOKEN_METER_TURNS_KEEP + 3;
    for (let i = 0; i < turns; i += 1) {
      const at = i * 10;
      drafts.push([at, 'turn/start', { kind: 'message' }]);
      drafts.push(...oneCall(at + 1, bucketed(10, { cacheReadTokens: 5 })));
      drafts.push([at + 5, 'turn/end', {}]);
    }
    const view = fold(log(...drafts));
    // 23 輪：最近 20 輪在窗口裡，更早的 3 輪併成一列（每輪 10／5）。
    expect(view.earlier?.turns).toBe(3);
    expect(view.earlier).toMatchObject({ uncachedInputTokens: 30, cacheReadTokens: 15 });
    expect(view.session).toMatchObject({
      uncachedInputTokens: 10 * turns,
      cacheReadTokens: 5 * turns,
    });
  });
});

describe('快取分桶：依模型的列、失敗、生摘要（#724）', () => {
  const withCache = (inputTokens: number, cacheReadTokens?: number, extra: object = {}) => ({
    inputTokens,
    outputTokens: 1,
    totalTokens: inputTokens + 1 + (cacheReadTokens ?? 0),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...extra,
  });
  const oneCall = (time: number, data: unknown, end: unknown = {}): Draft[] => [
    [time, 'model/start', {}],
    [time + 1, 'model/usage', data],
    [time + 2, 'model/end', end],
  ];

  it('依模型的列：inputTokens 只算未快取，快取讀寫另放；某個模型有一次沒報就只有它缺席', () => {
    const view = fold(
      log(
        [0, 'request/header', header('m-a')],
        ...oneCall(1, { ...withCache(10, 90), cacheWriteTokens: 0 }),
        ...oneCall(10, { ...withCache(5, 40), cacheWriteTokens: 2 }),
        [20, 'request/header', header('m-b')],
        ...oneCall(21, withCache(7, 3)),
        ...oneCall(30, usage(50, 1)), // m-b 這一次沒報快取
      ),
    );
    const rows = new Map(view.outside.models.map((row) => [row.model, row]));
    expect(rows.get('m-a')).toEqual({
      model: 'm-a',
      steps: 2,
      inputTokens: 15,
      outputTokens: 2,
      cacheReadTokens: 130,
      cacheWriteTokens: 2,
    });
    // m-b：讀只有一次報，寫都沒報 → 兩格都缺席；未快取桶不受影響（沒報細節的那次整個 prompt 就是未快取）。
    expect(rows.get('m-b')).toEqual({ model: 'm-b', steps: 2, inputTokens: 57, outputTokens: 2 });
  });

  it('名額滿了併進 modelsOther：同樣的規則，全部併進來的都報了才有快取格', () => {
    const drafts: Draft[] = [];
    const count = TOKEN_METER_MODELS_CAP + 2;
    for (let i = 0; i < count; i += 1) {
      drafts.push([i * 10, 'request/header', header(`m-${String(i)}`)]);
      drafts.push(...oneCall(i * 10 + 1, { ...withCache(10, 5), cacheWriteTokens: 1 }));
    }
    const view = fold(log(...drafts));
    expect(view.outside.models).toHaveLength(TOKEN_METER_MODELS_CAP);
    expect(view.outside.modelsOther).toEqual({
      steps: 2,
      inputTokens: 20,
      outputTokens: 2,
      cacheReadTokens: 10,
      cacheWriteTokens: 2,
    });
    const mixed = fold(
      log(...drafts, [900, 'request/header', header('m-extra')], ...oneCall(901, usage(9, 1))),
    );
    expect(mixed.outside.modelsOther).toMatchObject({ steps: 3, inputTokens: 29 });
    expect(mixed.outside.modelsOther).not.toHaveProperty('cacheReadTokens');
  });

  it('失敗那份與生摘要那一次也只算未快取桶', () => {
    const view = fold(
      log(
        [0, 'turn/start', { kind: 'message' }],
        ...oneCall(1, { ...withCache(10, 90), outcome: 'error' }, { outcome: 'error' }),
        [
          10,
          'compaction/summary',
          { usage: { inputTokens: 300, outputTokens: 40, cacheReadTokens: 700 } },
        ],
        [20, 'turn/end', {}],
      ),
    );
    expect(view.turns[0]).toMatchObject({
      inputTokens: 10,
      failedInputTokens: 10,
      summaryInputTokens: 300,
      cacheReadTokens: 90,
    });
  });

  describe('失敗那份與生摘要那份各自帶快取兩桶（缺席＝沒記，不是 0）', () => {
    const failed = { outcome: 'error' } as const;

    it('失敗的呼叫全都報了：失敗那份帶讀寫，且已含在總快取桶裡；成功的呼叫不進失敗桶', () => {
      const view = fold(
        log(
          [0, 'turn/start', { kind: 'message' }],
          ...oneCall(1, { ...withCache(10, 90), cacheWriteTokens: 4 }), // 成功
          ...oneCall(10, { ...withCache(5, 20, failed), cacheWriteTokens: 1 }, failed),
          ...oneCall(20, { ...withCache(6, 30, failed), cacheWriteTokens: 2 }, failed),
          [30, 'turn/end', {}],
        ),
      );
      expect(view.turns[0]).toMatchObject({
        cacheReadTokens: 140, // 90+20+30
        cacheWriteTokens: 7, // 4+1+2
        failedInputTokens: 11,
        failedCacheReadTokens: 50, // 20+30
        failedCacheWriteTokens: 3, // 1+2
      });
    });

    it('失敗的呼叫有一次沒報某一格：那一格整格缺席，另一格不受影響；沒有失敗的呼叫兩格都缺席', () => {
      const mixed = fold(
        log(
          [0, 'turn/start', { kind: 'message' }],
          ...oneCall(1, { ...withCache(5, 20, failed), cacheWriteTokens: 1 }, failed),
          ...oneCall(10, withCache(6, 30, failed), failed), // 讀有報、寫沒報
          [20, 'turn/end', {}],
        ),
      );
      expect(mixed.turns[0]).toMatchObject({ failedCacheReadTokens: 50 });
      expect(mixed.turns[0]).not.toHaveProperty('failedCacheWriteTokens');
      const none = fold(
        log(
          [0, 'turn/start', { kind: 'message' }],
          ...oneCall(1, { ...withCache(5, 20), cacheWriteTokens: 1 }),
          [20, 'turn/end', {}],
        ),
      );
      expect(none.turns[0]).not.toHaveProperty('failedCacheReadTokens');
      expect(none.turns[0]).not.toHaveProperty('failedCacheWriteTokens');
    });

    it('生摘要：報了用量的帶讀寫、另列不進總快取桶；有一次沒報某格就缺席；沒報用量的摘要不拖累別次', () => {
      const summary = (u?: object) =>
        [10, 'compaction/summary', u === undefined ? {} : { usage: u }] as const;
      const all = fold(
        log(
          [0, 'turn/start', { kind: 'message' }],
          [
            5,
            'compaction/summary',
            {
              usage: {
                inputTokens: 300,
                outputTokens: 40,
                cacheReadTokens: 700,
                cacheWriteTokens: 9,
              },
            },
          ],
          summary(), // 沒報用量
          [20, 'turn/end', {}],
        ),
      );
      expect(all.turns[0]).toMatchObject({
        summaries: 2,
        summariesUnknown: 1,
        summaryInputTokens: 300,
        summaryCacheReadTokens: 700,
        summaryCacheWriteTokens: 9,
      });
      expect(all.turns[0]).not.toHaveProperty('cacheReadTokens');
      const partial = fold(
        log(
          [0, 'turn/start', { kind: 'message' }],
          [
            5,
            'compaction/summary',
            {
              usage: {
                inputTokens: 300,
                outputTokens: 40,
                cacheReadTokens: 700,
                cacheWriteTokens: 9,
              },
            },
          ],
          summary({ inputTokens: 10, outputTokens: 1, cacheReadTokens: 5 }), // 寫沒報
          [20, 'turn/end', {}],
        ),
      );
      expect(partial.turns[0]).toMatchObject({ summaryCacheReadTokens: 705 });
      expect(partial.turns[0]).not.toHaveProperty('summaryCacheWriteTokens');
      const unknownOnly = fold(
        log([0, 'turn/start', { kind: 'message' }], summary(), [20, 'turn/end', {}]),
      );
      expect(unknownOnly.turns[0]).not.toHaveProperty('summaryCacheReadTokens');
    });

    it('跨輪、跨窗口合併：總計與較早的一格也遵守同一個規則', () => {
      const view = fold(
        log(
          [0, 'turn/start', { kind: 'message' }],
          ...oneCall(1, { ...withCache(5, 20, failed), cacheWriteTokens: 1 }, failed),
          [
            5,
            'compaction/summary',
            { usage: { inputTokens: 3, outputTokens: 1, cacheReadTokens: 7, cacheWriteTokens: 2 } },
          ],
          [20, 'turn/end', {}],
          [30, 'turn/start', { kind: 'message' }],
          ...oneCall(31, { ...withCache(6, 30, failed), cacheWriteTokens: 2 }, failed),
          [
            35,
            'compaction/summary',
            { usage: { inputTokens: 4, outputTokens: 1, cacheReadTokens: 8, cacheWriteTokens: 3 } },
          ],
          [50, 'turn/end', {}],
        ),
      );
      expect(view.session).toMatchObject({
        failedCacheReadTokens: 50,
        failedCacheWriteTokens: 3,
        summaryCacheReadTokens: 15,
        summaryCacheWriteTokens: 5,
      });
    });
  });
});

describe('投影通道', () => {
  it('單元宣告 children: true，插件註冊的就是它', () => {
    expect(tokenMeterUnit.children).toBe(true);
    expect(tokenMeterPlugin.name).toBe('token-meter');
  });

  it('即時一顆顆 push 與一次 fold 是同一個值；view 是純 JSON', () => {
    const events = mainLog();
    const folder = createProjectionFold([tokenMeterUnit]);
    const live = folder.session();
    for (const event of events) live.push(event);
    expect(live.current()).toEqual(folder.fold(events));
    const [value] = folder.fold(events);
    expect(JSON.parse(JSON.stringify(value?.view))).toEqual(value?.view);
  });
});
