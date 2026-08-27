/**
 * 核准層的**行為**驗收。
 *
 * `interrupts` 擴充點本身 Phase 2 就落地了（registry ＋ fold ＋ 缺 checkpointer 即拒絕
 * ＋ 工具名存在檢查 ＋ 多方標記 OR）。過去唯一的行為斷言是 `agent-factory.test.ts` 的
 * `expect(result.__interrupt__).toBeDefined()`——**那只證明了「停下來了」**。驗收句
 * 「破壞性操作必須人工核准才執行」的兩半，一半沒證據（拒絕之後工具真的沒跑嗎），
 * 另一半連路都沒有（核准之後接得回去嗎）。這一份補的就是暫停之後的事。
 *
 * 每一條都用**間諜工具**判定：跑沒跑的答案在它有沒有被呼叫，不在回傳訊息的措辭上。
 * 而每一條「沒跑」都配一條「跑得起來」的對照——`ran === []` 同樣被「模型根本沒呼叫
 * 那個工具」「工具名打錯」「中斷壓根沒觸發」滿足，那是這組測試最容易假綠的地方。
 *
 * 四條是**基座行為的絆索**，紅了代表基座改了主意、而不是我們寫壞了：
 *
 * 1. 一批裡有人被拒，被核准的那些會靜靜地不執行且從歷史裡消失（`hitl.js:483-496`）。
 * 2. `context.interruptOn` 在 invoke 時整組覆蓋掉建構期的設定（`hitl.js:421`）。
 * 3. `edit` 決定被基座拒收，我們的封閉詞彙是真的約束（`hitl.js:407`）。
 * 4. `when` 收到的 `request.tool` 是 `undefined`（`hitl.js:359-367`）。
 */

import { tool } from '@langchain/core/tools';
import type { AIMessage, BaseMessage } from '@langchain/core/messages';
import { Command, MemorySaver } from '@langchain/langgraph';
import type { NexusPlugin } from '@nexus/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createNexusAgent } from './agent-factory.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';

/** 這一輪真的被呼叫到的工具名，依呼叫順序。 */
let ran: string[] = [];

beforeEach(() => {
  ran = [];
});

/** 註冊幾個只做一件事的間諜工具：把自己的名字記進 {@link ran}。 */
function spyPlugin(names: readonly string[]): NexusPlugin {
  return {
    name: 'spy',
    apply(registry) {
      for (const name of names) {
        registry.tools.register(
          tool(
            () => {
              ran.push(name);
              return `${name} 跑過了`;
            },
            { name, description: `間諜工具 ${name}`, schema: z.object({}) },
          ),
        );
      }
    },
  };
}

/** 把幾個工具標成需要核准。 */
function gatePlugin(names: readonly string[], when?: InterruptWhen): NexusPlugin {
  return {
    name: 'gate',
    apply(registry) {
      for (const name of names) {
        registry.interrupts.require(name, { reason: `${name} 要人看過`, when });
      }
    },
  };
}

type InterruptWhen = Parameters<
  Parameters<NexusPlugin['apply']>[0]['interrupts']['require']
>[1]['when'];

/**
 * 假模型：先呼叫指定的工具，之後每一輪都只講話。
 *
 * 尾巴刻意多備幾輪——被拒的那一批會 `jumpTo: "model"` 回去再問一次模型，腳本用完
 * 就會炸在無關的地方。
 */
function scripted(toolNames: readonly string[]): ScriptedChatModel {
  return new ScriptedChatModel({
    turns: [
      { content: '動手。', toolCalls: toolNames.map((name) => ({ name, args: {} })) },
      { content: '收工。' },
      { content: '再收一次工。' },
    ],
  });
}

/** 建一個「工具全是間諜、其中幾個要核准」的 agent。 */
async function gatedAgent(options: {
  tools: readonly string[];
  gated: readonly string[];
  when?: InterruptWhen;
}) {
  return createNexusAgent({
    model: scripted(options.tools),
    checkpointer: new MemorySaver(),
    plugins: [spyPlugin(options.tools), gatePlugin(options.gated, options.when)],
  });
}

