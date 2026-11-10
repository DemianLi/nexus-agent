/**
 * native 的前景子代理往共用派發面派哪幾個 agent 事件：`agent/pre-step` 只有 root 派（`docs/plugin-contract.md`）、
 * `agent/turn-stopping` 只有 root 派（`agent.ts` 的 `stepEvents`），子代理的步驟都不派；`llm/stream` 與 `agent/request-error` 子代理照派（串流重打、重試的監聽者要接得到子代理那一次模型呼叫）。
 *
 * 一輪是：root 委派 → 子代理叫一次模型，第一次失敗、重試監聽者回 `retry`、第二次回話 → root 收尾。root 兩步、子代理一步。
 */

import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { StateBackend } from 'deepagents';
import { fakeModel as langchainFakeModel } from 'langchain';
import { describe, expect, it } from 'vitest';

import { assembleAgent } from '../agent-assembly.js';
import { fakeModel, fakePlugin } from '../fixtures.js';
import { foldRegistry } from '../fold.js';
import { loadPlugins } from '../load.js';

type Counted = 'agent/pre-step' | 'agent/turn-stopping' | 'llm/stream' | 'agent/request-error';

async function run(): Promise<Record<Counted, number>> {
  const counts: Record<Counted, number> = {
    'agent/pre-step': 0,
    'agent/turn-stopping': 0,
    'llm/stream': 0,
    'agent/request-error': 0,
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
      r.events.on('agent/request-error', async (_payload, next) => {
        counts['agent/request-error'] += 1;
        return counts['agent/request-error'] === 1 ? { kind: 'retry' as const } : next();
      });
    }),
  ]);
  const backend = new StateBackend();
  const params = foldRegistry(registry, {
    summarization: false,
    defaultBackend: backend,
    events: registry.dispatch,
    loop: 'native',
  });
  const agent = assembleAgent({
    ...params,
    model: fakeModel()
      .respondWithTools([
        { name: 'task', args: { description: '做', subagent_type: 'general-purpose' }, id: 'r1' },
      ])
      .respond(() => new Error('子代理那一次斷了'))
      .respond(new AIMessage('子代理收完'))
      .respond(new AIMessage('root 收完')),
    backend: params.backend ?? backend,
    loop: 'native',
    events: registry.dispatch,
  }) as unknown as { invoke(input: unknown, config: object): Promise<unknown> };
  const result = await agent.invoke(
    { messages: [new HumanMessage('動手')] },
    { configurable: { thread_id: 't' } },
  );
  expect(JSON.stringify(result)).toContain('root 收完');
  return counts;
}

describe('native 前景子代理的步驟往共用派發面派的事件', () => {
  it('pre-step、turn-stopping 只有 root 的；llm/stream、request-error 子代理也派', async () => {
    expect(await run()).toEqual({
      // root 兩步。
      'agent/pre-step': 2,
      // root 收尾一次。
      'agent/turn-stopping': 1,
      // root 兩次，子代理失敗的那一次與重試的那一次。
      'llm/stream': 4,
      // 只有子代理那一次失敗。
      'agent/request-error': 1,
    });
  });
});

/** 不讀 `configurable` 的模型（`langchain` 原本的 `fakeModel`）跑一輪：回 `llm/stream` 的派發次數或拋出來的錯。 */
async function runUncooperative(loop: 'native' | 'langgraph'): Promise<number> {
  let streams = 0;
  const { registry } = await loadPlugins([
    fakePlugin('listeners', (r) => {
      r.events.on('llm/stream', (_payload, next) => {
        streams += 1;
        return next();
      });
    }),
  ]);
  const backend = new StateBackend();
  const params = foldRegistry(registry, {
    summarization: false,
    defaultBackend: backend,
    events: registry.dispatch,
    loop,
  });
  const agent = assembleAgent({
    ...params,
    model: langchainFakeModel().respond(new AIMessage('收完')),
    backend: params.backend ?? backend,
    loop,
    events: registry.dispatch,
  }) as unknown as { invoke(input: unknown, config: object): Promise<unknown> };
  await agent.invoke(
    { messages: [new HumanMessage('動手')] },
    { configurable: { thread_id: 't' } },
  );
  return streams;
}

describe('模型沒有接上 llm/stream', () => {
  it('native：拋錯，訊息指名模型類別與要做的事', async () => {
    const thrown = await runUncooperative('native').then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(thrown?.message).toContain('FakeBuiltModel');
    expect(thrown?.message).toContain('configurable["__nexus_llm_stream"]');
    expect(thrown?.message).toContain('包住');
  });

  it('langgraph：不帶環繞函式、不檢查，llm/stream 一次都不派', async () => {
    expect(await runUncooperative('langgraph')).toBe(0);
  });
});
