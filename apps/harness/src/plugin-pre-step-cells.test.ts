/**
 * 四位 pre-step listener 的 `beforeAgent`（#2416）：宿主替每位建的那一顆登記了一步（`@nexus/core` 的 `createHookStepMiddleware`），
 * `native` 下 root、前景與背景子代理都由 native 在原位直接呼叫那一步、不經那顆的 hook；`langgraph` 全部經 hook。
 *
 * 計數掛在登記上：宿主經 `@nexus/core` 造的每一顆（core 自己造的不經這個 mock），登記的那一步包一個計數，那顆的 hook 再包一層 `AsyncLocalStorage`，經 hook 進來的叫用落在
 * 那一層裡面，native 直接呼叫登記的那一步則在外面。走 `createCliAgent` 的真組裝，跑一輪「root 前景委派 `worker` → 背景委派 `worker` →
 * 回答」，數每一位在 root、前景子代理、背景子代理各被叫了幾次。哪一邊照 state 的第一則訊息的第一段分：root 是「動手」，子代理是委派的描述。
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import * as core from '@nexus/core';
import type { PluginEntry } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCliAgent } from './assembly-root.js';
import { shippedPlugins, withScriptedModel } from './fixtures.js';
import { createHostToolsSlot, hostToolsEntry } from './host-tools.js';
import { ScriptedChatModel } from './scripted-model.js';

type Via = 'native' | 'hook';

/** 每一位（照名字）在哪一邊（照 state 的第一則訊息）各被叫了幾次，分成兩條路。 */
const counts = vi.hoisted(() => new Map<string, Map<string, Record<Via, number>>>());

vi.mock('@nexus/core', async (importOriginal) => {
  const actual = await importOriginal<typeof core>();
  const viaHook = new AsyncLocalStorage<true>();
  // 背景子代理的第一則是描述再接宿主補的回報提示（空一行），只取描述那段。
  const sideOf = (state: unknown): string =>
    ((state as { messages?: readonly BaseMessage[] } | null)?.messages?.[0]?.text ?? '').split(
      '\n\n',
    )[0]!;
  const bump = (name: string, state: unknown): void => {
    let bySide = counts.get(name);
    if (bySide === undefined) counts.set(name, (bySide = new Map()));
    const side = sideOf(state);
    const entry = bySide.get(side) ?? { native: 0, hook: 0 };
    entry[viaHook.getStore() === true ? 'hook' : 'native'] += 1;
    bySide.set(side, entry);
  };
  const createHookStepMiddleware: typeof actual.createHookStepMiddleware = (options) => {
    const step = options.beforeAgent;
    if (typeof step !== 'function') throw new Error('宿主的 pre-step 那一顆只給 beforeAgent 一步');
    const middleware = actual.createHookStepMiddleware({
      ...options,
      beforeAgent: (state, runtime) => {
        bump(options.name, state);
        return step(state, runtime);
      },
    });
    const target = middleware as unknown as {
      beforeAgent: (state: unknown, runtime: unknown) => unknown;
    };
    const hook = target.beforeAgent;
    target.beforeAgent = (state, runtime) => viaHook.run(true, () => hook(state, runtime));
    return middleware;
  };
  return { ...actual, createHookStepMiddleware };
});

const shipped = await shippedPlugins();

const ROOT = '動手';
const FOREGROUND = '叫一下';
const BACKGROUND = '背景叫一下';

const worker: PluginEntry = {
  plugin: {
    name: 'worker-host',
    apply(registry) {
      registry.subagents.register({
        name: 'worker',
        description: '幹活的。',
        systemPrompt: '你是 worker。',
        model: new ScriptedChatModel({
          turns: [{ content: '子代理好了' }, { content: '背景好了' }],
        }),
      });
    },
  },
};

let workspace: string;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'nexus-plugin-pre-step-cells-'));
  counts.clear();
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/** 這一邊每一位的次數。 */
const countsOn = (side: string) =>
  Object.fromEntries(
    [...counts]
      .filter(([, bySide]) => bySide.has(side))
      .map(([name, bySide]) => [name, bySide.get(side)]),
  );

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
        {
          content: '',
          toolCalls: [
            {
              name: 'subagent',
              args: { description: FOREGROUND, subagent_type: 'worker', run_in_background: false },
              id: 'root-fg',
            },
          ],
        },
        {
          content: '',
          toolCalls: [
            {
              name: 'subagent',
              args: { description: BACKGROUND, subagent_type: 'worker', run_in_background: true },
              id: 'root-bg',
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
      { configurable: { thread_id: 'plugin-pre-step-cells' } },
    )) as { messages: BaseMessage[] };
    // 背景那條在 root 回完之後才跑完：等每一位都在背景那一邊記到一次。
    await vi.waitFor(() => {
      expect(Object.keys(countsOn(BACKGROUND))).toEqual(Object.keys(countsOn(ROOT)));
    });
    return state.messages;
  } finally {
    detach();
    await built.dispose();
  }
}

describe.each(['native', 'langgraph'] as const)(
  '%s：四位 pre-step listener 每次 invoke 只跑一次',
  (loop) => {
    it('root、前景與背景子代理都走對的那一條路', async () => {
      const messages = await run(loop);
      expect(messages.at(-1)?.text).toBe('好了');
      const root = loop === 'native' ? { native: 1, hook: 0 } : { native: 0, hook: 1 };
      const names = Object.keys(countsOn(ROOT));
      expect(names).toMatchInlineSnapshot(`
        [
          "AgentInstructionsMiddleware",
          "SkillInvocationMiddleware",
          "TimeContextMiddleware",
          "nexusApprovalPolicyNotice",
        ]
      `);
      for (const name of names) {
        expect([name, countsOn(ROOT)[name]]).toEqual([name, root]);
        expect([name, countsOn(FOREGROUND)[name]]).toEqual([name, root]);
        expect([name, countsOn(BACKGROUND)[name]]).toEqual([name, root]);
      }
    });
  },
);
