/**
 * 「stop 但什麼都沒有」的判準（[#1437](https://github.com/DemianLi/nexus-agent/issues/1437)）。
 *
 * 判準的方向是**不誤傷**：全部成立才算空——`finish_reason` 明確是 `stop`、沒有文字、沒有工具呼叫、沒有推理。
 * 端到端（回報進 `llm/retry`、`turn/failed.error.code`）在 `apps/harness/src/empty-response.test.ts`。
 */

import { AIMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import {
  createEmptyResponseMiddleware,
  EMPTY_RESPONSE_CODE,
  EmptyResponseError,
  isEmptyStopReply,
} from './empty-response.js';
import { retryModelCall } from './stream-retry.js';

const stop = { finish_reason: 'stop' };

describe('isEmptyStopReply', () => {
  it('stop、沒有任何東西：空', () => {
    expect(isEmptyStopReply(new AIMessage({ content: '', response_metadata: stop }))).toBe(true);
    expect(isEmptyStopReply(new AIMessage({ content: [], response_metadata: stop }))).toBe(true);
    expect(
      isEmptyStopReply(
        new AIMessage({ content: [{ type: 'text', text: '' }], response_metadata: stop }),
      ),
    ).toBe(true);
  });

  it('沒有 finish_reason、或不是 stop：不碰（假模型、length、tool_calls 都不是這一顆的事）', () => {
    expect(isEmptyStopReply(new AIMessage({ content: '' }))).toBe(false);
    expect(
      isEmptyStopReply(
        new AIMessage({ content: '', response_metadata: { finish_reason: 'length' } }),
      ),
    ).toBe(false);
    expect(
      isEmptyStopReply(
        new AIMessage({ content: '', response_metadata: { finish_reason: 'tool_calls' } }),
      ),
    ).toBe(false);
  });

  it('有字（含只有空白）就不是空：數的是內容，不是 trim 之後的字數（同 dsh 數區塊）', () => {
    expect(isEmptyStopReply(new AIMessage({ content: '好', response_metadata: stop }))).toBe(false);
    expect(isEmptyStopReply(new AIMessage({ content: '\n', response_metadata: stop }))).toBe(false);
    expect(
      isEmptyStopReply(
        new AIMessage({ content: [{ type: 'text', text: '好' }], response_metadata: stop }),
      ),
    ).toBe(false);
  });

  it('只有推理：不算空（這一版不處理，見檔頭）', () => {
    expect(
      isEmptyStopReply(
        new AIMessage({
          content: '',
          additional_kwargs: { reasoning_content: '想了很久' },
          response_metadata: stop,
        }),
      ),
    ).toBe(false);
    expect(
      isEmptyStopReply(
        new AIMessage({
          content: [{ type: 'reasoning', reasoning: '想了很久' }],
          response_metadata: stop,
        }),
      ),
    ).toBe(false);
  });

  it('有工具呼叫（含解不開的）：不算空，哪怕 finish_reason 被對映成 stop', () => {
    expect(
      isEmptyStopReply(
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'c1', name: 'ls', args: {} }],
          response_metadata: stop,
        }),
      ),
    ).toBe(false);
    expect(
      isEmptyStopReply(
        new AIMessage({
          content: '',
          invalid_tool_calls: [{ id: 'c1', name: 'ls', args: '{', error: 'bad' }],
          response_metadata: stop,
        }),
      ),
    ).toBe(false);
  });
});

describe('createEmptyResponseMiddleware', () => {
  const middleware = createEmptyResponseMiddleware() as unknown as {
    wrapModelCall: (request: unknown, handler: () => Promise<unknown>) => Promise<unknown>;
  };

  it('空回覆：拋 EmptyResponseError，並向重試那一層回報 EMPTY_RESPONSE（碼在預設清單裡，重打）', async () => {
    let calls = 0;
    const result = await retryModelCall({ maxRetries: 2, initialDelayMs: 1 }, {}, () =>
      middleware.wrapModelCall({}, async () => {
        calls += 1;
        return calls < 2
          ? new AIMessage({ content: '', response_metadata: stop })
          : new AIMessage({ content: '好', response_metadata: stop });
      }),
    );
    expect(calls).toBe(2);
    expect((result as AIMessage).text).toBe('好');
  });

  it('一直空：預算用盡後拋的是 EmptyResponseError（名字與碼都在）', async () => {
    await expect(
      retryModelCall({ maxRetries: 1, initialDelayMs: 1 }, {}, () =>
        middleware.wrapModelCall(
          {},
          async () => new AIMessage({ content: '', response_metadata: stop }),
        ),
      ),
    ).rejects.toMatchObject({ name: 'EmptyResponseError', code: EMPTY_RESPONSE_CODE });
    expect(new EmptyResponseError().name).toBe('EmptyResponseError');
  });

  it('正常回覆原樣放行', async () => {
    const reply = new AIMessage({ content: '好', response_metadata: stop });
    await expect(middleware.wrapModelCall({}, async () => reply)).resolves.toBe(reply);
  });
});
