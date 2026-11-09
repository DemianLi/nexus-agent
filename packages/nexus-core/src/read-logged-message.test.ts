/**
 * 只讀推回（[#2117](https://github.com/DemianLi/nexus-agent/issues/2117)）：`readLoggedMessage` 推出的訊息跟 `fromLoggedMessage` 一樣，
 * 巢狀的值與日誌共用、不拷；輸入是凍過的也推得回來，推完日誌那一份沒變。
 *
 * 語料涵蓋建構子會動手的幾種：每則回覆都在 `data` 上補欄位（舊格式只有 `additional_kwargs.tool_calls` 的那則補 `tool_calls`）、
 * v1 的內容陣列與 `contentBlocks` 陣列（建構子在上面補 `tool_call` 區塊）；工具結果與使用者訊息是對照。少拷那兩個陣列，
 * 凍過的輸入就在建構子裡拋錯。
 */

import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { replayConversation } from './langchain-message-adapter.js';
import { resumedLog } from './fixtures.js';
import { fromLoggedMessage, readLoggedMessage, toLoggedMessage } from './logged-message.js';
import type { LoggedMessage } from './logged-message.js';

function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

const raw = (type: string, data: Record<string, unknown>): LoggedMessage =>
  ({ type, data }) as unknown as LoggedMessage;

const CORPUS: Readonly<Record<string, () => LoggedMessage>> = {
  帶工具呼叫的回覆: () =>
    toLoggedMessage(
      new AIMessage({ content: 'x', tool_calls: [{ id: 'c1', name: 't', args: { a: { b: 1 } } }] }),
    ),
  舊格式只有_additional_kwargs_tool_calls: () =>
    raw('ai', {
      content: '',
      additional_kwargs: {
        tool_calls: [{ id: 'c2', type: 'function', function: { name: 't', arguments: '{"a":1}' } }],
      },
    }),
  v1_內容陣列缺工具呼叫區塊: () =>
    raw('ai', {
      content: [{ type: 'text', text: 'hi' }],
      tool_calls: [{ id: 'c3', name: 't', args: {} }],
      response_metadata: { output_version: 'v1' },
    }),
  contentBlocks_陣列缺工具呼叫區塊: () =>
    raw('ai', {
      contentBlocks: [{ type: 'text', text: 'a' }],
      tool_calls: [{ id: 'c4', name: 't', args: {} }],
    }),
  帶_artifact_的工具結果: () =>
    toLoggedMessage(new ToolMessage({ content: 'r', tool_call_id: 'c1', artifact: { x: [1] } })),
  區塊陣列的使用者訊息: () =>
    toLoggedMessage(new HumanMessage({ content: [{ type: 'text', text: '看這個' }] })),
};

beforeEach(() => {
  // 舊格式那一則，LangChain 的建構子會印一行升級提醒。
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readLoggedMessage', () => {
  it.each(Object.keys(CORPUS))(
    '%s：凍過的輸入推得回來，跟深拷的那一支一樣，日誌那一份不動',
    (name) => {
      const logged = frozen(CORPUS[name]!());
      const before = JSON.stringify(logged);
      const read = readLoggedMessage(logged);
      const copied = fromLoggedMessage(logged);
      expect(read.toDict()).toEqual(copied.toDict());
      if (AIMessage.isInstance(copied)) {
        expect((read as AIMessage).tool_calls).toEqual(copied.tool_calls);
        expect(copied.tool_calls?.length).toBeGreaterThan(0);
      }
      expect(JSON.stringify(logged)).toBe(before);
    },
  );

  it('巢狀的值跟日誌共用，不拷', () => {
    const logged = frozen(CORPUS['帶工具呼叫的回覆']!());
    const data = logged.data as unknown as { tool_calls: { args: object }[] };
    const read = readLoggedMessage(logged) as AIMessage;
    expect(read.tool_calls![0]!.args).toBe(data.tool_calls[0]!.args);
    expect((fromLoggedMessage(logged) as AIMessage).tool_calls![0]!.args).not.toBe(
      data.tool_calls[0]!.args,
    );
    const human = frozen(CORPUS['區塊陣列的使用者訊息']!());
    expect((readLoggedMessage(human).content as unknown[])[0]).toBe(
      (human.data.content as unknown[])[0],
    );
  });
});

describe('replayConversation 的 readOnly', () => {
  it('推出來的跟預設一樣，訊息的巢狀值跟日誌共用', () => {
    const asking = toLoggedMessage(
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'c1', name: 't', args: { q: { deep: 1 } } }],
      }),
    );
    const { events } = resumedLog('t', [['assistant/message', { message: asking }]]);
    const plain = replayConversation(events);
    const readOnly = replayConversation(events, { readOnly: true });
    if (plain.kind !== 'replayed' || readOnly.kind !== 'replayed') throw new Error('推不回來');
    expect(readOnly.messages.map((message) => message.toDict())).toEqual(
      plain.messages.map((message) => message.toDict()),
    );
    const event = events[0]!;
    if (event.type !== 'assistant/message') throw new Error('第 0 顆不是 assistant/message');
    const loggedArgs = (event.data.message.data as unknown as { tool_calls: { args: object }[] })
      .tool_calls[0]!.args;
    expect((readOnly.messages[0] as AIMessage).tool_calls![0]!.args).toBe(loggedArgs);
    expect((plain.messages[0] as AIMessage).tool_calls![0]!.args).not.toBe(loggedArgs);
  });
});
