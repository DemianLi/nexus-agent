/**
 * 軌跡投影的折疊（[#1027](https://github.com/DemianLi/nexus-agent/issues/1027)）。
 *
 * 日誌都是照真實事件順序手寫的。歸屬不能靠位置，所以有幾條是故意把會騙過位置的順序寫出來；
 * 差分測試把這裡的歸屬跟 `@nexus/core` 的 `indexModelCalls` 逐呼叫對一遍。
 */

import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import {
  createProjectionFold,
  createRegistry,
  indexModelCalls,
  REPEAT_REMINDER_MARKER,
  SessionLog,
  toLoggedMessage,
} from '@nexus/core';
import { ProjectionDetailError } from '@nexus/core';
import type { ApprovalOutcome, SessionEvent } from '@nexus/core';
import {
  TRAJECTORY_CALL_TOOLS_CAP,
  TRAJECTORY_DETAIL_TURNS,
  TRAJECTORY_DIGEST_CAP,
  TRAJECTORY_PREVIEW_CHARS,
  TRAJECTORY_TURN_CALLS_CAP,
  TRAJECTORY_TURN_LIST_CAP,
} from '@nexus/wire';
import type { TrajectoryApprovalOutcome, TrajectoryView } from '@nexus/wire';
import { trajectoryPlugin } from './index.js';
import {
  applyTrajectory,
  initialTrajectory,
  trajectoryTurnDetail,
  trajectoryUnit,
  viewTrajectory,
  viewTrajectoryFull,
} from './trajectory.js';

/** 寫一顆 core 不認得種類的事件（owner 套件才宣告的那些）。 */
function foreign(log: SessionLog, type: string, data: unknown = {}): void {
  (log as unknown as { append(type: string, data: unknown): unknown }).append(type, data);
}

const reply = (modelCall: number | undefined, text: string, ...toolCallIds: string[]) => ({
  message: toLoggedMessage(
    new AIMessage({
      content: text,
      tool_calls: toolCallIds.map((id) => ({ id, name: 'read_file', args: {} })),
    }),
  ),
  ...(modelCall === undefined ? {} : { modelCall }),
});

const call = (callId: string, name = 'read_file') => ({ callId, name, arguments: '{}' });
const ok = (callId: string) => ({ callId, isError: false });

/** 整串事件折一遍，窗口開到不裁：量折疊本身，每一輪都帶完整結構。 */
function foldAll(events: readonly SessionEvent[]): TrajectoryView {
  let state = initialTrajectory();
  for (const event of events) state = applyTrajectory(state, event, { detailTurns: 1000 });
  return viewTrajectoryFull(state);
}

/** 整串事件照推送的樣子折一遍：預設窗口、`run` 輪只出摘要。 */
function foldWindowed(events: readonly SessionEvent[]): TrajectoryView {
  let state = initialTrajectory();
  for (const event of events) state = applyTrajectory(state, event);
  return viewTrajectory(state);
}

/** 一輪最小的對話：一次呼叫、一個工具。 */
function simpleTurn(log: SessionLog, text: string): void {
  log.append('turn/start', { kind: 'message', text });
  const start = log.append('model/start', {});
  log.append('assistant/message', reply(start.seq, '好。', 'c1'));
  log.append('model/end', { modelCall: start.seq });
  log.append('tool/call', call('c1'));
  log.append('tool/result', ok('c1'));
  log.append('turn/end', {});
}

describe('失敗與中止的呼叫（#1022）', () => {
  it('model/end 帶 outcome 的呼叫在 view 上標出來，它報的用量照常在 usage；正常的呼叫沒有這一格', () => {
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'message', text: 'x' });
    const failed = log.append('model/start', {});
    log.append('model/usage', {
      inputTokens: 7,
      outputTokens: 0,
      totalTokens: 7,
      outcome: 'error',
      modelCall: failed.seq,
    });
    log.append('model/end', { outcome: 'error', modelCall: failed.seq });
    const ok2 = log.append('model/start', {});
    log.append('model/end', { modelCall: ok2.seq });
    const [first, second] = foldAll([...log.events]).turns[0]!.calls;
    expect(first).toMatchObject({ outcome: 'error', usage: { inputTokens: 7 } });
    expect(second).not.toHaveProperty('outcome');
  });
});

