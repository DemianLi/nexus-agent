import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';

import {
  assumedFileLine,
  hasAttachmentBlocks,
  rewriteAttachmentBlocks,
  summaryImageText,
  textOnlyImageText,
  unavailableImageText,
} from './attachment-projection.js';
import { fileHandleText, fileModelPath, isFileBlock } from './attachment-ref.js';

const FILE = { attachmentId: `sha256:${'a'.repeat(64)}`, name: 'a b.txt', bytes: 5 };
const IMAGE = {
  attachmentId: `sha256:${'c'.repeat(64)}`,
  mediaType: 'image/png' as const,
  bytes: 70,
  width: 4,
  height: 3,
};

describe('附件區塊投影', () => {
  it('沒有附件區塊：回原陣列（同一個物件），字串內容與一般區塊不算附件', async () => {
    const messages = [
      new HumanMessage('嗨'),
      new AIMessage('好'),
      new HumanMessage({ content: [{ type: 'text', text: 'x' }] }),
    ];
    expect(messages.some(hasAttachmentBlocks)).toBe(false);
    expect(await rewriteAttachmentBlocks(messages, () => ({ type: 'text', text: '?' }))).toBe(
      messages,
    );
  });

  it('只換附件區塊：順序、文字區塊、id、名字、additional_kwargs 都帶過去；原訊息不動；沒附件的那幾則同一個物件', async () => {
    const plain = new HumanMessage('前面');
    const withAttachments = new HumanMessage({
      id: 'h1',
      name: 'u',
      content: [
        { type: 'nexus-file', attachment: FILE },
        { type: 'nexus-image', attachment: IMAGE },
        { type: 'text', text: '請看' },
      ] as never,
      additional_kwargs: { k: 1 },
    });
    const out = await rewriteAttachmentBlocks([plain, withAttachments], (block) =>
      isFileBlock(block)
        ? { type: 'text', text: 'FILE' }
        : { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    );
    expect(out[0]).toBe(plain);
    expect(out[1]).not.toBe(withAttachments);
    expect(out[1]!.content).toEqual([
      { type: 'text', text: 'FILE' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      { type: 'text', text: '請看' },
    ]);
    expect(out[1]).toMatchObject({ id: 'h1', name: 'u', additional_kwargs: { k: 1 } });
    // 原訊息還是參照。
    expect((withAttachments.content as { type: string }[])[0]!.type).toBe('nexus-file');
  });

  it('非同步的 rewrite 照順序等', async () => {
    const message = new HumanMessage({
      content: [
        { type: 'nexus-file', attachment: FILE },
        { type: 'nexus-file', attachment: { ...FILE, name: 'b.txt' } },
      ] as never,
    });
    const order: string[] = [];
    const out = await rewriteAttachmentBlocks([message], async (block) => {
      const name = (block.attachment as { name: string }).name;
      await new Promise((resolve) => setTimeout(resolve, name === 'a b.txt' ? 10 : 0));
      order.push(name);
      return { type: 'text', text: name };
    });
    expect(order).toEqual(['a b.txt', 'b.txt']);
    expect(out[0]!.content).toEqual([
      { type: 'text', text: 'a b.txt' },
      { type: 'text', text: 'b.txt' },
    ]);
  });

  it('固定的佔位字：假設讀得到的檔案行與 fileHandleText 相同；圖只露雜湊前八碼', () => {
    expect(assumedFileLine(FILE)).toBe(fileHandleText(FILE, fileModelPath(FILE)));
    expect(textOnlyImageText(IMAGE)).toBe(
      '[image omitted because this model accepts text only; attachment sha256:cccccccc]',
    );
    expect(unavailableImageText({ ...IMAGE, name: 'x.png' })).toContain(
      '"x.png" (sha256:cccccccc)',
    );
    expect(summaryImageText(IMAGE)).toContain('(sha256:cccccccc, 4x3)');
  });
});
