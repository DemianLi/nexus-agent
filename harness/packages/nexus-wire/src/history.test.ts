import { describe, expect, it } from 'vitest';
import type { Event } from './index.js';
import { emptyConversation, prependEntries, reduceAll } from './conversation.js';

/**
 * 歷史那幾顆 frame 在折疊器這一層的樣子（[#306](https://github.com/DemianLi/nexus-agent/issues/306)）。
 *
 * **真的日誌轉出來的 frame 驗在 `@nexus/harness`**（`conversation-history.test.ts` 與 `serve-history.test.ts`）。
 * 這裡只驗折疊器自己那兩件：人話那一格，以及歷史不帶 `seq` 時之後的即時 frame 還折得進來。
 */

function historyFrame(method: string, data: unknown): Event {
  return { type: 'event', method, params: { namespace: [], timestamp: 0, data } } as Event;
}

function liveFrame(seq: number, method: string, data: unknown): Event {
  return {
    type: 'event',
    seq,
    event_id: `t:${seq}`,
    method,
    params: { namespace: [], timestamp: 0, data },
  } as Event;
}

function said(role: 'human' | 'ai', id: string, text: string): Event[] {
  return [
    historyFrame('messages', { event: 'message-start', role, id }),
    historyFrame('messages', {
      event: 'content-block-delta',
      index: 0,
      delta: { type: 'text-delta', text },
      id,
    }),
    historyFrame('messages', { event: 'message-finish', reason: 'stop', id }),
  ];
}

const HISTORY: readonly Event[] = [
  historyFrame('lifecycle', { event: 'running', graph_name: 'root' }),
  ...said('human', 'history-0', '記住暗號是藍鯨'),
  ...said('ai', 'history-3', '記住了。'),
  historyFrame('lifecycle', { event: 'completed', graph_name: 'root' }),
];

/** 傳輸 seq 從 0 起的一則即時回覆——行程重開之後的第一輪就是這樣。 */
const LIVE_REPLY: readonly Event[] = [
  liveFrame(0, 'lifecycle', { event: 'running', graph_name: 'root' }),
  liveFrame(1, 'messages', { event: 'message-start', role: 'ai', id: 'run-a', run_id: 'a' }),
  liveFrame(2, 'messages', {
    event: 'content-block-delta',
    index: 0,
    delta: { type: 'text-delta', text: '暗號是藍鯨。' },
    run_id: 'a',
  }),
  liveFrame(3, 'messages', { event: 'message-finish', reason: 'stop', run_id: 'a' }),
  liveFrame(4, 'lifecycle', { event: 'completed', graph_name: 'root' }),
];

describe('歷史的 frame', () => {
  it('role 是 human 的一則畫成人話，而且不把狀態翻成跑著', () => {
    const state = reduceAll(emptyConversation(), said('human', 'history-0', '記住暗號是藍鯨'));

    expect(state.entries).toEqual([{ kind: 'human', id: 'history-0', text: '記住暗號是藍鯨' }]);
    expect(state.status).toBe('idle');
  });

  it('折完歷史之後，傳輸 seq 從 0 起的即時回覆照樣畫得出來', () => {
    const state = reduceAll(reduceAll(emptyConversation(), HISTORY), LIVE_REPLY);

    expect(state.entries.map((entry) => ('text' in entry ? entry.text : entry.kind))).toEqual([
      '記住暗號是藍鯨',
      '記住了。',
      '暗號是藍鯨。',
    ]);
    expect(state.status).toBe('idle');
  });

  /**
   * **這一條說明上一條為什麼要緊**：歷史帶了日誌的耐久 seq，傳輸 seq 從 0 起的即時 frame 全被當成重複丟掉——
   * 畫面上看不到回覆，日誌上一切正常。所以歷史不帶 seq（`historyPath` 的說明）。
   */
  it('對照：歷史帶了耐久 seq 的話，即時回覆整則不見', () => {
    const durable = HISTORY.map((event, index) => ({ ...event, seq: 40 + index }));
    const state = reduceAll(reduceAll(emptyConversation(), durable), LIVE_REPLY);

    expect(state.entries.map((entry) => ('text' in entry ? entry.text : entry.kind))).toEqual([
      '記住暗號是藍鯨',
      '記住了。',
    ]);
  });
});

describe('prependEntries', () => {
  it('更早那一頁接在最前面，現在的狀態不動', () => {
    const now = reduceAll(emptyConversation(), [
      historyFrame('lifecycle', { event: 'running', graph_name: 'root' }),
      ...said('human', 'history-9', '後來那句'),
    ]);
    const earlier = reduceAll(emptyConversation(), HISTORY);

    const joined = prependEntries(now, earlier);

    expect(joined.entries.map((entry) => entry.id)).toEqual([
      'history-0',
      'history-3',
      'history-9',
    ]);
    expect(joined.status).toBe('running');
  });
});
