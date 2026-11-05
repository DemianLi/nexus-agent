/**
 * 洋蔥的接縫（`onion.ts` 的 `handledOutsideOnion`，#2416）：標了的格 native 不再經洋蔥驅動，沒標的照跑。這裡用一顆五格都有的 middleware 跑一整輪「叫工具 → 回答」，數每一格被叫了幾次。
 */

import type { BaseMessage } from '@langchain/core/messages';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { createMiddleware } from 'langchain';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNativeAgent } from './agent.js';
import { handledOutsideOnion, type LoopMiddleware, type NativeHandledPart } from './onion.js';

/** 第一次叫 `echo`，第二次回答；`bound` 記下每次綁上的工具名。 */
function scriptedModel(bound: string[][]) {
  const replies = [
    new AIMessage({
      content: '',
      tool_calls: [{ id: 'call-1', name: 'echo', args: { text: '嗨' } }],
    }),
    new AIMessage('好了'),
  ];
  return {
    bindTools(tools: readonly { name: string }[]) {
      bound.push(tools.map((t) => t.name));
      return {
        invoke: async (_messages: BaseMessage[]) => {
          const next = replies.shift();
          if (next === undefined) throw new Error('模型多叫了一次');
          return next;
        },
      };
    },
  };
}

const echo = tool(async ({ text }: { text: string }) => `回聲：${text}`, {
  name: 'echo',
  description: '原樣回',
  schema: z.object({ text: z.string() }),
});

const extra = tool(async () => '多的', {
  name: 'extra',
  description: 'middleware 帶的工具',
  schema: z.object({}),
});

/** 五格都有、每格被叫就記一筆的 middleware，另帶一顆工具。 */
function recording(calls: string[]) {
  return createMiddleware({
    name: 'recording',
    tools: [extra],
    beforeAgent: () => {
      calls.push('beforeAgent');
    },
    beforeModel: () => {
      calls.push('beforeModel');
    },
    wrapModelCall: async (request, handler) => {
      calls.push('wrapModelCall');
      return handler(request);
    },
    wrapToolCall: async (request, handler) => {
      calls.push('wrapToolCall');
      return handler(request);
    },
    afterAgent: () => {
      calls.push('afterAgent');
    },
  }) as unknown as LoopMiddleware;
}

async function run(middleware: LoopMiddleware) {
  const bound: string[][] = [];
  const agent = createNativeAgent({
    model: scriptedModel(bound),
    tools: [echo],
    middleware: [middleware],
  });
  const state = await agent.invoke(
    { messages: [new HumanMessage('叫一下 echo')] },
    { configurable: { thread_id: 't' } },
  );
  return { agent, bound, messages: state.messages as BaseMessage[] };
}

/** 沒標時一整輪的呼叫序列：模型叫兩次、工具一次。 */
const ALL = [
  'beforeAgent',
  'beforeModel',
  'wrapModelCall',
  'wrapToolCall',
  'beforeModel',
  'wrapModelCall',
  'afterAgent',
];

describe('handledOutsideOnion：標了的格 native 不再經洋蔥驅動', () => {
  it('沒標：五格照 langchain 的節點順序全跑，middleware 帶的工具也綁上', async () => {
    const calls: string[] = [];
    const { bound, messages } = await run(recording(calls));
    expect(calls).toEqual(ALL);
    expect(bound).toEqual([
      ['echo', 'extra'],
      ['echo', 'extra'],
    ]);
    expect(messages.at(-1)?.text).toBe('好了');
  });

  it.each(['beforeAgent', 'beforeModel', 'wrapModelCall', 'wrapToolCall', 'afterAgent'] as const)(
    '標 %s：只有那一格不跑，其餘照跑，工具照樣執行',
    async (part) => {
      const calls: string[] = [];
      const { messages } = await run(handledOutsideOnion(recording(calls), [part]));
      expect(calls).toEqual(ALL.filter((name) => name !== part));
      const result = messages.find((m): m is ToolMessage => ToolMessage.isInstance(m));
      expect(result?.content).toBe('回聲：嗨');
    },
  );

  it('標 tools：middleware 帶的工具不綁上，其餘五格照跑', async () => {
    const calls: string[] = [];
    const { bound } = await run(handledOutsideOnion(recording(calls), ['tools']));
    expect(calls).toEqual(ALL);
    expect(bound).toEqual([['echo'], ['echo']]);
  });

  it('agent.middleware 仍是原物件：名字、順序與身分不變', async () => {
    const middleware = handledOutsideOnion(recording([]), ['wrapToolCall', 'afterAgent']);
    const { agent } = await run(middleware);
    expect(agent.middleware).toEqual([middleware]);
    expect(agent.middleware[0]).toBe(middleware);
    expect(middleware.wrapToolCall).toBeTypeOf('function');
  });

  it('分兩次標：兩次的格都不跑', async () => {
    const calls: string[] = [];
    const middleware = handledOutsideOnion(recording(calls), ['wrapToolCall']);
    handledOutsideOnion(middleware, ['beforeModel']);
    await run(middleware);
    expect(calls).toEqual(['beforeAgent', 'wrapModelCall', 'wrapModelCall', 'afterAgent']);
  });

  it('wrapModelCall 新加的工具：wrapToolCall 標成洋蔥外面做照樣收，執行它的人仍算在', async () => {
    const added = tool(async () => '加的', {
      name: 'added',
      description: '模型呼叫時才加的工具',
      schema: z.object({}),
    });
    const middleware = createMiddleware({
      name: 'adds',
      wrapModelCall: async (request, handler) =>
        handler({ ...request, tools: [...request.tools, added] }),
      wrapToolCall: async (request, handler) => handler(request),
    }) as unknown as LoopMiddleware;
    const { bound } = await run(handledOutsideOnion(middleware, ['wrapToolCall']));
    expect(bound[0]).toEqual(['echo', 'added']);
  });

  it('沒有誰執行新加的工具：照 langchain 拒收', async () => {
    const added = tool(async () => '加的', {
      name: 'added',
      description: '模型呼叫時才加的工具',
      schema: z.object({}),
    });
    const middleware = createMiddleware({
      name: 'adds',
      wrapModelCall: async (request, handler) =>
        handler({ ...request, tools: [...request.tools, added] }),
    }) as unknown as LoopMiddleware;
    await expect(run(middleware)).rejects.toThrow(
      'You have added a new tool in "wrapModelCall" hook of middleware "adds": added.',
    );
  });

  it('標了這顆沒有的格：當場拋，不會靜靜沒作用', () => {
    const middleware = createMiddleware({
      name: 'only-model',
      wrapModelCall: async (request, handler) => handler(request),
    }) as unknown as LoopMiddleware;
    const parts: NativeHandledPart[] = ['wrapModelCall', 'wrapToolCall', 'tools'];
    expect(() => handledOutsideOnion(middleware, parts)).toThrow(
      'middleware "only-model" 沒有 wrapToolCall、tools，不能標成由洋蔥外面做',
    );
  });
});
