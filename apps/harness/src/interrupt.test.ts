/**
 * 核准層的**行為**驗收，跑在真的 graph 上。
 *
 * [#111](https://github.com/DemianLi/nexus-agent/issues/111) 把機制從宣告式的
 * `interrupts.require(toolName, ...)` 換成 `wrapToolCall` 上的 pre-execute waterfall，
 * 所以這一份也跟著換了主體。純函式那一半（waterfall 語義、四個拒絕理由）在
 * `packages/nexus-core/src/approval.test.ts`；**這裡只放需要 checkpointer 與模型才問得出來的**。
 *
 * 每一條都用**間諜工具**判定：跑沒跑的答案在它有沒有被呼叫，不在回傳訊息的措辭上。
 * 而每一條「沒跑」都配一條「跑得起來」的對照——`ran === []` 同樣被「模型根本沒呼叫
 * 那個工具」「閘門壓根沒觸發」滿足，那是這組測試最容易假綠的地方。
 *
 * **兩條原本的基座絆索在這次換機制之後變成了反面**，而反面才是驗收句：
 *
 * 1. `context: { interruptOn: {} }` 過去一句話就把整組閘門換掉（`hitl.js:421`）。
 *    我們不再用 `interruptOn`，所以那條繞道**沒有東西可蓋**——測的是它真的失效了。
 * 2. 一批裡有人被拒、被核准的那些過去會靜靜地不執行且從歷史裡消失（`hitl.js:483-496`）。
 *    閘門改成逐次呼叫各自判斷，那個抹除不存在——測的是混合批次現在各行其是。
 *
 * **換來的新語義也要釘住**：同一批裡排在被擋工具**前面**的那些，在人被問到時已經跑完了。
 * 基座是問之前一個都沒跑。兩種都不是全有全無，差別在副作用落在問之前還是問之後。
 *
 * **[#159](https://github.com/DemianLi/nexus-agent/issues/159) 之後，這整份檔案跑在圍堵
 * 裡面。** 圍堵是 fold 打底的第 0 格，也就是說它包住這裡每一條核准路徑——而它是個
 * `try/catch`，擋在「把中斷整個吃掉」與我們之間的只有 `isGraphBubbleUp` 一條。這份檔案
 * 因此是那次搬家最有力的護欄：這裡任何一條紅了，先看的是那個判準而不是核准層。
 * 一條跟著翻了面（`resume` 傳看不懂的決定），理由寫在那條上面。
 */

import { tool } from '@langchain/core/tools';
import type { AIMessage, BaseMessage } from '@langchain/core/messages';
import { Command, MemorySaver } from '@langchain/langgraph';
import type { NexusPlugin, ToolExecution } from '@nexus/core';
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

/**
 * 一位 listener 判所有工具。
 *
 * **這就是換掉宣告式清單之後該有的寫法**：名字在 `exec` 上，不在我們手上的一份表裡，
 * 所以打錯字這個 bug class 不存在。`observe` 是給那條「listener 看得到什麼」的測試用的。
 */
