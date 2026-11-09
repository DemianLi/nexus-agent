/**
 * native 的系統提示那幾格（#2416）：登記了一步的（`system-prompt-step.ts` 的 `withSystemPromptStep`），root 與前景子代理都由 native 在模型那一串
 * 原位直接呼叫那一步、不經那顆的 `wrapModelCall`。
 *
 * 計數掛在登記上，做法同 `hook-cells.test.ts`：登記的那一步包一個計數，交給那顆的 `wrapModelCall` 再包一層 `AsyncLocalStorage`。
 * 跑一輪「root 叫工具 → 委派子代理、子代理叫工具」，數每一格在 root 與子代理各被叫了幾次。哪一邊照 state 的第一則訊息分。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { StateBackend } from 'deepagents';
import { createMiddleware, fakeModel } from 'langchain';
import { describe, expect, it, vi } from 'vitest';

import { assembleAgent } from '../agent-assembly.js';
import { fakePlugin, fakeTool } from '../fixtures.js';
import { foldRegistry } from '../fold.js';
import { loadPlugins } from '../load.js';
import { MIDDLE_SECTION_ORDERS } from '../prompt-sections.js';
import type * as SystemPromptStepModule from '../system-prompt-step.js';

type Via = 'native' | 'hook';

/** 每一格（middleware 的名字）在哪一邊（照 state 的第一則訊息）各被叫了幾次，分成兩條路。 */
const counts = vi.hoisted(() => new Map<string, Map<string, Record<Via, number>>>());

vi.mock('../system-prompt-step.js', async (importOriginal) => {
  const actual = await importOriginal<typeof SystemPromptStepModule>();
  const viaHook = new AsyncLocalStorage<true>();
  const sideOf = (request: unknown): string =>
    (request as { state?: { messages?: readonly BaseMessage[] } }).state?.messages?.[0]?.text ?? '';
  const bump = (cell: string, request: unknown): void => {
    let bySide = counts.get(cell);
    if (bySide === undefined) counts.set(cell, (bySide = new Map()));
    const side = sideOf(request);
    const entry = bySide.get(side) ?? { native: 0, hook: 0 };
    entry[viaHook.getStore() === true ? 'hook' : 'native'] += 1;
    bySide.set(side, entry);
  };
  const withSystemPromptStep: typeof actual.withSystemPromptStep = (cell, build) => {
    let name = '';
    const counted = {
      ...cell,
      step: (request: Parameters<typeof cell.step>[0]) => {
        bump(name, request);
        return cell.step(request);
      },
    };
    const middleware = actual.withSystemPromptStep(counted, (wrapModelCall) =>
      build(((request: never, handler: never) =>
        viaHook.run(true, () => wrapModelCall(request, handler))) as typeof wrapModelCall),
    );
    name = (middleware as { name?: string }).name ?? '';
    return middleware;
  };
  const createSystemPromptStepMiddleware: typeof actual.createSystemPromptStepMiddleware = (
    name,
    cell,
  ) =>
    withSystemPromptStep(
      cell,
      (wrapModelCall) => createMiddleware({ name, wrapModelCall: wrapModelCall as never }) as never,
    );
  return { ...actual, withSystemPromptStep, createSystemPromptStepMiddleware };
});

async function run() {
  counts.clear();
  const { registry } = await loadPlugins([
    fakePlugin('tools', (r) => {
      r.tools.register(fakeTool('alpha'));
      r.skills.addSource('/skills/');
      r.memory.addSource('/AGENTS.md');
      r.prompt.section({
        name: 'tools:plan',
        order: MIDDLE_SECTION_ORDERS.PLAN_POLICY,
        text: '計劃',
      });
      r.prompt.section({
        name: 'tools:policy',
        order: MIDDLE_SECTION_ORDERS.PLUGIN_POLICY,
        text: '政策',
      });
    }),
  ]);
  const backend = new StateBackend();
  const params = foldRegistry(registry, {
    summarization: false,
    stepInbox: true,
    defaultBackend: backend,
    events: registry.dispatch,
  });
  const model = fakeModel()
    .respondWithTools([{ name: 'alpha', args: {}, id: 'root-alpha' }])
    .respondWithTools([
      {
        name: 'task',
        args: { description: '叫一下 alpha', subagent_type: 'general-purpose' },
        id: 'root-task',
      },
    ])
    .respondWithTools([{ name: 'alpha', args: {}, id: 'sub-alpha' }])
    .respond(new AIMessage('子代理好了'))
    .respond(new AIMessage('好了'));
  const agent = assembleAgent({
    ...params,
    model,
    backend: params.backend ?? backend,
    loop: 'native',
    events: registry.dispatch,
  });
  const state = await agent.invoke(
    { messages: [new HumanMessage('動手')] },
    { configurable: { thread_id: 't' } },
  );
  return { messages: state.messages };
}

/** 這一邊每一格的次數。 */
const countsOn = (side: string) =>
  Object.fromEntries(
    [...counts]
      .filter(([, bySide]) => bySide.has(side))
      .map(([cell, bySide]) => [cell, bySide.get(side)]),
  );

describe('native 的系統提示那幾格：root 與前景子代理都由 native 原位呼叫', () => {
  it('root：每一格都由 native 直接呼叫那一步，經 wrapModelCall 一次都沒有', async () => {
    const { messages } = await run();
    expect(messages.at(-1)?.text).toBe('好了');
    expect(countsOn('動手')).toMatchInlineSnapshot(`
      {
        "MemoryMiddleware": {
          "hook": 0,
          "native": 3,
        },
        "SkillsMiddleware": {
          "hook": 0,
          "native": 3,
        },
        "nexusApprovalPolicyPrompt": {
          "hook": 0,
          "native": 3,
        },
        "nexusPromptSections:observation": {
          "hook": 0,
          "native": 3,
        },
        "nexusPromptSections:plugins": {
          "hook": 0,
          "native": 3,
        },
        "nexusPromptSections:prepended": {
          "hook": 0,
          "native": 3,
        },
      }
    `);
  });

  it('子代理：每一格都由 native 直接呼叫那一步，經 wrapModelCall 一次都沒有', async () => {
    await run();
    expect(countsOn('叫一下 alpha')).toMatchInlineSnapshot(`
      {
        "SkillsMiddleware": {
          "hook": 0,
          "native": 2,
        },
        "nexusApprovalPolicyPrompt": {
          "hook": 0,
          "native": 2,
        },
        "nexusPromptSections:observation": {
          "hook": 0,
          "native": 2,
        },
        "nexusPromptSections:plugins": {
          "hook": 0,
          "native": 2,
        },
        "nexusPromptSections:prepended": {
          "hook": 0,
          "native": 2,
        },
        "nexusSubagentDelegation": {
          "hook": 0,
          "native": 2,
        },
      }
    `);
  });
});
