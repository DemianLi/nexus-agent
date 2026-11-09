/**
 * native 的 `beforeAgent`／`beforeModel`／`afterAgent`（#2416）：登記了一步的 hook（`hook-step.ts` 的 `createHookStepMiddleware`），
 * root 由 native 在原位直接呼叫那一步、不經那顆的 hook；子代理在 native 下仍是 LangGraph 子圖（TODO(#2359)），照舊經 hook。
 *
 * 計數掛在登記上：每一顆經 `createHookStepMiddleware` 造的，登記的那一步包一個計數，那顆的 hook 再包一層 `AsyncLocalStorage`。
 * 經 hook 進來的叫用落在那一層裡面，native 直接呼叫登記的那一步則在外面，所以同一個計數分得出兩條路。跑一輪「root 叫工具 →
 * 委派子代理、子代理叫工具」，數每一格在 root 與子代理各被叫了幾次。哪一邊照 state 的第一則訊息分：root 是「動手」，子代理是委派的描述。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { StateBackend } from 'deepagents';
import { fakeModel } from 'langchain';
import { describe, expect, it, vi } from 'vitest';

import { assembleAgent } from '../agent-assembly.js';
import { fakePlugin, fakeTool } from '../fixtures.js';
import { foldRegistry } from '../fold.js';
import type * as HookStepModule from '../hook-step.js';
import { loadPlugins } from '../load.js';

type Via = 'native' | 'hook';

/** 每一格（`名字.hook`）在哪一邊（照 state 的第一則訊息）各被叫了幾次，分成兩條路。 */
const counts = vi.hoisted(() => new Map<string, Map<string, Record<Via, number>>>());

vi.mock('../hook-step.js', async (importOriginal) => {
  const actual = await importOriginal<typeof HookStepModule>();
  const viaHook = new AsyncLocalStorage<true>();
  const sideOf = (state: unknown): string =>
    (state as { messages?: readonly BaseMessage[] } | null)?.messages?.[0]?.text ?? '';
  const bump = (cell: string, state: unknown): void => {
    let bySide = counts.get(cell);
    if (bySide === undefined) counts.set(cell, (bySide = new Map()));
    const side = sideOf(state);
    const entry = bySide.get(side) ?? { native: 0, hook: 0 };
    entry[viaHook.getStore() === true ? 'hook' : 'native'] += 1;
    bySide.set(side, entry);
  };
  const createHookStepMiddleware: typeof actual.createHookStepMiddleware = (options) => {
    const counted: Record<string, unknown> = { ...options };
    for (const kind of actual.HOOK_KINDS) {
      const spec = options[kind];
      if (spec === undefined) continue;
      const cell = typeof spec === 'function' ? { step: spec } : spec;
      counted[kind] = {
        ...cell,
        step: (state: unknown, runtime: unknown) => {
          bump(`${options.name}.${kind}`, state);
          return cell.step(state, runtime);
        },
      };
    }
    const middleware = actual.createHookStepMiddleware(counted as typeof options);
    const target = middleware as unknown as Record<string, unknown>;
    for (const kind of actual.HOOK_KINDS) {
      const hook = target[kind] as
        | ((state: unknown, runtime: unknown) => unknown)
        | { hook: (state: unknown, runtime: unknown) => unknown; canJumpTo: readonly string[] }
        | undefined;
      if (hook === undefined) continue;
      const fn = typeof hook === 'function' ? hook : hook.hook;
      const wrapped = (state: unknown, runtime: unknown): unknown =>
        viaHook.run(true, () => fn(state, runtime));
      target[kind] = typeof hook === 'function' ? wrapped : { ...hook, hook: wrapped };
    }
    return middleware;
  };
  return { ...actual, createHookStepMiddleware };
});

async function run() {
  counts.clear();
  const { registry } = await loadPlugins([
    fakePlugin('tools', (r) => {
      r.tools.register(fakeTool('alpha'));
      r.skills.addSource('/skills/');
      r.memory.addSource('/AGENTS.md');
    }),
  ]);
  const backend = new StateBackend();
  // 只在有設定時才掛的那幾格（插話、skills、記憶）全打開；重複提醒照預設開著。
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

const ROOT = '動手';
const SUBAGENT = '叫一下 alpha';

/** 這一邊每一格的次數。 */
const countsOn = (side: string) =>
  Object.fromEntries(
    [...counts]
      .filter(([, bySide]) => bySide.has(side))
      .map(([cell, bySide]) => [cell, bySide.get(side)]),
  );

describe('native 的 hook：登記了一步的格，root 由 native 原位呼叫、子代理經 hook', () => {
  it('root：每一格都由 native 直接呼叫那一步，經 hook 一次都沒有', async () => {
    const { messages } = await run();
    expect(messages.at(-1)?.text).toBe('好了');
    expect(countsOn(ROOT)).toMatchInlineSnapshot(`
      {
        "MemoryMiddleware.beforeAgent": {
          "hook": 0,
          "native": 1,
        },
        "SkillsMiddleware.beforeAgent": {
          "hook": 0,
          "native": 1,
        },
        "nexusRepeatToolReminder.beforeModel": {
          "hook": 0,
          "native": 3,
        },
        "nexusStepInbox.afterAgent": {
          "hook": 0,
          "native": 1,
        },
        "nexusStepInbox.beforeModel": {
          "hook": 0,
          "native": 3,
        },
        "patchToolCallsMiddleware.beforeAgent": {
          "hook": 0,
          "native": 1,
        },
      }
    `);
  });

  it('子代理：每一格都經 hook，native 一次都沒有', async () => {
    await run();
    expect(countsOn(SUBAGENT)).toMatchInlineSnapshot(`
      {
        "SkillsMiddleware.beforeAgent": {
          "hook": 1,
          "native": 0,
        },
        "nexusRepeatToolReminder.beforeModel": {
          "hook": 2,
          "native": 0,
        },
        "patchToolCallsMiddleware.beforeAgent": {
          "hook": 1,
          "native": 0,
        },
      }
    `);
  });
});
