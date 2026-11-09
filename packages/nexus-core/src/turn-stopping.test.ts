/**
 * `langgraph` 下的 `agent/turn-stopping` 轉接格：只看這一顆自己派了什麼；插話跳回模型時不派、真的停時只派一次，由
 * `apps/harness/src/workspace-changes.test.ts` 在真的圖上驗。
 */

import { describe, expect, it } from 'vitest';

import { loadPlugins } from './load.js';
import type { PluginRegistry } from './registry.js';
import { TURN_CANCEL_CONFIG_KEY } from './turn-cancel.js';
import { createTurnStoppingMiddleware, TURN_STOPPING_MIDDLEWARE_NAME } from './turn-stopping.js';

interface Hooks {
  readonly name: string;
  afterAgent(state: unknown, runtime: unknown): unknown;
}

/** 一位插件掛 `listen`，交回這一份的轉接格。 */
async function adapterWith(listen: (registry: PluginRegistry) => void): Promise<Hooks> {
  const loaded = await loadPlugins([{ plugin: { name: 'turn-stopping-listener', apply: listen } }]);
  return createTurnStoppingMiddleware(loaded.registry.dispatch) as unknown as Hooks;
}

async function mounted() {
  const seen: { threadId: string | undefined; step: number; signal: AbortSignal }[] = [];
  const hooks = await adapterWith((registry) =>
    registry.events.on('agent/turn-stopping', (payload) => void seen.push(payload)),
  );
  return { hooks, seen };
}

describe('turn-stopping 轉接格', () => {
  it('名字是 nexusTurnStopping', async () => {
    expect((await mounted()).hooks.name).toBe(TURN_STOPPING_MIDDLEWARE_NAME);
    expect(TURN_STOPPING_MIDDLEWARE_NAME).toBe('nexusTurnStopping');
  });

  it('afterAgent 派一次：thread 與中止訊號從那一次的 configurable 讀，step 是 0，不改 state', async () => {
    const { hooks, seen } = await mounted();
    const controller = new AbortController();
    const update = await hooks.afterAgent(
      {},
      { configurable: { thread_id: 't-1', [TURN_CANCEL_CONFIG_KEY]: controller.signal } },
    );
    expect(update).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ threadId: 't-1', step: 0 });
    expect(seen[0]!.signal).toBe(controller.signal);
  });

  it('沒有 configurable：threadId 是 undefined，給一個永遠不中止的訊號', async () => {
    const { hooks, seen } = await mounted();
    await hooks.afterAgent({}, undefined);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.threadId).toBeUndefined();
    expect(seen[0]!.signal.aborted).toBe(false);
  });

  it('等監聽者做完才交回：監聽者的 await 在 afterAgent 回來之前結束', async () => {
    let done = false;
    const hooks = await adapterWith((registry) =>
      registry.events.on('agent/turn-stopping', async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        done = true;
      }),
    );
    await hooks.afterAgent({}, { configurable: { thread_id: 't' } });
    expect(done).toBe(true);
  });
});