/** 最後一則 AI 訊息上還掛著的工具呼叫名。 */
function lastAiToolCalls(messages: readonly BaseMessage[]): string[] {
  const ai = [...messages].reverse().find((message) => message.getType() === 'ai');
  return ((ai as AIMessage | undefined)?.tool_calls ?? []).map((call) => call.name);
}

describe('核准之後', () => {
  it('拒絕 → 工具沒跑，模型收到一則 error 的 ToolMessage', async () => {
    const { agent } = await gatedAgent({ tools: ['danger'], gated: ['danger'] });
    const config = { configurable: { thread_id: 'reject' } };

    const paused = await agent.invoke(toAgentInvocation('動手'), config);
    expect(paused.__interrupt__).toBeDefined();
    expect(ran).toEqual([]);

    const after = await agent.invoke(
      new Command({ resume: { decisions: [{ type: 'reject' }] } }) as never,
      config,
    );

    expect(ran).toEqual([]);
    const rejection = (after.messages as BaseMessage[]).find(
      (message) => message.getType() === 'tool',
    );
    expect(rejection?.text).toContain('User rejected the tool call');
    // 措辭本身不是重點，`status` 才是——模型分不分得出這則與成功的結果不同。
    expect((rejection as { status?: string } | undefined)?.status).toBe('error');
  });

  it('核准 → 工具真的跑了（上一條的對照組）', async () => {
    const { agent } = await gatedAgent({ tools: ['danger'], gated: ['danger'] });
    const config = { configurable: { thread_id: 'approve' } };

    await agent.invoke(toAgentInvocation('動手'), config);
    expect(ran).toEqual([]);

    const after = await agent.invoke(
      new Command({ resume: { decisions: [{ type: 'approve' }] } }) as never,
      config,
    );

    expect(ran).toEqual(['danger']);
    const result = (after.messages as BaseMessage[]).find(
      (message) => message.getType() === 'tool',
    );
    expect((result as { status?: string } | undefined)?.status).toBe('success');
  });
});

describe('一批裡混著核准與拒絕', () => {
  it('兩個都核准 → 兩個都跑（下一條的對照組）', async () => {
    const { agent } = await gatedAgent({
      tools: ['ok_tool', 'bad_tool'],
      gated: ['ok_tool', 'bad_tool'],
    });
    const config = { configurable: { thread_id: 'both-approve' } };

    await agent.invoke(toAgentInvocation('動手'), config);
    await agent.invoke(
      new Command({ resume: { decisions: [{ type: 'approve' }, { type: 'approve' }] } }) as never,
      config,
    );

    expect(ran).toEqual(['ok_tool', 'bad_tool']);
  });

  it('只要有一個被拒，被核准的那個也不會跑，而且從歷史裡消失', async () => {
    const { agent } = await gatedAgent({
      tools: ['ok_tool', 'bad_tool'],
      gated: ['ok_tool', 'bad_tool'],
    });
    const config = { configurable: { thread_id: 'mixed' } };

    await agent.invoke(toAgentInvocation('動手'), config);
    const after = await agent.invoke(
      new Command({ resume: { decisions: [{ type: 'approve' }, { type: 'reject' }] } }) as never,
      config,
    );

    // 上一條證明了這兩個工具在全核准時都跑得起來，所以這裡的空陣列只可能是被拒那件事造成的。
    expect(ran).toEqual([]);

    // 而且不是「跑了但沒記到」——基座直接改寫了 AI 訊息，被核准的那筆呼叫整個不見了：
    // 沒有 ToolMessage、沒有痕跡，模型看起來像它從來沒要求過 `ok_tool`。
    const messages = after.messages as BaseMessage[];
    const toolMessages = messages.filter((message) => message.getType() === 'tool');
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]?.text).toContain('bad_tool');

    // 關鍵的一句：`ok_tool` 連「曾經被要求過」都不剩。斷言的是被改寫後的 `tool_calls`
    // ——只數 `ran` 的話，這一條就只是一條計數測試，測不到抹除這件事。
    const requested = messages
      .filter((message) => message.getType() === 'ai')
      .flatMap((message) => lastAiToolCalls([message]));
    expect(requested).toContain('bad_tool');
    expect(requested).not.toContain('ok_tool');
  });
});

