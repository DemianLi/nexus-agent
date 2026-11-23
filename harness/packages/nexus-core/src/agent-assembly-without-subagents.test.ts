/**
 * `AssembleAgentParams.withoutSubagents`（[#2367](https://github.com/DemianLi/nexus-agent/issues/2367)）：給了就不掛子代理中介層，
 * 兩個 loop 下模型拿到的工具都沒有 `task`。對照組用同樣的 plugin fold 出來，只差不給這個選項。
 * 經 harness 嵌入版設定檔走的端到端在 `apps/harness/src/embed-profile.test.ts`。
 */

import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { StateBackend } from 'deepagents';
import { fakeModel } from './fixtures.js';
import { describe, expect, it } from 'vitest';

import { assembleAgent } from './agent-assembly.js';
import { fakePlugin } from './fixtures.js';
import { foldRegistry } from './fold.js';
import { loadPlugins } from './load.js';
import { LOOPS, type Loop } from './native-loop/human-input-loops.fixture.js';

/** 跑一輪，回模型每次綁到的工具名。 */
async function boundToolNames(
  loop: Loop,
  options: { readonly withoutSubagents?: boolean; readonly generalPurpose?: boolean },
): Promise<string[][]> {
  const { registry } = await loadPlugins([
    fakePlugin('worker', (r) => {
      r.subagents.register({
        name: 'worker',
        description: '幹活的。',
        systemPrompt: '你是 worker。',
      });
    }),
  ]);
  const model = fakeModel().respond(new AIMessage('好了'));
  const bound: string[][] = [];
  const bindTools = model.bindTools.bind(model);
  model.bindTools = (tools: readonly { readonly name: string }[]) => {
    bound.push(tools.map((t) => t.name));
    return bindTools(tools as never);
  };
  const backend = new StateBackend();
  const params = foldRegistry(registry, {
    summarization: false,
    defaultBackend: backend,
    events: registry.dispatch,
    loop,
  });
  const subagents =
    options.generalPurpose === false
      ? params.subagents.filter((spec) => spec.name !== 'general-purpose')
      : params.subagents;
  const agent = assembleAgent({
    ...params,
    subagents,
    model,
    backend: params.backend ?? backend,
    loop,
    events: registry.dispatch,
    ...(options.withoutSubagents !== undefined && { withoutSubagents: options.withoutSubagents }),
  }) as unknown as { invoke(input: unknown, config: object): Promise<unknown> };
  await agent.invoke({ messages: [new HumanMessage('嗨')] }, { configurable: { thread_id: 't' } });
  return bound;
}

describe.each(LOOPS)('withoutSubagents（%s）', (loop) => {
  it('給了：模型拿到的工具沒有 task；沒給：有', async () => {
    const without = await boundToolNames(loop, { withoutSubagents: true });
    const withSubagents = await boundToolNames(loop, {});

    expect(without).toHaveLength(1);
    expect(without[0]).not.toContain('task');
    expect(without[0]).toContain('read_file');
    expect(withSubagents).toHaveLength(1);
    expect(withSubagents[0]).toContain('task');
  });

  it('給了就不要求有 general-purpose', async () => {
    const without = await boundToolNames(loop, { withoutSubagents: true, generalPurpose: false });
    expect(without[0]).not.toContain('task');

    await expect(boundToolNames(loop, { generalPurpose: false })).rejects.toThrow(
      /沒有 general-purpose 子代理/,
    );
  });
});
