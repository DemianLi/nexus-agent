/**
 * native 模型那一串只記錄、不改請求的七格（#2416）：中止閘門與檢查點的模型那一半、起訖、空回覆、用量、請求快照、綁中止訊號。
 * 每一格登記成一步（`model-call-step.ts` 的 `withModelCallStep`），root 與前景子代理都由 native 在模型那一串原位直接呼叫。
 *
 * 計數做法同 `summarizer-cell.test.ts`：登記的那一步包一個計數；native 直接呼叫的那一支（`wrapModelCallFromStep`）包一層
 * `AsyncLocalStorage`，沒有那一層就是經 `wrapModelCall`。哪一邊照 state 的第一則訊息分。
 *
 * 起訖紀錄器用 `AsyncLocalStorage` 把這次呼叫的範圍往內帶（`model-call-scope.ts` 的 `openModelCall`）：最後兩條比對兩個 loop
 * 的 root 日誌，用量與回覆指到的 `model/start` 要相同；請求快照（格式 55 起不帶識別）看位置，歸給它之後的第一顆 `model/start`。
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

const CELLS = [
  'nexusTurnCancel',
  'nexusModelCallEvents',
  'nexusEmptyResponse',
  'nexusModelUsage',
  'nexusSessionCheckpoint',
  'nexusRequestSnapshot',
  'nexusTurnCancelModelSignal',
];

const usage = { input_tokens: 3, output_tokens: 4, total_tokens: 7 };
const reply = (fields: ConstructorParameters<typeof AIMessage>[0] & object) =>
  new AIMessage({ ...fields, usage_metadata: usage });

async function run(loop: AgentLoopKind) {
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
  return { messages: state.messages as BaseMessage[], root: sessions.root };
}

const cellCounts = () =>
  Object.fromEntries(
    [...counts].filter(([key]) => CELLS.some((cell) => key.startsWith(`${cell} › `))).sort(),
  );

/** root 日誌上帶 `modelCall` 的事件：型別與指到第幾次 `model/start`（從 0 數）。 */
function attribution(root: Awaited<ReturnType<typeof run>>['root']) {
  const starts = root.events
    .filter((event) => event.type === 'model/start')
    .map((e) => Number(e.seq));
  return root.events.flatMap((event) => {
    const modelCall = (event.data as { modelCall?: unknown } | undefined)?.modelCall;
    if (typeof modelCall !== 'number') return [];
    return [`${event.type} → ${starts.indexOf(modelCall)}`];
  });
}

/** root 日誌上的請求快照：型別與它之後的第一顆 `model/start` 是第幾次（從 0 數），格式 55 起看位置。 */
function snapshotOwners(root: Awaited<ReturnType<typeof run>>['root']) {
  const starts = root.events.filter((event) => event.type === 'model/start');
  return root.events.flatMap((event) => {
    if (!event.type.startsWith('request/')) return [];
    return [`${event.type} → ${starts.findIndex((start) => start.seq > event.seq)}`];
  });
}

describe('native 模型那一串只記錄的七格：root 與前景子代理都由 native 原位呼叫', () => {
  it('每一格 root 三次、子代理兩次都由 native 直接呼叫', async () => {
    const { messages } = await run('native');
    expect(messages.at(-1)?.text).toBe('好了');
    const expected = Object.fromEntries(
      CELLS.flatMap((cell) => [
        [`${cell} › 動手`, { native: 3, hook: 0 }],
        [`${cell} › 叫一下 alpha`, { native: 2, hook: 0 }],
      ]).sort(),
    );
    expect(cellCounts()).toEqual(expected);
  });

  it('langgraph：每一格都經 wrapModelCall', async () => {
    await run('langgraph');
    const expected = Object.fromEntries(
      CELLS.flatMap((cell) => [
        [`${cell} › 動手`, { native: 0, hook: 3 }],
        [`${cell} › 叫一下 alpha`, { native: 0, hook: 2 }],
      ]).sort(),
    );
    expect(cellCounts()).toEqual(expected);
  });

  it('起訖帶進去的識別在 native 直接呼叫時不斷：root 日誌每一筆指到的 model/start 與 langgraph 相同', async () => {
    const native = attribution((await run('native')).root);
    const langgraph = attribution((await run('langgraph')).root);
    expect(native).toEqual(langgraph);
    // 三次 root 模型呼叫各有 `model/usage` 與 `model/end`，指到的都是自己那一次。
    for (const index of [0, 1, 2]) {
      expect(native).toContain(`model/usage → ${index}`);
      expect(native).toContain(`model/end → ${index}`);
    }
    expect(native.some((line) => line.endsWith('→ -1'))).toBe(false);
  });

  it('格式 55：第一顆 request/* 在 model/start 之前，快照照位置歸給同一次，兩個 loop 相同', async () => {
    const nativeRoot = (await run('native')).root;
    const langgraphRoot = (await run('langgraph')).root;
    for (const root of [nativeRoot, langgraphRoot]) {
      const types = root.events.map((event) => event.type);
      expect(types.findIndex((type) => type.startsWith('request/'))).toBeLessThan(
        types.indexOf('model/start'),
      );
    }
    const native = snapshotOwners(nativeRoot);
    expect(native).toEqual(snapshotOwners(langgraphRoot));
    expect(native).toEqual(['request/system → 0', 'request/header → 0']);
  });
});
