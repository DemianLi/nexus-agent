/**
 * native 不跑的格（`native-skipped-cells.ts`）：清單是封閉的，這支檔列舉整份，多一條、少一條都紅；往清單加東西要先經過決策。
 * 另外驗它真的生效：同一份組裝、同一則超過 200,000 字的人話，`langgraph` 照基座搬到 `/conversation_history`，native 不搬。
 */

import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { StateBackend } from 'deepagents';
import { fakeModel } from 'langchain';
import { describe, expect, it } from 'vitest';

import { assembleAgent } from '../agent-assembly.js';
import { foldRegistry } from '../fold.js';
import { HUMAN_MESSAGE_LIMIT_CHARS } from '../human-message-admission.js';
import { loadPlugins } from '../load.js';
import { NATIVE_SKIPPED_CELLS, withoutNativeSkippedCells } from './native-skipped-cells.js';
import type { LoopMiddleware } from './onion.js';

describe('native 不跑的格', () => {
  it('清單只有 FilesystemMiddleware.beforeAgent 一條，附理由與出處', () => {
    expect(
      NATIVE_SKIPPED_CELLS.map(({ middleware, part, decision }) => ({
        middleware,
        part,
        decision,
      })),
    ).toEqual([
      { middleware: 'FilesystemMiddleware', part: 'beforeAgent', decision: '#1827 D234' },
    ]);
    for (const cell of NATIVE_SKIPPED_CELLS) expect(cell.reason.length).toBeGreaterThan(0);
  });

  it('清單上的那顆：那一格讀到 undefined，其餘照讀原物件；不在清單上的原樣回', () => {
    const beforeAgent = () => undefined;
    const wrapToolCall = async () => undefined;
    const listed = { name: 'FilesystemMiddleware', beforeAgent, wrapToolCall } as LoopMiddleware;
    const view = withoutNativeSkippedCells(listed);
    expect(view.beforeAgent).toBeUndefined();
    expect(view.wrapToolCall).toBe(wrapToolCall);
    expect(view.name).toBe('FilesystemMiddleware');
    expect(listed.beforeAgent).toBe(beforeAgent);

    const other = { name: 'Other', beforeAgent } as LoopMiddleware;
    expect(withoutNativeSkippedCells(other)).toBe(other);
  });

  it('清單上的那顆沒有那一格：拋，宣告對不上不會靜靜沒作用', () => {
    expect(() =>
      withoutNativeSkippedCells({ name: 'FilesystemMiddleware' } as LoopMiddleware),
    ).toThrow('middleware "FilesystemMiddleware" 沒有 beforeAgent');
  });
});

/** 一則超過上限的人話交給同一份組裝跑一輪，回 state 裡那則人話的 `lc_evicted_to`，與 `/conversation_history/` 底下的檔路徑。 */
async function run(loop: 'native' | 'langgraph') {
  const { registry } = await loadPlugins([]);
  const backend = new StateBackend();
  const params = foldRegistry(registry, {
    summarization: false,
    defaultBackend: backend,
    events: registry.dispatch,
  });
  const agent = assembleAgent({
    ...params,
    model: fakeModel().respond(new AIMessage('好了')),
    backend: params.backend ?? backend,
    checkpointer: new MemorySaver(),
    loop,
    events: registry.dispatch,
  });
  const config = { configurable: { thread_id: 't' } };
  const text = 'x'.repeat(HUMAN_MESSAGE_LIMIT_CHARS + 1);
  await agent.invoke({ messages: [new HumanMessage(text)] }, config);
  const state = (await agent.getState(config)) as {
    values: { messages?: BaseMessage[]; files?: Record<string, unknown> };
  };
  const human = (state.values.messages ?? []).find((m) => m.getType() === 'human');
  return {
    evictedTo: human?.additional_kwargs?.['lc_evicted_to'],
    stored: Object.keys(state.values.files ?? {}).filter((path) =>
      path.startsWith('/conversation_history/'),
    ),
  };
}

describe('超過 200,000 字的人話', () => {
  it('langgraph：基座搬到 /conversation_history', async () => {
    const { evictedTo, stored } = await run('langgraph');
    expect(evictedTo).toMatch(/^\/conversation_history\//u);
    expect(stored).toEqual([evictedTo]);
  });

  it('native：不搬（改在宿主的入口拒收）', async () => {
    const { evictedTo, stored } = await run('native');
    expect(evictedTo).toBeUndefined();
    expect(stored).toEqual([]);
  });
});
