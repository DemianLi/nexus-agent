/**
 * `patchToolCallsMiddleware` 在每一張圖上恰一顆；`stateFix`（`FoldedAgentParams.patchToolCallsStateFix`）決定它帶不帶改狀態的 `beforeAgent`。
 *
 * 三張圖都量：
 *
 * - root：`assembleAgent` 的核心疊（`agent-assembly.ts`）。
 * - 一次性子代理與背景子代理：同一個函式 `subagentDefaultMiddleware` 補的預設疊，背景那條經 `compileSubagentGraph`（`langgraph` 與 `native` 各一）。
 *
 * 旗標省略或 `true` ＝ 兩個掛點都在；`false`（`log`）＝ 只剩 `wrapModelCall`。fold 在 `log` 下算出 `false`，其餘來源不給。
 * `langgraph` 與 root 量的是**建好的 agent 身上的 `middleware` 清單**。**native 量的是傳給 `createNativeAgent` 的 `middleware` 參數，不是建好的 agent**：
 * 測試環境下 `NativeAgent` 的建構子會拒收預設疊裡沒登記步驟的格（摘要那顆），建不起來；參數就是它之後跑的那份。
 * 規格自己帶的同名 middleware 會換掉預設那顆（{@link mergeMiddlewareByName}），不會多出第二顆。
 */

import { FakeListChatModel } from '@langchain/core/utils/testing';
import { MemorySaver } from '@langchain/langgraph';
import { StateBackend } from 'deepagents';
import type { SubAgent } from 'deepagents';
import { describe, expect, it, vi } from 'vitest';

import { assembleAgent, subagentDefaultMiddleware } from './agent-assembly.js';
import { PATCH_TOOL_CALLS_MIDDLEWARE_NAME } from './patch-tool-calls.js';
import { compileSubagentGraph } from './subagent-graph.js';

type Mount = { name?: string; beforeAgent?: unknown; wrapModelCall?: unknown };

const nativeSeen: { middleware: Mount[] }[] = [];
vi.mock('./native-loop/agent.js', async (importActual) => {
  const actual = await importActual<typeof import('./native-loop/agent.js')>();
  return {
    ...actual,
    createNativeAgent: (params: { middleware: Mount[] }) => {
      nativeSeen.push(params);
      return {};
    },
  };
});

/** 建好的圖身上那份 middleware stack；找不到就失敗（基座內部形狀變了就是要知道）。 */
function middlewareOf(
  graph: unknown,
): readonly { name?: string; beforeAgent?: unknown; wrapModelCall?: unknown }[] {
  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number): unknown[] | null => {
    if (depth > 6 || node == null || typeof node !== 'object' || seen.has(node)) return null;
    seen.add(node);
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'middleware' && Array.isArray(value)) return value;
      const found = walk(value, depth + 1);
      if (found) return found;
    }
    return null;
  };
  const found = walk(graph, 0);
  if (!found) throw new Error('找不到圖的 middleware stack——基座的內部形狀變了。');
  return found as never;
}

const spec = {
  name: 'worker',
  description: '幹活的。',
  systemPrompt: '你是 worker。',
  tools: [],
} as unknown as SubAgent;

/** 旗標的三種給法與它們該得到的掛點：省略與 `true` 一樣，`false` 只剩請求那半。 */
const FLAGS = [
  ['省略', undefined, true],
  ['true', true, true],
  ['false', false, false],
] as const;

function expectMount(stack: readonly Mount[], withBeforeAgent: boolean): void {
  const mine = stack.filter((entry) => entry.name === PATCH_TOOL_CALLS_MIDDLEWARE_NAME);
  expect(mine).toHaveLength(1);
  expect(typeof mine[0]?.beforeAgent).toBe(withBeforeAgent ? 'function' : 'undefined');
  expect(typeof mine[0]?.wrapModelCall).toBe('function');
}

const flagField = (flag: boolean | undefined) =>
  flag === undefined ? {} : { patchToolCallsStateFix: flag };

describe('patchToolCallsMiddleware 的掛載', () => {
  describe.each(FLAGS)('旗標 %s', (_label, flag, withBeforeAgent) => {
    it('子代理預設疊（一次性與背景共用的函式）', () => {
      const stack = subagentDefaultMiddleware(
        spec as never,
        {
          backend: new StateBackend(),
          permissions: [],
          fileTools: undefined as never,
          ...flagField(flag),
        } as never,
      );
      expectMount(stack as never, withBeforeAgent);
    });

    it('背景子代理的圖：langgraph', () => {
      const graph = compileSubagentGraph(
        {
          subagents: [spec],
          model: new FakeListChatModel({ responses: ['好'] }),
          backend: new StateBackend(),
          ...flagField(flag),
        },
        'worker',
        { checkpointer: new MemorySaver() },
      );
      expectMount(middlewareOf(graph), withBeforeAgent);
    });

    it('背景子代理的圖：native', () => {
      nativeSeen.length = 0;
      compileSubagentGraph(
        {
          subagents: [spec],
          model: new FakeListChatModel({ responses: ['好'] }),
          backend: new StateBackend(),
          ...flagField(flag),
        },
        'worker',
        { loop: 'native' },
      );
      expect(nativeSeen).toHaveLength(1);
      expectMount(nativeSeen[0]?.middleware ?? [], withBeforeAgent);
    });

    it('root（assembleAgent 的核心疊）', () => {
      const agent = assembleAgent({
        model: new FakeListChatModel({ responses: ['好'] }),
        backend: new StateBackend(),
        tools: [],
        subagents: [],
        middleware: [],
        withoutSubagents: true,
        ...flagField(flag),
      } as never);
      expectMount(middlewareOf(agent), withBeforeAgent);
    });
  });
});