describe('一輪的結構', () => {
  it('呼叫、用量、重試、回覆、工具各歸到自己的那一次呼叫', () => {
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'message', text: '幫我看 README' });
    const first = log.append('model/start', {});
    log.append(
      'request/system',
      { system: '你是助手', reason: 'initial', modelCall: first.seq },
      { ignorable: true },
    );
    log.append(
      'request/header',
      { header: { config: { model: 'm-1' } }, reason: 'initial', modelCall: first.seq },
      { ignorable: true },
    );
    log.append('llm/retry', {
      retryId: 'r',
      retry: 1,
      maxRetries: 3,
      failure: { message: '忙', code: 'RATE_LIMIT', status: 429 },
      modelCall: first.seq,
    });
    log.append('llm/retry-started', {
      retryId: 'r',
      retry: 1,
      waitedMs: 800,
      modelCall: first.seq,
    });
    log.append('model/usage', {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      modelCall: first.seq,
    });
    log.append('assistant/message', reply(first.seq, '先讀檔', 'c1'));
    log.append('model/end', { modelCall: first.seq });
    log.append('context/measure', {
      approxTokens: 99,
      messageCount: 3,
      thresholds: [],
      modelCall: first.seq,
    });
    log.append('tool/call', call('c1'));
    log.append('tool/result', ok('c1'));
    const second = log.append('model/start', {});
    log.append('model/usage', {
      inputTokens: 20,
      outputTokens: 7,
      totalTokens: 27,
      modelCall: second.seq,
    });
    log.append('assistant/message', reply(second.seq, '完成'));
    log.append('model/end', { modelCall: second.seq });
    log.append('turn/end', {});

    const view = foldAll(log.events);
    expect(view.digests).toEqual([]);
    expect(view.turns).toHaveLength(1);
    const turn = view.turns[0]!;
    expect(turn).toMatchObject({
      index: 0,
      kind: 'message',
      logical: true,
      end: 'completed',
      preview: '幫我看 README',
      callCount: 2,
      toolCount: 1,
      toolErrors: 0,
      retryCount: 1,
      inputTokens: 30,
      outputTokens: 12,
      unattributed: 0,
    });
    const [a, b] = turn.calls;
    expect(a).toMatchObject({
      id: first.seq,
      model: 'm-1',
      system: 2,
      header: 3,
      measure: { approxTokens: 99, messageCount: 3 },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      retries: [{ retry: 1, code: 'RATE_LIMIT', status: 429, waitedMs: 800 }],
      reply: { textChars: 3, toolCalls: 1 },
      tools: [{ callId: 'c1', name: 'read_file', status: 'ok' }],
    });
    // 第二次呼叫沿用當時生效的快照（快照只在變的時候記），而不是空的。
    expect(b).toMatchObject({ id: second.seq, model: 'm-1', system: 2, header: 3, tools: [] });
    expect(b?.retries).toEqual([]);
  });

  it('工具失敗帶分類碼；沒配對的結果不憑空生出一個工具', () => {
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'message', text: 'x' });
    const start = log.append('model/start', {});
    log.append('assistant/message', reply(start.seq, '', 'c1'));
    log.append('tool/call', call('c1', 'nope'));
    log.append('tool/result', {
      callId: 'c1',
      isError: true,
      error: { name: 'nope', code: 'UNKNOWN_TOOL' },
    });
    log.append('tool/result', ok('ghost'));
    const view = foldAll(log.events);
    const turn = view.turns[0]!;
    expect(turn.calls[0]?.tools).toEqual([
      expect.objectContaining({ callId: 'c1', status: 'error', code: 'UNKNOWN_TOOL' }),
    ]);
    expect(turn.toolErrors).toBe(1);
    expect(turn.toolCount).toBe(1);
    expect(turn.end).toBeUndefined();
  });

  it('resume 開新的一個 turn 但不是新的邏輯輪；重進的工具回到原本那次呼叫上', () => {
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'message', text: '做事' });
    const start = log.append('model/start', {});
    log.append('assistant/message', reply(start.seq, '', 'c1'));
    log.append('tool/call', call('c1'));
    log.append('interrupt/raised', { interruptId: 'i' });
    log.append('turn/end', {});
    log.append('turn/start', { kind: 'resume' });
    log.append('tool/call', call('c1'));
    log.append('tool/result', ok('c1'));
    log.append('turn/end', {});
    const view = foldAll(log.events);
    expect(view.turns.map((t) => [t.kind, t.logical])).toEqual([
      ['message', true],
      ['resume', false],
    ]);
    // 同一個 callId 只算一個工具，而且是在發出它的那次呼叫上。
    expect(view.turns[0]?.calls[0]?.tools).toEqual([
      expect.objectContaining({ callId: 'c1', status: 'ok' }),
    ]);
    expect(view.turns[1]?.calls).toEqual([]);
    expect(view.turns[0]?.decisions).toEqual([expect.objectContaining({ kind: 'interrupt' })]);
  });

  it('失敗與停止的收尾', () => {
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'message', text: 'a' });
    log.append('turn/failed', { message: '炸了\n\n   而且很長'.padEnd(500, '!') });
    log.append('turn/start', { kind: 'message', text: 'b' });
    log.append('turn/end', { reason: { kind: 'aborted', cause: { kind: 'user' } } });
    log.append('turn/start', { kind: 'message', text: 'c' });
    log.append('turn/end', { reason: { kind: 'max-tokens' } });
    const view = foldAll(log.events);
    expect(view.turns.map((t) => t.end)).toEqual(['failed', 'aborted', 'max-tokens']);
    expect(view.turns[0]?.failure).toHaveLength(TRAJECTORY_PREVIEW_CHARS);
    expect(view.turns[0]?.failure).not.toMatch(/\n/);
  });
});

describe('失敗的分類碼（#434／#1115）', () => {
  it('turn/failed 帶 error.code：失敗的那一輪有 failureCode；沒帶（舊日誌）就沒有，不補 UNKNOWN', () => {
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'message', text: 'a' });
    log.append('turn/failed', {
      message: '額度用完',
      error: { message: '額度用完', code: 'QUOTA' },
    });
    log.append('turn/start', { kind: 'message', text: 'b' });
    log.append('turn/failed', { message: '舊日誌的失敗' });
    log.append('turn/start', { kind: 'message', text: 'c' });
    log.append('turn/failed', { message: 'x', error: { message: 'x', code: '' } });
    log.append('turn/start', { kind: 'message', text: 'd' });
    log.append('turn/end', { reason: { kind: 'max-tokens' } });
    const view = foldAll(log.events);
    expect(view.turns.map((t) => t.failureCode)).toEqual([
      'QUOTA',
      undefined,
      undefined,
      undefined,
    ]);
    expect(view.turns[1]).not.toHaveProperty('failureCode');
    expect(view.turns[2]).not.toHaveProperty('failureCode');
    // 失敗的訊息預覽照舊。
    expect(view.turns[0]?.failure).toBe('額度用完');
  });

  it('退成摘要之後碼還在：窗口外的失敗輪在骨架上也看得出是哪一類', () => {
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'message', text: 'a' });
    log.append('turn/failed', { message: '慢', error: { message: '慢', code: 'TIMEOUT' } });
    for (let i = 0; i < TRAJECTORY_DETAIL_TURNS; i += 1) simpleTurn(log, `後來 ${i}`);
    const view = foldWindowed(log.events);
    expect(view.digests[0]).toMatchObject({ index: 0, end: 'failed', failureCode: 'TIMEOUT' });
    expect(view.digests[0]).not.toHaveProperty('calls');
    // 沒失敗的輪不帶這一格。
    expect(view.turns[0]).not.toHaveProperty('failureCode');
  });
});

