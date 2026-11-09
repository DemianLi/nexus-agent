/**
 * `task` 的 description 超過門檻時，兩個 loop 送進前景子代理模型的內容一樣：基座的 `FilesystemMiddleware.beforeAgent` 把它搬到
 * `/conversation_history`，模型看到的是搬走後的那句。搬檔路徑的編號每次不同，比之前換成 `<id>`。
 */

import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { StateBackend } from 'deepagents';
import { fakeModel } from 'langchain';
import { describe, expect, it } from 'vitest';

import { assembleAgent } from '../agent-assembly.js';
import { HUMAN_MESSAGE_LIMIT_CHARS } from '../human-message-admission.js';
import { fakePlugin } from '../fixtures.js';
import { foldRegistry } from '../fold.js';
import { loadPlugins } from '../load.js';
import { LOOPS, type Loop } from './human-input-loops.fixture.js';

const LONG = '長'.repeat(HUMAN_MESSAGE_LIMIT_CHARS + 1);

/** 子代理那一次模型呼叫收到的人話。子代理沒宣告 model，跟 root 共用同一顆 fakeModel：第 0 次是 root 叫 `task`，第 1 次是子代理。 */
async function subagentHumanText(loop: Loop): Promise<readonly string[]> {
  const { registry } = await loadPlugins([
    fakePlugin('worker', (r) => {
      r.subagents.register({
        name: 'worker',
        description: '幹活的。',
        systemPrompt: '你是 worker。',
      });
    }),
  ]);
  const model = fakeModel()
    .respondWithTools([
      { name: 'task', args: { description: LONG, subagent_type: 'worker' }, id: 'task-1' },
    ])
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
  return (model.calls[1]?.messages as BaseMessage[])
    .filter((m) => HumanMessage.isInstance(m))
    .map((m) => m.text.replace(/\/conversation_history\/[0-9a-f]+/, '/conversation_history/<id>'));
}

describe('task 的 description 超過門檻', () => {
  it('兩個 loop 送進子代理模型的人話一樣', async () => {
    const [langgraph, native] = await Promise.all(LOOPS.map(subagentHumanText));
    // 先確定 langgraph 真的搬了；兩邊都沒搬時，下一條也會綠。
    expect(langgraph?.[0]).toContain('/conversation_history/<id>');
    expect(native).toEqual(langgraph);
  });
});
