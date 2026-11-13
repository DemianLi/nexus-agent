/**
 * 增量推導對整份重算逐位元組相同（[#2349](https://github.com/DemianLi/nexus-agent/issues/2349)）。
 *
 * 每一份日誌都**逐個前綴**比：同一個 {@link ModelHistoryCache} 依序吃 `events[0..k]`，每一步跟
 * `deriveConversation(events[0..k])` 比。只比最後一份的話，中途推錯、後來剛好被重建蓋掉的快取也會綠。
 * 步距另跑兩種：每三顆推一次、只在每顆 `model/start` 之前推（呼叫端實際的時機）。一次吃進好幾顆事件才碰得到的錯，
 * 例如 `session/end-seed` 換掉的串跟後面新進的訊息落在同一次，逐顆推碰不到。
 * 比的是每則訊息轉成 `BaseMessage`、再 {@link toLoggedMessage} 之後的 JSON，也就是日誌記訊息的那個形狀（含 `additional_kwargs`）。
 *
 * 前五節各對著 {@link MODEL_HISTORY_REBUILD_EVENTS} 的一種：那一種事件之後還有新的訊息進來，漏了重建就推錯。
 * 出貨寫入器寫的夾具另在 `apps/harness` 的 `model-history-fixtures.test.ts` 比。
 */

import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';

import { deriveConversation, ReplayFold } from './conversation-replay.js';
import type { DerivedConversation } from './conversation-replay.js';
import { toBaseMessage } from './langchain-message-adapter.js';
import { toLoggedMessage } from './logged-message.js';
import { MODEL_HISTORY_REBUILD_EVENTS, ModelHistoryCache } from './model-history.js';
import type { ModelHistoryOptions } from './model-history.js';
import { SessionLog } from './session-log.js';
import type { SessionEvent } from './session-log.js';

const ORIGINAL = '字'.repeat(300);

function serialized(replay: DerivedConversation): unknown {
  return replay.kind === 'replayed'
    ? replay.messages.map((message) => JSON.stringify(toLoggedMessage(toBaseMessage(message))))
    : replay;
}

const SENT: ModelHistoryOptions = {
  applyPrunes: true,
  applyArgTruncations: true,
  applyImageOffloads: true,
};

/** 逐個前綴、每三顆、每顆 `model/start` 之前各比一輪，兩組選項各一次。 */
function expectEveryPrefix(events: readonly SessionEvent[]): void {
  const every = events.map((_, k) => k + 1);
  const strides = {
    逐顆: [0, ...every],
    每三顆: [0, ...every.filter((k) => k % 3 === 0), events.length],
    'model/start 之前': events.flatMap((event, k) => (event.type === 'model/start' ? [k] : [])),
  };
  for (const options of [{}, SENT]) {
    for (const [stride, cuts] of Object.entries(strides)) {
      const cache = new ModelHistoryCache(options);
      for (const k of cuts) {
        const prefix = events.slice(0, k);
        expect(serialized(cache.derive(prefix)), `${stride}，前 ${String(k)} 顆`).toEqual(
          serialized(deriveConversation(prefix, options)),
        );
      }
    }
  }
}

function asking(text: string, calls: readonly (readonly [id: string, name: string])[]) {
  return toLoggedMessage(
    new AIMessage({
      content: text,
      tool_calls: calls.map(([id, name]) => ({ id, name, args: {}, type: 'tool_call' as const })),
    }),
  );
}

const reply = (text: string) => toLoggedMessage(new AIMessage(text));
const result = (id: string, name: string, text: string) =>
  toLoggedMessage(new ToolMessage({ content: text, tool_call_id: id, name }));
const summaryMessage = (text: string) =>
  toLoggedMessage(
    new HumanMessage({ content: text, additional_kwargs: { lc_source: 'summarization' } }),
  );

function tool(log: SessionLog, id: string, name: string, text: string): void {
  log.append('tool/call', { callId: id, name, arguments: '{}' });
  log.append('tool/result', { callId: id, isError: false, message: result(id, name, text) });
}

function chat(log: SessionLog, said: string, answered: string): void {
  log.append('turn/start', { kind: 'message', text: said });
  log.append('model/start', {});
  log.append('assistant/message', { message: reply(answered) });
  log.append('model/end', {});
  log.append('turn/end', {});
}

