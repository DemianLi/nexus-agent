/**
 * 登記了一步的 hook 在 native 原位呼叫時，跟 LangGraph 的 hook 節點一樣各扣一格遞迴預算（#2416）。模型一次答完的一輪，native 扣 8 格：
 * `beforeAgent` 4 顆（Skills、Filesystem（空函式，`native-noop-cells.ts`）、patchToolCalls、Memory）、`beforeModel` 2 顆（stepInbox、重複提醒）、模型 1、
 * `afterAgent` 1 顆（stepInbox）。上限從小掃到大，界線釘在 8：少扣或多扣一格，界線就跟著移。
 */

import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { StateBackend } from 'deepagents';
import { fakeModel } from '../fixtures.js';
import { describe, expect, it } from 'vitest';

import { assembleAgent } from '../agent-assembly.js';
import { fakePlugin } from '../fixtures.js';
import { foldRegistry } from '../fold.js';
import { loadPlugins } from '../load.js';

async function run(limit: number) {
  const { registry } = await loadPlugins([
    fakePlugin('sources', (r) => {
      r.skills.addSource('/skills/');
      r.memory.addSource('/AGENTS.md');
    }),
  ]);
  const backend = new StateBackend();
  const params = foldRegistry(registry, {
    summarization: false,
    stepInbox: true,
    defaultBackend: backend,
    events: registry.dispatch,
  });
  const agent = assembleAgent({
    ...params,
    model: fakeModel().respond(new AIMessage('好了')),
    backend: params.backend ?? backend,
    checkpointer: new MemorySaver(),
    loop: 'native',
    events: registry.dispatch,
  });
  const config = { configurable: { thread_id: 't' }, recursionLimit: limit };
  let failed = false;
  try {
    await agent.invoke({ messages: [new HumanMessage('動手')] }, config);
  } catch (error) {
    expect(String(error)).toContain(`Recursion limit of ${limit} reached`);
    failed = true;
  }
  const state = (await agent.getState(config)) as { values: { messages?: BaseMessage[] } };
  return { failed, messages: (state.values.messages ?? []).map((m) => m.text) };
}

describe('native 原位呼叫的 hook 各扣一格遞迴預算', () => {
  it('上限 1～7 拋、8 起跑完：這一輪剛好扣 8 格', async () => {
    for (let limit = 1; limit <= 10; limit++) {
      const { failed, messages } = await run(limit);
      expect([limit, failed]).toEqual([limit, limit < 8]);
      if (!failed) expect(messages).toEqual(['動手', '好了']);
    }
  });
});
