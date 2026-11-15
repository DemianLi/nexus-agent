/**
 * 子代理預設疊與背景子代理圖上 `patchToolCallsMiddleware` 恰一顆；預設疊那顆帶 `beforeAgent` 與 `wrapModelCall`。
 *
 * 一張圖上只有一顆，而且 root、一次性（`task`）子代理、背景子代理三者都有：
 *
 * - root：`assembleAgent` 的核心疊（`agent-assembly.ts`）。
 * - 一次性子代理與背景子代理：同一個函式 `subagentDefaultMiddleware` 補的預設疊，背景那條經 `compileSubagentGraph`。
 *
 * 規格自己帶的同名 middleware 會換掉預設那顆（{@link mergeMiddlewareByName}），不會多出第二顆。
 * 這個檔釘的是「背景子代理的圖上有它、而且只有一顆」。TODO(#2362)：拿掉 `beforeAgent` 時核對 root、一次性、背景三張圖。
 */

import { FakeListChatModel } from '@langchain/core/utils/testing';
import { MemorySaver } from '@langchain/langgraph';
import { StateBackend } from 'deepagents';
import type { SubAgent } from 'deepagents';
import { describe, expect, it } from 'vitest';

import { subagentDefaultMiddleware } from './agent-assembly.js';
import { PATCH_TOOL_CALLS_MIDDLEWARE_NAME } from './patch-tool-calls.js';
import { compileSubagentGraph } from './subagent-graph.js';

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

describe('patchToolCallsMiddleware 的掛載', () => {
  it('子代理預設疊（一次性與背景共用的函式）：恰一顆，兩個掛點都在', () => {
    const stack = subagentDefaultMiddleware(
      spec as never,
      {
        backend: new StateBackend(),
        permissions: [],
        fileTools: undefined as never,
      } as never,
    );
    const mine = stack.filter((entry) => entry.name === PATCH_TOOL_CALLS_MIDDLEWARE_NAME);
    expect(mine).toHaveLength(1);
    expect(typeof (mine[0] as { beforeAgent?: unknown }).beforeAgent).toBe('function');
    expect(typeof (mine[0] as { wrapModelCall?: unknown }).wrapModelCall).toBe('function');
  });

  it('背景子代理的圖（compileSubagentGraph）：恰一顆', () => {
    const graph = compileSubagentGraph(
      {
        subagents: [spec],
        model: new FakeListChatModel({ responses: ['好'] }),
        backend: new StateBackend(),
      },
      'worker',
      { checkpointer: new MemorySaver() },
    );
    const mine = middlewareOf(graph).filter(
      (entry) => entry.name === PATCH_TOOL_CALLS_MIDDLEWARE_NAME,
    );
    expect(mine).toHaveLength(1);
  });
});
