/**
 * native agent 自己數子代理的模型呼叫（`NativeAgentParams.maxTurns`）：撞上限的那一刻、怎麼告訴呼叫端、什麼不算。
 * 兩個 loop 撞上限的那一刻一樣，由 `../subagent-max-turns.test.ts` 經組裝比；這裡釘只有 native 才有的部分。
 */

import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { tool } from '@langchain/core/tools';
import { fakeModel } from '../fixtures.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { EventBus } from '../events.js';
import { createHookStepMiddleware } from '../hook-step.js';
import { createNativeAgent, RUN_STOP_CONFIG_KEY, type RunStopReason } from './agent.js';

const poke = (id: string): AIMessage =>
  new AIMessage({ content: '', tool_calls: [{ name: 'poke', args: {}, id }] });

function harness(options: {
  readonly replies: readonly (AIMessage | Error)[];
  readonly maxTurns: number;
  readonly middleware?: readonly unknown[];
  readonly retryOnce?: boolean;
}) {
  const seen: { pokes: number; keys: string[][] } = { pokes: 0, keys: [] };
  const pokeTool = tool(
    (_input: unknown, config: RunnableConfig) => {
      seen.pokes += 1;
      seen.keys.push(Object.keys(config.configurable ?? {}));
      return '戳了';
    },
    { name: 'poke', description: '戳一下。', schema: z.object({}) },
  );
  let model = fakeModel();
  for (const reply of options.replies) model = model.respond(reply);
  const events = new EventBus();
  if (options.retryOnce === true) {
    let retried = false;
    events.on('agent/request-error', async (_payload, next) => {
      if (retried) return next();
      retried = true;
      return { kind: 'retry' as const };
    });
  }
  const agent = createNativeAgent({
    model,
    tools: [pokeTool],
    middleware: options.middleware ?? [],
    events,
    background: true,
    maxTurns: options.maxTurns,
  });
  const stops: RunStopReason[] = [];
  const run = async (text: string) =>
    (await agent.invoke(
      { messages: [new HumanMessage(text)] },
      {
        configurable: {
          thread_id: 'bg',
          [RUN_STOP_CONFIG_KEY]: (reason: RunStopReason) => stops.push(reason),
        },
      },
    )) as { messages: BaseMessage[] };
  return { model, seen, stops, run };
}

const texts = (messages: readonly BaseMessage[]): string[] =>
  messages.map((m) => `${m.type}:${m.text}`);

describe('native agent 的 maxTurns', () => {
  it('叫滿上限就在下一次叫模型之前收：不合成訊息，告訴呼叫端一次', async () => {
    const h = harness({ replies: [poke('a'), poke('b'), poke('c')], maxTurns: 2 });
    const result = await h.run('動手');
    expect(h.model.calls).toHaveLength(2);
    expect(h.seen.pokes).toBe(2);
    expect(texts(result.messages)).toEqual(['human:動手', 'ai:', 'tool:戳了', 'ai:', 'tool:戳了']);
    expect(h.stops).toEqual([{ kind: 'max-turns', limit: 2 }]);
  });

  it('沒撞上限就不告訴呼叫端', async () => {
    const h = harness({ replies: [poke('a'), new AIMessage('做完了')], maxTurns: 2 });
    const result = await h.run('動手');
    expect(texts(result.messages).at(-1)).toBe('ai:做完了');
    expect(h.stops).toEqual([]);
  });

  it('每次 run 重算：撞過上限的 thread 下一次 run 照樣叫模型', async () => {
    const h = harness({ replies: [poke('a'), new AIMessage('第二輪')], maxTurns: 1 });
    await h.run('一');
    const second = await h.run('二');
    expect(h.model.calls).toHaveLength(2);
    expect(texts(second.messages).slice(-2)).toEqual(['human:二', 'ai:第二輪']);
    expect(h.stops).toEqual([{ kind: 'max-turns', limit: 1 }]);
  });

  it('重試成功只算一次', async () => {
    const h = harness({
      replies: [new Error('斷了'), poke('a'), poke('b')],
      maxTurns: 2,
      retryOnce: true,
    });
    await h.run('動手');
    // 失敗的那一次不算：成功回來的兩次叫滿上限。
    expect(h.model.calls).toHaveLength(3);
    expect(h.seen.pokes).toBe(2);
    expect(h.stops).toEqual([{ kind: 'max-turns', limit: 2 }]);
  });

  it('afterAgent 跳回模型的那一次不受上限擋，之後的下一步才收', async () => {
    let jumped = false;
    const jumpBack = createHookStepMiddleware({
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
    const h = harness({
      replies: [new AIMessage('好了'), poke('a'), poke('b')],
      maxTurns: 1,
      middleware: [jumpBack],
    });
    await h.run('動手');
    // 第一次回話就收、afterAgent 跳回：第二次不受擋（已叫滿 1 次），它要工具，工具跑完之後的下一步才收。
    expect(h.model.calls).toHaveLength(2);
    expect(h.seen.pokes).toBe(1);
    expect(h.stops).toEqual([{ kind: 'max-turns', limit: 1 }]);
  });

  it('收尾理由的回呼只給這一次 run：節點的 config 上沒有這把鍵', async () => {
    const h = harness({ replies: [poke('a'), new AIMessage('好了')], maxTurns: 3 });
    await h.run('動手');
    expect(h.seen.keys).toHaveLength(1);
    expect(h.seen.keys[0]).not.toContain(RUN_STOP_CONFIG_KEY);
  });

  it('root 給 maxTurns 在建構時拋', () => {
    expect(() =>
      createNativeAgent({ model: fakeModel(), tools: [], middleware: [], maxTurns: 1 }),
    ).toThrow(/maxTurns 只給子代理/);
  });
});