describe('歸屬不看位置', () => {
  it('沒有 modelCall 的重試（標題請求）不算主呼叫的；計進 unattributed', () => {
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'message', text: 'x' });
    const start = log.append('model/start', {});
    log.append('llm/retry', {
      retryId: 'title',
      retry: 1,
      maxRetries: 3,
      failure: { message: 'x', code: 'SERVER' },
    });
    log.append('assistant/message', reply(start.seq, 'ok'));
    log.append('model/end', { modelCall: start.seq });
    const turn = foldAll(log.events).turns[0]!;
    expect(turn.calls[0]?.retries).toEqual([]);
    expect(turn.retryCount).toBe(0);
    expect(turn.unattributed).toBe(1);
  });

  it('供應商每則回覆都從 call_0 起算：工具歸最近一則帶這個 id 的回覆', () => {
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'message', text: 'x' });
    const a = log.append('model/start', {});
    log.append('assistant/message', reply(a.seq, '', 'call_0'));
    log.append('tool/call', call('call_0'));
    log.append('tool/result', ok('call_0'));
    const b = log.append('model/start', {});
    log.append('assistant/message', reply(b.seq, '', 'call_0'));
    log.append('tool/call', call('call_0'));
    log.append('tool/result', ok('call_0'));
    const turn = foldAll(log.events).turns[0]!;
    expect(turn.calls.map((c) => c.tools.length)).toEqual([1, 1]);
    expect(turn.looseTools).toEqual([]);
  });

  it('最近一則帶這個 id 的回覆沒有 modelCall：進 looseTools，不落回更早的同 id', () => {
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'message', text: 'x' });
    const a = log.append('model/start', {});
    log.append('assistant/message', reply(a.seq, '', 'call_0'));
    log.append('model/start', {});
    log.append('assistant/message', reply(undefined, '', 'call_0'));
    log.append('tool/call', call('call_0'));
    log.append('tool/result', ok('call_0'));
    const turn = foldAll(log.events).turns[0]!;
    expect(turn.calls[0]?.tools).toEqual([]);
    expect(turn.looseTools).toEqual([expect.objectContaining({ callId: 'call_0', status: 'ok' })]);
    expect(turn.toolCount).toBe(1);
  });

  it('輪中的佇列變動進 inputs，不算進夾著它的那次呼叫', () => {
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'message', text: 'x' });
    const start = log.append('model/start', {});
    log.append('inbox/spliced', {
      target: 'next-step',
      start: 0,
      inserted: [{ id: 'q1', text: '插話', source: { kind: 'user' } } as never],
    });
    log.append('assistant/message', reply(start.seq, 'ok'));
    log.append('model/end', { modelCall: start.seq });
    const turn = foldAll(log.events).turns[0]!;
    expect(turn.inputs).toEqual([
      expect.objectContaining({ source: 'inbox', inserted: 1, removed: 0 }),
    ]);
    expect(turn.calls[0]).toMatchObject({ reply: expect.anything() });
    expect(turn.unattributed).toBe(0);
  });

  it('前景子代理日誌開頭那句話（出生就記，#1159）落在第一輪之前，不被畫成輪中輸入', () => {
    const log = new SessionLog('child');
    log.append('user/message', {
      message: toLoggedMessage(new HumanMessage('幹活')),
      source: { kind: 'user' },
    });
    const start = log.append('model/start', {});
    log.append('assistant/message', reply(start.seq, 'ok'));
    log.append('model/end', { modelCall: start.seq });
    const view = foldAll(log.events);
    expect(view.turns).toHaveLength(1);
    expect(view.turns[0]?.inputs).toEqual([]);
    expect(view.turns[0]?.unattributed).toBe(0);
  });

  it('輪外的佇列變動不歸任何一輪', () => {
    const log = new SessionLog('t');
    log.append('inbox/spliced', { target: 'next-turn', start: 0, inserted: [] });
    simpleTurn(log, 'a');
    log.append('inbox/spliced', { target: 'next-turn', start: 0, inserted: [] });
    expect(foldAll(log.events).turns[0]?.inputs).toEqual([]);
  });
});

describe('決策點與子代理連結', () => {
  it('重複提醒、插件訊息、goal、plan、todo、壓縮', () => {
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'message', text: 'x' });
    log.append('user/message', {
      message: toLoggedMessage(
        new HumanMessage({
          content: '你在重複',
          additional_kwargs: { [REPEAT_REMINDER_MARKER]: { tool: 'read_file', count: 3 } },
        }),
      ),
      source: { kind: 'plugin', plugin: 'repeat-reminder' },
    });
    log.append('user/message', {
      message: toLoggedMessage(new HumanMessage('別的插件')),
      source: { kind: 'plugin', plugin: 'other' },
    });
    foreign(log, 'goal/change', {
      operation: 'create',
      goal: { phase: 'active', objective: '機密目標' },
    });
    foreign(log, 'plan/mode', { active: true });
    foreign(log, 'todo/write', { todos: [{ content: 'a', status: 'pending' }] });
    log.append('compaction/summary', { cutoffIndex: 4, messagesBefore: 9, filePath: null });
    const decisions = foldAll(log.events).turns[0]!.decisions;
    expect(decisions.map((d) => d.kind)).toEqual([
      'reminder',
      'plugin-message',
      'goal',
      'plan',
      'todo',
      'compaction',
    ]);
    expect(decisions[0]).toMatchObject({ tool: 'read_file', count: 3 });
    expect(decisions[2]).toMatchObject({ operation: 'create', phase: 'active' });
    // 只帶結構化欄位，不帶寫給模型的原文或目標原文。
    expect(JSON.stringify(decisions)).not.toMatch(/你在重複|機密目標/);
  });

  it('subagent/catalog 把連結掛在配對的工具上', () => {
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'message', text: 'x' });
    const start = log.append('model/start', {});
    log.append('assistant/message', reply(start.seq, '', 'c1'));
    log.append('tool/call', call('c1', 'task'));
    const catalog = log.append('subagent/catalog', {
      childId: 'root/run1',
      callId: 'c1',
      mode: 'one-shot',
    });
    log.append('tool/result', ok('c1'));
    const tool = foldAll(log.events).turns[0]!.calls[0]!.tools[0]!;
    expect(tool.subagent).toEqual({
      childId: 'root/run1',
      // `runId` 是 `childId` 最後一段，web 拿它去 `subagentProjections[runId]` 找這個子代理自己的軌跡（#1070）。
      runId: 'run1',
      mode: 'one-shot',
      catalogSeq: catalog.seq,
    });
    expect(tool.status).toBe('ok');
  });
});

describe('窗口與上限', () => {
  it('超過窗口的輪退成摘要，計數保留；再多的只記數量', () => {
    const log = new SessionLog('t');
    const total = TRAJECTORY_DETAIL_TURNS + 3;
    for (let i = 0; i < total; i += 1) simpleTurn(log, `第 ${i} 句`);
    const view = foldWindowed(log.events);
    expect(view.turns).toHaveLength(TRAJECTORY_DETAIL_TURNS);
    expect(view.digests).toHaveLength(3);
    expect(view.digests.map((d) => d.index)).toEqual([0, 1, 2]);
    expect(view.turns[0]?.index).toBe(3);
    expect(view.digests[0]).toMatchObject({ callCount: 1, toolCount: 1, end: 'completed' });
    // 摘要不帶逐呼叫結構。
    expect(view.digests[0]).not.toHaveProperty('calls');
  });

  it('摘要列有上限，更早的記進 omitted', () => {
    let state = initialTrajectory();
    const log = new SessionLog('t');
    const total = TRAJECTORY_DETAIL_TURNS + TRAJECTORY_DIGEST_CAP + 5;
    for (let i = 0; i < total; i += 1) log.append('turn/start', { kind: 'message', text: 'x' });
    for (const event of log.events) state = applyTrajectory(state, event);
    const view = viewTrajectory(state);
    expect(view.digests).toHaveLength(TRAJECTORY_DIGEST_CAP);
    expect(view.omitted).toBe(5);
    expect(view.digests[0]?.index).toBe(5);
  });

  it('預覽有字數上限，且換行壓成空格', () => {
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'message', text: `一\n\n二${'三'.repeat(500)}` });
    const turn = foldWindowed(log.events).turns[0]!;
    expect(turn.preview).toHaveLength(TRAJECTORY_PREVIEW_CHARS);
    expect(turn.preview?.startsWith('一 二')).toBe(true);
    expect(turn.chars).toBe(503 + 1);
  });

  it('窗口外的呼叫遲到的事件靜靜丟掉，不拋', () => {
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'message', text: 'x' });
    const start = log.append('model/start', {});
    for (let i = 0; i < TRAJECTORY_DETAIL_TURNS + 1; i += 1)
      log.append('turn/start', { kind: 'message', text: 'y' });
    log.append('model/usage', {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      modelCall: start.seq,
    });
    expect(() => foldWindowed(log.events)).not.toThrow();
  });
});

