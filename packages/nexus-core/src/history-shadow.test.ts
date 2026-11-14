/**
 * 影子比對與 `log`（[#2355](https://github.com/DemianLi/nexus-agent/issues/2355)）的單元測試：投影、這次呼叫要推的那一段、分類、計數與兩顆 middleware。
 * 產品路徑上「沒有一次落在 other」的驗收在 `apps/harness` 的 `log-derived-history.test.ts` 與 `.agents.test.ts`；
 * 兩個分開數的類別在 `history-shadow-scenarios.test.ts`。
 */

import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';

import { TOOL_NOT_STARTED_TEXT } from './conversation-replay.js';
import {
  compareHistoryWithLog,
  compareProjections,
  createHistoryFromLogMiddleware,
  createHistoryShadowMiddleware,
  createHistoryShadowTally,
  createUnsummarizedHistoryReader,
  createVisibleHistoryReader,
  eventsForModelCall,
  wireProjection,
} from './history-shadow.js';
import type { HistoryShadowOutcome } from './history-shadow.js';
import { replayConversation } from './langchain-message-adapter.js';
import { toLoggedMessage } from './logged-message.js';
import { ModelHistoryCache } from './model-history.js';
import { patchDanglingToolCalls, patchedToolCallText } from './patch-tool-calls.js';
import type { SessionLookup } from './registry.js';
import { SessionLog } from './session-log.js';

const SENT = { applyPrunes: true, applyArgTruncations: true, applyImageOffloads: true } as const;
const cache = () => new ModelHistoryCache(SENT);
const reply = (text: string) => toLoggedMessage(new AIMessage(text));

function chat(log: SessionLog, said: string, answered: string): void {
  log.append('turn/start', { kind: 'message', text: said });
  log.append('model/start', {});
  log.append('assistant/message', { message: reply(answered) });
  log.append('model/end', {});
  log.append('turn/end', {});
}

/** 一輪問答之後，第二句的那次呼叫開著。 */
function secondCallOpen(): SessionLog {
  const log = new SessionLog('shadow');
  chat(log, '一', '甲');
  log.append('turn/start', { kind: 'message', text: '二' });
  log.append('model/start', {});
  return log;
}

/** LangGraph state 裡同一串的樣子：帶 LangChain 自己產的 `id`，助手訊息帶 `name`。 */
const stateOfSecondCall = (): BaseMessage[] => [
  new HumanMessage({ content: '一', id: 'h1' }),
  new AIMessage({ content: '甲', name: 'model', id: 'a1' }),
  new HumanMessage({ content: '二', id: 'h2' }),
];

describe('wireProjection：送上線的樣子', () => {
  it('不比 `id`、助手的 `name`、content 裡的工具呼叫與推理區塊', () => {
    const plain = new AIMessage({
      content: [{ type: 'text', text: '好' }],
      tool_calls: [{ id: 'c1', name: 'grep', args: { q: 'x' }, type: 'tool_call' }],
    });
    const decorated = new AIMessage({
      id: 'lc-1',
      name: 'model',
      content: [
        { type: 'reasoning', reasoning: '想一下' },
        { type: 'text', text: '好' },
        { type: 'tool_call', id: 'c1', name: 'grep', args: { q: '整段原文' } },
      ],
      tool_calls: [{ id: 'c1', name: 'grep', args: { q: 'x' }, type: 'tool_call' }],
    });
    expect(wireProjection(decorated)).toBe(wireProjection(plain));
  });

  it('上線的欄位改了就不同：內容、工具呼叫的參數、工具結果的 `name` 與 `tool_call_id`', () => {
    const base = wireProjection(
      new ToolMessage({ content: '結果', tool_call_id: 'c1', name: 'grep' }),
    );
    expect(
      wireProjection(new ToolMessage({ content: '結果!', tool_call_id: 'c1', name: 'grep' })),
    ).not.toBe(base);
    expect(
      wireProjection(new ToolMessage({ content: '結果', tool_call_id: 'c2', name: 'grep' })),
    ).not.toBe(base);
    expect(
      wireProjection(new ToolMessage({ content: '結果', tool_call_id: 'c1', name: 'glob' })),
    ).not.toBe(base);
    const ask = (q: string) =>
      wireProjection(
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'c1', name: 'grep', args: { q }, type: 'tool_call' }],
        }),
      );
    expect(ask('a')).not.toBe(ask('b'));
  });

  it('同 `fetch` 層：空的助手訊息整則不送；有工具呼叫的空內容一律是 null；空的工具結果是 `(no output)`', () => {
    expect(wireProjection(new AIMessage(''))).toBeUndefined();
    expect(wireProjection(new AIMessage(' \n'))).toBeUndefined();
    expect(wireProjection(new AIMessage({ content: [] }))).toBeUndefined();
    const call = [{ id: 'c1', name: 'grep', args: {}, type: 'tool_call' as const }];
    expect(wireProjection(new AIMessage({ content: [], tool_calls: call }))).toBe(
      wireProjection(new AIMessage({ content: [{ type: 'text', text: '' }], tool_calls: call })),
    );
    expect(wireProjection(new ToolMessage({ content: [], tool_call_id: 'c1' }))).toBe(
      wireProjection(new ToolMessage({ content: '(no output)', tool_call_id: 'c1' })),
    );
  });
});

