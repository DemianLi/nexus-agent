/**
 * harness 的兩格在 native 的模型那一串上（#2416）：host-tools、background-delegation 都登記了工具清單那一步（`@nexus/core` 的
 * `withToolListStep`），root 由 native 直接呼叫那一步、不經那顆的 `wrapModelCall`；子代理在 native 下仍是 LangGraph 子圖（TODO(#2359)），
 * 照舊經 `wrapModelCall`。`langgraph` 兩邊都經 `wrapModelCall`。
 *
 * 計數掛在登記上：從 `@nexus/core` 登記的每一顆，那一步與那顆的 `wrapModelCall` 各包一個計數。走 `createCliAgent` 的真組裝，跑一輪
 * 「root 叫 `ls` → root 前景委派 `worker` → worker 叫 `ls` → 回答」，數每一格在 root 與子代理的模型呼叫各被叫了幾次。
 * 哪一邊照請求的第一則訊息分：root 是「動手」，子代理是委派的描述。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import * as core from '@nexus/core';
import type { PluginEntry, ToolListStep } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCliAgent } from './assembly-root.js';
import { BACKGROUND_DELEGATION_MIDDLEWARE_NAME } from './background-delegation.js';
import { shippedPlugins, withScriptedModel } from './fixtures.js';
import { createHostToolsSlot, HOST_TOOLS_MIDDLEWARE_NAME, hostToolsEntry } from './host-tools.js';
import { ScriptedChatModel } from './scripted-model.js';

type Via = 'native' | 'wrapModelCall';

/** 每一格（照名字）在哪一邊（照請求的第一則訊息）各被叫了幾次，分成兩條路。 */
const counts = vi.hoisted(
  () => new Map<string, Map<string, Record<'native' | 'wrapModelCall', number>>>(),
);

vi.mock('@nexus/core', async (importOriginal) => {
  const actual = await importOriginal<typeof core>();
  const sideOf = (request: unknown): string =>
    (request as { messages?: readonly BaseMessage[] }).messages?.[0]?.text ?? '';
  const bump = (name: string, request: unknown, via: Via): void => {
    let bySide = counts.get(name);
    if (bySide === undefined) counts.set(name, (bySide = new Map()));
    const side = sideOf(request);
    const entry = bySide.get(side) ?? { native: 0, wrapModelCall: 0 };
    entry[via] += 1;
    bySide.set(side, entry);
  };
  const withToolListStep: typeof actual.withToolListStep = (middleware, step, inner) => {
    const target = middleware as unknown as {
      name: string;
      wrapModelCall: (request: unknown, handler: unknown) => unknown;
    };
    const wrap = target.wrapModelCall;
    target.wrapModelCall = (request, handler) => {
      bump(target.name, request, 'wrapModelCall');
      return wrap(request, handler);
    };
    return actual.withToolListStep(
      middleware,
      (request) => {
        bump(target.name, request, 'native');
        return step(request);
      },
      inner,
    );
  };
  return {
    ...actual,
    withToolListStep,
    createToolListStepMiddleware: (name: string, step: ToolListStep) =>
      withToolListStep(actual.createToolListStepMiddleware(name, step), step),
  };
});

const shipped = await shippedPlugins();

const CELLS = [BACKGROUND_DELEGATION_MIDDLEWARE_NAME, HOST_TOOLS_MIDDLEWARE_NAME] as const;
const ROOT = '動手';
const SUBAGENT = '叫一下 ls';

const worker: PluginEntry = {
  plugin: {
    name: 'worker-host',
    apply(registry) {
      registry.subagents.register({
        name: 'worker',
        description: '幹活的。',
        systemPrompt: '你是 worker。',
        model: new ScriptedChatModel({
          turns: [
            { content: '', toolCalls: [{ name: 'ls', args: { path: '/' }, id: 'sub-ls' }] },
            { content: '子代理好了' },
          ],
        }),
      });
    },
  },
};

let workspace: string;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'nexus-plugin-tool-list-cells-'));
  counts.clear();
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

async function run(loop: 'native' | 'langgraph') {
  const built = await createCliAgent(
    {
      live: false,
      workspace,
      sandbox: 'workspace-write',
      agentLoop: loop,
      backgroundSubagents: { maxActive: 2 },
    },
    withScriptedModel(
      [...shipped, worker, hostToolsEntry(createHostToolsSlot())],
      [
        { content: '', toolCalls: [{ name: 'ls', args: { path: '/' }, id: 'root-ls' }] },
        {
          content: '',
          toolCalls: [
            {
              name: 'subagent',
              args: { description: SUBAGENT, subagent_type: 'worker', run_in_background: false },
              id: 'root-sub',
            },
          ],
        },
        { content: '好了' },
      ],
    ),
    workspace,
  );
  const sessions = new core.SessionRegistry('root-1');
  const detach = built.attachSession(sessions);
  try {
    const state = (await built.agent.invoke(
      { messages: [new HumanMessage(ROOT)] },
      { configurable: { thread_id: 'plugin-tool-list-cells' } },
    )) as { messages: BaseMessage[] };
    return state.messages;
  } finally {
    detach();
    await built.dispose();
  }
}

describe.each(['native', 'langgraph'] as const)(
  '%s：harness 的兩格每次模型呼叫只跑一次',
  (loop) => {
    it('root 的三次與子代理的兩次模型呼叫：每一格各跑一次，走對的那一條路', async () => {
      const messages = await run(loop);
      expect(messages.at(-1)?.text).toBe('好了');
      const root =
        loop === 'native' ? { native: 3, wrapModelCall: 0 } : { native: 0, wrapModelCall: 3 };
      for (const cell of CELLS) {
        expect([cell, counts.get(cell)?.get(ROOT)]).toEqual([cell, root]);
        expect([cell, counts.get(cell)?.get(SUBAGENT)]).toEqual([
          cell,
          { native: 0, wrapModelCall: 2 },
        ]);
      }
    });
  },
);