describe('快取分桶（#724）', () => {
  const usageOf = (
    log: SessionLog,
    modelCall: number,
    inputTokens: number,
    extra: { cacheReadTokens?: number; cacheWriteTokens?: number } = {},
  ) =>
    log.append('model/usage', {
      inputTokens,
      outputTokens: 1,
      totalTokens: inputTokens + 1,
      modelCall,
      ...extra,
    });

  it('呼叫的 usage：inputTokens 仍是完整 prompt，另帶未快取、快取讀寫三格', () => {
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'message', text: 'x' });
    const start = log.append('model/start', {});
    usageOf(log, start.seq, 30, { cacheReadTokens: 64, cacheWriteTokens: 100 });
    const turn = foldAll(log.events).turns[0]!;
    expect(turn.calls[0]?.usage).toEqual({
      inputTokens: 194,
      outputTokens: 1,
      totalTokens: 31,
      uncachedInputTokens: 30,
      cacheReadTokens: 64,
      cacheWriteTokens: 100,
    });
    expect(turn).toMatchObject({
      inputTokens: 194,
      uncachedInputTokens: 30,
      cacheReadTokens: 64,
      cacheWriteTokens: 100,
    });
  });

  it('沒報快取細節（舊日誌、供應商沒給）：兩格缺席而不是 0，未快取桶就是整個 prompt', () => {
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'message', text: 'x' });
    const start = log.append('model/start', {});
    usageOf(log, start.seq, 500);
    const turn = foldAll(log.events).turns[0]!;
    expect(turn.calls[0]?.usage).not.toHaveProperty('cacheReadTokens');
    expect(turn.calls[0]?.usage).not.toHaveProperty('cacheWriteTokens');
    expect(turn.calls[0]?.usage?.uncachedInputTokens).toBe(500);
    expect(turn).not.toHaveProperty('cacheReadTokens');
    expect(turn.uncachedInputTokens).toBe(500);
  });

  it('一輪裡只要有一次報了用量的呼叫沒報快取，整輪那一格就缺席；沒有用量的呼叫不算', () => {
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'message', text: 'x' });
    const a = log.append('model/start', {});
    usageOf(log, a.seq, 10, { cacheReadTokens: 90 });
    const b = log.append('model/start', {});
    usageOf(log, b.seq, 40);
    log.append('model/start', {}); // 沒有 model/usage 的呼叫：不拖累別人
    const turn = foldAll(log.events).turns[0]!;
    expect(turn).not.toHaveProperty('cacheReadTokens');
    expect(turn.uncachedInputTokens).toBe(50);

    const clean = new SessionLog('t');
    clean.append('turn/start', { kind: 'message', text: 'x' });
    const c = clean.append('model/start', {});
    usageOf(clean, c.seq, 10, { cacheReadTokens: 90 });
    clean.append('model/start', {});
    expect(foldAll(clean.events).turns[0]?.cacheReadTokens).toBe(90);
  });

  it('呼叫超過上限被摺掉：桶照樣算進整輪，全報的規則跟著摺掉的呼叫走', () => {
    const total = TRAJECTORY_TURN_CALLS_CAP + 5;
    const build = (lastReports: boolean) => {
      const log = new SessionLog('t');
      log.append('turn/start', { kind: 'message', text: 'x' });
      for (let i = 0; i < total; i += 1) {
        const start = log.append('model/start', {});
        usageOf(log, start.seq, 2, i === total - 1 && !lastReports ? {} : { cacheReadTokens: 3 });
      }
      return foldAll(log.events).turns[0]!;
    };
    const allReported = build(true);
    expect(allReported.elided?.calls).toBe(5);
    expect(allReported).toMatchObject({
      uncachedInputTokens: 2 * total,
      cacheReadTokens: 3 * total,
      inputTokens: 5 * total,
    });
    // 最新那一次沒報：摺掉的 5 次報了，整輪仍然缺席。
    expect(build(false)).not.toHaveProperty('cacheReadTokens');
  });

  it('同一次呼叫的兩筆用量：先報後沒報也是缺席（不拿一部分當總數）', () => {
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'message', text: 'x' });
    const start = log.append('model/start', {});
    usageOf(log, start.seq, 10, { cacheReadTokens: 90 });
    usageOf(log, start.seq, 5);
    const usage = foldAll(log.events).turns[0]?.calls[0]?.usage;
    expect(usage).toMatchObject({ inputTokens: 105, uncachedInputTokens: 15 });
    expect(usage).not.toHaveProperty('cacheReadTokens');

    // 反過來（先沒報、後報）同樣缺席。
    const reversed = new SessionLog('t');
    reversed.append('turn/start', { kind: 'message', text: 'x' });
    const second = reversed.append('model/start', {});
    usageOf(reversed, second.seq, 5);
    usageOf(reversed, second.seq, 10, { cacheReadTokens: 90 });
    expect(foldAll(reversed.events).turns[0]?.calls[0]?.usage).not.toHaveProperty(
      'cacheReadTokens',
    );
  });

  it('摘要（digest）帶同樣的三格', () => {
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'message', text: 'x' });
    const start = log.append('model/start', {});
    usageOf(log, start.seq, 30, { cacheReadTokens: 64, cacheWriteTokens: 100 });
    log.append('turn/end', {});
    for (let i = 0; i < TRAJECTORY_DETAIL_TURNS + 1; i += 1) simpleTurn(log, `y${i}`);
    const digest = foldWindowed(log.events).digests[0]!;
    expect(digest).toMatchObject({
      uncachedInputTokens: 30,
      cacheReadTokens: 64,
      cacheWriteTokens: 100,
    });
  });
});