describe('eventsForModelCall：這次呼叫要推的那一段', () => {
  it('去掉開著的那顆 model/start；沒有開著的就原樣', () => {
    const log = secondCallOpen();
    const events = log.events;
    expect(eventsForModelCall(events)).toEqual({
      events: events.slice(0, -1),
      offloadAfterStart: false,
    });
    const closed = events.slice(0, 5);
    expect(eventsForModelCall(closed).events).toBe(closed);
  });

  it('model/start 之後的 image/offload 留著，其餘不留（54 的快照形狀落在 model/start 之後）', () => {
    const log = secondCallOpen();
    log.append('request/system', { modelCall: 6, system: '系統', reason: 'change' });
    const offload = log.append('image/offload', { targets: [{ seq: 0, imageIndexes: [0] }] });
    const cut = eventsForModelCall(log.events);
    expect(cut.offloadAfterStart).toBe(true);
    expect(cut.events.map((event) => event.type)).toEqual([
      ...log.events.slice(0, 6).map((event) => event.type),
      'image/offload',
    ]);
    expect(cut.events.at(-1)).toBe(log.events.find((event) => event.seq === offload.seq));
  });
});

describe('compareHistoryWithLog：分類', () => {
  it('state 跟日誌推的一樣：match', () => {
    expect(compareHistoryWithLog(stateOfSecondCall(), secondCallOpen(), cache())).toEqual({
      kind: 'match',
    });
  });

  it('差一個字：other，帶第一處差異', () => {
    const messages = stateOfSecondCall();
    messages[1] = new AIMessage({ content: '乙', name: 'model' });
    const outcome = compareHistoryWithLog(messages, secondCallOpen(), cache());
    expect(outcome.kind).toBe('other');
    expect(outcome.detail).toMatch(/^第 1 則：請求 .*乙.*／推導 .*甲/u);
  });

  it('多一則：other，講則數', () => {
    const outcome = compareHistoryWithLog(
      [...stateOfSecondCall(), new HumanMessage('三')],
      secondCallOpen(),
      cache(),
    );
    expect(outcome).toMatchObject({
      kind: 'other',
      detail: expect.stringMatching(/^則數不同：請求 4 則、推導 3 則/u),
    });
  });

  it('推不出來：other', () => {
    const log = new SessionLog('shadow');
    log.append('turn/start', { kind: 'message', text: '一' });
    log.append('model/start', {});
    log.append('model/end', {});
    log.append('model/start', {});
    const outcome = compareHistoryWithLog([new HumanMessage('一')], log, cache());
    expect(outcome).toMatchObject({ kind: 'other', detail: expect.stringMatching(/^推不出來：/u) });
  });

  it('recovery 在 model/start 之後才省略圖：算進去才對得上，記成 image-offload-after-start', () => {
    const image = {
      type: 'image' as const,
      attachmentId: `sha256:${'a'.repeat(64)}`,
      mediaType: 'image/png' as const,
      bytes: 300,
      width: 4,
      height: 3,
    };
    const log = new SessionLog('shadow');
    const first = log.append('turn/start', { kind: 'message', text: '看', attachments: [image] });
    log.append('model/start', {});
    log.append('assistant/message', { message: reply('看到了') });
    log.append('model/end', {});
    log.append('turn/end', {});
    log.append('turn/start', { kind: 'message', text: '再' });
    log.append('model/start', {});
    const before = replayConversation(eventsForModelCall(log.events).events, SENT);
    log.append('image/offload', { targets: [{ seq: first.seq, imageIndexes: [0] }] });
    const after = replayConversation(eventsForModelCall(log.events).events, SENT);
    if (before.kind !== 'replayed' || after.kind !== 'replayed') throw new Error('推不出來');
    // 送出去的是省略過的那一份；沒省略的那一份就不同。
    expect(compareHistoryWithLog(after.messages, log, cache())).toEqual({
      kind: 'image-offload-after-start',
    });
    expect(compareHistoryWithLog(before.messages, log, cache()).kind).toBe('other');
  });

  it('只差懸空呼叫的補結句子：patch-closer', () => {
    const log = new SessionLog('shadow');
    log.append('turn/start', { kind: 'message', text: '查' });
    log.append('model/start', {});
    log.append('assistant/message', {
      message: toLoggedMessage(
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'c1', name: 'grep', args: {}, type: 'tool_call' }],
        }),
      ),
    });
    log.append('model/end', {});
    log.append('turn/end', { reason: { kind: 'interrupted' } });
    log.append('turn/start', { kind: 'message', text: '算了' });
    log.append('model/start', {});
    const { patchedMessages } = patchDanglingToolCalls([
      new HumanMessage('查'),
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'c1', name: 'grep', args: {}, type: 'tool_call' }],
      }),
      new HumanMessage('算了'),
    ]);
    expect(patchedMessages[2]!.content).toBe(patchedToolCallText('grep', 'c1'));
    const derived = replayConversation(eventsForModelCall(log.events).events, SENT);
    if (derived.kind !== 'replayed') throw new Error('推不出來');
    expect(derived.messages[2]!.content).toBe(TOOL_NOT_STARTED_TEXT);
    expect(compareHistoryWithLog(patchedMessages, log, cache())).toEqual({
      kind: 'patch-closer',
      detail: '1 則補結的句子不同',
    });
  });

  it('補結那一格的呼叫 id 或內容對不上：不算補結，是 other', () => {
    const tool = (content: string, id = 'c1') =>
      wireProjection(new ToolMessage({ content, tool_call_id: id, name: 'grep' }))!;
    expect(
      compareProjections([tool(patchedToolCallText('grep', 'c1'))], [tool(TOOL_NOT_STARTED_TEXT)])
        .kind,
    ).toBe('patch-closer');
    expect(
      compareProjections(
        [tool(patchedToolCallText('grep', 'c1'))],
        [tool(TOOL_NOT_STARTED_TEXT, 'c2')],
      ).kind,
    ).toBe('other');
    expect(compareProjections([tool('別的')], [tool(TOOL_NOT_STARTED_TEXT)]).kind).toBe('other');
    expect(compareProjections([tool(patchedToolCallText('grep', 'c1'))], [tool('別的')]).kind).toBe(
      'other',
    );
  });
});

