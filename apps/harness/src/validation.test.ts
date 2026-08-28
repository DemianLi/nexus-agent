/**
 * 工具失敗回饋的**行為**驗收——掛進真的 agent 之後。
 *
 * 這一份存在的理由是一件動工前才驗出來的事：**nexus-agent 裡任何一個工具拋錯，
 * 整場 run 直接死。** 不是「錯誤訊息不好看」，是 `invoke()` reject、沒有 ToolMessage、
 * 模型不知道發生過什麼。原因是兩件事湊在一起——
 *
 * - `ToolNode.runTool` 只要 `this.wrapToolCall` 存在，就把工具自己拋的錯當成
 *   middleware 的錯（`langchain@1.5.10`，`dist/agents/nodes/ToolNode.js:275-282`），
 *   而 `#handleError:150` 對 middleware 的錯是 `handleToolErrors !== true` 即重拋；
 *   `ReactAgent` 建 `ToolNode` 時從不傳 `handleToolErrors`（`:174-179`），那條路設不回去。
 * - `createDeepAgent` 永遠掛 `FilesystemMiddleware`，而它永遠帶 `wrapToolCall`
 *   （`deepagents@1.13.1`）。
 *
 * 所以第一組的**對照組不是裝飾**：沒掛 plugin 那一條紅了（變成不拋），代表基座改了
 * 主意、這個 plugin 的存在理由就沒了；主張那一條紅了才是我們寫壞了。
 *
 * 第二組是與 [#71](https://github.com/DemianLi/nexus-agent/pull/71) 的交界：圍堵是
 * `try/catch`，而 LangGraph 的中斷也是拋例外走的。不分辨的話核准點會**無聲消失**，
 * 那正好是 #71 花一整張 PR 釘住的東西。
 */

import { tool } from '@langchain/core/tools';
import type { BaseMessage } from '@langchain/core/messages';
import { Command, MemorySaver, interrupt } from '@langchain/langgraph';
import { createMiddleware } from 'langchain';
import type { NexusPlugin } from '@nexus/core';
import { createValidationPlugin } from '@nexus/plugin-validation';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createNexusAgent } from './agent-factory.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';

/** 這一輪真的被呼叫到的工具名。 */
let ran: string[] = [];

beforeEach(() => {
  ran = [];
});

/** 一個會拋錯的工具。 */
function boomPlugin(): NexusPlugin {
  return {
    name: 'boom',
    apply(registry) {
      registry.tools.register(
        tool(
          () => {
            ran.push('boom');
            throw new Error('磁碟滿了');
          },
          { name: 'boom', description: '會炸的工具', schema: z.object({}) },
        ),
      );
    },
  };
}

/** 一個回傳固定字串的工具。 */
function reportPlugin(payload: string): NexusPlugin {
  return {
    name: 'report',
    apply(registry) {
      registry.tools.register(
        tool(() => payload, {
          name: 'report',
          description: '回一份報告',
          schema: z.object({}),
        }),
      );
    },
  };
}

/** 一個自己就會炸掉的 plugin middleware——用來驗圍堵接不接得到內層。 */
function brokenMiddlewarePlugin(): NexusPlugin {
  return {
    name: 'broken',
    apply(registry) {
      registry.middleware.use(
        createMiddleware({
          name: 'brokenMiddleware',
          wrapToolCall: async (request, handler) => {
            await handler(request);
            throw new TypeError('這個 middleware 自己有 bug');
          },
        }) as never,
      );
    },
  };
}

/** 一個會問人的工具。 */
function askPlugin(): NexusPlugin {
  return {
    name: 'ask',
    apply(registry) {
      registry.tools.register(
        tool(
          () => {
            const answer = interrupt({ question: '要繼續嗎' });
            ran.push('ask');
            return `使用者說：${String(answer)}`;
          },
          { name: 'ask', description: '問一句', schema: z.object({}) },
        ),
      );
    },
  };
}

/** 假模型：先呼叫指定工具，之後每輪只講話。 */
function scripted(toolName: string): ScriptedChatModel {
  return new ScriptedChatModel({
    turns: [
      { content: '動手。', toolCalls: [{ name: toolName, args: {} }] },
      { content: '收工。' },
      { content: '再收一次工。' },
    ],
  });
}

/** 這一輪產生的 ToolMessage。 */
function toolMessages(messages: readonly BaseMessage[]) {
  return messages.filter((message) => message.getType() === 'tool') as (BaseMessage & {
    status?: string;
  })[];
}