describe('單輪上限：摺掉的東西不讓計數變小', () => {
  it('呼叫超過上限：留最新的，更早的折進 elided，用量與重試照樣算進總數', () => {
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'message', text: 'x' });
    const total = TRAJECTORY_TURN_CALLS_CAP + 10;
    const firstStart = log.append('model/start', {});
    log.append('model/usage', {
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
      modelCall: firstStart.seq,
    });
    log.append('llm/retry', {
      retryId: 'r',
      retry: 1,
      maxRetries: 2,
      failure: { message: 'x', code: 'SERVER' },
      modelCall: firstStart.seq,
    });
    for (let i = 1; i < total; i += 1) {
      const start = log.append('model/start', {});
      log.append('model/usage', {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        modelCall: start.seq,
      });
    }
    // 被摺掉的呼叫遲到的事件靜靜丟掉。
    log.append('model/usage', {
      inputTokens: 100,
      outputTokens: 100,
      totalTokens: 200,
      modelCall: firstStart.seq,
    });
    const turn = foldAll(log.events).turns[0]!;
    expect(turn.calls).toHaveLength(TRAJECTORY_TURN_CALLS_CAP);
    expect(turn.calls[0]?.id).not.toBe(firstStart.seq);
    expect(turn.elided).toEqual({ calls: 10, tools: 0, inputs: 0, decisions: 0 });
    expect(turn.callCount).toBe(total);
    expect(turn.inputTokens).toBe(7 + (total - 1));
    expect(turn.outputTokens).toBe(3 + (total - 1));
    expect(turn.retryCount).toBe(1);
    expect(turn.unattributed).toBe(1);
  });

  it('一次呼叫的工具超過上限：留最新的，總數與摺掉當下已失敗的數目照算', () => {
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'message', text: 'x' });
    const start = log.append('model/start', {});
    const total = TRAJECTORY_CALL_TOOLS_CAP + 6;
    const ids = Array.from({ length: total }, (_, i) => `t${i}`);
    log.append('assistant/message', reply(start.seq, '', ...ids));
    ids.forEach((id, i) => {
      log.append('tool/call', call(id));
      log.append('tool/result', i < 2 ? { callId: id, isError: true } : ok(id));
    });
    const turn = foldAll(log.events).turns[0]!;
    expect(turn.calls[0]?.tools).toHaveLength(TRAJECTORY_CALL_TOOLS_CAP);
    expect(turn.calls[0]?.tools.at(-1)?.callId).toBe(`t${total - 1}`);
    expect(turn.elided).toMatchObject({ tools: 6 });
    expect(turn.toolCount).toBe(total);
    expect(turn.toolErrors).toBe(2);
  });

  it('inputs、decisions、looseTools 各有上限，摺掉的記進 elided', () => {
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'message', text: 'x' });
    const extra = 5;
    for (let i = 0; i < TRAJECTORY_TURN_LIST_CAP + extra; i += 1) {
      log.append('inbox/spliced', { target: 'next-step', start: 0, inserted: [] });
      foreign(log, 'plan/mode', { active: i % 2 === 0 });
      log.append('tool/call', call(`loose${i}`));
    }
    const turn = foldAll(log.events).turns[0]!;
    expect(turn.inputs).toHaveLength(TRAJECTORY_TURN_LIST_CAP);
    expect(turn.decisions).toHaveLength(TRAJECTORY_TURN_LIST_CAP);
    expect(turn.looseTools).toHaveLength(TRAJECTORY_TURN_LIST_CAP);
    expect(turn.elided).toEqual({ calls: 0, tools: extra, inputs: extra, decisions: extra });
    expect(turn.toolCount).toBe(TRAJECTORY_TURN_LIST_CAP + extra);
  });

  it('沒超過上限就沒有 elided 這一格', () => {
    const log = new SessionLog('t');
    simpleTurn(log, 'a');
    expect(foldAll(log.events).turns[0]).not.toHaveProperty('elided');
  });

  it('整數形的工具 id 也是先進先出：表滿了丟的是最早記下的，不是數字最小的', () => {
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'message', text: 'x' });
    const start = log.append('model/start', {});
    // 由大到小記：最早記下的是 "2099"。物件鍵若不加前綴，整數形的鍵會按數字升冪排，被丟的會變成 "0"。
    const ids = Array.from({ length: 2100 }, (_, i) => String(2099 - i));
    log.append('assistant/message', reply(start.seq, '', ...ids));
    log.append('tool/call', call('0'));
    log.append('tool/call', call('2099'));
    const turn = foldAll(log.events).turns[0]!;
    expect(turn.calls[0]?.tools.map((t) => t.callId)).toEqual(['0']);
    expect(turn.looseTools.map((t) => t.callId)).toEqual(['2099']);
  });
});

describe('純度與通道的契約', () => {
  it('不相干的事件回同一個參照', () => {
    const log = new SessionLog('t');
    simpleTurn(log, 'a');
    let state = initialTrajectory();
    for (const event of log.events) state = applyTrajectory(state, event);
    const extra = new SessionLog('u');
    foreign(extra, 'session/title', { title: 'x' });
    foreign(extra, 'something/else');
    for (const event of extra.events) expect(applyTrajectory(state, event)).toBe(state);
  });

  it('輪外的模型事件與工具事件不改狀態', () => {
    const log = new SessionLog('t');
    simpleTurn(log, 'a');
    let state = initialTrajectory();
    for (const event of log.events) state = applyTrajectory(state, event);
    const after = new SessionLog('t2');
    const start = after.append('model/start', {});
    after.append('model/usage', {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      modelCall: start.seq,
    });
    after.append('tool/call', call('zzz'));
    for (const event of after.events) expect(applyTrajectory(state, event)).toBe(state);
  });

  it('view 是純 JSON：經 JSON 來回一次不變（沒有 undefined 的 key）', () => {
    const log = new SessionLog('t');
    simpleTurn(log, 'a');
    foreign(log, 'goal/change', { operation: 'create' });
    const view = foldAll(log.events);
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
    expect(JSON.stringify(view)).not.toContain('undefined');
  });

  it('即時一顆顆 push 與整串 fold 得到同一份值', () => {
    const log = new SessionLog('t');
    for (let i = 0; i < 5; i += 1) simpleTurn(log, `輪 ${i}`);
    const fold = createProjectionFold([trajectoryUnit]);
    const live = fold.session();
    for (const event of log.events) live.push(event);
    expect(live.current()).toEqual(fold.fold(log.events));
  });

  it('插件把兩個單元註冊進通道', () => {
    const registry = createRegistry();
    const leave = registry.enter({ id: 'trajectory#0', name: 'trajectory' });
    trajectoryPlugin.apply(registry, undefined as never);
    leave();
    expect(registry.projections.list().map((unit) => unit.key)).toEqual([
      'trajectory',
      'request-snapshots',
    ]);
  });
});