describe('createHistoryShadowTally', () => {
  it('各類別分開數；不同的那幾次另外交出去，交出去那一端拋了也照數', () => {
    const seen: HistoryShadowOutcome[] = [];
    const tally = createHistoryShadowTally((outcome) => {
      seen.push(outcome);
      throw new Error('記錄端壞了');
    });
    tally.record({ kind: 'match' });
    tally.record({ kind: 'match' });
    tally.record({ kind: 'patch-closer', detail: 'x' });
    tally.record({ kind: 'other', detail: 'y' });
    expect(tally.counts()).toEqual({
      match: 2,
      'image-offload-after-start': 0,
      'patch-closer': 1,
      other: 1,
    });
    expect(seen.map((outcome) => outcome.kind)).toEqual(['patch-closer', 'other']);
  });
});

describe('createHistoryShadowMiddleware', () => {
  type Hook = (request: unknown, handler: (request: unknown) => unknown) => unknown;
  const hookOf = (sessions: { forCall(): SessionLookup }) => {
    const tally = createHistoryShadowTally();
    const middleware = createHistoryShadowMiddleware({ sessions, sink: tally }) as unknown as {
      wrapModelCall: Hook;
    };
    return { tally, hook: middleware.wrapModelCall };
  };

  it('請求原樣交下去（同一個物件），比對結果進 sink', async () => {
    const log = secondCallOpen();
    const { tally, hook } = hookOf({
      forCall: () => ({ kind: 'ok', address: { kind: 'root' }, log }),
    });
    const request = { messages: stateOfSecondCall(), runtime: { configurable: {} } };
    const handler = vi.fn((_request: unknown) => 'reply');
    expect(await hook(request, handler)).toBe('reply');
    expect(handler).toHaveBeenCalledWith(request);
    expect(handler.mock.calls[0]![0]).toBe(request);
    expect(tally.counts().match).toBe(1);
  });

  it('找不到日誌、讀日誌拋錯：記一筆 other，照樣交下去', async () => {
    for (const forCall of [
      () => ({ kind: 'unknown-caller' }) as SessionLookup,
      () => {
        throw new Error('壞了');
      },
    ]) {
      const { tally, hook } = hookOf({ forCall });
      const handler = vi.fn((_request: unknown) => 'reply');
      expect(await hook({ messages: [] }, handler)).toBe('reply');
      expect(tally.counts().other).toBe(1);
    }
  });

  it('同一份日誌往後長：每次只推新的（增量推導按日誌物件認）', async () => {
    const log = secondCallOpen();
    const { tally, hook } = hookOf({
      forCall: () => ({ kind: 'ok', address: { kind: 'root' }, log }),
    });
    await hook({ messages: stateOfSecondCall() }, () => undefined);
    log.append('assistant/message', { message: reply('乙') });
    log.append('model/end', {});
    log.append('turn/end', {});
    log.append('turn/start', { kind: 'message', text: '三' });
    log.append('model/start', {});
    await hook(
      {
        messages: [
          ...stateOfSecondCall(),
          new AIMessage({ content: '乙', name: 'model' }),
          new HumanMessage('三'),
        ],
      },
      () => undefined,
    );
    expect(tally.counts()).toMatchObject({ match: 2, other: 0 });
  });
});

