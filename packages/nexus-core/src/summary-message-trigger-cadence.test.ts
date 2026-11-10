/**
 * 只靠則數門檻觸發的摘要，觸發之後隔幾輪才再觸發（[#2659](https://github.com/DemianLi/nexus-agent/issues/2659)）。
 *
 * 一輪 8 則：人話 1 則、三次工具呼叫各 2 則、回覆約 3,000 字 1 則；同一條 thread 連跑多輪，數摘要模型被叫幾次、各在第幾輪。
 * 沒型錄的模型：保留量是 token 門檻的兩成（20,000），token 門檻（100,000）碰不到，所以只有 `messages: 60` 會觸發。
 * 三次呼叫用三個不同的工具：同一個工具連叫，重複呼叫提醒會多插一則人話，一輪就不是 8 則。
 */

import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { MemorySaver } from '@langchain/langgraph';
import { StateBackend } from 'deepagents';
import { describe, expect, it } from 'vitest';

import { assembleAgent } from './agent-assembly.js';
import type { AgentLoopKind } from './agent-assembly.js';
import { fakePlugin, fakeTool } from './fixtures.js';
import { foldRegistry } from './fold.js';
import { loadPlugins } from './load.js';

const TURNS = 24;
const TOOLS = ['alpha', 'beta', 'gamma'] as const;

/** 腳本模型：摘要請求回摘要並記下是第幾輪；其餘每輪依序呼叫三個工具，再回一則長回覆。 */
class ScriptedModel extends BaseChatModel {
  reply = '';
  turn = 0;
  step = 0;
  readonly summaries: number[] = [];
  /** 每次摘要之後，下一次一般呼叫看到的則數（含系統提示一則）。 */
  readonly afterSummary: number[] = [];
  private pending = false;

  _llmType(): string {
    return 'scripted';
  }

  override bindTools(): this {
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const reply = (message: AIMessage): ChatResult => ({
      generations: [{ message, text: message.text }],
    });
    if (messages.length === 1 && messages[0]!.text.includes('--- END OF CONVERSATION ---')) {
      this.summaries.push(this.turn);
      this.pending = true;
      return reply(new AIMessage('這是摘要。'));
    }
    if (this.pending) {
      this.afterSummary.push(messages.length);
      this.pending = false;
    }
    const name = TOOLS[this.step];
    this.step += 1;
    if (name === undefined) return reply(new AIMessage(this.reply));
    return reply(
      new AIMessage({
        content: '',
        tool_calls: [{ id: `call-${this.turn}-${name}`, name, args: {} }],
      }),
    );
  }
}

async function run(loop: AgentLoopKind, replyChars: number) {
  const { registry } = await loadPlugins([
    fakePlugin('tools', (r) => {
      for (const name of TOOLS) r.tools.register(fakeTool(name));
    }),
  ]);
  const backend = new StateBackend();
  const params = foldRegistry(registry, {
    stepInbox: true,
    defaultBackend: backend,
    events: registry.dispatch,
  });
  const model = new ScriptedModel({});
  model.reply = '這是一段回覆的內容。'.repeat(replyChars / 10);
  const agent = assembleAgent({
    ...params,
    model,
    backend: params.backend ?? backend,
    checkpointer: new MemorySaver(),
    withoutSubagents: true,
    loop,
    events: registry.dispatch,
  });
  const config = { configurable: { thread_id: 't' }, recursionLimit: 100 };
  const lengths: number[] = [];
  for (let turn = 1; turn <= TURNS; turn += 1) {
    model.turn = turn;
    model.step = 0;
    const state = await agent.invoke({ messages: [new HumanMessage(`第 ${turn} 輪`)] }, config);
    lengths.push((state.messages as BaseMessage[]).length);
  }
  return { summaries: model.summaries, afterSummary: model.afterSummary, lengths };
}

describe.each(['langgraph', 'native'] as const)('則數門檻觸發後的節奏（%s）', (loop) => {
  it.each([3_000, 3_800])('觀察：回覆 %i 字，摘要在第幾輪', async (chars) => {
    const result = await run(loop, chars);
    console.log(loop, chars, JSON.stringify(result));
    expect(result.summaries.length).toBeGreaterThan(0);
  });
});
