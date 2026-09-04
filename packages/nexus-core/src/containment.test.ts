/**
 * 圍堵自己的邏輯——直接餵它一個假的 `handler`，看它把什麼交回來。
 *
 * 這一份跟著實作從 `@nexus/plugin-validation` 搬過來
 * （[#159](https://github.com/DemianLi/nexus-agent/issues/159)）。**它掛在哪、順序排第幾**
 * 由 [`fold.test.ts`](./fold.test.ts) 釘；**掛進真的 agent 之後行為對不對**在
 * `apps/harness/src/validation.test.ts`，那一層才碰得到基座那條「工具拋錯就整場死」的路。
 */

import { ToolMessage } from '@langchain/core/messages';
import { GraphInterrupt } from '@langchain/langgraph';
import { describe, expect, it } from 'vitest';
import { createContainmentMiddleware } from './containment.js';

/** middleware 的 `wrapToolCall` 拿出來直接呼叫用的形狀。 */
type Wrapper = (
  request: unknown,
  handler: (request: unknown) => Promise<unknown>,
) => Promise<unknown>;

/** 從 middleware 上取出 `wrapToolCall`，沒有就當場失敗。 */
function wrapperOf(middleware: unknown): Wrapper {
  const wrap = (middleware as { wrapToolCall?: Wrapper }).wrapToolCall;
  if (wrap === undefined) throw new Error('這個 middleware 沒有 wrapToolCall');
  return wrap;
}

/** 一次工具呼叫的假請求。 */
function requestFor(toolName: string): unknown {
  return {
    toolCall: { name: toolName, args: {}, id: 'call-1' },
    tool: undefined,
    state: {},
    runtime: {},
  };
}

describe('圍堵', () => {
  const wrap = wrapperOf(createContainmentMiddleware());

  it('工具拋錯 → 一則 status error 的 ToolMessage，不再往外拋', async () => {
    const result = (await wrap(requestFor('probe'), () => {
      throw new Error('磁碟滿了');
    })) as ToolMessage;
    expect(ToolMessage.isInstance(result)).toBe(true);
    expect(result.status).toBe('error');
    expect(String(result.content)).toContain('probe');
    expect(String(result.content)).toContain('磁碟滿了');
    expect(result.tool_call_id).toBe('call-1');
  });

  it('訊息裡不帶堆疊、也不帶原始參數', async () => {
    const boom = new Error('炸了');
    boom.stack = 'Error: 炸了\n    at /Users/someone/secret/path.ts:1:1';
    const result = (await wrap(
      { toolCall: { name: 'probe', args: { key: 'sk-機密值' }, id: 'c' } },
      () => {
        throw boom;
      },
    )) as ToolMessage;
    expect(String(result.content)).not.toContain('/Users/someone/secret/path.ts');
    expect(String(result.content)).not.toContain('sk-機密值');
  });

  it('**中斷放行**——GraphBubbleUp 原樣往外拋', async () => {
    const interrupt = new GraphInterrupt([{ value: '要核准嗎', id: 'i1' }]);
    await expect(
      wrap(requestFor('probe'), () => {
        throw interrupt;
      }),
    ).rejects.toBe(interrupt);
  });

  it('沒出錯就原樣交回去', async () => {
    const message = new ToolMessage({ content: '好了', tool_call_id: 'call-1', name: 'probe' });
    expect(await wrap(requestFor('probe'), async () => message)).toBe(message);
  });

  it('**沒有 closure 狀態**——所以 root 與每個 subagent 共用同一份實例是安全的', async () => {
    // fold 只建一次就掛遍 root 與所有 subagent（見 `fold.ts`）。這一條擋的是「哪天有人
    // 往這裡加一個跨呼叫的累計器」——那會讓兩個 agent 的狀態悄悄混在一起。
    const shared = wrapperOf(createContainmentMiddleware());
    const first = (await shared(requestFor('a'), () => {
      throw new Error('第一個');
    })) as ToolMessage;
    const second = (await shared(requestFor('b'), () => {
      throw new Error('第二個');
    })) as ToolMessage;
    expect(String(first.content)).toContain('工具 a 執行失敗：第一個');
    expect(String(second.content)).toContain('工具 b 執行失敗：第二個');
  });
});