describe('工具拋錯', () => {
  it('**沒掛 plugin：整場 run 死掉**（這是基座現況的絆索，不是我們的行為）', async () => {
    const { agent } = await createNexusAgent({
      model: scripted('boom'),
      plugins: [boomPlugin()],
    });
    await expect(agent.invoke(toAgentInvocation('動手'))).rejects.toThrow('磁碟滿了');
    // 工具真的跑到了才拋——不然這條會被「模型根本沒呼叫它」滿足。
    expect(ran).toEqual(['boom']);
  });

  it('掛上 plugin：變成一則 error ToolMessage，那一輪繼續走完', async () => {
    const { agent } = await createNexusAgent({
      model: scripted('boom'),
      plugins: [createValidationPlugin(), boomPlugin()],
    });
    const result = await agent.invoke(toAgentInvocation('動手'));
    expect(ran).toEqual(['boom']);

    const failures = toolMessages(result.messages as BaseMessage[]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.status).toBe('error');
    expect(failures[0]?.text).toContain('磁碟滿了');
    // 那一輪沒中止——模型拿到回饋之後真的又講了一次話。
    const last = (result.messages as BaseMessage[]).at(-1);
    expect(last?.getType()).toBe('ai');
    expect(last?.text).toBe('收工。');
  });

  it('內層 plugin middleware 自己的 bug 也接得住，**而且不靠載入順序**', async () => {
    const { agent } = await createNexusAgent({
      model: scripted('report'),
      // **壞掉的那個刻意排在前面。** 只靠「註冊得早」的話這條會過得莫名其妙——
      // 真正把圍堵推到最外的是 `prepend`，拿掉它這條就紅。
      plugins: [brokenMiddlewarePlugin(), reportPlugin('好了'), createValidationPlugin()],
    });
    const result = await agent.invoke(toAgentInvocation('動手'));
    const failures = toolMessages(result.messages as BaseMessage[]);
    expect(failures[0]?.status).toBe('error');
    expect(failures[0]?.text).toContain('這個 middleware 自己有 bug');
  });
});

describe('圍堵與核准的交界', () => {
  it('**中斷不會被吃掉**——停得下來，也接得回去', async () => {
    const { agent } = await createNexusAgent({
      model: scripted('ask'),
      checkpointer: new MemorySaver(),
      plugins: [createValidationPlugin(), askPlugin()],
    });
    const config = { configurable: { thread_id: 'ask-1' } };

    const paused = await agent.invoke(toAgentInvocation('動手'), config);
    expect(paused.__interrupt__).toBeDefined();
    expect(ran).toEqual([]);

    const after = await agent.invoke(new Command({ resume: '好' }) as never, config);
    expect(ran).toEqual(['ask']);
    const results = toolMessages(after.messages as BaseMessage[]);
    expect(results[0]?.status).toBe('success');
    expect(results[0]?.text).toContain('使用者說：好');
  });
});

describe('輸出 schema', () => {
  const schemas = { report: z.object({ total: z.number() }) };

  it('不合宣告的形狀 → 帶原因的 error ToolMessage，原輸出不跟著出去', async () => {
    const { agent } = await createNexusAgent({
      model: scripted('report'),
      plugins: [createValidationPlugin({ schemas }), reportPlugin('{"total":"一百"}')],
    });
    const result = await agent.invoke(toAgentInvocation('動手'));
    const results = toolMessages(result.messages as BaseMessage[]);
    expect(results[0]?.status).toBe('error');
    expect(results[0]?.text).toContain('total');
    expect(results[0]?.text).not.toContain('一百');
  });

  it('合的原樣送到模型面前（上一條的對照組）', async () => {
    const { agent } = await createNexusAgent({
      model: scripted('report'),
      plugins: [createValidationPlugin({ schemas }), reportPlugin('{"total":100}')],
    });
    const result = await agent.invoke(toAgentInvocation('動手'));
    const results = toolMessages(result.messages as BaseMessage[]);
    expect(results[0]?.status).toBe('success');
    expect(results[0]?.text).toBe('{"total":100}');
  });

  it('沒宣告 schema 的工具不受影響', async () => {
    const { agent } = await createNexusAgent({
      model: scripted('report'),
      plugins: [
        createValidationPlugin({ schemas: { other: z.object({ x: z.number() }) } }),
        reportPlugin('隨便什麼都行'),
      ],
    });
    const result = await agent.invoke(toAgentInvocation('動手'));
    const results = toolMessages(result.messages as BaseMessage[]);
    expect(results[0]?.status).toBe('success');
    expect(results[0]?.text).toBe('隨便什麼都行');
  });
});
