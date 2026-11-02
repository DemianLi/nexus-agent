/**
 * 失敗輪留下的摘要事件，在下一步請求前補回 state（[#1390](https://github.com/DemianLi/nexus-agent/issues/1390)）。
 *
 * 分兩組：`summaryEventToCatchUp` 是判準（落後才補、比什麼、補什麼），`withSummaryCatchUp` 是接線（補在哪、
 * 什麼時候回 `Command`、讀誰的日誌、讀不到怎麼辦）。真的摘要器配真的 graph 的整合測試在
 * `apps/harness/src/summary-event-catch-up.test.ts`。
 */

import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { Command, isCommand } from '@langchain/langgraph';
import { describe, expect, it } from 'vitest';
import type { AgentMiddleware } from './base-types.js';
import { toLoggedMessage } from './logged-message.js';
import { toolCallSessionAddress } from './session-address.js';
import { SessionLog } from './session-log.js';
import type { SessionEvent } from './session-log.js';
import { SessionRegistry } from './session-registry.js';
import { summaryEventToCatchUp, withSummaryCatchUp } from './summary-catch-up.js';

/** 日誌上那一則摘要：與基座生的一樣帶 `lc_source`，replay 還原時靠它認得是摘要。 */
const summaryOf = (text: string) =>
  toLoggedMessage(
    new HumanMessage({ content: text, additional_kwargs: { lc_source: 'summarization' } }),
  );

/** 一筆 `compaction/summary` 事件；不經 `SessionLog` 的話 `seq` 之類用不到，這裡走真的 `append` 取一份。 */
function summaryEvent(
  data: Partial<Extract<SessionEvent, { type: 'compaction/summary' }>['data']> = {},
): SessionEvent {
  const log = new SessionLog('catch-up-unit');
  log.append('compaction/summary', {
    cutoffIndex: 4,
    messagesBefore: 6,
    filePath: '/conversation_history/t.md',
    summary: summaryOf('摘要一'),
    beforeCall: true,
    ...data,
  });
  return log.events[0]!;
}

const messages = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    index % 2 === 0 ? new HumanMessage(`問 ${index}`) : new AIMessage(`答 ${index}`),
  );

describe('summaryEventToCatchUp：state 的事件落後日誌才補', () => {
  it('日誌上沒有摘要事件：不補', () => {
    expect(summaryEventToCatchUp({ messages: messages(8) }, [])).toBeUndefined();
  });

  it('state 沒有事件、日誌有：補日誌那一筆（切點、filePath 原樣，摘要訊息是摘要型的 HumanMessage）', () => {
    const restored = summaryEventToCatchUp({ messages: messages(8) }, [summaryEvent()]);

    expect(restored?.cutoffIndex).toBe(4);
    expect(restored?.filePath).toBe('/conversation_history/t.md');
    expect(HumanMessage.isInstance(restored?.summaryMessage)).toBe(true);
    expect(restored?.summaryMessage.text).toBe('摘要一');
    expect(restored?.summaryMessage.additional_kwargs.lc_source).toBe('summarization');
  });

  it('state 的切點與 filePath 都跟日誌一樣：已經跟上，不補（結構化比對，摘要文字不一樣也算同一筆）', () => {
    const state = {
      messages: messages(8),
      _summarizationEvent: {
        cutoffIndex: 4,
        filePath: '/conversation_history/t.md',
        summaryMessage: new HumanMessage('模型這次生的字跟日誌上那份不一樣'),
      },
    };
    expect(summaryEventToCatchUp(state, [summaryEvent()])).toBeUndefined();
  });

  it('state 的切點比日誌的小：落後，補', () => {
    const state = {
      messages: messages(8),
      _summarizationEvent: {
        cutoffIndex: 2,
        filePath: '/conversation_history/t.md',
        summaryMessage: new HumanMessage('舊摘要'),
      },
    };
    expect(summaryEventToCatchUp(state, [summaryEvent({ cutoffIndex: 4 })])?.cutoffIndex).toBe(4);
  });

  it('state 的切點比日誌的大（state 走在前面）：不退回舊的', () => {
    const state = {
      messages: messages(8),
      _summarizationEvent: {
        cutoffIndex: 6,
        filePath: '/conversation_history/t2.md',
        summaryMessage: new HumanMessage('新摘要'),
      },
    };
    expect(summaryEventToCatchUp(state, [summaryEvent({ cutoffIndex: 4 })])).toBeUndefined();
  });

  /** 同一切點、filePath 不一樣不算跟上，但也不是「落後」（切點沒有比 state 大）：不動。 */
  it('同一切點、filePath 不同：切點不比 state 大，不補', () => {
    const state = {
      messages: messages(8),
      _summarizationEvent: {
        cutoffIndex: 4,
        filePath: '/conversation_history/other.md',
        summaryMessage: new HumanMessage('別份'),
      },
    };
    expect(summaryEventToCatchUp(state, [summaryEvent()])).toBeUndefined();
  });

  it('日誌上 filePath 是 null（原文沒寫成功）：照樣補，filePath 保持 null', () => {
    const restored = summaryEventToCatchUp({ messages: messages(8) }, [
      summaryEvent({ filePath: null }),
    ]);
    expect(restored?.filePath).toBeNull();
  });

  it('日誌上有好幾筆：取最後一筆', () => {
    const restored = summaryEventToCatchUp({ messages: messages(10) }, [
      summaryEvent({ cutoffIndex: 2, summary: summaryOf('摘要一') }),
      summaryEvent({ cutoffIndex: 6, summary: summaryOf('摘要二') }),
    ]);
    expect(restored?.cutoffIndex).toBe(6);
    expect(restored?.summaryMessage.text).toBe('摘要二');
  });

  it('切點落在 state 訊息串之外（日誌與 state 不是同一份歷史）：不補', () => {
    expect(
      summaryEventToCatchUp({ messages: messages(3) }, [summaryEvent({ cutoffIndex: 4 })]),
    ).toBeUndefined();
  });

  it('日誌事件沒有摘要本文（舊日誌）：不補', () => {
    const { summary: _omitted, ...rest } = {
      cutoffIndex: 4,
      messagesBefore: 6,
      filePath: null,
    } as {
      cutoffIndex: number;
      messagesBefore: number;
      filePath: null;
      summary?: undefined;
    };
    const log = new SessionLog('catch-up-no-summary');
    log.append('compaction/summary', rest);
    expect(summaryEventToCatchUp({ messages: messages(8) }, log.events)).toBeUndefined();
  });

  it('日誌上的摘要不是 HumanMessage：不補（基座的 schema 只收 HumanMessage）', () => {
    const asAi = toLoggedMessage(new AIMessage('我是 ai'));
    expect(
      summaryEventToCatchUp({ messages: messages(8) }, [summaryEvent({ summary: asAi })]),
    ).toBeUndefined();
  });

  it('state 缺失或形狀不對：當沒有事件，照補', () => {
    expect(summaryEventToCatchUp(undefined, [summaryEvent()])?.cutoffIndex).toBe(4);
    expect(
      summaryEventToCatchUp({ _summarizationEvent: 'oops' }, [summaryEvent()])?.cutoffIndex,
    ).toBe(4);
  });
});

