/**
 * native 模型那一串會改請求或回覆的格（#2416）：換模型、子代理跟隨、圖片省略、修工具參數、輸出上限、影子比對、歷史從日誌推、
 * 補懸空呼叫。每一格登記成一步（`model-call-step.ts` 的 `withModelCallStep`），root 由 native 在模型那一串原位直接呼叫，
 * 子代理在 native 下仍是 LangGraph 子圖（TODO(#2359)），經 `wrapModelCall`。
 *
 * 計數做法同 `recorder-cells.test.ts`：登記的那一步包一個計數；native 直接呼叫的那一支（`wrapModelCallFromStep`）包一層
 * `AsyncLocalStorage`，沒有那一層就是經 `wrapModelCall`。哪一邊照 state 的第一則訊息分。
 *
 * 換模型與子代理跟隨（`modelSelection`）、圖片省略（`modelLimits`）、影子比對與歷史從日誌推（`history`）只在給了對應選項時掛
 * （`fold.ts` 的槽位表），這裡都給；影子比對與從日誌推最多掛一顆，分兩輪。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { StateBackend } from 'deepagents';
import { fakeModel } from 'langchain';
import { describe, expect, it, vi } from 'vitest';

import type { AgentLoopKind } from '../agent-assembly.js';
import { assembleAgent } from '../agent-assembly.js';
import { fakePlugin, fakeTool } from '../fixtures.js';
import { foldRegistry } from '../fold.js';
import { loadPlugins } from '../load.js';
import { ModelSelectionController } from '../model-selection.js';
import type * as ModelCallStepModule from '../model-call-step.js';
import { SessionRegistry } from '../session-registry.js';

type Via = 'native' | 'hook';
type Count = Record<Via, number>;

/** `格名 › 哪一邊` → 兩條路各被叫了幾次。 */
const counts = vi.hoisted(() => new Map<string, Count>());

vi.mock('../model-call-step.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ModelCallStepModule>();
  const viaNative = new AsyncLocalStorage<true>();
  const sideOf = (request: unknown): string =>
    (request as { state?: { messages?: readonly BaseMessage[] } }).state?.messages?.[0]?.text ?? '';
  const withModelCallStep: typeof actual.withModelCallStep = (step, build) => {
    let name = '';
    const middleware = actual.withModelCallStep((request, next) => {
      const key = `${name} › ${sideOf(request)}`;
      const entry = counts.get(key) ?? { native: 0, hook: 0 };
      counts.set(key, entry);
      entry[(viaNative.getStore() === true ? 'native' : 'hook') satisfies Via] += 1;
      return step(request, (inner) => viaNative.exit(() => next(inner)));
    }, build);
    name = String((middleware as { name?: unknown }).name);
    return middleware;
  };
  const wrapModelCallFromStep = ((step: ModelCallStepModule.ModelCallStep) => {
    const wrap = actual.wrapModelCallFromStep(step);
    return (request: object, handler: (request: object) => unknown) =>
      viaNative.run(true, () => wrap(request, handler));
  }) as typeof actual.wrapModelCallFromStep;
  return { ...actual, withModelCallStep, wrapModelCallFromStep };
});

const ROOT_ONLY = ['nexusModelSelection', 'nexusImageOffload'];
const SUBAGENT_ONLY = ['nexusSubagentModelFollow'];
const SHARED = ['nexusInvalidToolArgs', 'nexusMaxTokens', 'patchToolCallsMiddleware'];
const CELLS = [...ROOT_ONLY, ...SUBAGENT_ONLY, ...SHARED, 'historyShadow', 'historyFromLog'];

const usage = { input_tokens: 3, output_tokens: 4, total_tokens: 7 };
const reply = (fields: ConstructorParameters<typeof AIMessage>[0] & object) =>
  new AIMessage({ ...fields, usage_metadata: usage });

async function run(loop: AgentLoopKind, history: 'shadow' | 'log') {
  counts.clear();
  const { registry } = await loadPlugins([
    fakePlugin('tools', (r) => {
      r.tools.register(fakeTool('alpha'));
    }),
  ]);
  const sessions = new SessionRegistry('t');
  registry.sessions.bind(sessions);
  const backend = new StateBackend();
  const params = foldRegistry(registry, {
    stepInbox: true,
    defaultBackend: backend,
    events: registry.dispatch,
    modelSelection: new ModelSelectionController({
      defaultRoute: { model: 'm' },
      instanceFor: () => undefined,
    }),
    modelLimits: () => undefined,
    history: history === 'shadow' ? { source: 'shadow', sink: { record() {} } } : { source: 'log' },
  });
  const model = fakeModel()
    .respond(reply({ content: '', tool_calls: [{ name: 'alpha', args: {}, id: 'root-alpha' }] }))
    .respond(
      reply({
        content: '',
        tool_calls: [
          {
            name: 'task',
            args: { description: '叫一下 alpha', subagent_type: 'general-purpose' },
            id: 'root-task',
          },
        ],
      }),
    )
    .respond(reply({ content: '', tool_calls: [{ name: 'alpha', args: {}, id: 'sub-alpha' }] }))
    .respond(reply({ content: '子代理好了' }))
    .respond(reply({ content: '好了' }));
  const agent = assembleAgent({
    ...params,
    model,
    backend: params.backend ?? backend,
    loop,
    events: registry.dispatch,
  });
  const state = await agent.invoke(
    { messages: [new HumanMessage('動手')] },
    { configurable: { thread_id: 't' } },
  );
  return state.messages as BaseMessage[];
}

const cellCounts = () =>
  Object.fromEntries(
    [...counts].filter(([key]) => CELLS.some((cell) => key.startsWith(`${cell} › `))).sort(),
  );

/** 這一輪預期的計數：root 三次、子代理兩次，`root` 那一邊由 `rootVia` 叫。 */
function expected(rootVia: Via, historyCell: string) {
  const root = { native: rootVia === 'native' ? 3 : 0, hook: rootVia === 'hook' ? 3 : 0 };
  const sub = { native: 0, hook: 2 };
  return Object.fromEntries(
    [
      ...[...ROOT_ONLY, historyCell].map((cell) => [`${cell} › 動手`, root] as const),
      ...SUBAGENT_ONLY.map((cell) => [`${cell} › 叫一下 alpha`, sub] as const),
      ...SHARED.flatMap((cell) => [
        [`${cell} › 動手`, root] as const,
        [`${cell} › 叫一下 alpha`, sub] as const,
      ]),
    ].sort(),
  );
}

describe('native 模型那一串改請求或回覆的格：root 由 native 原位呼叫、子代理經 wrapModelCall', () => {
  for (const history of ['shadow', 'log'] as const) {
    const historyCell = history === 'shadow' ? 'historyShadow' : 'historyFromLog';
    it(`native（${historyCell}）：root 三次都由 native 直接呼叫，子代理兩次都經 wrapModelCall`, async () => {
      const messages = await run('native', history);
      expect(messages.at(-1)?.text).toBe('好了');
      expect(cellCounts()).toEqual(expected('native', historyCell));
    });

    it(`langgraph（${historyCell}）：每一格都經 wrapModelCall`, async () => {
      const messages = await run('langgraph', history);
      expect(messages.at(-1)?.text).toBe('好了');
      expect(cellCounts()).toEqual(expected('hook', historyCell));
    });
  }
});