describe('差分：歸屬跟 core 的 indexModelCalls 一致', () => {
  /** 可重現的亂數。 */
  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }

  /** 產一串會騙過位置的日誌：id 重用、少數回覆沒 modelCall、夾外來重試。一輪都在窗口內。 */
  function randomLog(seed: number): SessionLog {
    const random = rng(seed);
    const pick = (n: number) => Math.floor(random() * n);
    const log = new SessionLog(`d${seed}`);
    log.append('turn/start', { kind: 'message', text: 'x' });
    const pending: string[] = [];
    for (let step = 0; step < 12; step += 1) {
      const start = log.append('model/start', {});
      if (random() < 0.3) {
        log.append('llm/retry', {
          retryId: `r${step}`,
          retry: 1,
          maxRetries: 2,
          failure: { message: 'x', code: 'SERVER' },
          ...(random() < 0.5 ? { modelCall: start.seq } : {}),
        });
      }
      log.append('model/usage', {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        modelCall: start.seq,
      });
      // id 從 call_0 起算（會重用），回覆有時沒有 modelCall。
      const ids = Array.from({ length: pick(3) }, (_, i) => `call_${i}`);
      log.append('assistant/message', reply(random() < 0.8 ? start.seq : undefined, '', ...ids));
      log.append('model/end', { modelCall: start.seq });
      pending.push(...ids);
      while (pending.length > 0) {
        const id = pending.shift()!;
        log.append('tool/call', call(id));
        log.append('tool/result', random() < 0.2 ? { callId: id, isError: true } : ok(id));
      }
    }
    log.append('turn/end', {});
    return log;
  }

  it.each(Array.from({ length: 25 }, (_, i) => i + 1))(
    '種子 %i：每次呼叫的工具、用量、重試、回覆都一致',
    (seed) => {
      const log = randomLog(seed);
      const view = foldAll(log.events);
      const turn = view.turns[0]!;
      const index = indexModelCalls(log.events);

      expect(turn.calls.map((c) => c.id)).toEqual(index.calls.map((r) => r.modelCall));
      index.calls.forEach((record, at) => {
        const mine = turn.calls[at]!;
        expect(mine.tools.map((t) => t.callId).sort()).toEqual(
          [...new Set(record.toolCalls.map((e) => e.data.callId))].sort(),
        );
        expect(mine.usage?.inputTokens ?? 0).toBe(record.usage.length);
        expect(mine.retries).toHaveLength(record.retries.length);
        expect(mine.reply !== undefined).toBe(record.replies.length > 0);
      });
      const looseIds = (events: readonly string[]) => [...new Set(events)].sort();
      expect(looseIds(turn.looseTools.map((t) => t.callId))).toEqual(
        looseIds(
          index.unattributed.flatMap((e) =>
            e.type === 'tool/call' ? [(e as SessionEvent<'tool/call'>).data.callId] : [],
          ),
        ),
      );
    },
  );
});

describe('沒有 turn/start 的日誌：前景子代理（#1070）', () => {
  /** 前景子代理日誌的真實形狀：從第一次模型呼叫開始，沒有 `turn/start`、也沒有 `turn/end`。 */
  function foregroundChild(): SessionLog {
    const log = new SessionLog('child');
    const first = log.append('model/start', {});
    log.append('assistant/message', reply(first.seq, '', 'c1'));
    log.append('model/end', { modelCall: first.seq });
    log.append('tool/call', call('c1'));
    log.append('tool/result', ok('c1'));
    const second = log.append('model/start', {});
    log.append('model/usage', {
      inputTokens: 5,
      outputTokens: 2,
      totalTokens: 7,
      modelCall: second.seq,
    });
    log.append('assistant/message', reply(second.seq, '做完'));
    log.append('model/end', { modelCall: second.seq });
    return log;
  }

  it('第一次模型呼叫開一輪 run：呼叫、工具、用量都在，沒有 end', () => {
    const view = foldAll(foregroundChild().events);
    expect(view.turns).toHaveLength(1);
    const turn = view.turns[0]!;
    expect(turn).toMatchObject({
      index: 0,
      kind: 'run',
      logical: true,
      callCount: 2,
      toolCount: 1,
      inputTokens: 5,
      outputTokens: 2,
      unattributed: 0,
    });
    expect(turn).not.toHaveProperty('end');
    expect(turn.calls.map((each) => each.tools.map((tool) => tool.callId))).toEqual([['c1'], []]);
    expect(turn.calls[1]?.reply).toMatchObject({ textChars: 2 });
  });

  it('沒有輪的日誌後來才出現 turn/start：run 那一輪照舊留著，新的一輪接在後面', () => {
    const log = foregroundChild();
    simpleTurn(log, '後來');
    const view = foldAll(log.events);
    expect(view.turns.map((turn) => [turn.index, turn.kind])).toEqual([
      [0, 'run'],
      [1, 'message'],
    ]);
  });

  it('只在「一輪都還沒開過」時開：開過輪的日誌，輪外的模型呼叫照舊不改狀態（root 不受影響）', () => {
    const rooted = new SessionLog('root');
    simpleTurn(rooted, '先有一輪');
    let state = initialTrajectory();
    for (const event of rooted.events) state = applyTrajectory(state, event);
    const stray = rooted.append('model/start', {});
    expect(applyTrajectory(state, stray)).toBe(state);
    // 有 turn/start 在前的日誌，第一輪是 message，不是 run。
    expect(foldAll(rooted.events).turns.map((turn) => turn.kind)).toEqual(['message']);
  });

  it('兩個單元都宣告 children：子代理的日誌也各折一份', () => {
    const registry = createRegistry();
    const leave = registry.enter({ id: 'trajectory#0', name: 'trajectory' });
    trajectoryPlugin.apply(registry, undefined as never);
    leave();
    const units = registry.projections.list();
    expect(units.map((unit) => [unit.key, unit.children])).toEqual([
      ['trajectory', true],
      ['request-snapshots', true],
    ]);
  });
});