describe('compaction/summary：切點之前的要拿掉', () => {
  it('新順序：摘要記在用到它的呼叫之前，之後還有幾輪', () => {
    const log = new SessionLog('history');
    chat(log, '一', '甲');
    chat(log, '二', '乙');
    log.append('turn/start', { kind: 'message', text: '三' });
    log.append('compaction/summary', {
      cutoffIndex: 2,
      messagesBefore: 5,
      filePath: null,
      summary: summaryMessage('摘要'),
      beforeCall: true,
    });
    log.append('model/start', {});
    log.append('assistant/message', { message: reply('丙') });
    log.append('model/end', {});
    log.append('turn/end', {});
    chat(log, '四', '丁');
    expectEveryPrefix(log.events);
  });

  it('壓縮兩次：第二次的切點以第一次之後的串為座標', () => {
    const log = new SessionLog('history');
    chat(log, '一', '甲');
    chat(log, '二', '乙');
    log.append('turn/start', { kind: 'message', text: '三' });
    log.append('compaction/summary', {
      cutoffIndex: 2,
      messagesBefore: 5,
      filePath: null,
      summary: summaryMessage('摘要一'),
      beforeCall: true,
    });
    log.append('assistant/message', { message: reply('丙') });
    log.append('turn/end', {});
    chat(log, '四', '丁');
    log.append('turn/start', { kind: 'message', text: '五' });
    log.append('compaction/summary', {
      cutoffIndex: 6,
      messagesBefore: 9,
      filePath: null,
      summary: summaryMessage('摘要二'),
      beforeCall: true,
    });
    log.append('assistant/message', { message: reply('戊') });
    log.append('turn/end', {});
    expectEveryPrefix(log.events);
  });

  it('切點落在還沒配齊的那一批裡：先補齊再切', () => {
    const log = new SessionLog('history');
    chat(log, '一', '甲');
    log.append('turn/start', { kind: 'message', text: '查' });
    log.append('assistant/message', {
      message: asking('好', [
        ['c1', 'grep'],
        ['c2', 'grep'],
      ]),
    });
    tool(log, 'c1', 'grep', '一號');
    tool(log, 'c2', 'grep', '二號');
    // raw 有四則（一、甲、查、好），那一批兩則還沒放進去：切點 5 落在第二顆結果上。
    log.append('compaction/summary', {
      cutoffIndex: 5,
      messagesBefore: 6,
      filePath: null,
      summary: summaryMessage('摘要'),
      beforeCall: true,
    });
    log.append('assistant/message', { message: reply('找到了') });
    log.append('turn/end', {});
    chat(log, '再', '好的');
    expectEveryPrefix(log.events);
  });
});

describe('compaction/prune：早就在串裡的工具結果要換', () => {
  it('剪的是前一輪的結果，之後還有一輪', () => {
    const log = new SessionLog('history');
    log.append('turn/start', { kind: 'message', text: '查' });
    log.append('assistant/message', { message: asking('好', [['c1', 'grep']]) });
    tool(log, 'c1', 'grep', ORIGINAL);
    log.append('assistant/message', { message: reply('找到了') });
    log.append('turn/end', {});
    chat(log, '再', '好的');
    log.append('compaction/prune', {
      results: [{ callId: 'c1', originalChars: 300, content: '頭…尾' }],
    });
    chat(log, '三', '嗯');
    expectEveryPrefix(log.events);
  });
});

describe('compaction/truncate-args：早就在串裡的助手訊息要換', () => {
  it('縮短的是前一輪的參數，之後還有一輪', () => {
    const log = new SessionLog('history');
    log.append('turn/start', { kind: 'message', text: '寫' });
    log.append('assistant/message', {
      message: toLoggedMessage(
        new AIMessage({
          content: '好',
          tool_calls: [
            {
              id: 'c1',
              name: 'write_file',
              args: { file_path: '/a.txt', content: ORIGINAL },
              type: 'tool_call' as const,
            },
          ],
        }),
      ),
    });
    tool(log, 'c1', 'write_file', '寫好了');
    log.append('assistant/message', { message: reply('完成') });
    log.append('turn/end', {});
    log.append('compaction/truncate-args', {
      calls: [{ callId: 'c1', args: { content: { originalChars: 300, value: '短' } } }],
    });
    chat(log, '再', '好的');
    expectEveryPrefix(log.events);
  });
});

