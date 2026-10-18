import { describe, it, expect } from 'vitest';
import type { ContentBlock } from '@langchain/core/messages';
import { AIMessage } from '@langchain/core/messages';
import { fromLoggedMessage, loggedContentBlocks, toLoggedMessage } from './logged-message.js';
import { SessionLog } from './session-log.js';

describe('loggedContentBlocks', () => {
  it('把字串轉成一塊 text', () => {
    const blocks = loggedContentBlocks('hello');
    expect(blocks).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('空字串也是一塊', () => {
    const blocks = loggedContentBlocks('');
    expect(blocks).toEqual([{ type: 'text', text: '' }]);
  });

  it('區塊陣列原樣回傳', () => {
    const input: ContentBlock[] = [
      { type: 'text', text: '文字' },
      { type: 'reasoning', reasoning: '思考' } as unknown as ContentBlock,
    ];
    const blocks = loggedContentBlocks(input);
    expect(blocks).toEqual(input);
  });

  it('text + reasoning 陣列原樣', () => {
    const input: ContentBlock[] = [
      { type: 'text', text: '文字' },
      { type: 'reasoning', reasoning: '思考' } as unknown as ContentBlock,
      { type: 'text', text: '更多' },
    ];
    const blocks = loggedContentBlocks(input);
    expect(blocks).toEqual(input);
  });

  it('非字串非陣列回空陣列', () => {
    expect(loggedContentBlocks(null)).toEqual([]);
    expect(loggedContentBlocks(undefined)).toEqual([]);
    expect(loggedContentBlocks({})).toEqual([]);
    expect(loggedContentBlocks(123)).toEqual([]);
  });
});

describe('LoggedMessage 的型別', () => {
  /**
   * 型別絆索：`data.content` 是 `string | ContentBlock[]`，不是 LangChain d.ts 講的 `string`。
   * 還原成 `StoredMessage` 時，下面那行不再是錯誤，`@ts-expect-error` 變成「未使用」而讓 typecheck 轉紅。
   */
  it('data.content 直接 .trim() 編不過', () => {
    const message = toLoggedMessage(new AIMessage('x'));
    // @ts-expect-error 陣列沒有 trim；讀方要走 loggedContentBlocks。
    const attempt = () => message.data.content.trim();
    expect(typeof attempt).toBe('function');
  });
});

/**
 * 物件與陣列交錯的巢狀（#1526）。深度取 3000：`structuredClone` 在 CI（Node 22.23.3 Linux x64）約 1500–2100 層就
 * `RangeError`；Node 22 的原生 `JSON.stringify` 連沒凍過的也是遞迴的，CI 上約 4100 層就拋，再深連改寫後也過不了。
 */
function deepMixed(depth: number): unknown {
  let value: unknown = 'leaf';
  for (let level = 0; level < depth; level++) value = level % 2 ? { next: value } : [value];
  return value;
}

describe('fromLoggedMessage 推得回深巢狀的那一則（#1526）', () => {
  it('日誌裡凍過的、工具參數 3000 層交錯巢狀的 AI 訊息：推得回來，參數原樣、拿到的是可改的副本', () => {
    const args = { v: deepMixed(3_000) };
    // 照續接時的來路造：日誌形狀的訊息是從磁碟讀回來的，不經過 `toLoggedMessage`（LangChain 的 `toDict` 本身是遞迴的）。
    const shallow = new AIMessage({
      id: 'm1',
      content: '',
      tool_calls: [{ id: 'c1', name: 't', args: {} }],
    });
    const logged = toLoggedMessage(shallow);
    // `StoredMessageData` 的型別沒有列 `tool_calls`，實際落盤的 AI 訊息有。
    const data = logged.data as typeof logged.data & { readonly tool_calls: readonly object[] };
    const message = { ...logged, data: { ...data, tool_calls: [{ ...data.tool_calls[0], args }] } };
    const event = new SessionLog('t').append('assistant/message', { message });
    const back = fromLoggedMessage(event.data.message) as AIMessage;
    const backArgs = back.tool_calls?.[0]?.args as Record<string, unknown>;
    // 比對用 JSON.stringify：vitest 的 toEqual 是遞迴的。
    expect(JSON.stringify(backArgs)).toBe(JSON.stringify(args));
    expect(Object.isFrozen(backArgs)).toBe(false);
  });
});