describe('推送的 view（#1083）', () => {
  it('只有最新一個實體輪帶逐呼叫結構，其餘都是摘要', () => {
    const log = new SessionLog('t');
    for (let i = 0; i < 4; i += 1) simpleTurn(log, `第 ${i} 句`);
    const view = foldWindowed(log.events);
    expect(TRAJECTORY_DETAIL_TURNS).toBe(1);
    expect(view.turns.map((turn) => turn.index)).toEqual([3]);
    expect(view.digests.map((digest) => digest.index)).toEqual([0, 1, 2]);
  });

  it('前景子代理的 run 輪（永不收尾）只出摘要，細節要用 detail 拉', () => {
    const child = new SessionLog('child');
    const start = child.append('model/start', {});
    child.append('assistant/message', reply(start.seq, '做完', 'c1'));
    child.append('tool/call', call('c1'));
    const view = foldWindowed(child.events);
    expect(view.turns).toEqual([]);
    expect(view.digests).toEqual([
      expect.objectContaining({ index: 0, kind: 'run', callCount: 1, toolCount: 1 }),
    ]);
    expect(view.digests[0]).not.toHaveProperty('calls');
    // 拉得到完整的。
    expect(trajectoryTurnDetail(child.events, {}).turns[0]).toMatchObject({
      kind: 'run',
      calls: [expect.objectContaining({ id: start.seq })],
    });
  });

  it('run 輪之後才出現 turn/start 的日誌：摘要在前、新的一輪接在後面', () => {
    const log = new SessionLog('child');
    log.append('model/start', {});
    simpleTurn(log, '後來');
    const view = foldWindowed(log.events);
    expect(view.digests.map((digest) => digest.kind)).toEqual(['run']);
    expect(view.turns.map((turn) => turn.kind)).toEqual(['message']);
  });
});

describe('核准的問題掛在它的中斷列上（#1029）', () => {
  const interruptRows = (view: TrajectoryView) =>
    view.turns
      .flatMap((turn) => turn.decisions)
      .filter((decision) => decision.kind === 'interrupt');

  /** 停在核准點的一輪，後面接（或不接）回答它的那一輪。 */
  function askedLog(): SessionLog {
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'message', text: '動手' });
    log.append('tool/call', call('c1', 'alpha'));
    log.append('interrupt/raised', { interruptId: 'i-1' });
    log.append('approval/asked', {
      id: 'i-1',
      toolName: 'alpha',
      callId: 'c1',
      reason: '要人看過',
    });
    log.append('turn/end', {});
    return log;
  }

  it('asked 之後還沒有 decided：approval 只有工具與呼叫，沒有 outcome（還在等，不是推一個結果）', () => {
    const [row] = interruptRows(foldAll(askedLog().events));
    expect(row).toMatchObject({
      kind: 'interrupt',
      id: 'i-1',
      approval: { tool: 'alpha', callId: 'c1' },
    });
    expect(row).not.toHaveProperty('approval.outcome');
    // 發問的人話不上線（只有結構化欄位，#1018 Q3）。
    expect(JSON.stringify(row)).not.toContain('要人看過');
  });

  it('decided 落在回答它的那一輪（resume），結局回填到前一輪的中斷列上，帶 decidedAt', () => {
    const log = askedLog();
    log.append('turn/start', { kind: 'resume' });
    const decided = log.append('approval/decided', { id: 'i-1', outcome: 'rejected' });
    log.append('tool/result', { callId: 'c1', isError: true });
    log.append('turn/end', {});
    const view = foldAll(log.events);
    expect(interruptRows(view)).toHaveLength(1);
    expect(interruptRows(view)[0]).toMatchObject({
      approval: { tool: 'alpha', outcome: 'rejected', decidedAt: decided.time },
    });
  });

  it('問答中斷（沒有 approval/asked）沒有 approval；不必問人的那一對（沒有中斷）不長中斷列', () => {
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'message', text: '問' });
    log.append('interrupt/raised', { interruptId: 'q-1' });
    log.append('turn/end', {});
    log.append('turn/start', { kind: 'message', text: '再來' });
    // 政策關掉：圖內一次寫一對，id 是新產的，沒有任何中斷認領它。
    log.append('approval/asked', { id: 'x-1', toolName: 'alpha', callId: 'c2' });
    log.append('approval/decided', { id: 'x-1', outcome: 'rejected' });
    log.append('turn/end', {});
    const rows = interruptRows(foldAll(log.events));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'interrupt', id: 'q-1' });
    expect(rows[0]).not.toHaveProperty('approval');
  });

  it('認不得的結局、缺欄位的事件不動狀態；對不上 id 的 decided 也不動', () => {
    const log = askedLog();
    log.append('turn/start', { kind: 'resume' });
    foreign(log, 'approval/decided', { id: 'i-1', outcome: 'maybe' });
    log.append('approval/decided', { id: 'someone-else', outcome: 'allowed-once' });
    log.append('turn/end', {});
    const [row] = interruptRows(foldAll(log.events));
    expect(row).not.toHaveProperty('approval.outcome');
  });

  it('wire 的結局詞彙與 core 的 ApprovalOutcome 是同一組（兩邊各寫一份，這裡釘住）', () => {
    const fromCore: readonly ApprovalOutcome[] = [
      'allowed-once',
      'rejected',
      'cancelled',
      'unavailable',
    ];
    const fromWire: readonly TrajectoryApprovalOutcome[] = fromCore;
    // 雙向可賦值：少一邊多一值，其中一行就編不過。
    const back: readonly ApprovalOutcome[] = fromWire;
    expect(back).toEqual(fromCore);
  });
});

describe('子代理計數（#1083）', () => {
  /** 一輪裡派 `n` 個子代理（每個一次呼叫的一個 task 工具）。 */
  function delegateTurn(log: SessionLog, n: number): void {
    log.append('turn/start', { kind: 'message', text: '分頭做' });
    const start = log.append('model/start', {});
    const ids = Array.from({ length: n }, (_, i) => `d${String(i)}`);
    log.append('assistant/message', reply(start.seq, '', ...ids));
    for (const id of ids) {
      log.append('tool/call', call(id, 'task'));
      log.append('subagent/catalog', { childId: `root/bg-${id}`, callId: id, mode: 'one-shot' });
      log.append('tool/result', ok(id));
    }
    log.append('turn/end', {});
  }

  it('摘要與完整輪都帶 subagentCount；工具超過單輪上限被摺掉的也算', () => {
    const log = new SessionLog('t');
    delegateTurn(log, TRAJECTORY_CALL_TOOLS_CAP + 4);
    simpleTurn(log, '下一輪');
    simpleTurn(log, '再下一輪');
    simpleTurn(log, '又一輪');
    const view = foldWindowed(log.events);
    // 第 0 輪已退成摘要：摺掉的 4 個工具在摺掉當下已經帶連結的，沒有連結的不算（連結在 tool/call 之後才掛）。
    expect(view.digests[0]?.toolCount).toBe(TRAJECTORY_CALL_TOOLS_CAP + 4);
    expect(view.digests[0]?.subagentCount).toBeGreaterThanOrEqual(TRAJECTORY_CALL_TOOLS_CAP);
    expect(view.turns.every((turn) => turn.subagentCount === 0)).toBe(true);
  });

  it('沒摺掉時精確：三個子代理就是 3', () => {
    const log = new SessionLog('t');
    delegateTurn(log, 3);
    expect(foldAll(log.events).turns[0]?.subagentCount).toBe(3);
  });
});

