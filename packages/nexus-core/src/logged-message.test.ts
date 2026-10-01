import { describe, it, expect } from 'vitest';
import type { ContentBlock } from '@langchain/core/messages';
import { AIMessage } from '@langchain/core/messages';
import { loggedContentBlocks, toLoggedMessage } from './logged-message.js';

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
