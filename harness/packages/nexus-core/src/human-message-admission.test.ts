/**
 * 人話拒收的量法對著真的基座比（[#2415](https://github.com/DemianLi/nexus-agent/issues/2415)）：同一則人話交給基座
 * `FilesystemMiddleware` 的 `beforeAgent`，拒不拒收與基座搬不搬一致；基座寫進 backend 的那段字就是
 * {@link humanMessageText}。升級基座時門檻或量法變了就紅在這裡。
 */

import { HumanMessage } from '@langchain/core/messages';
import type { MessageContent } from '@langchain/core/messages';
import { createFilesystemMiddleware } from 'deepagents';
import { describe, expect, it } from 'vitest';

import {
  HUMAN_MESSAGE_LIMIT_CHARS,
  humanMessageRejection,
  humanMessageText,
} from './human-message-admission.js';

/** 交給基座的 `beforeAgent`，回它寫進 backend 的那段字；沒搬就是 `undefined`。 */
async function evictedByBase(content: MessageContent): Promise<string | undefined> {
  const written: string[] = [];
  const backend = {
    ls: async () => [],
    read: async () => '',
    readRaw: async () => ({ content: [], created_at: '', modified_at: '' }),
    glob: async () => [],
    grep: async () => [],
    edit: async () => ({}),
    write: async (_path: string, text: string) => {
      written.push(text);
      return { filesUpdate: null };
    },
  };
  const base = createFilesystemMiddleware({ backend: backend as never });
  const beforeAgent = base.beforeAgent as unknown as (state: object) => Promise<unknown>;
  await beforeAgent({ messages: [new HumanMessage({ content: content as never })] });
  return written[0];
}

const limit = HUMAN_MESSAGE_LIMIT_CHARS;
const half = limit / 2;

const cases: Record<string, MessageContent> = {
  剛好等於上限: 'a'.repeat(limit),
  多一個字: 'a'.repeat(limit + 1),
  '兩個文字區塊，接起來的換行讓它過線': [
    { type: 'text', text: 'b'.repeat(half) },
    { type: 'text', text: 'c'.repeat(half) },
  ],
  附件的參照區塊不算字: [
    { type: 'nexus-file', id: 'x'.repeat(limit), name: 'f.txt' } as never,
    { type: 'text', text: 'd'.repeat(limit) },
  ],
  點名與情境的文字區塊算字: [
    { type: 'text', text: 'e'.repeat(limit - 10) },
    { type: 'text', text: 'mention-hint' },
  ],
};

describe('humanMessageRejection 對著基座的 beforeAgent', () => {
  for (const [title, content] of Object.entries(cases)) {
    it(title, async () => {
      const evicted = await evictedByBase(content);
      expect(humanMessageRejection(content) !== undefined).toBe(evicted !== undefined);
      if (evicted !== undefined) expect(humanMessageText(content)).toBe(evicted);
    });
  }

  it('有拒收的案例真的拒收：比對不是兩邊都收', () => {
    expect(humanMessageRejection(cases['多一個字']!)).toBe(
      'message-too-large: 這則訊息有 200,001 字，超過上限 200,000 字',
    );
    expect(humanMessageRejection(cases['剛好等於上限']!)).toBeUndefined();
    expect(humanMessageRejection(cases['兩個文字區塊，接起來的換行讓它過線']!)).toBeDefined();
    expect(humanMessageRejection(cases['附件的參照區塊不算字']!)).toBeUndefined();
    expect(humanMessageRejection(cases['點名與情境的文字區塊算字']!)).toBeDefined();
  });
});
