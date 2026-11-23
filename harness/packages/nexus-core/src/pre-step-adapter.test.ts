/**
 * `langgraph` 下的 `agent/pre-step` 轉接格：只看這一顆自己派了什麼、怎麼交回；掛不掛（只在 `langgraph`、有監聽者、只折進 root）
 * 由 `fold-pre-step.test.ts` 在 fold 上驗，計劃模式交待關的時點由 `apps/harness/src/plan-mode-pre-step.test.ts` 在真的圖上驗。
 */

import { describe, expect, it } from 'vitest';

import { TurnBlockedError } from './archive-gate.js';
import { loadPlugins } from './load.js';
import {
  createPreStepAdapterMiddleware,
  PRE_STEP_ADAPTER_MIDDLEWARE_NAME,
} from './pre-step-adapter.js';
import type { PluginRegistry } from './registry.js';
import { TURN_CANCEL_CONFIG_KEY } from './turn-cancel.js';

interface Hooks {
  readonly name: string;
  wrapModelCall(request: unknown, handler: (request: unknown) => unknown): Promise<unknown>;
}

async function adapterWith(listen: (registry: PluginRegistry) => void): Promise<Hooks> {
  const loaded = await loadPlugins([{ plugin: { name: 'pre-step-listener', apply: listen } }]);
  return createPreStepAdapterMiddleware(loaded.registry.dispatch) as unknown as Hooks;
}

describe('pre-step 轉接格', () => {
  it('名字是 nexusPreStep', async () => {
    const hooks = await adapterWith(() => {});
    expect(hooks.name).toBe(PRE_STEP_ADAPTER_MIDDLEWARE_NAME);
    expect(PRE_STEP_ADAPTER_MIDDLEWARE_NAME).toBe('nexusPreStep');
  });

  it('每次模型呼叫先派一次、等監聽者做完，才把同一份請求往內交：thread 與中止訊號從 configurable 讀，step 是 0', async () => {
    const order: string[] = [];
    const seen: { threadId: string | undefined; step: number; signal: AbortSignal }[] = [];
    const hooks = await adapterWith((registry) =>
      registry.events.on('agent/pre-step', async (payload, next) => {
        seen.push(payload);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push('listener');
        return next();
      }),
    );
    const controller = new AbortController();
    const request = {
      runtime: { configurable: { thread_id: 't-1', [TURN_CANCEL_CONFIG_KEY]: controller.signal } },
    };
    const handed: unknown[] = [];
    const result = await hooks.wrapModelCall(request, (inner) => {
      order.push('model');
      handed.push(inner);
      return 'reply';
    });
    await hooks.wrapModelCall(request, () => 'again');
    expect(result).toBe('reply');
    expect(handed).toEqual([request]);
    expect(order).toEqual(['listener', 'model', 'listener']);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ threadId: 't-1', step: 0 });
    expect(seen[0]!.signal).toBe(controller.signal);
  });

  it('沒有 configurable：threadId 是 undefined，給一個永遠不中止的訊號', async () => {
    const seen: { threadId: string | undefined; signal: AbortSignal }[] = [];
    const hooks = await adapterWith((registry) =>
      registry.events.on('agent/pre-step', (payload, next) => {
        seen.push(payload);
        return next();
      }),
    );
    await hooks.wrapModelCall({}, () => undefined);
    expect(seen[0]!.threadId).toBeUndefined();
    expect(seen[0]!.signal.aborted).toBe(false);
  });

  it('監聽者回 reject：拋 TurnBlockedError，不叫模型（同 native）', async () => {
    const hooks = await adapterWith((registry) =>
      registry.events.on('agent/pre-step', async () => ({ kind: 'reject', reason: '擋' })),
    );
    let called = false;
    await expect(
      hooks.wrapModelCall({}, () => {
        called = true;
      }),
    ).rejects.toBeInstanceOf(TurnBlockedError);
    expect(called).toBe(false);
  });
});
