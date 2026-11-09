/**
 * 子代理的 `maxTurns`：native agent 自己數（`NativeAgentParams.maxTurns`）跟 langgraph 用的 `modelCallLimitMiddleware` 撞上限的那一刻要一樣：
 * 模型被叫了幾次、工具跑了幾次；`task` 拿回的那句兩個 loop 不同。
 *
 * afterAgent 跳回模型的那一次兩個 loop 都算：langgraph 下跳回的那一格是子代理自己帶的 middleware，排在上限那一顆之後，它的 afterAgent
 * 先跑、先跳，上限那一顆的歸零沒跑到；native 的計數每次 run 一份，跳回那次照樣加。這一次要是沒算進去，子代理會多叫一次模型。
 * 重試只算一次的那一條在 `apps/harness/src/subagent-config.test.ts`：重打只看 adapter 回報的失敗碼（`stream-retry.ts`），假模型拋的錯沒有碼、
 * 不會重打，要經真的 adapter 打假端點。
 */

import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { Command, MemorySaver } from '@langchain/langgraph';
import { StateBackend } from 'deepagents';
import { fakeModel } from 'langchain';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { assembleAgent } from './agent-assembly.js';
import { fakePlugin } from './fixtures.js';
import { foldRegistry } from './fold.js';
import { createHookStepMiddleware } from './hook-step.js';
import { loadPlugins } from './load.js';
import {
  interruptIds,
  LOOPS,
  type Loop,
  type LoopEvent,
} from './native-loop/human-input-loops.fixture.js';
import { subagentTurnLimitNote } from './subagent-turn-limit.js';

type Reply = AIMessage;

const poke = (id: string): AIMessage =>
  new AIMessage({ content: '', tool_calls: [{ name: 'poke', args: {}, id }] });
const delegate = new AIMessage({
  content: '',
  tool_calls: [
    { name: 'task', args: { description: '做', subagent_type: 'worker' }, id: 'task-1' },
  ],
});
const limitText = (n: number): string =>
  `Model call limits exceeded: run level call limit reached with ${n} model calls`;

/** afterAgent 第一次收尾時塞一則人話、跳回模型；之後照常收尾。 */
function jumpBackOnce() {
  let jumped = false;
  return createHookStepMiddleware({
    name: 'jump-back-once',
    afterAgent: {
      canJumpTo: ['model'],
      step: () => {
        if (jumped) return undefined;
        jumped = true;
        return { messages: [new HumanMessage('再看一次')], jumpTo: 'model' as const };
      },
    },
  });
}

interface Outcome {
  /** 模型被叫的次數，root 與子代理合計。 */
  readonly calls: number;
  readonly pokes: number;
  /** `task` 回給 root 的那則工具訊息。 */
  readonly task: string;
  readonly last: string;
}

async function run(
  loop: Loop,
  replies: readonly Reply[],
  options: { readonly maxTurns: number; readonly jumpBack?: boolean },
): Promise<Outcome> {
  let calls = 0;
  let pokes = 0;
  const { registry } = await loadPlugins([
    fakePlugin('worker', (r) => {
      r.tools.register(
        tool(
          () => {
            pokes += 1;
            return '戳了';
          },
          { name: 'poke', description: '戳一下。', schema: z.object({}) },
        ),
      );
      r.subagents.register({
        name: 'worker',
        description: '幹活的。',
        systemPrompt: '你是 worker。',
        maxTurns: options.maxTurns,
        ...(options.jumpBack === true && { middleware: [jumpBackOnce()] }),
      });
    }),
  ]);
  let model = fakeModel();
  for (const reply of replies) {
    model = model.respond(() => {
      calls += 1;
      return reply;
    });
  }
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
  }) as unknown as {
    invoke(input: unknown, config: object): Promise<{ messages: readonly unknown[] }>;
  };
  const result = await agent.invoke(
    { messages: [new HumanMessage('動手')] },
    { configurable: { thread_id: 't' } },
  );
  const task = result.messages.find(
    (message): message is ToolMessage => ToolMessage.isInstance(message) && message.name === 'task',
  );
  const last = result.messages.at(-1) as AIMessage;
  return { calls, pokes, task: task?.text ?? '', last: last.text };
}

/** 兩個 loop 各跑一次，回 [langgraph, native]。 */
const both = async (
  replies: readonly Reply[],
  options: Parameters<typeof run>[2],
): Promise<readonly Outcome[]> => Promise.all(LOOPS.map((loop) => run(loop, replies, options)));