describe('image/offload：早就在串裡的人話要換', () => {
  it('省略的是前一輪的圖，之後還有一輪', () => {
    const image = {
      type: 'image' as const,
      attachmentId: `sha256:${'a'.repeat(64)}`,
      mediaType: 'image/png' as const,
      bytes: 300,
      width: 4,
      height: 3,
    };
    const log = new SessionLog('history');
    const first = log.append('turn/start', { kind: 'message', text: '看', attachments: [image] });
    log.append('model/start', {});
    log.append('assistant/message', { message: reply('看到了') });
    log.append('model/end', {});
    log.append('turn/end', {});
    chat(log, '再', '好的');
    log.append('image/offload', { targets: [{ seq: first.seq, imageIndexes: [0] }] });
    chat(log, '三', '嗯');
    expectEveryPrefix(log.events);
    // 套了才是送出去的那一份：第一輪那張圖標成已省略；不套就原樣。
    const flagOf = (options: ModelHistoryOptions) => {
      const derived = new ModelHistoryCache(options).derive(log.events);
      if (derived.kind !== 'replayed') throw new Error(derived.reason);
      const content = derived.messages[0]!.data.content as { type: string; offloaded?: boolean }[];
      return content.find((block) => block.type === 'nexus-image')?.offloaded;
    };
    expect(flagOf(SENT)).toBe(true);
    expect(flagOf({})).toBeUndefined();
  });
});

describe('session/end-seed：座標重設、整串換掉', () => {
  it('空的助手訊息在 end-seed 濾掉，之後的新輪接在換過的串後面', () => {
    const log = new SessionLog('history');
    log.append('turn/start', { kind: 'message', text: '一' });
    log.append('assistant/message', { message: reply('') });
    log.append('assistant/message', { message: reply('甲') });
    log.append('turn/end', {});
    log.append('session/end-seed', {});
    chat(log, '二', '乙');
    chat(log, '三', '丙');
    expectEveryPrefix(log.events);
  });

  it('壓縮過再 end-seed：灌回去的串是摘要加之後的', () => {
    const log = new SessionLog('history');
    chat(log, '一', '甲');
    log.append('turn/start', { kind: 'message', text: '二' });
    log.append('compaction/summary', {
      cutoffIndex: 2,
      messagesBefore: 3,
      filePath: null,
      summary: summaryMessage('摘要'),
      beforeCall: true,
    });
    log.append('assistant/message', { message: reply('乙') });
    log.append('turn/end', {});
    log.append('session/end-seed', {});
    chat(log, '三', '丙');
    expectEveryPrefix(log.events);
  });
});

describe('沒有重建事件的一般路徑', () => {
  it('那一批還沒到齊時補上的幾則，結果到了就換掉；外掛注入的話跟著結果走', () => {
    const log = new SessionLog('history');
    log.append('turn/start', { kind: 'message', text: '查' });
    log.append('assistant/message', {
      message: asking('好', [
        ['c1', 'grep'],
        ['c2', 'goal'],
      ]),
    });
    log.append('tool/call', { callId: 'c1', name: 'grep', arguments: '{}' });
    log.append('tool/call', { callId: 'c2', name: 'goal', arguments: '{}' });
    log.append('tool/result', {
      callId: 'c2',
      isError: false,
      message: result('c2', 'goal', '二'),
    });
    log.append('user/message', {
      message: toLoggedMessage(new HumanMessage('目標達成')),
      source: { kind: 'plugin', plugin: 'goal' },
    });
    log.append('tool/result', {
      callId: 'c1',
      isError: false,
      message: result('c1', 'grep', '一'),
    });
    log.append('assistant/message', { message: reply('好了') });
    log.append('turn/end', {});
    expectEveryPrefix(log.events);
  });

  it('推不下去的事件之後一直推不下去；整份層級的拒推隨後面的回覆解除', () => {
    const log = new SessionLog('history');
    log.append('turn/start', { kind: 'message', text: '一' });
    log.append('tool/call', { callId: 'c0', name: 'grep', arguments: '{}' });
    log.append('assistant/message', { message: reply('甲') });
    log.append('turn/end', {});
    log.append('turn/start', { kind: 'message', text: '二' });
    log.append('tool/result', { callId: 'c9', isError: false });
    chat(log, '三', '丙');
    expectEveryPrefix(log.events);
  });
});

describe('快取的邊界', () => {
  it('傳進來的不是上一次的延伸：從頭推', () => {
    const a = new SessionLog('a');
    chat(a, '一', '甲');
    chat(a, '二', '乙');
    const b = new SessionLog('b');
    chat(b, '別的', '別的回覆');
    const cache = new ModelHistoryCache();
    cache.derive(a.events);
    expect(serialized(cache.derive(b.events))).toEqual(serialized(deriveConversation(b.events)));
    expect(serialized(cache.derive(a.events.slice(0, 3)))).toEqual(
      serialized(deriveConversation(a.events.slice(0, 3))),
    );
  });

  it('改交出去的陣列不影響下一次', () => {
    const log = new SessionLog('history');
    chat(log, '一', '甲');
    const cache = new ModelHistoryCache();
    const first = cache.derive(log.events);
    if (first.kind !== 'replayed') throw new Error('推不出來');
    (first.messages as unknown[]).length = 0;
    chat(log, '二', '乙');
    expect(serialized(cache.derive(log.events))).toEqual(
      serialized(deriveConversation(log.events)),
    );
  });

  it('重建事件恰好是這五種', () => {
    expect([...MODEL_HISTORY_REBUILD_EVENTS].sort()).toEqual([
      'compaction/prune',
      'compaction/summary',
      'compaction/truncate-args',
      'image/offload',
      'session/end-seed',
    ]);
  });
});