describe('createHistoryFromLogMiddleware', () => {
  type Hook = (request: unknown, handler: (request: unknown) => unknown) => unknown;
  const hookOf = (sessions: { forCall(): SessionLookup }) =>
    (createHistoryFromLogMiddleware({ sessions }) as unknown as { wrapModelCall: Hook })
      .wrapModelCall;

  it('換掉 request.messages，其餘原樣：送出去的是日誌推出來的那一串', async () => {
    const log = secondCallOpen();
    const hook = hookOf({ forCall: () => ({ kind: 'ok', address: { kind: 'root' }, log }) });
    const request = {
      messages: [new HumanMessage('state 裡的另一串')],
      runtime: { configurable: {} },
      model: 'm',
    };
    const handler = vi.fn((_request: unknown) => 'reply');
    expect(await hook(request, handler)).toBe('reply');
    const sent = handler.mock.calls[0]![0] as typeof request;
    expect(sent.model).toBe('m');
    expect(sent.runtime).toBe(request.runtime);
    expect(sent.messages.map(wireProjection)).toEqual(stateOfSecondCall().map(wireProjection));
  });

  it('找不到日誌、推不出來：拋，不退回 state', async () => {
    const handler = vi.fn((_request: unknown) => 'reply');
    expect(() =>
      hookOf({ forCall: () => ({ kind: 'unknown-caller' }) as SessionLookup })(
        { messages: [new HumanMessage('甲')] },
        handler,
      ),
    ).toThrow(/找不到這次模型呼叫的日誌（unknown-caller）/u);
    const broken = new SessionLog('broken');
    broken.append('turn/start', { kind: 'message', text: '甲' });
    broken.append('model/start', {});
    broken.append('model/end', {});
    broken.append('turn/end', {});
    broken.append('turn/start', { kind: 'message', text: '乙' });
    broken.append('model/start', {});
    expect(() =>
      hookOf({ forCall: () => ({ kind: 'ok', address: { kind: 'root' }, log: broken }) })(
        { messages: [new HumanMessage('甲')] },
        handler,
      ),
    ).toThrow(/日誌推不回模型歷史.*--history-source state.*另開一條對話/su);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('createUnsummarizedHistoryReader：摘要前後的訊息都在', () => {
  it('同一份日誌：visible 讀者套摘要，這顆不套；摘要之後新增的訊息兩邊都跟著長', () => {
    const log = new SessionLog('reader');
    chat(log, '一', '甲');
    chat(log, '二', '乙');
    log.append('turn/start', { kind: 'message', text: '三' });
    log.append('compaction/summary', {
      cutoffIndex: 2,
      messagesBefore: 5,
      filePath: null,
      summary: toLoggedMessage(
        new HumanMessage({ content: '摘要', additional_kwargs: { lc_source: 'summarization' } }),
      ),
      beforeCall: true,
    });
    log.append('model/start', {});
    const visible = createVisibleHistoryReader();
    const unsummarized = createUnsummarizedHistoryReader();

    const textsOf = (messages: readonly BaseMessage[]) => messages.map((message) => message.text);
    expect(textsOf(visible(log))).toEqual(['摘要', '二', '乙', '三']);
    expect(textsOf(unsummarized(log))).toEqual(['一', '甲', '二', '乙', '三']);

    log.append('assistant/message', { message: reply('丙') });
    log.append('model/end', {});
    expect(textsOf(unsummarized(log))).toEqual(['一', '甲', '二', '乙', '三', '丙']);
  });
});
