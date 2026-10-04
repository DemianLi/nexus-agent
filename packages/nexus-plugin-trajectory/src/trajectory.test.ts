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
import type { SessionEvent } from '@nexus/core';
import {
  TRAJECTORY_DETAIL_TURNS,
  TRAJECTORY_DIGEST_CAP,
  TRAJECTORY_PREVIEW_CHARS,
} from '@nexus/wire';
import type { TrajectoryView } from '@nexus/wire';
import { trajectoryPlugin } from './index.js';
import {
  applyTrajectory,
  initialTrajectory,
  trajectoryUnit,
  viewTrajectory,
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

/** 整串事件折一遍。 */
function foldAll(events: readonly SessionEvent[]): TrajectoryView {
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
    const view = foldAll(log.events);
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
    const turn = foldAll(log.events).turns[0]!;
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
    expect(() => foldAll(log.events)).not.toThrow();
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