describe('deriveUnsummarized：沒套摘要的那一串', () => {
  const texts = (replay: DerivedConversation): string[] =>
    replay.kind === 'replayed' ? replay.messages.map((message) => toBaseMessage(message).text) : [];

  /** 對照組：新的 `ReplayFold` 餵同一段事件，取 `raw` 接上等結果的那一批。 */
  const expected = (events: readonly SessionEvent[]): unknown => {
    const fold = new ReplayFold();
    for (const event of events) fold.feed(event);
    return [...fold.raw, ...fold.pendingMessages()].map((message) =>
      JSON.stringify(toLoggedMessage(toBaseMessage(message))),
    );
  };

  function summarized(): SessionLog {
    const log = new SessionLog('history');
    chat(log, '一', '甲');
    chat(log, '二', '乙');
    log.append('turn/start', { kind: 'message', text: '三' });
    log.append('compaction/summary', {
      cutoffIndex: 2,
      messagesBefore: 5,
      filePath: null,
      summary: summaryMessage('摘要'),
      beforeCall: true,
    });
    log.append('model/start', {});
    log.append('assistant/message', { message: reply('丙') });
    log.append('model/end', {});
    log.append('turn/end', {});
    tool(log, 'c1', 'echo', '回聲');
    chat(log, '四', '丁');
    return log;
  }

  it('摘要之後切點之前的訊息還在、摘要訊息不在；`derive` 照樣套摘要', () => {
    const log = summarized();
    const cache = new ModelHistoryCache();
    const visible = texts(cache.derive(log.events));
    const raw = texts(cache.deriveUnsummarized(log.events));
    expect(raw).toContain('一');
    expect(raw).toContain('甲');
    expect(raw).not.toContain('摘要');
    expect(visible).toContain('摘要');
    expect(visible).not.toContain('一');
    expect(raw.length).toBeGreaterThan(visible.length);
  });

  it('逐個前綴與新 ReplayFold 推的相同；同一個實例穿插叫 derive 不影響結果', () => {
    const { events } = summarized();
    const cache = new ModelHistoryCache(SENT);
    events.forEach((_, k) => {
      const prefix = events.slice(0, k + 1);
      const raw = cache.deriveUnsummarized(prefix);
      if (k % 2 === 0) cache.derive(prefix);
      if (raw.kind === 'replayed') {
        expect(
          raw.messages.map((message) => JSON.stringify(toLoggedMessage(toBaseMessage(message)))),
          `前 ${String(k + 1)} 顆`,
        ).toEqual(expected(prefix));
      }
    });
  });

  it('不套剪法、縮短與圖片省略，即使選項開著', () => {
    const log = new SessionLog('history');
    log.append('turn/start', { kind: 'message', text: '讀它' });
    log.append('model/start', {});
    log.append('assistant/message', { message: asking('', [['p1', 'read']]) });
    log.append('model/end', {});
    tool(log, 'p1', 'read', ORIGINAL);
    log.append('compaction/prune', {
      results: [{ callId: 'p1', originalChars: ORIGINAL.length, content: '頭…尾' }],
    });
    chat(log, '再說', '好');
    const cache = new ModelHistoryCache(SENT);
    const raw = serialized(cache.deriveUnsummarized(log.events));
    expect(raw).toEqual(expected(log.events));
    expect(JSON.stringify(raw)).toContain(ORIGINAL);
    expect(JSON.stringify(serialized(cache.derive(log.events)))).not.toContain(ORIGINAL);
  });

  it('推不出來時回 unreplayable，原因同 derive', () => {
    const log = new SessionLog('history');
    log.append('turn/start', { kind: 'message', text: '一' });
    log.append('model/start', {});
    const cache = new ModelHistoryCache();
    const raw = cache.deriveUnsummarized(log.events);
    expect(raw.kind).toBe('unreplayable');
    expect(raw).toEqual(cache.derive(log.events));
  });
});