/** 一個只認得 `wrapModelCall` 的最小摘要器替身：記下它收到的請求，回指定的結果。 */
function fakeSummarizer(result: () => unknown) {
  const received: { state: unknown }[] = [];
  const middleware = {
    name: 'SummarizationMiddleware',
    wrapModelCall: async (request: { state: unknown }) => {
      received.push(request);
      return result();
    },
  } as unknown as AgentMiddleware;
  return { middleware, received };
}

/** 與 `registry.forCall` 同一個鑰匙：`request.runtime.configurable` → 地址 → 該地址的日誌。 */
function lookupOver(sessions: SessionRegistry) {
  return {
    forCall(config: unknown) {
      const address = toolCallSessionAddress(config);
      if (address === undefined) return { kind: 'unknown-caller' as const };
      return { kind: 'ok' as const, address, log: sessions.open(address) };
    },
  };
}

const requestOf = (state: unknown, checkpointNs = 'model_request:1') => ({
  state,
  messages: [],
  runtime: { configurable: { checkpoint_ns: checkpointNs, thread_id: 't' } },
});

const callOf = (middleware: AgentMiddleware, request: unknown) =>
  middleware.wrapModelCall!(
    request as never,
    (async () => new AIMessage('由 handler 回')) as never,
  );

describe('withSummaryCatchUp：補在請求前，補不補看日誌', () => {
  it('沒有落後（S0：日誌上根本沒有摘要）：請求原樣往下、不回任何 Command', async () => {
    const sessions = new SessionRegistry('root');
    const { middleware, received } = fakeSummarizer(() => new AIMessage('ok'));
    const wrapped = withSummaryCatchUp(middleware, lookupOver(sessions));
    const request = requestOf({ messages: messages(4) });

    const result = await callOf(wrapped, request);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(request);
    expect(isCommand(result)).toBe(false);
  });

  it('落後：交下去的 state 帶著還原的事件，下面沒回 Command 時補一顆只帶事件的 Command', async () => {
    const sessions = new SessionRegistry('root');
    sessions.root.append('compaction/summary', {
      cutoffIndex: 4,
      messagesBefore: 6,
      filePath: '/conversation_history/t.md',
      summary: summaryOf('摘要一'),
      beforeCall: true,
    });
    const { middleware, received } = fakeSummarizer(() => new AIMessage('ok'));
    const wrapped = withSummaryCatchUp(middleware, lookupOver(sessions));

    const result = await callOf(wrapped, requestOf({ messages: messages(8) }));

    const seen = (received[0]!.state as { _summarizationEvent?: { cutoffIndex: number } })
      ._summarizationEvent;
    expect(seen?.cutoffIndex).toBe(4);
    expect(isCommand(result)).toBe(true);
    const update = (result as Command).update as {
      _summarizationEvent: { cutoffIndex: number; filePath: string | null };
    };
    expect(Object.keys(update)).toEqual(['_summarizationEvent']);
    expect(update._summarizationEvent.cutoffIndex).toBe(4);
    expect(update._summarizationEvent.filePath).toBe('/conversation_history/t.md');
  });

  it('下面自己回了 Command（這一步又摘要了）：原樣往外，不覆蓋成補的那一筆', async () => {
    const sessions = new SessionRegistry('root');
    sessions.root.append('compaction/summary', {
      cutoffIndex: 4,
      messagesBefore: 6,
      filePath: '/conversation_history/t.md',
      summary: summaryOf('摘要一'),
      beforeCall: true,
    });
    const own = new Command({
      update: { _summarizationEvent: { cutoffIndex: 7, filePath: '/conversation_history/t.md' } },
    });
    const { middleware } = fakeSummarizer(() => own);
    const wrapped = withSummaryCatchUp(middleware, lookupOver(sessions));

    expect(await callOf(wrapped, requestOf({ messages: messages(8) }))).toBe(own);
  });

  it('讀日誌拋了：當沒有落後，請求照舊往下走', async () => {
    const { middleware, received } = fakeSummarizer(() => new AIMessage('ok'));
    const wrapped = withSummaryCatchUp(middleware, {
      forCall() {
        throw new Error('註冊表壞了');
      },
    });
    const request = requestOf({ messages: messages(4) });

    const result = await callOf(wrapped, request);

    expect(received[0]).toBe(request);
    expect(isCommand(result)).toBe(false);
  });

  it('讀不到日誌（not-attached、unknown-caller）：不補', async () => {
    const { middleware, received } = fakeSummarizer(() => new AIMessage('ok'));
    const wrapped = withSummaryCatchUp(middleware, {
      forCall: () => ({ kind: 'not-attached' as const }),
    });
    const request = requestOf({ messages: messages(4) });

    await callOf(wrapped, request);

    expect(received[0]).toBe(request);
  });

  it('子代理讀自己那份日誌：root 有事件、子代理沒有，子代理不補；反過來子代理有、root 沒有就補', async () => {
    const sessions = new SessionRegistry('root');
    const entry = {
      cutoffIndex: 4,
      messagesBefore: 6,
      filePath: '/conversation_history/t.md',
      summary: summaryOf('摘要一'),
      beforeCall: true as const,
    };
    // root 有、子代理沒有。
    sessions.root.append('compaction/summary', entry);
    const first = fakeSummarizer(() => new AIMessage('ok'));
    const asSubagent = requestOf({ messages: messages(8) }, 'tools:call-1|model_request:2');
    const fromSub = await callOf(
      withSummaryCatchUp(first.middleware, lookupOver(sessions)),
      asSubagent,
    );
    expect(isCommand(fromSub)).toBe(false);
    expect(first.received[0]).toBe(asSubagent);

    // 子代理有（用另一份註冊表，root 這份是空的）。
    const other = new SessionRegistry('root-2');
    other.open({ kind: 'subagent', runId: 'tools:call-1' }).append('compaction/summary', entry);
    const second = fakeSummarizer(() => new AIMessage('ok'));
    const wrapped = withSummaryCatchUp(second.middleware, lookupOver(other));
    expect(isCommand(await callOf(wrapped, requestOf({ messages: messages(8) })))).toBe(false);
    const fromSubWith = await callOf(
      wrapped,
      requestOf({ messages: messages(8) }, 'tools:call-1|model_request:2'),
    );
    expect(isCommand(fromSubWith)).toBe(true);
  });

  /** 換模型：規則不看 `request.model`——同一份日誌、同一份 state，不論請求帶哪一顆都補、補的是同一筆。 */
  it('請求帶哪一顆模型都不影響補不補、補什麼', async () => {
    const sessions = new SessionRegistry('root');
    sessions.root.append('compaction/summary', {
      cutoffIndex: 4,
      messagesBefore: 6,
      filePath: '/conversation_history/t.md',
      summary: summaryOf('摘要一'),
      beforeCall: true,
    });
    const outcomes: unknown[] = [];
    for (const model of [{ name: 'default' }, { name: 'small' }, undefined]) {
      const { middleware } = fakeSummarizer(() => new AIMessage('ok'));
      const wrapped = withSummaryCatchUp(middleware, lookupOver(sessions));
      const result = await callOf(wrapped, { ...requestOf({ messages: messages(8) }), model });
      outcomes.push((result as Command).update);
    }
    expect(outcomes[1]).toEqual(outcomes[0]);
    expect(outcomes[2]).toEqual(outcomes[0]);
  });

  it('不改名、不改別的鉤子：只換 wrapModelCall', () => {
    const { middleware } = fakeSummarizer(() => new AIMessage('ok'));
    const wrapped = withSummaryCatchUp(middleware, lookupOver(new SessionRegistry('root')));
    expect(wrapped.name).toBe(middleware.name);
    expect(wrapped.wrapModelCall).not.toBe(middleware.wrapModelCall);
  });
});
