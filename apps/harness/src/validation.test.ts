/**
 * 工具失敗回饋的**行為**驗收——掛進真的 agent 之後。
 *
 * 這一份存在的理由是一件動工前才驗出來的事：**基座那側任何一個工具拋錯，整場 run
 * 直接死。** 不是「錯誤訊息不好看」，是 `invoke()` reject、沒有 ToolMessage、模型不知道
 * 發生過什麼。成因、以及那條基座行為自己的絆索，在
 * [`baseline.test.ts`](./baseline.test.ts)——**這裡不再有那個對照組，因為我們的組裝已經
 * 造不出它了**：圍堵由 `foldRegistry` 打底進 root 與每個 subagent
 * （[#159](https://github.com/DemianLi/nexus-agent/issues/159)），沒有一份清單關得掉它。
 *
 * **所以這個檔案裡的組裝刻意不掛 `createValidationPlugin()`**（除了輸出 schema 那一組，
 * 那才是它今天的全部內容）。這一點是承重的：一條「掛了 plugin 然後觀察到圍堵」的測試
 * 在搬家**之前**的樹上就會過，證不到任何東西。
 *
 * 第二組是與 [#71](https://github.com/DemianLi/nexus-agent/pull/71) 的交界：圍堵是
 * `try/catch`，而 LangGraph 的中斷也是拋例外走的。不分辨的話核准點會**無聲消失**，
 * 那正好是 #71 花一整張 PR 釘住的東西。搬家之後圍堵第一次包住 root 與**每個 subagent**
 * 的核准路徑，所以那條命脈在新位置重量一次（另見
 * [`interrupt.test.ts`](./interrupt.test.ts)，那份本來就不掛這個 plugin）。
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
import type { ScriptedTurn } from './scripted-model.js';

/** 這一輪真的被呼叫到的工具名。 */
let ran: string[] = [];

beforeEach(() => {
  ran = [];
});

/**
 * 一個會拋錯的工具，外加（選加地）一個 subagent。
 *
 * @param withSubagent - 要不要順便註冊一個 `worker`，讓錯發生在 subagent 裡。
 * @returns 可以放進組裝清單的 plugin。
 */
function boomPlugin(withSubagent = false): NexusPlugin {
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
      if (withSubagent) registry.subagents.register({ name: 'worker', description: '幹活的。' });
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
  /**
   * **這一條是整張卡的驗收句，而且它是一條翻過面的絆索。**
   *
   * 同一格以前釘的是「沒掛 plugin ＝ 整場 run 死掉」。圍堵搬進 fold 打底之後
   * （[#159](https://github.com/DemianLi/nexus-agent/issues/159)），同一個組裝要跑得完。
   *
   * **零 plugin 是重點不是省事**：這是唯一一格「掛 plugin 修不好」的——它在搬家之前
   * 的樹上一定紅。基座那半邊的絆索在 [`baseline.test.ts`](./baseline.test.ts)。
   */
  it('**零 plugin 的裸組裝：拋錯變成一則 error ToolMessage，那一輪繼續走完**', async () => {
    const { agent } = await createNexusAgent({
      model: scripted('boom'),
      plugins: [boomPlugin()],
    });
    const result = await agent.invoke(toAgentInvocation('動手'));
    // 工具真的跑到了才有東西可接——不然這條會被「模型根本沒呼叫它」滿足。
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

  /**
   * **第二個掛點的驗收句。** 圍堵以前是 plugin middleware，而那些**一個都射不進
   * subagent**（`SubAgentBase.middleware` 是「append after default_middleware」），
   * 所以只補 `foldMiddleware` 那一注就是漏掉半棵樹。
   *
   * 判準刻意不是「run 沒 reject」——那在 subagent 沒拿到圍堵時也可能只是別的原因。
   * 這裡讀 `task` 交回來的那則 ToolMessage：裡面有 subagent **拿到回饋之後**講的那句話，
   * 代表它那一輪真的繼續走完了。
   */
  it('**錯發生在 subagent 裡也一樣**——第二個掛點', async () => {
    const turns: ScriptedTurn[] = [
      {
        content: '委派。',
        toolCalls: [{ name: 'task', args: { description: '幹活', subagent_type: 'worker' } }],
      },
      { content: '子代理動手。', toolCalls: [{ name: 'boom', args: {} }] },
      { content: '子代理收工。' },
      { content: '根收工。' },
      { content: '根再收一次。' },
    ];
    const { agent, dispose } = await createNexusAgent({
      model: new ScriptedChatModel({ turns }),
      checkpointer: new MemorySaver(),
      plugins: [boomPlugin(true)],
    });

    try {
      const result = await agent.invoke(toAgentInvocation('動手'), {
        configurable: { thread_id: 'boom-in-subagent' },
      });
      expect(ran).toEqual(['boom']);
      const fromTask = toolMessages(result.messages as BaseMessage[]).at(-1);
      expect(fromTask?.text).toContain('子代理收工。');
    } finally {
      await dispose();
    }
  });

  it('內層 middleware 自己的 bug 也接得住，**而且不靠載入順序**', async () => {
    const { agent } = await createNexusAgent({
      model: scripted('report'),
      // **壞掉的那個刻意排在最前。** 只靠「註冊得晚」的話這條會過得莫名其妙——真正把
      // 圍堵推到最外的是 fold 把它放在整份陣列的第 0 格，連 `prepend` 的都在它裡面。
      plugins: [brokenMiddlewarePlugin(), reportPlugin('好了')],
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
      // **不掛 plugin。** 這一條以前是掛著測的，那驗的是舊排法；圍堵現在在 fold 的
      // 第 0 格，這裡要驗的就是那一格上的 `isGraphBubbleUp` 還讓中斷穿得過去。
      plugins: [askPlugin()],
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
