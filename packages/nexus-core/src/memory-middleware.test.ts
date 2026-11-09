/**
 * 記憶的內容每條 thread 一份：同一個組裝上兩條 thread 交錯呼叫，各接各的。
 * 端到端（真的讀檔、同一條 thread 中途改檔不重載）在 `apps/harness/src/memory.test.ts`。
 */

import { SystemMessage } from '@langchain/core/messages';
import type { AnyBackendProtocol } from 'deepagents';
import { describe, expect, it } from 'vitest';

import { createMemoryContents, createMemoryMiddleware } from './memory-middleware.js';

type Hook = (state: unknown, runtime: unknown) => Promise<unknown>;
type Wrap = (request: unknown, handler: (request: unknown) => unknown) => unknown;

/** 每次讀都回 `files` 裡現在的值。 */
function backendOf(files: Record<string, string>): AnyBackendProtocol {
  return {
    read: async (path: string) =>
      files[path] === undefined ? { error: 'file_not_found' } : { content: files[path] },
  } as unknown as AnyBackendProtocol;
}

const runtimeOf = (thread: string) => ({ configurable: { thread_id: thread } });

/** 這一次呼叫送出的系統訊息的最後一塊。 */
function lastBlock(middleware: unknown, thread: string): string {
  let sent: SystemMessage | undefined;
  (middleware as { wrapModelCall: Wrap }).wrapModelCall(
    { systemMessage: new SystemMessage('前面'), runtime: runtimeOf(thread) },
    (request) => {
      sent = (request as { systemMessage: SystemMessage }).systemMessage;
    },
  );
  const blocks = sent!.content as { type: string; text: string }[];
  expect(blocks[0]).toEqual({ type: 'text', text: '前面' });
  return blocks.at(-1)!.text;
}

describe('記憶的內容每條 thread 一份', () => {
  it('a 讀完、b 讀完，a 的下一次模型呼叫仍是 a 讀到的', async () => {
    const files = { '/AGENTS.md': '甲的記憶。' };
    const contents = createMemoryContents();
    const middleware = createMemoryMiddleware(
      { backend: backendOf(files), sources: ['/AGENTS.md'] },
      contents,
    );
    const beforeAgent = (middleware as unknown as { beforeAgent: Hook }).beforeAgent;

    await beforeAgent({}, runtimeOf('a'));
    files['/AGENTS.md'] = '乙的記憶。';
    await beforeAgent({}, runtimeOf('b'));

    expect(lastBlock(middleware, 'a')).toContain('甲的記憶。');
    expect(lastBlock(middleware, 'b')).toContain('乙的記憶。');
    expect(contents.of('a')).toEqual({ '/AGENTS.md': '甲的記憶。' });
  });

  it('state 裡已經有的就沿用，不再讀檔', async () => {
    const files = { '/AGENTS.md': '檔案裡的。' };
    const middleware = createMemoryMiddleware({
      backend: backendOf(files),
      sources: ['/AGENTS.md'],
    });
    const beforeAgent = (middleware as unknown as { beforeAgent: Hook }).beforeAgent;

    await beforeAgent({ memoryContents: { '/AGENTS.md': 'state 裡的。' } }, runtimeOf('a'));

    expect(lastBlock(middleware, 'a')).toContain('state 裡的。');
  });
});