describe('按需拉一個邏輯輪（#1083）', () => {
  const idReply = (modelCall: number, id: string, text: string, ...toolCallIds: string[]) => ({
    message: toLoggedMessage(
      new AIMessage({
        id,
        content: text,
        tool_calls: toolCallIds.map((each) => ({ id: each, name: 'read_file', args: {} })),
      }),
    ),
    modelCall,
  });

  /** 六個邏輯輪；第 2 輪停在核准點、第 3 個實體輪是它的 resume；第 0 輪有個一直到後面才回結果的工具。 */
  function longLog(): { log: SessionLog; lateResult: number } {
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'message', text: '第 0 句' });
    const s0 = log.append('model/start', {});
    log.append('assistant/message', idReply(s0.seq, 'm-0', '好', 'bg'));
    log.append('tool/call', call('bg', 'task'));
    log.append('turn/end', {});
    simpleTurn(log, '第 1 句');
    log.append('turn/start', { kind: 'message', text: '第 2 句' });
    const s2 = log.append('model/start', {});
    log.append('assistant/message', idReply(s2.seq, 'm-2', '', 'c2'));
    log.append('tool/call', call('c2'));
    log.append('interrupt/raised', { interruptId: 'i-2' });
    log.append('turn/end', {});
    log.append('turn/start', { kind: 'resume' });
    log.append('tool/result', ok('c2'));
    log.append('turn/end', {});
    simpleTurn(log, '第 3 句');
    simpleTurn(log, '第 4 句');
    const late = log.append('tool/result', ok('bg'));
    simpleTurn(log, '第 5 句');
    return { log, lateResult: late.seq };
  }

  /** 對照組：窗口開到不裁，每一輪都有完整細節。 */
  function reference(events: readonly SessionEvent[]) {
    let state = initialTrajectory();
    for (const event of events) state = applyTrajectory(state, event, { detailTurns: 1000 });
    return viewTrajectory(state).turns;
  }

  it('每個邏輯輪拉回來的實體輪，與不裁窗口時同一輪逐欄相同（index、seq 都對得上骨架）', () => {
    const { log } = longLog();
    const ref = reference(log.events);
    const starts = ref.filter((turn) => turn.logical);
    expect(starts).toHaveLength(6);
    for (const [at, start] of starts.entries()) {
      const end = starts[at + 1]?.seq ?? Number.POSITIVE_INFINITY;
      const detail = trajectoryTurnDetail(log.events, { seq: start.seq });
      expect(detail.turns).toEqual(ref.filter((turn) => turn.seq >= start.seq && turn.seq < end));
      expect(detail.seq).toBe(log.events.at(-1)!.seq);
    }
  });

  it('錨點落在 resume 輪上，回整個邏輯輪（從 logical:true 那顆開始）', () => {
    const { log } = longLog();
    const resume = foldWindowed(log.events).digests.find((digest) => digest.kind === 'resume')!;
    const detail = trajectoryTurnDetail(log.events, { seq: resume.seq + 1 });
    expect(detail.turns.map((turn) => [turn.kind, turn.logical])).toEqual([
      ['message', true],
      ['resume', false],
    ]);
  });

  it('messageId 與 seq 解到同一個邏輯輪；錨點可以是呼叫的 id', () => {
    const { log } = longLog();
    const byMessage = trajectoryTurnDetail(log.events, { messageId: 'm-2' });
    expect(byMessage.turns[0]?.preview).toBe('第 2 句');
    const callId = byMessage.turns[0]!.calls[0]!.id;
    expect(trajectoryTurnDetail(log.events, { seq: String(callId) })).toEqual(byMessage);
  });

  it('遲到的事件記得回去：第 0 輪的背景工具後來才回結果，拉到的是 ok；推送的窗口裡它早已退成摘要', () => {
    const { log } = longLog();
    const detail = trajectoryTurnDetail(log.events, { messageId: 'm-0' });
    expect(detail.turns[0]?.calls[0]?.tools[0]).toMatchObject({ callId: 'bg', status: 'ok' });
    expect(detail.turns[0]?.unattributed).toBe(0);
  });

  it('沒給錨點是第一個邏輯輪', () => {
    const { log } = longLog();
    expect(trajectoryTurnDetail(log.events, {}).turns[0]?.preview).toBe('第 0 句');
  });

  it('沒有 turn/start 的日誌（前景子代理）整份就是一個邏輯輪', () => {
    const log = new SessionLog('child');
    const start = log.append('model/start', {});
    log.append('assistant/message', idReply(start.seq, 'm-c', '做完', 'c1'));
    log.append('tool/call', call('c1'));
    log.append('tool/result', ok('c1'));
    const detail = trajectoryTurnDetail(log.events, {});
    expect(detail.turns).toHaveLength(1);
    expect(detail.turns[0]).toMatchObject({ kind: 'run', logical: true, callCount: 1 });
    expect(trajectoryTurnDetail(log.events, { messageId: 'm-c' })).toEqual(detail);
  });

  it('錨點不合與找不到各有各的失敗，原因是中文', () => {
    const { log } = longLog();
    const fails = (
      query: Record<string, unknown>,
      events: readonly SessionEvent[] = log.events,
    ) => {
      try {
        trajectoryTurnDetail(events, query);
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(ProjectionDetailError);
        return error as ProjectionDetailError;
      }
      throw new Error('應該要拋');
    };
    expect(fails({ seq: 1, messageId: 'm-0' }).kind).toBe('invalid-argument');
    expect(fails({ seq: 'abc' }).kind).toBe('invalid-argument');
    expect(fails({ seq: -1 }).kind).toBe('invalid-argument');
    expect(fails({ messageId: '' }).kind).toBe('invalid-argument');
    expect(fails({ seq: 99_999 }).kind).toBe('not-found');
    expect(fails({ messageId: '不存在' }).kind).toBe('not-found');
    expect(fails({}, []).kind).toBe('not-found');
    expect(fails({ messageId: '不存在' }).message).toMatch(/[\u4e00-\u9fff]/u);
  });

  it('單元註冊的 detail 就是這個函式', () => {
    expect(trajectoryUnit.detail).toBe(trajectoryTurnDetail);
  });
});