describe('子代理 maxTurns：兩個 loop 撞上限的那一刻一樣', () => {
  // `task` 拿回的那句兩個 loop 不同：langgraph 照原版的英文（釘住它不變），native 是 `subagentTurnLimitReply`。
  it('子代理一直要叫工具：叫滿上限就收尾；task 拿回的，langgraph 是原版那句，native 只有上限說明', async () => {
    // 模型是 root 與子代理共用的一份腳本：子代理叫滿兩次之後，下一則輪到 root。
    const replies = [delegate, poke('p1'), poke('p2'), new AIMessage('root 收完')];
    const [langgraph, native] = await both(replies, { maxTurns: 2 });
    // root 一次、子代理兩次、root 收尾一次：子代理的第三次沒有發出去。
    expect(langgraph).toEqual({ calls: 4, pokes: 2, task: limitText(2), last: 'root 收完' });
    // 子代理兩則回覆都只有工具呼叫、沒有字，所以只有說明。
    expect(native).toEqual({ ...langgraph, task: subagentTurnLimitNote(2) });
  });

  it('afterAgent 跳回模型的那一次也算：跳回之後的下一步就撞上限', async () => {
    const replies = [
      delegate,
      poke('p1'),
      new AIMessage('子代理收完'),
      poke('p2'),
      new AIMessage('root 收完'),
      new AIMessage('多叫了一次'),
    ];
    const [langgraph, native] = await both(replies, { maxTurns: 3, jumpBack: true });
    // 子代理叫了三次：poke、收尾、跳回後的 poke。第三次算進去，所以下一步就撞上限，不會再叫第四次。
    expect(langgraph).toEqual({ calls: 5, pokes: 2, task: limitText(3), last: 'root 收完' });
    // 最後一則有字的回覆是跳回之前那句，接上說明。
    expect(native).toEqual({
      ...langgraph,
      task: `子代理收完\n\n${subagentTurnLimitNote(3)}`,
    });
  });
});

describe('native：前景子代理停在核准點、接回之後才撞上限', () => {
  it('task 拿回的仍是上限說明', async () => {
    const ran: string[] = [];
    const { registry } = await loadPlugins([
      fakePlugin('worker', (r) => {
        r.tools.register(
          tool(
            () => {
              ran.push('danger');
              return '做了';
            },
            { name: 'danger', description: '要核准。', schema: z.object({}) },
          ),
        );
        r.tools.register(
          tool(() => '戳了', { name: 'poke', description: '戳一下。', schema: z.object({}) }),
        );
        r.approvals.gate(async (exec, next) =>
          exec.name === 'danger' ? { kind: 'ask', reason: '要人核准' } : next(),
        );
        r.subagents.register({
          name: 'worker',
          description: '幹活的。',
          systemPrompt: '你是 worker。',
          maxTurns: 2,
        });
      }),
    ]);
    const model = fakeModel()
      .respond(delegate)
      .respond(new AIMessage({ content: '', tool_calls: [{ name: 'danger', args: {}, id: 's1' }] }))
      .respond(poke('s2'))
      .respond(new AIMessage('root 收完'));
    const backend = new StateBackend();
    const checkpointer = new MemorySaver();
    const params = foldRegistry(registry, {
      summarization: false,
      defaultBackend: backend,
      events: registry.dispatch,
      checkpointer,
      loop: 'native',
    });
    const agent = assembleAgent({
      ...params,
      model,
      backend: params.backend ?? backend,
      checkpointer,
      loop: 'native',
      events: registry.dispatch,
    }) as unknown as {
      streamEvents(input: unknown, config: object): Promise<AsyncIterable<LoopEvent>>;
      getState(config: object): Promise<{ values: { messages: readonly unknown[] } }>;
    };
    const options = { version: 'v3', configurable: { thread_id: 't' } };
    const drain = async (input: unknown): Promise<LoopEvent[]> => {
      const events: LoopEvent[] = [];
      for await (const event of await agent.streamEvents(input, options)) events.push(event);
      return events;
    };

    const parked = await drain({ messages: [new HumanMessage('動手')] });
    const ids = interruptIds(parked);
    expect(ids).toHaveLength(1);
    expect(ran).toEqual([]);
    await drain(new Command({ resume: { [ids[0]!]: { decisions: [{ type: 'approve' }] } } }));

    expect(ran).toEqual(['danger']);
    expect(model.calls).toHaveLength(4);
    const { messages } = (await agent.getState(options)).values;
    const task = messages.find(
      (message): message is ToolMessage =>
        ToolMessage.isInstance(message) && message.name === 'task',
    );
    expect(task?.text).toBe(subagentTurnLimitNote(2));
  });
});