describe('閘門本身的邊界', () => {
  it('invoke 時給 context.interruptOn 就整組覆蓋掉，閘門無聲消失', async () => {
    const { agent } = await gatedAgent({ tools: ['danger'], gated: ['danger'] });

    const result = await agent.invoke(toAgentInvocation('動手'), {
      configurable: { thread_id: 'context-override' },
      // 基座執行期取的是 `{ ...options, ...runtime.context }`，所以這一個空物件
      // 就把建構期折出來的整份 `interruptOn` 換掉了。
      context: { interruptOn: {} },
    } as never);

    expect(result.__interrupt__).toBeUndefined();
    expect(ran).toEqual(['danger']);
  });

  it('resume 傳 edit 決定 → 基座當場拒收，不是靜默降級成核准', async () => {
    const { agent } = await gatedAgent({ tools: ['danger'], gated: ['danger'] });
    const config = { configurable: { thread_id: 'edit' } };

    await agent.invoke(toAgentInvocation('動手'), config);
    const failure = await agent
      .invoke(
        new Command({
          resume: { decisions: [{ type: 'edit', editedAction: { name: 'danger', args: {} } }] },
        }) as never,
        config,
      )
      .catch((error: unknown) => (error as Error).message);

    expect(failure).toContain("Decision type 'edit' is not allowed");
    expect(failure).toContain('["approve","reject"]');
    expect(ran).toEqual([]);
  });

  it('when 收到的 request 沒有 tool——伸手拿 request.tool 會炸', async () => {
    let seen: { hasTool: boolean; toolCallName: unknown } | undefined;

    const { agent } = await gatedAgent({
      tools: ['danger'],
      gated: ['danger'],
      when: (request) => {
        seen = { hasTool: request.tool !== undefined, toolCallName: request.toolCall.name };
        return true;
      },
    });

    const result = await agent.invoke(toAgentInvocation('動手'), {
      configurable: { thread_id: 'when' },
    });

    // 述詞真的被求值了——沒有這一條，下面兩句在「基座根本沒呼叫 when」時也會過。
    expect(seen).toBeDefined();
    expect(seen?.toolCallName).toBe('danger');
    expect(seen?.hasTool).toBe(false);
    expect(result.__interrupt__).toBeDefined();
  });
});

describe('subagent 裡的閘門', () => {
  it('子代理呼叫 gated 工具 → 中斷冒到 root，拒絕之後工具沒跑', async () => {
    const model = new ScriptedChatModel({
      turns: [
        {
          content: '委派。',
          toolCalls: [{ name: 'task', args: { description: '幹活', subagent_type: 'worker' } }],
        },
        { content: '子代理動手。', toolCalls: [{ name: 'danger', args: {} }] },
        { content: '子代理收工。' },
        { content: '根收工。' },
        { content: '根再收一次工。' },
      ],
    });

    const { agent } = await createNexusAgent({
      model,
      checkpointer: new MemorySaver(),
      plugins: [
        spyPlugin(['danger']),
        {
          name: 'delegate',
          apply(registry) {
            // 刻意不自帶 `tools`——什麼都不帶的 subagent 沿用 root 那組，`danger`
            // 因此在子代理裡也叫得到，而閘門是不是跟著下去正是這一條要問的事。
            registry.subagents.register({ name: 'worker', description: '幹活的。' });
          },
        },
        gatePlugin(['danger']),
      ],
    });
    const config = { configurable: { thread_id: 'subagent' } };

    const paused = await agent.invoke(toAgentInvocation('委派'), config);
    expect(paused.__interrupt__).toBeDefined();
    expect(ran).toEqual([]);

    await agent.invoke(
      new Command({ resume: { decisions: [{ type: 'reject' }] } }) as never,
      config,
    );

    expect(ran).toEqual([]);
  });
});