function gatePlugin(
  names: readonly string[],
  observe?: (exec: ToolExecution) => void,
): NexusPlugin {
  return {
    name: 'gate',
    apply(registry) {
      registry.approvals.gate((exec, next) => {
        observe?.(exec);
        return names.includes(exec.name)
          ? { kind: 'ask', reason: `${exec.name} 要人看過` }
          : next();
      });
    },
  };
}

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
  observe?: (exec: ToolExecution) => void;
}) {
  return createNexusAgent({
    model: scripted(options.tools),
    checkpointer: new MemorySaver(),
    plugins: [spyPlugin(options.tools), gatePlugin(options.gated, options.observe)],
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
    // **拒絕的措辭現在是我們的**，不是基座的 "User rejected the tool call"——閘門
    // 自己產生那則 ToolMessage，而理由要說得出是哪一種拒絕（見 `approval.ts`）。
    expect(rejection?.text).toContain('有人看過並拒絕了');
    expect(rejection?.text).toContain('danger');
    // 措辭本身不是全部，`status` 才是——模型分不分得出這則與成功的結果不同。
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

  it('**一個被拒不再拖累另一個**——被核准的那個真的跑了', async () => {
    // 基座的批次語義是：算出 `hasRejectedToolCalls` 之後直接改寫 AI 訊息的 `tool_calls`
    // （`hitl.js:483-496`），被核准的那筆從歷史裡消失，沒有 ToolMessage、沒有痕跡。
    // 閘門改成逐次呼叫各自判斷之後，那個抹除**沒有發生的地方**了。
    const { agent } = await gatedAgent({
      tools: ['ok_tool', 'bad_tool'],
      gated: ['bad_tool'],
    });
    const config = { configurable: { thread_id: 'mixed' } };

    const paused = await agent.invoke(toAgentInvocation('動手'), config);
    expect(paused.__interrupt__).toBeDefined();

    // **這一句就是新語義**：`ok_tool` 沒被擋，所以在人被問到的當下它已經跑完了。
    // 基座那邊是問之前一個都沒跑。副作用落在問之前還是問之後，是換機制換到的東西。
    expect(ran).toEqual(['ok_tool']);

    const after = await agent.invoke(
      new Command({ resume: { decisions: [{ type: 'reject' }] } }) as never,
      config,
    );

    // `bad_tool` 被拒所以沒跑，而 `ok_tool` 沒有跟著被抹掉——兩件事都要驗。
    expect(ran).toEqual(['ok_tool']);
    const messages = after.messages as BaseMessage[];
    const toolMessages = messages.filter((message) => message.getType() === 'tool');
    expect(toolMessages.map((message) => message.text)).toEqual([
      expect.stringContaining('ok_tool 跑過了'),
      expect.stringContaining('bad_tool'),
    ]);
    // 「曾經被要求過」也還在——這正是基座會抹掉的那一格。要看的是**發出那一批的**
    // 那則 AI 訊息，不是最後一則（拒絕之後模型會再講一輪話，那則沒有 tool_calls）。
    const requested = messages
      .filter((message) => message.getType() === 'ai')
      .flatMap((message) => lastAiToolCalls([message]));
    expect(requested).toContain('ok_tool');
    expect(requested).toContain('bad_tool');
  });

  it('兩個都要核准 → 一次暫停帶兩顆中斷，一個決定套到兩顆上', async () => {
    // 全有全無的介面因此仍然成立：`packages/nexus-wire` 的 `uniformDecisions` 送滿
    // 同型決定，這一條釘住的是「顆數」與「一次 resume 收兩顆」。
    const { agent } = await gatedAgent({
      tools: ['ok_tool', 'bad_tool'],
      gated: ['ok_tool', 'bad_tool'],
    });
    const config = { configurable: { thread_id: 'two-gated' } };

    const paused = await agent.invoke(toAgentInvocation('動手'), config);
    expect((paused.__interrupt__ as unknown[] | undefined)?.length).toBe(2);
    expect(ran).toEqual([]);

    const after = await agent.invoke(
      new Command({ resume: { decisions: [{ type: 'approve' }] } }) as never,
      config,
    );
    expect(after.__interrupt__).toBeUndefined();
    expect(ran).toEqual(['ok_tool', 'bad_tool']);
  });
});

describe('閘門本身的邊界', () => {
  it('**`context.interruptOn` 那條繞道失效了**——那正是換機制要換掉的東西', async () => {
    const { agent } = await gatedAgent({ tools: ['danger'], gated: ['danger'] });

    const result = await agent.invoke(toAgentInvocation('動手'), {
      configurable: { thread_id: 'context-override' },
      // 過去這一個空物件就把建構期折出來的整份 `interruptOn` 換掉了（基座執行期取的是
      // `{ ...options, ...runtime.context }`，`hitl.js:421`）。閘門現在住在
      // `wrapToolCall` 上，不讀 context，所以這裡沒有東西可蓋。
      context: { interruptOn: {} },
    } as never);

    expect(result.__interrupt__).toBeDefined();
    expect(ran).toEqual([]);
  });

  /**
   * **這一條翻過一次面。** 它以前釘的是「當場拋」——閘門對看不懂的決定 `throw`，而那時
   * 整場 run 跟著死。[#159](https://github.com/DemianLi/nexus-agent/issues/159) 把圍堵
   * 打底進 fold 的第 0 格之後，閘門就在它裡面，所以那個 `throw` 變成一則 error
   * ToolMessage：**run 走得完，工具還是一次都沒跑。**
   *
   * **翻面之後仍然是同一句驗收**：詞彙是封閉的、`edit` 不被靜默降級成核准。變的只是
   * 拒絕的載體。這也正是 dsh 那側的形狀——「缺失、不负责该请求、抛异常或**不合规**的
   * 应答者会产生 `unavailable`，**而非放行**」，而呼叫端對 `unavailable` 執行拒絕
   * （`docs/subsystems/approval.zh.md:21`，SHA `4e84901`）：那是「這次呼叫被拒」，
   * 不是「這一輪結束」。
   */
  it('resume 傳看不懂的決定 → **一則錯誤，不是靜默降級成核准，也不再殺掉整場 run**', async () => {
    const { agent } = await gatedAgent({ tools: ['danger'], gated: ['danger'] });
    const config = { configurable: { thread_id: 'edit' } };

    await agent.invoke(toAgentInvocation('動手'), config);
    const after = await agent.invoke(
      new Command({
        resume: { decisions: [{ type: 'edit', editedAction: { name: 'danger', args: {} } }] },
      }) as never,
      config,
    );

    const failure = (after.messages as BaseMessage[])
      .filter((message) => message.getType() === 'tool')
      .at(-1) as (BaseMessage & { status?: string }) | undefined;
    expect(failure?.status).toBe('error');
    expect(failure?.text).toContain('核准回覆看不懂');
    // **承重的還是這一條**：載體變了，「沒跑」沒變。
    expect(ran).toEqual([]);
  });

  it('**listener 看得到工具名與已解析的參數**——`when` 述詞因此是免費的', async () => {
    const seen: ToolExecution[] = [];
    const { agent } = await gatedAgent({
      tools: ['danger'],
      gated: ['danger'],
      observe: (exec) => void seen.push(exec),
    });

    const result = await agent.invoke(toAgentInvocation('動手'), {
      configurable: { thread_id: 'listener-sees' },
    });

    // listener 真的被求值了——沒有這一條，下面幾句在「閘門根本沒被叫到」時也會過。
    expect(seen).toHaveLength(1);
    expect(seen[0]?.name).toBe('danger');
    // 舊機制的 `when` 拿到的 `request.tool` 恆為 `undefined`（`hitl.js:359-367`），
    // 伸手去拿編得過、跑起來炸。新的 `exec` 上根本沒有那一格，所以沒得踩。
    expect(seen[0]).not.toHaveProperty('tool');
    expect(seen[0]?.args).toEqual({});
    expect(result.__interrupt__).toBeDefined();
  });

  it('沒有 checkpointer → **組得起來，但確定性拒絕**，理由說的是沒有管道', async () => {
    // #111 的 (c)：舊版在 fold 就拋，任何 bundle 了 approval-gated 工具的 plugin
    // 在批次／CI 模式下變成載不起來。
    const { agent } = await createNexusAgent({
      model: scripted(['danger']),
      plugins: [spyPlugin(['danger']), gatePlugin(['danger'])],
    });

    const result = await agent.invoke(toAgentInvocation('動手'));

    expect(ran).toEqual([]);
    const rejection = (result.messages as BaseMessage[]).find(
      (message) => message.getType() === 'tool',
    );
    expect(rejection?.text).toContain('沒有可用的核准管道');
    expect((rejection as { status?: string } | undefined)?.status).toBe('error');
  });

  it('關掉核准 → **一樣跑得完**，沒被擋的工具照跑，被擋的說「沒有人被問到」', async () => {
    // (c) 的正面驗收：headless 下 agent 跑得起來，這是整張卡的動機 1。
    const { agent } = await createNexusAgent({
      model: scripted(['ok_tool', 'danger']),
      checkpointer: new MemorySaver(),
      approvals: { enabled: false },
      plugins: [spyPlugin(['ok_tool', 'danger']), gatePlugin(['danger'])],
    });

    const result = await agent.invoke(toAgentInvocation('動手'), {
      configurable: { thread_id: 'headless' },
    });

    expect(result.__interrupt__).toBeUndefined();
    // 沒被擋的真的跑了——只驗 `danger` 沒跑的話，「整場 run 死掉」也會讓它綠。
    expect(ran).toEqual(['ok_tool']);
    const messages = result.messages as BaseMessage[];
    const rejection = messages
      .filter((message) => message.getType() === 'tool')
      .find((message) => message.text.includes('關掉了人工核准'));
    expect(rejection?.text).toContain('沒有人被問到');
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
            // **這一條在換機制之後更吃重**：subagent 不繼承 root 的 plugin middleware
            // （`SubAgentBase.middleware` 是「append after default_middleware」），
            // 閘門是 fold 逐個注進去的。沒注就是默默地失去核准，而它紅在這裡。
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
