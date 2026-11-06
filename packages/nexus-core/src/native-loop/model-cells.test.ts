/**
 * native 的模型那一串（#2416）：登記了工具清單那一步的格（`tool-list-step.ts` 的 `withToolListStep`），root 由 native 直接呼叫那一步、
 * 不經那顆的 `wrapModelCall`；子代理在 native 下仍是 LangGraph 子圖（TODO(#2359)），照舊經 `wrapModelCall`。
 *
 * 基座的檔案工具、子代理兩顆是組裝時才建的，所以計數掛在登記上：每一次登記，那一步與那顆的 `wrapModelCall` 各包一個計數。
 * 跑一輪「root 叫工具 → 委派子代理、子代理叫工具」，數每一格在 root 與子代理的模型呼叫各被叫了幾次。哪一邊照請求的第一則訊息分：
 * root 是「動手」，子代理是委派的描述。
 */

import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { StateBackend } from 'deepagents';
import { fakeModel } from 'langchain';
import { describe, expect, it, vi } from 'vitest';

import { assembleAgent } from '../agent-assembly.js';
import { fakePlugin, fakeTool } from '../fixtures.js';
import { foldRegistry } from '../fold.js';
import { loadPlugins } from '../load.js';
import { SHARED_WORKSPACE_SERVICE } from '../sandbox.js';
import type * as ToolListStepModule from '../tool-list-step.js';

type Via = 'native' | 'wrapModelCall';

/** 每一格（照名字）在哪一邊（照請求的第一則訊息）各被叫了幾次，分成兩條路。 */
const counts = vi.hoisted(
  () => new Map<string, Map<string, Record<'native' | 'wrapModelCall', number>>>(),
);

vi.mock('../tool-list-step.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ToolListStepModule>();
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
    const counted: ToolListStepModule.ToolListStep = (request) => {
      bump(target.name, request, 'native');
      return step(request);
    };
    // `withToolListStep` 只在登記那一刻核對 `wrapModelCall` 是 `wrapModelCallWith(counted, inner)`；登記後換上的這支經原本的 `wrap` 跑、不經 `counted`，native 與 `wrapModelCall` 兩條路徑才各記各的。
    target.wrapModelCall = actual.wrapModelCallWith(counted, inner as never) as never;
    const registered = actual.withToolListStep(middleware, counted, inner);
    target.wrapModelCall = (request, handler) => {
      bump(target.name, request, 'wrapModelCall');
      return wrap(request, handler);
    };
    return registered;
  };
  return {
    ...actual,
    withToolListStep,
    createToolListStepMiddleware: (name: string, step: ToolListStepModule.ToolListStep) =>
      withToolListStep(actual.createToolListStepMiddleware(name, step), step),
  };
});

async function run() {
  counts.clear();
  const { registry } = await loadPlugins([
    fakePlugin('tools', (r) => {
      r.tools.register(fakeTool('alpha'));
      r.services.provide(SHARED_WORKSPACE_SERVICE, '/shared/');
    }),
  ]);
  const backend = new StateBackend();
  // 只在有設定時才掛的那幾格（backend 下的檔案工具與讀檔續讀、共用區搜尋描述、子代理工具過濾）全打開，名單涵蓋 core 每一顆登記了工具清單那一步的。
  const params = foldRegistry(registry, {
    summarization: false,
    repeatReminder: false,
    observationPolicy: true,
    defaultBackend: backend,
    spillPolicy: {
      maxInlineTokens: 100_000,
      store: { saveText: () => Promise.reject(new Error('這條測試不會存')) },
    },
    searchOverflow: { limits: { grepMaxMatches: 250, globMaxResults: 100 } },
    workspaceSearch: true,
    baseToolNames: ['write_file'],
    subagentToolFilter: { deny: ['write_file'] },
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

/** 在這一邊被叫過的格。 */
const cellsOn = (side: string) =>
  [...counts].filter(([, bySide]) => bySide.has(side)).map(([name]) => name);

describe('native 的模型那一串：登記了工具清單那一步的格每次呼叫只跑一次', () => {
  it('root 的三次模型呼叫：每一格由 native 直接呼叫那一步，wrapModelCall 一次都沒有', async () => {
    const { messages } = await run();
    expect(messages.at(-1)?.text).toBe('好了');
    expect(cellsOn(ROOT).length).toBeGreaterThan(0);
    for (const name of cellsOn(ROOT)) {
      expect([name, counts.get(name)?.get(ROOT)]).toEqual([name, { native: 3, wrapModelCall: 0 }]);
    }
  });

  it('子代理的兩次模型呼叫：每一格經 wrapModelCall，native 一次都沒有', async () => {
    await run();
    expect(cellsOn(SUBAGENT).length).toBeGreaterThan(0);
    for (const name of cellsOn(SUBAGENT)) {
      expect([name, counts.get(name)?.get(SUBAGENT)]).toEqual([
        name,
        { native: 0, wrapModelCall: 2 },
      ]);
    }
  });

  it('登記了工具清單那一步的格：root 與子代理兩邊的名單', async () => {
    await run();
    expect({ root: cellsOn(ROOT), subagent: cellsOn(SUBAGENT) }).toMatchInlineSnapshot(`
      {
        "root": [
          "FilesystemMiddleware",
          "subAgentMiddleware",
          "nexusReadContinuation",
          "nexusSearchDescriptions",
        ],
        "subagent": [
          "FilesystemMiddleware",
          "nexusReadContinuation",
          "nexusSearchDescriptions",
          "nexusSubagentToolFilter",
        ],
      }
    `);
  });
});
