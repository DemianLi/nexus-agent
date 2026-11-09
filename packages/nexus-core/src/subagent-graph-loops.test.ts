/**
 * `compileSubagentGraph` 的 `loop`：同一份規格在兩個 loop 下編出來的背景子代理，模型看到的一樣。native 那一支是 native agent 的
 * `background` 模式，這裡釘它跟 langgraph 不同、又必須對上的三件事：下一輪看得到上一輪靠的是同一個實例的記憶體（不是存檔點）；
 * 不派只有 root 派的 `agent/pre-step`、`agent/turn-stopping`；人話超過門檻時照基座搬到 `/conversation_history`。
 */

import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { StateBackend } from 'deepagents';
import { fakeModel } from 'langchain';
import { describe, expect, it } from 'vitest';

import type { AgentLoopKind } from './agent-assembly.js';
import { fakePlugin } from './fixtures.js';
import { foldRegistry } from './fold.js';
import { HUMAN_MESSAGE_LIMIT_CHARS } from './human-message-admission.js';
import { loadPlugins } from './load.js';
import { compileSubagentGraph } from './subagent-graph.js';

const LOOPS: readonly AgentLoopKind[] = ['langgraph', 'native'];

type Counted = 'agent/pre-step' | 'agent/turn-stopping' | 'llm/stream';

interface Seen {
  /** 每次叫模型收到的人話，搬檔路徑的編號換成 `<id>`。 */
  readonly humans: readonly (readonly string[])[];
  /** 共用派發面上各事件被派了幾次。 */
  readonly counts: Readonly<Record<Counted, number>>;
}

/** 同一個實例、同一條 thread 跑兩輪：第一輪說 `first`，第二輪說「第二輪」。 */
async function twoRounds(loop: AgentLoopKind, first: string): Promise<Seen> {
  const counts: Record<Counted, number> = {
    'agent/pre-step': 0,
    'agent/turn-stopping': 0,
    'llm/stream': 0,
  };
  const { registry } = await loadPlugins([
    fakePlugin('listeners', (r) => {
      r.events.on('agent/pre-step', (_payload, next) => {
        counts['agent/pre-step'] += 1;
        return next();
      });
      r.events.on('agent/turn-stopping', () => {
        counts['agent/turn-stopping'] += 1;
      });
      r.events.on('llm/stream', (_payload, next) => {
        counts['llm/stream'] += 1;
        return next();
      });
      r.subagents.register({
        name: 'worker',
        description: '幹活的。',
        systemPrompt: '你是 worker。',
      });
    }),
  ]);
  const model = fakeModel().respond(new AIMessage('一號')).respond(new AIMessage('二號'));
  const backend = new StateBackend();
  const params = foldRegistry(registry, {
    summarization: false,
    defaultBackend: backend,
    events: registry.dispatch,
    loop,
  });
  const graph = compileSubagentGraph({ ...params, backend: params.backend ?? backend }, 'worker', {
    checkpointer: new MemorySaver(),
    model: model as never,
    loop,
    events: registry.dispatch,
  });
  const config = { configurable: { thread_id: 'root-1/bg-1' } };
  await graph.invoke({ messages: [new HumanMessage(first)] }, config);
  await graph.invoke({ messages: [new HumanMessage('第二輪')] }, config);
  return {
    humans: model.calls.map((call) =>
      (call.messages as BaseMessage[])
        .filter((m) => HumanMessage.isInstance(m))
        .map((m) =>
          m.text.replace(/\/conversation_history\/[0-9a-f]+/, '/conversation_history/<id>'),
        ),
    ),
    counts,
  };
}

describe('compileSubagentGraph 的兩個 loop', () => {
  it('同一個實例的第二輪看得到第一輪；兩個 loop 送進模型的人話一樣', async () => {
    const [langgraph, native] = await Promise.all(LOOPS.map((loop) => twoRounds(loop, '第一輪')));
    expect(langgraph?.humans).toEqual([['第一輪'], ['第一輪', '第二輪']]);
    expect(native?.humans).toEqual(langgraph?.humans);
  });

  it('native 不派 pre-step、turn-stopping，llm/stream 照派；langgraph 的背景圖本來就不派前兩個', async () => {
    const [langgraph, native] = await Promise.all(LOOPS.map((loop) => twoRounds(loop, '第一輪')));
    expect(native?.counts).toEqual({
      'agent/pre-step': 0,
      'agent/turn-stopping': 0,
      // 兩輪各叫一次模型。
      'llm/stream': 2,
    });
    // langgraph 的背景圖沒有派這兩個事件的格（只折進 root），比的是這兩個。
    expect(langgraph?.counts).toMatchObject({ 'agent/pre-step': 0, 'agent/turn-stopping': 0 });
  });

  it('人話超過門檻：兩個 loop 都照基座搬檔，模型看到的那句一樣', async () => {
    const long = '長'.repeat(HUMAN_MESSAGE_LIMIT_CHARS + 1);
    const [langgraph, native] = await Promise.all(LOOPS.map((loop) => twoRounds(loop, long)));
    // 以 langgraph 為基準：兩邊都沒搬時下面的 toEqual 也會綠，所以先釘 langgraph 真的搬了。
    expect(langgraph?.humans[0]?.[0]).toContain('/conversation_history/<id>');
    expect(native?.humans).toEqual(langgraph?.humans);
  });
});
