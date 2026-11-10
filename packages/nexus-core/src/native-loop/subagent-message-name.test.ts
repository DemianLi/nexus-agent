/**
 * 子代理自己那則 AI 訊息的 `name` 是子代理的名字，兩個 loop 一樣：langchain 的 `AgentNode` 蓋上 agent 的 `name`，
 * deepagents 照規格建子代理時給的是子代理名字（直接給 `runnable` 的不經這一步）。這個欄位跟著訊息串送進模型請求（OpenAI 的 `name`）。
 */

import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { StateBackend } from 'deepagents';
import { fakeModel } from '../fixtures.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { assembleAgent } from '../agent-assembly.js';
import { fakePlugin } from '../fixtures.js';
import { foldRegistry } from '../fold.js';
import { loadPlugins } from '../load.js';
import { LOOPS, type Loop } from './human-input-loops.fixture.js';

/** 每次模型呼叫收到的 AI 訊息，各自的 `name`。 */
async function namesSeen(loop: Loop): Promise<readonly (readonly (string | undefined)[])[]> {
  const { registry } = await loadPlugins([
    fakePlugin('worker', (r) => {
      r.tools.register(
        tool(() => '戳了', { name: 'poke', description: '戳一下。', schema: z.object({}) }),
      );
      r.subagents.register({
        name: 'worker',
        description: '幹活的。',
        systemPrompt: '你是 worker。',
      });
    }),
  ]);
  const model = fakeModel()
    .respondWithTools([
      { name: 'task', args: { description: '做', subagent_type: 'worker' }, id: 'task-1' },
    ])
    .respondWithTools([{ name: 'poke', args: {}, id: 'p1' }])
    .respond(new AIMessage('子代理收完'))
    .respond(new AIMessage('root 收完'));
  const backend = new StateBackend();
  const params = foldRegistry(registry, {
    summarization: false,
    defaultBackend: backend,
    events: registry.dispatch,
    loop,
  });
  const agent = assembleAgent({
    ...params,
    model,
    backend: params.backend ?? backend,
    loop,
    events: registry.dispatch,
  }) as unknown as { invoke(input: unknown, config: object): Promise<unknown> };
  await agent.invoke(
    { messages: [new HumanMessage('動手')] },
    { configurable: { thread_id: 't' } },
  );
  return model.calls.map((call) =>
    (call.messages as BaseMessage[]).filter((m) => AIMessage.isInstance(m)).map((m) => m.name),
  );
}

describe('子代理那則 AI 訊息的 name', () => {
  it('子代理第二次叫模型時，前一則 AI 訊息的 name 是子代理名字；兩個 loop 一樣', async () => {
    const [langgraph, native] = await Promise.all(LOOPS.map(namesSeen));
    // 第三次呼叫是子代理叫完 poke 之後：送進去的是它自己那則。
    expect(langgraph?.[2]).toEqual(['worker']);
    expect(native).toEqual(langgraph);
  });
});
