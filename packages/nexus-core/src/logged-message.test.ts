import { describe, it, expect } from 'vitest';
import type { ContentBlock } from '@langchain/core/messages';
import { loggedContentBlocks } from './logged-message.js';

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
