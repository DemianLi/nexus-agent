/**
 * 出貨組裝上接住失敗、再往內交一次的兩格（#2416）：串流重打（`nexusStreamRetry`）與圖片省略的接住端（`nexusImageOffloadRecovery`）。
 * 兩顆都由 core 造、各登記了一步（`@nexus/core` 的 `withModelCallStep`），native 的 root 在原位直接呼叫；次數與路徑由 core 的
 * `native-loop/request-error-cells.test.ts` 數。這裡守宿主那一側：`--live` 組出來的 native agent 上，兩顆都還帶著登記。
 *
 * 接住端只在有型錄（`modelLimits`）時掛，串流重打只在 `retryPolicy.maxRetries` 大於 0 時掛，所以走 `live: true`。
 * 只組裝、不叫模型：端點是 loopback 上沒人聽的位址，key 是假的，**零憑證、零外部連線**。
 */

import * as core from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCliAgent } from './assembly-root.js';
import { shippedPlugins } from './fixtures.js';
import { DEFAULT_LIVE_MODEL_ENTRY, LIVE_API_KEY_ENV } from './live-model.js';
import { liveModelConfigSchema } from './settings/live-model.js';

const shipped = await shippedPlugins();

const CELLS = ['nexusStreamRetry', 'nexusImageOffloadRecovery'];

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env[LIVE_API_KEY_ENV];
  process.env[LIVE_API_KEY_ENV] = 'fake-key-for-loopback';
});
afterEach(() => {
  if (savedKey === undefined) delete process.env[LIVE_API_KEY_ENV];
  else process.env[LIVE_API_KEY_ENV] = savedKey;
});

describe('出貨組裝上接住失敗再交一次的格', () => {
  it('--live 組出來的 native agent 上，兩顆都帶著登記的一步', async () => {
    const liveModel = liveModelConfigSchema.parse({
      baseUrl: 'http://127.0.0.1:9/v1',
      retryPolicy: { mode: 'normal', maxRetries: 2 },
      modelId: DEFAULT_LIVE_MODEL_ENTRY.id,
      models: [structuredClone(DEFAULT_LIVE_MODEL_ENTRY)],
    });
    const built = await createCliAgent(
      { live: true, liveModel, agentLoop: 'native' },
      shipped,
      undefined,
      {},
    );
    try {
      const middleware = (built.agent as unknown as { middleware?: readonly { name: string }[] })
        .middleware;
      const registered = Object.fromEntries(
        CELLS.map((name) => {
          const found = middleware?.filter((m) => m.name === name) ?? [];
          return [
            name,
            found.length === 1 && core.modelCallStepOf(found[0]!) !== undefined
              ? '登記'
              : `${String(found.length)} 顆，${found.length === 1 ? '沒登記' : '數目不對'}`,
          ];
        }),
      );
      expect(registered, middleware?.map((m) => m.name).join(', ')).toEqual(
        Object.fromEntries(CELLS.map((name) => [name, '登記'])),
      );
    } finally {
      await built.dispose();
    }
  });
});
