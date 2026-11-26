/**
 * native 的工具鏈（#2416）：登記了工具步驟的那幾格（`tool-call-step.ts` 的 `withToolCallStep`），root 與前景子代理都由 native 直接呼叫那一步、不經
 * 那顆的 `wrapToolCall`。這裡在 fold 之後、組裝之前，
 * 把每顆登記過的 middleware 的那一步與 `wrapToolCall` 各包一個計數，跑一輪「root 叫工具 → 委派子代理、子代理叫工具」，
 * 數每一格對每一次呼叫各被叫了幾次。
 */

import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { StateBackend } from 'deepagents';
import { fakeModel } from '../fixtures.js';
import { describe, expect, it } from 'vitest';

import { assembleAgent } from '../agent-assembly.js';
import type { AgentMiddleware } from '../base-types.js';
import { fakePlugin, fakeTool } from '../fixtures.js';
import { foldRegistry } from '../fold.js';
import { loadPlugins } from '../load.js';
import { SHARED_WORKSPACE_SERVICE } from '../sandbox.js';
import { toolCallStepOf, withToolCallStep, wrapToolCallWith } from '../tool-call-step.js';
import type { ToolCallStep } from '../tool-call-step.js';

type Via = 'native' | 'wrapToolCall';

/** 每顆登記過的 middleware（照身分）對每個 `callId` 各被叫了幾次，分成兩條路。 */
type Counts = Map<object, Map<string, Record<Via, number>>>;

function bump(counts: Counts, middleware: object, callId: string | undefined, via: Via): void {
  let byCall = counts.get(middleware);
  if (byCall === undefined) counts.set(middleware, (byCall = new Map()));
  const key = callId ?? '';
  const entry = byCall.get(key) ?? { native: 0, wrapToolCall: 0 };
  entry[via] += 1;
  byCall.set(key, entry);
}

/** 登記過步驟的那幾顆：步驟與 `wrapToolCall` 各包一層計數，原地換掉（root 與子代理共用的實例兩邊都看得到）。 */
function instrument(middleware: Iterable<AgentMiddleware>, counts: Counts): Set<object> {
  const instrumented = new Set<object>();
  for (const m of middleware) {
    const step = toolCallStepOf(m);
    if (step === undefined || instrumented.has(m)) continue;
    instrumented.add(m);
    const counted: ToolCallStep = (call, next) => {
      bump(counts, m, call.callId, 'native');
      return step(call, next);
    };
    const target = m as unknown as {
      wrapToolCall: (request: { toolCall: { id?: string } }, handler: unknown) => unknown;
    };
    const wrap = target.wrapToolCall;
    // `withToolCallStep` 只在登記那一刻核對 `wrapToolCall` 是 `wrapToolCallWith(counted)`；登記後換上的這支經原本的 `wrap` 跑、不經 `counted`，native 與 `wrapToolCall` 兩條路徑才各記各的。
    target.wrapToolCall = wrapToolCallWith(counted) as never;
    withToolCallStep(m, counted);
    target.wrapToolCall = (request, handler) => {
      bump(counts, m, request.toolCall.id, 'wrapToolCall');
      return wrap(request, handler);
    };
  }
  return instrumented;
}

async function run() {
  const { registry } = await loadPlugins([
    fakePlugin('tools', (r) => {
      r.tools.register(fakeTool('alpha'));
      r.services.provide(SHARED_WORKSPACE_SERVICE, '/shared/');
    }),
  ]);
  const backend = new StateBackend();
  // 只在有設定時才掛的那幾格（外溢、搜尋上限、檔案工具兩顆、先讀後改、共用區前綴、子代理工具過濾）全打開，名單涵蓋每一顆登記過的。
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
    baseToolNames: ['write_file'],
    subagentToolFilter: { deny: ['write_file'] },
    events: registry.dispatch,
  });
  const counts: Counts = new Map();
  const rootStack = params.middleware;
  const subagentStacks = params.subagents.map(
    (spec) => ((spec as { middleware?: AgentMiddleware[] }).middleware ?? []) as AgentMiddleware[],
  );
  const instrumented = instrument([...rootStack, ...subagentStacks.flat()], counts);
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
  const rootCells = rootStack.filter((m) => instrumented.has(m));
  const subagentCells = (subagentStacks[0] ?? []).filter((m) => instrumented.has(m));
  return { counts, rootCells, subagentCells, messages: state.messages };
}

const count = (counts: Counts, m: object, callId: string) =>
  counts.get(m)?.get(callId) ?? { native: 0, wrapToolCall: 0 };

describe('native 的工具鏈：登記了工具步驟的格每次呼叫只跑一次', () => {
  it('root 的兩次呼叫：每一格由 native 直接呼叫那一步一次，wrapToolCall 一次都沒有', async () => {
    const { counts, rootCells, messages } = await run();
    expect(messages.at(-1)?.text).toBe('好了');
    expect(rootCells.length).toBeGreaterThan(0);
    for (const m of rootCells) {
      for (const callId of ['root-alpha', 'root-task']) {
        expect([(m as { name: string }).name, callId, count(counts, m, callId)]).toEqual([
          (m as { name: string }).name,
          callId,
          { native: 1, wrapToolCall: 0 },
        ]);
      }
    }
  });

  it('子代理的呼叫：每一格由 native 直接呼叫那一步一次，wrapToolCall 一次都沒有；共用的實例在 root 那邊照樣算數', async () => {
    const { counts, rootCells, subagentCells } = await run();
    expect(subagentCells.length).toBeGreaterThan(0);
    for (const m of subagentCells) {
      expect([(m as { name: string }).name, count(counts, m, 'sub-alpha')]).toEqual([
        (m as { name: string }).name,
        { native: 1, wrapToolCall: 0 },
      ]);
    }
    const shared = subagentCells.filter((m) => rootCells.includes(m));
    expect(shared.length).toBeGreaterThan(0);
    for (const m of shared) {
      expect(count(counts, m, 'root-alpha')).toEqual({ native: 1, wrapToolCall: 0 });
    }
  });

  it('登記了工具步驟的格：root 與子代理兩邊的名單', async () => {
    const { rootCells, subagentCells } = await run();
    const names = (cells: readonly object[]) => cells.map((m) => (m as { name: string }).name);
    expect({ root: names(rootCells), subagent: names(subagentCells) }).toMatchInlineSnapshot(`
      {
        "root": [
          "nexusToolBarrier",
          "nexusToolFailureContainment",
          "nexusTurnCancel",
          "nexusToolPreExecute",
          "nexusApprovalGate",
          "nexusToolPostExecute",
          "nexusReadContinuation",
          "nexusInvalidToolArgs",
          "nexusToolExecute",
        ],
        "subagent": [
          "nexusToolBarrier",
          "nexusToolFailureContainment",
          "nexusTurnCancel",
          "nexusToolPreExecute",
          "nexusApprovalGate",
          "nexusToolPostExecute",
          "nexusReadContinuation",
          "nexusInvalidToolArgs",
          "nexusToolExecute",
        ],
      }
    `);
  });
});
